---
name: trigger-build-workflow
description: 在用户授权范围内提交、推送代码，或触发 GitHub Actions 构建与发布。本地打包不触发本技能。
---

# Trigger Build Workflow

```bash
bun <skill-dir>/scripts/dispatch-build-workflow.ts --repo <repo-path> <action-flags> [options]
```

`--help` lists every option. The script runs the selected actions in the order commit, push, dispatch, and never adds one implicitly.

## Choose authorized actions

Decide the actions from the current request and existing authorization before inspecting workflows. A compatible workflow is a capability, never permission to build or publish.

| Request | Flags |
| --- | --- |
| Commit locally | `--commit` |
| Push existing commits | `--push`; it does not stage or commit |
| Commit and push | `--commit --push` |
| Explicit GitHub Actions build or release | `--dispatch`, plus `--commit` and `--push` only when those are also authorized |
| Local packaging | The project's local build command, not this skill |

- Dispatch alone builds the existing remote branch, even when local changes or commits differ.
- Do not infer push or dispatch from a version, a changelog, a compatible workflow or a request to submit code. Already authorized actions need no repeated confirmation. Ask only when it stays unclear, after reading the task context and project commands, whether "build" or "package" means local or remote.
- When merge and release are authorized, pass the repository's merge gate, verify that the remote target branch contains the merged content, then release.
- A push can still trigger the repository's own `on: push` workflows.

## Commit and push

- Inspect `git status --short` and pass one `--path` per task-owned file or area; unrelated staged changes stay in the index. Omit `--path` only when every local change is in scope: that selects `git add -A`.
- Push sends the current `HEAD` to `refs/heads/<branch>` on `--remote` (defaults: `origin`, the current branch). `--branch` is a destination, not a different local source. A detached HEAD needs an explicit destination.
- Without `--push`, dispatch builds what the remote branch already has; local commits are not uploaded.

## Dispatch

1. Confirm the target repository, remote branch and source commit by the project's release process. "Latest" without a named commit means the tip of the target remote branch.
2. If an artifact for that commit exists, verify the release record, that the artifact is usable, and its source SHA. If a run for it is in progress, follow it to completion. Otherwise dispatch, wait, and verify the same way.
3. Run the detector first: `bun <skill-dir>/scripts/detect-build-workflow.ts --repo <repo-path>`. `compatible: false` (missing, incompatible or ambiguous workflow) makes dispatch fail before any git change; choose one with `--workflow <file>` when ambiguous. Detection is local, so the workflow must be committed on the branch being built.
4. Channel: `X.Y.Z` or `vX.Y.Z` is production; no version or non-semver text is beta, and the `version` input is omitted. `--environment` overrides this, and `production` requires semver.
5. Changelog: use changelog-writing's technical route for beta and its customer-facing route for production, and pass the JSON with `--changelog-json-file`.
6. When the workflow is blocked, read its logs and the repository's existing recovery path. If it stays blocked, report the target SHA, the failing step and the actual state.

## Verify and report

- `--dry-run` validates local inputs without touching the index, the remote or gh. `--no-watch` skips waiting but still locates the run.
- Report the actions performed and skipped, the commit SHA and branch, and the remote and ref when pushed. For dispatch, add the target repository, branch and SHA, the workflow, the run URL and the final conclusion.
- A failure stops later actions; earlier ones are not rolled back. If dispatch succeeded but finding or watching the run failed, inspect that run before retrying, to avoid a duplicate release.
