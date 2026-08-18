# Audience routes

## Customer-facing route

Use for production, stable and official releases, customer-visible GitHub Releases, product UI, upgrade prompts, customer documentation, and public artifact notes.

Write for outcomes and user impact. Keep implementation details out unless they explain a visible behavior or required upgrade action.

Preferred sections:

- `Overview`: what the release improves.
- `New Features`: capabilities users can notice or use.
- `Improvements`: usability, accessibility, workflow, visual, or performance gains.
- `Fixes`: visible bugs, reliability, and compatibility fixes.
- `Upgrade Notes`: include only when users must act, expect downtime, or handle a compatibility change.

Exclude by default:

- commit hashes, raw commit lists, branch names, tag ranges, workflow run IDs, and internal issue IDs;
- standalone documentation/test sections unless those are shipped product surfaces;
- refactor details, helper extraction, naming cleanup, linting, fixtures, and internal module boundaries;
- CI/release pipeline mechanics unless they change installation or upgrade behavior;
- private repository, host, customer, incident, or infrastructure identifiers.

Translate technical work into visible meaning. For example, “restore the health endpoint used by probes” becomes “Improved compatibility with runtime health checks and external monitoring.” Omit a directory-guard test that has no direct user impact.

Customer-facing quick check:

- Every bullet answers what users can see or what administrators must know.
- The summary explains why upgrading matters and fits a compact dialog.
- No private identifiers, implementation-only evidence, or raw commit metadata remains.
- Upgrade notes exist only for concrete customer action or operational impact.

## Technical/internal route

Use for beta, RC, nightly, pre-release, engineering handoff, QA, deployment notes, rollback plans, and incident follow-up.

Write for traceability and operation. Include when useful:

- exact source range and selected commit highlights;
- affected modules, workflows, APIs, migrations, configuration, or infrastructure;
- verification commands and results;
- deployment, rollback, compatibility, data migration, and operational risks;
- known gaps, monitoring, and follow-up work.

Preferred sections:

- `Scope`
- `Changes`
- `Fixes`
- `Operational Impact`
- `Verification`
- `Risks / Follow-ups`
- `Commits` only when the audience needs them

Technical/internal quick check:

- Scope and source range are concrete.
- Verification is evidence-backed and uncertainty is explicit.
- Rollback-relevant details and known risks remain visible.
- Secrets and credential-bearing command output are redacted even for internal notes.

## Dual-audience release

When one release needs both audiences:

1. Write the customer-facing artifact.
2. Write a separate internal note with range, verification, run evidence, and risks.
3. Keep the internal note out of customer-visible surfaces.
