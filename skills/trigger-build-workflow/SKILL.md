---
name: trigger-build-workflow
description: Commit local changes and push the current branch, optionally dispatching a compatible GitHub Actions build or release workflow. Use when the user asks to submit code, commit and push changes, trigger a build, package an artifact, publish a beta build, or release a production version. Repositories without the expected release workflow contract automatically use a git-only path.
---

# Trigger Build Workflow

## Core workflow

Resolve this skill's directory from the loaded `SKILL.md`, then run the detector before drafting release metadata:

```bash
bun <skill-dir>/scripts/detect-build-workflow.ts --repo <repo-path>
```

Read its JSON `mode`:

- `git-only`: do not invoke changelog-writing, infer a release channel, or ask for version metadata. Run the dispatch script with the requested commit scope; it stages, commits, and pushes, then reports `dispatch=skipped`.
- `dispatch`: choose beta or production metadata, draft the matching changelog, then run the dispatch script. The script repeats detection before making changes, so a stale or incompatible workflow cannot be dispatched accidentally.

Use the bundled script for the mechanical path:

```bash
bun <skill-dir>/scripts/dispatch-build-workflow.ts --repo <repo-path> [options]
```

## Commit scope

- Inspect `git status --short` and preserve unrelated user changes.
- With no extra scope instruction, pass explicit `--path <path>` arguments for only the changes owned by the current task.
- When the user explicitly requests all local changes, use the default `git add -A` behavior by omitting `--path`.
- When the user names a feature, area, or file set, pass one `--path` per requested path.
- Ask only when the requested scope remains materially ambiguous after inspecting the worktree.

## Compatible workflow contract

The detector scans local `.github/workflows/*.yml` and `*.yaml` files. A compatible workflow must have:

- `workflow_dispatch`;
- an `environment` or `channel` input;
- a `version` input;
- one of `changelog`, `changelog_content`, or `changelogContent`.

It prefers `package-orchestrator.yml` / `.yaml`, selects a single other compatible workflow, and returns `git-only` when none is compatible. If several compatible workflows remain ambiguous, pass an explicit `--workflow <file>` or keep the safe git-only result.

Missing directories, missing files, unrelated workflows, missing inputs, and unsupported changelog shapes are normal git-only outcomes, not errors.

## Release routing

Apply these rules only when detection returns `dispatch`:

- No version, empty version, or non-semver text means `beta`.
- Beta omits the `version` dispatch value so the workflow can generate it.
- `X.Y.Z` or `vX.Y.Z` means `production`.
- Explicit `--environment production` requires a semver version.
- Explicit `--environment beta` always uses beta behavior.

For beta, use changelog-writing's technical/internal route. For production, use its customer-facing route. Prefer the JSON output and pass it with `--changelog-json-file` or `--changelog-json`.

## Examples

Submit selected files; this works with or without a compatible workflow:

```bash
bun <skill-dir>/scripts/dispatch-build-workflow.ts \
  --repo . \
  --message 'fix: handle empty configuration' \
  --path src/config.ts \
  --path test/config.test.ts
```

Beta build after the detector reports `dispatch`:

```bash
bun <skill-dir>/scripts/dispatch-build-workflow.ts \
  --repo . \
  --changelog-json-file <temporary-changelog.json>
```

Production release:

```bash
bun <skill-dir>/scripts/dispatch-build-workflow.ts \
  --repo . \
  --version 1.2.3 \
  --changelog-json-file <temporary-changelog.json>
```

## Reporting

Always report the commit SHA, branch, pushed remote/ref, workflow mode, and skip reason when git-only. For dispatched builds, also report workflow name, run URL, watch status, and final conclusion when watched.

## Gotchas

- Do not draft a changelog before detection; ordinary repositories should not be forced into release semantics.
- Do not treat the presence of any workflow file as compatibility. Validate the complete input contract.
- Do not choose arbitrarily among multiple compatible non-default workflows.
- `--dry-run` does not authenticate, commit, push, or dispatch; use it for fixture and scope verification.
- Workflow detection is intentionally local. A remote-only workflow is not enough because dispatching a workflow absent from the branch being pushed is unsafe.
