# Behavioral acceptance

Use this route when the task requires evidence of an asset performing real work. The observer owns the verdict; the asset-under-test runs as a real CLI in tmux, not as a subagent.

## Prepare the evaluation

1. Identify the asset and permitted side effects from the request. Read [asset-understanding.md](asset-understanding.md) if type or registration is unclear. Reuse an explicitly selected CLI; otherwise default to `claude`.
2. Read [convergence-and-task-design.md](convergence-and-task-design.md) for capability-based tasks, meaningful coverage, and affected-task revalidation. Apply [asset-strategies/common.md](asset-strategies/common.md) plus the matching type guide: [skill](asset-strategies/skill.md), [plugin](asset-strategies/plugin.md), [rule](asset-strategies/rule.md), or [agent](asset-strategies/agent.md).
3. Use [unattended-execution.md](unattended-execution.md) for the exact CLI commands, entry resolver, staging, task files, and recovery. These command contracts also apply to attended runs.
4. Register with `acc bootstrap`, record criteria and bounded tasks, choose `stop-loss`, `collect-first`, or `hybrid`, and start the round. Inspect relevant prerequisites before mutating state; do not turn routine setup into an approval gate.

## Execution contract

- Run ACC through `bun <skill-dir>/scripts/acc.ts`. State defaults to `~/.acceptance/state.sqlite3`; use `ACCEPTANCE_HOME` for isolation. All acceptance state reads and writes go through the CLI, never direct SQLite queries.
- Follow `start → launch → feed-task → bounded wait → capture → record → independent verification → finalize`. Feed every task with `acc feed-task --round` or `acc profile run-task` so coverage is recorded.
- Use the documented command spine. A structured gate rejection tells you what evidence is missing; do not inspect implementation to reverse-engineer a passing verdict or repeatedly probe `--help`.
- Only `acc finalize` ends a running round. Do not poll the DB waiting for that transition.
- Stage plugin assets with sandbox settings and `--plugin-dir`; stage standalone skills using the documented host discovery path. Real or symlinked HOME installations do not prove isolated execution.
- Use the isolation environment returned by `acc start`. Keep scratch under the round sandbox or `ACCEPTANCE_TMPDIR`; verify a task directory exists before writing into it.
- Never print settings or secret environment values. `acc capture`, `acc record`, and structured state reads redact known secrets; independently inspect the redacted evidence.
- Observe real task behavior. Self-grading or a correct answer produced by a neighboring global skill is not acceptance evidence.

## Finish and clean up

Continue authorized fixes and re-run affected tasks until clean PASS or a documented blocker under the convergence contract. Retain unaffected evidence only through its scoped revalidation rule; do not repeat unrelated passing tasks simply because a source hash changed.

`acc finalize` normally removes the sandbox, nested rounds, plugin staging, and this round's tmux session. Use `--keep-sandbox` only for active debugging, followed by `acc cleanup --round` before handoff. Never glob-clean `/tmp/acc-*` or kill unrelated tmux resources.

Report the verdict, actual task coverage, evidence, and cleanup. For self-validation, distinguish the observer's outer round from any nested round created by the asset-under-test.

## Host and recovery notes

- Shell variables do not persist between execution calls; resolve the loaded CLI path again or reload a task-private file. A review-only run has no strategy `WORK` directory.
- `acc history --asset <name-or-id>` requires an asset scope. If a required state read is unavailable, report it or add a narrow CLI operation when rig changes are authorized.
- Claude may expose a staged skill only as a namespaced slash command. Measure natural selection separately, then use the exact staged token for positive functional tasks. Do not repeat the same selection bypass until the budget is exhausted.
- Keep `scripts/acc.ts` focused on parsing, dispatch, JSON, and error shaping. DB, environment preparation, observation, and cleanup already have dedicated modules; change them only when the task needs it.
