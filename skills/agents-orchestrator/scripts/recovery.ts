import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";

import * as backends from "./backends/index.ts";
import * as executionConfig from "./execution_config.ts";
import * as executionSecrets from "./execution_secrets.ts";
import * as hookManager from "./hook_manager.ts";
import * as hookRuntime from "./hook_runtime.ts";
import * as outbox from "./outbox.ts";
import * as scheduler from "./scheduler.ts";
import * as stateStore from "./state_store.ts";
import { canonicalJson, RuntimeError, ValueError, type RuntimeRecord } from "./runtime_types.ts";
import { AgentBackend, ObserveResult } from "./backends/base.ts";

export const OWNER_LEASE_SECONDS = 15 * 60;
export let HEARTBEAT_STALE_SECONDS = 5 * 60;
export const EFFECT_CLAIM_STALE_SECONDS = 60;
export const LIVE_ATTEMPT_STATES = new Set(["assigned", "evaluating", "active", "waiting", "stopping"]);
export const TERMINAL_ATTEMPT_STATES = new Set(["done", "failed", "cancelled"]);

export function setHeartbeatStaleSecondsForTests(seconds: number): void { HEARTBEAT_STALE_SECONDS = seconds; }
export const heartbeat = hookRuntime.heartbeat;
export const observeSessionEnd = hookRuntime.observeSessionEnd;

function verifyOwner(run: RuntimeRecord | null, actorToken: string): asserts run is RuntimeRecord {
  if (!run) throw new ValueError("run not found");
  if (!stateStore.tokenMatches(actorToken, run.owner_token_hash)) throw new ValueError("invalid root owner token");
}

function observe(launch: RuntimeRecord, adapter?: AgentBackend): ObserveResult {
  const backend = adapter ?? backends.resolveExecutionBackend(launch);
  const result = backend.observe({
    jobId: launch.backend_ref ?? null,
    sessionName: launch.session_name ?? null,
    cwd: stateStore.getRun(String(launch.root_id))?.cwd ?? null,
  });
  if (result instanceof ObserveResult) return result;
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const item = result as RuntimeRecord;
    return new ObserveResult(item.presence ?? "unknown", item.session ?? null, item.error ?? null);
  }
  throw new RuntimeError("backend observe returned an invalid result");
}

function closeLaunch(connection: stateStore.Connection, launch: RuntimeRecord, reason: string): void {
  const timestamp = stateStore.now();
  connection.execute(
    `UPDATE launches SET status='closed',
      prompt_state=CASE WHEN prompt_state='ended' THEN prompt_state ELSE 'cancelled' END,
      exit_reason=COALESCE(exit_reason, ?), closed_at=COALESCE(closed_at, ?), last_event_at=?
     WHERE launch_id=?`,
    [reason, timestamp, timestamp, launch.launch_id],
  );
  connection.execute(
    "UPDATE acp_sessions SET status='closed', closed_at=COALESCE(closed_at, ?) WHERE launch_id=? AND status='active'",
    [timestamp, launch.launch_id],
  );
}

function failLiveAttempt(
  connection: stateStore.Connection,
  run: RuntimeRecord,
  task: RuntimeRecord,
  attempt: RuntimeRecord,
  launch: RuntimeRecord,
  reason: string,
): boolean {
  const current = stateStore.getCurrentAttempt(Number(task.task_id), connection);
  if (!current || current.attempt_id !== attempt.attempt_id || !LIVE_ATTEMPT_STATES.has(String(attempt.state))) return false;
  const timestamp = stateStore.now();
  const retryable = Number(attempt.attempt_no) < Number(run.max_attempts_per_task);
  const result = { status: "failed", retryable, summary: reason, caveats: [] };
  connection.execute(
    `UPDATE attempts SET state='failed', retryable=?, result_json=?, last_error=?, finished_at=? WHERE attempt_id=?`,
    [retryable ? 1 : 0, canonicalJson(result), reason, timestamp, attempt.attempt_id],
  );
  closeLaunch(connection, launch, reason);
  connection.execute(
    retryable
      ? "UPDATE tasks SET status='ready', finished_at=NULL WHERE task_id=?"
      : "UPDATE tasks SET status='failed', finished_at=? WHERE task_id=?",
    retryable ? [task.task_id] : [timestamp, task.task_id],
  );
  stateStore.appendEvent(
    connection, String(run.root_id), retryable ? "TaskRetryScheduled" : "TaskFailed",
    { reason, previous_attempt: attempt.attempt_id }, Number(task.task_id), Number(attempt.attempt_id),
  );
  return true;
}

