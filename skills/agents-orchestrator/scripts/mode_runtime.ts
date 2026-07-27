import * as executionConfig from "./execution_config.ts";
import * as modeModels from "./mode_models.ts";
import * as stateStore from "./state_store.ts";
import { canonicalJson, isRecord, type RuntimeRecord, ValueError } from "./runtime_types.ts";

export const TERMINAL_TASKS = new Set(["done", "failed", "blocked", "cancelled"]);
const SEVERITY_RANK: Readonly<Record<string, number>> = Object.freeze({ low: 0, medium: 1, high: 2, critical: 3 });

export type CompileTasks = (specifications: RuntimeRecord[]) => RuntimeRecord[];
export type CancelMode = (
  connection: stateStore.Connection,
  run: RuntimeRecord,
  mode: RuntimeRecord,
  reason: string,
) => unknown;

function json(value: unknown): string {
  return canonicalJson(value);
}

function decoded(row: RuntimeRecord, key: string): RuntimeRecord {
  const raw = row[key] || "{}";
  if (typeof raw !== "string") throw new ValueError(`${key} must be JSON text`);
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) throw new Error();
    return value;
  } catch {
    throw new ValueError(`${key} is invalid`);
  }
}

function ownerConstraints(context: RuntimeRecord): RuntimeRecord {
  return decoded(context.task, "constraints_json");
}

function taskConstraints(
  context: RuntimeRecord,
  options: { readOnly: boolean; notes: string[]; profileHint?: string | null },
): RuntimeRecord {
  const parent = ownerConstraints(context);
  const value: RuntimeRecord = {
    write_scope: options.readOnly ? [] : [...(parent.write_scope ?? [])],
    read_only: Boolean(options.readOnly || parent.read_only),
    notes: [...(parent.notes ?? []), ...options.notes],
  };
  if (options.profileHint !== undefined && options.profileHint !== null) value.profile_hint = options.profileHint;
  return value;
}

function outputContract(role: string): string {
  const contracts: Record<string, string> = {
    swarm: 'Complete the assigned task and finish with mode_result {"status":"done|partial","evidence":[...]} as well as normal finish fields.',
    developer: 'Develop the requested round and finish with mode_result {"summary":"...","state":{...},"evidence":[...]} as well as normal finish fields.',
    validator: 'Run deterministic validation without modifying files. Finish with mode_result {"stage":"validation|revalidation","status":"passed|failed|blocked","artifact_version":"...","commands":[...],"evidence":[...]}.',
    reviewer: 'Independently review the supplied bounded evidence. Finish with mode_result containing "findings":[{"title","description","claim","severity","location","rule","evidence","impact","confidence"}]. For develop_review_improve also include "verdict":"pass|changes_requested|blocked". The normal finish review object uses "source":"self".',
    verifier_reproduce: 'Reproduce the assigned candidate independently. Finish with mode_result containing "candidate_fingerprint", "verdict":"confirmed|rejected|unresolved", non-empty "evidence", and optional "discovered_findings".',
    verifier_falsify: 'Try to falsify the assigned candidate independently. Report the candidate truth, not whether the falsification attempt itself ran: finish with mode_result containing "candidate_fingerprint", "verdict":"confirmed|rejected|unresolved", non-empty "evidence", and optional "discovered_findings".',
    improver: 'Improve the prior result using the review findings. Finish with mode_result {"changed":true|false,"addressed_fingerprints":[...],"evidence":[...]}.',
    fixer: 'Fix only the assigned confirmed finding. Finish with mode_result {"fixed_fingerprints":[...],"evidence":[...]} including the assigned fingerprint.',
  };
  const contract = contracts[role];
  if (!contract) throw new ValueError(`unsupported mode task role: ${role}`);
  return contract;
}

function currentRound(connection: stateStore.Connection, mode: RuntimeRecord): RuntimeRecord {
  const row = connection.execute(
    "SELECT * FROM mode_rounds WHERE mode_id=? AND round_no=?",
    [mode.mode_id, mode.current_round],
  ).fetchone();
  if (row === null) throw new ValueError("mode current round is missing");
  return row;
}

function newRound(connection: stateStore.Connection, modeId: number, roundNumber: number, phase: string): number {
  return connection.execute(
    `INSERT INTO mode_rounds(mode_id, round_no, phase, status, started_at)
     VALUES (?, ?, ?, 'active', ?)`,
    [modeId, roundNumber, phase, stateStore.now()],
  ).lastrowid;
}

function setPhase(
  connection: stateStore.Connection,
  mode: RuntimeRecord,
  phase: string,
  roundNumber?: number,
): void {
  const timestamp = stateStore.now();
  const targetRound = Number(roundNumber ?? mode.current_round);
  connection.execute(
    "UPDATE modes SET phase=?, current_round=?, updated_at=? WHERE mode_id=?",
    [phase, targetRound, timestamp, mode.mode_id],
  );
  connection.execute(
    "UPDATE mode_rounds SET phase=? WHERE mode_id=? AND round_no=?",
    [phase, mode.mode_id, targetRound],
  );
  mode.phase = phase;
  mode.current_round = targetRound;
  mode.updated_at = timestamp;
}

function closeMode(
  connection: stateStore.Connection,
  mode: RuntimeRecord,
  status: string,
  reason: string,
  outcome?: string,
): RuntimeRecord {
  const timestamp = stateStore.now();
  const state = decoded(mode, "state_json");
  state.terminal_reason = reason;
  state.terminal_outcome = outcome ?? status;
  connection.execute(
    "UPDATE modes SET status=?, state_json=?, updated_at=?, completed_at=? WHERE mode_id=?",
    [status, json(state), timestamp, timestamp, mode.mode_id],
  );
  const roundStatus = status === "completed" ? "completed" : status === "cancelled" ? "cancelled" : "blocked";
  connection.execute(
    `UPDATE mode_rounds SET status=?, completed_at=COALESCE(completed_at, ?)
      WHERE mode_id=? AND status='active'`,
    [roundStatus, timestamp, mode.mode_id],
  );
  mode.status = status;
  mode.state_json = json(state);
  const response: RuntimeRecord = {
    accepted: true,
    mode_id: mode.mode_id,
    mode: mode.kind,
    status,
    outcome: state.terminal_outcome,
    phase: mode.phase,
    round: mode.current_round,
    reason,
    schedule_required: false,
    task_ids: [],
  };
  if (mode.kind === "multi_session_review") {
    const consensus = consensusSummary(connection, mode, status);
    response.verdict = consensus.verdict;
    response.findings = {
      confirmed: consensus.confirmed_findings,
      rejected: consensus.rejected_findings,
      unresolved: consensus.unresolved_findings,
    };
    response.consensus = consensus;
  }
  return response;
}

function modeTaskCount(connection: stateStore.Connection, modeId: number): number {
  return Number(connection.execute("SELECT COUNT(*) AS n FROM mode_tasks WHERE mode_id=?", [modeId]).fetchone()?.n ?? 0);
}

