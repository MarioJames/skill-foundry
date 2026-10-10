---
name: herdr
description: 在会话开始或主任务变化时命名当前会话与可验证归属的 Herdr 标签页，包括只读问答和无并行工作的评估，无需显式提及 Herdr。负责 Herdr tab/pane、持久终端、Agent 启停与精确资源清理；任务并行与模型决策使用 agent-dispatch。
---

# Herdr

At conversation start or a main-task change, name the current conversation and, where ownership can be verified, its Herdr tab as soon as the task is clear, before substantive task work or a final answer. This applies to read-only questions and evaluations as well as implementation; neither an explicit Herdr request nor a need for parallel work is required. Use the CLI result to establish availability, but require process ownership or a fresh native-title challenge to establish identity; if the caller cannot be verified, continue the task without naming.

Herdr owns terminal operations and tab naming. Task decomposition, parallel decisions, model routing and acceptance policy belong to `agent-dispatch`; load it when deciding whether or how to delegate. A terminal command may still use a `oneshot` lane; bounded Codex worker tasks default to the independent skill's RPC runner.

## Codex with a shared local app-server

When `CODEX_THREAD_ID` is present and this task owns tab naming, first run:

```sh
bun <skill-dir>/scripts/name-codex-session.ts --type FIX --topic '具体任务'
```

Choose TYPE/topic from the current task. The helper reads exactly the runtime-provided thread from the existing local daemon, derives its date from `createdAt` in Asia/Shanghai, sets the formal native name, then binds and names its Herdr tab:

1. Temporarily set this exact thread's native name to an unpredictable one-use marker.
2. Observe the marker echoed by the actual Codex client's live terminal title through `herdr agent list`. Require one pane, allow client updates to settle, and recheck its pane/tab/workspace/terminal IDs and the thread's marker before writing.
3. Rename only that verified tab, read its label back, and restore the formal native name in `finally`. On missing/ambiguous/moved panes, leave all tabs untouched. On a concurrent native name edit, preserve the other writer's edit and report a conflict.

This is a causal challenge/response, not matching an existing title, cwd, focus, or `agent_session`. A brief temporary title may be visible. The returned `tab.caller` is the verified caller for this operation; carry those explicit IDs into immediate routing/handoff instead of re-running raw `--current`. Do not cache the binding across resumes, client switches, or later tasks. If the helper reports failure, do not turn a candidate ID into `--caller-pane` to bypass it.

`--dry-run` reads metadata only, does not send a challenge or rename anything, and does not claim a verified tab. `--native-only` changes only the current native conversation name: use it for a delegate sharing its parent's tab (the parent retains tab naming), or a host explicitly known to have no Herdr client. Otherwise, default to binding and naming both. On a partial failure, output distinguishes native naming from tab failure; never claim tab success from native success alone. A timed-out write is not permission to replay it. Cleanup reads the current native name before restoring only its own marker; if cleanup cannot finish, report the temporary-title risk.

The helper does not start/restart the daemon, resume threads, modify projects, or change focus. Do not override `CODEX_THREAD_ID` with a Herdr-reported value. `CODEX_SESSION_ID` can identify a parent session tree and is not a substitute for the current thread. Older/local Codex without a running daemon and Claude use the verified terminal path below; never launch a daemon merely to name a conversation. After successful native+tab naming, do not repeat the terminal naming steps.

Shared app-server tools are not descendants of the TUI process. The installed Herdr Codex SessionStart hook may also report every thread to a daemon-inherited `HERDR_PANE_ID`. Consequently, a Herdr `agent_session` match alone is not independent ownership evidence. The fresh client echo avoids relying on either inherited IDs or that hook report. If a client does not echo native name changes, or multiple panes display the same thread, automatic binding fails safely.

## Name your own tab

When the task is clear, automatically give your tab a short, concrete task label in the user's language, including for work that needs no parallel lanes. Use `MMDD｜TYPE｜Topic`: derive MMDD only from the session createdAt in Asia/Shanghai, use FEA/DES/FIX/OPT/REL/EXP/DOC/RES, and a short concrete topic. Do not infer the creation date from updatedAt or today; if it is unavailable, preserve the title and report that gap. Re-evaluate the label when the user replaces or switches the main task, even if the existing label is already descriptive or was set in an earlier session. Progress updates, follow-up questions, and subtasks of the same goal do not require renaming.

