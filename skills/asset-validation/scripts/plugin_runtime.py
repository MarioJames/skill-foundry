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


def _session_isolation_prompt(kind: str, names: list) -> str:
    listed = ", ".join(names) if names else kind
    return (
        "Acceptance sandbox isolation: use only the asset staged through this "
        f"session plugin ({kind}: {listed}). Do not use same-name global skills, "
        "agents, or files under $HOME/.claude/skills as the asset source when a "
        "staged copy exists under ACCEPTANCE_SANDBOX. A token such as "
        "$asset-validation denotes a skill name in the user task, not a shell "
        "command or npm package. Never print settings files, auth tokens, or "
        "secret environment values; report paths only."
    )


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


def _read_skill_name(src: Path, fallback: Optional[str]) -> str:
    skill = src / "SKILL.md"
    if skill.exists():
        try:
            in_frontmatter = False
            for raw in skill.read_text(encoding="utf-8").splitlines():
                line = raw.strip()
                if line == "---":
                    if not in_frontmatter:
                        in_frontmatter = True
                        continue
                    break
                if in_frontmatter and line.startswith("name:"):
                    name = line.split(":", 1)[1].strip().strip("\"'")
                    if name:
                        return name
        except OSError:
            pass
    return fallback or src.name


def _read_agent_name(src: Path, fallback: Optional[str]) -> str:
    candidates = []
    if src.is_file() and src.suffix == ".md":
        candidates.append(src)
    agents_dir = src / "agents"
    if agents_dir.exists():
        candidates.extend(sorted(child for child in agents_dir.iterdir()
                                 if child.suffix == ".md"))
    for child in candidates:
        try:
            in_frontmatter = False
            for raw in child.read_text(encoding="utf-8").splitlines():
                line = raw.strip()
                if line == "---":
                    if not in_frontmatter:
                        in_frontmatter = True
                        continue
                    break
                if in_frontmatter and line.startswith("name:"):
                    name = line.split(":", 1)[1].strip().strip("\"'")
                    if name:
                        return name
        except OSError:
            pass
    return fallback or src.stem


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
    cli_args = [
        "--bare",
        "--append-system-prompt", _session_isolation_prompt("plugin", skills + agents),
        "--settings", settings,
        "--plugin-dir", str(plugin_dir),
    ]
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


def install_agent_source(sandbox, source_path, *, name: Optional[str] = None) -> dict:
    src = Path(source_path)
    if not src.exists():
        return {"installed": False, "reason": f"source not found: {src}"}

    env = prepare_round_environment(sandbox)
    agent_name = _read_agent_name(src, name)
    plugin_name = f"acc-agent-{agent_name}"
    plugin_dir = (
        Path(env["ACCEPTANCE_SANDBOX"])
        / ".iso" / "claude-agent-plugins" / plugin_name
    )
    agents_dest = plugin_dir / "agents"
    if (src / "agents").exists():
        _copy_entry(src / "agents", agents_dest)
    elif src.is_file() and src.suffix == ".md":
        _copy_entry(src, agents_dest / src.name)
    plugin_dir.mkdir(parents=True, exist_ok=True)
    (plugin_dir / "plugin.json").write_text(
        json.dumps({"name": plugin_name}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    agents = sorted(child.name for child in agents_dest.iterdir()) \
        if agents_dest.exists() else []
    settings = env["CMDAI_CLAUDE_SETTINGS_PATH"]
    cli_args = [
        "--bare",
        "--append-system-prompt", _session_isolation_prompt("agent", agents),
        "--settings", settings,
        "--plugin-dir", str(plugin_dir),
    ]
    manifest = {
        "name": plugin_name,
        "source": str(src),
        "plugin_dir": str(plugin_dir),
        "settings": settings,
        "skills": [],
        "agents": agents,
        "cli_args": cli_args,
        "staged_asset_type": "agent",
    }
    _write_install_manifest(sandbox, manifest)

    return {
        "installed": True,
        "name": plugin_name,
        "plugin_dir": str(plugin_dir),
        "settings": settings,
        "cli_args": cli_args,
        "skills": [],
        "agents": agents,
    }


def install_skill_source(sandbox, source_path, *, name: Optional[str] = None) -> dict:
    src = Path(source_path)
    if not src.exists():
        return {"installed": False, "reason": f"source not found: {src}"}

    env = prepare_round_environment(sandbox)
    skill_name = _read_skill_name(src, name)
    plugin_name = f"acc-skill-{skill_name}"
    plugin_dir = (
        Path(env["ACCEPTANCE_SANDBOX"])
        / ".iso" / "claude-skill-plugins" / plugin_name
    )
    skill_dir = plugin_dir / "skills" / skill_name
    _copy_entry(src, skill_dir)
    plugin_dir.mkdir(parents=True, exist_ok=True)
    (plugin_dir / "plugin.json").write_text(
        json.dumps({"name": plugin_name}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    settings = env["CMDAI_CLAUDE_SETTINGS_PATH"]
    cli_args = [
        "--bare",
        "--append-system-prompt", _session_isolation_prompt("skill", [skill_name]),
        "--settings", settings,
        "--plugin-dir", str(plugin_dir),
    ]
    manifest = {
        "name": plugin_name,
        "source": str(src),
        "plugin_dir": str(plugin_dir),
        "settings": settings,
        "skills": [skill_name],
        "agents": [],
        "cli_args": cli_args,
        "staged_asset_type": "skill",
    }
    _write_install_manifest(sandbox, manifest)

    return {
        "installed": True,
        "name": plugin_name,
        "plugin_dir": str(plugin_dir),
        "settings": settings,
        "cli_args": cli_args,
        "skills": [skill_name],
        "agents": [],
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
