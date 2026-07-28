# Runtime contract

This is the sole Runtime contract for Agents Orchestrator. All callers and child process boundaries
use the `AGENTS_ORCHESTRATOR_*` environment family. Partial identities fail closed, and child
process boundaries scrub inherited identity before exporting the current Task binding.

## Contents

- [Object model](#object-model)
- [Persistent state](#persistent-state)
- [Identity and secrets](#identity-and-secrets)
- [Lifecycle](#lifecycle)
- [Backend lifecycle guards](#backend-lifecycle-guards)
- [Hooks and worktrees](#hooks-and-worktrees)
- [Estimate and capabilities](#estimate-and-capabilities)
- [Dependencies, scheduling, and finish](#dependencies-scheduling-and-finish)

## Object model

```text
Run(root_id)
└── Task(task_id, parent_task_id)
    └── Attempt(attempt_id, attempt_no)
        └── Launch(launch_id, launch_no)
            └── ACP Session(profile_id, external_session_id)   # ACP only
```

- `root_id` is the only application-generated structural identifier.
- Task, Attempt, Launch, profile, and local Session keys are SQLite integer primary keys.
- `tasks.parent_task_id` is the logical tree edge. It remains stable when an Attempt or Session is
  retried, so it is the authoritative way to reconstruct the tree.
- A business retry keeps the Task and appends a new Attempt.
- A pre-ready process retry keeps the Attempt and appends a new Launch. Old Launch rows are closed,
  never rewritten into a new generation.
- ACP stores the Agent-issued `external_session_id` directly. `created_by_session_pk` is provenance,
  not the tree edge.

The foreground Root has a Task and Attempt but no background Launch. Child execution uses either a
Claude CLI Launch or an ACP Worker/Agent/Session Launch.

## Bun bootstrap and managed dependencies

Every user-facing command enters through `scripts/bootstrap.ts`. Bun is required and is never
installed automatically. A clean first launch needs network access; it verifies `package.json` and
`bun.lock`, installs exact versions with lifecycle scripts disabled into the private
`$HOME/.agents-orchestrator/dependencies` cache, validates the result, and atomically publishes a
content-addressed Runtime. Later commands reuse that cache. The repository and installed Skill do
not contain or generate `node_modules`.

Codex ACP and Claude Code ACP share the default managed dependency tree. Codex remains the only
default profile; preparing Claude does not select or execute it. Gemini is a separate explicit
fixed-version cache variant. Custom ACP commands are never installed or overwritten.

## Persistent state

Runtime facts live in `$AGENTS_ORCHESTRATOR_HOME/runtime.sqlite3`, defaulting to
`~/.agents-orchestrator/runtime.sqlite3`. The Runtime does not copy or reinterpret unrelated
database files.

Core tables:

| Table | Purpose |
| --- | --- |
| `runs` | root goal, cwd, limits, frozen Run config, owner lease |
| `tasks` / `task_dependencies` | logical task tree and dependency graph |
| `attempts` | immutable backend/profile snapshot plus business outcome |
| `launches` | append-only process/worker ownership and cleanup facts |
| `agent_profiles` | Agent type, package/version, command, state namespace |
| `acp_sessions` | real external ACP Session identity and capabilities |
| `effects` | idempotent spawn/stop side effects |
| `processed_actions` | Action idempotency responses |
| `run_notes` / `events` | bounded reusable notes and structural audit facts |
| `modes` / `mode_rounds` / `mode_tasks` | persistent routed recipe, round, and task state machines |
| `mode_findings` / provenance / verifications | candidate consensus and independent evidence |

Dialogue content is deliberately absent. There are no message, transcript, or conversation-event
tables. `session-history` resolves `agent_type + external_session_id` (and optional `root_id`), starts
the matching Agent profile, calls ACP `session/load`, and returns replayed updates from memory. A
missing/lost Session or missing capability is a normal unavailable result.

Schema initialization also installs only the minimal TypeScript Claude Hook runtime—
`runtime_env.ts`, `hook_runtime.ts`, `hook_manager.ts`, `state_store.ts`, and Hook shell files—under
`$AGENTS_ORCHESTRATOR_HOME`. Child Actions use the installed entrypoint exported as
`AGENTS_ORCHESTRATOR_SKILL_DIR`.

## Identity and secrets

An Action identity contains the canonical family:

```text
AGENTS_ORCHESTRATOR_ROOT_ID
AGENTS_ORCHESTRATOR_TASK_ID
AGENTS_ORCHESTRATOR_ATTEMPT_ID
AGENTS_ORCHESTRATOR_ACTOR_TOKEN
```

There is no intermediate `agent_id`. Child tokens are derived as
`base64url(HMAC-SHA256(seed, root_id|attempt_id))`; only hashes are stored in SQLite. The Run seed is
mode 0600 and removed only after a terminal Run has no pending spawn/stop Effect and no open Launch.

## Lifecycle

Attempt:

```text
assigned → evaluating → active ↔ waiting → done|failed
                              ↘ stopping → cancelled|failed
```

Launch:

```text
starting → running → turn_ended|error → closed
                 ↘ stopping ───────────→ closed
```

Task:

```text
pending → ready → assigned → active → done|failed
active → stopping → ready                 # explicit stop-and-retry
pending|ready|assigned|active → cancelled
```

Only Runtime Actions may complete Attempts and Tasks. Claude `SessionEnd` and ACP prompt turn end are
observations; neither forges `finish`.

## Backend lifecycle guards

The Run execution configuration is resolved at `init` and stored in `runs.execution_config_json`.
Each Attempt stores its immutable snapshot in `attempts.config_json`; later environment changes do
not alter it.

Codex ACP is the default. `--profile-allowlist-json` and `--default-profile` freeze the Run's
available ACP profiles before any child exists; `constraints.profile_hint` is either absent or a
non-empty name in that allowlist. `--entry-mode
swarm|loop|develop-review-improve|verification-fix|review|ravf` persists only a routing hint for
the foreground Root. Generic `loop` remains unresolved until the Root selects
`develop_review_improve`, `verification_fix`, or `ravf`; every recipe still starts through the
ordinary Action contract after an estimate.

Scheduler creation is one transaction:

1. insert Attempt and hashed actor token;
2. insert Launch number 1;
3. insert `spawn:<launch_id>` Effect;
4. mark the Task assigned.

An ACP Worker must atomically claim `launch_id + owner_nonce` before starting its Agent process.
Every endpoint request carries `launch_id`. If a starting Worker, Agent process, and socket are all
proven absent, recovery closes that Launch and appends a new Launch plus a new spawn Effect. A late
Worker cannot claim the closed Launch. Unknown/orphan process state never triggers replacement.

ACP `mark_ready` is atomic: it inserts the real Session/profile mapping, marks the Launch running,
and transitions the Attempt to evaluating before the Agent can submit an Action. Cleanup closes both
the Launch and local Session status while keeping `external_session_id` available for later
`session/load`.

Claude CLI uses its background job ID as `launches.backend_ref`; ACP uses the Launch as its control
identity and stores the Agent-issued Session ID separately.

## Hooks and worktrees

The Runtime does not create worktrees. Every child must run `bootstrap-cwd` before substantial work
and again after entering or creating another worktree.

Claude CLI project Hooks:

- `SessionStart` and `PostToolUse` refresh the Attempt heartbeat.
- `PostToolUseFailure` adds recovery guidance without changing state.
- `Stop` blocks one unfinished stop and asks for a legal `finish` Action.
- `SessionEnd` records observation only.

Hooks skip sessions without the complete four-field identity. ACP does not install Claude Hooks;
its Worker heartbeat and Action heartbeat are separate facts.

## Estimate and capabilities

- `evaluating`: `submit_estimate`, `write_note`
- active direct: revised estimate, `start_mode`, `advance_mode`, `write_note`, `finish`
- active split: the direct capabilities plus `create_tasks` and `wait`
- `waiting`: `write_note`, `wait`
- terminal: no Actions

Supported Intents are `implement`, `review`, `fix`, `research`, `design`, and `integrate`.

Default limits:

| Limit | Default |
| --- | ---: |
| concurrent Attempts | 8 |
| total Tasks | 100 |
| Attempts per Task | 2 |
| delegation depth | 5 |
| replans per Task | 2 |
| children per Action | 12 |

## Dependencies, scheduling, and finish

`create_tasks` atomically inserts all children, resolves action-local keys to integer task IDs, then
inserts dependencies. `success` requires upstream `done`; `terminal` accepts any terminal Task.
Failed required dependencies block downstream Tasks.

`finish(done)` requires every non-cancelled direct child to be done. A parent with children must
include an integration result. Root completion additionally requires all Tasks terminal, no live
Attempts, no pending spawn/stop Effects, and every Launch closed. Review and final-review structural
gates remain enforced. A Task also cannot finish done while a mode it owns is running, blocked, or
failed; Runtime-created mode Tasks must submit a role-valid `mode_result`.

Review provenance is role-scoped. `review.source: "self"` is valid only for the current Task when
its resolved Intent is `review`. Other Tasks omit `review` unless a gate requires it; when citing an
independent completed review, `review.source` is that review Task's integer `task_id`.

The Runtime enforces identity binding, current Attempt, Action idempotency, lifecycles, budgets,
dependencies, retries, Effects, recovery, and structural finish gates. It cannot prove semantic
quality, complete write isolation, or the truth of validation text.