- Set the label directly from the current task, regardless of the existing name or who set it. Do not add a name-preservation check or ask for confirmation. The user can manually change it afterward.
- Determine delegation from the task's explicit handoff context, not focus, pane count, or the CLI's Agent kind. The creator owns initial naming of a new destination tab before handing off work; include your tab ID, the destination IDs, and naming ownership in the handoff. A delegate sharing its parent's tab leaves naming to the parent; a delegate in a separate tab checks the assigned task label and owns later task changes. If a delegated task lacks this context, resolve the parent's tab or naming assignment before renaming; continue the assigned work if that cannot be resolved.

1. Run `bun <skill-dir>/scripts/resolve-caller.ts` and use `caller.tabId` only on success. The resolver checks that a foreground PID of the candidate pane is an OS ancestor of its process. Raw `herdr pane current --current` is only a candidate lookup: this CLI can return an inherited stale pane ID or fall back to focus. Matching `HERDR_*`, `CODEX_THREAD_ID`, Agent kind, or cwd alone does not prove ownership; a long-lived host can inherit all of them from another Agent. On failure or unavailable process evidence, skip naming. Do not retry with environment IDs removed, search by title/cwd, or substitute a focused pane. An explicit destination ID from the current task owner is valid only for that delegated destination, not proof of the caller’s own tab.
2. Run `herdr tab get <tab_id>` and read `result.tab.label`. Respect the delegation ownership above; skip the write if the desired label already matches.
3. Run `herdr tab rename <tab_id> '<task label>'`, passing the label as one safely quoted argument. Read the tab back and verify `result.tab.label` matches. If naming fails, report it briefly and continue the task.

Only change the tab label; keep workspace names, focus, order, and panes intact. The tab label is distinct from `terminal_title` and the Agent's conversation title.

## Resource ownership

- Receive the target cwd, selected native execution profile, explicit caller/destination IDs and naming ownership from the task owner. Herdr does not classify complexity or change models.
- Keep focus and unrelated resources intact. Before a repeated start/prompt, inspect the existing pane/session; an uncertain response is not permission to repeat execution.
- Close only resources created for the task after the owner has collected the result and confirmed they are no longer needed. Never close the caller pane or widen cleanup after a failure. Retain task data, artifacts and diagnostic records.

## Herdr operations

Use [`scripts/route-lane.ts`](scripts/route-lane.ts) for new `oneshot`, `service`, or `coding-agent` lanes. It owns directory/workspace matching and returns resource IDs plus `lane.cleanup_command`; start work separately in the returned pane. Use its `--help` for arguments.

Pass the task label with `--label`. Before returning success, the router reads back the new tab's label, renames it if needed, and verifies the result. This covers both a new tab in an existing workspace and a new workspace's first tab: `workspace create --label` alone names only the workspace. A split keeps the parent's tab label. Do not rely on the delegate to finish initial naming. If creating through the CLI directly, apply the same tab read/rename/read check to the returned new tab ID before handoff.

If naming or readiness verification fails, the router rolls back only its newly created resource and reports failure. If rollback fails, it reports the exact cleanup command; inspect that resource and retry its cleanup without closing an existing workspace, parent tab, or caller pane.

For a shared Codex daemon, carry the fresh `tab.caller` returned by successful native+tab naming. For direct terminal hosts, resolve the caller with `scripts/resolve-caller.ts`. Carry verified IDs through routing and cleanup. Automatic lane routing uses the same ownership check. Use `--caller-pane` only for that freshly verified caller or an explicit owner-authorized anchor from the current task/handoff; never copy an environment ID or failed candidate into it to bypass verification. Actual CLI responses determine availability; inherited `HERDR_*` variables do not establish ownership. Keep the user's focus unless asked to switch.

Consult the installed CLI's relevant group help for Agent start, prompt, wait, reads, or concrete failures. Use the returned cleanup command for each lane and inspect failures before choosing recovery.
