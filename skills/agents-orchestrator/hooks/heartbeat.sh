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
python3 "$SCRIPT_DIR/hook_runtime.py" heartbeat
