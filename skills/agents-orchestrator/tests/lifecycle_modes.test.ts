import { describe, expect, test } from "bun:test";

import * as actionProcessor from "../scripts/action_processor.ts";
import { initializeRun, ACTION_SCHEMAS, entryMode } from "../scripts/agent_orchestrator.ts";
import * as executionSecrets from "../scripts/execution_secrets.ts";
import * as modeModels from "../scripts/mode_models.ts";
import * as recovery from "../scripts/recovery.ts";
import * as scheduler from "../scripts/scheduler.ts";
import * as stateStore from "../scripts/state_store.ts";
import * as promptBuilder from "../scripts/prompt_builder.ts";
import { isolatedRuntime } from "./helpers.ts";
import type { RuntimeRecord } from "../scripts/runtime_types.ts";

function envelope(identity: RuntimeRecord, type: string, payload: RuntimeRecord, actionId: string, override: RuntimeRecord = {}): RuntimeRecord {
  return {
    schema_version: 1, action_id: actionId, root_id: identity.root_id,
    task_id: override.task_id ?? identity.task_id, attempt_id: override.attempt_id ?? identity.attempt_id,
    actor_token: override.actor_token ?? identity.actor_token, type, payload,
  };
}

function estimate(identity: RuntimeRecord, strategy = "split", actionId = "estimate"): RuntimeRecord {
  return actionProcessor.processAction(envelope(identity, "submit_estimate", {
    revision: false, strategy, resolved_intent: "implement", complexity: "high",
    concerns: [], unknowns: [], estimated_files: [], reason: "deterministic test",
  }, actionId));
}

function initialize(cwd: string, acp = false): RuntimeRecord {
  const identity = initializeRun("mode root", cwd, acp ? {
    requireFinalReview: false, maxConcurrentAgents: 20, backend: "acp", acpAgent: "custom",
    acpCommand: "/bin/true", acpArgs: [],
  } : { requireFinalReview: false, maxConcurrentAgents: 20, backend: "claude_cli" });
  estimate(identity);
  return identity;
}

function markDone(connection: stateStore.Connection, taskId: number, modeResult: RuntimeRecord): void {
  const attempt = stateStore.getCurrentAttempt(taskId, connection);
  const timestamp = stateStore.now();
  const encoded = JSON.stringify({ mode_result: modeResult });
  let attemptId: number;
  if (!attempt) {
    const cursor = connection.execute(
      `INSERT INTO attempts(task_id, attempt_no, state, actor_token_hash, backend_id,
        agent_type, config_json, result_json, created_at, finished_at)
       VALUES (?, 1, 'done', 'fixture', 'fixture', 'fixture', '{}', ?, ?, ?)`,
      [taskId, encoded, timestamp, timestamp],
    );
    attemptId = Number(cursor.lastrowid);
  } else {
    attemptId = Number(attempt.attempt_id);
    connection.execute("UPDATE attempts SET state='done', retryable=0, result_json=?, finished_at=? WHERE attempt_id=?", [encoded, timestamp, attemptId]);
    const launch = stateStore.getCurrentLaunch(attemptId, connection);
    if (launch) {
      connection.execute("UPDATE launches SET status='closed', prompt_state='ended', closed_at=?, last_event_at=? WHERE launch_id=?", [timestamp, timestamp, launch.launch_id]);
      connection.execute("UPDATE effects SET status='completed', completed_at=? WHERE launch_id=? AND status IN ('pending','running')", [timestamp, launch.launch_id]);
    }
  }
  connection.execute("UPDATE tasks SET status='done', finished_at=? WHERE task_id=?", [timestamp, taskId]);
  connection.execute("UPDATE mode_tasks SET result_validated=1 WHERE task_id=?", [taskId]);
}

