#!/usr/bin/env bash
set -euo pipefail

RUNTIME_HOME="${AGENTS_ORCHESTRATOR_HOME:-${AGENT_SWARM_HOME:-$HOME/.agent-swarm}}"
exec bun "$RUNTIME_HOME/scripts/hook_runtime.ts" hook-event finish
