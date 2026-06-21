---
name: ultra-team
description: Use only when user asks to use/start/run/resume with standalone phrase `ultra team`, or `[ORCHESTRATION IDENTITY]` starts with it. Do NOT trigger on task shape/count or review/edit/explain/rename/optimize.
---

# Ultra Team

Continue only when the current message passes the activation gate below.
The phrase `ultra team` is an explicit opt-in command, not a general topic keyword.

## Activation gate

Proceed only if one of these is true:

- The current user message contains the standalone phrase `ultra team` and explicitly asks to
  start, use, run, resume, recover, or continue a task-tree run.
- The current message contains an injected `[ORCHESTRATION IDENTITY]` block and starts with
  `ultra team`; this is an implement child created by `dispatch`.

Do not activate for path mentions such as `skills/ultra-team`, Markdown links, quoted examples,
code/docs references, or requests to review, edit, rename, explain, or optimize this skill or its
trigger phrase.
If this gate fails, do not call `init`, `dispatch`, `await-round`, or `finish`; handle the user's
actual request normally with any more relevant skill.

Once active, first check whether the current message carries an `[ORCHESTRATION IDENTITY]` block.

## Do immediately

1. If the current message shows recovery intent (e.g. `恢复 / 接续 / recover / resume`),
   read and strictly follow `<skill_dir>/references/recovery-protocol.md`;
   do NOT fall back to fresh root initialization.
2. Otherwise read and strictly follow `<skill_dir>/references/recursion-protocol.md`.
3. When you need command examples, read `<skill_dir>/references/script-cases.md`.
4. Derive the absolute path of `<skill_dir>` from the directory of this file.

## Identity check

1. No `[ORCHESTRATION IDENTITY]` and no recovery intent: you are root.
   Run `python3 <skill_dir>/scripts/agent_orchestrator.py init ...` to build the tree.
2. No `[ORCHESTRATION IDENTITY]` but recovery intent present: you are a recovery root.
   Discover and resume an existing run per `recovery-protocol.md`; do NOT call `init`.
3. `kind=implement` present: you are an implement child.
   Do NOT call `init`; work from the `agent_id/root/parent/round/kind` in the identity block.
4. review/fix nodes are leaves.
   If this skill loads by accident, just do the task your parent gave you and report via `finish`.

Before `init` succeeds and returns a `root_id`, do NOT implement the user's task directly.
Do NOT use Claude Code `Agent` / `Task` / `Workflow` or any other parallel sub-task capability to bypass this protocol.

## Core discipline

- root runs in the foreground and owns `dispatch`, `await-round`, continuation, and the final report.
- After `init`, root's first implementation action MUST be `dispatch`.
  For an empty directory, root MUST dispatch a bootstrap child for scaffold creation instead of running
  `create-*`, installing packages, or writing app files itself.
- root may do only orchestration, state inspection, and tiny integration wiring after
  child results exist. Root MUST NOT directly create or bulk edit business/scaffold files such as pages,
  components, types, engines, mocks, docs, package files, routing, or global config.
- Hand the bulk of implementation, review, and fix work to `kind=implement` / `kind=review` / `kind=fix` children.
- Dispatch only via `claude --bg`.
- Every parallelizable delegation MUST go through `dispatch` to create a trackable child.
- Quota, permission, or background-dispatch failures are all handled as a dispatch failure.
- `dispatch` may select `--agent` from the project's `.claude/agents/`, and `--model opus|sonnet|haiku` by task complexity.
- Multi-line tasks, or tasks containing backticks or shell metacharacters, MUST be dispatched via `--task-stdin`.
  `--task-stdin` is exactly one child task. For multiple multi-line tasks, run multiple `dispatch`
  commands with one heredoc each before a single `await-round`; never concatenate separate task bodies
  into one stdin payload.
- reviewer/fixer are leaves: no further `dispatch`, `claude --bg`, `claude agents`, or `Agent` / `Task` / `Workflow`.
- `await-round` returning `listen_window_expired:true` / `still_waiting:true` is NOT a failure.
- If you ever dispatched a direct child, you MUST complete one `kind=review` direct child before the final `finish`.
- If you dispatch fix or new implement after a review, you MUST review again.
- Serialize shared-file writes with rounds: handle bootstrap, foundation, and parallel fan-out in separate rounds.
- Heartbeats only update a running agent that can be attributed precisely, and maintain `last_reported_at`.
- SessionEnd is a cleanup and observation event only; it does NOT directly mark a running child as failed.
- After `stop` outputs `terminal:true` it is a HARD STOP.
  Stop the current response at once and run no further business command; do not continue editing.
  Only record evidence, then restart in a fresh cwd.

This skill is dormant by default. Do NOT activate it without explicit `ultra team` run intent.
