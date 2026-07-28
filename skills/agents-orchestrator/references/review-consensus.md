# Independent review consensus

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

## RAVF convergence

`ravf` is a separate ACP-only loop for changes that need both broad issue discovery and
cost-sensitive adjudication. It has these hard boundaries:

- Exactly five independent Reviewers, with at most five material findings each.
- The merged Review candidate set is capped at 25 original findings.
- `argue` and `vote` each use one fixed odd pool of 3, 5, or 7 Agents, defaulting to 5. Pool size is
  independent of finding count, so 25 findings still compile only five Arguer Tasks and five Voter
  Tasks.
- Each phase pool is compiled atomically once. Repeated `advance_mode` calls cannot create another
  batch for the same phase.

The original Reviewer finding is immutable and remains the source of every later decision. Argue
may challenge or propose a correction, but it cannot add a finding or replace its provenance.

| Stage | Per-finding state | Meaning |
| --- | --- | --- |
| Review | `candidate` | Immutable original finding plus all Reviewer provenance. |
| Argue | `review_stands` | The challenge did not overturn the original finding. |
| Argue | `review_rebutted` | Evidence supports rejecting the original finding. |
| Argue | `review_needs_revision` | The issue is real, but its wording, scope, severity, impact, or evidence needs correction. |
| Argue | `uncertain` | The Arguer cannot resolve the challenge from available evidence. |
| Vote | `accept_original` | Fix the original Reviewer finding as written. |
| Vote | `accept_revised` | Fix an Argue-informed revision while retaining the original source fingerprint. |
| Vote | `reject` / `abstain` | Reject the Reviewer finding or withhold a vote. |
| Main integration | `accept_original` / `accept_revised` / `reject` | Produce the final adopted set under the voter-majority constraints. |

Every Arguer receives the complete normalized Review result and all Reviewer provenance, then
covers every candidate exactly once:

```json
{
  "mode_result": {
    "arguments": [
      {
        "candidate_fingerprint": "finding_...",
        "challenge_outcome": "review_needs_revision",
        "rationale": "The defect is real, but the original scope and severity are overstated.",
        "roi": "positive",
        "bloat_risk": "low",
        "evidence": ["Reproduction and bounded fix estimate"],
        "proposed_revision": {
          "rule": "trigger",
          "title": "Trigger lacks an orchestration-signal guard",
          "description": "Ordinary reviews can activate orchestration when no orchestration signal exists.",
          "claim": "Activation is broader than the documented boundary.",
          "location": "SKILL.md:3",
          "severity": "medium",
          "evidence": ["ordinary review request activates the skill"],
          "impact": "Some requests launch unnecessary Agents.",
          "confidence": 0.9
        }
      }
    ]
  }
}
```

`proposed_revision` is required only for `review_needs_revision`. It is a correction attached to the
original fingerprint, never a new candidate. Argue judges both truth and fix value: a technically
accurate observation may still be rebutted when its benefit is negligible or its requested change
creates disproportionate code growth.

Every Voter receives the original Review candidates and all Arguer results. Each low-cost Voter
runs with `model_tier_hint=fast`, judges every issue independently, and returns one ballot per
candidate:

```json
{
  "mode_result": {
    "ballots": [
      {
        "candidate_fingerprint": "finding_...",
        "decision": "accept_revised",
        "rationale": "The issue has positive value after narrowing its scope.",
        "expected_value": "high",
        "evidence": ["Reviewer evidence and the cited correction are consistent"],
        "revision_basis_task_ids": [42]
      }
    ]
  }
}
```

`accept_revised` must cite Arguer Task ids that supplied a correction for that same candidate. The
Runtime counts `accept_original + accept_revised` as acceptance votes. Acceptance or rejection
requires a strict majority of the configured Voter pool; ties and abstention-heavy outcomes block.

After ballots complete, the first owner `advance_mode` returns `integration_required=true` with the
complete decision dossier. The main Agent must then submit exactly one integration decision per
original candidate:

```json
{
  "mode_id": 7,
  "ravf_integration": {
    "decisions": [
      {
        "candidate_fingerprint": "finding_...",
        "disposition": "accept_revised",
        "rationale": "The voter majority accepted the issue and supported a narrower correction.",
        "revised_finding": {"rule": "...", "title": "...", "description": "...", "claim": "...", "location": "...", "severity": "medium", "evidence": ["..."], "impact": "...", "confidence": 0.9},
        "revision_basis_task_ids": [42]
      }
    ]
  }
}
```

The main Agent cannot override a reject majority or adopt an unresolved issue. It may choose
`accept_revised` only when at least one Voter supported revision and every cited basis is both an
Arguer correction and Voter-cited. The Runtime stores `source_fingerprint`, immutable
`original_review`, the full argument and ballot record, the integration rationale, and the final
`adopted_finding` together.

The successful integration returns one `integrated_decision` and launches one coordinated fixer
with exactly the approved adopted findings. Rejected, unresolved, and unrelated work is forbidden.
After the fix, a new five-Reviewer round begins. Old fixed findings remain in history; if
rediscovered they reopen as current candidates. RAVF passes only when a fresh post-fix Review
produces no findings.
