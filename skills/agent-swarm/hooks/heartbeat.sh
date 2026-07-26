#!/usr/bin/env bash
set -euo pipefail

HOOK_JSON="$(cat || true)"
EVENT_NAME="$(HOOK_JSON="$HOOK_JSON" python3 - <<'PY'
import json
import os

try:
    data = json.loads(os.environ.get("HOOK_JSON") or "{}")
except ValueError:
    data = {}
print(data.get("hook_event_name") or data.get("event_name") or "")
PY
)"

if [ "$EVENT_NAME" != "SessionStart" ] && [ "$EVENT_NAME" != "PostToolUse" ]; then
  printf '{"skipped":true,"reason":"not SessionStart or PostToolUse"}\n'
  exit 0
fi

for name in AGENT_SWARM_ROOT_ID AGENT_SWARM_TASK_ID AGENT_SWARM_ATTEMPT_ID AGENT_SWARM_ACTOR_TOKEN; do
  if [ -z "${!name:-}" ]; then
    printf '{"skipped":true,"reason":"missing orchestration identity"}\n'
    exit 0
  fi
done

RUNTIME_HOME="${AGENT_SWARM_HOME:-$HOME/.agent-swarm}"
SCRIPT_DIR="$RUNTIME_HOME/scripts"
python3 "$SCRIPT_DIR/hook_runtime.py" heartbeat