describe("Task / Attempt / Launch lifecycle", () => {
  test("split tasks preserve dependencies and immutable execution snapshots", async () => isolatedRuntime(({ cwd }) => {
    const identity = initialize(cwd, true);
    const created = actionProcessor.processAction(envelope(identity, "create_tasks", { tasks: [
      { key: "a", goal: "A", intent_hint: "implement", output_contract: "A done" },
      { key: "b", goal: "B", intent_hint: "review", output_contract: "B done", depends_on: [{ task_key: "a", condition: "success" }] },
    ] }, "create"));
    expect(created.tasks).toHaveLength(2);
    const firstTaskId = created.tasks[0]!.task_id;
    const first = stateStore.getCurrentAttempt(firstTaskId)!;
    const snapshot = JSON.parse(first.config_json);
    expect(snapshot.backend).toBe("acp");
    expect(snapshot.command).toBe("/bin/true");
    stateStore.transaction((connection) => {
      connection.execute("UPDATE attempts SET state='done', result_json='{}', finished_at=? WHERE attempt_id=?", [stateStore.now(), first.attempt_id]);
      connection.execute("UPDATE tasks SET status='done', finished_at=? WHERE task_id=?", [stateStore.now(), first.task_id]);
    });
    expect(scheduler.schedule(identity.root_id)).toHaveLength(1);
    expect(JSON.parse(stateStore.getAttempt(first.attempt_id)!.config_json)).toEqual(snapshot);
  }));

  test("action IDs are idempotent and terminal Attempts cannot be reused", async () => isolatedRuntime(({ cwd }) => {
    const identity = initializeRun("direct", cwd, { requireFinalReview: false, backend: "claude_cli" });
    const first = estimate(identity, "direct", "same-action");
    expect(actionProcessor.processAction(envelope(identity, "submit_estimate", {}, "same-action"))).toEqual(first);
    const finished = actionProcessor.processAction(envelope(identity, "finish", {
      status: "done", retryable: false, summary: "done", changed_files: [], artifacts: [],
      validation: { status: "passed" }, review: null,
      integration_check: null, caveats: [],
    }, "finish"));
    expect(finished.accepted).toBe(true);
    expect(() => actionProcessor.processAction(envelope(identity, "write_note", {
      category: "note", content: "late", scope: "task",
    }, "late"))).toThrow("run is not running");
  }));

  test("recovery appends a new root Attempt and doctor reports durable facts", async () => isolatedRuntime(({ cwd }) => {
    const identity = initializeRun("recover", cwd, { requireFinalReview: false, backend: "claude_cli" });
    stateStore.execute("UPDATE runs SET status='failed', lease_expires_at=? WHERE root_id=?", [stateStore.now() - 1, identity.root_id]);
    const recovered = recovery.recoverRoot(identity.root_id);
    expect(recovered.attempt_id).not.toBe(identity.attempt_id);
    expect(stateStore.listAttempts(identity.root_id)).toHaveLength(2);
    expect(recovery.doctor(identity.root_id).run_status).toBe("running");
  }));
});

