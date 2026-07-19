---
name: asset-validation
description: Use when the user wants to evaluate, review, iterate on, validate, or run evidence-backed acceptance for a reusable asset such as a skill, plugin, rule, or agent. Trigger on 评估, 迭代, 验收, evaluate, validate, review, 靶场, observation-based acceptance, or explicit asset-validation. Do NOT trigger on testing ordinary application code.
---

# Asset Validation

Validate reusable assets through review, acceptance design, real CLI execution, evidence capture, and cleanup. You are the observer. Asset-under-test runs as real CLI in tmux, never as subagent.

## Convergence And Task Design

Before tasks or verdicts, use [references/convergence-and-task-design.md](references/convergence-and-task-design.md). It defines observer-owned verdicts, post-fix clean-pass requirements, capability profiling, and progressive scenario ladders. A tiny task is only a smoke test for complex assets.

## Command Entry

Derive `<skill_dir>` from this skill folder, not from a hard-coded global install path. The ACC resolver is defined in references/unattended-execution.md (staged copy -> repo checkout -> loaded skill dir); use that resolver verbatim. Do not run `acc --help` for discovery; contracts here are authoritative.

All state reads/writes go through `scripts/acc.py`. Do not query SQLite directly. If a read is missing, add a narrow `acc` command first.

**Thin script entry.** Keep `scripts/acc.py` as a thin entrypoint for argument parsing, command dispatch, JSON output, and user-facing error shaping. Put durable capabilities in focused submodules or sub-scripts: DB access, round environment preparation, plugin staging, tmux observation, and cleanup.

## State And Config

State lives in `~/.acceptance/state.sqlite3`; `ACCEPTANCE_HOME` overrides that root for tests or isolated runs. Select CLI at start/launch: ask `claude`/`codex` in attended mode, default `claude` when absent.

`acc start` idempotently prepares sandbox workdir, isolated DB root, `ACCEPTANCE_TMPDIR`, runtime roots, and Claude settings. Use returned `isolation_env`.

## Entry Routing

- `@asset` plus **评估 / 迭代 / 验收 / acceptance / evaluate / validate**: run the full pipeline.
- `@asset` plus **review**: run review only and stop after review-and-fix.
- `@asset` with no verb: ask for **full pipeline / acceptance only / review only**.
- Multiple unfinished acceptances for the asset: run `acc accept list --asset <name> --status draft` and ask which one to continue.

## Unattended Mode

When the user is away, sleeping, or asks for automatic completion, treat confirmations as pre-authorized unless the action changes destructive scope or touches assets outside the asset-under-test.

Use [references/unattended-execution.md](references/unattended-execution.md) before executing unattended rounds. It contains the exact command spine, temp-file rules, prompt-shape constraints, tmux capture flow, and cleanup requirements.

## Phase Checklist

1. Understand and classify the asset, then make the first write with `acc bootstrap` (registers the asset and opens the acceptance in one command; `acc asset add` + `acc accept new` are the two-step equivalent). In attended mode, confirm type and purpose first; in unattended mode, record the confirmation as pre-authorized.
2. Write an asset capability profile and design observer-scored progressive tasks. See [references/convergence-and-task-design.md](references/convergence-and-task-design.md).
3. Review and fix major logic problems in the asset-under-test only. See [references/review-and-fix.md](references/review-and-fix.md).
4. Complete acceptance artifacts with `acc accept update`: strategy, acceptance prompt, criteria, task prompts, ladder, and fixture. Use a capability-profiled progressive task ladder and flat task JSON such as `{"t1": "body to send"}`.
5. Pick one scheduling mode with a reason: **stop-loss / collect-first / hybrid**.
6. Launch the observe loop only after the prompt, criteria, task prompts, fixture decision, cleanup plan, and ladder coverage are explicit.
7. After each round, finalize and clean the round, fix observed defects, then re-run from `acc start` until a fresh clean PASS or blocked state.
8. Before feeding tasks, confirm each task is a black-box stimulus. The observer computes acceptance from transcripts, commands, files, processes, and cleanup state.

## Observe Loop

Use the selected real asset-under-test CLI: `acc start --cli <claude|codex>` -> `acc launch --round <round_id> --cli <claude|codex>` -> `acc feed-task --round <round_id> --task t1` -> bounded wait -> `acc capture` -> `acc record` -> independent re-verification -> `acc finding` as needed -> `acc finalize`. If the user does not choose a CLI, omit `--cli` and use the default `claude`. By default, `acc finalize` also cleans the round sandbox, nested acceptance sandboxes, plugin staging, and the round tmux session. Use `acc finalize --keep-sandbox` only when preserving a failed round for local debugging, then explicitly run `acc cleanup --round <round_id>` before returning.

Only `acc finalize` changes a round out of `running`; do not poll the database expecting that state to change by itself.

After `acc finalize`, inspect the verdict and evidence before answering. If the round is FAIL/CONDITIONAL, or if cleanup/evidence was incomplete, keep working per the convergence reference.

## Side Effects

Validation runs should only write the acceptance DB, round sandbox, fixture/evidence paths, and asset-under-test files when a fix is authorized. Do not create or update memory, global notes, caches, or host config unless the user explicitly asks.

## Gotchas

- A correct-looking answer without visible skill, agent, plugin, command, or transcript evidence is a bypass.
- Direct `sqlite3 .../state.sqlite3` reads are bypasses; use `acc round list`, `acc history`, `acc show`, or add an `acc` read.
- Never print settings files or secret env values; report paths only. `acc capture`/`acc record` redact known secret keys automatically.
- Bash variables do not persist across tool calls; resolve `ACC` in each Bash or store it in `"$WORK/.acc-path"`.
- A self-review prompt is not a negative trigger test. The observer must test trigger behavior by observing what the asset-under-test does, not by asking it to grade its own trigger.
- A one-line toy task is only a smoke test. It cannot be the final verdict for a complex orchestration, recovery, or workflow asset.
- Never manufacture a pass by doing the asset-under-test's work in the observer.
- Never glob-clean `/tmp/acc-*` or kill broad tmux state; rely on `acc finalize` automatic cleanup for the current round, or use `acc cleanup --round <round_id>` only for kept/debug rounds and orphan repair.
- Plugin assets must be staged through the round sandbox settings and plugin dir. Do not use real or symlinked HOME skill roots as install evidence.
- Fixed scratch paths such as `/tmp/acc-toy`, `/tmp/acc-work-path.txt`, or any fixed `/tmp/.<name>_marker` collide across rounds and agents. Persist work paths only inside the current round sandbox or its `ACCEPTANCE_TMPDIR`, for example `"$WORK/.workpath"`.

## Asset Strategies

Before final verdict, apply [references/asset-strategies/common.md](references/asset-strategies/common.md) (shared dimensions for every asset type) plus the per-type reference. For skill assets, this includes explicit script-entry assessment and, for self-validation or validation-harness skills, the outer/nested round boundary.

- [references/asset-strategies/common.md](references/asset-strategies/common.md)
- [references/asset-strategies/skill.md](references/asset-strategies/skill.md)
- [references/asset-strategies/plugin.md](references/asset-strategies/plugin.md)
- [references/asset-strategies/rule.md](references/asset-strategies/rule.md)
- [references/asset-strategies/agent.md](references/asset-strategies/agent.md)
