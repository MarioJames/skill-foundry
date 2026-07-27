---
name: agent-swarm
description: Legacy explicit-only alias for the canonical agents-orchestrator skill. Use only when the user explicitly asks to start, use, run, continue, resume, or recover orchestration with standalone `agent-swarm`, `agent swarm`, `agentswram`, or `蜂群模式` wording. Do not trigger for paths, links, quoted or example mentions, ordinary complex tasks or reviews, or requests merely to explain, inspect, edit, rename, or optimize Agent Swarm.
---

# Agent Swarm compatibility alias

Use the sibling `agents-orchestrator` package as the sole implementation. Read
`../agents-orchestrator/SKILL.md`, default a new request to the `swarm` recipe hint, and follow its
activation, identity, lifecycle, recovery, and validation rules.

This package owns no Runtime, schema, tests, or dependencies. Its only executable is
`scripts/bootstrap.ts`, which forwards to `../agents-orchestrator/scripts/bootstrap.ts`. The first
launch therefore has the same Bun/network requirement and managed dependency cache as the canonical
Skill. If the canonical package is missing, stop with that explicit error; never initialize a
fallback Run.

For a new compatibility Run:

```bash
bun <skills_root>/agent-swarm/scripts/bootstrap.ts init \
  --task "<user goal>" --cwd "$(pwd)"
```

The alias injects the `swarm` entry hint only for a fresh `init`. If a complete orchestration
identity already exists, preserve it and never call `init`. Unequal canonical/legacy environment
values fail closed. One user request maps to one canonical Run.
