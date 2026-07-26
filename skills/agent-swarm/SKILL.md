---
name: agent-swarm
description: Use only when the user explicitly asks to start, use, run, continue, resume, or recover a task-tree run with a standalone activation such as `agent-swarm`, `agent swarm`, `agentswram`, or `蜂群模式`, or when a Runtime-injected `[ORCHESTRATION IDENTITY]` block is present. **DO NOT** trigger for paths, links, quoted examples, ordinary complex tasks, or requests to review, explain, edit, rename, or optimize the Agent Swarm skill itself.
---

# Agent Swarm

Use the Python Runtime in this skill directory to coordinate one foreground Root session and
background child Agent sessions. The default execution Backend remains Claude CLI; ACP v1 is an
explicit opt-in. Resolve `<skill_dir>` from this file's directory.

## **HARD CONSTRAINTS**

- **DO NOT** invoke this Runtime unless the current message satisfies the frontmatter activation boundary.
- **MUST** call `recover` (not `init`) for resume/recover intent; **DO NOT** preflight SQLite or invent recoverability.
- **NEVER** silently replace a failed recovery with `init`.
- With `[ORCHESTRATION IDENTITY]`, **MUST** use that identity; **NEVER** initialize another Run.
- **MUST** delegate children only via `create_tasks`; **DO NOT** launch child Agent processes yourself.
- **NEVER** reuse a terminal Attempt for a business retry. A pre-ready infrastructure retry appends
  a new Launch; it does not rewrite the failed Launch.
- After `stop` reports `status: cancelled`, **DO NOT** execute further business Actions for that Run.
- Every child **MUST** run `bootstrap-cwd` before substantial work in its current directory, and again immediately after creating or entering another worktree. `worktree-init` remains a compatibility alias.

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
when examples are useful. Read [acp-sdk.md](references/acp-sdk.md) when configuring, diagnosing, or
changing the ACP backend.

## Start a Root

```bash
python3 <skill_dir>/scripts/agent_orchestrator.py init \
  --task "<user goal>" \
  --cwd "$(pwd)"
```

ACP is opt-in at Run initialization. Known profiles are version-pinned and never installed by the
Runtime:

```bash
python3 <skill_dir>/scripts/agent_orchestrator.py init \
  --task "<user goal>" \
  --cwd "$(pwd)" \
  --backend acp \
  --acp-agent <claude|codex|gemini>

# A custom stdio ACP Agent requires an explicit executable.
python3 <skill_dir>/scripts/agent_orchestrator.py init \
  --task "<user goal>" --cwd "$(pwd)" --backend acp --acp-agent custom \
  --acp-command /absolute/path/to/agent --acp-args-json '["--stdio"]'
```

Built-in profiles currently pin `claude-agent-acp` 0.62.0,
`@agentclientprotocol/codex-acp` 1.1.7, and Gemini CLI 0.41.0 (`gemini --acp`). A missing
executable fails cleanly with an exact pinned installation hint; the Runtime never downloads an
adapter or runs a floating `latest` package.
At Run initialization the selected built-in executable is resolved once to an absolute entrypoint;
the persisted Attempt never repeats `PATH` lookup. Virtual-environment and wrapper symlinks are
preserved because dereferencing them can change interpreter behavior. Custom Agents require an
absolute executable.

ACP requires CPython 3.10–3.14 but no user-installed Python package. The skill ships a hash-verified
offline runtime bundle containing the exact official `agent-client-protocol==0.11.0` distribution,
its pure-Python dependencies, and matching `pydantic-core` payloads for macOS/Linux on arm64 and
x86_64 (glibc and musl Linux). The first ACP use extracts only the matching native payload into
`$AGENT_SWARM_HOME/dependencies/acp-runtime`; it does not invoke pip/uv, install globally, or access
the network. A missing/corrupt/unsupported payload fails before Agent launch and requires
reinstalling the skill. The official SDK remains the only ACP framing, JSON-RPC, schema, dispatch,
and connection implementation; Agent Swarm retains only typed callbacks and Runtime lifecycle
policy.

Claude and Codex ACP profiles default to trusted-machine full access: Claude selects
`bypassPermissions`, while the official Codex adapter selects `agent-full-access`. Use
`--acp-permission-policy allow_in_workspace` only as an explicit opt-down. Gemini and custom
profiles retain the workspace-scoped default. An explicit CLI or environment policy always wins
and is frozen into the Run and Attempt configuration.

The profiles also freeze backend-specific model tiers. The official Codex App Server adapter
bundles a compatible Codex runtime and receives no legacy `-c model=...` process arguments; each
Session selects the immutable Attempt model from the Agent-advertised ACP config options
(`gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna`). Claude selects
`opus` / `sonnet` / `haiku`. An explicit model that the Agent did not advertise fails cleanly
instead of falling back to a different model.

