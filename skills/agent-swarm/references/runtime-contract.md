# Runtime contract

## Objects and lifecycle

```text
Run → Task → Attempt → Agent Session
```

- A Task is a stable goal. A retry keeps the Task and creates a new Attempt.
- An Attempt belongs to exactly one Task and one Agent Session.
- A new Session always requires a new Attempt.

## Persistent state

Runtime facts and audit events live in `runtime-v2.sqlite3` under `AGENT_SWARM_HOME` when that
variable is set, otherwise at `~/.agent-swarm/runtime-v2.sqlite3`. On first use of the default new
location, the Runtime copies a valid previous default v2 database into it without mutating the
source, then records the current schema version. To migrate any source into an explicit new home,
set `AGENT_SWARM_MIGRATE_FROM` to that old directory for the first launch. The separate legacy
`state.sqlite3` file is consulted read-only only to prevent a v2 Run from starting beside an
unfinished legacy Run; v2 never reinterprets legacy Kind/Round rows.

The copy preserves existing rows and recorded external session names so a live pre-rename Session
can still be observed or stopped. Every new Attempt uses the `agent-swarm-…` session-name prefix,
and every new injected identity/configuration boundary uses `AGENT_SWARM_*` / `agent_swarm_*`.

Schema initialization installs only the minimal Hook runtime—`scripts/hook_runtime.py`,
`scripts/hook_manager.py`, `scripts/state_store.py`, and the Hook shell files—into
`$AGENT_SWARM_HOME/{scripts,hooks}` (or `$HOME/.agent-swarm/{scripts,hooks}` by default). It does
not copy the Root/child action CLI or its other modules. Hook commands resolve that home at execution
time through
`${AGENT_SWARM_HOME:-$HOME/.agent-swarm}`; they **NEVER** depend on the installed skill's relative
directory. The child launcher exports the resolved `AGENT_SWARM_HOME` so a custom runtime home is
used consistently.

The Runtime does not issue `git worktree add` or `claude --worktree`; the Agent, child, or project
owns worktree creation. The default Claude CLI Backend installs project hooks and writes
`.claude/settings.local.json` to `.worktreeinclude` for future Claude-created worktrees, and
refreshes every registered worktree before and after child spawn. ACP does not mutate `.claude`
settings. Every child **MUST** run
`bootstrap-cwd` before substantial work in its current directory and again immediately after
entering or creating another worktree. That command authenticates the current identity and refreshes
its heartbeat; hook-capable Backends also merge local settings in the exact worktree.
`worktree-init` remains an alias. A user-defined Claude `WorktreeCreate` hook replaces Claude's
default creation path and does not process `.worktreeinclude`; the explicit `bootstrap-cwd` gate is
therefore authoritative.
The Runtime does not add a CLI `--settings` overlay, so user-level settings stay independent of Hook
deployment.

Agent lifecycle:

```text
received → evaluating → active ↔ waiting → terminal
```

Task lifecycle:

```text
pending → ready → assigned → active → done|failed
active → stopping → ready  (Parent-selected kill after a stalled heartbeat)
pending|blocked|active → cancelled
```

## Backend lifecycle guards

The detailed ACP design, implementation status, and real-agent acceptance record live in
[acp-backend-spec.md](../../docs/specs/acp-backend-spec.md). The default Backend remains Claude CLI;
ACP is an explicit Run-initialization choice and is frozen into each Attempt's execution record.

The Runtime installs project-local Hooks only while it owns an active Run:

- `SessionStart` and `PostToolUse` refresh an identified Agent heartbeat.
- `PostToolUseFailure` adds recovery guidance to the current Agent; it does not mutate task state.
- `Stop` checks the current identified Attempt. If it is unfinished, the Hook blocks the stop once
  and tells the Agent to submit the Runtime `finish` Action. A guarded repeat is allowed to avoid a
  permanent Hook loop.
- `SessionEnd` records that a Session ended but **NEVER** forges Task completion.

Every Hook skips sessions without the complete `AGENT_SWARM_*` identity. Hooks **NEVER** initialize, recover,
complete, or spawn Runs: Actions remain the only lifecycle authority.

ACP does not use Claude Hooks. Each Attempt owns a detached Worker, Agent Process, ACP Session, and
mode-0600 Unix control socket. The Worker persists generation ownership before launching the Agent,
negotiates protocol v1, applies only Agent-advertised model/permission config options, marks ready
only after initialize + session/new + prompt dispatch, and self-cleans after a legal `finish`.
Unsupported explicit models or unsafe permission modes fail cleanly. Turn end without `finish` is a
deterministic retryable failure, never success.

