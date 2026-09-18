---
name: trigger-build-workflow
description: 在用户授权范围内提交、推送代码，或触发 GitHub Actions 构建与发布。本地打包不触发本技能。
---

# Trigger Build Workflow

## Choose authorized actions

Determine the operations from the current request and existing authorization before inspecting workflows. A compatible workflow is a capability, never permission to build or publish.

- Local submission/commit: `--commit` only.
- Push existing commits: `--push` only. It does not stage or commit local changes.
- Commit and push: `--commit --push`.
- Explicit GitHub Actions build/release: `--dispatch`. Add `--commit` and/or `--push` only when those operations are also authorized. Dispatch alone builds the existing remote branch, including when local changes or commits differ.
- Local packaging: use the project's local build command; do not invoke this skill.

If “build/package” is ambiguous, inspect the task context and project commands; clarify only if the intended local or remote operation remains unclear. Already authorized actions need no repeated confirmation. Do not infer push or dispatch from a version, changelog, compatible workflow, or a request to submit code. A push can still activate the repository's own `on: push` workflows.

Resolve `<skill-dir>` from this loaded `SKILL.md`:

```bash
bun <skill-dir>/scripts/dispatch-build-workflow.ts --repo <repo-path> <action-flags> [options]
```

The script requires at least one of `--commit`, `--push`, `--dispatch`, executes selected actions in that order, and never supplies an implicit action. Commit options require `--commit`; workflow/release options require `--dispatch`.

## Commit scope and destination

Inspect `git status --short` and pass one `--path <path>` per task-owned file or area. Scoped commits exclude unrelated pre-staged changes and preserve them in the index. Omit `--path` only when all local changes are explicitly in scope; that selects `git add -A`. Ask only if ownership remains materially ambiguous after inspection.

`--remote` defaults to `origin`; `--branch` defaults to the current branch. Push always sends current `HEAD` to `refs/heads/<branch>` on that remote; `--branch` is a destination, not a different local source branch. Existing upstream settings do not override these values. Detached HEAD needs an explicit destination for push/dispatch. Commit alone needs neither a remote nor a workflow.

Dispatch and run monitoring use the selected remote's single push URL to resolve the GitHub repository, including when the fetch URL or gh's default repository differs. Without push, the script checks the destination remote branch and tracks its SHA. It does not upload local commits automatically.

## Dispatch preflight and metadata

Only for an authorized dispatch, run the detector before drafting release metadata:

```bash
bun <skill-dir>/scripts/detect-build-workflow.ts --repo <repo-path>
```

The JSON `compatible` boolean reports capability only. Detection scans local `.github/workflows/*.yml` and `*.yaml` for `workflow_dispatch`, an `environment` or `channel` input, `version`, and one of `changelog`, `changelog_content`, or `changelogContent`. It prefers `package-orchestrator.yml` / `.yaml`, otherwise requires a single compatible workflow. Resolve ambiguity with `--workflow <file>`; files outside that directory are invalid candidates.

Missing, incompatible, or ambiguous workflows produce `compatible: false` from the detector. Explicit dispatch then fails clearly before staging, committing, pushing, or dispatching; it never silently degrades into a Git operation. Without `--dispatch`, the script does not detect workflows or require release metadata.

The script rechecks local compatibility, release inputs, and destination configuration before mutations. Non-dry dispatch also checks gh authentication; it never logs in automatically. Detection is local: ensure the selected workflow is committed on the branch to build (or included in the authorized commit/push). Local detection cannot prove the server's workflow availability, permissions, or concurrent branch state; remote dispatch failures are reported.

Route release metadata only for dispatch:

- No version, empty version, or non-semver text selects beta. Omit the dispatch `version` field so the workflow generates it.
- `X.Y.Z` or `vX.Y.Z` selects production.
- `--environment production` requires that semver format; `--environment beta` always selects beta and omits version.

Use changelog-writing's technical/internal route for beta and customer-facing route for production. Pass its JSON via `--changelog-json-file` or `--changelog-json`, with `changelog`, `changelog_summary`, and `changelog_content`. The script maps the full text or content/summary to the detected inputs. For remaining input options, run the script with `--help`.

## Examples

Commit selected files locally:

```bash
bun <skill-dir>/scripts/dispatch-build-workflow.ts \
  --repo . --commit \
  --message 'fix: handle empty configuration' \
  --path src/config.ts --path tests/config.test.ts
```

Push current HEAD without committing or explicitly dispatching a workflow:

```bash
bun <skill-dir>/scripts/dispatch-build-workflow.ts --repo . --push
```

Commit and push selected changes:

```bash
bun <skill-dir>/scripts/dispatch-build-workflow.ts \
  --repo . --commit --push --path src/config.ts --message 'fix: handle empty configuration'
```

Build the already-published remote branch as beta:

```bash
bun <skill-dir>/scripts/dispatch-build-workflow.ts \
  --repo . --dispatch --changelog-json-file <temporary-changelog.json>
```

When committing, pushing, and production release are all authorized:

```bash
bun <skill-dir>/scripts/dispatch-build-workflow.ts \
  --repo . --commit --push --dispatch --path src/config.ts \
  --version 1.2.3 --changelog-json-file <temporary-changelog.json>
```

## Verification and reporting

`--dry-run` prints only selected actions and validates local inputs without modifying the index, committing, pushing, authenticating, or dispatching. It does not contact the remote to verify its branch or permissions. `--no-watch` skips waiting for completion but still locates and reports the dispatched run.

Report performed/skipped actions, local commit SHA and branch, and the remote/ref when push was selected. For dispatch, include target repository/branch/SHA, workflow, run URL, watch status and final conclusion when watched. Failures stop subsequent actions; successful earlier actions are not rolled back. If dispatch succeeded but run discovery/watch failed, inspect that run before retrying to avoid duplicate releases.