Run `doctor` to inspect the frozen executable, pinned profile version, executable availability,
declared sandbox behavior, authentication prerequisites, fenced control handshake, process
identity, capabilities, recent RPC error, and Hook installed/skipped status without downloading or
launching the Agent. Authentication stays in the external Agent/CLI; the Runtime never persists
credentials.

Keep every returned identity field and actor token. Because `init` cannot alter the parent shell,
either export the returned values as `AGENT_SWARM_ROOT_ID`, `AGENT_SWARM_TASK_ID`,
`AGENT_SWARM_ATTEMPT_ID`, and `AGENT_SWARM_ACTOR_TOKEN`, or pass the
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

## Backend lifecycle

The Runtime does not create Git worktrees. Claude CLI launches `claude --bg`; ACP launches one
detached, persisted Worker + Agent Process + ACP Session per Attempt. If an Agent or child enters a
worktree, that worktree is its own execution environment. For Claude CLI, the Runtime initializes
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
python3 "$AGENT_SWARM_SKILL_DIR/scripts/agent_orchestrator.py" bootstrap-cwd
```

It **MUST** run the same command again immediately after creating or entering another worktree. The
command authenticates the injected identity and refreshes its heartbeat. Claude CLI additionally
merges local Hook settings in that exact worktree; ACP does not mutate `.claude` settings. This gate
is required even with a custom Claude `WorktreeCreate`
hook, because that hook replaces Claude's normal `.worktreeinclude` copy path.
`SessionStart` and
`PostToolUse` refresh an identified Agent heartbeat; `PostToolUseFailure` injects recovery guidance;
`Stop` prevents an identified, unfinished Attempt from silently ending without `finish`; and
`SessionEnd` records observation only. Hooks skip sessions without a full `AGENT_SWARM_*` identity.

Hooks **NEVER** initialize, recover, complete, or spawn a Run on their own. Runtime Actions remain the
only authority for lifecycle state and task-tree changes.

Each ACP Launch stores the real ACP `session_id` together with its Agent profile. To view history
without persisting dialogue content locally, load it directly from the Agent:

```bash
python3 <skill_dir>/scripts/agent_orchestrator.py session-history \
  --agent-type <claude|codex|gemini|custom> \
  --session-id <acp-session-id> \
  --actor-token "$AGENT_SWARM_ACTOR_TOKEN"
```

The Runtime calls `session/load` and keeps replayed messages only in memory for that command. A
missing session or an Agent without load support returns a normal structured unavailable result.

ACP detects prompt turn end without forging `finish`, performs one bounded finish reprompt by
default, and reconciles a still-unfinished Attempt as retryable exactly once. Its permission policy
selects only options offered by the Agent and first selects a compatible advertised Session mode
(`bypassPermissions` for Claude and `agent-full-access` for Codex under their default `allow_all`;
`agent`/`default`/`auto` for explicit `allow_in_workspace`). `prompt` is rejected because v1 has no headless UI;
an Agent that advertises only an unsafe bypass mode also fails cleanly. `allow_in_workspace` denies
opaque/out-of-workspace permission requests. A no-location `execute` request has one narrow
exception for the authenticated Runtime CLI: it must originate in the workspace, use a trusted
absolute system shell, match the frozen Runtime entrypoint, and be exactly `bootstrap-cwd`,
`action-schema <ACTION_TYPE>`, or the documented single-JSON-object `printf | action --stdin`
form. The exception can select only an offered allow-once option; any non-empty location list that
is malformed or outside the allowed roots is denied, as are shell composition, unrelated commands, and
allow-always-only choices. A missing, null, or empty location list is treated as no location and
still must match the exact Runtime CLI exception.

Agents may also enforce workspace access internally without emitting a permission callback. This
is headless approval automation—not an OS sandbox. Real write isolation still depends on the
selected Agent profile, container, or operating system.

## Discipline

- **MUST** delegate only with `create_tasks`; **DO NOT** launch a child Agent process yourself.
- Treat Task, Attempt, Launch, and ACP Session as different objects. Business retries create a new
  Attempt; pre-ready process retries append a new Launch.
- Use Notes only for reusable decisions and pitfalls, not work logs.
- A timed-out `wait` window is not a Task failure; inspect results and wait again when needed.
- Review and fix are Intents, not fixed identities or leaf-only roles.
- Use only the Actions and lifecycle described here.
- After `stop` returns `status: cancelled`, **DO NOT** execute further business action for that Run.
- Runtime checks observable structure and lifecycle facts. **DO NOT** claim it proves semantic quality,
  complete file isolation, or the truth of validation text.
