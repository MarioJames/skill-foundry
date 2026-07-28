import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import * as backends from "./backends/index.ts";
import * as runtimeEnv from "./runtime_env.ts";
import * as executionSecrets from "./execution_secrets.ts";
import * as hookManager from "./hook_manager.ts";
import * as promptBuilder from "./prompt_builder.ts";
import * as scheduler from "./scheduler.ts";
import * as stateStore from "./state_store.ts";
import { canonicalJson, RuntimeError, type RuntimeRecord } from "./runtime_types.ts";
import {
  AgentBackend, BackendPendingError, BackendUnknownError, SpawnRequest, SpawnResult, StopRequest,
} from "./backends/base.ts";

const SKILL_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

export class StaleEffect extends RuntimeError { override name = "StaleEffect"; }

function message(error: unknown): string { return error instanceof Error ? error.message : "external effect failed"; }

function spawnCall(backend: AgentBackend, request: SpawnRequest): RuntimeRecord {
  const result = backend.spawn(request);
  if (result instanceof SpawnResult) return { job_id: result.jobId, session_name: result.sessionName, ...result.extras };
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new RuntimeError("backend spawn returned an invalid result");
  return result;
}

export function recoverStaleClaims(rootId: string, staleBefore: number): number {
  return stateStore.transaction((connection) => connection.execute(
    "UPDATE effects SET status='pending', claimed_at=NULL WHERE root_id=? AND status='running' AND claimed_at < ?",
    [rootId, staleBefore],
  ).rowcount);
}

function claim(effectId: number): boolean {
  return stateStore.transaction((connection) => connection.execute(
    `UPDATE effects SET status='running', claimed_at=?, attempts=attempts+1 WHERE id=? AND status='pending'`,
    [stateStore.now(), effectId],
  ).rowcount === 1);
}

function binding(connection: stateStore.Connection, payload: RuntimeRecord): RuntimeRecord {
  const run = stateStore.getRun(String(payload.root_id), connection);
  const task = stateStore.getTask(Number(payload.task_id), connection);
  const attempt = stateStore.getAttempt(Number(payload.attempt_id), connection);
  const launch = stateStore.getLaunch(Number(payload.launch_id), connection);
  if (!run || !task || !attempt || !launch) throw new StaleEffect("effect references missing runtime facts");
  const currentAttempt = stateStore.getCurrentAttempt(Number(task.task_id), connection);
  const currentLaunch = stateStore.getCurrentLaunch(Number(attempt.attempt_id), connection);
  if (task.root_id !== run.root_id || attempt.root_id !== run.root_id || attempt.task_id !== task.task_id ||
      launch.root_id !== run.root_id || launch.attempt_id !== attempt.attempt_id ||
      currentAttempt?.attempt_id !== attempt.attempt_id || currentLaunch?.launch_id !== launch.launch_id) {
    throw new StaleEffect("effect is fenced by a newer Attempt or Launch");
  }
  return { run, task, attempt, launch };
}

function enqueueStop(
  connection: stateStore.Connection,
  run: RuntimeRecord,
  task: RuntimeRecord,
  attempt: RuntimeRecord,
  launch: RuntimeRecord,
  reason: string,
): void {
  const payload = {
    root_id: run.root_id, task_id: task.task_id, attempt_id: attempt.attempt_id,
    launch_id: launch.launch_id, reason,
  };
  connection.execute(
    `INSERT OR IGNORE INTO effects(root_id, attempt_id, launch_id, effect_type, payload_json,
      idempotency_key, status, attempts, created_at)
     VALUES (?, ?, ?, 'stop_agent', ?, ?, 'pending', 0, ?)`,
    [run.root_id, attempt.attempt_id, launch.launch_id, canonicalJson(payload), `stop:${launch.launch_id}`, stateStore.now()],
  );
}

