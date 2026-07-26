"""Install and remove only Agent Swarm-owned Claude project hooks."""

import json
import pathlib
import subprocess

import state_store


OWNER_FIELD = "agent_swarm_owner"
OWNER_VALUE = "agent-swarm"
ROOT_FIELD = "agent_swarm_root_id"
WORKTREE_SETTINGS_PATH = ".claude/settings.local.json"
WORKTREE_INCLUDE_FILE = ".worktreeinclude"
HOOK_BINDINGS = (
    ("SessionStart", "heartbeat.sh"),
    ("PostToolUse", "heartbeat.sh"),
    ("PostToolUseFailure", "failure_context.sh"),
    ("Stop", "finish_gate.sh"),
    ("SessionEnd", "clean.sh"),
)


def _settings_path(cwd):
    return pathlib.Path(cwd) / ".claude" / "settings.local.json"


def _source_hook_path(name):
    return str((pathlib.Path(__file__).resolve().parent.parent / "hooks" / name).resolve())


def _runtime_hook_command(name):
    return "bash -c 'exec \"${AGENT_SWARM_HOME:-$HOME/.agent-swarm}/hooks/%s\"'" % name


def _worktree_roots(cwd):
    """Return this project plus every currently registered sibling worktree."""
    primary = _git_root(cwd) or pathlib.Path(cwd).resolve()
    roots = [primary]
    try:
        completed = subprocess.run(
            ["git", "-C", str(primary), "worktree", "list", "--porcelain"],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            check=False,
            timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired):
        return [str(primary)]
    if completed.returncode != 0:
        return [str(primary)]
    for line in (completed.stdout or "").splitlines():
        if not line.startswith("worktree "):
            continue
        candidate = pathlib.Path(line[len("worktree "):]).resolve()
        if candidate.is_dir() and candidate not in roots:
            roots.append(candidate)
    return [str(root) for root in roots]


def _git_output(cwd, *args):
    try:
        completed = subprocess.run(
            ["git", "-C", str(cwd), *args],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            check=False,
            timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if completed.returncode != 0:
        return None
    return (completed.stdout or "").strip()


def _git_root(cwd):
    output = _git_output(cwd, "rev-parse", "--show-toplevel")
    return pathlib.Path(output).resolve() if output else None


def _is_tracked(cwd, relative_path):
    return _git_output(cwd, "ls-files", "--error-unmatch", "--", relative_path) is not None


def _is_ignored(cwd, relative_path):
    return _git_output(cwd, "check-ignore", "-q", "--", relative_path) is not None


def _git_exclude_path(cwd):
    output = _git_output(cwd, "rev-parse", "--git-path", "info/exclude")
    if not output:
        return None
    path = pathlib.Path(output)
    return path if path.is_absolute() else pathlib.Path(cwd) / path


def _append_unique_line(path, line):
    lines = path.read_text().splitlines() if path.exists() else []
    if line in lines:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text("\n".join([*lines, line]) + "\n")
    temporary.replace(path)


def _prepare_future_worktrees(cwd):
    """Make newly created Claude worktrees inherit the already-merged local settings."""
    root = _git_root(cwd)
    if root is None:
        return None
    include = root / WORKTREE_INCLUDE_FILE
    _append_unique_line(include, WORKTREE_SETTINGS_PATH)
    exclude = _git_exclude_path(root)
    if exclude is not None:
        for relative_path in (WORKTREE_SETTINGS_PATH, WORKTREE_INCLUDE_FILE):
            if not _is_tracked(root, relative_path) and not _is_ignored(root, relative_path):
                _append_unique_line(exclude, relative_path)
    return str(include)


def _owned_hook(name, root_id=None):
    hook = {
        "type": "command",
        "command": _runtime_hook_command(name),
        OWNER_FIELD: OWNER_VALUE,
    }
    if root_id:
        hook[ROOT_FIELD] = root_id
    return hook


def _read(path):
    if not path.exists():
        return {}
    data = json.loads(path.read_text())
    if not isinstance(data, dict):
        raise ValueError("Claude settings must contain a JSON object")
    return data


def _write(path, settings):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(settings, ensure_ascii=False, indent=2) + "\n")
    temporary.replace(path)


def _is_owned(hook):
    if not isinstance(hook, dict):
        return False
    if hook.get(OWNER_FIELD) == OWNER_VALUE:
        return True
    command = hook.get("command")
    return command in {
        *(_runtime_hook_command(name) for _, name in HOOK_BINDINGS),
        *(_source_hook_path(name) for _, name in HOOK_BINDINGS),
    }


def _ensure_project_hooks_at(cwd, root_id=None):
    path = _settings_path(cwd)
    settings = _read(path)
    hooks = settings.setdefault("hooks", {})
    for event, name in HOOK_BINDINGS:
        entries = hooks.setdefault(event, [])
        cleaned_entries = []
        for entry in entries:
            if not isinstance(entry, dict) or not isinstance(entry.get("hooks"), list):
                cleaned_entries.append(entry)
                continue
            kept_hooks = [hook for hook in entry["hooks"] if not _is_owned(hook)]
            if kept_hooks:
                updated = dict(entry)
                updated["hooks"] = kept_hooks
                cleaned_entries.append(updated)
        hooks[event] = entries = cleaned_entries
        desired = _owned_hook(name, root_id=root_id)
        target = None
        for entry in entries:
            if isinstance(entry, dict) and entry.get("matcher") == "*":
                target = entry
                break
        if target is None:
            target = {"matcher": "*", "hooks": []}
            entries.append(target)
        event_hooks = target.setdefault("hooks", [])
        event_hooks.append(desired)
    _write(path, settings)
    return str(path)


def ensure_project_hooks(cwd, root_id=None):
    state_store.ensure_runtime_assets()
    _prepare_future_worktrees(cwd)
    paths = [_ensure_project_hooks_at(root, root_id=root_id) for root in _worktree_roots(cwd)]
    return paths[0] if paths else str(_settings_path(cwd))


def _cleanup_project_hooks_at(cwd, root_id=None):
    path = _settings_path(cwd)
    if not path.exists():
        return None
    settings = _read(path)
    hooks = settings.get("hooks")
    if isinstance(hooks, dict):
        for event in list(hooks):
            entries = hooks[event]
            if not isinstance(entries, list):
                continue
            kept_entries = []
            for entry in entries:
                if not isinstance(entry, dict) or not isinstance(entry.get("hooks"), list):
                    kept_entries.append(entry)
                    continue
                kept_hooks = [
                    hook
                    for hook in entry["hooks"]
                    if not (
                        _is_owned(hook)
                        and (
                            root_id is None
                            or not hook.get(ROOT_FIELD)
                            or hook.get(ROOT_FIELD) == root_id
                        )
                    )
                ]
                if kept_hooks:
                    updated = dict(entry)
                    updated["hooks"] = kept_hooks
                    kept_entries.append(updated)
            if kept_entries:
                hooks[event] = kept_entries
            else:
                hooks.pop(event, None)
        if not hooks:
            settings.pop("hooks", None)
    if settings:
        _write(path, settings)
    else:
        path.unlink()
    return str(path)


def cleanup_project_hooks(cwd, root_id=None):
    paths = [_cleanup_project_hooks_at(root, root_id=root_id) for root in _worktree_roots(cwd)]
    return paths[0] if paths else None
