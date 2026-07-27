import * as hookManager from "./hook_manager.ts";
import * as modelPolicy from "./model_policy.ts";
import * as modeRuntime from "./mode_runtime.ts";
import * as notes from "./notes.ts";
import * as outbox from "./outbox.ts";
import * as recovery from "./recovery.ts";
import * as scheduler from "./scheduler.ts";
import * as stateStore from "./state_store.ts";
import { canonicalJson, isRecord, RuntimeError, type RuntimeRecord, ValueError } from "./runtime_types.ts";

export const ACTION_TYPES = new Set([
  "submit_estimate",
  "create_tasks",
  "start_mode",
  "advance_mode",
  "write_note",
  "wait",
  "finish",
]);
export const OWNER_LEASE_SECONDS = 15 * 60;
export const INTENTS = new Set(["implement", "review", "fix", "research", "design", "integrate"]);
export const COMPLEXITIES = new Set(["low", "medium", "high"]);
export const MODEL_TIERS = new Set(["strong", "balanced", "fast"]);
export const TASK_TERMINAL = new Set(["done", "failed", "blocked", "cancelled"]);
export const WATCHDOG_INTERVAL_SECONDS = 30;

export class ActionError extends RuntimeError {
  override name = "ActionError";
}

function error(message: string): never {
  throw new ActionError(message);
}

function json(value: unknown): string {
  return canonicalJson(value);
}

function requireFields(payload: RuntimeRecord, fields: readonly string[], label: string): void {
  const missing = fields.filter((field) => !(field in payload));
  if (missing.length > 0) error(`${label} requires fields: ${missing.join(", ")}`);
}

function parseObject(raw: unknown, label: string): RuntimeRecord {
  if (typeof raw !== "string") error(`${label} is invalid`);
  try {
    const value: unknown = JSON.parse(raw || "{}");
    if (!isRecord(value)) throw new Error();
    return value;
  } catch {
    error(`${label} is invalid`);
  }
}

export function capabilities(context: RuntimeRecord): string[] {
  const state = context.attempt.state;
  if (state === "evaluating") return ["submit_estimate", "write_note"];
  if (state === "waiting") return ["write_note", "wait"];
  if (state !== "active") return [];
  const result = ["submit_estimate", "write_note", "start_mode", "advance_mode", "finish"];
  const estimate = parseObject(context.task.estimate_json || "{}", "task estimate_json");
  if (estimate.effective_strategy === "split") result.splice(4, 0, "create_tasks", "wait");
  return result;
}

function loadContext(
  connection: stateStore.Connection,
  envelope: RuntimeRecord,
  allowCached = true,
): [RuntimeRecord | null, RuntimeRecord | null] {
  const required = ["root_id", "task_id", "attempt_id", "actor_token", "action_id", "type"];
  const missing = required.filter((name) => !envelope[name]);
  if (missing.length > 0) error(`missing envelope fields: ${missing.join(", ")}`);
  if (envelope.schema_version !== 1) error("unsupported action schema_version");
  if (typeof envelope.type !== "string" || !ACTION_TYPES.has(envelope.type)) error("unsupported action type");
  if (!Number.isSafeInteger(envelope.task_id) || !Number.isSafeInteger(envelope.attempt_id)) {
    error("task_id and attempt_id must be integers");
  }
  const run = stateStore.getRun(envelope.root_id, connection);
  const task = stateStore.getTask(envelope.task_id, connection);
  const attempt = stateStore.getAttempt(envelope.attempt_id, connection);
  if (run === null || task === null || attempt === null) error("invalid run/task/attempt binding");
  if (
    task.root_id !== run.root_id ||
    attempt.root_id !== run.root_id ||
    attempt.task_id !== task.task_id
  ) error("invalid run/task/attempt binding");
  if (!stateStore.tokenMatches(envelope.actor_token, attempt.actor_token_hash)) error("invalid actor token");

  const cached = connection.execute(
    "SELECT attempt_id, response_json FROM processed_actions WHERE root_id=? AND action_id=?",
    [run.root_id, envelope.action_id],
  ).fetchone();
  if (cached !== null && allowCached) {
    if (cached.attempt_id !== attempt.attempt_id) error("action_id was already used by a different attempt");
    return [null, parseObject(cached.response_json, "processed action response_json")];
  }
  if (run.status !== "running") error("run is not running");
  const currentAttempt = stateStore.getCurrentAttempt(Number(task.task_id), connection);
  if (currentAttempt === null || currentAttempt.attempt_id !== attempt.attempt_id) {
    error("attempt is not the task current attempt");
  }
  if (new Set(["done", "failed", "cancelled"]).has(attempt.state)) error("attempt is terminal");
  if (task.task_id === run.root_task_id) {
    if (!stateStore.tokenMatches(envelope.actor_token, run.owner_token_hash)) error("root owner lease token is invalid");
    if (run.lease_expires_at && Number(run.lease_expires_at) < stateStore.now()) {
      error("root owner lease expired; recover the run");
    }
    const timestamp = stateStore.now();
    connection.execute(
      "UPDATE runs SET lease_expires_at=?, updated_at=? WHERE root_id=?",
      [timestamp + OWNER_LEASE_SECONDS, timestamp, run.root_id],
    );
  }
  if (!capabilities({ run, task, attempt }).includes(envelope.type)) {
    error(`action ${envelope.type} is not an available capability in state ${attempt.state}`);
  }
  const timestamp = stateStore.now();
  connection.execute("UPDATE attempts SET heartbeat_at=? WHERE attempt_id=?", [timestamp, attempt.attempt_id]);
  attempt.heartbeat_at = timestamp;
  return [{ run, task, attempt }, null];
}

