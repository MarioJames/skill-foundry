# Skill acceptance strategy (v1 deep)

Trigger surface: over/under-trigger (fires when it should, stays quiet when it should not), discrimination against neighboring skills.

Category and scope: the skill should have a single primary category and stay coherent. Common categories include library/API reference, product validation, data analysis, workflow automation, scaffolding/templates, code review/quality, CI/CD/deploy, runbook/debugging, and infrastructure operations. A skill that spans multiple unrelated categories usually confuses the agent; record AMBER or FAIL depending on the blast radius.

Description quality: description is trigger conditions for the model, not a workflow summary for humans. It should describe when to load the skill, include concrete symptoms/keywords, avoid first-person language, and avoid summarizing the internal process because the model may follow the description instead of reading the skill body.

Value density: do not reward obvious advice. A useful skill contains information Claude would not reliably infer from default behavior, such as organization-specific constraints, unusual APIs, high-signal examples, or hard-earned failure modes.

Structure and progressive disclosure: treat the skill as a folder, not only `SKILL.md`. Detailed references, templates, scripts, examples, and assets should live in separate files and be referenced only when needed. The entry document should route the agent to the right file without forcing all context to load up front.

Internal logic: does it actually follow its own steps; do `references` load on demand; do scripts run; are gates/checklists honored.

Scripts and generated code: scripts should encode deterministic or repetitive work so the agent spends judgment on composition and verification. For script-heavy skills, require a thin entry: one small command/router for argument parsing, dispatch, JSON output, and error shaping, with durable capabilities split into focused submodules or sub-scripts. Broad monolithic scripts or undocumented generated code paths are AMBER.

Script-heavy skill verdicts must include a scripts/acc.py thin-entry assessment when that file exists or when an equivalent script entrypoint drives the workflow. The assessment should name what stays in the entrypoint (argument parsing, dispatch, JSON output, user-facing error shaping) and what lives in focused submodules. Missing this explicit assessment is AMBER even when tests pass.

Initialization and configuration: if the skill needs user/team-specific setup, it should declare the required configuration, preferably via `config.json` or a documented stable settings file. Missing configuration should lead to a clear question or structured choice, not hidden defaults or ad hoc guesses.

State and memory: if the skill stores persistent state, it must document where that state lives and why. Prefer append-only logs, JSON, SQLite, or the host-provided persistent data directory. Hidden writes to real home directories, global caches, or fixed `/tmp` paths are defects unless explicitly justified and cleaned up.

Validation tasks should not create or update memory/global notes as a side effect of observation unless the user explicitly asks for memory updates. Reusable findings belong in the round report, acceptance issues, or the asset-under-test source changes; unrequested memory writes are AMBER because they escape the round sandbox and are hard to audit.

For self-validation or validation-harness skills, distinguish the observer's outer acceptance round from any nested round that the asset-under-test starts. Do not claim that no `~/.acceptance` state was written when the outer acceptance round exists; say whether the asset-under-test created an additional nested round, and record that boundary in the verdict.

Gotchas: every mature skill should have a high-signal Gotchas section or equivalent. Gotchas should come from observed failures, not generic warnings, and should be updated when acceptance finds new bypasses or edge cases.

Guidance strength: avoid over-prescribing exact behavior when the task needs judgment. The skill should provide constraints, examples, and decision criteria while leaving room to adapt to the concrete repo, user request, and evidence.

Hooks and guardrails: if the skill ships Hooks, they should be on-demand Hooks scoped to the skill/session and clearly explain what they block or enforce. Always-on or broad hooks that interfere with unrelated work are defects.

Category-specific evidence: validation skills should include programmatic assertions, transcripts, screenshots, videos, or other concrete evidence paths. Review/quality skills should identify deterministic tools or checks. Workflow skills should persist enough run history for consistency. Scaffolding skills should ship templates/assets rather than asking the model to recreate boilerplate from memory.

Skill assets should run the canonical skill validator when it is available: `$HOME/.claude/skills/.system/skill-creator/scripts/quick_validate.py <skill_dir>`. If `$HOME/.claude/skills` is a symlink, use `find -L "$HOME/.claude/skills" -path '*/skill-creator/scripts/quick_validate.py' -type f` or the equivalent global skill root to discover it. A custom smoke test can supplement quick_validate, but should not silently replace it unless the validator is unavailable and the fallback is stated in the report.

Hard fails: the asset-under-test **bypasses** the skill and finishes by hand; gates are decorative.

Task prompts: de-guided — no hints about whether to split / parallelize / re-evaluate.

Forensics: tmux capture-pane / workspace state files / rollout JSONL.

## Gotchas
- A skill that merely restates Claude's default behavior adds context without value — note it as a weak skill.
- Watch for "token parallelism": the asset-under-test claims it used the skill but only outsourced trivial peripheral output.
