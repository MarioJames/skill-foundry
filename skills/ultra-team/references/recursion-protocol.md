# Recursive Background Agent Tree: Node Protocol

You are one node in a task tree.
Call commands with the `agent_id` injected into you; do NOT generate or guess `session_id` / `job_id`.
The command entry point is fixed at `<skill>/scripts/agent_orchestrator.py`.

When you need copy-paste commands and scenario examples, read `references/script-cases.md`.

## Commands

- `init --task <task> --cwd <pwd>`: root only, used once; returns `root_id`.
- `dispatch --root-id R --parent-id P --round N --kind implement|review|fix --task "..."`
  dispatches this round's children; `--task` may be repeated.
- `dispatch` may read the task body from `--task-stdin`.
  Multi-line tasks, or tasks with backticks or shell metacharacters, MUST use `--task-stdin <<'EOF' ... EOF`
  to avoid shell command substitution corrupting the task.
- `--task-stdin` is exactly one child task.
  It is not a separator-aware batch format. If you have 2+ multi-line tasks, run 2+ separate
  `dispatch` commands with the same `--root-id`, `--parent-id`, `--round`, and `--kind`, one heredoc
  per command, then run one `await-round` for that round.
- `dispatch` accepts an optional `--agent <subagent>`.
  One value applies to all tasks; multiple values MUST map one-to-one to multiple `--task` / `--task-stdin`.
  Pick the subagent name from the current project's `.claude/agents/`.
- `dispatch` accepts an optional `--model opus|sonnet|haiku`.
  Omit it to use Claude's default model; choose by complexity — haiku for simple tasks, opus for complex ones.
- `await-round --root-id R --parent-id P --round N`: wait for this round's children; returns a result summary.
- `finish --agent-id A --root-id R --result "..." [--caveats "..."]`: write the final result and close out.
- `status --root-id R --json`: inspect the whole tree and reap terminal Claude agent views.
- `list-runs`: discover orphaned trees.
- `stop --root-id R`: stop the whole tree and clean up recorded jobs plus same-cwd `ut-*` orphans.

When the run or parent is not running, `dispatch`, `await-round`, and `finish` MUST all refuse.

## Dispatch

`dispatch` uses only `claude --bg` to spawn background nodes.
Each node gets a readable name `ut-{root4}-{kind3}-[{chain}-]{self4}-{task_slug}`.
`root4` and `self4` are the last 4 hex characters of `root_id` and `agent_id`.
`kind3` abbreviates the kind: `implement` → `impl`, `review` → `rev`, `fix` → `fix`.
`chain` is the intermediate parent-chain (omitted when parent is root); for deeper nesting
it is dot-joined, e.g. `d3c4.b2c3`.
`task_slug` is derived from the task intent (kebab-case, max 20 chars).
The `ut-` prefix enables cleanup identification, and in the flat `claude agents --json`
list, agents from the same run cluster together under the same `root4`.

Do NOT use Claude Code's built-in Agent/Task/Workflow or Workflow/TaskCreate for delegation.
Those built-in sub-tasks do not enter this protocol's state tree, so a parent cannot use SQLite,
heartbeats, and transcripts to judge their real progress.
Every parallelizable delegation MUST go through `dispatch` to create a trackable child.

Dispatch failures return as a dispatch failure.
The parent then dispatches `kind=review` to decide whether to retry, narrow the task, fix the
environment, or report to the user.

Claude Code background sessions read the target directory's settings.
By default pass `--permission-mode bypassPermissions` explicitly, so an unattended worker does not
stall on authorization.

`bypassPermissions` / `auto` requires one prior interactive confirmation on this machine.
If Claude Code refuses, treat it as a `claude` background dispatch failure; do NOT retry endlessly.

## Node flow

0. Root delegation:
   after `init` succeeds, root's first implementation action MUST be `dispatch`.
   In an empty directory, project scaffold/bootstrap is still a child task: root MUST dispatch a
   bootstrap implement child and then `await-round`. Root MUST NOT run scaffold commands, install
   packages, or create app files directly.
