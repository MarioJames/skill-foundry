import * as executionConfig from "./execution_config.ts";
import * as executionSecrets from "./execution_secrets.ts";
import * as modelPolicy from "./model_policy.ts";
import * as stateStore from "./state_store.ts";
import { canonicalJson, type RuntimeRecord } from "./runtime_types.ts";

export const TERMINAL_TASKS = new Set(["done", "failed", "blocked", "cancelled"]);
export const LIVE_ATTEMPT_STATES = new Set(["assigned", "evaluating", "active", "waiting", "stopping"]);

function resolveDependencies(connection: stateStore.Connection, rootId: string): void {
  let changed = true;
  while (changed) {
    changed = false;
    const pending = stateStore.fetchall(
      "SELECT * FROM tasks WHERE root_id = ? AND status = 'pending' ORDER BY created_at",
      [rootId],
      connection,
    );
    for (const task of pending) {
      const dependencies = stateStore.fetchall(
        `SELECT d.condition, upstream.status
           FROM task_dependencies d
           JOIN tasks upstream ON upstream.task_id = d.depends_on_task_id
          WHERE d.task_id = ?`,
        [task.task_id],
        connection,
      );
      const blocked = dependencies.some(
        (dependency) => dependency.condition === "success" && new Set(["failed", "blocked", "cancelled"]).has(dependency.status),
      );
      if (blocked) {
        connection.execute("UPDATE tasks SET status='blocked', finished_at=? WHERE task_id=?", [stateStore.now(), task.task_id]);
        stateStore.appendEvent(connection, rootId, "TaskBlocked", { reason: "required_dependency_failed" }, task.task_id);
        changed = true;
        continue;
      }
      const satisfied = dependencies.every(
        (dependency) =>
          (dependency.condition === "success" && dependency.status === "done") ||
          (dependency.condition === "terminal" && TERMINAL_TASKS.has(dependency.status)),
      );
      if (satisfied) {
        connection.execute("UPDATE tasks SET status='ready' WHERE task_id=?", [task.task_id]);
        stateStore.appendEvent(connection, rootId, "TaskReady", {}, task.task_id);
        changed = true;
      }
    }
  }
}

function liveAttemptCount(connection: stateStore.Connection, rootId: string): number {
  const states = [...LIVE_ATTEMPT_STATES].sort();
  const marks = states.map(() => "?").join(",");
  return Number(connection.execute(
    `SELECT COUNT(*) AS n FROM attempts a
      JOIN tasks t ON t.task_id=a.task_id
     WHERE t.root_id=? AND a.state IN (${marks})`,
    [rootId, ...states],
  ).fetchone()?.n ?? 0);
}

function createAttempt(
  connection: stateStore.Connection,
  run: RuntimeRecord,
  task: RuntimeRecord,
): RuntimeRecord | null {
  const lastNumber = Number(connection.execute(
    "SELECT COALESCE(MAX(attempt_no), 0) AS n FROM attempts WHERE task_id=?",
    [task.task_id],
  ).fetchone()?.n ?? 0);
  const attemptNumber = lastNumber + 1;
  if (attemptNumber > Number(run.max_attempts_per_task)) {
    connection.execute("UPDATE tasks SET status='failed', finished_at=? WHERE task_id=?", [stateStore.now(), task.task_id]);
    stateStore.appendEvent(connection, run.root_id, "TaskFailed", { reason: "attempt_budget_exhausted" }, task.task_id);
    return null;
  }

  const tier = modelPolicy.selectModelTier(task);
  const routedAttempts = Number(connection.execute(
    `SELECT COUNT(*) AS n
       FROM attempts routed
       JOIN tasks routed_task ON routed_task.task_id=routed.task_id
      WHERE routed_task.root_id=? AND routed_task.parent_task_id IS NOT NULL`,
    [run.root_id],
  ).fetchone()?.n ?? 0);
  const profileName = modelPolicy.selectProfile(run, task, routedAttempts);
  const modelName = modelPolicy.resolveModel(run, tier, profileName);
  const execution = executionConfig.snapshotAttempt(run, {
    model: modelName,
    modelTier: tier,
    profileHint: profileName,
    routingIndex: routedAttempts,
  });
  const created = stateStore.now();
  const cursor = connection.execute(
    `INSERT INTO attempts(
       task_id, attempt_no, state, actor_token_hash, backend_id, agent_type,
       model_tier, model_name, config_json, heartbeat_at, created_at
     ) VALUES (?, ?, 'assigned', 'pending', ?, ?, ?, ?, ?, ?, ?)`,
    [
      task.task_id,
      attemptNumber,
      execution.backend,
      execution.agent,
      tier,
      modelName,
      canonicalJson(execution),
      created,
      created,
    ],
  );
  const attemptId = cursor.lastrowid;
  const actorToken = executionSecrets.deriveAttemptToken(run, attemptId);
  connection.execute("UPDATE attempts SET actor_token_hash=? WHERE attempt_id=?", [stateStore.hashToken(actorToken), attemptId]);
  const sessionName = `agents-orchestrator-${String(run.root_id).replace("root_", "").slice(0, 8)}-${task.task_id}-${attemptNumber}`;
  const launchId = connection.execute(
    `INSERT INTO launches(
       attempt_id, launch_no, session_name, status, prompt_state,
       created_at, last_event_at
     ) VALUES (?, 1, ?, 'starting', 'pending', ?, ?)`,
    [attemptId, sessionName, created, created],
  ).lastrowid;
  connection.execute("UPDATE tasks SET status='assigned' WHERE task_id=?", [task.task_id]);
  const payload = {
    root_id: run.root_id,
    task_id: task.task_id,
    attempt_id: attemptId,
    launch_id: launchId,
    backend_id: execution.backend,
  };
  connection.execute(
    `INSERT OR IGNORE INTO effects(
       root_id, attempt_id, launch_id, effect_type, payload_json,
       idempotency_key, status, attempts, created_at
     ) VALUES (?, ?, ?, 'spawn_agent', ?, ?, 'pending', 0, ?)`,
    [run.root_id, attemptId, launchId, canonicalJson(payload), `spawn:${launchId}`, created],
  );
  stateStore.appendEvent(connection, run.root_id, "AttemptCreated", { attempt_no: attemptNumber }, task.task_id, attemptId);
  stateStore.appendEvent(
    connection,
    run.root_id,
    "AgentSpawnRequested",
    { session_name: sessionName, launch_id: launchId },
    task.task_id,
    attemptId,
  );
  return payload;
}

export function scheduleWithConnection(connection: stateStore.Connection, rootId: string): RuntimeRecord[] {
  const run = stateStore.getRun(rootId, connection);
  if (run === null || run.status !== "running") return [];
  resolveDependencies(connection, rootId);
  const slots = Math.max(0, Number(run.max_concurrent_agents) - liveAttemptCount(connection, rootId));
  if (slots <= 0) return [];
  const ready = stateStore.fetchall(
    `SELECT * FROM tasks
      WHERE root_id=? AND status='ready' AND task_id != ?
      ORDER BY priority DESC, created_at ASC, delegation_depth ASC, task_id ASC
      LIMIT ?`,
    [rootId, run.root_task_id, slots],
    connection,
  );
  const created: RuntimeRecord[] = [];
  for (const task of ready) {
    const result = createAttempt(connection, run, task);
    if (result !== null) created.push(result);
  }
  return created;
}

export function schedule(rootId: string): RuntimeRecord[] {
  return stateStore.transaction((connection) => scheduleWithConnection(connection, rootId));
}
