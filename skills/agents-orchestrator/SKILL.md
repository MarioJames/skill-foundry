---
name: agents-orchestrator
description: Explicit task-tree orchestration through one durable Runtime. Use only when the user explicitly asks to start, use, run, continue, resume, recover, reap, or stop orchestration with a standalone activation such as `$agents-orchestrator`, `agents-orchestrator`, `swarm mode`, `loop mode`, `multi-agent review`, `multi-Agent plan review`, or the legacy `agent-swarm`, `agent swarm`, `agentswram`, or `蜂群模式`; also use when a Runtime-injected `[ORCHESTRATION IDENTITY]` block is present. Do not trigger for ordinary reviews or complex tasks, paths or links containing these names, quoted or example mentions, or requests merely to explain, inspect, edit, rename, or optimize this skill.
---

# Agents Orchestrator

Coordinate one foreground Root and background children through the TypeScript/Bun Runtime in this
directory. `skills/agents-orchestrator` is canonical; `agent-swarm` is only a compatibility alias.
Resolve `<skill_dir>` from this file.

## Invariants

- Invoke the Runtime only when the frontmatter activation boundary is satisfied.
- With `[ORCHESTRATION IDENTITY]`, use the injected `AGENTS_ORCHESTRATOR_*` or equal legacy
  `AGENT_SWARM_*` identity and never initialize a second Run.
- For resume or recovery intent, call `recover` immediately. Never replace failed recovery with
  `init`.
- Delegate only through `create_tasks` or persistent-mode Actions; never start child processes
  directly.
- Run `bootstrap-cwd` before substantial child work and after entering another worktree.
- Submit `submit_estimate` before work and `finish` after integration and validation. Prose does not
  update Runtime state.
- Never reuse a terminal Attempt. After `stop` returns `status: cancelled`, submit no more business
  Actions.

## Operate

Read [runtime-contract.md](references/runtime-contract.md) before operating the Runtime and
[action-schemas.md](references/action-schemas.md) before composing Actions.

Bun is required. The first launch needs network access and installs the exact locked dependencies
into `$HOME/.agents-orchestrator/dependencies` (override with
`$AGENTS_ORCHESTRATOR_DEPENDENCY_HOME`; legacy `$AGENT_SWARM_DEPENDENCY_HOME` is accepted). Later
launches reuse the verified content-addressed cache. The Skill does not contain or create a local
`node_modules` directory.

For a new Run:

```bash
bun <skill_dir>/scripts/bootstrap.ts init \
  --task "<user goal>" --cwd "$(pwd)"
```

The default Backend/profile is ACP + Codex. First use prepares both Codex ACP and Claude Code ACP
in one managed dependency tree; Claude is installed but is not selected or executed automatically.
Gemini is installed only when its fixed profile is explicitly selected. A custom ACP command is
never installed or replaced.

Keep every returned identity field and actor token. A child with injected identity begins with:

```bash
bun "$AGENTS_ORCHESTRATOR_SKILL_DIR/scripts/bootstrap.ts" bootstrap-cwd
```

Explicit wording selects only a recipe hint: `swarm mode` or the compatibility alias maps to
`swarm`; `loop mode` / `develop-review-improve` maps to `develop_review_improve`; `multi-agent
review` maps to `multi_session_review`. `--entry-mode swarm|loop|review` records that normalized
hint. A mode begins only after `submit_estimate` and the matching `start_mode` Action.

Submit one Action JSON object on stdin and query its exact schema before use:

```bash
bun <skill_dir>/scripts/bootstrap.ts action-schema <ACTION_TYPE>
printf '%s' '<JSON object>' | bun <skill_dir>/scripts/bootstrap.ts \
  action --type <ACTION_TYPE> --stdin
```

Modes compile into Tasks in the same Run and Task tree; there is no `init --mode`. Read
[operating-modes.md](references/operating-modes.md) for swarm, the bounded improvement loop, and
composition. Read [review-consensus.md](references/review-consensus.md) for independent ACP review.

Read [recovery-protocol.md](references/recovery-protocol.md) for recover, reap, inspect, doctor, or
stop. Read [acp-sdk.md](references/acp-sdk.md) before configuring ACP. Select
`--backend claude_cli` explicitly only for the legacy Claude CLI Backend. Predeclare ACP diversity
with `--profile-allowlist-json '["codex","claude"]' --default-profile codex`; a child
`profile_hint` may only name that frozen allowlist.

## Discipline

- Use Notes only for reusable decisions and pitfalls.
- Treat Task, Attempt, Launch, and ACP Session as distinct objects.
- Treat review and fix as Intents, not permanent roles.
- A timed-out `wait` is not Task failure; inspect results and wait again when appropriate.
- Runtime gates prove lifecycle structure, not semantic quality, complete write isolation, or the
  truth of reported validation.
