#!/usr/bin/env bun
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";

import * as actionProcessor from "./action_processor.ts";
import * as compatEnv from "./compat_env.ts";
import * as executionConfig from "./execution_config.ts";
import * as executionSecrets from "./execution_secrets.ts";
import * as hookManager from "./hook_manager.ts";
import * as modeModels from "./mode_models.ts";
import * as outbox from "./outbox.ts";
import * as recovery from "./recovery.ts";
import * as sessionHistory from "./session_history.ts";
import * as stateStore from "./state_store.ts";
import { canonicalJson, RuntimeError, ValueError, type RuntimeRecord } from "./runtime_types.ts";

export const DEFAULT_MODEL_TIERS = { strong: "opus", balanced: "sonnet", fast: "haiku" };
export const OWNER_LEASE_SECONDS = 15 * 60;
export const ENTRY_MODE_ALIASES: Readonly<Record<string, string>> = {
  swarm: "swarm", loop: "develop_review_improve",
  "develop-review-improve": "develop_review_improve", develop_review_improve: "develop_review_improve",
  review: "multi_session_review", "multi-session-review": "multi_session_review", multi_session_review: "multi_session_review",
};

export const ACTION_SCHEMAS: Readonly<Record<string, RuntimeRecord>> = {
  submit_estimate: {
    title: "submit_estimate", type: "object",
    required: ["revision", "strategy", "resolved_intent", "complexity", "concerns", "unknowns", "estimated_files", "reason"],
    properties: {
      revision: { type: "boolean" }, strategy: { enum: ["direct", "split"] },
      resolved_intent: { enum: ["implement", "review", "fix", "research", "design", "integrate"] },
      complexity: { enum: ["low", "medium", "high"] }, concerns: { type: "array" }, unknowns: { type: "array" },
      estimated_files: { type: "array", items: { type: "string" } }, reason: { type: "string" },
    },
  },
  create_tasks: {
    title: "create_tasks", type: "object", required: ["tasks"], properties: { tasks: {
      type: "array", minItems: 1, maxItems: 12, items: {
        type: "object", required: ["key", "goal", "intent_hint", "output_contract"], properties: {
          key: { type: "string" }, goal: { type: "string" },
          intent_hint: { enum: ["implement", "review", "fix", "research", "design", "integrate"] },
          complexity_hint: { enum: ["low", "medium", "high"] }, model_tier_hint: { enum: ["strong", "balanced", "fast", null] },
          priority: { type: "integer", minimum: 0, maximum: 100 }, output_contract: { type: "string" },
          constraints: { type: "object", properties: {
            write_scope: { type: "array", items: { type: "string" } }, read_only: { type: "boolean" },
            notes: { type: "array" }, profile_hint: { type: "string", minLength: 1 },
          } },
          depends_on: { type: "array", items: { type: "object", properties: {
            task_key: { type: "string" }, task_id: { type: "integer" }, condition: { enum: ["success", "terminal"] },
          } } },
        },
      },
    } },
  },
  write_note: {
    title: "write_note", type: "object", required: ["category", "content", "scope"], properties: {
      category: { enum: ["decision", "pitfall", "note"] }, content: { type: "string", maxLength: 500 },
      scope: { enum: ["global", "subtree", "task"] }, pinned: { type: "boolean" }, supersedes_id: { type: ["integer", "null"] },
    },
  },
  wait: {
    title: "wait", type: "object", required: ["task_ids", "condition", "listen_seconds"], properties: {
      task_ids: { type: "array", minItems: 1, items: { type: "integer" } },
      condition: { enum: ["all_done", "all_terminal", "any_failed"] },
      listen_seconds: { type: "number", minimum: 0, maximum: 300 },
    },
  },
  start_mode: modeModels.START_MODE_SCHEMA,
  advance_mode: modeModels.ADVANCE_MODE_SCHEMA,
  finish: {
    title: "finish", type: "object", required: ["status", "summary", "caveats"], properties: {
      status: { enum: ["done", "failed"] }, retryable: { type: "boolean" }, summary: { type: "string" },
      changed_files: { type: "array", items: { type: "string" } }, artifacts: { type: "array" },
      validation: { type: ["object", "null"] }, review: { type: ["object", "null"] },
      integration_check: { type: ["object", "null"] }, mode_result: { type: ["object", "null"] }, caveats: { type: "array" },
    },
  },
};

