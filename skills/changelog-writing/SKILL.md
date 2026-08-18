---
name: changelog-writing
description: Draft, revise, or review changelogs, release notes, version notes, GitHub Release bodies, beta/production notes, customer-facing update copy, and technical release summaries. Use whenever release changes must be routed to a customer or engineering audience and formatted for people or workflow inputs.
---

# Changelog Writing

## Choose the audience route

Choose the audience before drafting. `production` defaults to customer-facing; `beta`, `rc`, and nightly default to technical/internal. Do not combine customer copy and internal evidence unless the user explicitly requests two artifacts.

Write changelogs in English by default. Follow an existing release channel's language when one is clearly established, or use another language when requested.

Read [references/audience-routes.md](references/audience-routes.md) for filtering, tone, and route-specific checks.

## Output contract

Unless the user asks for prose only, output one JSON object with these exact string fields:

```json
{
  "changelog": "<complete artifact for legacy single-field consumers>",
  "changelog_summary": "<single-line release summary>",
  "changelog_content": "<full release body>"
}
```

Do not wrap machine-consumed JSON in a Markdown fence.

- `changelog`: include summary and body as one coherent artifact.
- `changelog_summary`: one short sentence following the summary format below.
- `changelog_content`: concise route-appropriate bullets or sections. Exclude raw CI logs and unrelated implementation evidence.

## Summary format

Use:

```text
Version x.y.z, <most important change summary>
```

Omit a leading `v` in summary prose unless the release channel requires it. For production, summarize the most important user-visible outcome. For beta/internal notes, summarize the most important technical or operational change.

Keep customer summaries short enough for compact dialogs. Prefer outcome language over inventory and vary the verb to fit the actual value.

## Collect git source material

Resolve this skill's directory from the loaded `SKILL.md`, then run:

```bash
<skill-dir>/scripts/collect-commits.ts --from <previous-tag> --to HEAD
```

Useful variants:

```bash
<skill-dir>/scripts/collect-commits.ts --range v1.0.0..HEAD
<skill-dir>/scripts/collect-commits.ts --auto-beta --to HEAD
<skill-dir>/scripts/collect-commits.ts --auto-production --to HEAD
```

Treat the output as source material. Do not paste raw commit lists into customer-facing copy.

## Drafting workflow

1. Determine environment and audience route.
2. Gather user notes, a concrete git/tag range, PRs/issues, release runs, or deployment evidence.
3. Cluster customer-facing changes by visible capability, improvement, fix, or upgrade impact; cluster internal changes by subsystem, risk, operations, verification, and rollback.
4. Remove noise that does not matter to the chosen audience.
5. Write concise bullets with concrete outcomes.
6. Build the JSON object.
7. Apply the route-specific quick check in [references/audience-routes.md](references/audience-routes.md).

## Release closure

When the task also publishes a release, verify that a tag points at the release commit so the next changelog has a clean range. Read [references/release-closure.md](references/release-closure.md) before creating or pushing a tag.

## Gotchas

- Do not make a production GitHub Release read like an engineering handoff.
- Do not hide rollback, migration, compatibility, or known-risk facts in internal notes.
- Do not invent a version, source range, test result, or customer impact.
- Do not include internal repository names, hostnames, credentials, incident identifiers, or private URLs in public release copy.
- Do not force release semantics onto a git-only submission when the target repository has no compatible release workflow.
