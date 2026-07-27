import * as stateStore from "./state_store.ts";
import { type RuntimeRecord, ValueError } from "./runtime_types.ts";

export const CATEGORIES = new Set(["decision", "pitfall", "note"]);
export const SCOPES = new Set(["global", "subtree", "task"]);

export function ancestors(taskId: number, connection?: stateStore.Connection): number[] {
  const result: number[] = [];
  let current = stateStore.getTask(taskId, connection);
  const seen = new Set<number>();
  while (current !== null && !seen.has(Number(current.task_id))) {
    const currentId = Number(current.task_id);
    seen.add(currentId);
    result.push(currentId);
    current = current.parent_task_id ? stateStore.getTask(Number(current.parent_task_id), connection) : null;
  }
  return result;
}

export function selectNotes(
  rootId: string,
  taskId: number,
  limit = 12,
  connection?: stateStore.Connection,
): RuntimeRecord[] {
  const chain = ancestors(taskId, connection);
  const chainSet = new Set(chain);
  const relevant: Array<[number, number, number, number, RuntimeRecord]> = [];
  for (const note of stateStore.listNotes(rootId, false, connection)) {
    const owner = note.task_id === null ? null : Number(note.task_id);
    const applies = note.scope === "global" || (note.scope === "task" ? owner === taskId : owner !== null && chainSet.has(owner));
    if (!applies) continue;
    const group = note.pinned && note.category === "decision"
      ? 0
      : note.scope === "subtree"
        ? 1
        : note.scope === "task"
          ? 2
          : 3;
    relevant.push([
      group,
      owner !== null && chainSet.has(owner) ? chain.indexOf(owner) : chain.length,
      -Number(note.created_at),
      -Number(note.note_id),
      note,
    ]);
  }
  relevant.sort((left, right) => {
    for (let index = 0; index < 4; index += 1) {
      const difference = Number(left[index]) - Number(right[index]);
      if (difference !== 0) return difference;
    }
    return 0;
  });
  return relevant.slice(0, Math.max(0, Math.min(Math.trunc(limit), 12))).map((item) => item[4]);
}

export function writeNote(
  connection: stateStore.Connection,
  context: RuntimeRecord,
  payload: RuntimeRecord,
): number {
  const missing = ["category", "content", "scope"].filter((field) => !(field in payload));
  if (missing.length > 0) throw new ValueError(`write_note requires fields: ${missing.join(", ")}`);
  const { category, scope, content } = payload;
  if (typeof category !== "string" || !CATEGORIES.has(category)) throw new ValueError("invalid note category");
  if (typeof scope !== "string" || !SCOPES.has(scope)) throw new ValueError("invalid note scope");
  if (typeof content !== "string" || !content.trim()) throw new ValueError("note content is required");
  if (content.length > 500) throw new ValueError("note content exceeds 500 characters");
  if ("pinned" in payload && typeof payload.pinned !== "boolean") throw new ValueError("note pinned must be boolean");
  if (
    "supersedes_id" in payload &&
    payload.supersedes_id !== null &&
    (!Number.isSafeInteger(payload.supersedes_id) || typeof payload.supersedes_id === "boolean")
  ) throw new ValueError("note supersedes_id must be an integer or null");
  const count = Number(connection.execute(
    "SELECT COUNT(*) AS n FROM run_notes WHERE root_id = ?",
    [context.run.root_id],
  ).fetchone()?.n ?? 0);
  if (count >= 50) throw new ValueError("run note budget exhausted");
  const supersedesId = payload.supersedes_id ?? null;
  if (supersedesId !== null) {
    const old = connection.execute(
      "SELECT * FROM run_notes WHERE note_id = ? AND root_id = ?",
      [supersedesId, context.run.root_id],
    ).fetchone();
    if (old === null || old.category !== "decision" || category !== "decision") {
      throw new ValueError("supersedes_id must replace a decision in the same run");
    }
    connection.execute("UPDATE run_notes SET active = 0 WHERE note_id = ?", [supersedesId]);
  }
  return connection.execute(
    `INSERT INTO run_notes(
       root_id, task_id, created_by_attempt_id, category, scope, content, pinned,
       supersedes_id, active, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    [
      context.run.root_id,
      context.task.task_id,
      context.attempt.attempt_id,
      category,
      scope,
      content.trim(),
      payload.pinned ? 1 : 0,
      supersedesId,
      stateStore.now(),
    ],
  ).lastrowid;
}