function id(prefix: string): string { return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 12)}`; }
function positive(name: string, value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new ValueError(`${name} must be in ${minimum}..${maximum}`);
  return value;
}

export function entryMode(explicit?: string | null, environment: compatEnv.Environment = process.env): string | null {
  const normalize = (raw?: string | null): string | null => {
    if (raw === undefined || raw === null || !raw.trim()) return null;
    const normalized = ENTRY_MODE_ALIASES[raw.trim()];
    if (!normalized) throw new ValueError("entry_mode must be swarm, loop, or review");
    return normalized;
  };
  const selected = normalize(explicit);
  const inherited = normalize(compatEnv.value("MODE", environment));
  if (selected && inherited && selected !== inherited) throw new ValueError("explicit entry_mode conflicts with orchestration MODE");
  return selected ?? inherited;
}

export interface InitializeRunOptions {
  maxConcurrentAgents?: number;
  maxTotalTasks?: number;
  maxAttemptsPerTask?: number;
  maxDelegationDepth?: number;
  maxReplansPerTask?: number;
  maxChildrenPerAction?: number;
  requireFinalReview?: boolean;
  modelTiers?: Record<string, string> | null;
  backend?: string;
  acpAgent?: string;
  acpCommand?: string;
  acpArgs?: unknown;
  acpPermissionPolicy?: string;
  profileAllowlist?: unknown;
  defaultProfile?: string;
  entryMode?: string | null;
}

export function initializeRun(task: string, cwdValue: string, options: InitializeRunOptions = {}): RuntimeRecord {
  if (typeof task !== "string" || !task.trim()) throw new ValueError("task is required");
  const cwd = realpathSync(cwdValue);
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new ValueError(`cwd does not exist: ${cwd}`);
  const maxConcurrentAgents = positive("max_concurrent_agents", options.maxConcurrentAgents ?? 8, 1, 256);
  const maxTotalTasks = positive("max_total_tasks", options.maxTotalTasks ?? 100, 1, 10_000);
  const maxAttemptsPerTask = positive("max_attempts_per_task", options.maxAttemptsPerTask ?? 2, 1, 20);
  const maxDelegationDepth = positive("max_delegation_depth", options.maxDelegationDepth ?? 5, 0, 20);
  const maxReplansPerTask = positive("max_replans_per_task", options.maxReplansPerTask ?? 2, 0, 20);
  const maxChildrenPerAction = positive("max_children_per_action", options.maxChildrenPerAction ?? 12, 1, 12);
  const selectedEntryMode = entryMode(options.entryMode);
  const execution = executionConfig.resolveRunExecution({
    backend: options.backend, acpAgent: options.acpAgent, acpCommand: options.acpCommand,
    acpArgs: options.acpArgs, acpPermissionPolicy: options.acpPermissionPolicy,
    profileAllowlist: options.profileAllowlist, defaultProfile: options.defaultProfile,
    installDependencies: true,
  });
  execution.entry_mode = selectedEntryMode;
  const tiers: Record<string, string> = execution.backend === "acp"
    ? { ...DEFAULT_MODEL_TIERS, ...(execution.acp?.model_tiers ?? {}) }
    : { ...DEFAULT_MODEL_TIERS };
  if (options.modelTiers) Object.assign(tiers, options.modelTiers);
  if (Object.keys(tiers).sort().join(",") !== "balanced,fast,strong" || !Object.values(tiers).every((value) => typeof value === "string" && value)) {
    throw new ValueError("model_tiers must map strong, balanced, and fast");
  }
  const rootId = id("root");
  const actorToken = `as_${randomBytes(32).toString("base64url")}`;
  const created = stateStore.now();
  let seedReference: string | null = null;
  let taskId = 0;
  let attemptId = 0;
  try {
    const seed = executionSecrets.createRunSeed(rootId);
    seedReference = seed[0];
    stateStore.transaction((connection) => {
      const conflict = connection.execute(
        `SELECT root_id, status FROM runs WHERE cwd=? AND status IN ('running','stopping','failed')
         ORDER BY created_at DESC LIMIT 1`, [cwd],
      ).fetchone();
      if (conflict) throw new ValueError(`cwd already has recoverable run ${conflict.root_id} (${conflict.status}); use recover instead of init`);
      connection.execute(
        `INSERT INTO runs(root_id, goal, cwd, status, root_task_id,
          max_concurrent_agents, max_total_tasks, max_attempts_per_task, max_delegation_depth,
          max_replans_per_task, max_children_per_action, require_final_review, model_tiers_json,
          execution_config_json, token_seed_ref, token_seed_hash, owner_token_hash,
          lease_epoch, lease_expires_at, created_at, updated_at)
         VALUES (?, ?, ?, 'running', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
        [rootId, task.trim(), cwd, maxConcurrentAgents, maxTotalTasks, maxAttemptsPerTask,
          maxDelegationDepth, maxReplansPerTask, maxChildrenPerAction, options.requireFinalReview === false ? 0 : 1,
          canonicalJson(tiers), canonicalJson(execution), seedReference, seed[1], stateStore.hashToken(actorToken),
          created + OWNER_LEASE_SECONDS, created, created],
      );
      let cursor = connection.execute(
        `INSERT INTO tasks(root_id, goal, intent_hint, status, priority, complexity_hint,
          output_contract, constraints_json, delegation_depth, replan_count, created_at)
         VALUES (?, ?, 'implement', 'active', 100, 'high', ?, ?, 0, 0, ?)`,
        [rootId, task.trim(), task.trim(), "{}", created],
      );
      taskId = Number(cursor.lastrowid);
      const rootRun = stateStore.getRun(rootId, connection)!;
      const rootConfig = executionConfig.snapshotAttempt(rootRun, { model: tiers.strong });
      cursor = connection.execute(
        `INSERT INTO attempts(task_id, attempt_no, state, actor_token_hash, backend_id, agent_type,
          model_tier, model_name, config_json, heartbeat_at, created_at, started_at)
         VALUES (?, 1, 'evaluating', ?, ?, ?, 'strong', ?, ?, ?, ?, ?)`,
        [taskId, stateStore.hashToken(actorToken), execution.backend,
          execution.backend === "acp" ? execution.acp?.agent : "claude", tiers.strong,
          canonicalJson(rootConfig), created, created, created],
      );
      attemptId = Number(cursor.lastrowid);
      connection.execute("UPDATE runs SET root_task_id=? WHERE root_id=?", [taskId, rootId]);
      stateStore.appendEvent(connection, rootId, "RunInitialized", { task: task.trim() }, taskId, attemptId);
    });
  } catch (error) {
    if (seedReference) executionSecrets.removeRunSeed({ token_seed_ref: seedReference });
    throw error;
  }
  if (executionConfig.supportsHooks(execution)) {
    try { hookManager.ensureProjectHooks(cwd, rootId); }
    catch (error) {
      stateStore.transaction((connection) => connection.execute("DELETE FROM runs WHERE root_id=?", [rootId]));
      executionSecrets.removeRunSeed({ token_seed_ref: seedReference });
      throw error;
    }
  }
  return {
    root_id: rootId, task_id: taskId, attempt_id: attemptId, actor_token: actorToken,
    lease_epoch: 0, lease_expires_at: created + OWNER_LEASE_SECONDS, entry_mode: selectedEntryMode,
  };
}

