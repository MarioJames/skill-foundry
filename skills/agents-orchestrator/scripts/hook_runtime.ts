#!/usr/bin/env bun
import * as compatEnv from "./compat_env.ts";
import * as hookManager from "./hook_manager.ts";
import * as stateStore from "./state_store.ts";
import { RuntimeError, ValueError, type RuntimeRecord } from "./runtime_types.ts";

export const OWNER_LEASE_SECONDS = 15 * 60;

function verifyOwner(run: RuntimeRecord, token: string): void {
  if (!stateStore.tokenMatches(token, run.owner_token_hash)) throw new RuntimeError("invalid owner token");
}

export function heartbeat(rootId: string, taskId: number, attemptId: number, actorToken: string): RuntimeRecord {
  return stateStore.transaction((connection) => {
    const run = stateStore.getRun(rootId, connection);
    const task = stateStore.getTask(taskId, connection);
    const attempt = stateStore.getAttempt(attemptId, connection);
    if (!run || !task || !attempt || task.root_id !== rootId || attempt.root_id !== rootId || attempt.task_id !== taskId) {
      throw new RuntimeError("invalid heartbeat binding");
    }
    if (!stateStore.tokenMatches(actorToken, attempt.actor_token_hash)) throw new RuntimeError("invalid actor token");
    const current = stateStore.getCurrentAttempt(taskId, connection);
    if (!current || current.attempt_id !== attemptId) return { accepted: false, stale_attempt: true };
    if (run.status !== "running" || new Set(["done", "failed", "cancelled"]).has(String(attempt.state))) {
      return { accepted: false, terminal: true };
    }
    const timestamp = stateStore.now();
    connection.execute("UPDATE attempts SET heartbeat_at=? WHERE attempt_id=?", [timestamp, attemptId]);
    let leaseExpiresAt = run.lease_expires_at;
    if (taskId === run.root_task_id) {
      verifyOwner(run, actorToken);
      if (leaseExpiresAt && Number(leaseExpiresAt) < timestamp) throw new RuntimeError("root owner lease expired; recover the run");
      leaseExpiresAt = timestamp + OWNER_LEASE_SECONDS;
      connection.execute("UPDATE runs SET lease_expires_at=?, updated_at=? WHERE root_id=?", [leaseExpiresAt, timestamp, rootId]);
    }
    return { accepted: true, heartbeat_at: timestamp, lease_expires_at: leaseExpiresAt };
  });
}

export function observeSessionEnd(rootId: string, taskId: number, attemptId: number, actorToken: string): RuntimeRecord {
  return stateStore.transaction((connection) => {
    const run = stateStore.getRun(rootId, connection);
    const task = stateStore.getTask(taskId, connection);
    const attempt = stateStore.getAttempt(attemptId, connection);
    if (!run || !task || !attempt) throw new RuntimeError("invalid SessionEnd binding");
    if (task.root_id !== rootId || attempt.task_id !== taskId || !stateStore.tokenMatches(actorToken, attempt.actor_token_hash)) {
      throw new RuntimeError("invalid SessionEnd identity");
    }
    stateStore.appendEvent(connection, rootId, "SessionEndObserved", { attempt_state: attempt.state }, taskId, attemptId);
    return { observed: true, attempt_id: attemptId, state: attempt.state };
  });
}

function authorizeRead(rootId: string, actorToken: string): RuntimeRecord {
  stateStore.initializeSchema();
  const run = stateStore.getRun(rootId);
  if (!run) throw new ValueError("run not found");
  if (!stateStore.listAttempts(rootId).some((attempt) => stateStore.tokenMatches(actorToken, attempt.actor_token_hash))) {
    throw new ValueError("invalid actor token");
  }
  return run;
}

export function inspectCurrent(rootId: string, taskId: number, actorToken: string): RuntimeRecord {
  authorizeRead(rootId, actorToken);
  const task = stateStore.getTask(taskId);
  if (!task || task.root_id !== rootId) throw new ValueError("current task does not belong to the authorized run");
  const attempt = stateStore.getCurrentAttempt(taskId);
  if (!attempt || attempt.root_id !== rootId || attempt.task_id !== taskId) throw new ValueError("current attempt binding is invalid");
  const launch = stateStore.getCurrentLaunch(Number(attempt.attempt_id));
  const session = launch ? stateStore.getSessionForLaunch(Number(launch.launch_id)) : null;
  return { run: stateStore.getRun(rootId), task, attempt, launch, session };
}

