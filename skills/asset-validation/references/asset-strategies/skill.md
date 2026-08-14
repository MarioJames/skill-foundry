# Skill acceptance strategy (v1 deep)

Apply [common.md](common.md) for the shared dimensions. Below is what is specific to skill assets.

Category and scope: the skill should have a single primary category and stay coherent. Common categories include library/API reference, product validation, data analysis, workflow automation, scaffolding/templates, code review/quality, CI/CD/deploy, runbook/debugging, and infrastructure operations. A skill that spans multiple unrelated categories usually confuses the agent; record AMBER or FAIL depending on the blast radius.

Negative trigger tests are behavior probes: send an ordinary neighboring task containing a decoy skill name/path/phrase, then judge from transcript markers and side effects whether the skill loaded or ran. Do not ask the asset-under-test to review its own trigger description.

Progressive ladder for complex workflow/orchestration skills: require minimal smoke, small realistic workflow, medium representative workflow, final end-to-end complex workflow, failure/recovery/cleanup, and negative boundaries before PASS. If the skill claims recursion, scheduling, cleanup, recovery, or review/fix gates, at least one rung must exercise each claimed class of behavior. A single tiny happy-path file write is GREEN only for the smoke rung and remains AMBER/insufficient as the final verdict. The largest known benchmark can inform the final rung's shape, but should not be copied into every rung or replace incremental coverage.

Value density: do not reward obvious advice. A useful skill contains information Claude would not reliably infer from default behavior, such as organization-specific constraints, unusual APIs, high-signal examples, or hard-earned failure modes. A skill that merely restates default behavior is weak even when it triggers correctly.

Structure and progressive disclosure: treat the skill as a folder, not only `SKILL.md`. Detailed references, templates, scripts, examples, and assets should live in separate files and be referenced only when needed. The entry document should route the agent to the right file without forcing all context to load up front.

Internal logic: does it actually follow its own steps; do `references` load on demand; do scripts run; are gates/checklists honored.

Scripts and generated code: scripts should encode deterministic or repetitive work so the agent spends judgment on composition and verification. For script-heavy skills, require a thin entry: one small command/router for argument parsing, dispatch, JSON output, and error shaping, with durable capabilities split into focused submodules or sub-scripts. Broad monolithic scripts or undocumented generated code paths are AMBER.

Script-heavy skill verdicts must include a `scripts/acc.ts` thin-entry assessment when that file exists or when an equivalent script entrypoint drives the workflow. The assessment should name what stays in the entrypoint (argument parsing, dispatch, JSON output, user-facing error shaping) and what lives in focused submodules. Missing this explicit assessment is AMBER even when tests pass.

Initialization: when user/team-specific setup is needed, prefer `config.json` or a documented stable settings file (general configuration rule: common.md).

Nested rounds: for self-validation or validation-harness skills, distinguish the observer's outer acceptance round from any nested round that the asset-under-test starts. Do not claim that no `~/.acceptance` state was written when the outer acceptance round exists; say whether the asset-under-test created an additional nested round, and record that boundary in the verdict.

Gotchas quality: every mature skill should have a high-signal Gotchas section or equivalent. Gotchas should come from observed failures, not generic warnings, and should be updated when acceptance finds new bypasses or edge cases.

Guidance strength: avoid over-prescribing exact behavior when the task needs judgment. The skill should provide constraints, examples, and decision criteria while leaving room to adapt to the concrete repo, user request, and evidence.

Category-specific evidence: validation skills should include programmatic assertions, transcripts, screenshots, videos, or other concrete evidence paths. Review/quality skills should identify deterministic tools or checks. Workflow skills should persist enough run history for consistency. Scaffolding skills should ship templates/assets rather than asking the model to recreate boilerplate from memory.

Standalone skill execution evidence must come from a sandbox-discoverable skill install, not merely `--add-dir` file access. Prefer `acc profile run-task` for supported skill rounds so the typed profile runner applies the skill staging, bounded wait, transcript capture, and secret redaction consistently. For Claude, `acc launch` uses a temporary sandbox-local plugin wrapper with `--bare`, isolation `--append-system-prompt`, sandbox `--settings`, and `--plugin-dir`. For Codex, it stages the skill at the round sandbox's `.agents/skills/<name>` repository discovery path. Require visible skill-selection evidence and verify executed script/file paths; a correct answer from a neighboring global skill or inline behavior is a bypass.

Separate host selection from functional execution. For a host such as Claude Code that exposes staged skills as slash commands but does not promise automatic natural-language selection, prefix positive functional tasks with the exact staged slash token shown by the session (for example `/acc-skill-<name>:<name>`). Keep at least one natural-language trigger probe separate. If the natural probe bypasses while the explicit staged command loads and performs correctly, record the host-selection limitation; do not burn the round budget repeating the same natural prompt or misclassify the script/workflow as broken. A positive functional result still requires visible staged-skill evidence; manually reproducing its answer remains a bypass.

The rig enforces a recursion depth limit (`ACCEPTANCE_DEPTH` max 2): a self-validation skill that itself starts nested acceptance rounds cannot recurse beyond two levels, preventing runaway CLI spawning. `acc start` rejects with `{"blocked": "depth-exceeded"}` when exceeded.

Hard fails: the asset-under-test **bypasses** the skill and finishes by hand; gates are decorative.
