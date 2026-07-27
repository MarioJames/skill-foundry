#!/usr/bin/env bun

/** Manual end-to-end Runtime harness for an explicitly selected real ACP Agent. */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { initializeRun } from "../scripts/agent_orchestrator.ts";
import * as executionSecrets from "../scripts/execution_secrets.ts";
import * as outbox from "../scripts/outbox.ts";
import * as recovery from "../scripts/recovery.ts";
import * as scheduler from "../scripts/scheduler.ts";
import * as stateStore from "../scripts/state_store.ts";
import { processGroupAlive, terminateProcessGroup } from "../scripts/backends/acp/processes.ts";
import type { RuntimeRecord } from "../scripts/runtime_types.ts";

export const GOALS: Readonly<Record<string, string | null>> = Object.freeze({
  direct: "Follow the injected Runtime instructions. Do not modify project files. Run bootstrap-cwd, submit a direct estimate, then finish(status=done) with no changed files.",
  permission: "Follow the injected Runtime instructions. Create permission-proof.txt containing exactly `ACP permission proof` followed by a newline, validate it, then finish(status=done).",
  "permission-allow": "Follow the injected Runtime instructions. Create permission-proof.txt containing exactly `ACP permission proof` followed by a newline, validate it, then finish(status=done).",
  "permission-deny": null,
  stop: "Follow the injected Runtime instructions, submit a direct estimate, then sleep for 60 seconds before finish. Do not skip the sleep.",
  "agent-crash": "Follow the injected Runtime instructions, submit a direct estimate, then sleep for 60 seconds before finish. The adapter will be terminated externally.",
  orchestration: "Follow the injected Runtime instructions. Submit a split estimate, create exactly two independent child Tasks named leaf-a and leaf-b, wait for both, verify their results, then finish(status=done) with a passed integration_check.",
});

interface Options {
  agent: string;
  profile: string;
  command: string;
  commandArgs: string[];
  mode: string;
  workspace: string;
  runtimeHome: string;
  permissionPolicy?: string;
  timeout: number;
}

function parseArguments(argv: string[]): Options {
  const values: Record<string, string | string[]> = { commandArg: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index]!;
    if (!raw.startsWith("--")) throw new Error(`unexpected argument: ${raw}`);
    const key = raw.slice(2).replaceAll(/-([a-z])/gu, (_match, letter: string) => letter.toUpperCase());
    const value = argv[++index];
    if (value === undefined) throw new Error(`${raw} requires a value`);
    if (key === "commandArg") (values.commandArg as string[]).push(value);
    else values[key] = value;
  }
  for (const required of ["agent", "command", "mode", "workspace", "runtimeHome"]) {
    if (typeof values[required] !== "string" || !values[required]) throw new Error(`--${required.replaceAll(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)} is required`);
  }
  const profile = String(values.profile ?? "custom");
  if (!["claude", "codex", "gemini", "custom"].includes(profile)) throw new Error("unsupported profile");
  const mode = String(values.mode);
  if (!(mode in GOALS)) throw new Error("unsupported harness mode");
  const timeout = Number(values.timeout ?? 180);
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("--timeout must be positive");
  return {
    agent: String(values.agent), profile, command: resolve(String(values.command)),
    commandArgs: values.commandArg as string[], mode,
    workspace: resolve(String(values.workspace)), runtimeHome: resolve(String(values.runtimeHome)),
    permissionPolicy: typeof values.permissionPolicy === "string" ? values.permissionPolicy : undefined,
    timeout,
  };
}

export function permissionDenyGoal(path: string): string {
  return `Follow the injected Runtime instructions. Attempt to create the absolute path \`${path}\` containing \`must be denied\`. Do not bypass a denial. Confirm the file does not exist, then finish(status=done) with no changed files.`;
}

export function classifyPermissionDeny(options: {
  outsideExists: boolean;
  permissionEvents: RuntimeRecord[];
  safeWorkspaceMode: boolean;
}): RuntimeRecord {
  const callbackDenied = options.permissionEvents.some((event) => event.allowed === false);
  const evidence = !options.outsideExists && callbackDenied
    ? "acp_callback_deny"
    : !options.outsideExists && options.safeWorkspaceMode ? "native_sandbox_deny" : "not_denied";
  return {
    passed: new Set(["acp_callback_deny", "native_sandbox_deny"]).has(evidence),
    evidence,
    acp_permission_callback_passed: evidence === "acp_callback_deny",
  };
}

