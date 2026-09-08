---
name: herdr
description: Prefer Herdr when parallel work can shorten the critical path, or when managing Herdr agents and terminal resources.
---

# Herdr

Use Herdr as the first choice for useful parallel work, including independent subtasks of the same deliverable.

## Principles

- Parallelize when the time saved outweighs coordination cost. Choose the split from dependencies and write boundaries; status questions and tightly coupled steps stay with their owner.
- Keep responsibility for the complete result. Continue useful work while delegated tasks run, adapt to user steering, and integrate their results before declaring completion.
- Give each Agent the target cwd, a clear outcome, write ownership, and enough context to work independently. Reuse a suitable active Agent; resolve actual write collisions with a single writer.
- Treat Agent states as coordination signals. Verify the requested result from output and artifacts; inspect failed or timed-out submissions before resending them.
- Own the resources you create. Collect and close finished one-off work promptly; retain services or Agents only while needed. Clean only task-owned resources, never the caller's pane; verify removal and report intentional retention. A cleanup failure does not authorize closing a wider group.

## Herdr operations

Use [`scripts/route-lane.ts`](scripts/route-lane.ts) for new `oneshot`, `service`, or `coding-agent` lanes. It owns directory/workspace matching and returns resource IDs plus `lane.cleanup_command`; start work separately in the returned pane. Use its `--help` for arguments.

Resolve the caller with `herdr pane current --current` and carry explicit IDs through routing and cleanup. Actual CLI responses determine availability; inherited `HERDR_*` variables do not. Keep the user's focus unless asked to switch.

Consult the installed CLI's relevant group help for Agent start, prompt, wait, reads, or concrete failures. Use the returned cleanup command for each lane and inspect failures before choosing recovery.
