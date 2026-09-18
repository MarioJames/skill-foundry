---
name: changelog-writing
description: 根据发布证据撰写或审查面向用户、工程团队的更新说明；用于编写变更日志、发布说明和工程交接，支持发布流程所需的结构化输出。
---

# Changelog Writing

## Audience and language

Choose the audience before drafting. Production defaults to customer-facing; beta, RC, and nightly default to technical/internal. Follow the user's requested language, then the established release channel, then the conversation language.

Use [audience-routes.md](references/audience-routes.md) for filtering and audience-specific checks. Include only sections that help the reader. If both audiences need artifacts, keep internal evidence separate from public copy.

## Output

For people, write the requested prose or Markdown. For a release workflow or explicitly requested machine format, use [workflow-output.md](references/workflow-output.md), which defines the existing three-field JSON contract. Do not force JSON on an ordinary request to write update notes.

## Source material

Use supplied notes, a concrete Git/PR range, or release evidence. When Git collection is needed, resolve this skill directory and run:

```bash
bun <skill-dir>/scripts/collect-commits.ts --from <previous-tag> --to HEAD
```

The collector also supports `--range v1.0.0..HEAD`, `--auto-beta --to HEAD`, and `--auto-production --to HEAD`. Treat collected commits as evidence; group by meaningful outcome instead of pasting raw lists into customer copy.

Include upgrade actions, compatibility changes, and known risks when relevant. Do not invent a version, source range, verification result, or user impact. Keep credentials, private URLs, hostnames, and internal incident identifiers out of public artifacts.

## Publication tasks

Writing release notes does not authorize publication. When the request also publishes a release, read [release-closure.md](references/release-closure.md) for tag verification and already-authorized follow-through. A git-only submission does not need release metadata.