1. Implement:
   the implement child prompt carries the `ultra team` trigger phrase and `[ORCHESTRATION IDENTITY]`.
   After loading the skill, recognize that you are an existing node and do NOT `init` again.
   A normal prose summary is not completion. Before an implement node ends its final response, its final
   tool call MUST be `python3 <skill>/scripts/agent_orchestrator.py finish --agent-id A --root-id R ...`.
2. Integrate:
   the parent may do lightweight stitching or wiring after child results exist.
   Direct root writes are limited to orchestration artifacts such as review prompts, status notes,
   and tiny integration glue. Root MUST NOT directly create or bulk edit business/scaffold files such as
   pages, components, types, engines, mocks, docs, package files, routing, or global config.
   Broad writes to shared files such as routing, index, and config should be serialized.
3. Acceptance:
   `dispatch --kind review` spawns 1 independent reviewer leaf.
   The review node only inspects; it MUST NOT modify business files.
   review MUST return a structured verdict/issues/fix_scopes.
4. Fix:
   the parent fans out `kind=fix` leaves based on the reviewer's fix_scopes.
   After a fix or re-dispatch completes, you MUST review again.

If the `await-round` summary shows a failed child, first dispatch review to triage.
review decides whether it is a real failure, completed but failed to report, or needs retry/fix.

`await-round` returning `listen_window_expired:true` or `still_waiting:true` is NOT a failure.
The parent MUST continue the same round per the returned `required_next_action` / `next_commands`,
and MUST NOT dispatch review/fix.
The returned `elapsed_for` is how long this listen has run.
The returned `idle_for` is how long since the running subtree's last heartbeat.

When a normal wait window ends, it returns:

- `required_next_action: "continue_await_round"`
- `next_commands: [{"action":"continue_await_round","command":[...]}]`
- compatibility field `next_command`, equal to the first await command.

If `await-round` finds a direct running child in the Claude agent view that is recoverable, and the
transcript shows a recovery signal, it returns:

- `status=idle` / `state=working`: recoverable when the latest subtree activity exceeds the recovery threshold.
- `status=busy` / `state=working`: recoverable when the transcript has been unchanged for a long time;
  this usually means Claude background still shows busy but is actually stuck with no output.

- `required_next_action: "recover_idle_agent"`
- `recovery_candidates`: the direct children to recover, with job_id, session_id, and reason.
- `next_commands`: run `recover-idle-agent --root-id ... --agent-id ...`.
  That command verifies the child is still recoverable, then via a temporary `tmux` session runs
  `claude attach <job_id>`, sends `continue`, detaches with `C-z`, and returns the follow-up
  `continue_await_round` command.
  If a candidate carries `interrupt_first:true`, the recovery command first sends `Ctrl+C` to interrupt
  the current busy state, then sends `continue`.
- This case returns no compatibility `next_command`, to avoid skipping recovery and idling on.

Recovery signals include:

- `away_summary`
- an empty `end_turn`
- multiple valid run events (e.g. assistant output, an attachment, a user event with tool_result).

Do NOT use agent-view status alone as the auto-recovery condition; a newly queued, scheduling, or
normally long-reasoning background job may look similar. After manually attaching and confirming the job
is waiting for input, or busy with no output, you may explicitly run `recover-idle-agent --force`, but
that path still MUST verify the job is visible and `idle/working` or `busy/working`.

If a direct child's entire subtree has had no heartbeat or new transcript message for 10 consecutive
minutes, `await-round` may mark that direct child as failed and stop its job.
A parent handles only its own direct children; grandchildren or deeper nodes are handled by their direct
parent. If a grandchild still has a new transcript, the direct child's subtree does NOT count as
unresponsive.

## Closeout gate

`finish` has hard preconditions:

