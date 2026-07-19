# Rule acceptance strategy (v1 deep)

Apply [common.md](common.md) for the shared dimensions. Below is what is specific to rule assets.

Matcher surface: takes effect when the matcher matches, stays inert when it does not; include positive and negative cases plus neighboring rules that are easy to confuse. The matcher should be specific enough to avoid false positives and broad enough to avoid false negatives. Rule tasks naturally come in matched/unmatched pairs — design and run them together.

Scope and precedence: document precedence, override relationships, and whether the rule composes with or suppresses other rules. If two rules can fire together, acceptance must prove the resulting instruction order is coherent.

Injected content quality: the rule should provide minimal injected content that changes behavior in the intended way. It should not restate default behavior, duplicate global instructions, or add generic advice that consumes context without improving outcomes.

Behavioral delta: require transcript or programmatic evidence showing the asset-under-test behaves differently when the rule matches and stays unchanged when it does not.

Statelessness: rules should usually be stateless. If a rule relies on scripts, generated files, or scratch space, it must declare that explicitly, use no fixed /tmp paths, and clean up after the round (persistent-state rule: common.md).

Hard fails: false positive (fires when it should not) / false negative; wrong matcher.

Rig limitation: the current rig has no rule-injection staging mechanism (rule profile is `implemented: False`). Rule rounds launch with `--add-dir` only, so loaded-rule evidence may be unavailable. Mark rule trigger evidence as `rig-blocked` when the host CLI does not expose rule-load markers; do not chase evidence the rig cannot produce.

## Gotchas
- Rules are context injectors, not full workflows; if the rule tries to own a multi-step process, it may be a skill or agent instead.
- Small matcher changes can steal traffic from neighboring rules; always include neighbor prompts.
- A rule that only says what the base system already says is weak even if it triggers correctly.