function resolveValue(explicit: unknown, suffix: string, label: string, required = true): string | null {
  const inherited = compatEnv.value(suffix);
  if (explicit && inherited && String(explicit) !== inherited) throw new ValueError(`explicit ${label} does not match orchestration ${suffix}`);
  const value = explicit ? String(explicit) : inherited ?? null;
  if (required && !value) throw new ValueError(`${label} is required (argument or ${compatEnv.canonicalName(suffix)}/${compatEnv.legacyName(suffix)})`);
  return value;
}

function resolveInteger(explicit: unknown, suffix: string, label: string): number {
  const value = Number(resolveValue(explicit, suffix, label));
  if (!Number.isSafeInteger(value) || value <= 0) throw new ValueError(`${label} must be a positive integer`);
  return value;
}

function refreshRunHooks(rootId: string, cwd?: string): void {
  const run = stateStore.getRun(rootId);
  if (run && executionConfig.supportsHooks(executionConfig.loadRunExecution(run))) {
    hookManager.ensureProjectHooks(cwd ?? String(run.cwd), rootId);
  }
}

function print(data: unknown): void { process.stdout.write(`${canonicalJson(data)}\n`); }

function authorizeRead(rootId: string, actorToken: string): RuntimeRecord {
  stateStore.initializeSchema();
  const run = stateStore.getRun(rootId);
  if (!run) throw new ValueError("run not found");
  if (!stateStore.listAttempts(rootId).some((attempt) => stateStore.tokenMatches(actorToken, attempt.actor_token_hash))) {
    throw new ValueError("invalid actor token");
  }
  return run;
}

