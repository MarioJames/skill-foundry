import { describe, expect, test } from "bun:test";

import { initializeRun } from "../scripts/agent_orchestrator.ts";
import * as actionProcessor from "../scripts/action_processor.ts";
import * as outbox from "../scripts/outbox.ts";
import * as recovery from "../scripts/recovery.ts";
import * as scheduler from "../scripts/scheduler.ts";
import * as stateStore from "../scripts/state_store.ts";
import {
  AgentBackend,
  BackendPendingError,
  BackendUnknownError,
  ObserveResult,
  SpawnRequest,
  SpawnResult,
  StopRequest,
} from "../scripts/backends/base.ts";
import { ClaudeCliBackend } from "../scripts/backends/claude_cli.ts";
import { resolveExecutionBackend } from "../scripts/backends/index.ts";
import { insertReadyChild, isolatedRuntime } from "./helpers.ts";
import type { RuntimeRecord } from "../scripts/runtime_types.ts";

class StubBackend extends AgentBackend {
  readonly backendId = "stub";
  readonly requests: SpawnRequest[] = [];
  readonly stops: StopRequest[] = [];
  presence: "present" | "absent" | "unknown";
  spawnError: Error | null;

  constructor(options: {
    presence?: "present" | "absent" | "unknown";
    spawnError?: Error | null;
  } = {}) {
    super();
    this.presence = options.presence ?? "present";
    this.spawnError = options.spawnError ?? null;
  }

  spawn(request: SpawnRequest): SpawnResult {
    this.requests.push(request);
    if (this.spawnError) throw this.spawnError;
    return new SpawnResult(`job-${request.metadata.launch_id}`, request.sessionName);
  }

  stop(request: StopRequest): RuntimeRecord {
    this.stops.push(request);
    return { stopped: true };
  }

  observe(): ObserveResult {
    // This nested transaction proves recovery does not hold a write transaction
    // while observing an external process.
    stateStore.transaction((connection) => connection.execute("SELECT 1"));
    return new ObserveResult(this.presence);
  }

  listSessions(): RuntimeRecord[] { return []; }
  supportsHooks(): boolean { return false; }
}

function run(cwd: string, options: RuntimeRecord = {}): RuntimeRecord {
  return initializeRun("root", cwd, {
    backend: "claude_cli",
    requireFinalReview: false,
    ...options,
  });
}

function child(identity: RuntimeRecord): RuntimeRecord {
  stateStore.transaction((connection) => {
    insertReadyChild(connection, stateStore.getRun(String(identity.root_id), connection)!);
  });
  return scheduler.schedule(String(identity.root_id))[0]!;
}

function envelope(identity: RuntimeRecord, type: string, payload: RuntimeRecord, actionId: string): RuntimeRecord {
  return { schema_version: 1, action_id: actionId, root_id: identity.root_id,
    task_id: identity.task_id, attempt_id: identity.attempt_id,
    actor_token: identity.actor_token, type, payload };
}

function estimate(identity: RuntimeRecord): void {
  actionProcessor.processAction(envelope(identity, "submit_estimate", {
    revision: false, strategy: "direct", resolved_intent: "implement", complexity: "low",
    concerns: [], unknowns: [], estimated_files: [], reason: "contract test",
  }, "root-estimate"));
}

describe("backend and effect contracts", () => {
  test("Claude backend implements the common contract and resolver uses persisted backend", () => {
    expect(new ClaudeCliBackend()).toBeInstanceOf(AgentBackend);
    expect(resolveExecutionBackend({ backend_id: "claude_cli", config_json: '{"command":"claude"}' })).toBeInstanceOf(ClaudeCliBackend);
  });

  test("spawn receives Launch metadata, no legacy agent ID, and executes exactly once", async () => isolatedRuntime(({ cwd }) => {
    const identity = run(cwd);
    const created = child(identity);
    const backend = new StubBackend();
    const result = outbox.drain(String(identity.root_id), backend, 1);
    expect(result.completed).toBe(1);
    expect(backend.requests).toHaveLength(1);
    const request = backend.requests[0]!;
    expect(request.metadata.launch_id).toBe(String(created.launch_id));
    expect(request.metadata.agent_id).toBeUndefined();
    expect(request.env.AGENT_SWARM_AGENT_ID).toBeUndefined();
    expect(stateStore.getAttempt(Number(created.attempt_id))!.state).toBe("evaluating");
    expect(stateStore.getLaunch(Number(created.launch_id))!.status).toBe("running");
    expect(outbox.drain(String(identity.root_id), backend, 1).claimed).toBe(0);
    expect(backend.requests).toHaveLength(1);
  }));

  test("business TypeError is not retried through another backend signature", async () => isolatedRuntime(({ cwd }) => {
    const identity = run(cwd);
    child(identity);
    const backend = new StubBackend({ spawnError: new TypeError("business type error") });
    expect(outbox.drain(String(identity.root_id), backend, 1).failed).toBe(1);
    expect(backend.requests).toHaveLength(1);
  }));

  test("stale spawn effect cannot act on a newer Launch", async () => isolatedRuntime(({ cwd }) => {
    const identity = run(cwd);
    const created = child(identity);
    let nextLaunch = 0;
    stateStore.transaction((connection) => {
      const old = stateStore.getLaunch(Number(created.launch_id), connection)!;
      connection.execute("UPDATE launches SET status='closed', closed_at=? WHERE launch_id=?", [stateStore.now(), old.launch_id]);
      nextLaunch = Number(connection.execute(
        `INSERT INTO launches(attempt_id, launch_no, session_name, status, prompt_state, created_at, last_event_at)
         VALUES (?, 2, ?, 'starting', 'pending', ?, ?)`,
        [created.attempt_id, old.session_name, stateStore.now(), stateStore.now()],
      ).lastrowid);
    });
    const backend = new StubBackend();
    expect(outbox.drain(String(identity.root_id), backend, 1).stale).toBe(1);
    expect(backend.requests).toEqual([]);
    expect(stateStore.getCurrentLaunch(Number(created.attempt_id))!.launch_id).toBe(nextLaunch);
  }));
});

