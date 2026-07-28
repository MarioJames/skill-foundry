# Persistent operating modes

Runtime modes are persistent state machines compiled onto the same durable Task/dependency graph.
They share one Run, Attempts, scheduling, recovery, and `finish` gates. The graph is an execution
detail; the Orchestrator surface is the collection of recipes plus routing.

| Selected recipe / CLI hint | Persisted `entry_mode` | Required `start_mode.mode` |
| --- | --- | --- |
| `swarm mode`, `--entry-mode swarm` | `swarm` | `swarm` |
| generic `loop mode`, `--entry-mode loop` | `loop` | route to one loop below |
| `develop-review-improve` | `develop_review_improve` | `develop_review_improve` |
| `verification-fix`, `validation-fix` | `verification_fix` | `verification_fix` |
| `multi-agent review`, `--entry-mode review` | `multi_session_review` | `multi_session_review` |
| `RAVF`, `review-argue-vote-fix` | `ravf` | `ravf` |
| `$agents-orchestrator` without a recipe | null | select through `routing.md` |

Natural-language activation does not mutate Runtime state. `init` persists only the routing hint;
the Root submits `submit_estimate` and then the selected `start_mode` Action. The Action is the only
event that creates a mode state machine and compiles Tasks.

Submit an estimate before starting a mode. Every persistent mode compiles child Tasks, so its owner
uses `strategy=split` and receives the `wait` Action. `strategy=direct` is only for a Task that will
not start a persistent mode or create children. Query `action-schema start_mode` and
`action-schema advance_mode`; never infer a payload from these examples alone.

## Contents

