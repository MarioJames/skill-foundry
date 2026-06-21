---
name: asset-validation
description: Use when the user wants to evaluate, review, iterate on, validate, or run evidence-backed acceptance for a reusable asset such as a skill, plugin, rule, or agent. Trigger on 评估, 迭代, 验收, evaluate, validate, review, 靶场, observation-based acceptance, or explicit asset-validation. Do NOT trigger on testing ordinary application code.
---

# Asset Validation

Validate a reusable asset through review, acceptance design, real CLI execution, evidence capture, and cleanup. The current agent is the observer. The asset-under-test runs as a real interactive CLI in tmux, never as a subagent or substitute answer.

## Command Entry

Derive `<skill_dir>` from this skill folder. In a sandboxed CLI round, the loaded path is usually `$HOME/.claude/skills/asset-validation`:

```
ACC="$HOME/.claude/skills/asset-validation/scripts/acc.py"
python3 "$ACC" <subcommand> ...
```

All reads and writes go through `scripts/acc.py`. Do not query SQLite directly. If the script layer lacks the read you need, add a narrow `acc` read command first.

**Thin script entry.** Keep `scripts/acc.py` as a thin entrypoint for argument parsing, command dispatch, JSON output, and user-facing error shaping. Put durable capabilities in focused submodules or sub-scripts: DB access, round environment preparation, plugin staging, tmux observation, and cleanup.

## State And Config

State lives in `~/.acceptance/state.sqlite3` plus `~/.acceptance/fixtures/`; `ACCEPTANCE_HOME` overrides that root for tests or isolated runs. The asset-under-test CLI is selected when starting and launching a round: ask the user to choose `claude` or `codex` in attended mode, and default to `claude` when no choice is provided.

`acc start` prepares each round idempotently: sandbox workdir, isolated acceptance DB root, `ACCEPTANCE_TMPDIR`, sandbox runtime roots, and sandbox Claude settings. Use the returned `isolation_env` instead of hand-rolling paths.

## Entry Routing

- `@asset` plus **评估 / 迭代 / 验收 / acceptance / evaluate / validate**: run the full pipeline.
- `@asset` plus **review**: run review only and stop after review-and-fix.
- `@asset` with no verb: ask for **full pipeline / acceptance only / review only**.
- Multiple unfinished acceptances for the asset: run `acc accept list --asset <name> --status draft` and ask which one to continue.

## Unattended Mode

When the user is away, sleeping, or asks for automatic completion, treat confirmations as pre-authorized unless the action changes destructive scope or touches assets outside the asset-under-test.

Use [references/unattended-execution.md](references/unattended-execution.md) before executing unattended rounds. It contains the exact command spine, temp-file rules, prompt-shape constraints, tmux capture flow, and cleanup requirements.

## Phase Checklist

1. Understand and classify the asset, then run `acc asset add`. In attended mode, confirm type and purpose first; in unattended mode, record the confirmation as pre-authorized.
2. Review and fix major logic problems in the asset-under-test only. See [references/review-and-fix.md](references/review-and-fix.md).
3. Produce acceptance artifacts with `acc accept new` and `acc accept update`: goal, strategy, acceptance prompt, criteria, task prompts, and fixture. Use flat task JSON such as `{"t1": "body to send"}`.
4. Pick one scheduling mode with a reason: **stop-loss / collect-first / hybrid**.
5. Launch the observe loop only after the prompt, criteria, task prompts, fixture decision, and cleanup plan are explicit.

## Observe Loop

Use the selected real asset-under-test CLI: `acc start --cli <claude|codex>` -> `acc launch --round <round_id> --cli <claude|codex>` -> `acc feed-task --round <round_id> --task t1` -> bounded wait -> `acc capture` -> `acc record` -> independent re-verification -> `acc finding` as needed -> `acc finalize`. If the user does not choose a CLI, omit `--cli` and use the default `claude`. By default, `acc finalize` also cleans the round sandbox, nested acceptance sandboxes, plugin staging, and the round tmux session. Use `acc finalize --keep-sandbox` only when preserving a failed round for local debugging, then explicitly run `acc cleanup --round <round_id>` before returning.

Only `acc finalize` changes a round out of `running`; do not poll the database expecting that state to change by itself.

## Side Effects

Validation runs should only write the acceptance DB, round sandbox, configured fixture/evidence paths, and files in the asset-under-test when a fix is authorized. Do not create or update memory, global notes, unrelated caches, or host configuration unless the user explicitly asks for that persistent side effect.

## Gotchas

- A correct-looking answer without visible skill, agent, plugin, command, or transcript evidence is a bypass.
- Never manufacture a pass by doing the asset-under-test's work in the observer.
- Never glob-clean `/tmp/acc-*` or kill broad tmux state; rely on `acc finalize` automatic cleanup for the current round, or use `acc cleanup --round <round_id>` only for kept/debug rounds and orphan repair.
- Plugin assets must be staged through the round sandbox settings and plugin dir. Do not use real or symlinked HOME skill roots as install evidence.
- Fixed scratch paths such as `/tmp/acc-toy` and `/tmp/acc-work-path.txt` collide across rounds and agents.

## Asset Strategies

Before final verdict, apply the relevant asset strategy reference for the asset type. For skill assets, this includes explicit script-entry assessment and, for self-validation or validation-harness skills, the outer/nested round boundary.

- [references/asset-strategies/skill.md](references/asset-strategies/skill.md)
- [references/asset-strategies/plugin.md](references/asset-strategies/plugin.md)
- [references/asset-strategies/rule.md](references/asset-strategies/rule.md)
- [references/asset-strategies/agent.md](references/asset-strategies/agent.md)
