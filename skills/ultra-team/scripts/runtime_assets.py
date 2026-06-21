import json
import pathlib
import shutil
import stat
from typing import Optional

import state_store


def skill_dir() -> str:
    return str(pathlib.Path(__file__).resolve().parent.parent)


def install_runtime_assets() -> dict:
    source_root = pathlib.Path(skill_dir())
    runtime_root = state_store.runtime_root()
    installed = []
    for relative in [
        pathlib.Path("SKILL.md"),
        pathlib.Path("hooks") / "heartbeat.sh",
        pathlib.Path("hooks") / "clean.sh",
        pathlib.Path("references") / "recursion-protocol.md",
        pathlib.Path("references") / "recovery-protocol.md",
        pathlib.Path("references") / "script-cases.md",
    ]:
        installed.append(_copy_runtime_asset(source_root, runtime_root, relative))

    for script in sorted((source_root / "scripts").glob("*.py")):
        relative = pathlib.Path("scripts") / script.name
        installed.append(_copy_runtime_asset(source_root, runtime_root, relative))

    return {
        "runtime_home": str(runtime_root),
        "hooks_dir": str(runtime_root / "hooks"),
        "installed": installed,
    }


def _copy_runtime_asset(source_root: pathlib.Path, runtime_root: pathlib.Path, relative: pathlib.Path) -> str:
    src = source_root / relative
    dst = runtime_root / relative
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)
    if dst.suffix == ".sh":
        dst.chmod(dst.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return str(dst)


def project_hook_entries() -> dict:
    return {
        "PostToolUse": {
            "matcher": "*",
            "hook": {
                "type": "command",
                "command": "$HOME/.ultra-team/hooks/heartbeat.sh",
            },
        },
        "SessionEnd": {
            "matcher": "*",
            "hook": {
                "type": "command",
                "command": "$HOME/.ultra-team/hooks/clean.sh",
            },
        },
    }


def project_hook_commands() -> set[str]:
    return {
        entry["hook"]["command"] for entry in project_hook_entries().values()
    } | {"$HOME/.ultra-team/hooks/guard.sh"}


def ensure_project_hooks(cwd: Optional[str]) -> Optional[pathlib.Path]:
    if not cwd:
        return None
    project_dir = pathlib.Path(cwd)
    if not project_dir.exists():
        return None
    claude_dir = project_dir / ".claude"
    claude_dir.mkdir(parents=True, exist_ok=True)
    settings_path = claude_dir / "settings.local.json"
    if settings_path.exists():
        with settings_path.open(encoding="utf-8") as fh:
            settings = json.load(fh)
    else:
        settings = {}
    hooks = settings.setdefault("hooks", {})
    for event, entry in project_hook_entries().items():
        event_entries = hooks.setdefault(event, [])
        ensure_hook_entry(event_entries, entry["matcher"], entry["hook"])
    tmp_path = settings_path.with_suffix(settings_path.suffix + ".tmp")
    with tmp_path.open("w", encoding="utf-8") as fh:
        json.dump(settings, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    tmp_path.replace(settings_path)
    return settings_path


def cleanup_project_hooks(cwd: Optional[str]) -> Optional[pathlib.Path]:
    if not cwd:
        return None
    settings_path = pathlib.Path(cwd) / ".claude" / "settings.local.json"
    if not settings_path.exists():
        return None
    with settings_path.open(encoding="utf-8") as fh:
        settings = json.load(fh)

    commands = project_hook_commands()
    hooks = settings.get("hooks")
    if isinstance(hooks, dict):
        for event in list(hooks.keys()):
            entries = hooks.get(event)
            if not isinstance(entries, list):
                continue
            cleaned_entries = []
            for entry in entries:
                if not isinstance(entry, dict):
                    cleaned_entries.append(entry)
                    continue
                entry_hooks = entry.get("hooks")
                if not isinstance(entry_hooks, list):
                    cleaned_entries.append(entry)
                    continue
                remaining = [
                    hook for hook in entry_hooks
                    if not (isinstance(hook, dict) and hook.get("command") in commands)
                ]
                if remaining:
                    updated = dict(entry)
                    updated["hooks"] = remaining
                    cleaned_entries.append(updated)
            if cleaned_entries:
                hooks[event] = cleaned_entries
            else:
                hooks.pop(event, None)
        if not hooks:
            settings.pop("hooks", None)

    if settings:
        tmp_path = settings_path.with_suffix(settings_path.suffix + ".tmp")
        with tmp_path.open("w", encoding="utf-8") as fh:
            json.dump(settings, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        tmp_path.replace(settings_path)
    else:
        settings_path.unlink()
    return settings_path


def cleanup_project_hooks_for_root(root_id: str) -> None:
    run = state_store.get_run(root_id)
    if run:
        cleanup_project_hooks(run.get("cwd"))


def cleanup_project_hooks_for_cwd(cwd: str) -> None:
    cleanup_project_hooks(cwd)


def ensure_hook_entry(event_entries: list, matcher: str, hook: dict) -> None:
    for entry in event_entries:
        if entry.get("matcher") != matcher:
            continue
        hooks = entry.setdefault("hooks", [])
        if not any(existing.get("command") == hook["command"] for existing in hooks):
            hooks.append(dict(hook))
        return
    event_entries.append({"matcher": matcher, "hooks": [dict(hook)]})