function actionBatch(context: RuntimeRecord, plans: RuntimeRecord[]): RuntimeRecord[] {
  return plans.slice(0, Math.max(1, Number(context.run.max_children_per_action)));
}

function compile(
  connection: stateStore.Connection,
  context: RuntimeRecord,
  mode: RuntimeRecord,
  roundId: number,
  plans: RuntimeRecord[],
  compileTasks: CompileTasks,
): number[] {
  const config = decoded(mode, "config_json");
  if (modeTaskCount(connection, Number(mode.mode_id)) + plans.length > Number(config.max_tasks)) {
    throw new ValueError("mode max_tasks guard exceeded");
  }
  const created = compileTasks(plans.map((plan) => plan.spec));
  const ids = new Map(created.map((item) => [item.key, Number(item.task_id)]));
  const timestamp = stateStore.now();
  for (const plan of plans) {
    const taskId = ids.get(plan.spec.key);
    if (taskId === undefined) throw new ValueError("mode task compiler omitted a requested task");
    connection.execute(
      `INSERT INTO mode_tasks(
         mode_id, round_id, task_id, role, candidate_fingerprint,
         proposer_task_id, profile_hint_json, result_validated, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      [
        mode.mode_id,
        roundId,
        taskId,
        plan.role,
        plan.candidate_fingerprint ?? null,
        plan.proposer_task_id ?? null,
        plan.profile_hint === null || plan.profile_hint === undefined ? null : json(plan.profile_hint),
        timestamp,
      ],
    );
  }
  return plans.map((plan) => ids.get(plan.spec.key)!);
}

function parentMode(
  connection: stateStore.Connection,
  context: RuntimeRecord,
  requested: number | null,
): [RuntimeRecord | null, number] {
  const linked = stateStore.getModeTask(Number(context.task.task_id), connection);
  const implicit = linked?.mode_id ?? null;
  const parentId = requested ?? implicit;
  if (requested !== null && implicit !== null && requested !== implicit) {
    throw new ValueError("nested mode parent must be the mode that owns the current task");
  }
  if (parentId === null) return [null, 0];
  const parent = stateStore.getMode(Number(parentId), connection);
  if (parent === null || parent.root_id !== context.run.root_id) throw new ValueError("parent mode must belong to the same Run");
  if (parent.status !== "running") throw new ValueError("parent mode must be running");
  if (
    context.task.task_id !== parent.owner_task_id &&
    (linked === null || linked.mode_id !== parent.mode_id)
  ) throw new ValueError("current task is not part of the requested parent mode");
  const seen = new Set<number>();
  let cursor: RuntimeRecord | null = parent;
  while (cursor !== null) {
    if (seen.has(Number(cursor.mode_id))) throw new ValueError("mode composition cycle detected");
    seen.add(Number(cursor.mode_id));
    cursor = cursor.parent_mode_id === null ? null : stateStore.getMode(Number(cursor.parent_mode_id), connection);
  }
  return [parent, Number(parent.depth) + 1];
}

function swarmPlans(tasks: unknown[]): RuntimeRecord[] {
  return tasks.map((specification) => {
    if (!isRecord(specification)) throw new ValueError("swarm tasks must be objects");
    const specificationCopy: RuntimeRecord = { ...specification };
    specificationCopy.output_contract = `${String(specificationCopy.output_contract ?? "").trim()}\n${outputContract("swarm")}`.trim();
    return { role: "swarm", spec: specificationCopy };
  });
}

function developerPlan(
  context: RuntimeRecord,
  mode: RuntimeRecord,
  roundNumber: number,
  dependsOn?: number,
): RuntimeRecord {
  const specification: RuntimeRecord = {
    key: `mode-${mode.mode_id}-round-${roundNumber}-develop`,
    goal: `${mode.objective}\nDevelop round ${roundNumber}.`,
    intent_hint: "implement",
    complexity_hint: "high",
    model_tier_hint: "strong",
    priority: 80,
    output_contract: outputContract("developer"),
    constraints: taskConstraints(context, {
      readOnly: false,
      notes: [`Persistent mode ${mode.mode_id}, round ${roundNumber} developer.`],
    }),
  };
  if (dependsOn !== undefined) specification.depends_on = [{ task_id: dependsOn, condition: "success" }];
  return { role: "developer", spec: specification };
}

function validatorPlan(
  context: RuntimeRecord,
  mode: RuntimeRecord,
  roundNumber: number,
  dependsOn: number,
  stage: "validation" | "revalidation",
): RuntimeRecord {
  return {
    role: "validator",
    spec: {
      key: `mode-${mode.mode_id}-round-${roundNumber}-${stage}`,
      goal: `${mode.objective}\nRun deterministic ${stage} for round ${roundNumber}.`,
      intent_hint: "review",
      complexity_hint: "high",
      model_tier_hint: "strong",
      priority: 85,
      output_contract: outputContract("validator"),
      constraints: taskConstraints(context, {
        readOnly: true,
        notes: [
          `Persistent mode ${mode.mode_id}, round ${roundNumber} deterministic ${stage}.`,
          "Do not modify the artifact while validating it.",
        ],
      }),
      depends_on: [{ task_id: dependsOn, condition: "success" }],
    },
  };
}

function loopReviewerPlan(
  context: RuntimeRecord,
  mode: RuntimeRecord,
  roundNumber: number,
  dependsOn: number,
): RuntimeRecord {
  return {
    role: "reviewer",
    spec: {
      key: `mode-${mode.mode_id}-round-${roundNumber}-review`,
      goal: `${mode.objective}\nIndependently review development round ${roundNumber}.`,
      intent_hint: "review",
      complexity_hint: "high",
      model_tier_hint: "strong",
      priority: 80,
      output_contract: outputContract("reviewer"),
      constraints: taskConstraints(context, {
        readOnly: true,
        notes: [`Persistent mode ${mode.mode_id}, round ${roundNumber} review.`],
      }),
      depends_on: [{ task_id: dependsOn, condition: "success" }],
    },
  };
}

function improverPlan(
  context: RuntimeRecord,
  mode: RuntimeRecord,
  roundNumber: number,
  dependsOn: number | number[],
  fingerprints: string[],
): RuntimeRecord {
  const dependencies = Array.isArray(dependsOn) ? dependsOn : [dependsOn];
  return {
    role: "improver",
    spec: {
      key: `mode-${mode.mode_id}-round-${roundNumber}-improve`,
      goal: `${mode.objective}\nImprove round ${roundNumber} for findings: ${fingerprints.join(", ")}`,
      intent_hint: "fix",
      complexity_hint: "high",
      model_tier_hint: "strong",
      priority: 85,
      output_contract: outputContract("improver"),
      constraints: taskConstraints(context, {
        readOnly: false,
        notes: [`Only address the listed round findings: ${fingerprints.join(", ")}`],
      }),
      depends_on: dependencies.map((taskId) => ({ task_id: taskId, condition: "success" })),
    },
  };
}

function reviewerPlans(context: RuntimeRecord, mode: RuntimeRecord, config: RuntimeRecord): RuntimeRecord[] {
  return (config.reviewers as RuntimeRecord[]).map((reviewer) => ({
    role: "reviewer",
    profile_hint: reviewer.profile_hint,
    spec: {
      key: `mode-${mode.mode_id}-review-${reviewer.id}`,
      goal: `${mode.objective}\nPerform an independent proposal review as ${reviewer.id}.`,
      intent_hint: "review",
      complexity_hint: "high",
      model_tier_hint: "strong",
      priority: 80,
      output_contract: outputContract("reviewer"),
      constraints: taskConstraints(context, {
        readOnly: true,
        notes: [
          "Do not coordinate with other reviewers.",
          `Runtime mode ${mode.mode_id} independent reviewer ${reviewer.id}.`,
        ],
        profileHint: reviewer.profile_hint,
      }),
    },
  }));
}

export function startMode(
  connection: stateStore.Connection,
  context: RuntimeRecord,
  payload: RuntimeRecord,
  actionId: string,
  compileTasks: CompileTasks,
): RuntimeRecord {
  const data = modeModels.validateStartPayload(payload);
  const execution = decoded(context.run, "execution_config_json");
  if (data.kind === "multi_session_review" && execution.backend !== "acp") {
    throw new ValueError("multi_session_review is ACP-only");
  }
  const reviewers = data.kind === "multi_session_review" ? data.config.reviewers as RuntimeRecord[] : [];
  if (reviewers.length > Number(context.run.max_children_per_action)) {
    throw new ValueError("reviewer count exceeds the Run max_children_per_action guard");
  }
  for (const reviewer of reviewers) {
    if (reviewer.profile_hint !== null) {
      executionConfig.selectProfile(execution, { profileHint: reviewer.profile_hint });
    }
  }
  const [parent, depth] = parentMode(connection, context, data.parent_mode_id);
  if (depth > Number(data.config.max_mode_depth)) throw new ValueError("mode composition depth guard exceeded");
  if (parent !== null && depth > Number(decoded(parent, "config_json").max_mode_depth ?? 4)) {
    throw new ValueError("parent mode composition depth guard exceeded");
  }
  const timestamp = stateStore.now();
  const state = {
    evidence_bundle: data.evidence_bundle,
    no_progress_count: 0,
    candidate_expansions: 0,
    candidate_overflow: [],
  };
  const phase = data.kind === "swarm"
    ? "swarm"
    : data.kind === "develop_review_improve"
      ? (data.config.phases?.[0] ?? "develop")
      : "review";
  const modeId = connection.execute(
    `INSERT INTO modes(
       root_id, owner_task_id, parent_mode_id, kind, status, phase,
       current_round, depth, objective, config_json, state_json,
       deadline_at, started_at, updated_at
     ) VALUES (?, ?, ?, ?, 'running', ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
    [
      context.run.root_id,
      context.task.task_id,
      parent?.mode_id ?? null,
      data.kind,
      phase,
      depth,
      data.objective,
      json(data.config),
      json(state),
      timestamp + Number(data.config.max_seconds),
      timestamp,
      timestamp,
    ],
  ).lastrowid;
  const mode = stateStore.getMode(modeId, connection)!;
  const roundId = newRound(connection, modeId, 1, phase);
  const plans = data.kind === "swarm"
    ? swarmPlans(data.tasks)
    : data.kind === "develop_review_improve"
      ? [developerPlan(context, mode, 1)]
      : reviewerPlans(context, mode, data.config);
  const taskIds = compile(connection, context, mode, roundId, plans, compileTasks);
  const fingerprint = snapshotFingerprint(connection, modeId);
  connection.execute("UPDATE modes SET state_fingerprint=? WHERE mode_id=?", [fingerprint, modeId]);
  stateStore.appendEvent(
    connection,
    context.run.root_id,
    "ModeStarted",
    { mode_id: modeId, kind: data.kind, task_ids: taskIds, parent_mode_id: data.parent_mode_id },
    context.task.task_id,
    context.attempt.attempt_id,
    null,
    actionId,
  );
  return {
    accepted: true,
    mode_id: modeId,
    mode: data.kind,
    status: "running",
    phase,
    round: 1,
    task_ids: taskIds,
    schedule_required: true,
  };
}

function modeRows(
  connection: stateStore.Connection,
  modeId: number,
  role?: string | Set<string>,
  roundId?: number,
): RuntimeRecord[] {
  const conditions = ["mt.mode_id=?"];
  const parameters: unknown[] = [modeId];
  if (role !== undefined) {
    const roles = typeof role === "string" ? [role] : [...role];
    conditions.push(`mt.role IN (${roles.map(() => "?").join(",")})`);
    parameters.push(...roles);
  }
  if (roundId !== undefined) {
    conditions.push("mt.round_id=?");
    parameters.push(roundId);
  }
  return stateStore.fetchall(
    `SELECT mt.*, t.status, a.result_json
       FROM mode_tasks mt
       JOIN tasks t ON t.task_id=mt.task_id
       LEFT JOIN attempts a ON a.attempt_id=(
         SELECT current.attempt_id FROM attempts current
          WHERE current.task_id=t.task_id ORDER BY current.attempt_no DESC LIMIT 1
       )
      WHERE ${conditions.join(" AND ")} ORDER BY mt.mode_task_id`,
    parameters,
    connection,
  );
}

function modeResult(row: RuntimeRecord): RuntimeRecord {
  if (!row.result_json) return {};
  try {
    const result: unknown = JSON.parse(row.result_json);
    if (!isRecord(result)) throw new Error();
    return isRecord(result.mode_result) ? result.mode_result : {};
  } catch {
    throw new ValueError("attempt result_json is invalid");
  }
}

function consensusSummary(
  connection: stateStore.Connection,
  mode: RuntimeRecord,
  lifecycleStatus: string,
): RuntimeRecord {
  const findingRows = stateStore.fetchall(
    "SELECT * FROM mode_findings WHERE mode_id=? ORDER BY fingerprint",
    [mode.mode_id],
    connection,
  );
  const findings: Record<string, RuntimeRecord[]> = { confirmed: [], rejected: [], unresolved: [] };
  const quorum: RuntimeRecord[] = [];
  for (const row of findingRows) {
    const canonical = decoded({ canonical_json: row.canonical_json }, "canonical_json");
    canonical.fingerprint = row.fingerprint;
    canonical.severity = row.severity;
    canonical.status = row.status;
    canonical.adjudication = row.adjudication_json
      ? decoded({ adjudication_json: row.adjudication_json }, "adjudication_json")
      : null;
    if (row.status in findings) findings[row.status]!.push(canonical);
    const verifications = stateStore.fetchall(
      `SELECT task_id, verifier_kind, verdict, evidence_hash
         FROM mode_verifications WHERE finding_id=?
        ORDER BY verifier_kind, task_id`,
      [row.finding_id],
      connection,
    );
    const kinds = new Set(verifications.map((item) => item.verifier_kind));
    quorum.push({
      fingerprint: row.fingerprint,
      status: row.status,
      required: { independent_verifiers: 2, kinds: ["reproduce", "falsify"] },
      observed: verifications,
      met: new Set(verifications.map((item) => item.task_id)).size >= 2 &&
        kinds.size === 2 && kinds.has("reproduce") && kinds.has("falsify"),
    });
  }
  const provenance = stateStore.fetchall(
    `SELECT f.fingerprint, p.task_id, p.source_kind, p.evidence_hash
       FROM mode_finding_provenance p
       JOIN mode_findings f ON f.finding_id=p.finding_id
      WHERE f.mode_id=? ORDER BY f.fingerprint, p.provenance_id`,
    [mode.mode_id],
    connection,
  );
  const verdict = lifecycleStatus !== "completed"
    ? "blocked"
    : findings.confirmed!.length > 0 || findings.unresolved!.length > 0
      ? "changes_requested"
      : "pass";
  const state = decoded(mode, "state_json");
  return {
    verdict,
    reviewed_artifact: state.evidence_bundle,
    confirmed_findings: findings.confirmed,
    rejected_findings: findings.rejected,
    unresolved_findings: findings.unresolved,
    provenance,
    quorum,
    revision_input: {
      confirmed_fingerprints: findings.confirmed!.map((item) => item.fingerprint),
      unresolved_fingerprints: findings.unresolved!.map((item) => item.fingerprint),
    },
  };
}

function snapshotFingerprint(connection: stateStore.Connection, modeId: number): string {
  const mode = stateStore.getMode(modeId, connection);
  if (mode === null) throw new ValueError("mode is missing");
  const tasks = modeRows(connection, modeId);
  const findings = stateStore.fetchall(
    `SELECT fingerprint, severity, status, adjudication_json
       FROM mode_findings WHERE mode_id=? ORDER BY fingerprint`,
    [modeId],
    connection,
  );
  return modeModels.digest({
    phase: mode.phase,
    round: mode.current_round,
    tasks: tasks.map((row) => ({
      task_id: row.task_id,
      role: row.role,
      status: row.status,
      result: row.result_json ? modeModels.digest(modeResult(row)) : null,
    })),
    findings,
  });
}

function trackProgress(connection: stateStore.Connection, mode: RuntimeRecord): number {
  const fingerprint = snapshotFingerprint(connection, Number(mode.mode_id));
  const state = decoded(mode, "state_json");
  state.no_progress_count = fingerprint === mode.state_fingerprint
    ? Number(state.no_progress_count ?? 0) + 1
    : 0;
  connection.execute(
    "UPDATE modes SET state_json=?, state_fingerprint=?, updated_at=? WHERE mode_id=?",
    [json(state), fingerprint, stateStore.now(), mode.mode_id],
  );
  mode.state_json = json(state);
  mode.state_fingerprint = fingerprint;
  return Number(state.no_progress_count);
}

function recordFinding(
  connection: stateStore.Connection,
  mode: RuntimeRecord,
  taskId: number,
  finding: RuntimeRecord,
  sourceKind: string,
  allowNew = true,
): [string | null, boolean] {
  const normalized = modeModels.validateFinding(finding);
  const fingerprint = normalized.fingerprint as string;
  const existing = connection.execute(
    "SELECT * FROM mode_findings WHERE mode_id=? AND fingerprint=?",
    [mode.mode_id, fingerprint],
  ).fetchone();
  let findingId: number;
  let created: boolean;
  if (existing === null) {
    if (!allowNew) return [null, false];
    const timestamp = stateStore.now();
    findingId = connection.execute(
      `INSERT INTO mode_findings(
         mode_id, fingerprint, rule_name, title, description, location,
         severity, status, canonical_json, first_seen_round,
         discovered_by_task_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'candidate', ?, ?, ?, ?, ?)`,
      [
        mode.mode_id,
        fingerprint,
        normalized.rule,
        normalized.title,
        normalized.description,
        normalized.location,
        normalized.severity,
        json(normalized),
        mode.current_round,
        taskId,
        timestamp,
        timestamp,
      ],
    ).lastrowid;
    created = true;
  } else {
    findingId = Number(existing.finding_id);
    created = false;
    if ((SEVERITY_RANK[normalized.severity] ?? -1) > (SEVERITY_RANK[existing.severity] ?? -1)) {
      connection.execute(
        "UPDATE mode_findings SET severity=?, updated_at=? WHERE finding_id=?",
        [normalized.severity, stateStore.now(), findingId],
      );
    }
  }
  connection.execute(
    `INSERT OR IGNORE INTO mode_finding_provenance(
       finding_id, task_id, source_kind, raw_finding_json,
       evidence_hash, created_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
    [findingId, taskId, sourceKind, json(normalized), modeModels.digest(normalized.evidence), stateStore.now()],
  );
  return [fingerprint, created];
}

function recordReviewFindings(
  connection: stateStore.Connection,
  mode: RuntimeRecord,
  rows: RuntimeRecord[],
): RuntimeRecord[] {
  const config = decoded(mode, "config_json");
  const overflow: RuntimeRecord[] = [];
  for (const row of rows) {
    const findings = modeResult(row).findings ?? [];
    if (!Array.isArray(findings)) throw new ValueError("mode_result.findings must be an array");
    for (const finding of findings) {
      const count = Number(connection.execute(
        "SELECT COUNT(*) AS n FROM mode_findings WHERE mode_id=?",
        [mode.mode_id],
      ).fetchone()?.n ?? 0);
      const [fingerprint] = recordFinding(
        connection,
        mode,
        Number(row.task_id),
        finding,
        "reviewer",
        count < Number(config.max_candidates),
      );
      if (fingerprint === null) {
        const normalized = modeModels.validateFinding(finding);
        overflow.push({
          fingerprint: normalized.fingerprint,
          severity: normalized.severity,
          task_id: row.task_id,
          evidence_hash: modeModels.digest(normalized.evidence),
        });
      }
    }
  }
  if (overflow.length > 0) {
    const state = decoded(mode, "state_json");
    state.candidate_overflow = [...(state.candidate_overflow ?? []), ...overflow];
    connection.execute("UPDATE modes SET state_json=? WHERE mode_id=?", [json(state), mode.mode_id]);
    mode.state_json = json(state);
  }
  return overflow;
}

function verifierPlans(
  connection: stateStore.Connection,
  context: RuntimeRecord,
  mode: RuntimeRecord,
): RuntimeRecord[] {
  const findings = stateStore.fetchall(
    `SELECT f.* FROM mode_findings f
      WHERE f.mode_id=? AND f.status='candidate'
      ORDER BY f.fingerprint`,
    [mode.mode_id],
    connection,
  );
  const plans: RuntimeRecord[] = [];
  for (const finding of findings) {
    const provenance = connection.execute(
      `SELECT task_id FROM mode_finding_provenance
        WHERE finding_id=? ORDER BY provenance_id LIMIT 1`,
      [finding.finding_id],
    ).fetchone();
    if (provenance === null) throw new ValueError("candidate has no provenance");
    const proposer = Number(provenance.task_id);
    for (const [role, suffix] of [
      ["verifier_reproduce", "reproduce"],
      ["verifier_falsify", "falsify"],
    ] as const) {
      const existing = connection.execute(
        `SELECT 1 FROM mode_tasks
          WHERE mode_id=? AND candidate_fingerprint=? AND role=?`,
        [mode.mode_id, finding.fingerprint, role],
      ).fetchone();
      if (existing !== null) continue;
      plans.push({
        role,
        candidate_fingerprint: finding.fingerprint,
        proposer_task_id: proposer,
        spec: {
          key: `mode-${mode.mode_id}-${finding.fingerprint}-${suffix}`,
          goal: `${mode.objective}\n${suffix[0]!.toUpperCase()}${suffix.slice(1)} candidate ${finding.fingerprint} independently.`,
          intent_hint: "review",
          complexity_hint: "high",
          model_tier_hint: "strong",
          priority: 90,
          output_contract: outputContract(role),
          constraints: taskConstraints(context, {
            readOnly: true,
            notes: [
              `Assigned candidate: ${finding.fingerprint}`,
              `Independent ${suffix} verifier; do not trust or coordinate with proposer task ${proposer}.`,
            ],
          }),
          depends_on: [{ task_id: proposer, condition: "success" }],
        },
      });
    }
  }
  return plans;
}

function ingestVerifications(connection: stateStore.Connection, mode: RuntimeRecord): void {
  const config = decoded(mode, "config_json");
  const state = decoded(mode, "state_json");
  let expansions = Number(state.candidate_expansions ?? 0);
  const overflow: RuntimeRecord[] = [...(state.candidate_overflow ?? [])];
  const rows = modeRows(connection, Number(mode.mode_id), new Set(["verifier_reproduce", "verifier_falsify"]));
  for (const row of rows) {
    if (row.status !== "done") continue;
    if (connection.execute("SELECT 1 FROM mode_verifications WHERE task_id=?", [row.task_id]).fetchone() !== null) continue;
    const result = modeResult(row);
    const finding = connection.execute(
      "SELECT * FROM mode_findings WHERE mode_id=? AND fingerprint=?",
      [mode.mode_id, row.candidate_fingerprint],
    ).fetchone();
    if (finding === null) throw new ValueError("verifier references a missing Runtime candidate");
    connection.execute(
      `INSERT INTO mode_verifications(
         finding_id, task_id, verifier_kind, verdict, evidence_json,
         evidence_hash, submitted_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        finding.finding_id,
        row.task_id,
        row.role === "verifier_reproduce" ? "reproduce" : "falsify",
        result.verdict,
        json(result.evidence),
        modeModels.digest(result.evidence),
        stateStore.now(),
      ],
    );
    const discovered = result.discovered_findings ?? [];
    if (!Array.isArray(discovered)) throw new ValueError("verifier discovered_findings must be an array");
    for (const findingValue of discovered) {
      const normalized = modeModels.validateFinding(findingValue);
      const existingCandidate = connection.execute(
        "SELECT 1 FROM mode_findings WHERE mode_id=? AND fingerprint=?",
        [mode.mode_id, normalized.fingerprint],
      ).fetchone();
      const candidateCount = Number(connection.execute(
        "SELECT COUNT(*) AS n FROM mode_findings WHERE mode_id=?",
        [mode.mode_id],
      ).fetchone()?.n ?? 0);
      const allowNew = existingCandidate !== null ||
        (expansions < Number(config.max_expansions) && candidateCount < Number(config.max_candidates));
      const [fingerprint, created] = recordFinding(
        connection,
        mode,
        Number(row.task_id),
        normalized,
        "verifier_discovery",
        allowNew,
      );
      if (created) expansions += 1;
      else if (fingerprint === null) {
        overflow.push({
          fingerprint: normalized.fingerprint,
          severity: normalized.severity,
          task_id: row.task_id,
          evidence_hash: modeModels.digest(normalized.evidence),
        });
      }
    }
  }
  state.candidate_expansions = expansions;
  state.candidate_overflow = overflow;
  connection.execute("UPDATE modes SET state_json=? WHERE mode_id=?", [json(state), mode.mode_id]);
  mode.state_json = json(state);
}

function adjudicate(connection: stateStore.Connection, mode: RuntimeRecord): void {
  const findings = stateStore.fetchall(
    "SELECT * FROM mode_findings WHERE mode_id=? AND status='candidate' ORDER BY fingerprint",
    [mode.mode_id],
    connection,
  );
  for (const finding of findings) {
    const assigned = stateStore.fetchall(
      `SELECT task_id, role, proposer_task_id FROM mode_tasks
        WHERE mode_id=? AND candidate_fingerprint=?
          AND role IN ('verifier_reproduce','verifier_falsify')
        ORDER BY role`,
      [mode.mode_id, finding.fingerprint],
      connection,
    );
    const verifications = stateStore.fetchall(
      "SELECT v.* FROM mode_verifications v WHERE v.finding_id=? ORDER BY verifier_kind",
      [finding.finding_id],
      connection,
    );
    const roles = new Set(assigned.map((item) => item.role));
    const independent = new Set(assigned.map((item) => item.task_id)).size >= 2 &&
      roles.size === 2 && roles.has("verifier_reproduce") && roles.has("verifier_falsify") &&
      assigned.every((item) => item.task_id !== item.proposer_task_id);
    if (!independent || verifications.length < 2) continue;
    const verdicts = new Set(verifications.map((item) => item.verdict));
    const status = verdicts.size === 1 && verdicts.has("confirmed")
      ? "confirmed"
      : verdicts.size === 1 && verdicts.has("rejected")
        ? "rejected"
        : "unresolved";
    const adjudication = {
      verdicts: verifications.map((item) => ({
        task_id: item.task_id,
        kind: item.verifier_kind,
        verdict: item.verdict,
        evidence_hash: item.evidence_hash,
      })),
      independent,
    };
    connection.execute(
      "UPDATE mode_findings SET status=?, adjudication_json=?, updated_at=? WHERE finding_id=?",
      [status, json(adjudication), stateStore.now(), finding.finding_id],
    );
  }
}

function fixerPlans(
  connection: stateStore.Connection,
  context: RuntimeRecord,
  mode: RuntimeRecord,
): RuntimeRecord[] {
  const findings = stateStore.fetchall(
    `SELECT * FROM mode_findings f
      WHERE mode_id=? AND status='confirmed'
        AND NOT EXISTS (
          SELECT 1 FROM mode_tasks mt
           WHERE mt.mode_id=f.mode_id AND mt.role='fixer'
             AND mt.candidate_fingerprint=f.fingerprint
        )
      ORDER BY fingerprint`,
    [mode.mode_id],
    connection,
  );
  return findings.map((finding) => {
    const verifierIds = stateStore.fetchall(
      "SELECT v.task_id FROM mode_verifications v WHERE v.finding_id=? ORDER BY v.task_id",
      [finding.finding_id],
      connection,
    ).map((row) => Number(row.task_id));
    return {
      role: "fixer",
      candidate_fingerprint: finding.fingerprint,
      spec: {
        key: `mode-${mode.mode_id}-fix-${finding.fingerprint}`,
        goal: `${mode.objective}\nFix confirmed finding ${finding.fingerprint} only.`,
        intent_hint: "fix",
        complexity_hint: "high",
        model_tier_hint: "strong",
        priority: 95,
        output_contract: outputContract("fixer"),
        constraints: taskConstraints(context, {
          readOnly: false,
          notes: [
            `Runtime-adjudicated confirmed finding: ${finding.fingerprint}`,
            "Do not fix rejected or unresolved candidates.",
          ],
        }),
        depends_on: verifierIds.map((taskId) => ({ task_id: taskId, condition: "success" })),
      },
    };
  });
}

function response(
  mode: RuntimeRecord,
  options: { taskIds?: number[]; reason?: string; schedule?: boolean } = {},
): RuntimeRecord {
  const value: RuntimeRecord = {
    accepted: true,
    mode_id: mode.mode_id,
    mode: mode.kind,
    status: mode.status,
    phase: mode.phase,
    round: mode.current_round,
    task_ids: options.taskIds ?? [],
    schedule_required: options.schedule ?? false,
  };
  if (options.reason) value.reason = options.reason;
  return value;
}

function advanceSwarm(connection: stateStore.Connection, mode: RuntimeRecord): RuntimeRecord {
  const rows = modeRows(connection, Number(mode.mode_id), "swarm");
  if (rows.some((row) => new Set(["failed", "blocked", "cancelled"]).has(row.status))) {
    return closeMode(connection, mode, "blocked", "swarm task did not complete");
  }
  if (rows.length > 0 && rows.every((row) => row.status === "done")) {
    return closeMode(connection, mode, "completed", "all compiled swarm tasks completed");
  }
  return response(mode, { reason: "swarm tasks are still running" });
}

function advanceLoop(
  connection: stateStore.Connection,
  context: RuntimeRecord,
  mode: RuntimeRecord,
  compileTasks: CompileTasks,
): RuntimeRecord {
  const round = currentRound(connection, mode);
  const rows = modeRows(connection, Number(mode.mode_id), undefined, Number(round.round_id));
  const roles: Record<string, Set<string>> = {
    develop: new Set(["developer"]),
    validate: new Set(["validator"]),
    review: new Set(["reviewer"]),
    re_review: new Set(["reviewer"]),
    verify: new Set(["verifier_reproduce", "verifier_falsify"]),
    improve: new Set(["improver"]),
    revalidate: new Set(["validator"]),
  };
  const phaseRoles = roles[mode.phase];
  if (!phaseRoles) return closeMode(connection, mode, "blocked", "loop phase is invalid");
  const phaseRows = rows.filter((row) => phaseRoles.has(row.role));
  if (phaseRows.length === 0) return closeMode(connection, mode, "blocked", "loop phase has no compiled task");
  if (phaseRows.some((row) => new Set(["failed", "blocked", "cancelled"]).has(row.status))) {
    return closeMode(connection, mode, "blocked", "loop phase task did not complete");
  }
  if (!phaseRows.every((row) => row.status === "done")) {
    return response(mode, { reason: "loop phase tasks are still running" });
  }
  const config = decoded(mode, "config_json");
  const exitConditions = config.exit_conditions as RuntimeRecord;
  if (mode.phase === "develop") {
    const plan = validatorPlan(context, mode, Number(mode.current_round), Number(phaseRows[0]!.task_id), "validation");
    const taskIds = compile(connection, context, mode, Number(round.round_id), [plan], compileTasks);
    setPhase(connection, mode, "validate");
    return response(mode, { taskIds, schedule: true });
  }
  if (mode.phase === "validate" || mode.phase === "revalidate") {
    const result = modeResult(phaseRows[0]!);
    if (result.status !== "passed") {
      return closeMode(
        connection,
        mode,
        "blocked",
        `deterministic ${mode.phase} did not pass`,
        exitConditions.validation_failure,
      );
    }
    if (mode.phase === "validate") {
      const plan = loopReviewerPlan(context, mode, Number(mode.current_round), Number(phaseRows[0]!.task_id));
      const taskIds = compile(connection, context, mode, Number(round.round_id), [plan], compileTasks);
      setPhase(connection, mode, "review");
      return response(mode, { taskIds, schedule: true });
    }
    if (Number(mode.current_round) >= Number(config.max_rounds)) {
      return closeMode(
        connection,
        mode,
        "blocked",
        "max_rounds guard reached after required revalidation",
        exitConditions.max_rounds,
      );
    }
    connection.execute(
      "UPDATE mode_rounds SET status='completed', completed_at=? WHERE round_id=?",
      [stateStore.now(), round.round_id],
    );
    const nextRound = Number(mode.current_round) + 1;
    const nextPhase = "re_review";
    const nextRoundId = newRound(connection, Number(mode.mode_id), nextRound, nextPhase);
    const plan = loopReviewerPlan(context, mode, nextRound, Number(phaseRows[0]!.task_id));
    const taskIds = compile(connection, context, mode, nextRoundId, [plan], compileTasks);
    setPhase(connection, mode, nextPhase, nextRound);
    return response(mode, { taskIds, schedule: true });
  }
  if (mode.phase === "review" || mode.phase === "re_review") {
    const result = modeResult(phaseRows[0]!);
    recordReviewFindings(connection, mode, phaseRows);
    if (result.verdict === "pass" && (!Array.isArray(result.findings) || result.findings.length === 0)) {
      return closeMode(
        connection,
        mode,
        "completed",
        `review passed (exit condition: ${exitConditions.passed})`,
        "passed",
      );
    }
    if (result.verdict === "blocked") return closeMode(connection, mode, "blocked", "reviewer blocked the loop", "blocked");
    const plans = verifierPlans(connection, context, mode);
    if (plans.length === 0) return closeMode(connection, mode, "blocked", "review findings lack verifier assignments");
    try {
      const taskIds = compile(
        connection,
        context,
        mode,
        Number(round.round_id),
        actionBatch(context, plans),
        compileTasks,
      );
      setPhase(connection, mode, "verify");
      return response(mode, { taskIds, schedule: true });
    } catch (error) {
      if (error instanceof ValueError) return closeMode(connection, mode, "blocked", error.message);
      throw error;
    }
  }
  if (mode.phase === "verify") {
    ingestVerifications(connection, mode);
    adjudicate(connection, mode);
    const plans = verifierPlans(connection, context, mode);
    if (plans.length > 0) {
      try {
        const taskIds = compile(
          connection,
          context,
          mode,
          Number(round.round_id),
          actionBatch(context, plans),
          compileTasks,
        );
        return response(mode, { taskIds, schedule: true });
      } catch (error) {
        if (error instanceof ValueError) return closeMode(connection, mode, "blocked", error.message);
        throw error;
      }
    }
    const unresolvedHigh = Number(connection.execute(
      `SELECT COUNT(*) AS n FROM mode_findings
        WHERE mode_id=? AND status='unresolved'
          AND severity IN ('high','critical')`,
      [mode.mode_id],
    ).fetchone()?.n ?? 0);
    if (unresolvedHigh > 0) {
      return closeMode(
        connection,
        mode,
        "blocked",
        "high-severity findings remain unresolved",
        exitConditions.high_severity_unresolved,
      );
    }
    const overflow = decoded(mode, "state_json").candidate_overflow ?? [];
    if ((overflow as RuntimeRecord[]).some((item) => new Set(["high", "critical"]).has(item.severity))) {
      return closeMode(connection, mode, "blocked", "high-severity candidate budget overflow");
    }
    if ((overflow as unknown[]).length > 0) return closeMode(connection, mode, "blocked", "candidate budget guard reached");
    const confirmed = stateStore.fetchall(
      `SELECT fingerprint FROM mode_findings
        WHERE mode_id=? AND status='confirmed' ORDER BY fingerprint`,
      [mode.mode_id],
      connection,
    ).map((row) => row.fingerprint as string);
    if (confirmed.length === 0) {
      return closeMode(connection, mode, "completed", "review findings were not confirmed", "passed");
    }
    const plan = improverPlan(
      context,
      mode,
      Number(mode.current_round),
      phaseRows.map((row) => Number(row.task_id)),
      confirmed,
    );
    const taskIds = compile(connection, context, mode, Number(round.round_id), [plan], compileTasks);
    setPhase(connection, mode, "improve");
    return response(mode, { taskIds, schedule: true });
  }
  const result = modeResult(phaseRows[0]!);
  if (!result.changed) {
    return closeMode(connection, mode, "blocked", "no progress reported by improver", exitConditions.no_progress);
  }
  const plan = validatorPlan(context, mode, Number(mode.current_round), Number(phaseRows[0]!.task_id), "revalidation");
  const taskIds = compile(connection, context, mode, Number(round.round_id), [plan], compileTasks);
  setPhase(connection, mode, "revalidate");
  return response(mode, { taskIds, schedule: true });
}

function advanceReview(
  connection: stateStore.Connection,
  context: RuntimeRecord,
  mode: RuntimeRecord,
  compileTasks: CompileTasks,
): RuntimeRecord {
  const config = decoded(mode, "config_json");
  const round = currentRound(connection, mode);
  if (mode.phase === "review") {
    const reviewers = modeRows(connection, Number(mode.mode_id), "reviewer");
    if (reviewers.some((row) => new Set(["failed", "blocked", "cancelled"]).has(row.status))) {
      return closeMode(connection, mode, "blocked", "independent reviewer did not complete");
    }
    if (reviewers.length === 0 || !reviewers.every((row) => row.status === "done")) {
      return response(mode, { reason: "independent reviewers are still running" });
    }
    recordReviewFindings(connection, mode, reviewers);
    const plans = verifierPlans(connection, context, mode);
    if (plans.length === 0) {
      const overflow = decoded(mode, "state_json").candidate_overflow ?? [];
      if ((overflow as RuntimeRecord[]).some((item) => new Set(["high", "critical"]).has(item.severity))) {
        return closeMode(connection, mode, "blocked", "high-severity candidate budget overflow");
      }
      if ((overflow as unknown[]).length > 0) return closeMode(connection, mode, "blocked", "candidate budget guard reached");
      return closeMode(connection, mode, "completed", "review produced no candidates");
    }
    try {
      const taskIds = compile(
        connection,
        context,
        mode,
        Number(round.round_id),
        actionBatch(context, plans),
        compileTasks,
      );
      setPhase(connection, mode, "verify");
      return response(mode, { taskIds, schedule: true });
    } catch (error) {
      if (error instanceof ValueError) return closeMode(connection, mode, "blocked", error.message);
      throw error;
    }
  }
  if (mode.phase === "verify") {
    const verifiers = modeRows(
      connection,
      Number(mode.mode_id),
      new Set(["verifier_reproduce", "verifier_falsify"]),
    );
    if (verifiers.some((row) => new Set(["failed", "blocked", "cancelled"]).has(row.status))) {
      return closeMode(connection, mode, "blocked", "candidate verifier did not complete");
    }
    if (verifiers.length === 0 || !verifiers.every((row) => row.status === "done")) {
      return response(mode, { reason: "candidate verifiers are still running" });
    }
    ingestVerifications(connection, mode);
    adjudicate(connection, mode);
    const plans = verifierPlans(connection, context, mode);
    if (plans.length > 0) {
      try {
        const taskIds = compile(
          connection,
          context,
          mode,
          Number(round.round_id),
          actionBatch(context, plans),
          compileTasks,
        );
        return response(mode, { taskIds, schedule: true });
      } catch (error) {
        if (error instanceof ValueError) return closeMode(connection, mode, "blocked", error.message);
        throw error;
      }
    }
    const unresolvedHigh = Number(connection.execute(
      `SELECT COUNT(*) AS n FROM mode_findings
        WHERE mode_id=? AND status='unresolved'
          AND severity IN ('high','critical')`,
      [mode.mode_id],
    ).fetchone()?.n ?? 0);
    const overflow = decoded(mode, "state_json").candidate_overflow ?? [];
    if (
      unresolvedHigh > 0 ||
      (overflow as RuntimeRecord[]).some((item) => new Set(["high", "critical"]).has(item.severity))
    ) return closeMode(connection, mode, "blocked", "high-severity findings remain unresolved");
    if ((overflow as unknown[]).length > 0) {
      return closeMode(connection, mode, "blocked", "candidate expansion budget guard reached");
    }
    if (config.create_fix_tasks) {
      const fixers = fixerPlans(connection, context, mode);
      if (fixers.length > 0) {
        try {
          const taskIds = compile(
            connection,
            context,
            mode,
            Number(round.round_id),
            actionBatch(context, fixers),
            compileTasks,
          );
          setPhase(connection, mode, "fix");
          return response(mode, { taskIds, schedule: true });
        } catch (error) {
          if (error instanceof ValueError) return closeMode(connection, mode, "blocked", error.message);
          throw error;
        }
      }
    }
    return closeMode(connection, mode, "completed", "review candidates adjudicated");
  }
  const fixers = modeRows(connection, Number(mode.mode_id), "fixer");
  if (fixers.some((row) => new Set(["failed", "blocked", "cancelled"]).has(row.status))) {
    return closeMode(connection, mode, "blocked", "confirmed finding fixer did not complete");
  }
  if (fixers.length === 0 || !fixers.every((row) => row.status === "done")) {
    return response(mode, { reason: "confirmed finding fixers are still running" });
  }
  const remaining = fixerPlans(connection, context, mode);
  if (remaining.length > 0) {
    try {
      const taskIds = compile(
        connection,
        context,
        mode,
        Number(round.round_id),
        actionBatch(context, remaining),
        compileTasks,
      );
      return response(mode, { taskIds, schedule: true });
    } catch (error) {
      if (error instanceof ValueError) return closeMode(connection, mode, "blocked", error.message);
      throw error;
    }
  }
  return closeMode(connection, mode, "completed", "confirmed findings fixed");
}

export function advanceMode(
  connection: stateStore.Connection,
  context: RuntimeRecord,
  payload: RuntimeRecord,
  actionId: string,
  compileTasks: CompileTasks,
  cancelMode: CancelMode,
): RuntimeRecord {
  const modeId = payload.mode_id;
  if (!Number.isSafeInteger(modeId) || typeof modeId === "boolean") {
    throw new ValueError("advance_mode mode_id must be an integer");
  }
  const mode = stateStore.getMode(modeId, connection);
  if (mode === null || mode.root_id !== context.run.root_id) throw new ValueError("mode must belong to the current Run");
  if (mode.owner_task_id !== context.task.task_id) throw new ValueError("only the mode owner Task can advance it");
  const operation = payload.operation ?? "advance";
  if (operation !== "advance" && operation !== "cancel") {
    throw new ValueError("advance_mode operation must be advance or cancel");
  }
  if (modeModels.MODE_TERMINAL.has(mode.status)) return response(mode, { reason: "mode is already terminal" });
  let result: RuntimeRecord;
  if (operation === "cancel") {
    const reason = String(payload.reason || "owner requested mode cancellation").trim();
    cancelMode(connection, context.run, mode, reason);
    result = closeMode(connection, mode, "cancelled", reason, "cancelled");
  } else if (stateStore.now() >= Number(mode.deadline_at)) {
    result = closeMode(connection, mode, "blocked", "max_seconds guard reached", "budget_exhausted");
  } else if (mode.kind === "swarm") {
    result = advanceSwarm(connection, mode);
  } else if (mode.kind === "develop_review_improve") {
    result = advanceLoop(connection, context, mode, compileTasks);
  } else {
    result = advanceReview(connection, context, mode, compileTasks);
  }
  if (result.status === "running") {
    const config = decoded(mode, "config_json");
    const repeated = trackProgress(connection, mode);
    if (repeated >= Number(config.max_no_progress)) {
      const exitConditions = isRecord(config.exit_conditions) ? config.exit_conditions : {};
      result = closeMode(
        connection,
        mode,
        "blocked",
        "repeated-state/no-progress guard reached",
        typeof exitConditions.no_progress === "string" ? exitConditions.no_progress : "no_progress",
      );
    }
  }
  stateStore.appendEvent(
    connection,
    context.run.root_id,
    "ModeAdvanced",
    {
      mode_id: modeId,
      status: result.status,
      phase: result.phase,
      round: result.round,
      task_ids: result.task_ids,
    },
    context.task.task_id,
    context.attempt.attempt_id,
    null,
    actionId,
  );
  return result;
}

export function validateTaskModeResult(
  connection: stateStore.Connection,
  context: RuntimeRecord,
  payload: RuntimeRecord,
): RuntimeRecord | null {
  const link = stateStore.getModeTask(Number(context.task.task_id), connection);
  if (link === null) {
    if ("mode_result" in payload && payload.mode_result !== null && payload.mode_result !== undefined) {
      throw new ValueError("mode_result is only valid for a Runtime mode task");
    }
    return null;
  }
  const mode = stateStore.getMode(Number(link.mode_id), connection);
  if (mode === null) throw new ValueError("mode task references a missing mode");
  const normalized = modeModels.validateModeResult(link, mode, payload.mode_result);
  payload.mode_result = normalized;
  connection.execute("UPDATE mode_tasks SET result_validated=1 WHERE mode_task_id=?", [link.mode_task_id]);
  return normalized;
}

export function validateOwnerModesFinished(connection: stateStore.Connection, taskId: number): void {
  const rows = stateStore.fetchall(
    `SELECT mode_id, status FROM modes
      WHERE owner_task_id=? AND status NOT IN ('completed','cancelled')`,
    [taskId],
    connection,
  );
  if (rows.length > 0) {
    throw new ValueError(
      `task cannot finish done while owned modes are non-terminal-success: ${rows
        .map((row) => `${row.mode_id}:${row.status}`)
        .join(", ")}`,
    );
  }
}

function parseOptionalJson(raw: unknown, label: string): unknown {
  if (!raw) return null;
  if (typeof raw !== "string") throw new ValueError(`${label} must be JSON text`);
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ValueError(`${label} is invalid`);
  }
}

