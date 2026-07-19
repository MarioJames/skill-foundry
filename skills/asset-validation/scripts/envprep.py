import json
import os
import shutil
import tempfile
import time
from pathlib import Path
from typing import Optional

from . import db


def _tmp_root() -> Path:
    for key in ("ACCEPTANCE_TMPDIR", "TMPDIR", "TMP", "TEMP"):
        value = os.environ.get(key)
        if value:
            return Path(value)
    return Path(tempfile.gettempdir())


def make_sandbox(round_tag) -> Path:
    base = _tmp_root() / f"acc-{round_tag}"
    base.mkdir(parents=True, exist_ok=True)
    return base


def rsync_fixture(fixture_path, sandbox) -> Optional[Path]:
    if not fixture_path:
        return None
    src = Path(fixture_path)
    if not src.exists():
        return None
    dest = Path(sandbox) / src.name
    shutil.copytree(src, dest, dirs_exist_ok=True)
    return dest


def _ensure_json_object(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return
        except (OSError, json.JSONDecodeError):
            pass
    path.write_text("{}\n", encoding="utf-8")


def _sandbox_claude_settings(home: Path) -> dict:
    """Copy only settings needed for auth/model/permissions into sandbox."""
    src = home / ".claude" / "settings.json"
    try:
        data = json.loads(src.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        data = {}
    if not isinstance(data, dict):
        data = {}
    return {
        key: data[key]
        for key in ("env", "permissions", "model")
        if key in data
    }


def prepare_round_environment(sandbox, source_home: Optional[Path] = None) -> dict:
    sb = Path(sandbox)
    acc_home = sb / ".aut-acceptance"
    iso = sb / ".iso"
    tmp = sb / ".tmp"
    home = Path(source_home) if source_home else Path.home()
    settings = iso / "claude-settings.json"
    try:
        depth = int(os.environ.get("ACCEPTANCE_DEPTH", "0")) + 1
    except ValueError:
        depth = 1
    for path in (acc_home, iso, tmp):
        path.mkdir(parents=True, exist_ok=True)
    _ensure_json_object(settings)
    settings.write_text(
        json.dumps(_sandbox_claude_settings(home), ensure_ascii=False, indent=2)
        + "\n",
        encoding="utf-8",
    )
    return {
        "ACCEPTANCE_SANDBOX": str(sb),
        "ACCEPTANCE_HOME": str(acc_home),
        "ACCEPTANCE_TMPDIR": str(tmp),
        "ACCEPTANCE_DEPTH": str(depth),
        "TMPDIR": str(tmp),
        "TMP": str(tmp),
        "TEMP": str(tmp),
        "HOME": str(home),
        "CMDAI_CODEX_MARKETPLACE_ROOT": str(iso / "codex-marketplace"),
        "CMDAI_CLAUDE_MARKETPLACE_ROOT": str(iso / "claude-marketplace"),
        "CMDAI_CODEX_AGENTS_ROOT": str(iso / "codex-agents"),
        "CMDAI_CLAUDE_SETTINGS_PATH": str(settings),
        "BH_PROFILE_ROOT": str(iso / "bh-profiles"),
    }


def isolation_env(sandbox) -> dict:
    return prepare_round_environment(sandbox)


def cleanup_sandbox(sandbox) -> dict:
    sb = Path(sandbox)
    tmp = sb / ".tmp"
    nested = _cleanup_nested_sandboxes(sb)
    existed = sb.exists()
    tmp_existed = tmp.exists()
    if existed:
        _rmtree_retry(sb)
    return {
        "removed": str(sb),
        "existed": existed,
        "tmpdir": str(tmp),
        "tmpdir_existed": tmp_existed,
        "tmpdir_removed": tmp_existed and not tmp.exists(),
        "nested_sandboxes": nested,
    }


def _cleanup_nested_sandboxes(sandbox: Path) -> list:
    state_db = sandbox / ".aut-acceptance" / "state.sqlite3"
    return [
        _cleanup_nested_sandbox(path, sandbox)
        for path in db.round_sandbox_paths_from(state_db)
        if _is_safe_nested_sandbox(path, sandbox)
    ]


def _cleanup_nested_sandbox(path, parent_sandbox: Path) -> dict:
    nested = Path(path)
    existed = nested.exists()
    if existed:
        _rmtree_retry(nested)
    return {
        "path": str(nested),
        "existed": existed,
        "removed": existed and not nested.exists(),
    }


def _is_safe_nested_sandbox(path, parent_sandbox: Path) -> bool:
    nested = Path(path)
    if not nested.is_absolute() or not nested.name.startswith("acc-"):
        return False
    try:
        nested_resolved = nested.resolve()
        parent_resolved = parent_sandbox.resolve()
        tmp_resolved = _tmp_root().resolve()
    except OSError:
        return False
    if nested_resolved == parent_resolved:
        return False
    return (
        parent_resolved in nested_resolved.parents
        or tmp_resolved in nested_resolved.parents
        or nested_resolved.parent == tmp_resolved
    )


def _rmtree_retry(path: Path, attempts: int = 4) -> None:
    for attempt in range(attempts):
        try:
            shutil.rmtree(path)
            return
        except FileNotFoundError:
            return
        except OSError:
            if attempt + 1 >= attempts:
                raise
            time.sleep(0.1 * (attempt + 1))
