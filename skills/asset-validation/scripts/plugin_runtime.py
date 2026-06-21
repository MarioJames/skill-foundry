import json
import shutil
from pathlib import Path
from typing import Optional

from .envprep import prepare_round_environment


def _copy_entry(src: Path, dest: Path) -> None:
    if src.is_dir():
        if dest.exists() or dest.is_symlink():
            if dest.is_dir() and not dest.is_symlink():
                shutil.rmtree(dest)
            else:
                dest.unlink()
        shutil.copytree(src, dest, symlinks=True)
    else:
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dest)


def _install_manifest_path(sandbox) -> Path:
    return Path(sandbox) / ".aut-acceptance" / "plugin-install.json"


def _read_install_manifest(sandbox) -> dict:
    path = _install_manifest_path(sandbox)
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _write_install_manifest(sandbox, manifest: dict) -> None:
    path = _install_manifest_path(sandbox)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2),
                    encoding="utf-8")


def _read_plugin_name(src: Path, fallback: Optional[str]) -> str:
    manifest = src / "plugin.json"
    if manifest.exists():
        try:
            data = json.loads(manifest.read_text(encoding="utf-8"))
            if data.get("name"):
                return data["name"]
        except (OSError, json.JSONDecodeError):
            pass
    return fallback or src.name


def install_plugin_source(sandbox, source_path, *, name: Optional[str] = None) -> dict:
    src = Path(source_path)
    if not src.exists():
        return {"installed": False, "reason": f"source not found: {src}"}

    env = prepare_round_environment(sandbox)
    plugin_name = _read_plugin_name(src, name)
    plugin_dir = Path(env["ACCEPTANCE_SANDBOX"]) / ".iso" / "claude-plugins" / plugin_name
    _copy_entry(src, plugin_dir)

    skills = sorted(child.name for child in (src / "skills").iterdir()) \
        if (src / "skills").exists() else []
    agents = sorted(child.name for child in (src / "agents").iterdir()) \
        if (src / "agents").exists() else []
    settings = env["CMDAI_CLAUDE_SETTINGS_PATH"]
    cli_args = ["--settings", settings, "--plugin-dir", str(plugin_dir)]
    manifest = {
        "name": plugin_name,
        "source": str(src),
        "plugin_dir": str(plugin_dir),
        "settings": settings,
        "skills": skills,
        "agents": agents,
        "cli_args": cli_args,
    }
    _write_install_manifest(sandbox, manifest)

    return {
        "installed": True,
        "name": plugin_name,
        "plugin_dir": str(plugin_dir),
        "settings": settings,
        "cli_args": cli_args,
        "skills": skills,
        "agents": agents,
    }


def cleanup_plugin_install(sandbox) -> Optional[dict]:
    manifest = _read_install_manifest(sandbox)
    if not manifest:
        return None
    raw_plugin_dir = manifest.get("plugin_dir")
    removed_plugin_dir = False
    plugin_dir = Path(raw_plugin_dir) if raw_plugin_dir else None
    if plugin_dir and plugin_dir.exists():
        if plugin_dir.is_dir() and not plugin_dir.is_symlink():
            shutil.rmtree(plugin_dir)
        else:
            plugin_dir.unlink()
        removed_plugin_dir = True
    try:
        _install_manifest_path(sandbox).unlink()
    except FileNotFoundError:
        pass
    return {
        "name": manifest.get("name"),
        "removed_plugin_dir": removed_plugin_dir,
        "plugin_dir": str(plugin_dir) if plugin_dir else None,
        "skills": manifest.get("skills", []),
        "agents": manifest.get("agents", []),
    }
