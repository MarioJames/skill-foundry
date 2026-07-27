# Multi-Agent review consensus

`multi_session_review` is an ACP-only persistent mode. It uses at least three independent reviewer
Sessions, then assigns two different verifier Tasks per candidate finding: one attempts to
reproduce it and one attempts to falsify it. The finding proposer cannot verify its own candidate.

## Consensus rules

- Normalize findings from `rule`, `title`, `description`, `claim`, `location`, `impact`, and
  `confidence`; the Runtime owns the stable fingerprint and retains severity, evidence, and
  provenance separately. New reviewer/verifier finish payloads must provide non-empty `claim` and
  `impact` plus numeric `confidence` in `0..1`.
- Confirm only when both independent verifiers report `confirmed`; reject only when both report
  `rejected`; mixed or incomplete verdicts are `unresolved`.
- Block on unresolved high/critical candidates or high/critical candidate-budget overflow.
- Optionally compile one scoped fixer per confirmed finding. Never fix rejected or unresolved
  candidates.
- Bound `max_candidates`, `max_expansions`, `max_tasks`, `max_seconds`, nesting depth, and repeated
  no-progress states. Runtime lifecycle gates do not prove that an Agent's evidence is true.

Every reviewer and verifier receives the mode compiler's bounded, hashed dependency evidence. This
is the consensus input; task dependencies alone are not evidence transport. Oversized evidence
uses the sectioned serialization contract documented in [Persistent operating modes](operating-modes.md#evidence-propagation),
which reserves separate candidate, dependency, and provenance previews before base evidence.

## Multi-Agent plan review

Start the Run with the ACP profile(s) needed by the review, then submit an estimate (normally split
so the owner can `wait`). This Action starts three independent reviewer Sessions over one frozen
plan evidence object:

```bash
bun <skill_dir>/scripts/bootstrap.ts init --task "<review goal>" --cwd "$(pwd)" \
  --profile-allowlist-json '["codex","claude"]' --default-profile codex \
  --entry-mode review
```

```bash
printf '%s' '{"mode":"multi_session_review","objective":"Review the plan for correctness, feasibility, and operational risk","config":{"reviewers":[{"id":"correctness","profile_hint":"codex"},{"id":"feasibility","profile_hint":"codex"},{"id":"risk","profile_hint":"codex"}],"max_candidates":30,"max_expansions":6,"max_tasks":50,"max_seconds":3600,"create_fix_tasks":false},"evidence":{"kind":"plan","sha256":"<sha256-of-full-plan>","content":"<bounded plan content>"}}' | bun <skill_dir>/scripts/bootstrap.ts action --type start_mode --stdin
```

Each optional `profile_hint` is a name frozen in the Run's ACP profile allowlist. Reusing one
profile still creates independent Sessions; omit hints to use deterministic Runtime routing.

Reviewers finish with normal fields plus findings:

```json
{
  "mode_result": {
    "findings": [
      {
        "rule": "rollback",
        "title": "Rollback criteria are missing",
        "description": "The rollout has no measurable rollback threshold.",
        "claim": "The plan cannot make a deterministic rollback decision.",
        "location": "Rollout section",
        "severity": "high",
        "evidence": ["The plan defines monitoring but no threshold."],
        "impact": "An unsafe rollout may continue after its acceptable failure boundary.",
        "confidence": 0.95
      }
    ]
  }
}
```

Because reviewer and verifier Tasks have `intent=review`, the same `finish` payload must also carry
the ordinary structured `review` object (`pass|changes_requested|blocked`, `"source":"self"`, and a
findings array). The Runtime accepts `self` only from the current review Task; an integer source
must identify another done review Task in the same Run. A Task with `read_only=true`, or any Task
resolved to review intent, cannot finish done with non-empty `changed_files`. `mode_result` drives
mode consensus; `review` satisfies the base review gate.

After every returned Task batch becomes terminal, the owner submits `advance_mode`. The Runtime
records candidates, compiles independent reproduce/falsify verifiers, adjudicates them, optionally
compiles fixers, and returns either the next Task IDs or a terminal mode status:

```bash
printf '%s' '{"mode_id":<mode_id>,"operation":"advance","reason":"current phase terminal"}' | bun <skill_dir>/scripts/bootstrap.ts action --type advance_mode --stdin
```

A terminal response includes top-level `verdict` (`pass|changes_requested|blocked`) and a
machine-readable `consensus` object containing the reviewed evidence bundle, confirmed/rejected/
unresolved findings, reviewer/verifier provenance, quorum evidence, and revision input. Lifecycle
`status=completed` means the protocol finished; it does not imply `verdict=pass`.
Any blocked, failed, or cancelled lifecycle returns `verdict=blocked`; an incomplete protocol can
never report a passing consensus.

Verifier `mode_result` includes the assigned `candidate_fingerprint`, a
`confirmed|rejected|unresolved` verdict, non-empty evidence, and optional newly discovered findings.
New candidates are expanded only within the configured bounds.
