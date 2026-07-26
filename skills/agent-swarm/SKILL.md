---
name: agent-swarm
description: Legacy explicit-only alias for the canonical agents-orchestrator skill. Use only when the user explicitly asks to start, use, run, continue, resume, or recover orchestration with standalone `agent-swarm`, `agent swarm`, `agentswram`, or `蜂群模式` wording. Do not trigger for paths, links, quoted or example mentions, ordinary complex tasks or reviews, or requests merely to explain, inspect, edit, rename, or optimize Agent Swarm.
---

# Agent Swarm compatibility alias

Use the sibling `agents-orchestrator` package as the sole implementation. Read
`../agents-orchestrator/SKILL.md`, default the requested recipe to `swarm`, and follow its activation,
identity, lifecycle, recovery, and validation rules.

This package never owns Runtime state and contains no Runtime copy. Its entrypoint only replaces
itself with `../agents-orchestrator/scripts/agent_orchestrator.py`. If the canonical package is
missing, stop and ask the user to install `agents-orchestrator`; never initialize a fallback Run.

If `[ORCHESTRATION IDENTITY]` or `AGENT_SWARM_*` identity is already present, preserve it and never
call `init`. One user request maps to one canonical Run.