`allow_in_workspace` normally requires every advertised permission location to resolve inside the
workspace or an additional directory. Non-empty declared location metadata that is malformed or
out of workspace is denied. A missing, null, or empty location list is treated as no location; for
those Codex ACP requests, the only allowable exception is an `execute` call from a workspace cwd
through a trusted absolute system shell that exactly invokes the frozen Runtime entrypoint as
`bootstrap-cwd`, `action-schema <ACTION_TYPE>`, or the documented single-object
`printf '%s' ... | ... action --type <ACTION_TYPE> --stdin` form. That exception chooses only
allow-once; it rejects shell
composition, alternate entrypoints/producers, unrelated Runtime commands, and allow-always-only
choices. This approval automation permits authenticated Runtime state updates outside the child
workspace; it is not an OS filesystem sandbox.

## Child heartbeat watchdog

The Root can run `reap` without changing its own identity. A running child with a heartbeat older
than five minutes is retried only after its persisted Backend observation confirms the Session is
absent. A still-live Session is returned to the Parent as a diagnostic candidate; the
Parent may explicitly request a stop-and-retry for that Attempt. An observation failure is reported
without changing child state. Root `wait` invokes this watchdog immediately and at most every 30
seconds while it is waiting.

## Estimate and capabilities

- `evaluating`: `submit_estimate`, `write_note`
- active direct estimate: revised estimate, `write_note`, `finish`
- active split estimate: revised estimate, `create_tasks`, `write_note`, `wait`, `finish`
- `waiting`: `write_note`, `wait`
- `terminal`: no Actions

`resolved_intent` is set by the first estimate and remains stable for the Task. Supported Intents:
`implement`, `review`, `fix`, `research`, `design`, and `integrate`.

Default hard budgets:

| Budget | Default |
| --- | ---: |
| concurrent Agents | 8 |
| total Tasks | 100 |
| Attempts per Task | 2 |
| delegation depth | 5 |
| replans per Task | 2 |
| children per Action | 12 |

The foreground Root consumes one concurrent-Agent slot. When that is the only slot, or split is
otherwise impossible because a hard budget is exhausted, Runtime forces direct execution; finish
the critical scope directly and report caveats.

## Scheduler and dependencies

`create_tasks` atomically creates all Tasks and dependencies. `success` requires the upstream Task
to be done; `terminal` accepts any terminal upstream state. A permanently failed `success`
dependency blocks the downstream Task.

The Runtime schedules by priority, creation time, then shallower depth. It creates the Attempt,
Agent, immutable execution record, and `spawn:{attempt_id}` outbox effect before invoking the
selected Backend. Agents **NEVER** manage slots or process lifetimes.

## Completion gates

For `finish(status=done)`:

- `summary`, `changed_files`, and `caveats` are required.
- Changed files require passed validation, or skipped validation with a reason.
- A Task with children requires every non-cancelled direct child to be done and must provide an
  integration check.
- A review Intent must provide `review.status` and `review.findings`.
- When final review is enabled and any Task changed files, Root must provide a review. A referenced
  review Task must be a done review Intent in the same Run.
- Root closes only when all required Tasks are done, no Attempt is live, no spawn/stop effect is
  pending, and every execution record is closed.

New child actor tokens are derived from a mode-0600 Run seed. SQLite, Outbox payloads, prompts,
diagnostic logs, and optional sidecars store identity/hash facts only, never the plaintext token.
The seed is removed only after a terminal Run has no open execution or spawn/stop effect.

ACP built-in profiles resolve the executable once to an absolute real path and freeze that path,
args, version, authentication prerequisites, sandbox declaration, and model-tier mapping into the
Run/Attempt records. Custom Agents require an absolute executable. `doctor` reports that preflight
without installing or starting the external Agent. The Worker records advertised authentication
method IDs and capabilities for diagnosis, but never credentials or prompt text.

Failed child Attempts retry only when marked retryable and within budget. A failed Root **NEVER**
automatically starts a new foreground Root; use `recover`.

## Hard and soft boundaries

Runtime enforces Action shape, identity/token binding, current Attempt, idempotency, lifecycle,
budgets, dependencies, retries, outbox effects, stop/recovery, and structural finish gates.

Prompt guidance covers semantic decomposition, write scope quality, read-only review behavior,
validation adequacy, and whether all changed files were reported. Reported out-of-scope paths create
warnings; the Runtime does not intercept every filesystem write.
