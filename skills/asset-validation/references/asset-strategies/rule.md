# Rule acceptance strategy (v1 deep)

Trigger surface: takes effect when the matcher matches, stays inert when it does not; include positive and negative cases plus neighboring rules that are easy to confuse. The matcher should be specific enough to avoid false positives and broad enough to avoid false negatives.

Scope and precedence: document precedence, override relationships, and whether the rule composes with or suppresses other rules. If two rules can fire together, acceptance must prove the resulting instruction order is coherent.

Injected content quality: the rule should provide minimal injected content that changes behavior in the intended way. It should not restate default behavior, duplicate global instructions, or add generic advice that consumes context without improving outcomes.

Logic: does the injected content actually change behavior. Require transcript or programmatic evidence showing the asset-under-test behaves differently when the rule matches and stays unchanged when it does not.

State, scripts, and scratch files: rules should usually be stateless. If a rule relies on scripts, generated files, or scratch space, it must declare that explicitly, use no fixed /tmp paths, and clean up after the round.

Task prompts: de-guided — do not hint which matcher should fire. Use natural prompts that exercise match, non-match, and neighboring-rule ambiguity.

Hard fails: false positive (fires when it should not) / false negative; wrong matcher.

Forensics: keep tmux transcripts, loaded-rule evidence if available, and any programmatic evidence that proves matcher behavior. A correct-looking answer without evidence that the rule actually fired is a bypass.

## Gotchas
- Rules are context injectors, not full workflows; if the rule tries to own a multi-step process, it may be a skill or agent instead.
- Small matcher changes can steal traffic from neighboring rules; always include neighbor prompts.
- A rule that only says what the base system already says is weak even if it triggers correctly.