function reconcileOne(rootId: string, attempt: RuntimeRecord, launch: RuntimeRecord, adapter?: AgentBackend): RuntimeRecord {
  const task = stateStore.getTask(Number(attempt.task_id));
  const run = stateStore.getRun(rootId);
  if (!task || !run) return { attempt_id: attempt.attempt_id, outcome: "missing_facts" };
  if (new Set(["closed", "turn_ended", "error"]).has(String(launch.status))) {
    if (LIVE_ATTEMPT_STATES.has(String(attempt.state))) {
      const reason = String(launch.exit_reason || "launch_ended_without_finish");
      stateStore.transaction((connection) => {
        if (failLiveAttempt(connection, run, task, attempt, launch, reason)) scheduler.scheduleWithConnection(connection, rootId);
      });
      return { attempt_id: attempt.attempt_id, outcome: "retryable_failure" };
    }
    return { attempt_id: attempt.attempt_id, outcome: "terminal" };
  }
  const observation = observe(launch, adapter);
  if (observation.presence === "present") return {
    attempt_id: attempt.attempt_id, launch_id: launch.launch_id, outcome: "present", heartbeat_at: attempt.heartbeat_at,
  };
  if (observation.presence === "unknown") return {
    attempt_id: attempt.attempt_id, launch_id: launch.launch_id, outcome: "unknown", error: observation.error,
  };
  let outcome = "stale";
  stateStore.transaction((connection) => {
    if (TERMINAL_ATTEMPT_STATES.has(String(attempt.state))) { closeLaunch(connection, launch, "backend_absent"); outcome = "closed_terminal_launch"; }
    else if (launch.status === "starting" && launch.ready_at === null) outcome = "starting_absent";
    else {
      const changed = failLiveAttempt(connection, run, task, attempt, launch, "backend_session_absent");
      if (changed) scheduler.scheduleWithConnection(connection, rootId);
      outcome = changed ? "retryable_failure" : "stale";
    }
  });
  return { attempt_id: attempt.attempt_id, launch_id: launch.launch_id, outcome };
}

export function reapChildren(rootId: string, actorToken: string, adapter?: AgentBackend): RuntimeRecord {
  const run = stateStore.getRun(rootId);
  verifyOwner(run, actorToken);
  if (run.status !== "running") throw new ValueError("run is not running");
  const reclaimed = outbox.recoverStaleClaims(rootId, stateStore.now() - EFFECT_CLAIM_STALE_SECONDS);
  const outcomes: RuntimeRecord[] = [];
  const stalled: RuntimeRecord[] = [];
  for (const task of stateStore.listTasks(rootId)) {
    if (task.task_id === run.root_task_id) continue;
    const attempt = stateStore.getCurrentAttempt(Number(task.task_id));
    if (!attempt) continue;
    const launch = stateStore.getCurrentLaunch(Number(attempt.attempt_id));
    if (!launch) continue;
    const result = reconcileOne(rootId, attempt, launch, adapter);
    outcomes.push(result);
    const heartbeatAt = Number(attempt.heartbeat_at ?? attempt.started_at ?? attempt.created_at);
    if (result.outcome === "present" && LIVE_ATTEMPT_STATES.has(String(attempt.state)) &&
        heartbeatAt < stateStore.now() - HEARTBEAT_STALE_SECONDS) {
      stalled.push({
        task_id: task.task_id, attempt_id: attempt.attempt_id, launch_id: launch.launch_id,
        heartbeat_at: heartbeatAt, message: "Backend is present but the Attempt heartbeat is stale.",
      });
    }
  }
  const scheduled = stateStore.transaction((connection) => scheduler.scheduleWithConnection(connection, rootId));
  return { ok: true, reclaimed_effect_claims: reclaimed, reconciled: outcomes, stalled_attempts: stalled, scheduled };
}

