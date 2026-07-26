# {{ASSET_NAME}} rig tasks (for the asset-under-test root agent — de-guided)

Tasks are black-box stimuli. **DO NOT** ask the asset-under-test to judge its own trigger behavior, protocol compliance, or acceptance result; the observer decides those from transcript, command, file, process, and cleanup evidence.

Derive these tasks from the asset capability profile:
- asset type/category: {{ASSET_TYPE_CATEGORY}}
- realistic user goals: {{REALISTIC_USER_GOALS}}
- claimed capabilities to cover: {{CAPABILITIES_TO_COVER}}
- neighboring non-trigger cases: {{NEGATIVE_BOUNDARIES}}
- failure/recovery/cleanup modes: {{FAILURE_RECOVERY_MODES}}
- small/medium/complex meaning for this asset: {{SCALE_DEFINITION}}

For complex assets, create a progressive ladder instead of only a smoke task:
- negative / boundary task
- smoke
- small realistic scenario
- medium representative workflow
- final end-to-end complex scenario
- failure / recovery / cleanup path

Non-smoke rungs should be scenario prompts with domain context, constraints, deliverables, validation requirements, and non-goals. Scale them progressively: small realistic scenario, medium representative workflow, then final end-to-end complex scenario. **DO NOT** replace them with one-line toy tasks or a checklist of trivial file writes, and **DO NOT** copy the largest benchmark into every rung.

## Task A
{{TASK_A_BODY}}

## Task B
{{TASK_B_BODY}}

Constraints: complete only what the task body asks; **DO NOT** `git init` the /tmp sandbox; record environment problems honestly as blocked.