- No running direct child.
- If direct children were ever dispatched, the last direct child MUST be `kind=review` with `status=done`.
- If a failed direct child exists, the last failure MUST be followed by a `done review` that characterizes
  it and confirms it is safe to proceed.

In other words, you cannot `finish` straight after implement/fix.
A failed direct child cannot be dismissed on the parent's subjective judgment alone.
For every node kind, writing "done", "will report via finish", or any other plain-text completion note
does not change SQLite state. The node is complete only after the `finish` command succeeds.

## Two iron rules

- Iron rule 1: `kind=review` / `kind=fix` are leaves.
  After `finish` they exit directly; no further dispatch.
  Do NOT call Agent/Task/Workflow, Workflow/TaskCreate, or any other background/sub-task capability.
- Iron rule 2: the parent only verifies whether the integration or wiring of direct child results meets
  this level's success bar.
  The parent does NOT re-review grandchildren; problems this level cannot solve are reported up as `--caveats`.

## Dispatch splitting principle

Maximize parallelism: split tasks into as many child agents as possible to keep each agent's scope
small and fast. Prefer many focused children (each handling one file, one component, one module) over
few broad children.

- Each child should complete in under 2 minutes when possible.
- A task that touches 4 files should become 4 children, not 1 child doing all 4.
- Splitting into more agents is almost always better than fewer; the overhead of dispatch is low
  compared to the risk of one slow, broad child blocking the round.
- Only merge tasks into one child when they share the same file or have tight ordering dependencies.
- When uncertain whether to split further, split.

## Avoid parallel write conflicts

Do NOT use git worktree for isolation unless parallel agents genuinely cannot avoid editing the same
file after task splitting. The primary strategy is to control each child's scope so files don't
overlap — worktrees add setup cost, merge complexity, and should be a last resort, not the default.

Parallel children run in the same directory; writing the same file overwrites each other.
Use rounds to serialize shared writes:

- Bootstrap round: handle an empty directory, project scaffold, dependency installation, or a user request
  to not create `.git` first, on its own child. Root dispatches and awaits this child; root does not run
  scaffold or package-manager commands directly.
- Round 1 = foundation: serialize shared types, utilities, routing skeleton, and global config.
- Round 2+ = fan-out: parallel feature children write only non-overlapping files.
- Shared wiring goes to the parent for integration, or to a dedicated serial round.

## Heartbeats and SessionEnd

The runtime lets review/fix leaves that do not load the skill still update `last_reported_at`.
`dispatch` refreshes the parent heartbeat before Claude starts, when the job has started, and after it returns.

A heartbeat only updates a running agent that can be attributed precisely.
If a tool call cannot be proven to belong to a specific child, `cwd + runs.branch` may only keep the
foreground root alive.

SessionEnd is a cleanup and observation event.
A running child's SessionEnd does NOT flip it to failed directly; it only records the event.
A later parent or upper `await-round` keeps reconciling it based on Claude job status, child results, and review.

When a recursive implement parent has already delegated its work to descendants, the parent's Claude
session ending is NOT equivalent to the parent failing.
Keep waiting while descendants are running; when all direct descendants are done, synthesize the parent
result with a caveat.

Agent status is one-directional: `done` and `failed` are terminal.
A heartbeat only updates a running agent; an agent that already `finish`ed never rolls back to running.

## Stop

Before a task cancellation, a dispatch failure, or root preparing to report blocked/failed, run `stop --root-id R`.
Then run `claude agents --json` again to confirm no `ut-*` background session for this root's cwd remains.

`stop` outputting `terminal:true` is a hard-stop signal:

- HARD STOP.
- The current response may only report or record evidence.
- do not continue editing.
- Do NOT keep implementing, fixing business files, or re-`init` in the same cwd.
- Record evidence, then restart in a fresh cwd.

## Branch recording

When `init` writes `runs`, it records the current git branch into `runs.branch`.
A plain non-git scratch directory may leave it empty.
On a detached HEAD it is recorded as `detached:<short_sha>`.