export function recoverRun(rootId: string, actorToken: string, adapter?: AgentBackend): RuntimeRecord {
  const report = reapChildren(rootId, actorToken, adapter);
  report.side_effects = outbox.drain(rootId, adapter);
  return report;
}

export function killStalledAttempt(rootId: string, actorToken: string, attemptIdValue: number): RuntimeRecord {
  const run = stateStore.getRun(rootId);
  verifyOwner(run, actorToken);
  const attemptId = Math.trunc(attemptIdValue);
  let launchId = 0;
  stateStore.transaction((connection) => {
    const attempt = stateStore.getAttempt(attemptId, connection);
    if (!attempt || attempt.root_id !== rootId) throw new ValueError("attempt not found in run");
    const task = stateStore.getTask(Number(attempt.task_id), connection)!;
    const current = stateStore.getCurrentAttempt(Number(task.task_id), connection);
    const launch = stateStore.getCurrentLaunch(attemptId, connection);
    if (!current || current.attempt_id !== attemptId) throw new ValueError("attempt is stale");
    if (!LIVE_ATTEMPT_STATES.has(String(attempt.state)) || !launch) throw new ValueError("attempt has no live Launch");
    launchId = Number(launch.launch_id);
    const timestamp = stateStore.now();
    connection.execute(
      "UPDATE attempts SET state='failed', retryable=1, last_error='operator_requested_stop', finished_at=? WHERE attempt_id=?",
      [timestamp, attemptId],
    );
    connection.execute("UPDATE tasks SET status='stopping' WHERE task_id=?", [task.task_id]);
    connection.execute(
      `UPDATE launches SET status='stopping', stop_requested_at=COALESCE(stop_requested_at, ?), last_event_at=?
       WHERE launch_id=? AND status != 'closed'`,
      [timestamp, timestamp, launch.launch_id],
    );
    const payload = {
      root_id: rootId, task_id: task.task_id, attempt_id: attemptId, launch_id: launch.launch_id,
      retry_task_id: task.task_id, reason: "operator_requested_stop",
    };
    connection.execute(
      `INSERT OR IGNORE INTO effects(root_id, attempt_id, launch_id, effect_type, payload_json,
        idempotency_key, status, attempts, created_at)
       VALUES (?, ?, ?, 'stop_agent', ?, ?, 'pending', 0, ?)`,
      [rootId, attemptId, launch.launch_id, canonicalJson(payload), `stop:${launch.launch_id}`, timestamp],
    );
    connection.execute(
      "UPDATE effects SET status='pending', claimed_at=NULL, last_error=NULL WHERE idempotency_key=? AND status='failed'",
      [`stop:${launch.launch_id}`],
    );
    stateStore.appendEvent(connection, rootId, "AttemptStopRequested", { launch_id: launch.launch_id }, Number(task.task_id), attemptId);
  });
  return { requested: true, attempt_id: attemptId, launch_id: launchId };
}