export function hasSafeWorkspaceMode(events: RuntimeRecord[]): boolean {
  return events.some((event) => new Set(["agent", "auto", "default"]).has(String((event.configured as RuntimeRecord | undefined)?.mode)));
}

export function hasWriteCapableMode(events: RuntimeRecord[]): boolean {
  return events.some((event) => new Set([
    "agent", "auto", "default", "agent-full-access", "bypassPermissions", "full-access",
  ]).has(String((event.configured as RuntimeRecord | undefined)?.mode)));
}

export function tokenResidue(runtimeHome: string, plaintextTokens: string[]): string[] {
  const tokens = plaintextTokens.filter(Boolean).map((token) => Buffer.from(token));
  const found: string[] = [];
  const pending = [runtimeHome];
  while (pending.length) {
    const directory = pending.pop()!;
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) {
        try {
          const bytes = readFileSync(path);
          if (tokens.some((token) => bytes.includes(token))) found.push(relative(runtimeHome, path));
        } catch { /* a concurrently removed log is safe */ }
      }
    }
  }
  return found.sort();
}

export function boundedCleanup(identity: RuntimeRecord | null): RuntimeRecord {
  const result: RuntimeRecord = { stop: null, error: null, fallback: [] };
  if (!identity) return result;
  try { result.stop = recovery.stopRun(String(identity.root_id), String(identity.actor_token)); }
  catch (error) { result.error = { type: error instanceof Error ? error.name : "Error" }; }
  for (const launch of stateStore.listLaunches(String(identity.root_id))) {
    const nonce = typeof launch.owner_nonce === "string" ? launch.owner_nonce : null;
    for (const field of ["agent_pid", "worker_pid"] as const) {
      if (!processGroupAlive(launch[field])) continue;
      const cleaned = terminateProcessGroup(launch[field], { graceSeconds: 1, expectedNonce: nonce });
      (result.fallback as RuntimeRecord[]).push({ process: field, cleaned });
    }
    const endpoint = typeof launch.control_endpoint === "string" ? launch.control_endpoint : null;
    if (endpoint && !processGroupAlive(launch.worker_pid) && !processGroupAlive(launch.agent_pid)) {
      try { unlinkSync(endpoint); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          (result.fallback as RuntimeRecord[]).push({ process: "control_endpoint", cleaned: false });
        }
      }
    }
  }
  return result;
}

function createChild(rootId: string, goal: string): RuntimeRecord {
  stateStore.transaction((connection) => {
    const run = stateStore.getRun(rootId, connection)!;
    connection.execute(
      `INSERT INTO tasks(root_id, parent_task_id, goal, intent_hint, status, priority,
        complexity_hint, output_contract, constraints_json, delegation_depth, replan_count, created_at)
       VALUES (?, ?, ?, 'implement', 'ready', 50, 'low', 'Complete the Runtime smoke contract.', '{}', 1, 0, ?)`,
      [rootId, run.root_task_id, goal, stateStore.now()],
    );
  });
  return scheduler.schedule(rootId)[0]!;
}

function executionClean(launch: RuntimeRecord): boolean {
  const endpoint = typeof launch.control_endpoint === "string" ? launch.control_endpoint : null;
  return launch.status === "closed" && !processGroupAlive(launch.worker_pid) &&
    !processGroupAlive(launch.agent_pid) && !(endpoint && existsSync(endpoint));
}

function waitUntil<T>(probe: () => T | null | false | undefined, timeoutSeconds: number): T {
  const deadline = performance.now() + timeoutSeconds * 1000;
  while (performance.now() < deadline) {
    const value = probe();
    if (value) return value;
    Bun.sleepSync(250);
  }
  const value = probe();
  if (value) return value;
  throw new Error("timed out waiting for real ACP condition");
}