export function promptContext(connection: stateStore.Connection, taskId: number): string {
  const link = stateStore.getModeTask(taskId, connection);
  const owned = stateStore.fetchall(
    `SELECT mode_id, parent_mode_id, kind, status, phase, current_round, depth
       FROM modes WHERE owner_task_id=? ORDER BY mode_id`,
    [taskId],
    connection,
  );
  if (link === null && owned.length === 0) return "";
  const payload: RuntimeRecord = { owned_modes: owned };
  if (link !== null) {
    const mode = stateStore.getMode(Number(link.mode_id), connection);
    if (mode === null) throw new ValueError("mode task references a missing mode");
    const state = decoded(mode, "state_json");
    const dependencies = stateStore.fetchall(
      `SELECT upstream.task_id, upstream.status, attempt.result_json
         FROM task_dependencies dependency
         JOIN tasks upstream ON upstream.task_id=dependency.depends_on_task_id
         LEFT JOIN attempts attempt ON attempt.attempt_id=(
           SELECT current.attempt_id FROM attempts current
            WHERE current.task_id=upstream.task_id
            ORDER BY current.attempt_no DESC LIMIT 1
         )
        WHERE dependency.task_id=? ORDER BY upstream.task_id`,
      [taskId],
      connection,
    );
    let candidate: RuntimeRecord | null = null;
    let provenance: RuntimeRecord[] = [];
    if (link.candidate_fingerprint) {
      candidate = connection.execute(
        `SELECT fingerprint, rule_name, title, description, location,
                severity, status, canonical_json
           FROM mode_findings WHERE mode_id=? AND fingerprint=?`,
        [link.mode_id, link.candidate_fingerprint],
      ).fetchone();
      if (candidate !== null) {
        provenance = stateStore.fetchall(
          `SELECT p.task_id, p.source_kind, p.raw_finding_json, p.evidence_hash
             FROM mode_finding_provenance p
             JOIN mode_findings f ON f.finding_id=p.finding_id
            WHERE f.mode_id=? AND f.fingerprint=?
            ORDER BY p.provenance_id`,
          [link.mode_id, link.candidate_fingerprint],
          connection,
        );
      }
    }
    const evidence = {
      base: state.evidence_bundle,
      dependencies: dependencies.map((row) => ({
        task_id: row.task_id,
        status: row.status,
        result: parseOptionalJson(row.result_json, "attempt result_json"),
      })),
      candidate,
      provenance,
    };
    payload.assignment = {
      mode_id: mode.mode_id,
      kind: mode.kind,
      phase: mode.phase,
      round: mode.current_round,
      role: link.role,
      candidate_fingerprint: link.candidate_fingerprint ?? null,
      proposer_task_id: link.proposer_task_id ?? null,
      profile_hint: parseOptionalJson(link.profile_hint_json, "mode profile_hint_json"),
      dependency_evidence_bundle: modeModels.boundedBundle(
        evidence,
        modeModels.MAX_EVIDENCE_BYTES,
        ["candidate", "dependencies", "provenance"],
      ),
    };
  }
  return `\n[MODE CONTEXT]\n${json(payload)}\n`;
}