function ensureSeed(run: RuntimeRecord, connection: stateStore.Connection): void {
  try { executionSecrets.deriveAttemptToken(run, -1); return; }
  catch {
    if (run.token_seed_ref) {
      try { unlinkSync(executionSecrets.resolveSeedPath(run.token_seed_ref)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const [reference, digest] = executionSecrets.createRunSeed(String(run.root_id));
    connection.execute("UPDATE runs SET token_seed_ref=?, token_seed_hash=? WHERE root_id=?", [reference, digest, run.root_id]);
  }
}

export function recoverRoot(rootId: string, forceTakeover = false): RuntimeRecord {
  let run = stateStore.getRun(rootId);
  if (!run) throw new ValueError("run not found");
  if (new Set(["done", "cancelled"]).has(String(run.status))) throw new ValueError("terminal run cannot be recovered");
  const timestamp = stateStore.now();
  if (run.lease_expires_at && Number(run.lease_expires_at) > timestamp && !forceTakeover) {
    throw new ValueError("root owner lease is still active; use --force-takeover");
  }
  const token = `as_${randomBytes(32).toString("base64url")}`;
  let taskId = 0;
  let attemptId = 0;
  let leaseEpoch = 0;
  stateStore.transaction((connection) => {
    run = stateStore.getRun(rootId, connection)!;
    const task = stateStore.getTask(Number(run.root_task_id), connection)!;
    taskId = Number(task.task_id);
    const previous = stateStore.getCurrentAttempt(taskId, connection);
    if (previous && LIVE_ATTEMPT_STATES.has(String(previous.state))) {
      connection.execute("UPDATE attempts SET state='cancelled', finished_at=? WHERE attempt_id=?", [timestamp, previous.attempt_id]);
    }
    const attemptNo = Number(previous?.attempt_no ?? 0) + 1;
    const tiers = JSON.parse(String(run.model_tiers_json)) as RuntimeRecord;
    const config = executionConfig.snapshotAttempt(run, { model: String(tiers.strong) });
    const cursor = connection.execute(
      `INSERT INTO attempts(task_id, attempt_no, state, actor_token_hash, backend_id, agent_type,
        model_tier, model_name, config_json, heartbeat_at, created_at, started_at)
       VALUES (?, ?, 'evaluating', ?, ?, ?, 'strong', ?, ?, ?, ?, ?)`,
      [taskId, attemptNo, stateStore.hashToken(token), config.backend, config.agent, config.model ?? null,
        canonicalJson(config), timestamp, timestamp, timestamp],
    );
    attemptId = Number(cursor.lastrowid);
    ensureSeed(run, connection);
    connection.execute(
      `UPDATE runs SET status='running', owner_token_hash=?, lease_epoch=lease_epoch+1,
       lease_expires_at=?, finished_at=NULL, updated_at=? WHERE root_id=?`,
      [stateStore.hashToken(token), timestamp + OWNER_LEASE_SECONDS, timestamp, rootId],
    );
    connection.execute("UPDATE tasks SET status='active', finished_at=NULL WHERE task_id=?", [taskId]);
    stateStore.appendEvent(connection, rootId, "RootRecovered", {
      previous_attempt_id: previous?.attempt_id ?? null,
      continuing_mode_ids: stateStore.fetchall(
        "SELECT mode_id FROM modes WHERE root_id=? AND status='running' ORDER BY mode_id", [rootId], connection,
      ).map((row) => row.mode_id),
    }, taskId, attemptId);
    leaseEpoch = Number(run.lease_epoch) + 1;
  });
  return {
    root_id: rootId, task_id: taskId, attempt_id: attemptId, actor_token: token,
    lease_epoch: leaseEpoch, lease_expires_at: timestamp + OWNER_LEASE_SECONDS,
  };
}

export function cancelModeWithConnection(
  connection: stateStore.Connection,
  run: RuntimeRecord,
  mode: RuntimeRecord,
  reason: string,
): RuntimeRecord {
  const timestamp = stateStore.now();
  const modeIds = stateStore.fetchall(
    `WITH RECURSIVE descendants(mode_id) AS (
       SELECT mode_id FROM modes WHERE mode_id=?
       UNION ALL SELECT child.mode_id FROM modes child JOIN descendants parent ON child.parent_mode_id=parent.mode_id)
     SELECT mode_id FROM descendants`,
    [mode.mode_id], connection,
  ).map((row) => Number(row.mode_id));
  if (!modeIds.length) return { cancelled_task_ids: [], stopping_launch_ids: [] };
  const marks = modeIds.map(() => "?").join(",");
  const tasks = stateStore.fetchall(
    `SELECT DISTINCT t.* FROM tasks t JOIN mode_tasks mt ON mt.task_id=t.task_id WHERE mt.mode_id IN (${marks})`,
    modeIds, connection,
  );
  const cancelledTaskIds: number[] = [];
  const stoppingLaunchIds: number[] = [];
  for (const task of tasks) {
    if (new Set(["done", "failed", "blocked", "cancelled"]).has(String(task.status))) continue;
    const attempt = stateStore.getCurrentAttempt(Number(task.task_id), connection);
    const launch = attempt ? stateStore.getCurrentLaunch(Number(attempt.attempt_id), connection) : null;
    if (attempt && LIVE_ATTEMPT_STATES.has(String(attempt.state))) {
      connection.execute(
        "UPDATE attempts SET state='cancelled', retryable=0, last_error=?, finished_at=COALESCE(finished_at, ?) WHERE attempt_id=?",
        [reason, timestamp, attempt.attempt_id],
      );
    }
    connection.execute("UPDATE tasks SET status='cancelled', finished_at=COALESCE(finished_at, ?) WHERE task_id=?", [timestamp, task.task_id]);
    cancelledTaskIds.push(Number(task.task_id));
    if (!launch || launch.status === "closed") continue;
    if (launch.status === "starting" && launch.ready_at === null) {
      connection.execute(
        `UPDATE launches SET status='closed', prompt_state='cancelled', exit_reason=?, closed_at=?, last_event_at=? WHERE launch_id=?`,
        [reason, timestamp, timestamp, launch.launch_id],
      );
      connection.execute(
        `UPDATE effects SET status='completed', completed_at=?, last_error=?
          WHERE launch_id=? AND effect_type='spawn_agent' AND status IN ('pending','running')`,
        [timestamp, "mode cancelled before spawn", launch.launch_id],
      );
      continue;
    }
    connection.execute(
      "UPDATE launches SET status='stopping', stop_requested_at=COALESCE(stop_requested_at, ?), last_event_at=? WHERE launch_id=?",
      [timestamp, timestamp, launch.launch_id],
    );
    const payload = {
      root_id: run.root_id, task_id: task.task_id, attempt_id: attempt!.attempt_id,
      launch_id: launch.launch_id, reason: "mode_cancelled",
    };
    connection.execute(
      `INSERT OR IGNORE INTO effects(root_id, attempt_id, launch_id, effect_type, payload_json,
       idempotency_key, status, attempts, created_at)
       VALUES (?, ?, ?, 'stop_agent', ?, ?, 'pending', 0, ?)`,
      [run.root_id, attempt!.attempt_id, launch.launch_id, canonicalJson(payload), `stop:${launch.launch_id}`, timestamp],
    );
    stoppingLaunchIds.push(Number(launch.launch_id));
  }
  connection.execute(
    `UPDATE modes SET status='cancelled', updated_at=?, completed_at=COALESCE(completed_at, ?)
      WHERE mode_id IN (${marks}) AND status='running'`,
    [timestamp, timestamp, ...modeIds],
  );
  connection.execute(
    `UPDATE mode_rounds SET status='cancelled', completed_at=COALESCE(completed_at, ?)
      WHERE mode_id IN (${marks}) AND status='active'`,
    [timestamp, ...modeIds],
  );
  stateStore.appendEvent(connection, String(run.root_id), "ModeCancellationRequested", {
    mode_id: mode.mode_id, mode_ids: modeIds, task_ids: cancelledTaskIds,
    launch_ids: stoppingLaunchIds, reason,
  }, Number(mode.owner_task_id));
  return { cancelled_task_ids: cancelledTaskIds, stopping_launch_ids: stoppingLaunchIds };
}

export function stopRun(rootId: string, actorToken: string, adapter?: AgentBackend): RuntimeRecord {
  const run = stateStore.getRun(rootId);
  verifyOwner(run, actorToken);
  stateStore.transaction((connection) => {
    const timestamp = stateStore.now();
    connection.execute("UPDATE runs SET status='stopping', updated_at=? WHERE root_id=?", [timestamp, rootId]);
    for (const launch of stateStore.listLaunches(rootId, connection)) {
      if (launch.status === "closed") continue;
      connection.execute(
        "UPDATE launches SET status='stopping', stop_requested_at=COALESCE(stop_requested_at, ?), last_event_at=? WHERE launch_id=?",
        [timestamp, timestamp, launch.launch_id],
      );
      const payload = {
        root_id: rootId, task_id: launch.task_id, attempt_id: launch.attempt_id,
        launch_id: launch.launch_id, reason: "run_stopped",
      };
      connection.execute(
        `INSERT OR IGNORE INTO effects(root_id, attempt_id, launch_id, effect_type, payload_json,
          idempotency_key, status, attempts, created_at)
         VALUES (?, ?, ?, 'stop_agent', ?, ?, 'pending', 0, ?)`,
        [rootId, launch.attempt_id, launch.launch_id, canonicalJson(payload), `stop:${launch.launch_id}`, timestamp],
      );
      connection.execute(
        "UPDATE effects SET status='pending', claimed_at=NULL, last_error=NULL WHERE idempotency_key=? AND status='failed'",
        [`stop:${launch.launch_id}`],
      );
    }
    connection.execute(
      `UPDATE attempts SET state='cancelled', finished_at=COALESCE(finished_at, ?)
        WHERE attempt_id IN (SELECT a.attempt_id FROM attempts a JOIN tasks t ON t.task_id=a.task_id WHERE t.root_id=?)
          AND state IN ('assigned','evaluating','active','waiting','stopping')`,
      [timestamp, rootId],
    );
    connection.execute(
      `UPDATE tasks SET status='cancelled', finished_at=COALESCE(finished_at, ?)
        WHERE root_id=? AND status NOT IN ('done','failed','blocked','cancelled')`,
      [timestamp, rootId],
    );
    connection.execute(
      `UPDATE modes SET status='cancelled', updated_at=?, completed_at=COALESCE(completed_at, ?)
        WHERE root_id=? AND status='running'`,
      [timestamp, timestamp, rootId],
    );
    connection.execute(
      `UPDATE mode_rounds SET status='cancelled', completed_at=COALESCE(completed_at, ?)
        WHERE mode_id IN (SELECT mode_id FROM modes WHERE root_id=?) AND status='active'`,
      [timestamp, rootId],
    );
  });
  const sideEffects = outbox.drain(rootId, adapter);
  const openLaunches = stateStore.listLaunches(rootId).filter((item) => item.status !== "closed");
  const status = openLaunches.length ? "stopping" : "cancelled";
  if (!openLaunches.length) {
    stateStore.transaction((connection) => {
      const timestamp = stateStore.now();
      connection.execute("UPDATE runs SET status='cancelled', finished_at=?, updated_at=? WHERE root_id=?", [timestamp, timestamp, rootId]);
    });
    hookManager.cleanupProjectHooks(String(run.cwd), rootId);
    executionSecrets.cleanupRunSeedIfSafe(rootId);
  }
  return { root_id: rootId, status, open_launches: openLaunches.map((item) => item.launch_id), side_effects: sideEffects };
}

export function doctor(rootId: string): RuntimeRecord {
  const run = stateStore.getRun(rootId);
  if (!run) throw new ValueError("run not found");
  const now = stateStore.now();
  const attempts = stateStore.listAttempts(rootId);
  const launches = stateStore.listLaunches(rootId);
  const effects = stateStore.listEffects(rootId);
  return {
    root_id: rootId,
    run_status: run.status,
    stale_attempts: attempts.filter((item) => LIVE_ATTEMPT_STATES.has(String(item.state)) &&
      Number(item.heartbeat_at ?? item.created_at) < now - HEARTBEAT_STALE_SECONDS)
      .map((item) => ({ attempt_id: item.attempt_id, task_id: item.task_id, state: item.state, heartbeat_at: item.heartbeat_at })),
    open_launches: launches.filter((item) => item.status !== "closed"),
    pending_effects: effects.filter((item) => new Set(["pending", "running"]).has(String(item.status))),
  };
}

function counts(items: RuntimeRecord[], key: string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const item of items) result[String(item[key])] = (result[String(item[key])] ?? 0) + 1;
  return result;
}

export function metrics(rootId: string): RuntimeRecord {
  const run = stateStore.getRun(rootId);
  if (!run) throw new ValueError("run not found");
  const tasks = stateStore.listTasks(rootId);
  const attempts = stateStore.listAttempts(rootId);
  const launches = stateStore.listLaunches(rootId);
  const sessions = stateStore.listSessions(rootId);
  return {
    root_id: rootId, run_status: run.status,
    tasks: { total: tasks.length, by_status: counts(tasks, "status") },
    attempts: { total: attempts.length, by_state: counts(attempts, "state") },
    launches: { total: launches.length, by_status: counts(launches, "status") },
    acp_sessions: { total: sessions.length, by_status: counts(sessions, "status") },
  };
}
