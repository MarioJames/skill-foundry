import * as executionConfig from "./execution_config.ts";
import * as modeModels from "./mode_models.ts";
import * as stateStore from "./state_store.ts";
import { canonicalJson, isRecord, type RuntimeRecord, ValueError } from "./runtime_types.ts";

export const TERMINAL_TASKS = new Set(["done", "failed", "blocked", "cancelled"]);
const SEVERITY_RANK: Readonly<Record<string, number>> = Object.freeze({ low: 0, medium: 1, high: 2, critical: 3 });
const RAVF_CONTEXT_BYTES = 128_000;

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

function recipe(mode: RuntimeRecord): string {
  return modeModels.modeRecipe(mode);
}

function semanticRole(mode: RuntimeRecord, role: unknown): string {
  if (recipe(mode) === "verification_fix" && role === "reviewer") return "diagnostician";
  if (recipe(mode) === "ravf" && role === "verifier_falsify") return "arguer";
  if (recipe(mode) === "ravf" && role === "verifier_reproduce") return "voter";
  return String(role);
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
    validator: 'Run deterministic validation without modifying files. Finish with mode_result {"stage":"validation|revalidation","status":"passed|failed|blocked","artifact_version":"...","commands":[...],"evidence":[...]} and the normal structured review object with "source":"self".',
    reviewer: 'Independently review the supplied bounded evidence. Finish with mode_result containing "findings":[{"title","description","claim","severity","location","rule","evidence","impact","confidence"}]. For develop_review_improve also include "verdict":"pass|changes_requested|blocked". The normal finish review object uses "source":"self".',
    verifier_reproduce: 'Reproduce the assigned candidate independently. Finish with mode_result containing "candidate_fingerprint", "verdict":"confirmed|rejected|unresolved", non-empty "evidence", optional "discovered_findings", and the normal structured review object with "source":"self".',
    verifier_falsify: 'Try to falsify the assigned candidate independently. Report the candidate truth, not whether the falsification attempt itself ran: finish with mode_result containing "candidate_fingerprint", "verdict":"confirmed|rejected|unresolved", non-empty "evidence", optional "discovered_findings", and the normal structured review object with "source":"self".',
    improver: 'Improve the prior result using the review findings. Finish with mode_result {"changed":true|false,"addressed_fingerprints":[...],"evidence":[...]}.',
    fixer: 'Fix exactly the Runtime-approved finding set in one coordinated change. Finish with mode_result {"fixed_fingerprints":[...],"evidence":[...]} including every approved fingerprint and no rejected or unrelated fingerprint.',
    diagnostician: 'Locate the deterministic validation failure without modifying files. Finish with mode_result {"verdict":"changes_requested","root_cause":"...","findings":[{"title","description","claim","severity","location","rule","evidence","impact","confidence"}],"evidence":[...]} and the normal structured review object with "source":"self".',
    arguer: 'Challenge the complete current Review result independently and fairly. Argue cannot create findings. Cover every supplied reviewer candidate exactly once in mode_result {"arguments":[{"candidate_fingerprint":"...","challenge_outcome":"review_stands|review_rebutted|review_needs_revision|uncertain","rationale":"...","roi":"positive|neutral|negative","bloat_risk":"low|medium|high","evidence":[...],"proposed_revision":null|{standard finding fields}}]}. proposed_revision is required only when the original Review is valid but needs correction. The normal finish review object uses "source":"self".',
    voter: 'Independently vote on every original reviewer candidate after comparing its full reviewer provenance with all arguer evidence. Cover every candidate exactly once in mode_result {"ballots":[{"candidate_fingerprint":"...","decision":"accept_original|accept_revised|reject|abstain","rationale":"...","expected_value":"high|medium|low|negative","evidence":[...],"revision_basis_task_ids":[...]}]}. accept_revised must cite the arguer task ids whose corrections it supports. Do not coordinate with other voters. The normal finish review object uses "source":"self".',
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
    mode: recipe(mode),
    status,
    outcome: state.terminal_outcome,
    phase: mode.phase,
    round: mode.current_round,
    reason,
    schedule_required: false,
    task_ids: [],
  };
  if (new Set(["multi_session_review", "ravf"]).has(recipe(mode))) {
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
  dependsOn: number | undefined,
  stage: "validation" | "revalidation",
): RuntimeRecord {
  const specification: RuntimeRecord = {
    key: `mode-${mode.mode_id}-round-${roundNumber}-${stage}`,
    goal: `${mode.objective}\nRun deterministic ${stage} for round ${roundNumber}; use unit tests, browser tests, or both as required by the evidence and repository.`,
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
  };
  if (dependsOn !== undefined) specification.depends_on = [{ task_id: dependsOn, condition: "success" }];
  return {
    role: "validator",
    spec: specification,
  };
}

