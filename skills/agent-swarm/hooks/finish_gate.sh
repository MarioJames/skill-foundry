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
STOP_HOOK_ACTIVE="$(HOOK_JSON="$HOOK_JSON" python3 - <<'PY'
import json
import os

try:
    data = json.loads(os.environ.get("HOOK_JSON") or "{}")
except ValueError:
    data = {}
print("true" if data.get("stop_hook_active") else "false")
PY
)"

if [ "$EVENT_NAME" != "Stop" ]; then
  printf '{"skipped":true,"reason":"not Stop"}\n'
  exit 0
fi

# Claude marks the next Stop callback after a previous block. Let that guarded
# callback exit so a malformed hook response cannot keep a session alive forever.
if [ "$STOP_HOOK_ACTIVE" = "true" ]; then
  printf '{}\n'
  exit 0
fi

for name in AGENT_SWARM_ROOT_ID AGENT_SWARM_TASK_ID AGENT_SWARM_ATTEMPT_ID AGENT_SWARM_AGENT_ID AGENT_SWARM_ACTOR_TOKEN; do
  if [ -z "${!name:-}" ]; then
    printf '{"skipped":true,"reason":"missing orchestration identity"}\n'
    exit 0
  fi
done

RUNTIME_HOME="${AGENT_SWARM_HOME:-$HOME/.agent-swarm}"
SCRIPT_DIR="$RUNTIME_HOME/scripts"
INSPECTION="$(python3 "$SCRIPT_DIR/hook_runtime.py" inspect-current 2>/dev/null || true)"
STATE="$(HOOK_INSPECTION="$INSPECTION" python3 - <<'PY'
import json
import os

try:
    data = json.loads(os.environ.get("HOOK_INSPECTION") or "{}")
except ValueError:
    data = {}
task = data.get("task") if isinstance(data, dict) else None
attempt = data.get("attempt") if isinstance(data, dict) else None
agent = data.get("agent") if isinstance(data, dict) else None
if not all(isinstance(value, dict) for value in (task, attempt, agent)):
    print("unknown")
elif (
    task.get("status") in {"done", "failed", "blocked", "cancelled"}
    and attempt.get("status") in {"done", "failed", "cancelled"}
    and agent.get("state") == "terminal"
):
    print("terminal")
else:
    print("unfinished")
PY
)"

if [ "$STATE" = "unfinished" ]; then
  printf '%s\n' '{"decision":"block","reason":"Agent Swarm Runtime requires this Attempt to submit finish before the Claude session can stop. Submit finish with validation and caveats, or report a failed finish when appropriate."}'
else
  # An unavailable inspection must not turn a cleanup hook into an unbounded
  # stop loop. Runtime Actions still enforce all lifecycle transitions.
  printf '{}\n'
fi
