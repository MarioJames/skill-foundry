---
name: asset-validation
description: Use when the user wants to evaluate, review, iterate on, validate, or run evidence-backed acceptance for a reusable asset such as a skill, plugin, rule, or agent. Trigger on 评估, 迭代, 验收, evaluate, validate, review, 靶场, observation-based acceptance, or explicit asset-validation. **DO NOT** trigger on testing ordinary application code.
---

# Asset Validation

Validate reusable assets through review, acceptance design, real CLI execution, evidence capture, and cleanup. You are the observer. Asset-under-test runs as real CLI in tmux, never as subagent.

## **HARD CONSTRAINTS**

- **MUST** run the asset-under-test as real CLI in tmux; **DO NOT** use a subagent as the asset-under-test.
- **DO NOT** query SQLite directly. All state reads/writes go through `bun scripts/acc.ts`.
- **DO NOT** create or update memory, global notes, caches, or host config unless the user explicitly asks.
- **NEVER** print settings files or secret env values; report paths only.
- **NEVER** manufacture a pass by doing the asset-under-test's work in the observer.
- **NEVER** glob-clean `/tmp/acc-*` or kill broad tmux state; rely on `acc finalize` / `acc cleanup --round`.
- **DO NOT** run `acc --help` for discovery; contracts here and in references are authoritative.
- **DO NOT** inspect, grep, or read ACC implementation files to discover command contracts, PASS gates, or sequencing; use the documented command spine and let the CLI enforce its gates.
- **MUST** feed tasks via `acc feed-task --round` or `acc profile run-task`; only `acc finalize` leaves `running`.
- Plugin assets **MUST** be staged via sandbox settings/`--plugin-dir`; **DO NOT** use real or symlinked HOME skill roots as install evidence.

## Convergence And Task Design

Before tasks or verdicts, use [references/convergence-and-task-design.md](references/convergence-and-task-design.md): observer-owned verdicts, post-fix clean-pass, capability profiling, progressive ladders. A tiny task is only smoke for complex assets.

## Command Entry

Derive `<skill_dir>` from this skill folder, not a hard-coded global install path. The ACC resolver is defined in references/unattended-execution.md (staged copy -> repo checkout -> loaded skill dir); use that resolver verbatim.

All state reads/writes go through `scripts/acc.ts` on the Bun runtime. If a read is missing, add a narrow `acc` command first.

**Thin script entry.** Keep `scripts/acc.ts` thin (args, dispatch, JSON, error shaping). Put durable capabilities in focused TypeScript submodules: DB, env prep, plugin staging, tmux observation, cleanup.

## State And Config

State lives in `~/.acceptance/state.sqlite3`; `ACCEPTANCE_HOME` overrides for tests or isolation. ACC requires Bun and uses `bun:sqlite`; its bundled runtime has no Python dependency. Review of an external skill may separately invoke the active skill-creator's canonical validator, including its external Python fallback documented in `references/review-and-fix.md`. Select CLI at start/launch: ask `claude`/`codex` in attended mode, default `claude` when absent.

`acc start` idempotently prepares sandbox workdir, isolated DB root, `ACCEPTANCE_TMPDIR`, runtime roots, and host-specific launch settings. Use returned `isolation_env`.

## Entry Routing

- `@asset` plus **评估 / 迭代 / 验收 / acceptance / evaluate / validate**: full pipeline.
- `@asset` plus **review**: review only; stop after review-and-fix.
- `@asset` with no verb: ask for **full pipeline / acceptance only / review only**.
- Multiple unfinished acceptances: `acc accept list --asset <name> --status draft` and ask which to continue.

## Unattended Mode

When the user is away, sleeping, or asks for automatic completion, treat confirmations as pre-authorized unless the action changes destructive scope or touches assets outside the asset-under-test.

Use [references/unattended-execution.md](references/unattended-execution.md) before unattended rounds (command spine, temp-file rules, prompt shape, tmux capture, cleanup).

## Phase Checklist

1. Classify the asset; first write with `acc bootstrap` (`acc asset add` + `acc accept new` is the two-step equivalent). Attended: confirm type/purpose first; unattended: record pre-authorized confirmation.
2. Write capability profile and progressive observer-scored tasks. See convergence reference.
3. Review/fix major logic only in the asset-under-test. See [references/review-and-fix.md](references/review-and-fix.md).
4. `acc accept update`: strategy, acceptance prompt, criteria, task prompts, ladder, fixture. Flat task JSON: `{"t1": "body to send"}`.
5. Pick scheduling mode with reason: **stop-loss / collect-first / hybrid**.
6. Launch observe loop only after prompt, criteria, tasks, fixture, cleanup plan, and ladder coverage are explicit.
7. After each round: finalize/clean, fix defects, then re-run from `acc start` until clean PASS or blocked. For a boundary-only additive fix, follow the scoped revalidation rule in the convergence reference: keep unaffected PASS evidence and re-run only the failed/new boundary tasks. Never repeat a passed task solely because the asset hash changed.
8. Before feeding tasks, confirm each is a black-box stimulus; observer scores from transcripts, commands, files, processes, cleanup.

