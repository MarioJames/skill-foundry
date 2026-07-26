---
name: agent-swarm
description: Use only when the user explicitly asks to start, use, run, continue, resume, or recover a task-tree run with a standalone activation such as `agent-swarm`, `agent swarm`, `agentswram`, or `蜂群模式`, or when a Runtime-injected `[ORCHESTRATION IDENTITY]` block is present. **DO NOT** trigger for paths, links, quoted examples, ordinary complex tasks, or requests to review, explain, edit, rename, or optimize the Agent Swarm skill itself.
---

# Agent Swarm

Use the Python Runtime in this skill directory to coordinate one foreground Root session and
background Claude child sessions. Resolve `<skill_dir>` from this file's directory.

## **HARD CONSTRAINTS**

- **DO NOT** invoke this Runtime unless the current message satisfies the frontmatter activation boundary.
- **MUST** call `recover` (not `init`) for resume/recover intent; **DO NOT** preflight SQLite or invent recoverability.
- **NEVER** silently replace a failed recovery with `init`.
- With `[ORCHESTRATION IDENTITY]`, **MUST** use that identity; **NEVER** initialize another Run.
- **MUST** delegate children only via `create_tasks`; **DO NOT** start a child with `claude --bg` yourself.
- **NEVER** reuse an Attempt for a new Session.
- After `stop` reports `terminal: true`, **DO NOT** execute further business Actions for that Run.
- Every child **MUST** run `worktree-init` before substantial work in its current directory, and again immediately after creating or entering another worktree.

## Activation

Continue only when the current message satisfies the frontmatter activation boundary. If it does
not, handle the actual request normally and **DO NOT** invoke this Runtime.

If the user asks to resume or recover, **MUST** invoke the canonical recovery entrypoint immediately;
**DO NOT** inspect Runtime storage or preflight recoverability yourself:

```bash
python3 <skill_dir>/scripts/agent_orchestrator.py recover --cwd "$(pwd)"
```

Use `--root-id <root_id>` instead when the Run ID is known. Let `recover` report that no unique
recoverable Run exists, and **NEVER** silently replace a failed recovery with `init`. Otherwise:

- With no `[ORCHESTRATION IDENTITY]`, initialize a foreground Root.
- With `[ORCHESTRATION IDENTITY]`, use its `AGENT_SWARM_*` identity and **NEVER** initialize another Run.

When the foreground Root is healthy and only child Attempts need monitoring, use `reap` from the
recovery protocol instead of `recover`; `recover --force-takeover` replaces the Root identity.

Read [runtime-contract.md](references/runtime-contract.md) before operating the Runtime. Read
[recovery-protocol.md](references/recovery-protocol.md) for recovery or stop work. Query exact
payload shapes with `action-schema`; read [action-schemas.md](references/action-schemas.md) only
when examples are useful.

## Start a Root

```bash
python3 <skill_dir>/scripts/agent_orchestrator.py init \
  --task "<user goal>" \
  --cwd "$(pwd)"
```

Keep every returned identity field and actor token. Because `init` cannot alter the parent shell,
either export the returned values as `AGENT_SWARM_ROOT_ID`, `AGENT_SWARM_TASK_ID`,
`AGENT_SWARM_ATTEMPT_ID`, `AGENT_SWARM_AGENT_ID`, and `AGENT_SWARM_ACTOR_TOKEN`, or pass the
matching explicit identity arguments to every Action.

Before substantive work, submit `submit_estimate` with `strategy=direct|split`.

- For `direct`, do the task, validate it, and submit `finish`.
- For `split`, submit independent child tasks with clear output contracts and dependencies. The
  Runtime schedules and starts them. Use `wait`, integrate their results, then submit `finish`.
- If direct work expands materially, submit a revised split estimate before `create_tasks`.

Root may directly complete a simple task. It is not restricted to orchestration-only work.

## Run as a Child

Use the injected identity and submit an estimate before substantive work. A child may complete its
Task directly or recursively create child Tasks when the estimate and remaining budgets allow it.
Report completion through `finish`; prose alone does not update Runtime state.

## Runtime actions

Submit one JSON object on stdin:

```bash
python3 <skill_dir>/scripts/agent_orchestrator.py action \
  --type <submit_estimate|create_tasks|write_note|wait|finish> \
  --stdin
```

Use `--action-id <stable-id>` when retrying an uncertain Action submission. The same ID returns the
first response without duplicating state changes.

## Claude Hooks

The Runtime does not create Git worktrees: it launches `claude --bg` in the Run cwd. If Claude or
the child enters a worktree, that worktree is its own execution environment. The Runtime initializes
or merges owned Hook entries in the active project and registered Git worktrees, and writes the
local settings path to `.worktreeinclude` for future Claude-created worktrees. A child Action or
explicit heartbeat refreshes that Run's registered worktrees; child launch refreshes the set both
before and after launch without overriding user-level settings through a CLI settings overlay.
When the Runtime initializes, it copies only the Hook runtime (`hook_runtime.py`, `hook_manager.py`,
and `state_store.py`) plus Hook shell files into `$AGENT_SWARM_HOME` (default
`$HOME/.agent-swarm`). Project Hook commands resolve that Runtime home, not the source skill
directory; child launch exports the resolved home for custom installations.
Before substantial work in its current directory, every child **MUST** run:

```bash
python3 "$AGENT_SWARM_SKILL_DIR/scripts/agent_orchestrator.py" worktree-init
```

It **MUST** run the same command again immediately after creating or entering another worktree. The
command authenticates the injected identity, refreshes its heartbeat, and merges the local Hook
settings in that exact worktree. This gate is required even with a custom Claude `WorktreeCreate`
hook, because that hook replaces Claude's normal `.worktreeinclude` copy path.
`SessionStart` and
`PostToolUse` refresh an identified Agent heartbeat; `PostToolUseFailure` injects recovery guidance;
`Stop` prevents an identified, unfinished Attempt from silently ending without `finish`; and
`SessionEnd` records observation only. Hooks skip sessions without a full `AGENT_SWARM_*` identity.

Hooks **NEVER** initialize, recover, complete, or spawn a Run on their own. Runtime Actions remain the
only authority for lifecycle state and task-tree changes.

## Discipline

- **MUST** delegate only with `create_tasks`; **DO NOT** start a child with `claude --bg` yourself.
- Treat Task, Attempt, and Agent Session as different objects. **NEVER** reuse an Attempt for a new
  Session.
- Use Notes only for reusable decisions and pitfalls, not work logs.
- A timed-out `wait` window is not a Task failure; inspect results and wait again when needed.
- Review and fix are Intents, not fixed identities or leaf-only roles.
- Use only the v2 Actions and lifecycle described here.
- After `stop` returns terminal, **DO NOT** execute further business action for that Run.
- Runtime checks observable structure and lifecycle facts. **DO NOT** claim it proves semantic quality,
  complete file isolation, or the truth of validation text.