function recordResponse(
  connection: stateStore.Connection,
  context: RuntimeRecord,
  envelope: RuntimeRecord,
  response: RuntimeRecord,
): void {
  const launch = stateStore.getCurrentLaunch(Number(context.attempt.attempt_id), connection);
  const session = launch === null ? null : stateStore.getSessionForLaunch(Number(launch.launch_id), connection);
  connection.execute(
    `INSERT INTO processed_actions(
       root_id, action_id, attempt_id, source_session_pk, response_json, processed_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
    [
      context.run.root_id,
      envelope.action_id,
      context.attempt.attempt_id,
      session?.session_pk ?? null,
      json(response),
      stateStore.now(),
    ],
  );
}

function estimate(
  connection: stateStore.Connection,
  context: RuntimeRecord,
  payload: RuntimeRecord,
  actionId: string,
): RuntimeRecord {
  const { task, attempt, run } = context;
  requireFields(
    payload,
    ["revision", "strategy", "resolved_intent", "complexity", "concerns", "unknowns", "estimated_files", "reason"],
    "submit_estimate",
  );
  if (typeof payload.revision !== "boolean") error("estimate revision must be boolean");
  if (payload.strategy !== "direct" && payload.strategy !== "split") error("estimate strategy must be direct or split");
  if (typeof payload.complexity !== "string" || !COMPLEXITIES.has(payload.complexity)) {
    error("estimate complexity must be low, medium, or high");
  }
  if (!Array.isArray(payload.concerns) || !Array.isArray(payload.unknowns)) {
    error("estimate concerns and unknowns must be arrays");
  }
  if (!Array.isArray(payload.estimated_files) || !payload.estimated_files.every((path) => typeof path === "string")) {
    error("estimate estimated_files must be an array of paths");
  }
  if (typeof payload.reason !== "string" || !payload.reason.trim()) error("estimate reason is required");

  let resolvedIntent: string;
  if (attempt.state === "evaluating") {
    if (payload.revision) error("first estimate cannot be a revision");
    if (typeof payload.resolved_intent !== "string" || !INTENTS.has(payload.resolved_intent)) {
      error("resolved_intent is required and must be supported");
    }
    if (task.resolved_intent && payload.resolved_intent !== task.resolved_intent) {
      error("resolved_intent cannot change across attempts for the same task");
    }
    resolvedIntent = task.resolved_intent || payload.resolved_intent;
  } else {
    if (!payload.revision) error("active agent must mark estimate revision=true");
    resolvedIntent = task.resolved_intent;
    if (payload.resolved_intent !== resolvedIntent) error("resolved_intent cannot change after the first estimate");
    if (Number(task.replan_count) >= Number(run.max_replans_per_task)) error("max_replans_per_task exhausted");
    connection.execute("UPDATE tasks SET replan_count=replan_count+1 WHERE task_id=?", [task.task_id]);
    task.replan_count = Number(task.replan_count) + 1;
  }

  let effective = payload.strategy as string;
  let forcedReason: string | null = null;
  const taskCount = Number(connection.execute(
    "SELECT COUNT(*) AS n FROM tasks WHERE root_id=?",
    [run.root_id],
  ).fetchone()?.n ?? 0);
  if (effective === "split" && Number(task.delegation_depth) >= Number(run.max_delegation_depth)) {
    effective = "forced_direct";
    forcedReason = "delegation_depth_limit";
  } else if (effective === "split" && taskCount >= Number(run.max_total_tasks)) {
    effective = "forced_direct";
    forcedReason = "task_budget_exhausted";
  } else if (effective === "split" && Number(run.max_concurrent_agents) <= 1) {
    effective = "forced_direct";
    forcedReason = "concurrency_limit";
  }
  const stored: RuntimeRecord = {
    ...payload,
    resolved_intent: resolvedIntent,
    effective_strategy: effective === "forced_direct" ? "direct" : effective,
  };
  connection.execute(
    "UPDATE tasks SET resolved_intent=?, estimate_json=? WHERE task_id=?",
    [resolvedIntent, json(stored), task.task_id],
  );
  connection.execute(
    "UPDATE attempts SET state='active', started_at=COALESCE(started_at, ?) WHERE attempt_id=?",
    [stateStore.now(), attempt.attempt_id],
  );
  connection.execute("UPDATE tasks SET status='active' WHERE task_id=?", [task.task_id]);
  task.resolved_intent = resolvedIntent;
  task.estimate_json = json(stored);
  attempt.state = "active";
  stateStore.appendEvent(
    connection,
    run.root_id,
    "EstimateSubmitted",
    { strategy: effective, revision: payload.revision, complexity: payload.complexity },
    task.task_id,
    attempt.attempt_id,
    null,
    actionId,
  );
  const response: RuntimeRecord = {
    accepted: true,
    state: "active",
    strategy: effective,
    capabilities: capabilities(context),
    budget: {
      remaining_tasks: Math.max(0, Number(run.max_total_tasks) - taskCount),
      max_attempts_for_current_task: run.max_attempts_per_task,
      remaining_delegation_depth: Math.max(0, Number(run.max_delegation_depth) - Number(task.delegation_depth)),
    },
    next_action: effective === "forced_direct"
      ? "implement_critical_scope_and_report_caveats"
      : effective === "split"
        ? "create_tasks_or_execute"
        : "execute_task",
  };
  if (forcedReason !== null) response.reason = forcedReason;
  return response;
}

function staticPrefix(pattern: string): [string, boolean] {
  const value = pattern.replaceAll("\\", "/").trim();
  if (!value || value.startsWith("/") || value === ".." || value.startsWith("../") || value.includes("/../")) {
    error("write_scope paths must be relative and cannot traverse parents");
  }
  let wildcard = value.length;
  for (const marker of ["*", "?", "["]) {
    const position = value.indexOf(marker);
    if (position >= 0) wildcard = Math.min(wildcard, position);
  }
  return [value.slice(0, wildcard).replace(/\/+$/u, ""), wildcard < value.length];
}

function globRegex(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "*" && pattern[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (character === "*") source += "[^/]*";
    else if (character === "?") source += "[^/]";
    else if (character === "[") {
      const end = pattern.indexOf("]", index + 1);
      if (end === -1) source += "\\[";
      else {
        const content = pattern.slice(index + 1, end).replace(/^!/u, "^");
        source += `[${content}]`;
        index = end;
      }
    } else source += character.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
  }
  return new RegExp(`^${source}$`, "u");
}

function scopeContains(parentPattern: string, childPattern: string): boolean {
  const parent = parentPattern.replaceAll("\\", "/").trim();
  const child = childPattern.replaceAll("\\", "/").trim();
  staticPrefix(parent);
  staticPrefix(child);
  const markers = ["*", "?", "["];
  const parentHasGlob = markers.some((marker) => parent.includes(marker));
  const childHasGlob = markers.some((marker) => child.includes(marker));
  if (!parentHasGlob) return child === parent;
  if (parent === "**" || parent === "**/*") return true;
  if (parent.endsWith("/**") && !markers.some((marker) => parent.slice(0, -3).includes(marker))) {
    const prefix = parent.slice(0, -3).replace(/\/+$/u, "");
    const childPrefix = staticPrefix(child)[0];
    return childPrefix === prefix || childPrefix.startsWith(`${prefix}/`);
  }
  if (childHasGlob) return child === parent;
  return globRegex(parent).test(child);
}

function validateConstraints(parent: RuntimeRecord, child: unknown): asserts child is RuntimeRecord {
  if (!isRecord(child)) error("task constraints must be an object");
  const writeScope = child.write_scope ?? [];
  if (!Array.isArray(writeScope) || !writeScope.every((path) => typeof path === "string")) {
    error("constraints.write_scope must be an array of paths");
  }
  if (typeof (child.read_only ?? false) !== "boolean") error("constraints.read_only must be boolean");
  if (!Array.isArray(child.notes ?? [])) error("constraints.notes must be an array");
  if ("profile_hint" in child && (typeof child.profile_hint !== "string" || !child.profile_hint.trim())) {
    error("constraints.profile_hint must be a non-empty profile name");
  }
  for (const pattern of writeScope) staticPrefix(pattern);
  const parentScope = parent.write_scope ?? [];
  if (Array.isArray(parentScope) && parentScope.length > 0 && writeScope.length > 0) {
    for (const childPattern of writeScope) {
      if (!parentScope.some((parentPattern) => typeof parentPattern === "string" && scopeContains(parentPattern, childPattern))) {
        error("child write_scope exceeds parent write_scope");
      }
    }
  }
}

function detectCycle(keys: Set<string>, dependencyKeys: Map<string, string[]>): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string): void => {
    if (visiting.has(key)) error("task dependency graph contains a cycle");
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dependency of dependencyKeys.get(key) ?? []) if (keys.has(dependency)) visit(dependency);
    visiting.delete(key);
    visited.add(key);
  };
  for (const key of keys) visit(key);
}

type DependencyReference = ["key" | "id", string | number];
interface NormalizedTask {
  specification: RuntimeRecord;
  constraints: RuntimeRecord;
  dependencies: Array<[DependencyReference, string]>;
}

function createTasks(
  connection: stateStore.Connection,
  context: RuntimeRecord,
  payload: RuntimeRecord,
  actionId: string,
  options: { schedule?: boolean; countReplan?: boolean } = {},
): RuntimeRecord {
  const specifications = payload.tasks;
  if (!Array.isArray(specifications) || specifications.length === 0) {
    error("create_tasks requires a non-empty tasks array");
  }
  const { run, task: parent } = context;
  if (specifications.length > Math.min(12, Number(run.max_children_per_action))) error("max_children_per_action exceeded");
  const existingCount = Number(connection.execute(
    "SELECT COUNT(*) AS n FROM tasks WHERE root_id=?",
    [run.root_id],
  ).fetchone()?.n ?? 0);
  if (existingCount + specifications.length > Number(run.max_total_tasks)) error("max_total_tasks exceeded");
  if (Number(parent.delegation_depth) >= Number(run.max_delegation_depth)) error("delegation_depth_limit");
  const priorChildren = Number(connection.execute(
    "SELECT COUNT(*) AS n FROM tasks WHERE parent_task_id=?",
    [parent.task_id],
  ).fetchone()?.n ?? 0);
  if (priorChildren > 0 && (options.countReplan ?? true)) {
    if (Number(parent.replan_count) >= Number(run.max_replans_per_task)) error("max_replans_per_task exhausted");
    connection.execute("UPDATE tasks SET replan_count=replan_count+1 WHERE task_id=?", [parent.task_id]);
  }

  const keys = specifications.map((specification) => isRecord(specification) ? specification.key : null);
  if (
    keys.some((key) => typeof key !== "string" || !key.trim()) ||
    new Set(keys).size !== keys.length
  ) error("task keys must be non-empty and unique within the action");
  const keySet = new Set(keys as string[]);
  const parentConstraints = parseObject(parent.constraints_json || "{}", "parent constraints_json");
  const dependencyKeys = new Map<string, string[]>();
  const normalized: NormalizedTask[] = [];
  for (const raw of specifications) {
    if (!isRecord(raw)) error("child task must be an object");
    const specification: RuntimeRecord = raw;
    if (typeof specification.goal !== "string" || !specification.goal.trim()) error("child task goal is required");
    if (typeof specification.output_contract !== "string" || !specification.output_contract.trim()) {
      error("child task output_contract is required");
    }
    if (typeof specification.intent_hint !== "string" || !INTENTS.has(specification.intent_hint)) {
      error("invalid child intent_hint");
    }
    const complexity = specification.complexity_hint ?? "medium";
    if (typeof complexity !== "string" || !COMPLEXITIES.has(complexity)) error("invalid child complexity_hint");
    const tier = specification.model_tier_hint;
    if (tier !== null && tier !== undefined && (typeof tier !== "string" || !MODEL_TIERS.has(tier))) {
      error("invalid child model_tier_hint");
    }
    const priority = specification.priority ?? 50;
    if (!Number.isSafeInteger(priority) || typeof priority === "boolean" || priority < 0 || priority > 100) {
      error("child priority must be an integer in 0..100");
    }
    const constraints = specification.constraints ?? { write_scope: [], read_only: false, notes: [] };
    validateConstraints(parentConstraints, constraints);
    try {
      modelPolicy.selectProfile(run, { constraints_json: json(constraints) });
    } catch (caught) {
      error(caught instanceof Error ? caught.message : "child profile is invalid");
    }
    const dependencies = specification.depends_on ?? [];
    if (!Array.isArray(dependencies)) error("depends_on must be an array");
    const resolvedDependencies: Array<[DependencyReference, string]> = [];
    const newReferences: string[] = [];
    const seen = new Set<string>();
    for (const dependency of dependencies) {
      if (!isRecord(dependency)) error("dependency must be an object");
      const taskKey = dependency.task_key;
      const taskId = dependency.task_id;
      const hasTaskKey = taskKey !== null && taskKey !== undefined;
      const hasTaskId = taskId !== null && taskId !== undefined;
      if (hasTaskKey === hasTaskId) error("dependency must provide exactly one of task_key or task_id");
      const condition = dependency.condition ?? "success";
      if (condition !== "success" && condition !== "terminal") error("dependency condition must be success or terminal");
      let reference: DependencyReference;
      if (hasTaskKey) {
        if (typeof taskKey !== "string" || !keySet.has(taskKey)) error("dependency task_key must reference this action");
        newReferences.push(taskKey);
        reference = ["key", taskKey];
      } else {
        if (!Number.isSafeInteger(taskId) || typeof taskId === "boolean") error("dependency task_id must be an integer");
        const numericTaskId = taskId as number;
        const existing = stateStore.getTask(numericTaskId, connection);
        if (existing === null || existing.root_id !== run.root_id) {
          error("dependency must reference this action or an existing task in the run");
        }
        reference = ["id", numericTaskId];
      }
      if (hasTaskKey && taskKey === specification.key) error("task cannot depend on itself");
      const signature = `${reference[0]}:${reference[1]}`;
      if (seen.has(signature)) error("duplicate dependency for child task");
      seen.add(signature);
      resolvedDependencies.push([reference, condition]);
    }
    dependencyKeys.set(specification.key, newReferences);
    normalized.push({ specification, constraints, dependencies: resolvedDependencies });
  }
  detectCycle(keySet, dependencyKeys);

  const createdAt = stateStore.now();
  const launch = stateStore.getCurrentLaunch(Number(context.attempt.attempt_id), connection);
  const session = launch === null ? null : stateStore.getSessionForLaunch(Number(launch.launch_id), connection);
  const ids = new Map<string, number>();
  const responseTasks: RuntimeRecord[] = [];
  normalized.forEach((item, index) => {
    const { specification, constraints } = item;
    const taskId = connection.execute(
      `INSERT INTO tasks(
         root_id, parent_task_id, created_by_session_pk, goal, intent_hint,
         status, priority, complexity_hint, model_tier_hint, output_contract,
         constraints_json, delegation_depth, replan_count, created_at
       ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, 0, ?)`,
      [
        run.root_id,
        parent.task_id,
        session?.session_pk ?? null,
        specification.goal.trim(),
        specification.intent_hint,
        specification.priority ?? 50,
        specification.complexity_hint ?? "medium",
        specification.model_tier_hint ?? null,
        specification.output_contract.trim(),
        json(constraints),
        Number(parent.delegation_depth) + 1,
        createdAt + index * 0.000001,
      ],
    ).lastrowid;
    ids.set(specification.key, taskId);
    stateStore.appendEvent(
      connection,
      run.root_id,
      "TaskCreated",
      { key: specification.key, intent_hint: specification.intent_hint },
      taskId,
      context.attempt.attempt_id,
      session?.session_pk ?? null,
      actionId,
    );
    responseTasks.push({ key: specification.key, task_id: taskId });
  });
  for (const { specification, dependencies } of normalized) {
    const taskId = ids.get(specification.key)!;
    for (const [[kind, value], condition] of dependencies) {
      const dependencyId = kind === "key" ? ids.get(value as string)! : value as number;
      connection.execute(
        "INSERT INTO task_dependencies(task_id, depends_on_task_id, condition) VALUES (?, ?, ?)",
        [taskId, dependencyId, condition],
      );
    }
  }
  if (options.schedule ?? true) scheduler.scheduleWithConnection(connection, run.root_id);
  stateStore.appendEvent(
    connection,
    run.root_id,
    "ChildTasksCreated",
    { task_ids: responseTasks.map((item) => item.task_id) },
    parent.task_id,
    context.attempt.attempt_id,
    session?.session_pk ?? null,
    actionId,
  );
  return { accepted: true, tasks: responseTasks };
}

function modeTaskCompiler(
  connection: stateStore.Connection,
  context: RuntimeRecord,
  actionId: string,
): modeRuntime.CompileTasks {
  return (specifications) => {
    try {
      return createTasks(
        connection,
        context,
        { tasks: specifications },
        actionId,
        { schedule: false, countReplan: false },
      ).tasks;
    } catch (caught) {
      if (caught instanceof ActionError) throw new ValueError(caught.message);
      throw caught;
    }
  };
}

function startMode(
  connection: stateStore.Connection,
  context: RuntimeRecord,
  payload: RuntimeRecord,
  actionId: string,
): RuntimeRecord {
  let response: RuntimeRecord;
  try {
    response = modeRuntime.startMode(connection, context, payload, actionId, modeTaskCompiler(connection, context, actionId));
  } catch (caught) {
    error(caught instanceof Error ? caught.message : "start_mode failed validation");
  }
  const scheduleRequired = Boolean(response.schedule_required);
  delete response.schedule_required;
  if (scheduleRequired) scheduler.scheduleWithConnection(connection, context.run.root_id);
  return response;
}

function advanceMode(
  connection: stateStore.Connection,
  context: RuntimeRecord,
  payload: RuntimeRecord,
  actionId: string,
): RuntimeRecord {
  let response: RuntimeRecord;
  try {
    response = modeRuntime.advanceMode(
      connection,
      context,
      payload,
      actionId,
      modeTaskCompiler(connection, context, actionId),
      recovery.cancelModeWithConnection,
    );
  } catch (caught) {
    error(caught instanceof Error ? caught.message : "advance_mode failed validation");
  }
  const scheduleRequired = Boolean(response.schedule_required);
  delete response.schedule_required;
  if (scheduleRequired) scheduler.scheduleWithConnection(connection, context.run.root_id);
  return response;
}

function writeNote(
  connection: stateStore.Connection,
  context: RuntimeRecord,
  payload: RuntimeRecord,
  actionId: string,
): RuntimeRecord {
  let noteId: number;
  try {
    noteId = notes.writeNote(connection, context, payload);
  } catch (caught) {
    error(caught instanceof Error ? caught.message : "note validation failed");
  }
  stateStore.appendEvent(
    connection,
    context.run.root_id,
    "NoteWritten",
    { note_id: noteId, category: payload.category },
    context.task.task_id,
    context.attempt.attempt_id,
    null,
    actionId,
  );
  return { accepted: true, note_id: noteId };
}

function validateDonePayload(
  connection: stateStore.Connection,
  context: RuntimeRecord,
  payload: RuntimeRecord,
): RuntimeRecord[] {
  if (typeof payload.summary !== "string" || !payload.summary.trim()) error("finish summary is required");
  if (!Array.isArray(payload.changed_files) || !payload.changed_files.every((path) => typeof path === "string")) {
    error("finish changed_files must be an array");
  }
  for (const path of payload.changed_files) staticPrefix(path);
  if (!Array.isArray(payload.caveats)) error("finish caveats must be an array");
  const validation = payload.validation;
  if (payload.changed_files.length > 0) {
    if (!isRecord(validation) || (validation.status !== "passed" && validation.status !== "skipped")) {
      error("changed files require validation with passed or skipped status");
    }
    if (validation.status === "skipped" && !String(validation.reason ?? "").trim()) {
      error("skipped validation requires a reason");
    }
  }
  try {
    modeRuntime.validateTaskModeResult(connection, context, payload);
    modeRuntime.validateOwnerModesFinished(connection, Number(context.task.task_id));
  } catch (caught) {
    error(caught instanceof Error ? caught.message : "mode result validation failed");
  }

  const children = stateStore.fetchall(
    "SELECT * FROM tasks WHERE parent_task_id=? ORDER BY created_at",
    [context.task.task_id],
    connection,
  );
  if (children.some((child) => child.status !== "cancelled" && child.status !== "done")) {
    error("all non-cancelled direct child tasks must be done before finish");
  }
  if (children.length > 0) {
    const integration = payload.integration_check;
    if (!isRecord(integration) || !integration.status || !String(integration.summary ?? "").trim()) {
      error("tasks with children require integration_check.status and integration_check.summary");
    }
  }
  const review = payload.review;
  if (context.task.resolved_intent === "review") {
    if (!isRecord(review) || !new Set(["pass", "changes_requested", "blocked"]).has(review.status as string)) {
      error("review task requires structured review.status");
    }
    if (!Array.isArray(review.findings)) error("review task requires review.findings array");
  }

  const rootTask = context.task.task_id === context.run.root_task_id;
  if (rootTask && context.run.require_final_review) {
    let changedAnywhere = payload.changed_files.length > 0;
    for (const row of stateStore.fetchall(
      `SELECT a.result_json FROM attempts a
        JOIN tasks t ON t.task_id=a.task_id
       WHERE t.root_id=? AND a.result_json IS NOT NULL`,
      [context.run.root_id],
      connection,
    )) {
      const prior = parseObject(row.result_json, "attempt result_json");
      if (Array.isArray(prior.changed_files) && prior.changed_files.length > 0) {
        changedAnywhere = true;
        break;
      }
    }
    if (changedAnywhere) {
      if (!isRecord(review) || !new Set(["pass", "changes_requested", "blocked"]).has(review.status as string)) {
        error("root final review is required because the run changed files");
      }
      if (!Array.isArray(review.findings)) error("root final review findings must be an array");
    }
  }
  if (isRecord(review)) {
    const source = review.source;
    if (source !== null && source !== undefined) {
      if (source === "self") {
        if (context.task.resolved_intent !== "review") {
          error("review source self is valid only for the current review task");
        }
      } else {
        if (!Number.isSafeInteger(source) || typeof source === "boolean") {
          error("review source must be self or an integer task_id");
        }
        const sourceTask = stateStore.getTask(source as number, connection);
        if (
          sourceTask === null ||
          sourceTask.root_id !== context.run.root_id ||
          sourceTask.status !== "done" ||
          sourceTask.resolved_intent !== "review"
        ) error("review source task must be a done review task in this run");
      }
    }
  }
  return children;
}

function pathInScope(path: string, patterns: string[]): boolean {
  if (patterns.length === 0) return true;
  const normalized = path.replaceAll("\\", "/");
  return patterns.some((pattern) => scopeContains(pattern, normalized));
}

function finish(
  connection: stateStore.Connection,
  context: RuntimeRecord,
  payload: RuntimeRecord,
  actionId: string,
): RuntimeRecord {
  const status = payload.status;
  if (status !== "done" && status !== "failed") error("finish status must be done or failed");
  if (typeof payload.summary !== "string" || !payload.summary.trim()) error("finish summary is required");
  if (!("caveats" in payload) || !Array.isArray(payload.caveats)) error("finish caveats must be an array");
  if ("retryable" in payload && typeof payload.retryable !== "boolean") error("finish retryable must be boolean");
  if (
    "changed_files" in payload &&
    (!Array.isArray(payload.changed_files) || !payload.changed_files.every((path) => typeof path === "string"))
  ) error("finish changed_files must be an array");
  if ("artifacts" in payload && !Array.isArray(payload.artifacts)) error("finish artifacts must be an array");
  for (const field of ["validation", "review", "integration_check", "mode_result"]) {
    if (field in payload && payload[field] !== null && !isRecord(payload[field])) {
      error(`finish ${field} must be an object or null`);
    }
  }
  if (status === "failed" && typeof payload.retryable !== "boolean") error("failed finish requires boolean retryable");
  const { run, task, attempt } = context;
  const finished = stateStore.now();
  const warnings: string[] = [];
  let retryScheduled: boolean;
  let runStatus: string;

  if (status === "done") {
    const changedFiles = (payload.changed_files ?? []) as string[];
    const constraints = parseObject(task.constraints_json || "{}", "task constraints_json");
    if (changedFiles.length > 0 && (constraints.read_only === true || task.resolved_intent === "review")) {
      error("read-only or review tasks cannot finish done with changed_files");
    }
    validateDonePayload(connection, context, payload);
    const scope = Array.isArray(constraints.write_scope) ? constraints.write_scope as string[] : [];
    const outside = changedFiles.filter((path) => !pathInScope(path, scope));
    if (outside.length > 0) warnings.push(`reported changed_files outside write_scope: ${outside.join(", ")}`);
    for (const warning of warnings) {
      stateStore.appendEvent(
        connection,
        run.root_id,
        "ScopeWarning",
        { warning },
        task.task_id,
        attempt.attempt_id,
        null,
        actionId,
      );
    }
    connection.execute(
      "UPDATE attempts SET state='done', retryable=0, result_json=?, finished_at=? WHERE attempt_id=?",
      [json(payload), finished, attempt.attempt_id],
    );
    connection.execute("UPDATE tasks SET status='done', finished_at=? WHERE task_id=?", [finished, task.task_id]);
    stateStore.appendEvent(connection, run.root_id, "AttemptFinished", { status: "done" }, task.task_id, attempt.attempt_id, null, actionId);
    stateStore.appendEvent(
      connection,
      run.root_id,
      "TaskFinished",
      { summary: payload.summary },
      task.task_id,
      attempt.attempt_id,
      null,
      actionId,
    );
    retryScheduled = false;
    if (task.task_id === run.root_task_id) {
      const remaining = Number(connection.execute(
        "SELECT COUNT(*) AS n FROM tasks WHERE root_id=? AND status NOT IN ('done', 'cancelled')",
        [run.root_id],
      ).fetchone()?.n ?? 0);
      const live = Number(connection.execute(
        `SELECT COUNT(*) AS n FROM attempts a
          JOIN tasks t ON t.task_id=a.task_id
         WHERE t.root_id=? AND a.state IN ('assigned','evaluating','active','waiting','stopping')`,
        [run.root_id],
      ).fetchone()?.n ?? 0);
      const effects = Number(connection.execute(
        `SELECT COUNT(*) AS n FROM effects
          WHERE root_id=? AND effect_type IN ('spawn_agent','stop_agent')
            AND status IN ('pending','running')`,
        [run.root_id],
      ).fetchone()?.n ?? 0);
      const launches = Number(connection.execute(
        `SELECT COUNT(*) AS n FROM launches l
          JOIN attempts a ON a.attempt_id=l.attempt_id
          JOIN tasks t ON t.task_id=a.task_id
         WHERE t.root_id=? AND l.status != 'closed'`,
        [run.root_id],
      ).fetchone()?.n ?? 0);
      if (launches > 0) error("root closeout requires no open launches");
      if (remaining > 0 || live > 0 || effects > 0) {
        error("root closeout requires all tasks done and no live attempts or pending effects");
      }
      connection.execute(
        "UPDATE runs SET status='done', finished_at=?, updated_at=? WHERE root_id=?",
        [finished, finished, run.root_id],
      );
      stateStore.appendEvent(connection, run.root_id, "RunFinished", {}, null, null, null, actionId);
      runStatus = "done";
    } else {
      scheduler.scheduleWithConnection(connection, run.root_id);
      runStatus = "running";
    }
  } else {
    const retryable = payload.retryable === true;
    connection.execute(
      "UPDATE attempts SET state='failed', retryable=?, result_json=?, finished_at=? WHERE attempt_id=?",
      [retryable ? 1 : 0, json(payload), finished, attempt.attempt_id],
    );
    if (task.task_id === run.root_task_id) {
      connection.execute("UPDATE tasks SET status='failed', finished_at=? WHERE task_id=?", [finished, task.task_id]);
      connection.execute(
        "UPDATE runs SET status='failed', finished_at=?, updated_at=? WHERE root_id=?",
        [finished, finished, run.root_id],
      );
      stateStore.appendEvent(connection, run.root_id, "RunFailed", { summary: payload.summary });
      retryScheduled = false;
      runStatus = "failed";
    } else if (retryable && Number(attempt.attempt_no) < Number(run.max_attempts_per_task)) {
      connection.execute("UPDATE tasks SET status='ready', finished_at=NULL WHERE task_id=?", [task.task_id]);
      stateStore.appendEvent(
        connection,
        run.root_id,
        "TaskRetryScheduled",
        { previous_attempt: attempt.attempt_id },
        task.task_id,
        attempt.attempt_id,
      );
      scheduler.scheduleWithConnection(connection, run.root_id);
      retryScheduled = true;
      runStatus = "running";
    } else {
      connection.execute("UPDATE tasks SET status='failed', finished_at=? WHERE task_id=?", [finished, task.task_id]);
      stateStore.appendEvent(connection, run.root_id, "TaskFailed", { summary: payload.summary }, task.task_id, attempt.attempt_id);
      scheduler.scheduleWithConnection(connection, run.root_id);
      retryScheduled = false;
      runStatus = "running";
    }
    stateStore.appendEvent(
      connection,
      run.root_id,
      "AttemptFinished",
      { status: "failed", retryable },
      task.task_id,
      attempt.attempt_id,
      null,
      actionId,
    );
  }
  return {
    accepted: true,
    status,
    task_id: task.task_id,
    attempt_id: attempt.attempt_id,
    retry_scheduled: retryScheduled,
    run_status: runStatus,
    warnings,
  };
}

function taskSummaries(
  connection: stateStore.Connection,
  rootId: string,
  taskIds: number[],
): RuntimeRecord[] {
  return taskIds.map((taskId) => {
    const task = stateStore.getTask(taskId, connection);
    if (task === null || task.root_id !== rootId) error("wait tasks must belong to the current run");
    const attempt = stateStore.getCurrentAttempt(Number(task.task_id), connection);
    const result = attempt?.result_json ? parseObject(attempt.result_json, "attempt result_json") : null;
    return {
      task_id: taskId,
      status: task.status,
      result,
      reason: task.status === "blocked"
        ? "required_dependency_failed"
        : isRecord(result) && task.status === "failed"
          ? result.summary
          : task.status === "cancelled"
            ? "run_cancelled"
            : null,
    };
  });
}

function conditionMet(condition: string, summaries: RuntimeRecord[]): boolean {
  const statuses = summaries.map((item) => item.status);
  if (condition === "all_done") return statuses.every((status) => status === "done");
  if (condition === "all_terminal") return statuses.every((status) => TASK_TERMINAL.has(status));
  if (condition === "any_failed") return statuses.some((status) => status === "failed" || status === "blocked");
  error("wait condition must be all_done, all_terminal, or any_failed");
}

function runRootWatchdog(context: RuntimeRecord, actorToken: string): RuntimeRecord | null {
  if (context.task.task_id !== context.run.root_task_id) return null;
  try {
    const report = { ...recovery.reapChildren(context.run.root_id, actorToken) };
    report.side_effects = outbox.drain(context.run.root_id);
    return report;
  } catch {
    return { ok: false, error: "watchdog_failed" };
  }
}

function wait(envelope: RuntimeRecord, pollInterval: number): RuntimeRecord {
  const payload = isRecord(envelope.payload) ? envelope.payload : {};
  requireFields(payload, ["task_ids", "condition", "listen_seconds"], "wait");
  const taskIds = payload.task_ids;
  const condition = payload.condition;
  const listenSeconds = payload.listen_seconds;
  if (!Array.isArray(taskIds) || taskIds.length === 0 || !taskIds.every((item) => Number.isSafeInteger(item))) {
    error("wait task_ids must be a non-empty array");
  }
  if (condition !== "all_done" && condition !== "all_terminal" && condition !== "any_failed") {
    error("wait condition must be all_done, all_terminal, or any_failed");
  }
  if (typeof listenSeconds !== "number" || !Number.isFinite(listenSeconds) || listenSeconds < 0 || listenSeconds > 300) {
    error("listen_seconds must be in 0..300");
  }

  const context = stateStore.transaction((connection) => {
    const [loaded, cached] = loadContext(connection, envelope);
    if (cached !== null) return { context: null, cached };
    const active = loaded!;
    for (const taskId of taskIds) {
      const task = stateStore.getTask(taskId, connection);
      if (task === null || task.root_id !== active.run.root_id) error("wait tasks must belong to the current run");
    }
    connection.execute("UPDATE attempts SET state='waiting' WHERE attempt_id=?", [active.attempt.attempt_id]);
    active.attempt.state = "waiting";
    stateStore.appendEvent(
      connection,
      active.run.root_id,
      "AgentWaiting",
      { task_ids: taskIds, condition },
      active.task.task_id,
      active.attempt.attempt_id,
      null,
      envelope.action_id,
    );
    return { context: active, cached: null };
  });
  if (context.cached !== null) return context.cached;
  const active = context.context!;
  let watchdog = runRootWatchdog(active, envelope.actor_token);
  let nextWatchdogAt = Bun.nanoseconds() / 1e9 + WATCHDOG_INTERVAL_SECONDS;
  const deadline = Bun.nanoseconds() / 1e9 + listenSeconds;
  let summaries: RuntimeRecord[] = [];
  let complete = false;
  while (true) {
    const monotonic = Bun.nanoseconds() / 1e9;
    if (watchdog !== null && monotonic >= nextWatchdogAt) {
      watchdog = runRootWatchdog(active, envelope.actor_token);
      nextWatchdogAt = monotonic + WATCHDOG_INTERVAL_SECONDS;
    }
    summaries = stateStore.transaction(
      (connection) => taskSummaries(connection, envelope.root_id, taskIds as number[]),
      false,
    );
    complete = conditionMet(condition, summaries);
    if (complete || monotonic >= deadline) break;
    Bun.sleepSync(Math.max(10, pollInterval * 1_000));
  }
  return stateStore.transaction((connection) => {
    const [loaded, cached] = loadContext(connection, envelope);
    if (cached !== null) return cached;
    const resumed = loaded!;
    if (resumed.attempt.state !== "waiting") error("waiting attempt state changed unexpectedly");
    connection.execute(
      "UPDATE attempts SET state='active', heartbeat_at=? WHERE attempt_id=?",
      [stateStore.now(), resumed.attempt.attempt_id],
    );
    const response: RuntimeRecord = { complete, still_waiting: !complete, tasks: summaries };
    if (watchdog !== null) response.watchdog = watchdog;
    stateStore.appendEvent(
      connection,
      resumed.run.root_id,
      "AgentResumed",
      { complete },
      resumed.task.task_id,
      resumed.attempt.attempt_id,
      null,
      envelope.action_id,
    );
    recordResponse(connection, resumed, envelope, response);
    return response;
  });
}

function processActionInternal(envelope: unknown, pollInterval = 0.1): RuntimeRecord {
  if (!isRecord(envelope)) error("action envelope must be an object");
  const action = envelope as RuntimeRecord;
  if (action.type === "wait") return wait(action, pollInterval);
  if (!isRecord(action.payload)) error("action payload must be an object");
  const payload = action.payload as RuntimeRecord;
  let cleanupCwd: string | null = null;
  const response = stateStore.transaction((connection) => {
    const [context, cached] = loadContext(connection, action);
    if (cached !== null) {
      if (cached.run_status === "done") cleanupCwd = stateStore.getRun(String(action.root_id), connection)?.cwd ?? null;
      return cached;
    }
    const active = context!;
    let result: RuntimeRecord;
    if (action.type === "submit_estimate") result = estimate(connection, active, payload, String(action.action_id));
    else if (action.type === "create_tasks") result = createTasks(connection, active, payload, String(action.action_id));
    else if (action.type === "start_mode") result = startMode(connection, active, payload, String(action.action_id));
    else if (action.type === "advance_mode") result = advanceMode(connection, active, payload, String(action.action_id));
    else if (action.type === "write_note") result = writeNote(connection, active, payload, String(action.action_id));
    else if (action.type === "finish") result = finish(connection, active, payload, String(action.action_id));
    else error("unsupported action type");
    recordResponse(connection, active, action, result);
    if (action.type === "finish" && result.run_status === "done") cleanupCwd = active.run.cwd;
    return result;
  });
  if (cleanupCwd !== null) {
    try {
      hookManager.cleanupProjectHooks(cleanupCwd, String(action.root_id));
    } catch (caught) {
      stateStore.transaction((connection) => {
        stateStore.appendEvent(
          connection,
          String(action.root_id),
          "HookCleanupFailed",
          { error_type: caught instanceof Error ? caught.name : "Error" },
          null,
          null,
          null,
          String(action.action_id),
        );
      });
    }
  }
  return response;
}

function auditRejection(envelope: RuntimeRecord, message: string): void {
  try {
    stateStore.transaction((connection) => {
      const run = typeof envelope.root_id === "string" ? stateStore.getRun(envelope.root_id, connection) : null;
      const attempt = Number.isSafeInteger(envelope.attempt_id)
        ? stateStore.getAttempt(envelope.attempt_id, connection)
        : null;
      if (
        run === null || attempt === null || attempt.root_id !== run.root_id ||
        !stateStore.tokenMatches(envelope.actor_token, attempt.actor_token_hash)
      ) return;
      stateStore.appendEvent(
        connection,
        run.root_id,
        "ActionRejected",
        { action_type: envelope.type, reason: message },
        Number.isSafeInteger(envelope.task_id) ? envelope.task_id : null,
        Number.isSafeInteger(envelope.attempt_id) ? envelope.attempt_id : null,
        null,
        typeof envelope.action_id === "string" ? envelope.action_id : null,
      );
    });
  } catch {
    // Rejection auditing cannot mask the original validation error.
  }
}

export function processAction(envelope: unknown, pollInterval = 0.1): RuntimeRecord {
  try {
    return processActionInternal(envelope, pollInterval);
  } catch (caught) {
    if (caught instanceof ActionError && isRecord(envelope)) auditRejection(envelope, caught.message);
    throw caught;
  }
}