type Args = RuntimeRecord & { _: string[] };
const BOOLEAN_OPTIONS = new Set(["no-final-review", "stdin", "current", "force-takeover"]);
const REPEAT_OPTIONS = new Set(["kill-attempt"]);
function parseArguments(argv: string[]): Args {
  const result: Args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) { result._.push(token); continue; }
    const raw = token.slice(2);
    const equal = raw.indexOf("=");
    const key = equal >= 0 ? raw.slice(0, equal) : raw;
    let value: unknown;
    if (BOOLEAN_OPTIONS.has(key)) value = true;
    else {
      value = equal >= 0 ? raw.slice(equal + 1) : argv[++index];
      if (value === undefined || String(value).startsWith("--")) throw new ValueError(`--${key} requires a value`);
    }
    const normalized = key.replaceAll(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase());
    if (REPEAT_OPTIONS.has(key)) (result[normalized] ??= []).push(value);
    else result[normalized] = value;
  }
  return result;
}

function numeric(args: Args, name: string, fallback: number): number {
  if (args[name] === undefined) return fallback;
  const value = Number(args[name]);
  if (!Number.isFinite(value)) throw new ValueError(`--${name} must be numeric`);
  return value;
}

function jsonOption(value: unknown, label: string): unknown {
  if (value === undefined) return undefined;
  try { return JSON.parse(String(value)); } catch { throw new ValueError(`${label} must be valid JSON`); }
}

function identity(args: Args): { rootId: string; taskId: number; attemptId: number; actorToken: string } {
  return {
    rootId: resolveValue(args.rootId, "ROOT_ID", "root_id")!,
    taskId: resolveInteger(args.taskId, "TASK_ID", "task_id"),
    attemptId: resolveInteger(args.attemptId, "ATTEMPT_ID", "attempt_id"),
    actorToken: resolveValue(args.actorToken, "ACTOR_TOKEN", "actor_token")!,
  };
}

async function actionCommand(args: Args): Promise<void> {
  const current = identity(args);
  refreshRunHooks(current.rootId, process.cwd());
  let payload: unknown;
  try { payload = await Bun.stdin.json(); } catch { throw new ValueError("action --stdin requires one JSON object"); }
  const response = actionProcessor.processAction({
    schema_version: 1, action_id: args.actionId ?? id("action"), root_id: current.rootId,
    task_id: current.taskId, attempt_id: current.attemptId, actor_token: current.actorToken,
    type: args.type, payload,
  });
  response.side_effects = outbox.drain(current.rootId);
  executionSecrets.cleanupRunSeedIfSafe(current.rootId);
  print(response);
}

