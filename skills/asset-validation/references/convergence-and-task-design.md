# Convergence and Task Design

## Convergence Contract

The full pipeline is not complete after the first observed round. Continue the observe -> record -> fix -> re-run loop until one of these terminal states is true:

- **Clean PASS:** a fresh round, started after the latest asset or strategy fix, satisfies the acceptance criteria in one uninterrupted run; `acc finalize` reports cleanup, and independent checks show no relevant sandbox, tmux, plugin staging, or asset-owned background residue. Freshness is recorded mechanically: each round stores the asset source hash at start, and `acc history --asset <asset-name-or-id>` marks a round `stale` when the asset changed after it ran; a stale PASS never satisfies this contract.
- **Blocked:** the same blocker (same `finding --key`) repeats after at least three consecutive attempts, the acceptance exceeds its `--budget-max-rounds` limit, or the next fix would require user approval because it changes destructive scope, touches assets outside the asset-under-test, or needs unavailable credentials/quota.

A FAIL, CONDITIONAL, partial PASS, manual hot-fix, or "this should be fixed now" is an intermediate result. Record and finalize that round, fix the asset-under-test or acceptance design, then start a new fresh round. Do not return a final verdict until a post-fix round passes cleanly or the run is explicitly blocked.

## Verdict Ownership

The observer owns all validation verdicts. The asset-under-test may produce task output, but it must not be asked to judge whether its own skill, plugin, rule, trigger surface, or protocol behaved correctly. Treat any self-assessment from the observed CLI as ordinary transcript text, never as acceptance evidence by itself.

Design trigger and negative-control tasks as behavior probes, not self-reviews. For example, ask the observed CLI to perform a neighboring ordinary task that contains a decoy phrase/path, then the observer checks the transcript and side effects for evidence: no `Skill(...)` load, no orchestration command, no unexpected background job, no asset-owned state change. Do not ask the observed CLI "did this trigger correctly?", "is this skill easy to mis-trigger?", or "validate your trigger description" as the acceptance task.

## Progressive Task Ladder

Acceptance tasks must be derived from the asset type and capability profile. Declare the ladder with `acc accept update --ladder-file <f>` (JSON mapping rung names to task keys: `{"smoke": ["t1"], "representative": ["t2"], ...}`). Valid rungs are `smoke`, `representative`, `complex`, `failure-recovery`, `negative-boundary`. `acc finalize --verdict PASS` blocks while any declared rung has a task without a non-stale PASS round covering it; task coverage is recorded mechanically when tasks are fed via `acc feed-task --round` or `acc profile run-task`. Use `--allow-partial <reason>` only for explicit partial coverage (it records a waived finding). Before writing task prompts, classify what the asset is for, what users would realistically ask it to do, what capabilities it claims, and what failure modes matter for that category. Then build a small-to-large ladder of realistic task goals for that asset. Do not declare a complex skill, plugin, rule, or agent OK after only a tiny smoke task. Build enough fresh rounds to cover the asset's real behavioral surface:

- **Smoke:** minimal task proving the trigger and script entry work.
- **Representative:** ordinary real-world scenario for the asset's main purpose.
- **Complex / multi-step:** scenario-grade task that exercises coordination, state, retries, parallelism, or cross-file/process behavior when the asset claims those capabilities.
- **Failure / recovery:** realistic blocked, failed, partial, or timeout path when the asset has recovery or cleanup logic.
- **Negative / boundary:** neighboring tasks and decoy phrases that should not trigger.

Each rung must have explicit observer-owned evidence and cleanup checks. If a rung fails and is fixed, re-run that rung from a fresh round, then continue upward. A smoke PASS may justify continuing; it is not a final PASS for a complex asset. The meaning of "small", "medium", and "complex" must be reasonable for the asset category: a browser-validation skill might scale from one static page to a project with dev server and cleanup; an orchestration skill might scale from one delegated task to a multi-module product delivery; a rule asset might scale from one ambiguous instruction to a realistic conflicting-constraints workflow.

For staged skills, split the smoke evidence when the selected host uses explicit slash activation: one natural-language probe measures host selection, while an explicit staged slash invocation proves the skill and its scripts actually execute. Do not accept a hand-computed natural-language answer as functional evidence, and do not repeat an identical host-selection bypass until the budget is exhausted after explicit activation is available.

## Scenario-Grade Tasks

For complex assets, each non-smoke rung must be a coherent scenario prompt, not a list of tiny chores. Scenario scale should increase rung by rung according to the asset type: start with a small realistic scenario, then a medium representative workflow, and reserve the largest end-to-end scenario for the final complex rung. A scenario-grade prompt includes:

- real context and domain constraints;
- enough scope to require the asset's advertised workflow rather than direct single-agent execution;
- concrete deliverables and non-goals;
- explicit validation requirements, commands, paths, or evidence the observed CLI must produce;
- realistic failure pressure such as integration boundaries, cleanup requirements, recovery paths, or conflicting constraints;
- clear acceptance expectations without revealing the observer's scoring rubric.

Do not synthesize "complexity" by chaining several one-line tasks such as "write two files" or "make a tiny script." Also do not copy the largest known benchmark as every rung. Extract the benchmark's essence: realistic context, constraints, deliverables, evidence, and meaningful pressure on the asset's claimed behaviors. If the asset is an orchestration/workflow skill, the medium and final rungs should be large enough that delegation, state tracking, review/fix, recovery, and cleanup are naturally useful. The root prompt may include the skill's required activation phrase, but should not explain the orchestration protocol, subagent strategy, or observer verdict rules.
