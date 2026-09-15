---
name: asset-validation
description: Review reusable skills, plugins, rules, and agents; run real CLI acceptance when behavioral validation is requested. Not for ordinary application tests.
---

# Asset Validation

## Choose the requested outcome

- **Review / audit:** inspect the asset and relevant references, report concrete findings, and run proportionate static checks. Use [review-and-fix.md](references/review-and-fix.md). Do not launch ACC or modify the asset unless the request includes those actions.
- **Fix / iterate:** implement the requested corrections and verify affected behavior. A documentation edit does not automatically require full acceptance.
- **Behavioral acceptance / real CLI evaluation:** use [acceptance.md](references/acceptance.md) for isolation, task design, observation, and cleanup. A static review cannot establish a behavioral PASS.

Use Codex for real CLI acceptance by default. Use Claude Code only when the user explicitly selects it; an unavailable Codex must not silently trigger a Claude fallback.

Infer the route from the requested deliverable and existing authorization. Ask only when a missing choice changes scope, cost, or permitted side effects. An already specified asset, purpose, or CLI needs no reconfirmation. If an asset is named without a requested operation, start with a brief read-only assessment.

## Shared boundaries

- Keep edits and generated evidence within the authorized asset and task paths. Do not write memory, host configuration, or global installation state unless requested.
- Keep credentials and settings contents out of output; report paths and redacted evidence.
- Preserve unrelated changes. Use task-private scratch directories and clean only resources created by this task.
- Distinguish inspection, format checks, script execution, and observed Agent behavior in the result. Do not manufacture a PASS from work performed on behalf of the asset-under-test.
- Continue authorized fixes and relevant verification to completion; a new approval is needed only when the next action exceeds that authorization.

## References

Load only the route needed for the current task:

- [Review and focused fixes](references/review-and-fix.md): static findings and canonical skill validation.
- [Behavioral acceptance](references/acceptance.md): real CLI execution, evidence, and cleanup.
- [Asset identification](references/asset-understanding.md): ambiguous asset types or acceptance registration.

The CLI is `scripts/acc.ts`, relative to this skill directory. Its Bun runtime, DB, and round mechanics belong to the behavioral acceptance route; ordinary review does not need them.
