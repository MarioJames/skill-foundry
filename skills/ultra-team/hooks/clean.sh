#!/usr/bin/env bash
set -euo pipefail

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_DIR="$(cd "$HOOK_DIR/../scripts" && pwd)"

HOOK_JSON="$(cat || true)"
HOOK_EVENT_NAME="$(
  HOOK_JSON="$HOOK_JSON" python3 - <<'PY'
import json
import os

raw = os.environ.get("HOOK_JSON", "").strip()
data = {}
if raw:
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        data = {}

value = data.get("hook_event_name") or data.get("event_name") or os.environ.get("CLAUDE_HOOK_EVENT_NAME", "")
print(value if isinstance(value, str) else "")
PY
)"

if [ "$HOOK_EVENT_NAME" != "SessionEnd" ]; then
  printf '{"skipped": true, "reason": "not SessionEnd", "hook_event_name": "%s"}\n' "$HOOK_EVENT_NAME"
  exit 0
fi

CLEAN_CWD="$(
  HOOK_JSON="$HOOK_JSON" python3 - <<'PY'
import json
import os

raw = os.environ.get("HOOK_JSON", "").strip()
data = {}
if raw:
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        data = {}

for key in ("cwd", "project_dir", "workspace", "current_dir"):
    value = data.get(key)
    if isinstance(value, str) and value:
        print(value)
        raise SystemExit

workspace = data.get("workspace")
if isinstance(workspace, dict):
    for key in ("current_dir", "project_dir"):
        value = workspace.get(key)
        if isinstance(value, str) and value:
            print(value)
            raise SystemExit

for key in ("CLAUDE_PROJECT_DIR", "CLAUDE_WORKSPACE", "PWD"):
    value = os.environ.get(key)
    if value:
        print(value)
        raise SystemExit
PY
)"

TARGET_CWD="${CLEAN_CWD:-$PWD}"
set +e
PYTHONPATH="$SCRIPT_DIR" HOOK_JSON="$HOOK_JSON" python3 - "$TARGET_CWD" <<'PY'
import json
import os
import subprocess
import sys

import state_store

target_cwd = sys.argv[1]
target = os.path.realpath(target_cwd)
raw = os.environ.get("HOOK_JSON", "").strip()
data = {}
if raw:
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        data = {}

def first_string(*keys):
    for key in keys:
        value = data.get(key)
        if isinstance(value, str) and value:
            return value
    return ""

agent_id = first_string("agent_id", "agentId")
root_id = first_string("root_id", "rootId")
session_id = first_string("session_id", "sessionId") or os.environ.get("CLAUDE_SESSION_ID", "")

def finish_known_child(agent):
    if agent.get("agent_id") == agent.get("root_id"):
        return False
    if agent.get("status") == "running":
        action = "observed_running_child_session_end"
    else:
        action = "known_child_terminal"
    print(json.dumps({
        "cwd": target_cwd,
        "agent_id": agent["agent_id"],
        "root_id": agent["root_id"],
        "session_id": session_id,
        "action": action,
    }, ensure_ascii=False))
    return True

if session_id:
    matches = state_store.agents_by_session_id(session_id, cwd=target_cwd)
    for agent in matches:
        if finish_known_child(agent):
            raise SystemExit(42)

if agent_id and root_id:
    agent = state_store.get_agent(agent_id)
    if agent and agent.get("root_id") == root_id and finish_known_child(agent):
        raise SystemExit(42)

def interactive_root_is_active():
    try:
        proc = subprocess.run(
            ["claude", "agents", "--json"],
            capture_output=True,
            text=True,
            check=False,
            timeout=10,
        )
    except Exception:
        return False
    if proc.returncode != 0:
        return False
    try:
        items = json.loads(proc.stdout or "[]")
    except json.JSONDecodeError:
        return False
    if not isinstance(items, list):
        return False
    for item in items:
        if not isinstance(item, dict):
            continue
        cwd = item.get("cwd") or ""
        if not cwd or os.path.realpath(cwd) != target:
            continue
        if item.get("kind") == "interactive" and item.get("status") != "exited":
            return True
    return False

if interactive_root_is_active():
    print(json.dumps({
        "cwd": target_cwd,
        "session_id": session_id,
        "action": "foreground_active_skip_cleanup",
    }, ensure_ascii=False))
    raise SystemExit(42)

root_ids = []
for run in state_store.list_runs():
    if run.get("status") != "running":
        continue
    run_cwd = run.get("cwd") or ""
    if run_cwd and os.path.realpath(run_cwd) == target:
        root_ids.append(run["root_id"])

if root_ids:
    print(json.dumps({"cwd": target_cwd, "root_ids": root_ids, "action": "root_session_end_observed"}, ensure_ascii=False))
    raise SystemExit(42)

print(json.dumps({"cwd": target_cwd, "root_ids": root_ids, "action": "cleanup_hooks_only"}, ensure_ascii=False))
PY
CLASSIFY_RC=$?
set -e
if [ "$CLASSIFY_RC" -eq 42 ]; then
  exit 0
fi
if [ "$CLASSIFY_RC" -ne 0 ]; then
  exit "$CLASSIFY_RC"
fi
python3 "$SCRIPT_DIR/agent_orchestrator.py" cleanup-hooks --cwd "$TARGET_CWD" >/dev/null
