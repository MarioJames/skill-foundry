import { describe, expect, test } from "bun:test";

import * as actionProcessor from "../scripts/action_processor.ts";
import { initializeRun } from "../scripts/agent_orchestrator.ts";
import * as executionSecrets from "../scripts/execution_secrets.ts";
import * as modeModels from "../scripts/mode_models.ts";
import * as promptBuilder from "../scripts/prompt_builder.ts";
import * as stateStore from "../scripts/state_store.ts";
import { isolatedRuntime } from "./helpers.ts";
import type { RuntimeRecord } from "../scripts/runtime_types.ts";

function envelope(
  identity: RuntimeRecord,
  type: string,
  payload: RuntimeRecord,
  actionId: string,
  binding: RuntimeRecord = {},
): RuntimeRecord {
  return {
    schema_version: 1, action_id: actionId, root_id: identity.root_id,
    task_id: binding.task_id ?? identity.task_id,
    attempt_id: binding.attempt_id ?? identity.attempt_id,
    actor_token: binding.actor_token ?? identity.actor_token,
    type, payload,
  };
}

function submitEstimate(
  identity: RuntimeRecord,
  options: { strategy?: string; intent?: string; actionId?: string; binding?: RuntimeRecord } = {},
): RuntimeRecord {
  return actionProcessor.processAction(envelope(identity, "submit_estimate", {
    revision: false, strategy: options.strategy ?? "split", resolved_intent: options.intent ?? "implement",
    complexity: "high", concerns: [], unknowns: [], estimated_files: [], reason: "deterministic mode contract",
  }, options.actionId ?? "estimate", options.binding));
}

function initialize(cwd: string, acp = false, maxConcurrentAgents = 20): RuntimeRecord {
  const identity = initializeRun("mode root", cwd, acp ? {
    requireFinalReview: false, maxConcurrentAgents, backend: "acp", acpAgent: "custom",
    acpCommand: "/bin/true", acpArgs: [],
  } : { requireFinalReview: false, maxConcurrentAgents, backend: "claude_cli" });
  submitEstimate(identity);
  return identity;
}

function activate(taskId: number): RuntimeRecord {
  return stateStore.transaction((connection) => {
    const attempt = stateStore.getCurrentAttempt(taskId, connection)!;
    connection.execute("UPDATE attempts SET state='evaluating' WHERE attempt_id=?", [attempt.attempt_id]);
    connection.execute("UPDATE tasks SET status='active' WHERE task_id=?", [taskId]);
    const launch = stateStore.getCurrentLaunch(Number(attempt.attempt_id), connection);
    if (launch) connection.execute(
      `UPDATE launches SET status='running', prompt_state='in_flight',
       ready_at=COALESCE(ready_at, ?), last_event_at=? WHERE launch_id=?`,
      [stateStore.now(), stateStore.now(), launch.launch_id],
    );
    return stateStore.getCurrentAttempt(taskId, connection)!;
  });
}

function markDone(taskId: number, modeResult: RuntimeRecord): void {
  stateStore.transaction((connection) => {
    const timestamp = stateStore.now();
    const attempt = stateStore.getCurrentAttempt(taskId, connection);
    const encoded = JSON.stringify({ mode_result: modeResult });
    if (attempt) {
      connection.execute(
        "UPDATE attempts SET state='done', retryable=0, result_json=?, finished_at=? WHERE attempt_id=?",
        [encoded, timestamp, attempt.attempt_id],
      );
      const launch = stateStore.getCurrentLaunch(Number(attempt.attempt_id), connection);
      if (launch) {
        connection.execute(
          "UPDATE launches SET status='closed', prompt_state='ended', closed_at=?, last_event_at=? WHERE launch_id=?",
          [timestamp, timestamp, launch.launch_id],
        );
        connection.execute(
          "UPDATE effects SET status='completed', completed_at=? WHERE launch_id=? AND status IN ('pending','running')",
          [timestamp, launch.launch_id],
        );
      }
    } else {
      connection.execute(
        `INSERT INTO attempts(task_id, attempt_no, state, actor_token_hash, backend_id, agent_type,
          config_json, result_json, created_at, finished_at)
         VALUES (?, 1, 'done', 'fixture', 'fixture', 'fixture', '{}', ?, ?, ?)`,
        [taskId, encoded, timestamp, timestamp],
      );
    }
    connection.execute("UPDATE tasks SET status='done', finished_at=? WHERE task_id=?", [timestamp, taskId]);
    connection.execute("UPDATE mode_tasks SET result_validated=1 WHERE task_id=?", [taskId]);
  });
}

