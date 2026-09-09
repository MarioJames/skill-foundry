---
name: cow-workspace
description: Create, inspect, export, and remove copy-on-write Git workspaces for local development or parallel agents on Linux. Use when worktrees duplicate source or dependencies, or when isolated edits should reuse a prepared environment. Agent and terminal routing stays with Herdr.
---

# CoW Workspace

Use one prepared, fixed source-and-dependency baseline and give each task its own writable view. Reuse unchanged files; keep edits, Git state, and build output local to that view. This is filesystem isolation, not a process, network, or security sandbox.

## Prepare once, create as needed

Run the bundled CLI with Bun. It requires Linux, Git, `flock`, `fuse-overlayfs`, `fusermount3`, and usable `/dev/fuse`. The CLI checks actual mounting; it never installs tools or silently falls back to a full copy per workspace.

```bash
bun <skill-dir>/scripts/cow.ts prepare --repo <repo> --id <baseline-id>
bun <skill-dir>/scripts/cow.ts create --base <baseline-id> --id <task-id>
```

`prepare` makes **one ordinary copy per baseline** on filesystems without native reflinks. It takes committed source from the repository's current HEAD, copies ignored root `node_modules` if present, and links the repository's `.env` as shared configuration. Include other prepared dependency directories with repeated `--include <repo-relative-path>`; use `--env-file <path>` for another public configuration file. Keep the source and included directories idle during preparation. Dirty or untracked source, submodules, and symlinks escaping the baseline (except the deliberate `.env` link) are rejected instead of producing a misleading snapshot.

The baseline has its own complete `.git` directory. It does not borrow a worktree's Git administration files or an external object store. Once prepared, do not edit it directly; prepare a new baseline after changing source or dependencies. Baselines stay available until explicitly removed.

`create` returns `cwd`, the working directory to give the Agent or dev server. Internally `fuse-overlayfs` supplies lower/upper/work/merged; callers need only the baseline and task IDs. Repeating `create` with the same IDs reuses a mounted view or remounts its retained writes after interruption. Storage defaults to `~/.local/share/cow-workspace`, not `/tmp`; `--root <path>` selects another location. Keep the store outside source repositories. Use `--fuse-overlayfs <executable>` if the executable is not on PATH.

## Work in the returned directory

- Put task-specific environment differences in `.env.local`; use the project's existing loader and dev commands. The shared `.env` is deliberately outside CoW: edit local overrides, not its shared target. Existing process environment and framework-specific precedence still apply.
- Install or rebuild inside `cwd` only when the task needs it. New files and copy-up data consume real storage; CoW does not make builds free. Do not write directly to the baseline or upper directory.
- Give concurrent servers distinct ports. Database, Redis, and object-store writes follow the project's existing isolation conventions; the filesystem mount does not isolate those services.
- Commit task changes normally inside the view. Each new workspace starts on its own `cow/<task-id>` branch; remounting preserves its Git state. No remote is configured automatically.

When using Herdr, pass the returned `cwd` to its existing lane router and follow Herdr's naming, ownership, and cleanup rules. Keep the CLI resource lifecycle separate from terminal routing; closing a pane does not remove its workspace.

## Export before removing

```bash
bun <skill-dir>/scripts/cow.ts export --id <task-id> --output <outside-store>/task.bundle
git -C <destination-repo> fetch <outside-store>/task.bundle HEAD
# Inspect FETCH_HEAD, then integrate with the project's normal Git workflow.
bun <skill-dir>/scripts/cow.ts remove --id <task-id>
bun <skill-dir>/scripts/cow.ts remove-base --id <baseline-id>
```

Export produces a verified Git bundle of commits since the baseline, including binary changes. It requires a clean source worktree and refuses overwriting an output file. Review and integrate the commits in the destination repository; exported commits are not automatically merged or pushed.

Stop task-owned servers and Agents and run removal from outside their working directory. Removal protects uncommitted source and commits not covered by an intact export; it unmounts normally and checks for remaining mounts before deleting anything. Ignored configuration, dependencies, and build output are temporary and are not exported. Use `--discard` only when discarding the workspace's changes is authorized. A busy or failed unmount leaves the workspace intact; do not force/lazy-unmount or broaden cleanup. Baseline removal refuses while any workspace, mounted or not, still references it.

Inspect retained resources with `list` or `status --id <task-id>`. Mutations are serialized with `flock`; if another operation holds the lock, wait for it rather than deleting lock/state files.

## Verification

```bash
bun <skill-dir>/scripts/cow.ts --help
bun test <skill-dir>/tests
```

The lifecycle tests use real Git repositories and FUSE mounts, including sibling isolation, deletions, binary export/import, remount, and guarded cleanup. They require the runtime dependencies above; set `COW_TEST_FUSE_OVERLAYFS` to an alternate executable. They fail when mounting is unavailable rather than reporting a simulated pass.
