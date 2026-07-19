# Common acceptance dimensions (all asset types)

Apply these dimensions to every asset type, then read the per-type strategy file for its deltas. Per-type files do not repeat these rules.

**Trigger surface:** fires when it should, stays quiet when it should not, and discriminates against neighboring assets (skills, agents, rules) that could steal or leak triggers. The `description` / matcher is trigger conditions for the model, not a workflow summary for humans: concrete symptoms/keywords, no first-person language, and no internal-process summary the model might follow instead of reading the body. Over-broad or over-narrow trigger surfaces are themselves defects to record.

**De-guided task prompts:** the task sent to the asset-under-test must not hint which asset should fire, whether to split / parallelize / re-evaluate, or how the observer scores. Use natural user phrasing; the root prompt may include a required activation phrase but never the protocol or verdict rules.

**Verdict ownership:** the observer owns all verdicts; never ask the asset-under-test to grade its own trigger or protocol behavior (see references/convergence-and-task-design.md "Verdict Ownership").

**Configuration:** if the asset needs user/team/repo-specific setup, the config path and missing-config behavior must be documented and repeatable. Missing configuration should lead to a clear question or clean failure — never hidden defaults, prompts that cannot run unattended, or ad hoc guesses.

**Persistent state:** document where state lives and why. Prefer append-only logs, JSON, SQLite, or host-provided persistent data directories. Hidden writes to real HOME, global caches, or fixed `/tmp` paths are defects unless explicitly justified and cleaned up. Validation itself must not create memory or global notes as a side effect (SKILL.md "Side Effects"); unrequested memory writes are AMBER because they escape the round sandbox and are hard to audit.

**Hooks and guardrails:** shipped hooks should be on-demand Hooks scoped to the asset/session, with clear trigger patterns and failure behavior. Broad always-on hooks that block unrelated commands, mutate unrelated files, or silently change tool semantics are defects.

**Forensics and bypass:** require observer-collected evidence — transcript markers, commands, files, processes, cleanup state — via tmux capture-pane, workspace state files, or rollout JSONL. A correct-looking answer without visible skill/agent/plugin/rule evidence is a bypass: record FAIL or CONDITIONAL, then fix and re-run.

**Token parallelism:** outsourcing trivial peripheral output while doing the real work by hand is not meaningful asset use; record AMBER or FAIL.
