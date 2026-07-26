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

IDENTITY_COUNT=0
CANONICAL_COUNT=0
LEGACY_COUNT=0
for suffix in ROOT_ID TASK_ID ATTEMPT_ID ACTOR_TOKEN; do
  canonical_name="AGENTS_ORCHESTRATOR_${suffix}"
  legacy_name="AGENT_SWARM_${suffix}"
  canonical_value="${!canonical_name:-}"
  legacy_value="${!legacy_name:-}"
  if [ -n "$canonical_value" ]; then CANONICAL_COUNT=$((CANONICAL_COUNT + 1)); fi
  if [ -n "$legacy_value" ]; then LEGACY_COUNT=$((LEGACY_COUNT + 1)); fi
  if [ -n "$canonical_value" ] && [ -n "$legacy_value" ] && [ "$canonical_value" != "$legacy_value" ]; then
    printf 'conflicting orchestration identity: %s does not match %s\n' "$canonical_name" "$legacy_name" >&2
    exit 2
  fi
  resolved_value="${canonical_value:-$legacy_value}"
  if [ -n "$resolved_value" ]; then
    IDENTITY_COUNT=$((IDENTITY_COUNT + 1))
    printf -v "$canonical_name" '%s' "$resolved_value"
    printf -v "$legacy_name" '%s' "$resolved_value"
    export "$canonical_name" "$legacy_name"
  fi
done
if { [ "$CANONICAL_COUNT" -gt 0 ] && [ "$CANONICAL_COUNT" -ne 4 ]; } ||
   { [ "$LEGACY_COUNT" -gt 0 ] && [ "$LEGACY_COUNT" -ne 4 ]; }; then
  printf 'partial orchestration identity\n' >&2
  exit 2
fi
if [ "$IDENTITY_COUNT" -eq 0 ]; then
  printf '{"skipped":true,"reason":"missing orchestration identity"}\n'
  exit 0
fi
if [ -n "${AGENTS_ORCHESTRATOR_HOME:-}" ] && [ -n "${AGENT_SWARM_HOME:-}" ] && [ "$AGENTS_ORCHESTRATOR_HOME" != "$AGENT_SWARM_HOME" ]; then
  printf 'conflicting orchestration runtime home\n' >&2
  exit 2
fi
RUNTIME_HOME="${AGENTS_ORCHESTRATOR_HOME:-${AGENT_SWARM_HOME:-$HOME/.agent-swarm}}"
export AGENTS_ORCHESTRATOR_HOME="$RUNTIME_HOME"
export AGENT_SWARM_HOME="$RUNTIME_HOME"
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
if not all(isinstance(value, dict) for value in (task, attempt)):
    print("unknown")
elif (
    task.get("status") in {"done", "failed", "blocked", "cancelled"}
    and attempt.get("state") in {"done", "failed", "cancelled"}
):
    print("terminal")
else:
    print("unfinished")
PY
)"

if [ "$STATE" = "unfinished" ]; then
  printf '%s\n' '{"decision":"block","reason":"Agents Orchestrator Runtime requires this Attempt to submit finish before the Claude session can stop. Submit finish with validation and caveats, or report a failed finish when appropriate."}'
else
  # An unavailable inspection must not turn a cleanup hook into an unbounded
  # stop loop. Runtime Actions still enforce all lifecycle transitions.
  printf '{}\n'
fi
