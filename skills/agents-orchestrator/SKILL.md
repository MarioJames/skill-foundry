---
name: agents-orchestrator
description: Route and run a collection of durable multi-Agent orchestration patterns, including parallel swarm, develop-review-improve, verification-fix, RAVF, and independent multi-session review. Use when the user explicitly asks to coordinate multiple Agents, invokes Agents Orchestrator or one of these modes, when a Runtime-injected `[ORCHESTRATION IDENTITY]` block is present, or to recommend (not auto-start) a mode when there is a concrete orchestration signal such as multiple independent workstreams, repeated failing validation, or a high-risk change that needs independent adjudication. Do not trigger for ordinary coding or review work, complexity alone, paths or links containing these names, quoted or example mentions, or requests merely to explain, inspect, edit, rename, or optimize this skill.
---

# Agents Orchestrator

Act as a router over reusable Agents orchestration patterns, backed by the TypeScript/Bun Runtime
in this directory. Treat the persisted Task/dependency graph as an execution mechanism, not as the
definition of Orchestrator. Resolve `<skill_dir>` from this file.

## Activation and routing

Read [routing.md](references/routing.md) before recommending or selecting a mode.

- On an explicit `$agents-orchestrator`, generic orchestration, or named-mode request, select the
  matching recipe and operate it without asking for a second confirmation.
- On an implicit high-signal match, recommend one recipe with its benefit and overhead; do not run
  `init`, create Agents, or otherwise start orchestration until the user opts in.
- With `[ORCHESTRATION IDENTITY]`, continue the injected Run immediately. Never initialize a
  second Run or downgrade an active recipe to a recommendation.
- Do not recommend orchestration for a small, tightly coupled, one-shot task merely because it is
  described as complex.

## Invariants

- For resume or recovery intent, call `recover` immediately. Never replace failed recovery with
  `init`.
- Delegate only through `create_tasks` or persistent-mode Actions; never start child processes
  directly.
- Run `bootstrap-cwd` before substantial child work and after entering another worktree.
- Submit `submit_estimate` before work and `finish` after integration and validation. Prose does not
  update Runtime state.
- Never reuse a terminal Attempt. After `stop` returns `status: cancelled`, submit no more business
  Actions.
- Bound every loop by rounds, tasks, time, candidate count, and no-progress guards. A post-fix pass
  must come from a fresh validation or review phase.
- In RAVF, keep every original Reviewer finding immutable. Argue may rebut or propose a revision
  but cannot create the source issue; Vote decides per original fingerprint, and the main Agent must
  submit the final original/revised/rejected integration before one coordinated fix starts.

## Operate

Read [runtime-contract.md](references/runtime-contract.md) before operating the Runtime and
[action-schemas.md](references/action-schemas.md) before composing Actions.

For an explicit new Run, follow this fast path without exploratory detours:

1. Trust the published commands and references. Do not inspect Runtime source, probe `--help`, test
   network access, or reverse-engineer Backend behavior before acting.
2. Run `init` once and retain its returned `root_id`, `task_id`, `attempt_id`, and `actor_token`.
   Omit `--backend` unless the user explicitly selected a non-default Backend. `init` defaults to
   `require_final_review=true`.
3. Query only the `submit_estimate` and selected `start_mode` schemas, submit the estimate, then
   submit `start_mode` immediately. Use `strategy: "split"` for every persistent mode: each recipe
   compiles child Tasks, and the owner needs the resulting `wait` capability. Reserve
   `strategy: "direct"` for work that will not start a persistent mode or create child Tasks.
4. Schedule/wait for returned Tasks, advance the mode from terminal phase evidence, integrate, and
   finish. Build `finish` for the current Task's role: omit `review` for a non-review Task unless a
   final review is required; `review.source: "self"` is legal only when the current Task's resolved
   Intent is `review`, while another Task's review must use that completed review Task's integer ID.
   If the Run changed files and final review is required, the root `finish` must cite that completed
   review Task id; a passing self-review from a non-review root is rejected.
   Use `inspect` or source-level diagnosis only after a concrete Action failure.

Bun is required. The first launch needs network access and installs the exact locked dependencies
into `$HOME/.agents-orchestrator/dependencies` (override with
`$AGENTS_ORCHESTRATOR_DEPENDENCY_HOME`). Later launches reuse the verified content-addressed cache.
The Skill does not contain or create a local `node_modules` directory.

For a new Run:

```bash
bun <skill_dir>/scripts/bootstrap.ts init \
  --task "<user goal>" --cwd "$(pwd)"
```

The default Backend/profile is ACP + Codex. First use prepares both Codex ACP and Claude Code ACP
in one managed dependency tree; Claude is installed but not selected automatically. Gemini is
installed only when its fixed profile is explicitly selected. A custom ACP command is never
installed or replaced.

Keep every returned identity field and actor token. A child with injected identity begins with:

```bash
bun "$AGENTS_ORCHESTRATOR_SKILL_DIR/scripts/bootstrap.ts" bootstrap-cwd
```

An explicit recipe may persist `--entry-mode
swarm|loop|develop-review-improve|verification-fix|review|ravf`. Generic `loop` is a routing hint;
select `develop_review_improve`, `verification_fix`, or `ravf` from the work state. A mode begins
only after `submit_estimate` and the matching `start_mode` Action.

Submit one Action JSON object on stdin and query its exact schema before use:

```bash
bun <skill_dir>/scripts/bootstrap.ts action-schema <ACTION_TYPE>
printf '%s' '<JSON object>' | bun <skill_dir>/scripts/bootstrap.ts \
  action --type <ACTION_TYPE> --stdin
```

Modes compile into Tasks in the same durable Run; there is no `init --mode`. Read
[operating-modes.md](references/operating-modes.md) for executable recipes and composition. Read
[review-consensus.md](references/review-consensus.md) for independent consensus and RAVF details.

Read [recovery-protocol.md](references/recovery-protocol.md) for recover, reap, inspect, doctor, or
stop. Read [acp-sdk.md](references/acp-sdk.md) before configuring ACP. Select
`--backend claude_cli` explicitly only for the legacy Claude CLI Backend. Predeclare ACP diversity
with `--profile-allowlist-json '["codex","claude"]' --default-profile codex`; a child
`profile_hint` may only name that frozen allowlist.

## Discipline

- Use Notes only for reusable decisions and pitfalls.
- Treat Task, Attempt, Launch, and ACP Session as distinct objects.
- Treat review, argument, vote, diagnosis, and fix as Intents, not permanent roles.
- A timed-out `wait` is not Task failure; inspect results and wait again when appropriate.
- Runtime gates prove lifecycle structure, not semantic quality, complete write isolation, or the
  truth of reported validation.