function inspectCommand(args: Args): void {
  stateStore.initializeSchema();
  let rootId: string;
  if (args.run || args.notes || args.events) rootId = String(args.run ?? args.notes ?? args.events);
  else if (args.children) {
    const task = stateStore.getTask(Number(args.children));
    if (!task) throw new ValueError("task not found");
    rootId = String(task.root_id);
  } else if (args.mode !== undefined) {
    const mode = stateStore.getMode(Number(args.mode));
    if (!mode) throw new ValueError("mode not found");
    rootId = String(mode.root_id);
  } else rootId = resolveValue(args.rootId, "ROOT_ID", "root_id")!;
  const token = resolveValue(args.actorToken, "ACTOR_TOKEN", "actor_token")!;
  const run = authorizeRead(rootId, token);
  let data: RuntimeRecord;
  if (args.notes) data = { root_id: rootId, notes: stateStore.listNotes(rootId) };
  else if (args.events) data = { root_id: rootId, events: stateStore.listEvents(rootId, numeric(args, "limit", 50)) };
  else if (args.children) data = { task_id: Number(args.children), children: stateStore.fetchall(
    "SELECT * FROM tasks WHERE parent_task_id=? ORDER BY created_at", [Number(args.children)],
  ) };
  else if (args.mode !== undefined) data = { root_id: rootId, modes: stateStore.inspectModes(rootId, Number(args.mode)) };
  else if (args.current) {
    const taskId = resolveInteger(args.taskId, "TASK_ID", "task_id");
    const task = stateStore.getTask(taskId);
    if (!task || task.root_id !== rootId) throw new ValueError("current task does not belong to the authorized run");
    const attempt = stateStore.getCurrentAttempt(taskId);
    if (!attempt || attempt.root_id !== rootId || attempt.task_id !== taskId) throw new ValueError("current attempt binding is invalid");
    const launch = stateStore.getCurrentLaunch(Number(attempt.attempt_id));
    data = { run, task, attempt, launch, session: launch ? stateStore.getSessionForLaunch(Number(launch.launch_id)) : null };
  } else data = {
    run, tasks: stateStore.listTasks(rootId), attempts: stateStore.listAttempts(rootId),
    launches: stateStore.listLaunches(rootId), sessions: stateStore.listSessions(rootId),
    effects: stateStore.listEffects(rootId), modes: stateStore.inspectModes(rootId),
  };
  print(data);
}

function bootstrapCwd(args: Args): void {
  const current = identity(args);
  const beat = recovery.heartbeat(current.rootId, current.taskId, current.attemptId, current.actorToken);
  if (!beat.accepted) throw new RuntimeError("bootstrap-cwd requires a current, running Attempt");
  const run = stateStore.getRun(current.rootId);
  const hooksEnabled = Boolean(run && executionConfig.supportsHooks(executionConfig.loadRunExecution(run)));
  const settingsPath = hooksEnabled ? hookManager.ensureProjectHooks(process.cwd(), current.rootId) : null;
  print({ initialized: true, hooks_enabled: hooksEnabled, settings_path: settingsPath, heartbeat: beat });
}