function diagnosisPlan(
  context: RuntimeRecord,
  mode: RuntimeRecord,
  roundNumber: number,
  dependsOn: number,
): RuntimeRecord {
  return {
    role: "reviewer",
    spec: {
      key: `mode-${mode.mode_id}-round-${roundNumber}-diagnose`,
      goal: `${mode.objective}\nLocate the root cause of the failed deterministic validation in round ${roundNumber}.`,
      intent_hint: "review",
      complexity_hint: "high",
      model_tier_hint: "strong",
      priority: 90,
      output_contract: outputContract("diagnostician"),
      constraints: taskConstraints(context, {
        readOnly: true,
        notes: [
          `Persistent mode ${mode.mode_id}, round ${roundNumber} failure diagnosis.`,
          "Use the validation evidence; diagnose before proposing any change and do not modify files.",
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
      key: `mode-${mode.mode_id}-round-${mode.current_round}-review-${reviewer.id}`,
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

function ravfReviewerPlans(context: RuntimeRecord, mode: RuntimeRecord, config: RuntimeRecord): RuntimeRecord[] {
  return (config.reviewers as RuntimeRecord[]).map((reviewer) => ({
    role: "reviewer",
    profile_hint: reviewer.profile_hint,
    spec: {
      key: `mode-${mode.mode_id}-round-${mode.current_round}-ravf-review-${reviewer.id}`,
      goal: `${mode.objective}\nIndependently review the current change. Find as many material correctness, maintainability, security, and operability issues as evidence supports.`,
      intent_hint: "review",
      complexity_hint: "high",
      model_tier_hint: "strong",
      priority: 85,
      output_contract: outputContract("reviewer"),
      constraints: taskConstraints(context, {
        readOnly: true,
        notes: [
          "Review broadly and independently; do not coordinate with other reviewers.",
          "Report evidence-backed material findings, not cosmetic churn or findings invented to fill a quota.",
          `Return at most ${modeModels.RAVF_FINDINGS_PER_REVIEWER} highest-value findings; the five-reviewer union is capped at ${modeModels.RAVF_MAX_CANDIDATES}.`,
          `RAVF mode ${mode.mode_id}, round ${mode.current_round}, reviewer ${reviewer.id}.`,
        ],
        profileHint: reviewer.profile_hint,
      }),
    },
  }));
}

function currentCandidateRows(
  connection: stateStore.Connection,
  mode: RuntimeRecord,
  roundId: number,
): RuntimeRecord[] {
  return stateStore.fetchall(
    `SELECT DISTINCT f.*
       FROM mode_findings f
       JOIN mode_finding_provenance p ON p.finding_id=f.finding_id
       JOIN mode_tasks mt ON mt.task_id=p.task_id
      WHERE f.mode_id=? AND f.status='candidate' AND mt.round_id=?
      ORDER BY f.fingerprint`,
    [mode.mode_id, roundId],
    connection,
  );
}

function ravfArguerPlans(
  connection: stateStore.Connection,
  context: RuntimeRecord,
  mode: RuntimeRecord,
  round: RuntimeRecord,
  config: RuntimeRecord,
): RuntimeRecord[] {
  if (modeRows(connection, Number(mode.mode_id), "verifier_falsify", Number(round.round_id)).length > 0) return [];
  const candidates = currentCandidateRows(connection, mode, Number(round.round_id));
  if (candidates.length === 0) throw new ValueError("RAVF argue phase requires current Review candidates");
  const reviewerIds = modeRows(connection, Number(mode.mode_id), "reviewer", Number(round.round_id))
    .map((row) => Number(row.task_id));
  if (reviewerIds.length === 0) throw new ValueError("RAVF argue phase requires complete reviewer evidence");
  const fingerprints = candidates.map((finding) => String(finding.fingerprint));
  return (config.arguers as RuntimeRecord[]).map((arguer) => ({
      role: "verifier_falsify",
      profile_hint: arguer.profile_hint,
      spec: {
        key: `mode-${mode.mode_id}-round-${mode.current_round}-argue-${arguer.id}`,
        goal: `${mode.objective}\nRAVF arguer ${arguer.id}. Independently assess the complete Review result and judge every current candidate: ${fingerprints.join(", ")}.`,
        intent_hint: "review",
        complexity_hint: "high",
        model_tier_hint: "balanced",
        priority: 90,
        output_contract: outputContract("arguer"),
        constraints: taskConstraints(context, {
          readOnly: true,
          notes: [
            `Assess the complete Review output, including all reviewer provenance, for ${fingerprints.length} candidates.`,
            "Cover each supplied candidate exactly once and remain independent from reviewers and other arguers.",
            "Do not defend or reject a finding merely to create disagreement.",
            "Weigh correctness impact, expected maintenance value, implementation cost, and code-bloat risk.",
          ],
          profileHint: arguer.profile_hint,
        }),
        depends_on: reviewerIds.map((taskId) => ({ task_id: taskId, condition: "success" })),
      },
    }));
}

function ravfVoterPlans(
  connection: stateStore.Connection,
  context: RuntimeRecord,
  mode: RuntimeRecord,
  round: RuntimeRecord,
  config: RuntimeRecord,
): RuntimeRecord[] {
  if (modeRows(connection, Number(mode.mode_id), "verifier_reproduce", Number(round.round_id)).length > 0) return [];
  const candidates = currentCandidateRows(connection, mode, Number(round.round_id));
  if (candidates.length === 0) throw new ValueError("RAVF vote phase requires current Review candidates");
  const arguerIds = modeRows(connection, Number(mode.mode_id), "verifier_falsify", Number(round.round_id))
    .map((row) => Number(row.task_id));
  if (arguerIds.length !== (config.arguers as RuntimeRecord[]).length) {
    throw new ValueError("RAVF vote phase requires the complete fixed-size arguer pool");
  }
  const fingerprints = candidates.map((finding) => String(finding.fingerprint));
  return (config.voters as RuntimeRecord[]).map((voter) => ({
        role: "verifier_reproduce",
        profile_hint: voter.profile_hint,
        spec: {
          key: `mode-${mode.mode_id}-round-${mode.current_round}-vote-${voter.id}`,
          goal: `${mode.objective}\nRAVF voter ${voter.id}. Independently vote on every current candidate after comparing its reviewer evidence with all arguer evidence: ${fingerprints.join(", ")}.`,
          intent_hint: "review",
          complexity_hint: "low",
          model_tier_hint: "fast",
          priority: 88,
          output_contract: outputContract("voter"),
          constraints: taskConstraints(context, {
            readOnly: true,
            notes: [
              `Cast one independent ballot for each of ${fingerprints.length} candidates.`,
              "For every issue, compare the original reviewer claim and provenance with all independent arguer judgments.",
              "Vote for actual expected value; reject low-ROI or code-bloating work even when the underlying observation is technically true.",
              "Do not coordinate with other voters.",
            ],
            profileHint: voter.profile_hint,
          }),
          depends_on: arguerIds.map((taskId) => ({ task_id: taskId, condition: "success" })),
        },
      }));
}

function ravfFixerPlan(
  connection: stateStore.Connection,
  context: RuntimeRecord,
  mode: RuntimeRecord,
  round: RuntimeRecord,
): RuntimeRecord | null {
  if (modeRows(connection, Number(mode.mode_id), "fixer", Number(round.round_id)).length > 0) return null;
  const findings = stateStore.fetchall(
    `SELECT DISTINCT f.* FROM mode_findings f
      JOIN mode_finding_provenance p ON p.finding_id=f.finding_id
      JOIN mode_tasks proposed ON proposed.task_id=p.task_id AND proposed.round_id=?
     WHERE f.mode_id=? AND f.status='confirmed'
     ORDER BY f.fingerprint`,
    [round.round_id, mode.mode_id],
    connection,
  );
  if (findings.length === 0) return null;
  const fingerprints = findings.map((finding) => String(finding.fingerprint));
  const voterIds = modeRows(connection, Number(mode.mode_id), "verifier_reproduce", Number(round.round_id))
    .map((row) => Number(row.task_id));
  return {
      role: "fixer",
      spec: {
        key: `mode-${mode.mode_id}-round-${mode.current_round}-fix-approved`,
        goal: `${mode.objective}\nApply one coordinated fix for exactly the RAVF-approved findings: ${fingerprints.join(", ")}.`,
        intent_hint: "fix",
        complexity_hint: "high",
        model_tier_hint: "strong",
        priority: 95,
        output_contract: outputContract("fixer"),
        constraints: taskConstraints(context, {
          readOnly: false,
          notes: [
            `The main Agent integrated the independent ballots and approved exactly: ${fingerprints.join(", ")}.`,
            "Keep the fix scoped; do not implement rejected, unresolved, or unrelated suggestions.",
          ],
        }),
        depends_on: voterIds.map((taskId) => ({ task_id: taskId, condition: "success" })),
      },
    };
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
  if (new Set(["multi_session_review", "ravf"]).has(String(data.recipe)) && execution.backend !== "acp") {
    throw new ValueError(`${data.recipe} is ACP-only`);
  }
  const reviewers = new Set(["multi_session_review", "ravf"]).has(String(data.recipe))
    ? data.config.reviewers as RuntimeRecord[] : [];
  const arguers = data.recipe === "ravf" ? data.config.arguers as RuntimeRecord[] : [];
  const voters = data.recipe === "ravf" ? data.config.voters as RuntimeRecord[] : [];
  if ([reviewers, arguers, voters].some((participants) => participants.length > Number(context.run.max_children_per_action))) {
    throw new ValueError("reviewer, arguer, or voter count exceeds the Run max_children_per_action guard");
  }
  for (const participant of [...reviewers, ...arguers, ...voters]) {
    if (participant.profile_hint !== null) {
      executionConfig.selectProfile(execution, { profileHint: participant.profile_hint });
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
    fixed_fingerprints: [],
  };
  const phase = data.recipe === "swarm"
    ? "swarm"
    : data.recipe === "develop_review_improve"
      ? (data.config.phases?.[0] ?? "develop")
      : data.recipe === "verification_fix"
        ? "validate"
        : "review";
  const modeId = connection.execute(
    `INSERT INTO modes(
       root_id, owner_task_id, parent_mode_id, kind, recipe, status, phase,
       current_round, depth, objective, config_json, state_json,
       deadline_at, started_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'running', ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
    [
      context.run.root_id,
      context.task.task_id,
      parent?.mode_id ?? null,
      data.kind,
      data.recipe,
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
  const plans = data.recipe === "swarm"
    ? swarmPlans(data.tasks)
    : data.recipe === "develop_review_improve"
      ? [developerPlan(context, mode, 1)]
      : data.recipe === "verification_fix"
        ? [validatorPlan(context, mode, 1, undefined, "validation")]
        : data.recipe === "ravf"
          ? ravfReviewerPlans(context, mode, data.config)
          : reviewerPlans(context, mode, data.config);
  const taskIds = compile(connection, context, mode, roundId, plans, compileTasks);
  const fingerprint = snapshotFingerprint(connection, modeId);
  connection.execute("UPDATE modes SET state_fingerprint=? WHERE mode_id=?", [fingerprint, modeId]);
  stateStore.appendEvent(
    connection,
    context.run.root_id,
    "ModeStarted",
    { mode_id: modeId, kind: data.kind, recipe: data.recipe, task_ids: taskIds, parent_mode_id: data.parent_mode_id },
    context.task.task_id,
    context.attempt.attempt_id,
    null,
    actionId,
  );
  return {
    accepted: true,
    mode_id: modeId,
    mode: data.recipe,
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
  const state = decoded(mode, "state_json");
  const fixedFingerprints = new Set(
    Array.isArray(state.fixed_fingerprints) ? state.fixed_fingerprints.map((item) => String(item)) : [],
  );
  const fixed: RuntimeRecord[] = [];
  const quorum: RuntimeRecord[] = [];
  for (const row of findingRows) {
    const canonical = decoded({ canonical_json: row.canonical_json }, "canonical_json");
    canonical.fingerprint = row.fingerprint;
    canonical.severity = row.severity;
    canonical.status = row.status;
    canonical.adjudication = row.adjudication_json
      ? decoded({ adjudication_json: row.adjudication_json }, "adjudication_json")
      : null;
    if (recipe(mode) === "ravf" && fixedFingerprints.has(String(row.fingerprint))) fixed.push(canonical);
    else if (row.status in findings) findings[row.status]!.push(canonical);
    if (recipe(mode) === "ravf") {
      const adjudication = canonical.adjudication as RuntimeRecord | null;
      const vote = isRecord(adjudication?.vote) ? adjudication.vote : {};
      const ballots = Array.isArray(vote.ballots) ? vote.ballots as RuntimeRecord[] : [];
      quorum.push({
        fingerprint: row.fingerprint,
        status: row.status,
        required: { voters: Number(vote.quorum ?? 0), rule: "strict_majority" },
        observed: ballots,
        met: Number(vote.quorum ?? 0) >= 3 && new Set(ballots.map((item) => item.task_id)).size >= Number(vote.quorum),
      });
    } else {
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
  return {
    verdict,
    reviewed_artifact: state.evidence_bundle,
    confirmed_findings: findings.confirmed,
    rejected_findings: findings.rejected,
    unresolved_findings: findings.unresolved,
    fixed_findings: fixed,
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
    if (existing.status !== "candidate" && Number(existing.first_seen_round) < Number(mode.current_round)) {
      connection.execute(
        `UPDATE mode_findings
            SET status='candidate', canonical_json=?, adjudication_json=NULL, updated_at=?
          WHERE finding_id=?`,
        [json(normalized), stateStore.now(), findingId],
      );
      connection.execute("DELETE FROM mode_verifications WHERE finding_id=?", [findingId]);
      const state = decoded(mode, "state_json");
      state.fixed_fingerprints = Array.isArray(state.fixed_fingerprints)
        ? state.fixed_fingerprints.filter((item) => item !== fingerprint)
        : [];
      connection.execute("UPDATE modes SET state_json=? WHERE mode_id=?", [json(state), mode.mode_id]);
      mode.state_json = json(state);
    }
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
      const normalized = modeModels.validateFinding(finding);
      const ravf = recipe(mode) === "ravf";
      const roundId = Number(row.round_id);
      if (ravf && !Number.isSafeInteger(roundId)) {
        throw new ValueError("RAVF Reviewer task is missing its round identity");
      }
      const alreadyInRound = ravf && connection.execute(
        `SELECT 1
           FROM mode_findings f
           JOIN mode_finding_provenance p ON p.finding_id=f.finding_id
           JOIN mode_tasks mt ON mt.task_id=p.task_id
          WHERE f.mode_id=? AND f.fingerprint=? AND mt.round_id=?
          LIMIT 1`,
        [mode.mode_id, normalized.fingerprint, roundId],
      ).fetchone() !== null;
      const count = ravf
        ? currentCandidateRows(connection, mode, roundId).length
        : Number(connection.execute(
          "SELECT COUNT(*) AS n FROM mode_findings WHERE mode_id=?",
          [mode.mode_id],
        ).fetchone()?.n ?? 0);
      if (ravf && !alreadyInRound && count >= Number(config.max_candidates)) {
        overflow.push({
          fingerprint: normalized.fingerprint,
          severity: normalized.severity,
          task_id: row.task_id,
          evidence_hash: modeModels.digest(normalized.evidence),
        });
        continue;
      }
      const [fingerprint] = recordFinding(
        connection,
        mode,
        Number(row.task_id),
        normalized,
        "reviewer",
        ravf || count < Number(config.max_candidates),
      );
      if (fingerprint === null) {
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
          WHERE mode_id=? AND round_id=? AND candidate_fingerprint=? AND role=?`,
        [mode.mode_id, currentRound(connection, mode).round_id, finding.fingerprint, role],
      ).fetchone();
      if (existing !== null) continue;
      plans.push({
        role,
        candidate_fingerprint: finding.fingerprint,
        proposer_task_id: proposer,
        spec: {
          key: `mode-${mode.mode_id}-round-${mode.current_round}-${finding.fingerprint}-${suffix}`,
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
  const round = currentRound(connection, mode);
  const rows = modeRows(
    connection,
    Number(mode.mode_id),
    new Set(["verifier_reproduce", "verifier_falsify"]),
    Number(round.round_id),
  );
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
  const round = currentRound(connection, mode);
  const findings = stateStore.fetchall(
    "SELECT * FROM mode_findings WHERE mode_id=? AND status='candidate' ORDER BY fingerprint",
    [mode.mode_id],
    connection,
  );
  for (const finding of findings) {
    const assigned = stateStore.fetchall(
      `SELECT task_id, role, proposer_task_id FROM mode_tasks
        WHERE mode_id=? AND round_id=? AND candidate_fingerprint=?
          AND role IN ('verifier_reproduce','verifier_falsify')
        ORDER BY role`,
      [mode.mode_id, round.round_id, finding.fingerprint],
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
  const round = currentRound(connection, mode);
  const findings = stateStore.fetchall(
    `SELECT * FROM mode_findings f
      WHERE mode_id=? AND status='confirmed'
        AND NOT EXISTS (
          SELECT 1 FROM mode_tasks mt
           WHERE mt.mode_id=f.mode_id AND mt.role='fixer'
             AND mt.round_id=?
             AND mt.candidate_fingerprint=f.fingerprint
        )
      ORDER BY fingerprint`,
    [mode.mode_id, round.round_id],
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
        key: `mode-${mode.mode_id}-round-${mode.current_round}-fix-${finding.fingerprint}`,
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
    mode: recipe(mode),
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

function modeFindingFingerprints(rows: RuntimeRecord[]): string[] {
  const fingerprints = new Set<string>();
  for (const row of rows) {
    const values = modeResult(row).findings ?? [];
    if (!Array.isArray(values)) throw new ValueError("mode_result.findings must be an array");
    for (const value of values) fingerprints.add(String(modeModels.validateFinding(value).fingerprint));
  }
  return [...fingerprints].sort();
}

function advanceVerificationFix(
  connection: stateStore.Connection,
  context: RuntimeRecord,
  mode: RuntimeRecord,
  compileTasks: CompileTasks,
): RuntimeRecord {
  const round = currentRound(connection, mode);
  const rows = modeRows(connection, Number(mode.mode_id), undefined, Number(round.round_id));
  const roles: Record<string, Set<string>> = {
    validate: new Set(["validator"]),
    diagnose: new Set(["reviewer"]),
    fix: new Set(["improver"]),
  };
  const expected = roles[mode.phase];
  if (!expected) return closeMode(connection, mode, "blocked", "verification_fix phase is invalid");
  const phaseRows = rows.filter((row) => expected.has(String(row.role)));
  if (phaseRows.length === 0) return closeMode(connection, mode, "blocked", "verification_fix phase has no compiled task");
  if (phaseRows.some((row) => new Set(["failed", "blocked", "cancelled"]).has(String(row.status)))) {
    return closeMode(connection, mode, "blocked", "verification_fix phase task did not complete");
  }
  if (!phaseRows.every((row) => row.status === "done")) {
    return response(mode, { reason: "verification_fix phase tasks are still running" });
  }
  const config = decoded(mode, "config_json");
  const exitConditions = config.exit_conditions as RuntimeRecord;
  if (mode.phase === "validate") {
    const result = modeResult(phaseRows[0]!);
    if (result.status === "passed") {
      return closeMode(
        connection,
        mode,
        "completed",
        `deterministic validation passed (exit condition: ${exitConditions.passed})`,
        "passed",
      );
    }
    if (result.status === "blocked") {
      return closeMode(connection, mode, "blocked", "deterministic validation was blocked", exitConditions.blocked);
    }
    const plan = diagnosisPlan(context, mode, Number(mode.current_round), Number(phaseRows[0]!.task_id));
    const taskIds = compile(connection, context, mode, Number(round.round_id), [plan], compileTasks);
    setPhase(connection, mode, "diagnose");
    return response(mode, { taskIds, schedule: true });
  }
  if (mode.phase === "diagnose") {
    const overflow = recordReviewFindings(connection, mode, phaseRows);
    if (overflow.length > 0) return closeMode(connection, mode, "blocked", "diagnosis candidate budget guard reached");
    const fingerprints = modeFindingFingerprints(phaseRows);
    if (fingerprints.length === 0) return closeMode(connection, mode, "blocked", "failed validation produced no diagnosed finding");
    const state = decoded(mode, "state_json");
    state.current_fix_fingerprints = fingerprints;
    connection.execute("UPDATE modes SET state_json=? WHERE mode_id=?", [json(state), mode.mode_id]);
    mode.state_json = json(state);
    const plan = improverPlan(
      context,
      mode,
      Number(mode.current_round),
      phaseRows.map((row) => Number(row.task_id)),
      fingerprints,
    );
    const taskIds = compile(connection, context, mode, Number(round.round_id), [plan], compileTasks);
    setPhase(connection, mode, "fix");
    return response(mode, { taskIds, schedule: true });
  }
  const result = modeResult(phaseRows[0]!);
  const state = decoded(mode, "state_json");
  const required = Array.isArray(state.current_fix_fingerprints)
    ? state.current_fix_fingerprints.map((item) => String(item)) : [];
  const addressed = new Set(Array.isArray(result.addressed_fingerprints)
    ? result.addressed_fingerprints.map((item) => String(item)) : []);
  if (!result.changed || required.some((fingerprint) => !addressed.has(fingerprint))) {
    return closeMode(connection, mode, "blocked", "fix made no complete progress", exitConditions.no_progress);
  }
  state.fixed_fingerprints = [...new Set([
    ...(Array.isArray(state.fixed_fingerprints) ? state.fixed_fingerprints.map((item) => String(item)) : []),
    ...required,
  ])].sort();
  state.current_fix_fingerprints = [];
  connection.execute("UPDATE modes SET state_json=? WHERE mode_id=?", [json(state), mode.mode_id]);
  mode.state_json = json(state);
  for (const fingerprint of required) connection.execute(
    "UPDATE mode_findings SET status='confirmed', updated_at=? WHERE mode_id=? AND fingerprint=?",
    [stateStore.now(), mode.mode_id, fingerprint],
  );
  if (Number(mode.current_round) >= Number(config.max_rounds)) {
    return closeMode(
      connection,
      mode,
      "blocked",
      "max_rounds guard reached before a clean post-fix validation",
      exitConditions.max_rounds,
    );
  }
  connection.execute(
    "UPDATE mode_rounds SET status='completed', completed_at=? WHERE round_id=?",
    [stateStore.now(), round.round_id],
  );
  const nextRound = Number(mode.current_round) + 1;
  const nextRoundId = newRound(connection, Number(mode.mode_id), nextRound, "validate");
  const plan = validatorPlan(context, mode, nextRound, Number(phaseRows[0]!.task_id), "validation");
  const taskIds = compile(connection, context, mode, nextRoundId, [plan], compileTasks);
  setPhase(connection, mode, "validate", nextRound);
  return response(mode, { taskIds, schedule: true });
}

function ravfDecisionDossier(
  connection: stateStore.Connection,
  mode: RuntimeRecord,
  round: RuntimeRecord,
  config: RuntimeRecord,
): RuntimeRecord {
  const quorum = Number(config.vote_quorum);
  const arguerRows = modeRows(
    connection,
    Number(mode.mode_id),
    "verifier_falsify",
    Number(round.round_id),
  );
  const voterRows = modeRows(
    connection,
    Number(mode.mode_id),
    "verifier_reproduce",
    Number(round.round_id),
  );
  if (
    arguerRows.length !== (config.arguers as RuntimeRecord[]).length ||
    voterRows.length !== (config.voters as RuntimeRecord[]).length ||
    voterRows.length < quorum ||
    [...arguerRows, ...voterRows].some((row) => row.status !== "done")
  ) throw new ValueError("RAVF requires complete fixed-size arguer and voter pools before integration");

  const candidates: RuntimeRecord[] = [];
  for (const finding of currentCandidateRows(connection, mode, Number(round.round_id))) {
    const argumentsForFinding: RuntimeRecord[] = arguerRows.map((row) => {
      const values = modeResult(row).arguments;
      if (!Array.isArray(values)) throw new ValueError("RAVF arguer result is missing arguments");
      const argument = values.find((item) => isRecord(item) && item.candidate_fingerprint === finding.fingerprint);
      if (!isRecord(argument)) throw new ValueError(`RAVF candidate ${finding.fingerprint} lacks complete argument coverage`);
      return { task_id: row.task_id, ...argument } as RuntimeRecord;
    });
    const decisions: RuntimeRecord[] = voterRows.map((row) => {
      const values = modeResult(row).ballots;
      if (!Array.isArray(values)) throw new ValueError("RAVF voter result is missing ballots");
      const ballot = values.find((item) => isRecord(item) && item.candidate_fingerprint === finding.fingerprint);
      if (!isRecord(ballot)) throw new ValueError(`RAVF candidate ${finding.fingerprint} lacks complete vote coverage`);
      return { task_id: row.task_id, ...ballot };
    });
    const originalVotes = decisions.filter((vote) => vote.decision === "accept_original").length;
    const revisedVotes = decisions.filter((vote) => vote.decision === "accept_revised").length;
    const acceptVotes = originalVotes + revisedVotes;
    const rejectVotes = decisions.filter((vote) => vote.decision === "reject").length;
    const majority = Math.floor(voterRows.length / 2) + 1;
    const preliminary = acceptVotes >= majority ? "accepted" : rejectVotes >= majority ? "rejected" : "unresolved";
    const provenance = stateStore.fetchall(
      `SELECT p.task_id, p.source_kind, p.raw_finding_json, p.evidence_hash
         FROM mode_finding_provenance p
         JOIN mode_tasks mt ON mt.task_id=p.task_id
        WHERE p.finding_id=? AND p.source_kind='reviewer' AND mt.round_id=?
        ORDER BY p.provenance_id`,
      [finding.finding_id, round.round_id],
      connection,
    ).map((item) => ({
      task_id: item.task_id,
      source_kind: item.source_kind,
      finding: parseOptionalJson(item.raw_finding_json, "raw reviewer finding"),
      evidence_hash: item.evidence_hash,
    }));
    candidates.push({
      candidate_fingerprint: finding.fingerprint,
      original_review: decoded({ canonical_json: finding.canonical_json }, "canonical_json"),
      reviewer_provenance: provenance,
      arguments: argumentsForFinding.map((argument) => ({
          task_id: argument.task_id,
          challenge_outcome: argument.challenge_outcome,
          roi: argument.roi,
          bloat_risk: argument.bloat_risk,
          rationale: argument.rationale,
          proposed_revision: argument.proposed_revision,
          evidence_hash: modeModels.digest(argument.evidence),
      })),
      vote: {
        quorum,
        majority,
        accept_original_votes: originalVotes,
        accept_revised_votes: revisedVotes,
        accept_votes: acceptVotes,
        reject_votes: rejectVotes,
        abstentions: voterRows.length - acceptVotes - rejectVotes,
        preliminary,
        ballots: decisions.map((vote) => ({
          task_id: vote.task_id,
          decision: vote.decision,
          expected_value: vote.expected_value,
          rationale: vote.rationale,
          revision_basis_task_ids: vote.revision_basis_task_ids,
          evidence_hash: modeModels.digest(vote.evidence),
        })),
      },
    });
  }
  return {
    protocol: "ravf-v3-review-origin",
    arguer_task_ids: arguerRows.map((row) => Number(row.task_id)),
    voter_task_ids: voterRows.map((row) => Number(row.task_id)),
    candidates,
  };
}

function applyRavfIntegration(
  connection: stateStore.Connection,
  mode: RuntimeRecord,
  dossier: RuntimeRecord,
  integration: unknown,
): RuntimeRecord {
  if (!isRecord(integration) || !Array.isArray(integration.decisions)) {
    throw new ValueError("RAVF main-Agent integration requires a decisions array");
  }
  const candidates = dossier.candidates as RuntimeRecord[];
  const decisions = integration.decisions;
  const candidateMap = new Map(candidates.map((candidate) => [String(candidate.candidate_fingerprint), candidate]));
  exactFingerprintCoverage(
    decisions.map((decision) => isRecord(decision) ? String(decision.candidate_fingerprint ?? "") : ""),
    [...candidateMap.keys()],
    "RAVF main-Agent integration",
  );
  const integrated: RuntimeRecord = {
    approved_fingerprints: [],
    rejected_fingerprints: [],
    unresolved_fingerprints: [],
    approved_findings: [],
  };
  for (const rawDecision of decisions) {
    if (!isRecord(rawDecision)) throw new ValueError("RAVF integration decisions must be objects");
    const fingerprint = String(rawDecision.candidate_fingerprint);
    const candidate = candidateMap.get(fingerprint)!;
    const vote = candidate.vote as RuntimeRecord;
    const preliminary = String(vote.preliminary);
    const disposition = rawDecision.disposition;
    if (preliminary === "unresolved") throw new ValueError(`RAVF candidate ${fingerprint} has no voter majority`);
    if (preliminary === "rejected" && disposition !== "reject") {
      throw new ValueError(`RAVF candidate ${fingerprint} was rejected by voter majority`);
    }
    if (
      preliminary === "accepted" &&
      disposition !== "accept_original" && disposition !== "accept_revised"
    ) throw new ValueError(`RAVF candidate ${fingerprint} was accepted and requires an original or revised adoption`);
    if (typeof rawDecision.rationale !== "string" || !rawDecision.rationale.trim()) {
      throw new ValueError(`RAVF integration rationale is required for ${fingerprint}`);
    }

    const original = candidate.original_review as RuntimeRecord;
    let adoptedFinding: RuntimeRecord | null = null;
    let revisionBasis: number[] = [];
    if (disposition === "accept_original") {
      if (rawDecision.revised_finding !== null && rawDecision.revised_finding !== undefined) {
        throw new ValueError(`RAVF accept_original cannot include revised_finding for ${fingerprint}`);
      }
      adoptedFinding = { ...original };
    } else if (disposition === "accept_revised") {
      if (Number(vote.accept_revised_votes) === 0) {
        throw new ValueError(`RAVF accept_revised requires voter support for ${fingerprint}`);
      }
      const basis = rawDecision.revision_basis_task_ids;
      if (
        !Array.isArray(basis) || basis.length === 0 ||
        !basis.every((taskId) => Number.isSafeInteger(taskId) && typeof taskId !== "boolean") ||
        new Set(basis).size !== basis.length
      ) throw new ValueError(`RAVF accept_revised requires unique revision_basis_task_ids for ${fingerprint}`);
      const argumentsForFinding = candidate.arguments as RuntimeRecord[];
      const revisionArguments = new Map(argumentsForFinding
        .filter((argument) => argument.challenge_outcome === "review_needs_revision" && isRecord(argument.proposed_revision))
        .map((argument) => [Number(argument.task_id), argument]));
      const voterSupported = new Set((vote.ballots as RuntimeRecord[])
        .filter((ballot) => ballot.decision === "accept_revised")
        .flatMap((ballot) => ballot.revision_basis_task_ids as number[]));
      if (basis.some((taskId) => !revisionArguments.has(Number(taskId)) || !voterSupported.has(Number(taskId)))) {
        throw new ValueError(`RAVF revision basis for ${fingerprint} must be proposed by an arguer and cited by a voter`);
      }
      const revised = modeModels.validateFinding(rawDecision.revised_finding, "RAVF revised_finding", true);
      delete revised.fingerprint;
      adoptedFinding = revised;
      revisionBasis = basis.map((taskId) => Number(taskId));
    }

    const status = disposition === "reject" ? "rejected" : "confirmed";
    const adjudication = {
      protocol: dossier.protocol,
      source_fingerprint: fingerprint,
      original_review: original,
      reviewer_provenance: candidate.reviewer_provenance,
      arguments: candidate.arguments,
      vote,
      integration: {
        disposition,
        rationale: rawDecision.rationale.trim(),
        revision_basis_task_ids: revisionBasis,
      },
      adopted_finding: adoptedFinding,
    };
    connection.execute(
      "UPDATE mode_findings SET status=?, adjudication_json=?, updated_at=? WHERE mode_id=? AND fingerprint=?",
      [status, json(adjudication), stateStore.now(), mode.mode_id, fingerprint],
    );
    if (status === "confirmed") {
      (integrated.approved_fingerprints as unknown[]).push(fingerprint);
      (integrated.approved_findings as unknown[]).push({
        source_fingerprint: fingerprint,
        disposition,
        finding: adoptedFinding,
      });
    } else {
      (integrated.rejected_fingerprints as unknown[]).push(fingerprint);
    }
  }
  return integrated;
}

function advanceRavf(
  connection: stateStore.Connection,
  context: RuntimeRecord,
  mode: RuntimeRecord,
  compileTasks: CompileTasks,
  payload: RuntimeRecord,
): RuntimeRecord {
  const config = decoded(mode, "config_json");
  const exitConditions = config.exit_conditions as RuntimeRecord;
  const round = currentRound(connection, mode);
  if (payload.ravf_integration !== undefined && mode.phase !== "vote") {
    throw new ValueError("ravf_integration is valid only after the RAVF vote phase completes");
  }
  const phaseRoles: Record<string, string> = {
    review: "reviewer",
    argue: "verifier_falsify",
    vote: "verifier_reproduce",
    fix: "fixer",
  };
  const role = phaseRoles[String(mode.phase)];
  if (!role) return closeMode(connection, mode, "blocked", "RAVF phase is invalid");
  const rows = modeRows(connection, Number(mode.mode_id), role, Number(round.round_id));
  if (rows.length === 0) return closeMode(connection, mode, "blocked", "RAVF phase has no compiled task");
  if (rows.some((row) => new Set(["failed", "blocked", "cancelled"]).has(String(row.status)))) {
    return closeMode(connection, mode, "blocked", `RAVF ${mode.phase} task did not complete`);
  }
  if (!rows.every((row) => row.status === "done")) {
    return response(mode, { reason: `RAVF ${mode.phase} tasks are still running` });
  }
  if (mode.phase === "review") {
    const overflow = recordReviewFindings(connection, mode, rows);
    if (overflow.length > 0) return closeMode(connection, mode, "blocked", "RAVF candidate budget guard reached");
    if (currentCandidateRows(connection, mode, Number(round.round_id)).length === 0) {
      return closeMode(
        connection,
        mode,
        "completed",
        `RAVF clean review passed (exit condition: ${exitConditions.passed})`,
        "passed",
      );
    }
    const plans = ravfArguerPlans(connection, context, mode, round, config);
    const taskIds = compile(connection, context, mode, Number(round.round_id), plans, compileTasks);
    setPhase(connection, mode, "argue");
    return response(mode, { taskIds, schedule: true });
  }
  if (mode.phase === "argue") {
    const plans = ravfVoterPlans(connection, context, mode, round, config);
    const taskIds = compile(connection, context, mode, Number(round.round_id), plans, compileTasks);
    setPhase(connection, mode, "vote");
    return response(mode, { taskIds, schedule: true });
  }
  if (mode.phase === "vote") {
    const dossier = ravfDecisionDossier(connection, mode, round, config);
    const unresolved = (dossier.candidates as RuntimeRecord[])
      .filter((candidate) => (candidate.vote as RuntimeRecord).preliminary === "unresolved")
      .map((candidate) => candidate.candidate_fingerprint);
    if (unresolved.length > 0) {
      return closeMode(connection, mode, "blocked", "RAVF vote did not resolve every candidate", exitConditions.unresolved);
    }
    if (payload.ravf_integration === undefined) {
      const result = response(mode, {
        reason: "RAVF ballots are complete; main-Agent integration is required before fixing",
      });
      result.integration_required = true;
      result.decision_context = dossier;
      result.integration_contract = {
        decisions: "exactly one per original candidate",
        dispositions: ["accept_original", "accept_revised", "reject"],
        revised_rule: "accept_revised must cite voter-supported arguer revision task ids and include revised_finding",
        source_rule: "every adopted finding retains its original reviewer candidate_fingerprint",
      };
      return result;
    }
    const integrated = applyRavfIntegration(connection, mode, dossier, payload.ravf_integration);
    const fixer = ravfFixerPlan(connection, context, mode, round);
    if (fixer === null) {
      return closeMode(connection, mode, "completed", "RAVF vote rejected all proposed fixes", "passed");
    }
    const taskIds = compile(connection, context, mode, Number(round.round_id), [fixer], compileTasks);
    setPhase(connection, mode, "fix");
    const result = response(mode, { taskIds, schedule: true });
    result.integrated_decision = integrated;
    return result;
  }
  const remaining = ravfFixerPlan(connection, context, mode, round);
  if (remaining !== null) {
    const taskIds = compile(connection, context, mode, Number(round.round_id), [remaining], compileTasks);
    return response(mode, { taskIds, schedule: true });
  }
  const fixedResult = modeResult(rows[0]!);
  const fixed = Array.isArray(fixedResult.fixed_fingerprints)
    ? fixedResult.fixed_fingerprints.map((item) => String(item))
    : [];
  const state = decoded(mode, "state_json");
  state.fixed_fingerprints = [...new Set([
    ...(Array.isArray(state.fixed_fingerprints) ? state.fixed_fingerprints.map((item) => String(item)) : []),
    ...fixed,
  ])].sort();
  state.candidate_overflow = [];
  connection.execute("UPDATE modes SET state_json=? WHERE mode_id=?", [json(state), mode.mode_id]);
  mode.state_json = json(state);
  if (Number(mode.current_round) >= Number(config.max_rounds)) {
    return closeMode(
      connection,
      mode,
      "blocked",
      "max_rounds guard reached before a clean post-fix review",
      exitConditions.max_rounds,
    );
  }
  connection.execute(
    "UPDATE mode_rounds SET status='completed', completed_at=? WHERE round_id=?",
    [stateStore.now(), round.round_id],
  );
  const nextRound = Number(mode.current_round) + 1;
  const nextRoundId = newRound(connection, Number(mode.mode_id), nextRound, "review");
  mode.current_round = nextRound;
  const plans = ravfReviewerPlans(context, mode, config);
  const taskIds = compile(connection, context, mode, nextRoundId, plans, compileTasks);
  setPhase(connection, mode, "review", nextRound);
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
  if (payload.ravf_integration !== undefined && recipe(mode) !== "ravf") {
    throw new ValueError("ravf_integration is valid only for a RAVF mode");
  }
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
  } else if (recipe(mode) === "swarm") {
    result = advanceSwarm(connection, mode);
  } else if (recipe(mode) === "develop_review_improve") {
    result = advanceLoop(connection, context, mode, compileTasks);
  } else if (recipe(mode) === "verification_fix") {
    result = advanceVerificationFix(connection, context, mode, compileTasks);
  } else if (recipe(mode) === "ravf") {
    result = advanceRavf(connection, context, mode, compileTasks, payload);
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

function exactFingerprintCoverage(actual: string[], expected: string[], label: string): void {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  if (
    actualSet.size !== actual.length ||
    actualSet.size !== expectedSet.size ||
    [...expectedSet].some((fingerprint) => !actualSet.has(fingerprint))
  ) throw new ValueError(`${label} must cover every current RAVF candidate exactly once`);
}

function validateRavfPoolResult(
  connection: stateStore.Connection,
  mode: RuntimeRecord,
  link: RuntimeRecord,
  normalized: RuntimeRecord,
): void {
  const roundId = Number(link.round_id);
  if (!Number.isSafeInteger(roundId)) throw new ValueError("RAVF task is missing its round");
  if (link.role === "verifier_falsify" || link.role === "verifier_reproduce") {
    const expected = currentCandidateRows(connection, mode, roundId).map((row) => String(row.fingerprint));
    const field = link.role === "verifier_falsify" ? "arguments" : "ballots";
    const values = normalized[field];
    if (!Array.isArray(values)) throw new ValueError(`RAVF ${field} result is required`);
    exactFingerprintCoverage(
      values.map((item) => isRecord(item) ? String(item.candidate_fingerprint) : ""),
      expected,
      `RAVF ${field}`,
    );
    if (link.role === "verifier_reproduce") {
      const arguerRows = new Map(modeRows(connection, Number(mode.mode_id), "verifier_falsify", roundId)
        .map((row) => [Number(row.task_id), row]));
      for (const ballot of values as RuntimeRecord[]) {
        if (ballot.decision !== "accept_revised") continue;
        for (const taskId of ballot.revision_basis_task_ids as number[]) {
          const arguer = arguerRows.get(Number(taskId));
          const argument = arguer && Array.isArray(modeResult(arguer).arguments)
            ? (modeResult(arguer).arguments as RuntimeRecord[]).find(
              (item) => item.candidate_fingerprint === ballot.candidate_fingerprint,
            )
            : null;
          if (
            !argument || argument.challenge_outcome !== "review_needs_revision" ||
            !isRecord(argument.proposed_revision)
          ) throw new ValueError("RAVF voter revision basis must cite a current arguer correction for that candidate");
        }
      }
    }
    return;
  }
  if (link.role === "fixer") {
    const expected = stateStore.fetchall(
      `SELECT DISTINCT f.fingerprint FROM mode_findings f
        JOIN mode_finding_provenance p ON p.finding_id=f.finding_id
        JOIN mode_tasks proposed ON proposed.task_id=p.task_id AND proposed.round_id=?
       WHERE f.mode_id=? AND f.status='confirmed' ORDER BY f.fingerprint`,
      [roundId, mode.mode_id],
      connection,
    ).map((row) => String(row.fingerprint));
    const values = normalized.fixed_fingerprints;
    if (!Array.isArray(values)) throw new ValueError("RAVF fixed_fingerprints result is required");
    exactFingerprintCoverage(values.map((item) => String(item)), expected, "RAVF fixed_fingerprints");
  }
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
  if (recipe(mode) === "ravf") validateRavfPoolResult(connection, mode, link, normalized);
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
    let candidates: RuntimeRecord[] = [];
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
    if (
      recipe(mode) === "ravf" &&
      new Set(["verifier_falsify", "verifier_reproduce", "fixer"]).has(String(link.role))
    ) {
      candidates = stateStore.fetchall(
        `SELECT DISTINCT f.* FROM mode_findings f
          JOIN mode_finding_provenance p ON p.finding_id=f.finding_id
          JOIN mode_tasks proposed ON proposed.task_id=p.task_id AND proposed.round_id=?
         WHERE f.mode_id=? ORDER BY f.fingerprint`,
        [link.round_id, mode.mode_id],
        connection,
      ).flatMap<RuntimeRecord>((finding): RuntimeRecord[] => {
        const canonical = decoded({ canonical_json: finding.canonical_json }, "canonical_json");
        const adjudication = finding.adjudication_json
          ? parseOptionalJson(finding.adjudication_json, "RAVF adjudication")
          : null;
        if (link.role === "fixer") {
          if (finding.status !== "confirmed" || !isRecord(adjudication)) return [];
          return [{
            fingerprint: finding.fingerprint,
            status: finding.status,
            source_fingerprint: adjudication.source_fingerprint,
            original_review: adjudication.original_review,
            adopted_finding: adjudication.adopted_finding,
            integration: adjudication.integration,
          } as RuntimeRecord];
        }
        const reviewerProvenance = stateStore.fetchall(
          `SELECT p.task_id, p.source_kind, p.raw_finding_json, p.evidence_hash
             FROM mode_finding_provenance p
             JOIN mode_tasks mt ON mt.task_id=p.task_id
            WHERE p.finding_id=? AND p.source_kind='reviewer' AND mt.round_id=?
            ORDER BY p.provenance_id`,
          [finding.finding_id, link.round_id],
          connection,
        ).map((item) => ({
          task_id: item.task_id,
          source_kind: item.source_kind,
          finding: parseOptionalJson(item.raw_finding_json, "raw finding"),
          evidence_hash: item.evidence_hash,
        }));
        return [{
          ...canonical,
          fingerprint: finding.fingerprint,
          status: finding.status,
          adjudication,
          reviewer_provenance: reviewerProvenance,
        } as RuntimeRecord];
      });
    }
    const evidence = {
      base: state.evidence_bundle,
      dependencies: dependencies.map((row) => ({
        task_id: row.task_id,
        status: row.status,
        result: (() => {
          const parsed = parseOptionalJson(row.result_json, "attempt result_json");
          return isRecord(parsed) && isRecord(parsed.mode_result) ? parsed.mode_result : parsed;
        })(),
      })),
      candidate,
      candidates,
      provenance,
    };
    const evidenceLimit = recipe(mode) === "ravf" ? RAVF_CONTEXT_BYTES : modeModels.MAX_EVIDENCE_BYTES;
    payload.assignment = {
      mode_id: mode.mode_id,
      kind: recipe(mode),
      engine_kind: mode.kind,
      phase: mode.phase,
      round: mode.current_round,
      role: semanticRole(mode, link.role),
      runtime_role: link.role,
      candidate_fingerprint: link.candidate_fingerprint ?? null,
      proposer_task_id: link.proposer_task_id ?? null,
      profile_hint: parseOptionalJson(link.profile_hint_json, "mode profile_hint_json"),
      dependency_evidence_bundle: modeModels.boundedBundle(
        evidence,
        evidenceLimit,
        ["candidate", "candidates", "dependencies", "provenance"],
      ),
    };
  }
  return `\n[MODE CONTEXT]\n${json(payload)}\n`;
}