describe("reconciliation and stop ordering", () => {
  test("terminal Launch stays open while backend is present and closes after absence", async () => isolatedRuntime(({ cwd }) => {
    const identity = run(cwd);
    const created = child(identity);
    const backend = new StubBackend();
    outbox.drain(String(identity.root_id), backend);
    stateStore.transaction((connection) => {
      connection.execute("UPDATE attempts SET state='done' WHERE attempt_id=?", [created.attempt_id]);
      connection.execute("UPDATE tasks SET status='done' WHERE task_id=?", [created.task_id]);
    });
    recovery.reapChildren(String(identity.root_id), String(identity.actor_token), backend);
    expect(stateStore.getLaunch(Number(created.launch_id))!.status).toBe("running");
    backend.presence = "absent";
    recovery.reapChildren(String(identity.root_id), String(identity.actor_token), backend);
    expect(stateStore.getLaunch(Number(created.launch_id))!.status).toBe("closed");
  }));

  test("pending and unknown spawn outcomes preserve a single assigned Attempt", async () => {
    for (const failure of [new BackendPendingError("pending"), new BackendUnknownError("unknown")]) {
      await isolatedRuntime(({ cwd }) => {
        const identity = run(cwd);
        const created = child(identity);
        expect(outbox.drain(String(identity.root_id), new StubBackend({ spawnError: failure })).deferred).toBe(1);
        expect(stateStore.getAttempt(Number(created.attempt_id))!.state).toBe("assigned");
        expect(stateStore.listAttempts(String(identity.root_id)).filter((item) => item.task_id === created.task_id)).toHaveLength(1);
      });
    }
  });

  test("turn-end reconciliation is idempotent and appends one retry Attempt", async () => isolatedRuntime(({ cwd }) => {
    const identity = run(cwd);
    const created = child(identity);
    const backend = new StubBackend();
    outbox.drain(String(identity.root_id), backend);
    stateStore.execute(
      "UPDATE launches SET status='closed', prompt_state='ended', exit_reason='without_finish', closed_at=? WHERE launch_id=?",
      [stateStore.now(), created.launch_id],
    );
    recovery.reapChildren(String(identity.root_id), String(identity.actor_token), backend);
    recovery.reapChildren(String(identity.root_id), String(identity.actor_token), backend);
    const attempts = stateStore.listAttempts(String(identity.root_id)).filter((item) => item.task_id === created.task_id);
    expect(attempts).toHaveLength(2);
    expect(attempts.map((item) => item.state)).toEqual(["failed", "assigned"]);
  }));

  test("unready starting Launch absence does not consume the Attempt", async () => isolatedRuntime(({ cwd }) => {
    const identity = run(cwd);
    const created = child(identity);
    const report = recovery.reapChildren(String(identity.root_id), String(identity.actor_token), new StubBackend({ presence: "absent" }));
    expect(report.reconciled[0].outcome).toBe("starting_absent");
    expect(stateStore.getAttempt(Number(created.attempt_id))!.state).toBe("assigned");
  }));

  test("root finish rejects a child Launch still observed as open", async () => isolatedRuntime(({ cwd }) => {
    const identity = run(cwd);
    const created = child(identity);
    outbox.drain(String(identity.root_id), new StubBackend());
    stateStore.transaction((connection) => {
      connection.execute("UPDATE attempts SET state='done', result_json='{}' WHERE attempt_id=?", [created.attempt_id]);
      connection.execute("UPDATE tasks SET status='done' WHERE task_id=?", [created.task_id]);
    });
    estimate(identity);
    expect(() => actionProcessor.processAction(envelope(identity, "finish", {
      status: "done", summary: "done", changed_files: [], artifacts: [], caveats: [],
      validation: null, review: null, mode_result: null,
      integration_check: { status: "passed", summary: "ok" },
    }, "root-finish"))).toThrow("open launches");
  }));

  test("stop fences and closes every Launch before terminal Run state", async () => isolatedRuntime(({ cwd }) => {
    const identity = run(cwd, { maxConcurrentAgents: 4 });
    child(identity);
    const backend = new StubBackend();
    outbox.drain(String(identity.root_id), backend);
    child(identity);
    outbox.drain(String(identity.root_id), backend);
    const stopped = recovery.stopRun(String(identity.root_id), String(identity.actor_token), backend);
    expect(stopped.status).toBe("cancelled");
    expect(backend.stops).toHaveLength(2);
    expect(stateStore.listLaunches(String(identity.root_id)).every((item) => item.status === "closed")).toBe(true);
  }));
});
