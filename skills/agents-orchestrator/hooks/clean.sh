#!/usr/bin/env bash
set -euo pipefail

RUNTIME_HOME="${AGENTS_ORCHESTRATOR_HOME:-$HOME/.agents-orchestrator}"
exec bun "$RUNTIME_HOME/scripts/hook_runtime.ts" hook-event clean