function spawnEffect(effect: RuntimeRecord, payload: RuntimeRecord, adapter?: AgentBackend): void {
  const prepared = stateStore.transaction((connection) => {
    const { run, task, attempt, launch } = binding(connection, payload);
    if (run.status !== "running" || attempt.state !== "assigned") throw new StaleEffect("spawn effect no longer targets an assigned Attempt");
    const actorToken = executionSecrets.deriveAttemptToken(run, Number(attempt.attempt_id));
    const prompt = promptBuilder.buildPrompt(run, task, attempt, connection);
    const boundaryValues = {
      ROOT_ID: run.root_id, TASK_ID: String(task.task_id), ATTEMPT_ID: String(attempt.attempt_id),
      ACTOR_TOKEN: actorToken, HOME: stateStore.runtimeRoot(), SKILL_DIR,
    };
    const env = runtimeEnv.exportEnvironment(boundaryValues, { base: process.env, scrubIdentity: true });
    return {
      run, task, attempt, launch, boundaryValues,
      request: new SpawnRequest(
        prompt, String(run.cwd), String(launch.session_name), attempt.model_name ?? null,
        Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
        JSON.parse(String(attempt.config_json)),
        {
          root_id: String(run.root_id), task_id: String(task.task_id),
          attempt_id: String(attempt.attempt_id), launch_id: String(launch.launch_id),
        },
      ),
    };
  }, false);
  const backend = adapter ?? backends.resolveSpawnBackend(prepared.launch);
  if (backend.supportsHooks()) hookManager.ensureProjectHooks(prepared.request.cwd, String(payload.root_id));
  const result = runtimeEnv.withProcessBoundary(prepared.boundaryValues, () => spawnCall(backend, prepared.request));
  if (backend.supportsHooks()) hookManager.ensureProjectHooks(prepared.request.cwd, String(payload.root_id));

  stateStore.transaction((connection) => {
    const run = stateStore.getRun(String(payload.root_id), connection);
    const task = stateStore.getTask(Number(payload.task_id), connection);
    const attempt = stateStore.getAttempt(Number(payload.attempt_id), connection);
    const launch = stateStore.getLaunch(Number(payload.launch_id), connection);
    const currentAttempt = task ? stateStore.getCurrentAttempt(Number(task.task_id), connection) : null;
    const currentLaunch = attempt ? stateStore.getCurrentLaunch(Number(attempt.attempt_id), connection) : null;
    const expected = Boolean(
      run?.status === "running" && task && attempt && launch &&
      currentAttempt?.attempt_id === attempt.attempt_id && currentLaunch?.launch_id === launch.launch_id &&
      new Set(["assigned", "evaluating", "active", "waiting"]).has(String(attempt.state)) &&
      new Set(["starting", "running"]).has(String(launch.status)),
    );
    const timestamp = stateStore.now();
    if (!expected) {
      const completedBeforeAck = Boolean(launch?.ready_at !== null && launch?.status === "closed" && attempt &&
        new Set(["done", "failed", "cancelled"]).has(String(attempt.state)));
      if (run && task && attempt && launch && !completedBeforeAck) enqueueStop(connection, run, task, attempt, launch, "spawn_compensation");
      connection.execute("UPDATE effects SET status='completed', completed_at=?, last_error=? WHERE id=?", [
        timestamp, completedBeforeAck ? "spawn acknowledged after Attempt completed" : "spawn compensated after state changed", effect.id,
      ]);
      return;
    }
    connection.execute(
      `UPDATE launches SET backend_ref=COALESCE(backend_ref, ?),
        status=CASE WHEN status='starting' THEN 'running' ELSE status END,
        prompt_state=CASE WHEN prompt_state='pending' THEN 'in_flight' ELSE prompt_state END,
        ready_at=COALESCE(ready_at, ?), last_event_at=? WHERE launch_id=?`,
      [result.job_id ?? null, timestamp, timestamp, launch!.launch_id],
    );
    connection.execute(
      `UPDATE attempts SET state=CASE WHEN state='assigned' THEN 'evaluating' ELSE state END,
       started_at=COALESCE(started_at, ?), heartbeat_at=? WHERE attempt_id=?`,
      [timestamp, timestamp, attempt!.attempt_id],
    );
    connection.execute("UPDATE tasks SET status='active' WHERE task_id=? AND status='assigned'", [task!.task_id]);
    connection.execute("UPDATE effects SET status='completed', completed_at=?, last_error=NULL WHERE id=?", [timestamp, effect.id]);
    stateStore.appendEvent(connection, String(run!.root_id), "AgentProcessStarted", {
      launch_id: launch!.launch_id, backend_ref: result.job_id ?? null, backend_id: launch!.backend_id,
    }, Number(task!.task_id), Number(attempt!.attempt_id));
  });
}

function spawnFailed(effect: RuntimeRecord, payload: RuntimeRecord, failure: unknown): void {
  const reason = message(failure);
  stateStore.transaction((connection) => {
    connection.execute("UPDATE effects SET status='failed', last_error=? WHERE id=?", [reason, effect.id]);
    const run = stateStore.getRun(String(payload.root_id), connection);
    const task = stateStore.getTask(Number(payload.task_id), connection);
    const attempt = stateStore.getAttempt(Number(payload.attempt_id), connection);
    const launch = stateStore.getLaunch(Number(payload.launch_id), connection);
    const current = task ? stateStore.getCurrentAttempt(Number(task.task_id), connection) : null;
    if (!run || !task || !attempt || !launch || !current || current.attempt_id !== attempt.attempt_id ||
        !new Set(["assigned", "evaluating"]).has(String(attempt.state))) return;
    const finished = stateStore.now();
    const result = { status: "failed", retryable: true, summary: reason, caveats: [] };
    connection.execute(
      `UPDATE attempts SET state='failed', retryable=1, result_json=?, last_error=?, finished_at=? WHERE attempt_id=?`,
      [canonicalJson(result), reason, finished, attempt.attempt_id],
    );
    connection.execute(
      `UPDATE launches SET status='closed', prompt_state='cancelled', exit_reason=?, closed_at=?, last_event_at=? WHERE launch_id=?`,
      [reason, finished, finished, launch.launch_id],
    );
    if (Number(attempt.attempt_no) < Number(run.max_attempts_per_task)) {
      connection.execute("UPDATE tasks SET status='ready' WHERE task_id=?", [task.task_id]);
      stateStore.appendEvent(connection, String(run.root_id), "TaskRetryScheduled", { reason: "spawn_failed" }, Number(task.task_id), Number(attempt.attempt_id));
    } else connection.execute("UPDATE tasks SET status='failed', finished_at=? WHERE task_id=?", [finished, task.task_id]);
    stateStore.appendEvent(connection, String(run.root_id), "AgentSpawnFailed", { launch_id: launch.launch_id, error: reason }, Number(task.task_id), Number(attempt.attempt_id));
    scheduler.scheduleWithConnection(connection, String(run.root_id));
  });
}

