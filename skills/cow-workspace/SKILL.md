---
name: cow-workspace
description: 在 Linux 上创建、检查、导出和回收写时复制 Git 工作区。用于工作树重复占用源码或依赖，或隔离编辑需要复用已准备环境的场景；Agent 与终端调度交由 Herdr。
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

- Put task-specific environment differences in `.env.local` only where the project's loader supports it; otherwise use its existing equivalent override. Verify application, migration and test loaders separately, including process environment and migration-specific connections. The shared `.env` is deliberately outside CoW: edit local overrides, not its shared target. Follow the project's permitted environment-access mechanism; do not print credentials.
- Install or rebuild inside `cwd` only when the task needs it. New files and copy-up data consume real storage; CoW does not make builds free. Do not write directly to the baseline or upper directory.
- Give concurrent servers distinct ports. Database, Redis, and object-store writes follow the project's existing isolation conventions; the filesystem mount does not isolate those services.
- Commit task changes normally inside the view. Each new workspace starts on its own `cow/<task-id>` branch; remounting preserves its Git state. No remote is configured automatically.

When using Herdr, pass the returned `cwd` to its existing lane router and follow Herdr's naming, ownership, and cleanup rules. Keep the CLI resource lifecycle separate from terminal routing; closing a pane does not remove its workspace.

## Data ownership and lifetime

Databases are persistent by default. Existing development databases and databases first initialized for continued project use retain their data and migration history. A task ending, a passing acceptance run, or removal of a workspace does not authorize clearing tables, dropping databases, deleting volumes, or resetting migration history.

- Before writes, identify each affected database or storage namespace and its owner, intended lifetime, configuration source, and retention needs. Keep this in existing private task/handoff records outside the workspace being removed; do not create another registry or commit credentials. A database name, local address, container, `.env.local`, or parallel Agent is not evidence that data is disposable.
- Isolate actual write conflicts and destructive tests using the project's existing database/schema/namespace conventions. Do not duplicate every dependency. Overriding the application's primary connection does not isolate its migration connection, another business database, background workers, Redis, or object storage. Read test setup/reset/teardown before running it against any reused service; a test command may delete all data through the normal application connection.
- A temporary database may be reclaimed automatically only when creation evidence identifies it as this task's isolated, disposable resource (including an explicit child-Agent handoff), validation and handoff that need its state are complete, and no integration, user review, debugging or follow-up depends on it. Retain useful failure state; reproducible disposable tests may clean up after sufficient diagnostics are saved. Record the owner and release condition for retained temporary resources, then reclaim precisely when that condition is met. Unknown ownership means retain. Clearing persistent data requires explicit user authorization for the target and impact; do not ask again when already authorized.
- Keep fresh-install and historical-upgrade checks separate. Run repeat-migration checks on the same continuous state without clearing data or migration records between runs. Use a consistent database copy for destructive upgrade verification when needed; preserve the original development database. Test fixtures in a shared database may be removed only by exact ownership with no collateral or cascading effects.
- Store persistent database files, SQLite/PGlite directories, required private configuration and container bind mounts outside disposable workspaces and baselines. `--include` is for prepared dependencies, not live database directories. For data already inside a workspace, use the database's supported consistent backup/relocation process and verify recovery and reconnection before removal; copying live database files or exporting a Git bundle is not a database backup.
- Reclaim only the verified task-owned database, schema, directory or volume. Do not delete a shared instance, use broad volume pruning/`docker compose down -v`, or clear a shared Redis/object store as workspace cleanup. Check logical ownership and handoff needs as well as active users; absence of open connections alone does not establish disposability. Stop only task-owned processes; data retention does not require keeping services running.

## Export before removing

```bash
bun <skill-dir>/scripts/cow.ts export --id <task-id> --output <outside-store>/task.bundle
git -C <destination-repo> fetch <outside-store>/task.bundle HEAD
# Inspect FETCH_HEAD, then integrate with the project's normal Git workflow.
bun <skill-dir>/scripts/cow.ts remove --id <task-id>
bun <skill-dir>/scripts/cow.ts remove-base --id <baseline-id>
```

Export produces a verified Git bundle of commits since the baseline, including binary changes. It requires a clean source worktree and refuses overwriting an output file. Review and integrate the commits in the destination repository; exported commits are not automatically merged or pushed.

Before calling `remove`, complete the data-lifetime checks above and preserve required ignored data/configuration outside the removal scope. The CLI checks Git and mounts, not database ownership or recoverability: ignored files are not exported and are deleted with the workspace. Report process cleanup separately from data retention/reclamation, including retained resources' owner and release condition.

Stop task-owned servers and Agents and run removal from outside their working directory. Removal protects uncommitted source and commits not covered by an intact export; it unmounts normally and checks for remaining mounts before deleting anything. Use `--discard` only when discarding the workspace's changes is authorized; it does not authorize deleting persistent data. A busy or failed unmount leaves the workspace intact; do not force/lazy-unmount or broaden cleanup. Baseline removal refuses while any workspace, mounted or not, still references it.

Inspect retained resources with `list` or `status --id <task-id>`. Mutations are serialized with `flock`; if another operation holds the lock, wait for it rather than deleting lock/state files.

## Verification

```bash
bun <skill-dir>/scripts/cow.ts --help
bun test <skill-dir>/tests
```

The lifecycle tests use real Git repositories and FUSE mounts, including sibling isolation, deletions, binary export/import, remount, and guarded cleanup. They require the runtime dependencies above; set `COW_TEST_FUSE_OVERLAYFS` to an alternate executable. They fail when mounting is unavailable rather than reporting a simulated pass.