describe("persistent modes", () => {
  test("entry hints remain separate from mode creation", async () => isolatedRuntime(({ cwd }) => {
    expect(entryMode("loop", {})).toBe("develop_review_improve");
    const identity = initializeRun("hint", cwd, { backend: "claude_cli", entryMode: "swarm", requireFinalReview: false });
    expect(stateStore.inspectModes(identity.root_id)).toEqual([]);
    expect(ACTION_SCHEMAS.start_mode).toBeDefined();
    expect(() => actionProcessor.processAction(envelope(identity, "start_mode", {
      mode: "swarm", objective: "too early", tasks: [],
    }, "early"))).toThrow("not an available capability");
  }));

  test("swarm compiles child Tasks, propagates evidence, and can cancel", async () => isolatedRuntime(({ cwd }) => {
    const identity = initialize(cwd);
    const started = actionProcessor.processAction(envelope(identity, "start_mode", {
      mode: "swarm", objective: "parallel work", evidence: { content: "EVIDENCE_SENTINEL" }, tasks: [
        { key: "one", goal: "One", intent_hint: "implement", output_contract: "One result" },
        { key: "two", goal: "Two", intent_hint: "review", output_contract: "Two result" },
      ],
    }, "start-swarm"));
    expect(started.task_ids).toHaveLength(2);
    expect(stateStore.inspectModes(identity.root_id, started.mode_id)[0]!.tasks).toHaveLength(2);
    const childTask = stateStore.getTask(started.task_ids[0])!;
    const childAttempt = stateStore.getCurrentAttempt(started.task_ids[0])!;
    const prompt = stateStore.transaction((connection) => promptBuilder.buildPrompt(
      stateStore.getRun(identity.root_id, connection)!, childTask, childAttempt, connection,
    ), false);
    expect(prompt).toContain("EVIDENCE_SENTINEL");
    const cancelled = actionProcessor.processAction(envelope(identity, "advance_mode", {
      mode_id: started.mode_id, operation: "cancel", reason: "test cancellation",
    }, "cancel-swarm"));
    expect(cancelled.status).toBe("cancelled");
  }));

  test("develop-review-improve advances through bounded phases and detects no progress", async () => isolatedRuntime(({ cwd }) => {
    const identity = initialize(cwd);
    const started = actionProcessor.processAction(envelope(identity, "start_mode", {
      mode: "develop-review-improve", objective: "bounded loop", config: { max_rounds: 1, max_no_progress: 1 },
    }, "start-loop"));
    expect(started.phase).toBe("develop");
    stateStore.transaction((connection) => markDone(connection, started.task_ids[0], {
      summary: "developed", state: { version: 1 }, evidence: ["implementation"],
    }));
    const validation = actionProcessor.processAction(envelope(identity, "advance_mode", { mode_id: started.mode_id }, "advance-validation"));
    expect(validation.phase).toBe("validate");
    const repeated = actionProcessor.processAction(envelope(identity, "start_mode", {
      mode: "develop_review_improve", objective: "repeat", config: { max_no_progress: 1 },
    }, "repeat-start"));
    expect(actionProcessor.processAction(envelope(identity, "advance_mode", { mode_id: repeated.mode_id }, "repeat-one")).status).toBe("running");
    const blocked = actionProcessor.processAction(envelope(identity, "advance_mode", { mode_id: repeated.mode_id }, "repeat-two"));
    expect(blocked.status).toBe("blocked");
    expect(blocked.reason).toContain("repeated-state");
  }));

  test("multi-session review is ACP-only and creates at least three independent reviewers", async () => {
    await isolatedRuntime(({ cwd }) => {
      const identity = initialize(cwd, false);
      expect(() => actionProcessor.processAction(envelope(identity, "start_mode", {
        mode: "multi-session-review", objective: "review",
      }, "review-non-acp"))).toThrow("ACP-only");
    });
    await isolatedRuntime(({ cwd }) => {
      const identity = initialize(cwd, true);
      const started = actionProcessor.processAction(envelope(identity, "start_mode", {
        mode: "multi-session-review", objective: "review", config: { create_fix_tasks: false },
      }, "review-acp"));
      expect(started.task_ids.length).toBeGreaterThanOrEqual(3);
      expect(new Set(started.task_ids).size).toBe(started.task_ids.length);
      const cancelled = actionProcessor.processAction(envelope(identity, "advance_mode", {
        mode_id: started.mode_id, operation: "cancel", reason: "bounded",
      }, "review-cancel"));
      expect(cancelled.consensus.verdict).toBe("blocked");
    });
  });

  test("nested modes share the same Task tree and persist parent depth", async () => isolatedRuntime(({ cwd }) => {
    const identity = initialize(cwd, true);
    const parent = actionProcessor.processAction(envelope(identity, "start_mode", {
      mode: "swarm", objective: "parent", tasks: [
        { key: "owner", goal: "nested owner", intent_hint: "implement", output_contract: "nested result" },
      ],
    }, "parent-mode"));
    const ownerTaskId = parent.task_ids[0];
    const ownerAttempt = stateStore.getCurrentAttempt(ownerTaskId)!;
    stateStore.transaction((connection) => {
      connection.execute("UPDATE attempts SET state='evaluating' WHERE attempt_id=?", [ownerAttempt.attempt_id]);
      connection.execute("UPDATE tasks SET status='active' WHERE task_id=?", [ownerTaskId]);
    });
    const token = executionSecrets.deriveAttemptToken(stateStore.getRun(identity.root_id)!, ownerAttempt.attempt_id);
    estimate({ ...identity, task_id: ownerTaskId, attempt_id: ownerAttempt.attempt_id, actor_token: token }, "split", "nested-estimate");
    const nested = actionProcessor.processAction(envelope(identity, "start_mode", {
      mode: "swarm", objective: "nested", tasks: [
        { key: "leaf", goal: "leaf", intent_hint: "review", output_contract: "leaf result" },
      ],
    }, "nested-mode", { task_id: ownerTaskId, attempt_id: ownerAttempt.attempt_id, actor_token: token }));
    const persisted = stateStore.getMode(nested.mode_id)!;
    expect(persisted.parent_mode_id).toBe(parent.mode_id);
    expect(persisted.depth).toBe(1);
    expect(stateStore.getTask(nested.task_ids[0])!.root_id).toBe(identity.root_id);
  }));

  test("evidence bundles are deterministic, bounded, and preserve reserved sections", () => {
    const evidence = {
      base: { content: `BASE${"x".repeat(20_000)}` }, candidate: { title: "CANDIDATE" },
      dependencies: [{ result: "DEPENDENCY" }], provenance: [{ evidence: "PROVENANCE" }],
    };
    const reserved = ["candidate", "dependencies", "provenance"];
    const bundle = modeModels.boundedBundle(evidence, modeModels.MAX_EVIDENCE_BYTES, reserved);
    expect(bundle).toEqual(modeModels.boundedBundle(evidence, modeModels.MAX_EVIDENCE_BYTES, reserved));
    expect(bundle.truncated).toBe(true);
    expect(Buffer.byteLength(bundle.content)).toBeLessThanOrEqual(modeModels.MAX_EVIDENCE_BYTES);
    expect(bundle.content).toContain("CANDIDATE");
    expect(bundle.content).toContain("DEPENDENCY");
  });
});
