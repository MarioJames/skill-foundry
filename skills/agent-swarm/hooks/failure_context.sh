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

if [ "$EVENT_NAME" != "PostToolUseFailure" ]; then
  printf '{"skipped":true,"reason":"not PostToolUseFailure"}\n'
  exit 0
fi

for name in AGENT_SWARM_ROOT_ID AGENT_SWARM_TASK_ID AGENT_SWARM_ATTEMPT_ID AGENT_SWARM_ACTOR_TOKEN; do
  if [ -z "${!name:-}" ]; then
    printf '{"skipped":true,"reason":"missing orchestration identity"}\n'
    exit 0
  fi
done

printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PostToolUseFailure","additionalContext":"Agent Swarm observed a tool failure. Inspect the error before proceeding; retry safely or revise the estimate. Record only reusable pitfalls with write_note, and do not claim completion without the Runtime finish action."}}'
