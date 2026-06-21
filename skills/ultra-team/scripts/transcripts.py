import json
import pathlib


def session_transcript_path(session_id: str, cwd=None):
    if not session_id:
        return None
    projects = pathlib.Path.home() / ".claude" / "projects"
    if not projects.exists():
        return None
    matches = sorted(projects.glob(f"*/{session_id}.jsonl"))
    if not matches:
        return None
    if cwd:
        encoded = encode_project_path(cwd)
        for path in matches:
            if path.parent.name == encoded:
                return path
    return matches[-1]


def encode_project_path(cwd: str) -> str:
    return str(pathlib.Path(cwd).resolve()).replace("/", "-")


def latest_activity(session_id: str, cwd=None):
    path = session_transcript_path(session_id, cwd=cwd)
    if not path or not path.exists():
        return None
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return None
    return {"path": str(path), "latest_at": mtime}


def recovery_signal(session_id: str, cwd=None, scan_limit: int = 40):
    path = session_transcript_path(session_id, cwd=cwd)
    if not path or not path.exists():
        return None
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return None
    scanned = 0
    for line in reversed(lines):
        if not line.strip():
            continue
        try:
            data = json.loads(line)
        except json.JSONDecodeError:
            continue
        scanned += 1
        if data.get("type") == "away_summary":
            return {
                "reason": "away_summary",
                "summary": data.get("content") or "",
            }
        if is_empty_assistant_end_turn(data):
            return {
                "reason": "empty_end_turn",
                "summary": "",
            }
        if scanned >= scan_limit:
            break
    if meaningful_event_count(lines) >= 2:
        return {
            "reason": "transcript_activity",
            "summary": "transcript has multiple runtime events",
        }
    return None


def is_empty_assistant_end_turn(data):
    message = data.get("message")
    if not isinstance(message, dict) or message.get("role") != "assistant":
        return False
    if data.get("stop_reason") != "end_turn" and message.get("stop_reason") != "end_turn":
        return False
    content = message.get("content")
    if content in ("", None):
        return True
    if not isinstance(content, list):
        return False
    for item in content:
        if not isinstance(item, dict):
            return False
        if item.get("type") != "text":
            return False
        if (item.get("text") or "").strip():
            return False
    return True


def meaningful_event_count(lines):
    count = 0
    for line in lines:
        if not line.strip():
            continue
        try:
            data = json.loads(line)
        except json.JSONDecodeError:
            continue
        if is_meaningful_runtime_event(data):
            count += 1
    return count


def is_meaningful_runtime_event(data):
    type_ = data.get("type")
    if type_ == "assistant":
        return True
    if type_ == "attachment":
        return True
    if type_ == "user":
        message = data.get("message")
        if not isinstance(message, dict):
            return False
        content = message.get("content")
        if isinstance(content, list):
            return any(isinstance(item, dict) and item.get("type") == "tool_result" for item in content)
        return isinstance(content, str) and bool(content.strip())
    return False
