---
name: herdr
description: 在会话开始或主任务变化时命名当前 Herdr 标签页，包括只读问答和无并行工作的评估，无需显式提及 Herdr。也用于有收益的并行工作、Jev 多任务调度与模型选择，以及 Herdr Agent 和终端管理。
---

# Herdr

At conversation start or a main-task change, resolve the caller and name its tab as soon as the task is clear, before substantive task work or a final answer. This applies to read-only questions and evaluations as well as implementation; neither an explicit Herdr request nor a need for parallel work is required. Use the CLI result to establish availability, not inherited environment variables; if the caller cannot be resolved, continue the task without naming.

Naming and delegation are independent. After the naming check, use Herdr as the first choice for useful parallel work, including independent subtasks of the same deliverable.

## Decompose, decide, dispatch

For multi-task work that benefits from model selection, read [Jev task scheduling](references/jev-scheduling.md). The main Agent defines bounded tasks, dependencies, acceptance criteria and resource ownership; [`scripts/decide-tasks.ts`](scripts/decide-tasks.ts) calls OpenRouter `~typesafe/jev-latest` to select a candidate wave with explicit execution models. Keep ordinary single-owner work direct.

Supply only the current scheduling context and a few concrete candidate plans. The script excludes plans with declared dependency, resource, model or capacity violations, bounds the complete request, and returns parallelism together with task/model assignments. It does not discover hidden dependencies or replace runtime checks. Missing context, low confidence and API failure return control to the main Agent without dispatch or silent model substitution.

Before dispatch, recheck task state, actual available models and remaining capacity; only `ok=true` with `status=selected` supplies a dispatchable proposal. Follow the existing lane router, explicitly start each Agent with its selected model, record returned IDs, and mark it running before starting another wave. Use `cow-workspace` when independent writes need filesystem isolation; database and shared-service ownership remain separate. Accept and integrate artifacts before marking dependencies done, then decide the next wave. Failed work is inspected before a bounded retry or model escalation; the main Agent retains final integration and validation.

## Name your own tab

When the task is clear, automatically give your tab a short, concrete task label in the user's language, including for work that needs no parallel lanes. For example: `修复登录跳转` or `Herdr Tab 自动命名`. Re-evaluate the label when the user replaces or switches the main task, even if the existing label is already descriptive or was set in an earlier session. Progress updates, follow-up questions, and subtasks of the same goal do not require renaming.

- Set the label directly from the current task, regardless of the existing name or who set it. Do not add a name-preservation check or ask for confirmation. The user can manually change it afterward.
- Determine delegation from the task's explicit handoff context, not focus, pane count, or the CLI's Agent kind. The creator owns initial naming of a new destination tab before handing off work; include your tab ID, the destination IDs, and naming ownership in the handoff. A delegate sharing its parent's tab leaves naming to the parent; a delegate in a separate tab checks the assigned task label and owns later task changes. If a delegated task lacks this context, resolve the parent's tab or naming assignment before renaming; continue the assigned work if that cannot be resolved.

1. Run `herdr pane current --current` and read `result.pane.tab_id` to locate yourself, regardless of which pane the user has focused. If the caller cannot be resolved, skip naming; do not fall back to the focused tab.
2. Run `herdr tab get <tab_id>` and read `result.tab.label`. Respect the delegation ownership above; skip the write if the desired label already matches.
3. Run `herdr tab rename <tab_id> '<task label>'`, passing the label as one safely quoted argument. Read the tab back and verify `result.tab.label` matches. If naming fails, report it briefly and continue the task.

Only change the tab label; keep workspace names, focus, order, and panes intact. The tab label is distinct from `terminal_title` and the Agent's conversation title.

## Principles

- Parallelize when the time saved outweighs coordination cost. Choose the split from dependencies and write boundaries; status questions and tightly coupled steps stay with their owner.
- Keep responsibility for the complete result. Continue useful work while delegated tasks run, adapt to user steering, and integrate their results before declaring completion.
- Give each Agent the target cwd, a clear outcome, write ownership, and enough context to work independently. Reuse a suitable active Agent; resolve actual write collisions with a single writer.
- Treat Agent states as coordination signals. Verify the requested result from output and artifacts; inspect failed or timed-out submissions before resending them.
- Own the resources you create. Collect and close finished one-off work promptly; retain services or Agents only while needed. Clean only task-owned resources, never the caller's pane; verify removal and report intentional retention. A cleanup failure does not authorize closing a wider group.

## Herdr operations

Use [`scripts/route-lane.ts`](scripts/route-lane.ts) for new `oneshot`, `service`, or `coding-agent` lanes. It owns directory/workspace matching and returns resource IDs plus `lane.cleanup_command`; start work separately in the returned pane. Use its `--help` for arguments.

Pass the task label with `--label`. Before returning success, the router reads back the new tab's label, renames it if needed, and verifies the result. This covers both a new tab in an existing workspace and a new workspace's first tab: `workspace create --label` alone names only the workspace. A split keeps the parent's tab label. Do not rely on the delegate to finish initial naming. If creating through the CLI directly, apply the same tab read/rename/read check to the returned new tab ID before handoff.

If naming or readiness verification fails, the router rolls back only its newly created resource and reports failure. If rollback fails, it reports the exact cleanup command; inspect that resource and retry its cleanup without closing an existing workspace, parent tab, or caller pane.

Resolve the caller with `herdr pane current --current` and carry explicit IDs through routing and cleanup. Actual CLI responses determine availability; inherited `HERDR_*` variables do not. Keep the user's focus unless asked to switch.

Consult the installed CLI's relevant group help for Agent start, prompt, wait, reads, or concrete failures. Use the returned cleanup command for each lane and inspect failures before choosing recovery.
