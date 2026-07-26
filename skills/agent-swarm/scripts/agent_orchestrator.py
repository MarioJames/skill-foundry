#!/usr/bin/env python3
"""Legacy entrypoint that execs the sole Agents Orchestrator Runtime."""

import os
import pathlib
import sys


DEFAULT_MODE = "swarm"
IDENTITY_SUFFIXES = ("ROOT_ID", "TASK_ID", "ATTEMPT_ID", "ACTOR_TOKEN")
CANONICAL_ENTRYPOINT = (
    pathlib.Path(__file__).resolve().parents[2]
    / "agents-orchestrator"
    / "scripts"
    / "agent_orchestrator.py"
)


def has_injected_identity():
    return any(
        os.environ.get(prefix + suffix)
        for prefix in ("AGENTS_ORCHESTRATOR_", "AGENT_SWARM_")
        for suffix in IDENTITY_SUFFIXES
    )


def main():
    if not CANONICAL_ENTRYPOINT.is_file():
        raise SystemExit(
            "agent-swarm is a compatibility alias; install the sibling "
            "agents-orchestrator skill"
        )
    if sys.argv[1:2] == ["init"] and has_injected_identity():
        raise SystemExit(
            "agent-swarm refuses init with an injected orchestration identity; "
            "use the existing canonical Run"
        )
    canonical_mode = os.environ.get("AGENTS_ORCHESTRATOR_MODE", "").strip() or None
    legacy_mode = os.environ.get("AGENT_SWARM_MODE", "").strip() or None
    if canonical_mode and legacy_mode and canonical_mode != legacy_mode:
        raise SystemExit(
            "conflicting orchestration environment: AGENTS_ORCHESTRATOR_MODE "
            "does not match AGENT_SWARM_MODE"
        )
    selected_mode = canonical_mode or legacy_mode or DEFAULT_MODE
    os.environ["AGENTS_ORCHESTRATOR_MODE"] = selected_mode
    os.environ["AGENT_SWARM_MODE"] = selected_mode
    os.execv(
        sys.executable,
        [sys.executable, str(CANONICAL_ENTRYPOINT), *sys.argv[1:]],
    )


if __name__ == "__main__":
    main()
