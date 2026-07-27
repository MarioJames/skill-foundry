import * as modeRuntime from "./mode_runtime.ts";
import * as notes from "./notes.ts";
import * as stateStore from "./state_store.ts";
import { canonicalJson, type RuntimeRecord } from "./runtime_types.ts";

function parse(raw: unknown): RuntimeRecord {
  try {
    const value: unknown = JSON.parse(typeof raw === "string" && raw ? raw : "{}");
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RuntimeRecord : {};
  } catch { return {}; }
}

function formatNotes(items: RuntimeRecord[]): string {
  return items.length ? items.map((item) => `- [${item.category}] ${item.content}`).join("\n") : "(none)";
}

function recoveryContext(task: RuntimeRecord, attempt: RuntimeRecord, connection?: stateStore.Connection): string {
  if (!connection || Number(attempt.attempt_no ?? 1) <= 1) return "";
  const previous = connection.execute(
    `SELECT attempt_no, state, result_json FROM attempts
      WHERE task_id=? AND attempt_no < ? ORDER BY attempt_no DESC LIMIT 3`,
    [task.task_id, attempt.attempt_no],
  ).fetchall();
  const childRows = connection.execute(
    `SELECT child.task_id, child.status, attempt.result_json
       FROM tasks child
       LEFT JOIN attempts attempt ON attempt.attempt_id=(
         SELECT current.attempt_id FROM attempts current
          WHERE current.task_id=child.task_id ORDER BY current.attempt_no DESC LIMIT 1)
      WHERE child.parent_task_id=? ORDER BY child.created_at LIMIT 12`,
    [task.task_id],
  ).fetchall();
  const facts = previous.map((row) => {
    const result = parse(row.result_json);
    return { attempt_no: row.attempt_no, status: row.state, summary: result.summary ?? null, caveats: result.caveats ?? [] };
  });
  const children = childRows.map((row) => {
    const result = parse(row.result_json);
    return { task_id: row.task_id, status: row.status, summary: result.summary ?? null };
  });
  return `\n[RECOVERY CONTEXT]\n${canonicalJson({ previous_attempts: facts, child_results: children })}\n`;
}

export function buildPrompt(
  run: RuntimeRecord,
  task: RuntimeRecord,
  attempt: RuntimeRecord,
  connection?: stateStore.Connection,
): string {
  const constraints = parse(task.constraints_json);
  const execution = parse(run.execution_config_json);
  const acp = execution.backend === "acp";
  const skillGuidance = acp
    ? "The complete required Runtime protocol is included below. Use"
    : 'Before substantial work, read\n"$AGENT_SWARM_SKILL_DIR/SKILL.md" and use';
  const actionGuidance = acp ? `
For every Runtime Action, use exactly this single-line form (encode apostrophes
inside JSON strings as \\u0027 so the JSON remains one single-quoted shell literal):
\`printf '%s' '<JSON object>' | bun "$AGENT_SWARM_SKILL_DIR/scripts/bootstrap.ts" action --type <ACTION_TYPE> --stdin\`
To inspect an Action schema, use exactly:
\`bun "$AGENT_SWARM_SKILL_DIR/scripts/bootstrap.ts" action-schema <ACTION_TYPE>\`` : "";
  const selected = notes.selectNotes(String(run.root_id), Number(task.task_id), 12, connection);
  const remainingDepth = Math.max(0, Number(run.max_delegation_depth) - Number(task.delegation_depth));
  const usedTasks = connection
    ? Number(connection.execute("SELECT COUNT(*) AS n FROM tasks WHERE root_id=?", [run.root_id]).fetchone()?.n ?? 0)
    : stateStore.listTasks(String(run.root_id)).length;
  const remainingTasks = Math.max(0, Number(run.max_total_tasks) - usedTasks);
  const recovery = recoveryContext(task, attempt, connection);
  const mode = connection ? modeRuntime.promptContext(connection, Number(task.task_id)) : "";
  return `[ORCHESTRATION IDENTITY]
root_id: ${run.root_id}
task_id: ${task.task_id}
attempt_id: ${attempt.attempt_id}

[TASK]
${task.goal}

[INTENT]
${task.resolved_intent ?? task.intent_hint}

[OUTPUT CONTRACT]
${task.output_contract ?? "Report the completed result."}

[CONSTRAINTS]
write_scope: ${canonicalJson(constraints.write_scope ?? [])}
read_only: ${String(Boolean(constraints.read_only)).toLowerCase()}
notes: ${canonicalJson(constraints.notes ?? [])}

[RELEVANT NOTES]
${formatNotes(selected)}
${recovery}
${mode}

[RUNTIME]
remaining delegation depth: ${remainingDepth}
remaining task budget: ${remainingTasks}
available actions: submit_estimate, write_note
after estimate, persistent mode owners may also use start_mode/advance_mode; inspect schemas first

[RUNTIME ENTRYPOINT]
This child session already has the exported AGENT_SWARM_* identity. ${skillGuidance}
\`bun "$AGENT_SWARM_SKILL_DIR/scripts/bootstrap.ts"\` for every Runtime action.
Do not initialize another Run: submit \`submit_estimate\` through that entrypoint, then
submit \`finish\` through the same entrypoint after validation.
${actionGuidance}

[WORKSPACE BOOTSTRAP]
Before substantial work in the current directory, run:
\`bun "$AGENT_SWARM_SKILL_DIR/scripts/bootstrap.ts" bootstrap-cwd\`
If you create or enter another Git worktree later, run it again there before doing work. This is
mandatory for every Backend; hook-capable Backends also refresh local hook settings.

[PROTOCOL]
1. Before substantial work, submit an estimate: direct or split.
2. If scope changes materially, revise the estimate before changing strategy.
3. Split only into independent tasks with clear output contracts.
4. Delegate only with create_tasks; never launch an Agent process directly.
5. Use wait when child results are required.
6. Record only reusable decisions or pitfalls.
7. Finish with changed files, validation, integration summary, and caveats.
8. Use action-schema for exact JSON shapes.
`;
}
