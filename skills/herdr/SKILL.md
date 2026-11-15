---
name: herdr
description: Herdr 基础操作：tab/pane、持久终端、Agent 启停、隐藏 session 与精确资源清理；用 name-tab.ts 为可证明归属本进程的标签页设置调用方给定的标签。会话命名的时机、格式与归属由 agent-conduct 负责，任务拆分、派发与模型选择由 Weaver（agents-weaver）负责。
---

# Herdr

Herdr provides terminal primitives: lanes (tabs, panes, workspaces, hidden sessions), agent start/stop and precise cleanup, plus verified tab labelling. It does not decide when to name a conversation or what the label says: session naming rules live in [agent-conduct](../agent-conduct/SKILL.md#会话命名), whose `name-session.ts` calls `name-tab.ts` below. Task decomposition, dispatch and model routing belong to Weaver (`agents-weaver`) when the user invokes it. A terminal command may still use a `oneshot` lane.

## Label your own tab

```sh
bun <skill-dir>/scripts/name-tab.ts --label '<label>'
```

Sets the label of the tab this process owns, verbatim, and reads it back. Output is `{ok, tab: {caller, label, changed, proof}}`; carry `tab.caller` into immediate routing or handoff instead of re-running raw `--current`. Ownership is proven, never assumed:

1. **Process ancestry** (`tab.proof: "process-ancestry"`). A foreground PID of the candidate pane from `pane current --current` must be an OS ancestor of this invocation. This covers Claude Code, a Codex TUI without a shared daemon and other direct terminal hosts. A proven process can label its own tab even when the terminal shows an independent activity title.
2. **Native-title challenge** (`tab.proof: "native-title-challenge"`), only for `CODEX_THREAD_ID` under a running shared local app-server, whose tools are not descendants of the TUI. The thread must already carry its formal native name. The script temporarily sets this exact thread's native name to an unpredictable one-use marker, requires exactly one live Codex client to echo it in its terminal title through `herdr agent list`, lets client updates settle, then binds that pane. It restores the formal name in `finally`, restoring only its own marker and preserving a concurrent edit (reported as a conflict). A brief temporary title is visible only on this path. No echo or multiple matching panes fails safely without changing any tab.

For either proof, pane/tab/workspace/terminal IDs and the live proof are rechecked immediately before the write. A lost proof, identity conflict or uncertain write stops the operation: it never falls back to another target, and a timed-out write is not permission to replay it. On failure, skip labelling and continue the task; do not turn a candidate ID into `--caller-pane`, retry with environment IDs removed, search by title/cwd, or substitute a focused pane.

Raw `herdr pane current --current` is only a candidate lookup: it can return an inherited stale pane ID or fall back to focus. Matching `HERDR_*`, `CODEX_THREAD_ID`, Agent kind or cwd alone does not prove ownership, since a long-lived host can inherit all of them from another Agent. The installed Herdr Codex SessionStart hook may also report every thread to a daemon-inherited `HERDR_PANE_ID`, so an `agent_session` match is not evidence either. `CODEX_SESSION_ID` can identify a parent session tree and is not a substitute for the current thread. Do not cache the binding across resumes, client switches or later tasks.

The script never starts or restarts the Codex daemon, resumes threads, or changes focus, workspace names, order or panes. The tab label, the terminal activity title (`terminal_title`) and the conversation title are separate values. `scripts/resolve-caller.ts` returns the verified caller (process ancestry only) without writing anything.

## Resource ownership

- Receive the target cwd, selected native execution profile, explicit caller/destination IDs and the destination tab label from the task owner. Herdr does not classify complexity, change models or choose labels.
- Keep focus and unrelated resources intact. Before a repeated start/prompt, inspect the existing pane/session; an uncertain response is not permission to repeat execution.
- Close only resources created for the task after the owner has collected the result and verified that no actual dependency remains. Never close the caller pane or widen cleanup after a failure. Follow [task resource lifecycle](../agent-conduct/SKILL.md#收尾回收) for artifacts, data and workspaces; retain final deliverables and necessary evidence, and reclaim eligible task intermediates rather than stopping processes alone.

## Herdr operations

Use [`scripts/route-lane.ts`](scripts/route-lane.ts) for new `oneshot`, `service`, or `coding-agent` lanes. It owns directory/workspace matching and returns resource IDs plus `lane.cleanup_command`; start work separately in the returned pane. Use its `--help` for arguments.

Pass the destination's label with `--label`; its format and who names which tab follow agent-conduct's session naming. Before returning success, the router reads back the new tab's label, renames it if needed, and verifies the result. This covers both a new tab in an existing workspace and a new workspace's first tab: `workspace create --label` alone names only the workspace. A split keeps the parent's tab label. If creating through the CLI directly, apply the same tab read/rename/read check to the returned new tab ID before handoff.

If naming or readiness verification fails, the router rolls back only its newly created resource and reports failure. If rollback fails, it reports the exact cleanup command; inspect that resource and retry its cleanup without closing an existing workspace, parent tab, or caller pane.

Carry the fresh `tab.caller` returned by `name-tab.ts` (also present in the `herdr-tab` target of agent-conduct's `name-session.ts`). Otherwise resolve the caller with `scripts/resolve-caller.ts`. Carry verified IDs through routing and cleanup. Automatic lane routing uses the same ownership check. Use `--caller-pane` only for that freshly verified caller or an explicit owner-authorized anchor from the current task/handoff; never copy an environment ID or failed candidate into it to bypass verification. Actual CLI responses determine availability; inherited `HERDR_*` variables do not establish ownership. Keep the user's focus unless asked to switch.

Hidden session: for background agents the user does not need to watch (for example heterogeneous workers), build the lane in a separate headless Herdr session so it stays out of the main session's agents panel. Hidden lanes skip caller resolution and only create a tab or workspace (independent scope; `--caller-pane` and `--scope same-task` are rejected). Run later Herdr commands for that lane with `herdr --session NAME ...`, and clean up with the returned `cleanup_command`. Agents that must be visible, such as an intake or cooperation owner, stay in the main session. The user can inspect a hidden session with `herdr session attach NAME`.

- `--create-session NAME --op-tag TAG` creates a brand-new session for the first lane and never adopts an existing one. A same-name running or stopped session, directory or scope fails with `session_exists`. On success `session` is `{name, created: true, proof: {unit, invocation_id, server_pid, server_starttime, boot_id}, dir_id: {dev, ino}}`, with `server_pid` verified to hold the session socket inside that scope. The session directory is claimed with an atomic `mkdir` and must still be empty when the server is forked. A directory written to in between, restored workspaces, or a socket served by another process fails with `session_foreign`: only reported, never stopped or deleted. A failure after creation also returns `session`. Excludes `--session`, `--dry-run`, `--caller-pane` and `--scope same-task`.
- `--session NAME` uses an existing session (started on demand if stopped) and reports `session.created: false` without proof. After the last lane closes, `route-lane.ts --session NAME --stop-if-empty` stops it only when no workspaces remain.
- `--session NAME --require-running` reuses only a running server, with `created: false, started: false`; an unavailable server or later native failure never triggers a start or restart. See `--help` for parameter constraints and failure codes.
- `--op-tag TAG` is kept verbatim in the router's and launcher's argv and exported as `HERDR_LANE_OP_TAG` to every child (herdr, systemd-run, systemctl), so a supervisor can find an in-flight call in `/proc`; the long-lived server does not carry it.
- On Herdr 0.9.3, closing a tab's last pane closes the tab and a workspace's last tab removes the workspace; closing the only pane of a worktree parent that still has worktree workspaces is refused (`confirmation_required`).

Consult the installed CLI's relevant group help for Agent start, prompt, wait, reads, or concrete failures. Use the returned cleanup command for each lane and inspect failures before choosing recovery.