function startReview(identity: RuntimeRecord, config: RuntimeRecord = {}, actionId = "start-review"): RuntimeRecord {
  return actionProcessor.processAction(envelope(identity, "start_mode", {
    mode: "multi-session-review", objective: "Review candidate", config,
  }, actionId));
}

describe("persistent mode compilation and results", () => {
  test("schema v3 persists real mode, finding, provenance, and verification facts", async () => isolatedRuntime(({ cwd }) => {
    const identity = initialize(cwd);
    const tables = stateStore.fetchall("SELECT name FROM sqlite_master WHERE type='table'").map((row) => row.name);
    for (const name of ["modes", "mode_rounds", "mode_tasks", "mode_findings", "mode_finding_provenance", "mode_verifications"]) {
      expect(tables).toContain(name);
    }
    expect(stateStore.inspectModes(String(identity.root_id))).toEqual([]);
    const sql = String(stateStore.fetchall("SELECT sql FROM sqlite_master WHERE type='table' AND name='mode_tasks'")[0]!.sql);
    expect(sql).toContain("'validator'");
  }));

  test("reviewer profile hints must be non-empty allowlisted names", async () => isolatedRuntime(({ cwd }) => {
    const identity = initialize(cwd, true);
    expect(() => startReview(identity, { reviewers: [
      { id: "one", profile_hint: { name: "custom" } },
      { id: "two", profile_hint: "custom" },
      { id: "three", profile_hint: "custom" },
    ] }, "object-hint")).toThrow("non-empty profile name");
    expect(() => startReview(identity, { reviewers: [
      { id: "one", profile_hint: "codex" },
      { id: "two", profile_hint: "custom" },
      { id: "three", profile_hint: "custom" },
    ] }, "unallowlisted-hint")).toThrow("Run profile allowlist");
    const started = startReview(identity, { reviewers: [
      { id: "one", profile_hint: "custom" },
      { id: "two", profile_hint: "custom" },
      { id: "three", profile_hint: "custom" },
    ] }, "valid-hint");
    for (const row of stateStore.fetchall("SELECT * FROM mode_tasks WHERE mode_id=?", [started.mode_id])) {
      expect(JSON.parse(String(row.profile_hint_json))).toBe("custom");
      expect(JSON.parse(String(stateStore.getTask(Number(row.task_id))!.constraints_json)).profile_hint).toBe("custom");
    }
  }));

  test("swarm compiles dependencies once and completes from validated mode results", async () => isolatedRuntime(({ cwd }) => {
    const identity = initialize(cwd);
    const started = actionProcessor.processAction(envelope(identity, "start_mode", {
      mode: "swarm", objective: "compile", tasks: [
        { key: "producer", goal: "produce", intent_hint: "implement", output_contract: "evidence" },
        { key: "consumer", goal: "consume", intent_hint: "integrate", output_contract: "integrated",
          depends_on: [{ task_key: "producer", condition: "success" }] },
      ],
    }, "start-swarm-contract"));
    const [producer, consumer] = started.task_ids as number[];
    expect(stateStore.fetchall("SELECT depends_on_task_id FROM task_dependencies WHERE task_id=?", [consumer])[0]!.depends_on_task_id).toBe(producer);
    markDone(producer!, { status: "done", evidence: ["producer complete"] });
    markDone(consumer!, { status: "done", evidence: ["consumer complete"] });
    const advanced = actionProcessor.processAction(envelope(identity, "advance_mode", { mode_id: started.mode_id }, "advance-swarm-contract"));
    expect(advanced.status).toBe("completed");
    expect(stateStore.inspectModes(String(identity.root_id), Number(started.mode_id))[0]!.tasks).toHaveLength(2);
  }));

  test("mode Task finish requires role result and stores Runtime fingerprint", async () => isolatedRuntime(({ cwd }) => {
    const identity = initialize(cwd, false, 2);
    const started = actionProcessor.processAction(envelope(identity, "start_mode", {
      mode: "swarm", objective: "one", tasks: [
        { key: "leaf", goal: "leaf", intent_hint: "implement", output_contract: "finish leaf" },
      ],
    }, "start-result-validation"));
    const taskId = Number(started.task_ids[0]);
    const attempt = activate(taskId);
    const token = executionSecrets.deriveAttemptToken(stateStore.getRun(String(identity.root_id))!, Number(attempt.attempt_id));
    const binding = { task_id: taskId, attempt_id: attempt.attempt_id, actor_token: token };
    submitEstimate(identity, { strategy: "direct", actionId: "leaf-estimate", binding });
    const base = { status: "done", summary: "leaf done", changed_files: [], artifacts: [], caveats: [], validation: null, review: null, integration_check: null };
    expect(() => actionProcessor.processAction(envelope(identity, "finish", base, "missing-mode-result", binding))).toThrow("mode_result");
    actionProcessor.processAction(envelope(identity, "finish", {
      ...base, mode_result: { status: "done", evidence: ["validated"] },
    }, "valid-mode-result", binding));
    const result = JSON.parse(String(stateStore.getCurrentAttempt(taskId)!.result_json)).mode_result;
    expect(result.runtime_result_fingerprint).toBeTruthy();
    expect(stateStore.getModeTask(taskId)!.result_validated).toBe(1);
  }));

  test("review source self is executable and read-only mode reviewers cannot report changes", async () => {
    await isolatedRuntime(({ cwd }) => {
      const identity = initializeRun("self review", cwd, { requireFinalReview: false, backend: "claude_cli" });
      submitEstimate(identity, { strategy: "direct", intent: "review", actionId: "self-review-estimate" });
      const finished = actionProcessor.processAction(envelope(identity, "finish", {
        status: "done", summary: "review passed", changed_files: [], artifacts: [], caveats: [],
        validation: null, review: { status: "pass", source: "self", findings: [] },
        integration_check: null, mode_result: null,
      }, "self-review-finish"));
      expect(finished.accepted).toBe(true);
    });
    await isolatedRuntime(({ cwd }) => {
      const identity = initialize(cwd, true);
      const started = startReview(identity, { create_fix_tasks: false });
      const taskId = Number(started.task_ids[0]);
      expect(JSON.parse(String(stateStore.getTask(taskId)!.constraints_json)).read_only).toBe(true);
      const attempt = activate(taskId);
      const token = executionSecrets.deriveAttemptToken(stateStore.getRun(String(identity.root_id))!, Number(attempt.attempt_id));
      const binding = { task_id: taskId, attempt_id: attempt.attempt_id, actor_token: token };
      submitEstimate(identity, { strategy: "direct", intent: "review", actionId: "readonly-estimate", binding });
      expect(() => actionProcessor.processAction(envelope(identity, "finish", {
        status: "done", summary: "invalid mutation", changed_files: ["src/modified.ts"], artifacts: [], caveats: [],
        validation: { status: "passed" }, review: { status: "pass", source: "self", findings: [] },
        integration_check: null, mode_result: { findings: [] },
      }, "readonly-finish", binding))).toThrow("cannot finish done with changed_files");
      expect(stateStore.getTask(taskId)!.status).toBe("active");
    });
  });

  test("cancelled review reports blocked consensus, never a passing verdict", async () => isolatedRuntime(({ cwd }) => {
    const identity = initialize(cwd, true);
    const started = startReview(identity, { create_fix_tasks: false }, "review-to-cancel");
    const cancelled = actionProcessor.processAction(envelope(identity, "advance_mode", {
      mode_id: started.mode_id, operation: "cancel", reason: "bounded cancellation",
    }, "cancel-review-contract"));
    expect(cancelled).toMatchObject({ status: "cancelled", outcome: "cancelled", verdict: "blocked" });
    expect(cancelled.consensus.verdict).toBe("blocked");
  }));

  test("mode prompt carries bounded hashed dependency evidence", async () => isolatedRuntime(({ cwd }) => {
    const identity = initialize(cwd);
    const started = actionProcessor.processAction(envelope(identity, "start_mode", {
      mode: "swarm", objective: "evidence", evidence: { content: `BASE-${"x".repeat(16_000)}` }, tasks: [
        { key: "leaf", goal: "consume", intent_hint: "integrate", output_contract: "result" },
      ],
    }, "evidence-mode"));
    const task = stateStore.getTask(Number(started.task_ids[0]))!;
    const attempt = stateStore.getCurrentAttempt(Number(task.task_id))!;
    const prompt = stateStore.transaction((connection) => promptBuilder.buildPrompt(
      stateStore.getRun(String(identity.root_id), connection)!, task, attempt, connection,
    ), false);
    expect(prompt).toContain("dependency_evidence_bundle");
    expect(prompt).toContain("sha256");
    expect(prompt).toContain("truncated");
  }));

  test("develop-review-improve verifies before fix, revalidates, and independently re-reviews", async () => isolatedRuntime(({ cwd }) => {
    const identity = initialize(cwd);
    const started = actionProcessor.processAction(envelope(identity, "start_mode", {
      mode: "develop_review_improve", objective: "converge", config: { max_rounds: 2 },
    }, "loop-e2e-start"));
    markDone(Number(started.task_ids[0]), {
      summary: "implemented v1", state: { version: 1 }, evidence: ["baseline"],
    });
    const validation = actionProcessor.processAction(envelope(identity, "advance_mode", { mode_id: started.mode_id }, "loop-e2e-validation"));
    expect(validation.phase).toBe("validate");
    markDone(Number(validation.task_ids[0]), {
      stage: "validation", status: "passed", artifact_version: "v1", commands: ["bun test"], evidence: ["passed"],
    });
    const review = actionProcessor.processAction(envelope(identity, "advance_mode", { mode_id: started.mode_id }, "loop-e2e-review"));
    expect(review.phase).toBe("review");
    markDone(Number(review.task_ids[0]), {
      verdict: "changes_requested", findings: [{
        rule: "deterministic", title: "Real defect", description: "The check fails.",
        severity: "medium", location: "feature.ts:1", evidence: ["reproduced"],
      }],
    });
    const verify = actionProcessor.processAction(envelope(identity, "advance_mode", { mode_id: started.mode_id }, "loop-e2e-verify"));
    expect(verify.phase).toBe("verify");
    expect(verify.task_ids).toHaveLength(2);
    expect(stateStore.fetchall("SELECT * FROM mode_tasks WHERE mode_id=? AND role='improver'", [started.mode_id])).toEqual([]);
    const verifierRows = stateStore.fetchall(
      `SELECT * FROM mode_tasks WHERE task_id IN (${verify.task_ids.map(() => "?").join(",")})`, verify.task_ids,
    );
    const fingerprint = String(verifierRows[0]!.candidate_fingerprint);
    for (const row of verifierRows) markDone(Number(row.task_id), {
      candidate_fingerprint: fingerprint, verdict: "confirmed", evidence: ["independent confirmation"], discovered_findings: [],
    });
    const improve = actionProcessor.processAction(envelope(identity, "advance_mode", { mode_id: started.mode_id }, "loop-e2e-improve"));
    expect(improve.phase).toBe("improve");
    markDone(Number(improve.task_ids[0]), {
      changed: true, addressed_fingerprints: [fingerprint], evidence: ["fixed"],
    });
    const revalidate = actionProcessor.processAction(envelope(identity, "advance_mode", { mode_id: started.mode_id }, "loop-e2e-revalidate"));
    expect(revalidate.phase).toBe("revalidate");
    markDone(Number(revalidate.task_ids[0]), {
      stage: "revalidation", status: "passed", artifact_version: "v2", commands: ["bun test"], evidence: ["passed"],
    });
    const rereview = actionProcessor.processAction(envelope(identity, "advance_mode", { mode_id: started.mode_id }, "loop-e2e-rereview"));
    expect(rereview).toMatchObject({ phase: "re_review", round: 2 });
    markDone(Number(rereview.task_ids[0]), { verdict: "pass", findings: [] });
    const completed = actionProcessor.processAction(envelope(identity, "advance_mode", { mode_id: started.mode_id }, "loop-e2e-complete"));
    expect(completed.status).toBe("completed");
    expect(completed.reason).toContain("review passed");
  }));

  test("multi-session review deduplicates provenance and fixes only confirmed findings", async () => isolatedRuntime(({ cwd }) => {
    const identity = initialize(cwd, true);
    const started = startReview(identity, {
      create_fix_tasks: true, max_expansions: 1, max_candidates: 5,
    }, "consensus-e2e-start");
    const reviewers = stateStore.fetchall(
      "SELECT * FROM mode_tasks WHERE mode_id=? AND role='reviewer' ORDER BY task_id", [started.mode_id],
    );
    expect(reviewers.length).toBeGreaterThanOrEqual(3);
    const confirmed = {
      rule: "A", title: "Confirmed bug", description: "A deterministic defect.",
      severity: "medium", location: "a.ts:1", evidence: ["review evidence"],
      claim: "A fails.", impact: "Incorrect result.", confidence: 0.9,
    };
    const rejected = {
      rule: "B", title: "Rejected bug", description: "A false positive.",
      severity: "low", location: "b.ts:1", evidence: ["review evidence"],
      claim: "B fails.", impact: "Minor risk.", confidence: 0.7,
    };
    for (const row of reviewers) markDone(Number(row.task_id), { findings: [confirmed, rejected] });
    const verify = actionProcessor.processAction(envelope(identity, "advance_mode", { mode_id: started.mode_id }, "consensus-to-verify"));
    expect(verify.phase).toBe("verify");
    const inspected = stateStore.inspectModes(String(identity.root_id), Number(started.mode_id))[0]!;
    expect(inspected.provenance).toHaveLength(reviewers.length * 2);
    const confirmedFp = String(inspected.findings.find((item: RuntimeRecord) => item.title === confirmed.title)!.fingerprint);
    const rejectedFp = String(inspected.findings.find((item: RuntimeRecord) => item.title === rejected.title)!.fingerprint);
    const verifiers = stateStore.fetchall(
      "SELECT * FROM mode_tasks WHERE mode_id=? AND role IN ('verifier_reproduce','verifier_falsify')", [started.mode_id],
    );
    expect(verifiers).toHaveLength(4);
    for (const row of verifiers) markDone(Number(row.task_id), {
      candidate_fingerprint: row.candidate_fingerprint,
      verdict: row.candidate_fingerprint === confirmedFp ? "confirmed" : "rejected",
      evidence: ["independent verdict"], discovered_findings: [],
    });
    const fix = actionProcessor.processAction(envelope(identity, "advance_mode", { mode_id: started.mode_id }, "consensus-to-fix"));
    expect(fix.phase).toBe("fix");
    expect(fix.task_ids).toHaveLength(1);
    expect(stateStore.getModeTask(Number(fix.task_ids[0]))!.candidate_fingerprint).toBe(confirmedFp);
    const statuses = Object.fromEntries(
      stateStore.inspectModes(String(identity.root_id), Number(started.mode_id))[0]!.findings
        .map((item: RuntimeRecord) => [item.fingerprint, item.status]),
    );
    expect(statuses[confirmedFp]).toBe("confirmed");
    expect(statuses[rejectedFp]).toBe("rejected");
  }));
});

