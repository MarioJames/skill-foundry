---
name: agents-orchestrator
description: Explicit task-tree orchestration through one durable Runtime. Use only when the user explicitly asks to start, use, run, continue, resume, recover, reap, or stop orchestration with a standalone activation such as `$agents-orchestrator`, `agents-orchestrator`, `swarm mode`, `loop mode`, `multi-agent review`, `multi-Agent plan review`, or the legacy `agent-swarm`, `agent swarm`, `agentswram`, or `蜂群模式`; also use when a Runtime-injected `[ORCHESTRATION IDENTITY]` block is present. Do not trigger for ordinary reviews or complex tasks, paths or links containing these names, quoted or example mentions, or requests merely to explain, inspect, edit, rename, or optimize this skill.
---

# Agents Orchestrator

Coordinate one foreground Root and background child Agents through the Python Runtime in this
skill directory. Treat `skills/agents-orchestrator` as canonical; `agent-swarm` is only a legacy
alias. Resolve `<skill_dir>` from this file.

## Invariants

- Invoke the Runtime only when the frontmatter activation boundary is satisfied.
- With `[ORCHESTRATION IDENTITY]`, use the injected `AGENTS_ORCHESTRATOR_*` or legacy
  `AGENT_SWARM_*` identity exactly as supplied and never initialize a second Run.
- For resume or recovery intent, call `recover` immediately; never preflight storage or replace a
  failed recovery with `init`.
- Delegate only through Runtime `create_tasks` or persistent mode Actions; never launch child Agent
  processes directly.
- Run `bootstrap-cwd` before substantial child work and again after entering another worktree.
- Submit `submit_estimate` before work and `finish` after integration and validation. Prose does
  not update Runtime state.
- Never reuse a terminal Attempt. Stop business Actions after `stop` reports `status: cancelled`.

## Operate

Read [runtime-contract.md](references/runtime-contract.md) before using the Runtime and
[action-schemas.md](references/action-schemas.md) when composing Actions.

For a new Run:

```bash
python3 <skill_dir>/scripts/agent_orchestrator.py init \
  --task "<user goal>" --cwd "$(pwd)"
```

The first ACP `init` installs the pinned Python SDK plus Codex and Claude Code ACP Agents into
`$HOME/.agents-orchestrator/dependencies`. Keep Codex as the default profile; installing Claude
does not select it.

Keep every returned identity field and actor token. A child with injected identity begins with:

```bash
python3 "$AGENTS_ORCHESTRATOR_SKILL_DIR/scripts/agent_orchestrator.py" bootstrap-cwd
```

Explicit wording selects a recipe hint: `swarm mode` or the legacy alias maps to `swarm`; `loop
mode` / `develop-review-improve` maps to `develop_review_improve`; `multi-agent review` maps to
`multi_session_review`. `--entry-mode swarm|loop|review` records that normalized hint, but the mode
begins only after `submit_estimate` and a matching `start_mode` Action. It never starts a second
Runtime or bypasses the estimate gate.

Submit Actions as one JSON object on stdin; query the exact schema before guessing:

```bash
python3 <skill_dir>/scripts/agent_orchestrator.py action-schema <ACTION_TYPE>
printf '%s' '<JSON object>' | python3 <skill_dir>/scripts/agent_orchestrator.py \
  action --type <ACTION_TYPE> --stdin
```

Choose and compile the requested orchestration recipe into Tasks and Actions; modes are not a
second Runtime and there is no `init --mode` flag. Read
[operating-modes.md](references/operating-modes.md) for swarm, bounded loop,
develop-review-improve, and composed pipelines. Read
[review-consensus.md](references/review-consensus.md) for multi-Agent plan or artifact review.

Read [recovery-protocol.md](references/recovery-protocol.md) for recover, reap, inspect, or stop.
Read [acp-sdk.md](references/acp-sdk.md) before configuring or diagnosing ACP. Codex ACP is the
default Backend/profile; select `--backend claude_cli` explicitly for the legacy Claude CLI
Backend. Predeclare ACP diversity with `--profile-allowlist-json '["codex","claude"]'` and
`--default-profile codex`; child `profile_hint` values may only name that frozen allowlist.

## Discipline

- Use Notes only for reusable decisions and pitfalls.
- Treat Task, Attempt, Launch, and ACP Session as distinct objects.
- Treat review and fix as Intents, not permanent Agent roles.
- A timed-out `wait` is not Task failure; inspect results and wait again when appropriate.
- Runtime gates prove lifecycle structure, not semantic quality, complete write isolation, or the
  truth of reported validation.
