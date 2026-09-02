---
name: herdr
description: "Use Herdr when an Agent with active work receives an additional or replacement task, when parallel work can shorten the critical path, when work should be routed to an existing Agent, or when the user asks to manage Herdr panes, tabs, workspaces, or Agents. Do not use for status-only messages, one small serial task, tightly coupled work, or overlapping ownership that cannot be separated safely."
---

# Herdr

Herdr adds task routing to an Agent that is already doing substantive work. The owning Agent remains an implementer; it becomes a pure orchestrator only when the user explicitly requests that role.

## Route the incoming work

When a new message arrives during active work, classify its relationship to the current task before changing course:

- **Status, clarification, or constraint:** answer it or fold it into the current task. Do not create a lane.
- **Replacement:** stop or safely settle superseded work, then continue in the owning Agent. Do not preserve stale work by spawning the replacement elsewhere.
- **Derived work:** keep it in the owning Agent when it contributes to the same deliverable, depends on current findings, shares mutable state, or is too small to repay dispatch and merge cost.
- **Additive independent work:** keep the current primary task in the owning Agent and route only the addition when it has a self-contained outcome, exclusive ownership, no blocking dependency, and enough work to benefit from parallel execution. Reuse a suitable live Agent lane before creating another one.

Topic difference alone does not make work independent, and repository sameness alone does not make it derived. If replacement versus addition is materially ambiguous and changes what should keep running, ask one concise question; otherwise make the narrowest reasonable assumption.

## Keep the owning Agent productive

- Reserve a concrete implementation, investigation, or verification slice for the owning Agent before delegating.
- Give each child a bounded contract: target cwd, outcome, owned and excluded scope, relevant constraints, acceptance checks, and handoff format.
- An explicit, exclusive dispatch scope is already an accepted ownership boundary. Re-negotiate only when evidence reveals a real collision or the boundary must change.
- Avoid overlapping writes. If work cannot be separated safely, keep one writer and use other Agents for findings or review.
- The owning Agent integrates delegated results and verifies the combined outcome.

## Create a lane

Classify a new lane as `oneshot`, `service`, or `coding-agent`. Resolve the caller with `herdr pane current --current`; the CLI result is authoritative, and inherited `HERDR_*` variables are not an availability check.

For every new lane, use [`scripts/route-lane.ts`](scripts/route-lane.ts). It owns cwd/workspace matching and decides whether to split a pane, create a tab, or create a workspace. Capture the target cwd before changing directories, pass explicit IDs, and use the installed Herdr CLI group help for Agent start, prompt, wait, or inspection commands.

```bash
target_cwd=$PWD
primary_pane_id="$(herdr pane current --current | bun -e 'const r=JSON.parse(await Bun.stdin.text()); process.stdout.write(r.result.pane.pane_id)')"
bun /absolute/path/to/herdr/scripts/route-lane.ts --type coding-agent --cwd "$target_cwd" --caller-pane "$primary_pane_id"
```

The script creates the runtime resource and returns its IDs plus an exact `lane.cleanup_command`; start the command or Agent separately in the returned pane. If routing fails, inspect the concrete error and relevant CLI group instead of guessing IDs or silently falling back to an unrelated workspace.

## Own the lifecycle

- Track each created lane's type, IDs, ownership, state, handoff, and exact cleanup command.
- Keep work unfocused unless the user asks to switch. Give every lane a bounded result contract and continue useful root work while it runs.
- Collect and clean a `oneshot` together. Keep a `service` or `coding-agent` only while a named dependency or follow-up remains.
- Execute the returned cleanup command exactly once; never close unrelated resources or the caller Agent's pane. Verify cleanup from a surviving resource list.
- Re-evaluate active lanes whenever the user changes direction. Join required results before integration, and independently verify the combined outcome.
- At handoff, report any intentionally retained resource and its purpose; otherwise state that no task-created resources remain.
