---
name: herdr
description: Herdr 基础操作：tab/pane、持久终端、Agent 启停、隐藏 session 与精确资源清理；用 name-tab.ts 为可证明归属本进程的标签页设置调用方给定的标签。会话命名的时机、格式与归属由 agent-conduct 负责，任务拆分、派发与模型选择由 Weaver（agents-weaver）负责。
---

# Herdr

Terminal primitives: lanes (tabs, panes, workspaces, hidden sessions), agent start/stop, precise cleanup and verified tab labelling. When to name a conversation and what the label says belong to [agent-conduct](../agent-conduct/SKILL.md#会话命名); task decomposition, dispatch and model routing belong to Weaver (`agents-weaver`).

## Label your own tab

```sh
bun <skill-dir>/scripts/name-tab.ts --label '<label>'
```

Sets the label of the tab this process provably owns and reads it back. Output is `{ok, tab: {caller, label, changed, proof}}`; carry `tab.caller` into routing or handoff.

- On failure, skip labelling and continue the task. Do not pass a candidate ID as `--caller-pane`, retry with environment IDs removed, search by title or cwd, or substitute the focused pane. A timed-out write is not permission to replay it.
- `HERDR_*`, `CODEX_THREAD_ID`, agent kind, cwd and `herdr pane current --current` are only candidates: a long-lived host passes them to every agent it starts. Do not cache the binding across resumes or later tasks.
- `scripts/resolve-caller.ts` returns the verified caller without writing anything.
- How ownership is proven, and why a proof fails: [Ownership proof](references/ownership-proof.md).

## Create a lane

```sh
bun <skill-dir>/scripts/route-lane.ts --type oneshot|service|coding-agent --cwd <path> --label '<label>' [--caller-pane <verified caller>]
```

The router matches the directory to a workspace, creates the lane, labels and verifies the new tab, and returns resource IDs plus `lane.cleanup_command`. Start work separately in the returned pane. `--help` covers every option and failure code, including hidden sessions.

- Receive the cwd, execution profile, caller or destination IDs and the label from the task owner. Herdr does not classify complexity, change models or choose labels.
- `--caller-pane` takes only the caller just verified by `name-tab.ts` or `resolve-caller.ts`, or an anchor the owner gave explicitly in this task.
- On failure the router rolls back only what it created; if rollback fails it prints the exact cleanup command. Never close an existing workspace, parent tab or the caller pane.
- When creating a tab through the CLI directly, read the new tab's label, rename it and read it again before handoff: `workspace create --label` names only the workspace.
- Hidden session (`--session`, `--create-session`): for background agents the user does not need to watch. Run later commands with `herdr --session NAME ...`; after the last lane closes, `route-lane.ts --session NAME --stop-if-empty`. Agents that must stay visible, such as an intake or cooperation owner, go in the main session.
- On Herdr 0.9.3, closing a tab's last pane closes the tab and a workspace's last tab removes the workspace; closing the only pane of a worktree parent that still has worktree workspaces is refused (`confirmation_required`).

## Ownership and cleanup

- Keep the user's focus and unrelated resources intact. Before repeating a start or prompt, inspect the existing pane or session; an uncertain response is not permission to repeat.
- Close only resources created for the task, after the owner has collected the result and no dependency remains, using each lane's `cleanup_command`. Never widen cleanup after a failure. Artifacts, data and workspaces follow [agent-conduct](../agent-conduct/SKILL.md#收尾回收).
- For agent start, prompt, wait and reads, consult the installed CLI's group help.