function stopEffect(effect: RuntimeRecord, payload: RuntimeRecord, adapter?: AgentBackend): void {
  const launch = stateStore.getLaunch(Number(payload.launch_id));
  if (!launch) throw new StaleEffect("stop effect launch no longer exists");
  const backend = adapter ?? backends.resolveExecutionBackend(launch);
  backend.stop(new StopRequest(
    launch.backend_ref ?? null, launch.session_name ?? null,
    stateStore.getRun(String(launch.root_id))?.cwd ?? null, payload.reason ?? null,
  ));
  stateStore.transaction((connection) => {
    const timestamp = stateStore.now();
    connection.execute(
      `UPDATE launches SET status='closed', prompt_state='cancelled', closed_at=COALESCE(closed_at, ?), last_event_at=? WHERE launch_id=?`,
      [timestamp, timestamp, launch.launch_id],
    );
    connection.execute(
      "UPDATE acp_sessions SET status='closed', closed_at=COALESCE(closed_at, ?) WHERE launch_id=? AND status='active'",
      [timestamp, launch.launch_id],
    );
    connection.execute("UPDATE effects SET status='completed', completed_at=?, last_error=NULL WHERE id=?", [timestamp, effect.id]);
    let retryScheduled = false;
    if (payload.retry_task_id) {
      const task = stateStore.getTask(Number(payload.retry_task_id), connection);
      const attempt = stateStore.getAttempt(Number(launch.attempt_id), connection);
      const current = task ? stateStore.getCurrentAttempt(Number(payload.retry_task_id), connection) : null;
      if (task && attempt && current?.attempt_id === attempt.attempt_id && task.status === "stopping" && attempt.state === "failed") {
        connection.execute("UPDATE tasks SET status='ready' WHERE task_id=?", [payload.retry_task_id]);
        scheduler.scheduleWithConnection(connection, String(payload.root_id));
        retryScheduled = true;
      }
    }
    stateStore.appendEvent(connection, String(payload.root_id), "AgentStopped", {
      launch_id: launch.launch_id, retry_scheduled: retryScheduled,
    }, Number(launch.task_id), Number(launch.attempt_id));
  });
}

export function drain(rootId: string, adapter?: AgentBackend, maxEffects?: number | null): RuntimeRecord {
  const run = stateStore.getRun(rootId);
  const automaticLimit = run ? Number(run.max_total_tasks) * Number(run.max_attempts_per_task) + 100 : 1000;
  const limit = maxEffects === null || maxEffects === undefined ? automaticLimit : Math.max(0, Math.trunc(maxEffects));
  const summary: RuntimeRecord = { claimed: 0, completed: 0, failed: 0, stale: 0, deferred: 0 };
  let processed = 0;
  while (processed < limit) {
    const effect = stateStore.fetchall(
      "SELECT * FROM effects WHERE root_id=? AND status='pending' ORDER BY id LIMIT 1", [rootId],
    )[0];
    if (!effect) break;
    if (!claim(Number(effect.id))) continue;
    processed += 1;
    summary.claimed += 1;
    const payload = JSON.parse(String(effect.payload_json)) as RuntimeRecord;
    try {
      if (effect.effect_type === "spawn_agent") spawnEffect(effect, payload, adapter);
      else if (effect.effect_type === "stop_agent") stopEffect(effect, payload, adapter);
      else throw new RuntimeError(`unsupported effect: ${effect.effect_type}`);
      summary.completed += 1;
    } catch (error) {
      if (error instanceof StaleEffect) {
        stateStore.transaction((connection) => connection.execute(
          "UPDATE effects SET status='completed', completed_at=?, last_error=? WHERE id=?",
          [stateStore.now(), error.message, effect.id],
        ));
        summary.stale += 1;
      } else if (error instanceof BackendPendingError || error instanceof BackendUnknownError) {
        stateStore.transaction((connection) => connection.execute(
          "UPDATE effects SET status='pending', claimed_at=NULL, last_error=? WHERE id=?",
          [error.message, effect.id],
        ));
        summary.deferred += 1;
        break;
      } else {
        if (effect.effect_type === "spawn_agent") spawnFailed(effect, payload, error);
        else stateStore.transaction((connection) => connection.execute(
          "UPDATE effects SET status='failed', last_error=? WHERE id=?", [message(error), effect.id],
        ));
        summary.failed += 1;
      }
    }
  }
  return summary;
}