describe("bounded loop and finding validation", () => {
  test("canonical loop phases and exit conditions reject decorative config", () => {
    const config = modeModels.normalizeConfig("develop_review_improve", {
      phases: [...modeModels.LOOP_PHASES], exit_conditions: { ...modeModels.LOOP_EXIT_CONDITIONS },
    });
    expect(config.phases).toEqual([...modeModels.LOOP_PHASES]);
    expect(config.exit_conditions).toEqual(modeModels.LOOP_EXIT_CONDITIONS);
    expect(() => modeModels.normalizeConfig("develop_review_improve", { phases: ["develop", "review"] })).toThrow("canonical v1 phase order");
    expect(() => modeModels.normalizeConfig("develop_review_improve", { decorative_phase: "ignored" })).toThrow("unsupported");
  });

  test("validator contract and standard finding fields fail closed", () => {
    const validation = modeModels.validateModeResult(
      { role: "validator", phase: "validate" },
      { kind: "develop_review_improve" },
      { stage: "validation", status: "passed", artifact_version: "v1", commands: ["bun test"], evidence: ["passed"] },
    );
    expect(validation.status).toBe("passed");
    const finding = {
      rule: "contract", title: "Standard finding", description: "Contract is violated.",
      claim: "Required data is dropped.", location: "mode_runtime.ts:1", severity: "high",
      evidence: ["reproduction"], impact: "Consensus loses evidence.", confidence: 0.93,
    };
    expect(modeModels.validateFinding(finding, "finding", true)).toMatchObject({
      claim: finding.claim, impact: finding.impact, confidence: finding.confidence,
    });
    const incomplete = { ...finding } as RuntimeRecord;
    delete incomplete.claim;
    expect(() => modeModels.validateModeResult(
      { role: "reviewer" }, { kind: "multi_session_review" }, { findings: [incomplete] },
    )).toThrow("claim is required");
  });
});