function eventPayloads(rootId: string, type: string): RuntimeRecord[] {
  return stateStore.listEvents(rootId, 500)
    .filter((event) => event.type === type)
    .map((event) => JSON.parse(String(event.payload_json)) as RuntimeRecord);
}

export function runHarness(options: Options): RuntimeRecord {
  mkdirSync(options.workspace, { recursive: true });
  mkdirSync(options.runtimeHome, { recursive: true, mode: 0o700 });
  process.env.AGENTS_ORCHESTRATOR_HOME = options.runtimeHome;
  process.env.AGENT_SWARM_HOME = options.runtimeHome;
  const started = performance.now();
  let identity: RuntimeRecord | null = null;
  let child: RuntimeRecord | null = null;
  let drain: RuntimeRecord | null = null;
  let failure: RuntimeRecord | null = null;
  let adapterTerminated = false;
  let cleanup: RuntimeRecord = { stop: null, error: null, fallback: [] };
  const plaintextTokens: string[] = [];
  const outside = join(dirname(options.workspace), `${options.workspace.split(/[\\/]/u).at(-1)}-outside-permission-proof.txt`);
  const outsidePreexisting = existsSync(outside);
  try {
    if (options.mode === "permission-deny" && outsidePreexisting) throw new Error("outside permission proof path already exists");
    identity = initializeRun(`real ACP ${options.mode} smoke`, options.workspace, {
      maxAttemptsPerTask: 1, requireFinalReview: false, backend: "acp",
      acpAgent: options.profile, acpCommand: options.command, acpArgs: options.commandArgs,
      acpPermissionPolicy: options.permissionPolicy,
    });
    child = createChild(String(identity.root_id), options.mode === "permission-deny" ? permissionDenyGoal(outside) : GOALS[options.mode]!);
    const run = stateStore.getRun(String(identity.root_id))!;
    plaintextTokens.push(String(identity.actor_token), executionSecrets.deriveAttemptToken(run, Number(child.attempt_id)));
    drain = outbox.drain(String(identity.root_id), undefined, 1);
    if (options.mode === "agent-crash") {
      const running = waitUntil(() => {
        const launch = stateStore.getLaunch(Number(child!.launch_id));
        return launch?.status === "running" ? launch : null;
      }, options.timeout);
      adapterTerminated = terminateProcessGroup(running.agent_pid, {
        graceSeconds: 2,
        expectedNonce: typeof running.owner_nonce === "string" ? running.owner_nonce : null,
      });
      if (!adapterTerminated) throw new Error("failed to terminate ACP adapter process group");
      waitUntil(() => stateStore.getLaunch(Number(child!.launch_id))?.status === "closed", options.timeout);
      waitUntil(() => {
        recovery.reapChildren(String(identity!.root_id), String(identity!.actor_token));
        return stateStore.getAttempt(Number(child!.attempt_id))?.state === "failed";
      }, options.timeout);
    } else if (options.mode !== "stop") {
      waitUntil(() => {
        const task = stateStore.getTask(Number(child!.task_id));
        if (task && new Set(["done", "failed", "cancelled", "blocked"]).has(String(task.status))) return task;
        recovery.reapChildren(String(identity!.root_id), String(identity!.actor_token));
        return null;
      }, options.timeout);
    }
  } catch (error) {
    failure = { type: error instanceof Error ? error.name : "Error" };
  } finally {
    cleanup = boundedCleanup(identity);
  }

  const rootId = identity ? String(identity.root_id) : null;
  const launch = child ? stateStore.getLaunch(Number(child.launch_id)) : null;
  const task = child ? stateStore.getTask(Number(child.task_id)) : null;
  const permissions = rootId ? eventPayloads(rootId, "AcpPermissionDecision") : [];
  const sessions = rootId ? eventPayloads(rootId, "AcpSessionCreated") : [];
  const normalizedMode = options.mode === "permission" ? "permission-allow" : options.mode;
  const proof = join(options.workspace, "permission-proof.txt");
  let permissionEvidence: RuntimeRecord | null = null;
  if (normalizedMode === "permission-allow") {
    const callbackAllowed = permissions.some((event) => event.allowed === true);
    permissionEvidence = {
      passed: existsSync(proof) && (callbackAllowed || hasWriteCapableMode(sessions)),
      evidence: callbackAllowed ? "acp_callback_allow" : "native_mode_allow",
      acp_permission_callback_passed: callbackAllowed,
    };
  } else if (normalizedMode === "permission-deny") {
    permissionEvidence = classifyPermissionDeny({
      outsideExists: existsSync(outside), permissionEvents: permissions,
      safeWorkspaceMode: hasSafeWorkspaceMode(sessions),
    });
  }
  const launches = rootId ? stateStore.listLaunches(rootId) : [];
  const tasks = rootId ? stateStore.listTasks(rootId) : [];
  const attempts = rootId ? stateStore.listAttempts(rootId) : [];
  const descendants = child ? tasks.filter((item) => item.parent_task_id === child!.task_id) : [];
  const currentAttempt = child ? stateStore.getAttempt(Number(child.attempt_id)) : null;
  const retryableFailure = currentAttempt?.state === "failed";
  const allExecutionsClean = launches.length > 0 && launches.every(executionClean);
  const residue = tokenResidue(options.runtimeHome, plaintextTokens);
  const stopResult = cleanup.stop as RuntimeRecord | null;
  const modeOutcome = options.mode === "agent-crash"
    ? Boolean(adapterTerminated && retryableFailure && task?.status === "failed" && String(launch?.exit_reason).startsWith("acp_error:"))
    : options.mode === "orchestration"
      ? Boolean(task?.status === "done" && descendants.length === 2 && descendants.every((item) => item.status === "done"))
      : options.mode === "stop"
        ? Boolean(rootId && stateStore.getRun(rootId)?.status === "cancelled")
        : task?.status === "done";
  const permissionPassed = !new Set(["permission-allow", "permission-deny"]).has(normalizedMode) || permissionEvidence?.passed === true;
  const proofCorrect = normalizedMode !== "permission-allow" || (existsSync(proof) && readFileSync(proof, "utf8") === "ACP permission proof\n");
  const ok = failure === null && cleanup.error === null && stopResult?.status === "cancelled" &&
    allExecutionsClean && Boolean(modeOutcome) && residue.length === 0 && permissionPassed && proofCorrect;
  const report: RuntimeRecord = {
    agent: options.agent, mode: options.mode, ok,
    elapsed_seconds: Math.round((performance.now() - started) / 100) / 10_000,
    drain, stop: cleanup.stop, cleanup, error: failure,
    task_status: task?.status ?? null, attempt_status: currentAttempt?.state ?? null,
    execution: launch ? Object.fromEntries(["status", "prompt_state", "launch_no", "exit_reason", "ready_at", "closed_at"].map((key) => [key, launch[key] ?? null])) : null,
    permission_events: permissions, permission_evidence: permissionEvidence,
    session_events: sessions, proof_exists: existsSync(proof), outside_proof_exists: existsSync(outside),
    adapter_terminated: adapterTerminated, retryable_failure: retryableFailure,
    launch_count: launches.length, all_executions_clean: allExecutionsClean,
    launch_summaries: launches.map((item) => ({ launch_id: item.launch_id, attempt_id: item.attempt_id, status: item.status, exit_reason: item.exit_reason })),
    attempt_summaries: attempts.map((item) => ({ attempt_id: item.attempt_id, task_id: item.task_id, state: item.state, retryable: Boolean(item.retryable) })),
    task_summaries: tasks.map((item) => ({ task_id: item.task_id, parent_task_id: item.parent_task_id, status: item.status })),
    descendant_task_statuses: descendants.map((item) => item.status), token_residue_files: residue,
    runtime_home: options.runtimeHome, workspace: options.workspace,
  };
  if (options.mode === "permission-deny" && existsSync(outside) && !outsidePreexisting) {
    rmSync(outside, { force: true });
    report.outside_proof_cleaned = true;
  }
  return report;
}

if (import.meta.main) {
  try {
    const report = runHarness(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exit(report.ok ? 0 : 1);
  } catch (error) {
    process.stderr.write(`manual_real_acp.ts: ${error instanceof Error ? error.message : "invalid arguments"}\n`);
    process.exit(2);
  }
}