## Observe Loop

Real CLI spine: `acc start --cli <claude|codex>` -> `acc launch --round <round_id> --cli <claude|codex>` -> `acc feed-task --round <round_id> --task t1` -> bounded wait -> `acc capture` -> `acc record` -> independent re-verification -> `acc finding` as needed -> `acc finalize`. Omit `--cli` to default `claude`. Default `acc finalize` cleans sandbox, nested sandboxes, plugin staging, and round tmux. Use `--keep-sandbox` only for local debug, then `acc cleanup --round <round_id>` before return.

After recording every declared ladder task, invoke documented `acc finalize --verdict <PASS|FAIL|CONDITIONAL>` directly. Do not inspect ACC source to predict `canFinalizePass` or other internal gates. A structured gate rejection is the contract: address the reported missing coverage/evidence, then retry the documented command.

Only `acc finalize` changes a round out of `running`; **DO NOT** poll the DB for that transition.

After finalize, inspect verdict and evidence. On FAIL/CONDITIONAL or incomplete cleanup/evidence, keep working per the convergence reference.

## Side Effects

Write only the acceptance DB, round sandbox, fixture/evidence paths, and authorized asset-under-test fixes. **DO NOT** create or update memory, global notes, caches, or host config unless the user explicitly asks.

## Gotchas

- Correct-looking answer without skill/agent/plugin/command/transcript evidence is a bypass.
- Direct `sqlite3 .../state.sqlite3` is a bypass; use the documented scoped reads, including `acc history --asset <asset-name-or-id>`. A bare `acc history` is a usage error because `--asset` is required. If the existing reads cannot answer the question, add a narrow `acc` read.
- **NEVER** print settings files or secret env values; report paths only. `acc capture`/`acc record` and every structured `acc` read redact known secret keys and high-confidence bare tokens. The rig also sanitizes evidence persisted by older versions before returning `round list` or `history`; add a regression whenever a new token shape is observed.
- Bash variables do not persist across tool calls. In review-only mode, no strategy `WORK` exists: resolve `ACC` again in each Bash batch and do not try to persist `"$WORK/.acc-path"`. In a full acceptance, write under `WORK` only after that same batch has confirmed it is a non-empty existing absolute directory; an unset `WORK` turns the path into `/.acc-path` and fails on the read-only filesystem.
- Self-review is not a negative trigger test. Observer **MUST** watch behavior, not ask the asset to grade its own trigger.
- Claude Code may expose a staged skill only as a namespaced slash command and bypass it on a natural prompt. Use a separate natural selection probe, then invoke the exact staged slash token for positive functional rounds; never substitute a hand-computed answer or repeat the same selection bypass until the budget is gone.
- One-line toy task is smoke only; not final verdict for complex orchestration/recovery/workflow assets.
- **NEVER** manufacture a pass by doing the asset-under-test's work in the observer.
- **NEVER** glob-clean `/tmp/acc-*` or kill broad tmux; rely on `acc finalize` auto-cleanup, or `acc cleanup --round` for kept/debug/orphan rounds.
- Fixed scratch paths (`/tmp/acc-toy`, `/tmp/acc-work-path.txt`, `/tmp/.<name>_marker`) collide. Persist paths only under the round sandbox or its `ACCEPTANCE_TMPDIR`, e.g. `"$WORK/.workpath"`.
- Review-only scratch must also use `mktemp -d "${ACCEPTANCE_TMPDIR:-${TMPDIR:-/tmp}}/<purpose>.XXXXXX"`; do not hard-code `/tmp/<purpose>.*` when the acceptance runtime already supplies an isolation root.
- In review-only, stop once the requested static, runtime, and canonical evidence is complete. Do not append speculative usage/error-path probes merely because time remains. If an explicitly requested probe needs captured stdout/stderr, create `SCRATCH` first in that same batch and redirect only to `"$SCRATCH/stdout"` / `"$SCRATCH/stderr"`; placeholder targets such as `/tmp-placeholder-ignore` are commands against the real filesystem, not harmless notation.

## Asset Strategies

Before final verdict, apply [references/asset-strategies/common.md](references/asset-strategies/common.md) plus the per-type file. Skill assets need script-entry assessment and, for self-validation/validation-harness skills, the outer/nested round boundary.

- [references/asset-strategies/common.md](references/asset-strategies/common.md)
- [references/asset-strategies/skill.md](references/asset-strategies/skill.md)
- [references/asset-strategies/plugin.md](references/asset-strategies/plugin.md)
- [references/asset-strategies/rule.md](references/asset-strategies/rule.md)
- [references/asset-strategies/agent.md](references/asset-strategies/agent.md)