function identity(): { rootId: string; taskId: number; attemptId: number; actorToken: string } {
  // Validate configuration aliases at the same boundary as the four identity fields.
  compatEnv.value("HOME");
  compatEnv.value("SKILL_DIR");
  const values = compatEnv.validateIdentity();
  const rootId = values.ROOT_ID;
  const actorToken = values.ACTOR_TOKEN;
  if (!rootId || !actorToken || !values.TASK_ID || !values.ATTEMPT_ID) throw new ValueError("missing orchestration identity");
  const taskId = Number(values.TASK_ID);
  const attemptId = Number(values.ATTEMPT_ID);
  if (!Number.isSafeInteger(taskId) || !Number.isSafeInteger(attemptId)) throw new ValueError("orchestration task and attempt IDs must be integers");
  Object.assign(process.env, compatEnv.exportBoth({ ROOT_ID: rootId, TASK_ID: taskId, ATTEMPT_ID: attemptId, ACTOR_TOKEN: actorToken }));
  return { rootId, taskId, attemptId, actorToken };
}

function optionalIdentity(): ReturnType<typeof identity> | null {
  const values = compatEnv.validateIdentity();
  if (!values.ROOT_ID && !values.TASK_ID && !values.ATTEMPT_ID && !values.ACTOR_TOKEN) return null;
  return identity();
}

function hookInput(value: unknown): RuntimeRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RuntimeRecord : {};
}

function skipped(reason: string): RuntimeRecord { return { skipped: true, reason }; }

export function handleHookEvent(kind: string, rawInput: unknown): RuntimeRecord {
  const input = hookInput(rawInput);
  const event = String(input.hook_event_name ?? input.event_name ?? "");
  const expected: Readonly<Record<string, ReadonlySet<string>>> = {
    heartbeat: new Set(["SessionStart", "PostToolUse"]),
    failure: new Set(["PostToolUseFailure"]),
    finish: new Set(["Stop"]),
    clean: new Set(["SessionEnd"]),
  };
  const events = expected[kind];
  if (!events) throw new ValueError("unknown hook event kind");
  if (!events.has(event)) return skipped(`not ${[...events].join(" or ")}`);
  if (kind === "finish" && input.stop_hook_active === true) return {};
  const current = optionalIdentity();
  if (current === null) return skipped("missing orchestration identity");
  if (kind === "failure") {
    return {
      hookSpecificOutput: {
        hookEventName: "PostToolUseFailure",
        additionalContext: "Agents Orchestrator observed a tool failure. Inspect the error before proceeding; retry safely or revise the estimate. Record only reusable pitfalls with write_note, and do not claim completion without the Runtime finish action.",
      },
    };
  }
  if (kind === "heartbeat") {
    if (stateStore.getRun(current.rootId)) hookManager.ensureProjectHooks(process.cwd(), current.rootId);
    return heartbeat(current.rootId, current.taskId, current.attemptId, current.actorToken);
  }
  if (kind === "clean") {
    return observeSessionEnd(current.rootId, current.taskId, current.attemptId, current.actorToken);
  }
  try {
    const inspected = inspectCurrent(current.rootId, current.taskId, current.actorToken);
    const task = inspected.task as RuntimeRecord;
    const attempt = inspected.attempt as RuntimeRecord;
    const terminalTask = new Set(["done", "failed", "blocked", "cancelled"]).has(String(task.status));
    const terminalAttempt = new Set(["done", "failed", "cancelled"]).has(String(attempt.state));
    if (!terminalTask || !terminalAttempt) {
      return {
        decision: "block",
        reason: "Agents Orchestrator Runtime requires this Attempt to submit finish before the Claude session can stop. Submit finish with validation and caveats, or report a failed finish when appropriate.",
      };
    }
  } catch {
    // An unavailable inspection must not create an unbounded Stop loop. Runtime
    // Actions remain authoritative for every lifecycle transition.
  }
  return {};
}

if (import.meta.main) {
  try {
    const command = process.argv[2];
    let result: RuntimeRecord;
    if (command === "hook-event") {
      let input: unknown = {};
      try { input = JSON.parse(await Bun.stdin.text()); } catch { /* missing event is skipped */ }
      result = handleHookEvent(String(process.argv[3] ?? ""), input);
    } else {
      const current = identity();
      if (command === "heartbeat") {
      if (stateStore.getRun(current.rootId)) hookManager.ensureProjectHooks(process.cwd(), current.rootId);
      result = heartbeat(current.rootId, current.taskId, current.attemptId, current.actorToken);
      } else if (command === "inspect-current") result = inspectCurrent(current.rootId, current.taskId, current.actorToken);
      else if (command === "session-end") result = observeSessionEnd(current.rootId, current.taskId, current.attemptId, current.actorToken);
      else throw new ValueError("command must be hook-event, heartbeat, inspect-current, or session-end");
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "hook runtime failed"}\n`);
    process.exit(2);
  }
}