- [Evidence propagation](#evidence-propagation)
- [Swarm](#swarm)
- [Develop-review-improve](#develop-review-improve)
- [Verification-fix](#verification-fix)
- [RAVF](#ravf)
- [Composition](#composition)
- [Cancel](#cancel)

## Evidence propagation

Task dependency edges gate scheduling but do not themselves place upstream `result_json` in a
downstream prompt. The mode compiler injects `[MODE CONTEXT]` containing
`assignment.dependency_evidence_bundle` with:

```json
{"sha256":"<hash-of-unabridged-canonical-json>","bytes":1234,"truncated":false,"content":"<bounded canonical JSON>"}
```

The bundle covers base evidence, dependency results, the assigned candidate, and finding
provenance. Content is capped at 12,000 bytes while the hash and byte count describe the full
canonical payload. Oversized input uses a deterministic `sectioned-canonical-json-v1` envelope so
base evidence cannot hide candidate, dependency, or provenance previews. Do not rely on dependency
edges alone or ask a restricted child to recover evidence with general Runtime `inspect`.

## Swarm

Use for substantial parallel work with separable ownership:

```bash
printf '%s' '{"mode":"swarm","objective":"Implement and validate the feature","tasks":[{"key":"implementation","goal":"Implement the scoped feature","intent_hint":"implement","complexity_hint":"medium","model_tier_hint":"balanced","priority":60,"output_contract":"Changed files, validation, and mode_result evidence","constraints":{"write_scope":["src/**"],"read_only":false,"notes":[]},"depends_on":[]},{"key":"tests","goal":"Add independent acceptance tests","intent_hint":"implement","complexity_hint":"medium","model_tier_hint":"balanced","priority":50,"output_contract":"Tests, command output, and mode_result evidence","constraints":{"write_scope":["tests/**"],"read_only":false,"notes":[]},"depends_on":[]}],"config":{"max_tasks":8,"max_seconds":1800},"evidence":{}}' | bun <skill_dir>/scripts/bootstrap.ts action --type start_mode --stdin
```

Each child finishes with normal fields plus
`"mode_result":{"status":"done","evidence":[...]}`. Advance after the Tasks are terminal; the mode
completes only when every compiled Task is done.

## Develop-review-improve

Use when implementation has not yet been produced. The canonical phases are `develop -> validate
-> review -> verify -> improve -> revalidate -> re_review`. Review candidates receive independent
reproduce and falsify Tasks before an improver exists. Only confirmed fingerprints reach the
improver. Every change receives deterministic revalidation and a fresh independent re-review.

```bash
printf '%s' '{"mode":"develop_review_improve","objective":"Implement the change and converge on independent review","config":{"max_rounds":3,"max_tasks":18,"max_seconds":3600,"max_no_progress":2},"evidence":{"request":"<bounded source requirement>"}}' | bun <skill_dir>/scripts/bootstrap.ts action --type start_mode --stdin
```

This recipe blocks when initial deterministic validation fails. Route an existing artifact whose
tests are already failing to `verification_fix` instead.

## Verification-fix

Use `validate -> diagnose -> fix` rounds when deterministic unit tests, browser journeys, or both
are the convergence oracle. A failed validation creates a separate read-only diagnosis Task; the
fixer must address every diagnosed fingerprint. The next round runs validation again. Only a clean
post-fix validation completes the mode.

```bash
printf '%s' '{"mode":"verification_fix","objective":"Run unit and browser validation until the defect set converges","config":{"max_rounds":4,"max_tasks":16,"max_seconds":3600,"max_no_progress":2},"evidence":{"unit_command":"bun test","browser_journey":"<observable Playwright journey>"}}' | bun <skill_dir>/scripts/bootstrap.ts action --type start_mode --stdin
```

Validator results include `stage`, `passed|failed|blocked`, `artifact_version`, commands, and
evidence. Diagnosis results include `root_cause` and standard findings. Fix results include
`changed`, every `addressed_fingerprint`, and evidence. A failed or incomplete fix, time/task
budget, repeated state, or missing clean validation closes with an explicit non-pass outcome.

## RAVF

Use `Review -> Argue -> Vote -> Fix` for reusable or high-risk changes where review findings need
fair value judgment. RAVF is ACP-only:

```bash
printf '%s' '{"mode":"ravf","objective":"Converge the reusable skill without low-value code growth","config":{"max_rounds":3,"max_candidates":25,"max_tasks":120,"max_seconds":5400},"evidence":{"change":"<bounded change evidence>"}}' | bun <skill_dir>/scripts/bootstrap.ts action --type start_mode --stdin
```

RAVF always uses five Reviewers with at most five findings each, so each round's merged
original-Review set has a hard 25-candidate ceiling. The ceiling resets for every fresh Review; it
is not a lifetime cap across the Mode. `argue` and `vote` use fixed odd pools of 3, 5, or 7 Agents and
default to 5, independent of candidate count. Every Arguer challenges the complete Review result
without creating findings. Every `fast` Voter independently chooses `accept_original`,
`accept_revised`, `reject`, or `abstain` per original issue after seeing its Reviewer and all Arguer
evidence. After a strict majority, the Runtime requires the main Agent to integrate every decision;
an Argue-informed revision keeps the original Reviewer fingerprint and provenance. One coordinated
fixer receives exactly the adopted set. Any fix starts a fresh Review round; findings from that
round enter another complete Argue -> Vote -> Fix cycle. Completion requires a clean Review after
the latest fix, while round/task/time/no-progress guards provide explicit non-pass exits. See
[review-consensus.md](review-consensus.md#ravf-convergence) for result contracts.

## Composition

Compose modes from a mode-owned child while its parent remains running. Parent links are inferred;
an explicit `parent_mode_id` must match ownership. Depth guards reject cycles and excessive
nesting. Useful compositions include parallel discovery/implementation through `swarm` followed by
`verification_fix`, and a high-risk delivery followed by `ravf`.

Advance every owned mode through the Runtime. A Task cannot finish done while one of its owned
modes is blocked, failed, or still running.

## Cancel

Cancellation is explicit and bounded:

```bash
printf '%s' '{"mode_id":<mode_id>,"operation":"cancel","reason":"user stopped the mode"}' | bun <skill_dir>/scripts/bootstrap.ts action --type advance_mode --stdin
```
