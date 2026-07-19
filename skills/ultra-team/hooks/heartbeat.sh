#!/usr/bin/env bash
set -euo pipefail

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_DIR="$(cd "$HOOK_DIR/../scripts" && pwd)"
HOOK_JSON="$(cat || true)"

PYTHONPATH="$SCRIPT_DIR" HOOK_JSON="$HOOK_JSON" python3 - <<'PY'
import json
import os
import subprocess

import state_store
import transcripts

raw = os.environ.get("HOOK_JSON", "").strip()
data = {}
if raw:
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        data = {}

event = data.get("hook_event_name") or data.get("event_name") or os.environ.get("CLAUDE_HOOK_EVENT_NAME", "")
if event != "PostToolUse":
    print(json.dumps({"skipped": True, "reason": "not PostToolUse", "hook_event_name": event}, ensure_ascii=False))
    raise SystemExit

def first_string(*keys):
    for key in keys:
        value = data.get(key)
        if isinstance(value, str) and value:
            return value
    return ""

def detect_branch(cwd):
    if not cwd:
        return None
    out = subprocess.run(
        ["git", "-C", cwd, "branch", "--show-current"],
        capture_output=True,
        text=True,
        check=False,
    )
    branch = out.stdout.strip()
    if out.returncode == 0 and branch:
        return branch
    out = subprocess.run(
        ["git", "-C", cwd, "rev-parse", "--short", "HEAD"],
        capture_output=True,
        text=True,
        check=False,
    )
    rev = out.stdout.strip()
    if out.returncode == 0 and rev:
        return f"detached:{rev}"
    return ""

cwd = first_string("cwd", "project_dir", "current_dir") or os.environ.get("CLAUDE_PROJECT_DIR") or os.environ.get("PWD", "")
agent_id = first_string("agent_id", "agentId")
root_id = first_string("root_id", "rootId")
branch = first_string("branch", "git_branch", "gitBranch")
if not branch:
    branch = detect_branch(cwd)
session_id = first_string("session_id", "sessionId") or os.environ.get("CLAUDE_SESSION_ID", "")
job_id = first_string("job_id", "jobId")
touched = state_store.touch_running_agents_for_hook(
    cwd,
    agent_id=agent_id,
    root_id=root_id,
    job_id=job_id,
    branch=branch,
    session_id=session_id,
)
transcript_activity = []
if session_id:
    latest = transcripts.latest_activity(session_id, cwd=cwd)
    if latest:
        for item in touched:
            updated = state_store.update_transcript_activity(
                item["agent_id"],
                item["root_id"],
                latest["path"],
                latest["latest_at"],
            )
            if updated:
                transcript_activity.append(updated)
resolved_agent_id = touched[0]["agent_id"] if len(touched) == 1 else agent_id
resolved_root_id = touched[0]["root_id"] if len(touched) == 1 else root_id
print(json.dumps({
    "event": "PostToolUse",
    "cwd": cwd,
    "agent_id": resolved_agent_id,
    "root_id": resolved_root_id,
    "input_agent_id": agent_id,
    "input_root_id": root_id,
    "branch": branch,
    "session_id": session_id,
    "job_id": job_id,
    "touched": touched,
    "transcript_activity": transcript_activity,
}, ensure_ascii=False))
PY
