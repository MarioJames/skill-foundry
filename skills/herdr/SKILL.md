---
name: herdr
description: "Proactively control Herdr to shorten the critical path. Trigger automatically when HERDR_ENV=1 and a task has independent repository, module, file-ownership, research, check, or test lanes; a long-running command, service, or monitor can overlap useful work; an additive independent user request arrives while another task is still running; or a coding agent can own an independent deliverable. Also trigger whenever the user mentions Herdr, panes, or tabs. Do not trigger for a superseding request, one short command, tightly serial work, overlapping mutable state, or coordination overhead that exceeds the likely saving. Requires HERDR_ENV=1."
---

# Herdr

Use Herdr when it shortens the task's critical path, not merely to increase pane count.

## Recognize useful concurrency

- **Fan out and join:** split independent repositories, exclusively owned modules/files, research alternatives, or checks/tests. Let the root lane integrate results and verify the combined outcome.
- **Overlap waiting:** run a long build, test, server, or monitor in its own pane while useful work continues elsewhere.
- **Accept an additive task mid-run:** when a new user message adds an independent request instead of replacing the active one, keep the active lane moving and start a coding-agent pane with a self-contained cwd, scope, constraints, ownership, and deliverable.
- **Stay serial:** do not split a replacement request, dependency chain, overlapping edits, shared mutable state, or work whose resource contention/merge cost cancels the saving. If “replace or add” is materially ambiguous, clarify before spawning.

## Decide and split

1. Check `test "${HERDR_ENV:-}" = 1`. If false, continue without Herdr unless the user explicitly required it; then report that Herdr is unavailable.
2. Identify independent lanes before splitting. Start the slowest useful lanes first and keep doing useful work in the caller pane.
3. Estimate whether `max(lane durations) + coordination overhead` beats serial execution. Avoid delegating trivial work or splitting tightly dependent steps.
4. Use sibling panes in the current tab only when the lane belongs to the caller's workspace/repository. When its target cwd is materially different, route it to the workspace that represents that directory and create a tab there; do not put it in the caller's workspace merely because that workspace is current.
5. Classify every created pane before launch: `oneshot`, `service`, or `coding-agent`. This classification determines cleanup.

Inspect only the relevant current CLI group before using it, for example `herdr pane` or `herdr agent`. The installed CLI is authoritative. Do not call `herdr --skill` during normal operation; use it only when the user explicitly requests the full manual, or after a concrete CLI failure that the relevant group output cannot resolve.

## Route by directory

Prefer [`scripts/route-lane.ts`](scripts/route-lane.ts) for create-time classification, workspace probing, and resource creation:

```bash
scripts/route-lane.ts --type oneshot --scope same-task --cwd "$PWD" --caller-pane "$HERDR_PANE_ID"
scripts/route-lane.ts --type coding-agent --cwd /target/repo --label task-name --caller-pane "$HERDR_PANE_ID"
```

Resolve the script relative to this `SKILL.md`. `oneshot` and `service` default to `same-task`; `coding-agent` defaults to `independent`. Use `--dry-run` to inspect the decision without mutation. The script returns one JSON object containing `action`, matched and created IDs, and the cleanup contract. It creates only the routed pane/tab/workspace; start the command or agent separately using `result.pane_id`.

For a read-only directory lookup without type routing, use [`scripts/probe-workspace.ts`](scripts/probe-workspace.ts) with `--cwd <path>`. Both commands run directly through their Bun shebang, require `bun` and the installed `herdr` CLI, support paths containing spaces, and emit structured JSON errors with nonzero exit status. They use only Bun and Node built-ins; no package install is needed.

The router applies this fallback decision process internally; use it manually only when the script is unavailable:

1. Normalize the target cwd and, when applicable, resolve its Git/worktree root.
2. Read IDs with `herdr workspace list`, then inspect `cwd` and `foreground_cwd` using `herdr pane list --workspace <id>` for each candidate. Never treat the workspace label or a broad ancestor such as the home directory as directory evidence.
3. Prefer an exact cwd match, then a matching Git/worktree root. If a workspace matches, create the lane with `herdr tab create --workspace <id> --cwd <target-cwd> --no-focus`.
4. If none matches, create a workspace rooted at the target cwd with `herdr workspace create --cwd <target-cwd> --no-focus` instead of adding the tab to an unrelated workspace.
5. Verify the returned workspace, tab, root-pane IDs, and cwd before starting the command or coding agent.

## Operate

- Inspect layout before choosing `right` versus `down`.
- Resolve the caller once with `herdr pane current --current`, record its returned pane and tab IDs, then use explicit IDs for every split, run, read, wait, move, and close. Never call `herdr pane current` without a target; UI focus may belong to another workspace.
- After every create, split, or move, verify the returned `tab_id`/`workspace_id` matches the intended parent before doing anything in the new pane.
- Preserve context and user focus with `--cwd "$PWD" --no-focus`.
- Parse pane, tab, and agent IDs from command JSON; never predict IDs or rely on UI order.
- Use pane commands for shells, tests, servers, and logs. Use agent commands only for recognized coding agents.
- Target `--current`, an explicit ID, or a unique agent name; never depend on another client's focused pane.
- Honor a user-selected agent kind. Otherwise inspect `herdr agent` and choose the kind appropriate to the lane.
- Give every lane a bounded result contract: exit status, concise findings, and exact evidence paths. Filter or cap logs inside the lane instead of returning whole files or repository-wide dumps to the owning pane.
- For completion waits, ensure the match marker does not occur verbatim in the echoed command; construct it from pieces or verify foreground-process state as well.
- Join all required lane results before integration, and independently verify failures or ambiguous agent states.

## Safety and cleanup

- Keep background work unfocused unless the user asks to switch context.
- Never close a pane, tab, workspace, or session that this task did not create without explicit permission.
- Do not treat `unknown` agent state as completion; inspect state and recent output.
- Close a task-created `oneshot` pane as soon as its exit status and bounded result have been collected, including after handled failures. Keep it only while concrete debugging evidence is still needed.
- Keep a useful `coding-agent` pane available for follow-up by default. Close it only when it was explicitly disposable, the user requests full cleanup, or it has no remaining value after its result is integrated.
- Keep a `service` pane only while something depends on it; then stop the service and close the pane. Report every retained pane's purpose and identifier, plus the port for services.
- Never close the caller/root coding-agent pane as part of child-lane cleanup.

## Gotchas

- More panes can make the critical path worse through startup, duplicated discovery, and merge overhead.
- Unbounded lane output can erase execution-time savings by moving the bottleneck into root-context processing.
- A new user message is not automatically a new lane: status questions should be answered while work continues, and replacement requests should supersede stale work rather than fork it.
- Pass the payload of `herdr pane run` as one correctly quoted shell argument. Check for shell parse errors before waiting for a success marker.
- Commands that mutate state may execute with defaults when probed without required-looking arguments; use the documented group help instead.
- A successful lane is not integrated evidence: verify the combined result in the owning pane.