function discoverRoot(cwd: string): string {
  stateStore.initializeSchema();
  const rows = stateStore.fetchall(
    `SELECT * FROM runs WHERE cwd=? AND status IN ('running','failed','stopping') ORDER BY created_at DESC`,
    [realpathSync(cwd)],
  );
  if (rows.length !== 1) throw new ValueError("recover requires exactly one recoverable run in cwd or --root-id");
  return String(rows[0]!.root_id);
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = argv;
  if (!command) throw new ValueError("a command is required");
  const args = parseArguments(rest);
  if (command === "init") {
    if (!args.task || !args.cwd) throw new ValueError("init requires --task and --cwd");
    print(initializeRun(String(args.task), String(args.cwd), {
      maxConcurrentAgents: numeric(args, "maxConcurrentAgents", 8), maxTotalTasks: numeric(args, "maxTotalTasks", 100),
      maxAttemptsPerTask: numeric(args, "maxAttemptsPerTask", 2), maxDelegationDepth: numeric(args, "maxDelegationDepth", 5),
      maxReplansPerTask: numeric(args, "maxReplansPerTask", 2), maxChildrenPerAction: numeric(args, "maxChildrenPerAction", 12),
      requireFinalReview: !args.noFinalReview, modelTiers: jsonOption(args.modelTiersJson, "model tiers") as Record<string, string>,
      backend: args.backend, acpAgent: args.acpAgent, acpCommand: args.acpCommand,
      acpArgs: jsonOption(args.acpArgsJson, "ACP args"), acpPermissionPolicy: args.acpPermissionPolicy,
      profileAllowlist: jsonOption(args.profileAllowlistJson, "profile allowlist"),
      defaultProfile: args.defaultProfile, entryMode: args.entryMode,
    }));
  } else if (command === "action") {
    if (!args.type || !ACTION_SCHEMAS[String(args.type)] || !args.stdin) throw new ValueError("action requires --type and --stdin");
    await actionCommand(args);
  } else if (command === "action-schema") {
    const action = args._[0];
    if (action && !ACTION_SCHEMAS[action]) throw new ValueError("unknown action schema");
    print(action ? ACTION_SCHEMAS[action] : ACTION_SCHEMAS);
  } else if (command === "inspect") inspectCommand(args);
  else if (command === "recover") {
    const rootId = args.rootId ? String(args.rootId) : discoverRoot(String(args.cwd ?? process.cwd()));
    const context = recovery.recoverRoot(rootId, Boolean(args.forceTakeover));
    try { context.recovery = recovery.recoverRun(rootId, String(context.actor_token)); }
    catch (error) { context.recovery = { ok: false, error: error instanceof Error ? error.message : "recovery failed" }; }
    try { context.side_effects = outbox.drain(rootId); }
    catch (error) { context.side_effects = { ok: false, error: error instanceof Error ? error.message : "effects failed" }; }
    print(context);
  } else if (command === "reap") {
    const rootId = resolveValue(args.rootId, "ROOT_ID", "root_id")!;
    const token = resolveValue(args.actorToken, "ACTOR_TOKEN", "actor_token")!;
    const report = recovery.reapChildren(rootId, token);
    report.kill_requests = (args.killAttempt ?? []).map((value: unknown) => recovery.killStalledAttempt(rootId, token, Number(value)));
    report.side_effects = outbox.drain(rootId);
    print(report);
  } else if (command === "stop") {
    print(recovery.stopRun(
      resolveValue(args.rootId, "ROOT_ID", "root_id")!,
      resolveValue(args.actorToken, "ACTOR_TOKEN", "actor_token")!,
    ));
  } else if (command === "heartbeat") {
    const current = identity(args); refreshRunHooks(current.rootId, process.cwd());
    print(recovery.heartbeat(current.rootId, current.taskId, current.attemptId, current.actorToken));
  } else if (command === "bootstrap-cwd" || command === "worktree-init") bootstrapCwd(args);
  else if (command === "doctor" || command === "metrics") {
    const rootId = resolveValue(args.rootId, "ROOT_ID", "root_id")!;
    authorizeRead(rootId, resolveValue(args.actorToken, "ACTOR_TOKEN", "actor_token")!);
    print(command === "doctor" ? recovery.doctor(rootId) : recovery.metrics(rootId));
  } else if (command === "session-history") {
    if (!args.agentType || !args.sessionId) throw new ValueError("session-history requires --agent-type and --session-id");
    const rootId = resolveValue(args.rootId, "ROOT_ID", "root_id", false) ?? undefined;
    const records = sessionHistory.findRecords(String(args.agentType), String(args.sessionId), rootId);
    const authorizedRoot = rootId ?? (records.length === 1 ? String(records[0]!.root_id) : undefined);
    if (authorizedRoot) authorizeRead(authorizedRoot, resolveValue(args.actorToken, "ACTOR_TOKEN", "actor_token")!);
    print(await sessionHistory.loadHistory(String(args.agentType), String(args.sessionId), rootId));
  } else if (command === "prune") {
    const cutoff = stateStore.now() - Math.max(0, numeric(args, "olderThanHours", 168)) * 3600;
    const pruned = stateStore.transaction((connection) => {
      const rows = stateStore.fetchall(
        "SELECT root_id, cwd FROM runs WHERE status IN ('done','failed','cancelled') AND finished_at < ?", [cutoff], connection,
      );
      const ids: string[] = [];
      for (const row of rows) {
        hookManager.cleanupProjectHooks(String(row.cwd), String(row.root_id));
        if (connection.execute(
          "DELETE FROM runs WHERE root_id=? AND status IN ('done','failed','cancelled') AND finished_at < ?",
          [row.root_id, cutoff],
        ).rowcount === 1) ids.push(String(row.root_id));
      }
      return ids;
    });
    print({ pruned: pruned.length, root_ids: pruned });
  } else throw new ValueError(`unknown command: ${command}`);
  return 0;
}

if (import.meta.main) {
  try { process.exit(await main()); }
  catch (error) {
    process.stderr.write(`agent_orchestrator.ts: error: ${error instanceof Error ? error.message : "runtime failed"}\n`);
    process.exit(2);
  }
}
