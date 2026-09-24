---
name: herdr
description: 在会话开始或主任务变化时命名当前 Herdr 标签页，包括只读问答和无并行工作的评估，无需显式提及 Herdr。负责 Herdr tab/pane、持久终端、Agent 启停与精确资源清理；任务并行与模型决策使用 agent-dispatch。
---

# Herdr

At conversation start or a main-task change, resolve the caller and name its tab as soon as the task is clear, before substantive task work or a final answer. This applies to read-only questions and evaluations as well as implementation; neither an explicit Herdr request nor a need for parallel work is required. Use the CLI result to establish availability, not inherited environment variables; if the caller cannot be resolved, continue the task without naming.

Herdr owns terminal operations and tab naming. Task decomposition, parallel decisions, model routing and acceptance policy belong to `agent-dispatch`; load it when deciding whether or how to delegate. A terminal command may still use a `oneshot` lane; bounded Codex worker tasks default to the independent skill's RPC runner.

## Name your own tab

When the task is clear, automatically give your tab a short, concrete task label in the user's language, including for work that needs no parallel lanes. Use `MMDD｜TYPE｜Topic`: derive MMDD only from the session createdAt in Asia/Shanghai, use FEA/DES/FIX/OPT/REL/EXP/DOC/RES, and a short concrete topic. Do not infer the creation date from updatedAt or today; if it is unavailable, preserve the title and report that gap. Re-evaluate the label when the user replaces or switches the main task, even if the existing label is already descriptive or was set in an earlier session. Progress updates, follow-up questions, and subtasks of the same goal do not require renaming.

- Set the label directly from the current task, regardless of the existing name or who set it. Do not add a name-preservation check or ask for confirmation. The user can manually change it afterward.
- Determine delegation from the task's explicit handoff context, not focus, pane count, or the CLI's Agent kind. The creator owns initial naming of a new destination tab before handing off work; include your tab ID, the destination IDs, and naming ownership in the handoff. A delegate sharing its parent's tab leaves naming to the parent; a delegate in a separate tab checks the assigned task label and owns later task changes. If a delegated task lacks this context, resolve the parent's tab or naming assignment before renaming; continue the assigned work if that cannot be resolved.

1. Run `herdr pane current --current` and read `result.pane.tab_id` to locate yourself, regardless of which pane the user has focused. If the caller cannot be resolved, skip naming; do not fall back to the focused tab.
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

Resolve the caller with `herdr pane current --current` and carry explicit IDs through routing and cleanup. Actual CLI responses determine availability; inherited `HERDR_*` variables do not. Keep the user's focus unless asked to switch.

Consult the installed CLI's relevant group help for Agent start, prompt, wait, reads, or concrete failures. Use the returned cleanup command for each lane and inspect failures before choosing recovery.
