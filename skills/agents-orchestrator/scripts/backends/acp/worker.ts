#!/usr/bin/env bun
import { closeSync, constants as fsConstants, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

import * as executionSecrets from "../../execution_secrets.ts";
import * as executionState from "../../execution_state.ts";
import * as promptBuilder from "../../prompt_builder.ts";
import * as stateStore from "../../state_store.ts";
import { RuntimeError, type RuntimeRecord } from "../../runtime_types.ts";
import { createAcpClient } from "./client.ts";
import { decidePermission } from "./permissions.ts";
import { terminateProcessGroup } from "./processes.ts";
import { ensureAvailable, ensureSdkAvailable } from "./registry.ts";
import { configureSession } from "./session_config.ts";
import { ControlServer, endpointPath } from "./worker_protocol.ts";

const SCRIPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SKILL_DIR = dirname(SCRIPTS_DIR);
const IDENTITY_SUFFIXES = new Set(["ROOT_ID", "TASK_ID", "ATTEMPT_ID", "ACTOR_TOKEN", "HOME", "SKILL_DIR"]);

function safeAcpError(error: unknown): string {
  const name = error instanceof Error && /^[A-Za-z][A-Za-z0-9]*$/u.test(error.name) ? error.name : "Error";
  const code = error !== null && typeof error === "object" && Number.isInteger((error as RuntimeRecord).code)
    ? `:code=${(error as RuntimeRecord).code}` : "";
  return `acp_error:${name}${code}`;
}

function parseObject(raw: unknown): RuntimeRecord {
  const value: unknown = JSON.parse(typeof raw === "string" ? raw : "{}");
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new RuntimeError("invalid persisted execution configuration");
  return value as RuntimeRecord;
}

function delay(milliseconds: number): Promise<void> { return Bun.sleep(milliseconds); }

export class Worker {
  readonly launchId: number;
  readonly attemptId: number;
  private readonly candidateNonce: string;
  private stopRequested = false;
  private cleanupStarted = false;
  private cleanupSucceeded = false;
  private cleanupResolve!: () => void;
  private readonly cleanupDone = new Promise<void>((resolveDone) => { this.cleanupResolve = resolveDone; });
  private control: ControlServer | null = null;
  private agent: ChildProcess | null = null;
  private connection: acp.ClientConnection | null = null;
  private context: acp.ClientContext | null = null;
  private sessionId: string | null = null;
  private capabilities: RuntimeRecord = {};
  private protocolVersion = 1;
  private configured: Record<string, string> = {};
  private promptPending = false;
  private exitReason = "worker_exit";
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private logDescriptor: number | null = null;
  private promptPromise: Promise<acp.PromptResponse> | null = null;

  constructor(launchId: number, candidateNonce: string) {
    this.launchId = Math.trunc(launchId);
    const launch = stateStore.getLaunch(this.launchId);
    if (!launch) throw new RuntimeError("launch record not found");
    this.attemptId = Number(launch.attempt_id);
    this.candidateNonce = candidateNonce;
  }

  private records(): [RuntimeRecord, RuntimeRecord, RuntimeRecord, RuntimeRecord] {
    return stateStore.transaction((connection) => {
      const launch = stateStore.getLaunch(this.launchId, connection);
      const attempt = stateStore.getAttempt(this.attemptId, connection);
      const task = attempt ? stateStore.getTask(Number(attempt.task_id), connection) : null;
      const run = launch ? stateStore.getRun(String(launch.root_id), connection) : null;
      if (!run || !task || !attempt || !launch) throw new RuntimeError("launch identity is incomplete");
      return [run, task, attempt, launch];
    }, false);
  }

  private openLog(rootId: string): void {
    const path = join(stateStore.runtimeRoot(), "logs", rootId, "acp", `launch-${this.launchId}.ndjson`);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.logDescriptor = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND, 0o600);
  }

  private log(event: string, fields: RuntimeRecord = {}): void {
    if (this.logDescriptor === null) return;
    const safe = JSON.stringify({ event, at: stateStore.now(), ...fields });
    writeSync(this.logDescriptor, `${safe}\n`);
  }

  private sessionUpdate(notification: acp.SessionNotification): void {
    this.log("session_update", {
      session_id: notification.sessionId,
      update_type: notification.update.sessionUpdate,
    });
  }

  private permission(request: acp.RequestPermissionRequest): ReturnType<typeof decidePermission> {
    const [run, , , launch] = this.records();
    const config = parseObject(launch.config_json);
    const decision = decidePermission(request, {
      policy: String(config.permission_policy || "allow_in_workspace"),
      cwd: String(run.cwd),
      runtimeEntrypoint: join(SCRIPTS_DIR, "agent_orchestrator.ts"),
    });
    stateStore.transaction((connection) => stateStore.appendEvent(
      connection, String(run.root_id), "AcpPermissionDecision",
      { selected: decision.selectedOptionId, allowed: decision.allowed },
      null, this.attemptId,
    ));
    return decision;
  }

  private async controlRequest(request: RuntimeRecord): Promise<RuntimeRecord> {
    if (Number(request.launch_id ?? -1) !== this.launchId) return { ok: false, error: "launch fence mismatch" };
    if (request.command === "ping" || request.command === "status") {
      const record = stateStore.getLaunch(this.launchId);
      return {
        ok: true, launch_id: this.launchId, worker_pid: process.pid,
        agent_pid: this.agent?.pid ?? record?.agent_pid ?? null,
        prompt_state: record?.prompt_state ?? null, status: record?.status ?? null,
      };
    }
    if (request.command === "stop") {
      this.stopRequested = true;
      const timeout = Math.max(0, Number(request.timeout || 8)) * 1000;
      await Promise.race([this.cleanupDone, delay(timeout)]);
      return { ok: true, stopped: this.cleanupStarted && this.cleanupSucceeded };
    }
    return { ok: false, error: "unsupported control command" };
  }

  private heartbeat(): void {
    const record = stateStore.getLaunch(this.launchId);
    if (!record || record.stop_requested_at !== null) this.stopRequested = true;
    executionState.heartbeat(this.launchId, this.candidateNonce);
  }

  private attemptTerminal(): boolean {
    const attempt = stateStore.getAttempt(this.attemptId);
    return !attempt || !executionState.LIVE_ATTEMPT_STATES.has(String(attempt.state));
  }

  private async waitOperation<T>(
    operation: Promise<T>,
    options: { timeoutSeconds?: number | null; checkAttempt?: boolean } = {},
  ): Promise<[T | null, string | null]> {
    const deadline = options.timeoutSeconds ? performance.now() + options.timeoutSeconds * 1000 : null;
    const tracked = operation.then(
      (value) => ({ kind: "value" as const, value }),
      (error: unknown) => ({ kind: "error" as const, error }),
    );
    while (true) {
      if (this.stopRequested) return [null, "stopped"];
      if (options.checkAttempt && this.attemptTerminal()) { await delay(250); return [null, "attempt_terminal"]; }
      if (deadline !== null && performance.now() >= deadline) return [null, "timeout"];
      const result = await Promise.race([
        tracked,
        delay(50).then(() => ({ kind: "tick" as const })),
      ]);
      if (result.kind === "value") return [result.value, null];
      if (result.kind === "error") throw result.error;
    }
  }

  private recordPromptEnd(rootId: string, result: acp.PromptResponse, reprompt: number): void {
    stateStore.transaction((connection) => stateStore.appendEvent(
      connection, rootId, "PromptTurnEnded", { stop_reason: result.stopReason, reprompt }, null, this.attemptId,
    ));
  }

  private async runPromptTurns(run: RuntimeRecord, config: RuntimeRecord, bootstrap: string): Promise<void> {
    if (!this.context || !this.sessionId) throw new RuntimeError("ACP session is unavailable");
    const limit = Number(config.turn_end_reprompt_limit ?? 1);
    let text = bootstrap;
    for (let reprompt = 0; reprompt <= limit; reprompt += 1) {
      this.promptPromise = this.context.request(acp.methods.agent.session.prompt, {
        sessionId: this.sessionId,
        prompt: [{ type: "text", text }],
      });
      this.promptPending = true;
      if (reprompt === 0) {
        const ready = executionState.markReady(this.launchId, this.candidateNonce, {
          externalSessionId: this.sessionId,
          protocolVersion: this.protocolVersion,
          capabilities: this.capabilities,
          profileConfig: config,
          cwd: String(run.cwd),
          mode: this.configured.mode ?? null,
          model: this.configured.model ?? config.model ?? null,
        });
        if (!ready) { this.exitReason = "ready_fence_rejected"; return; }
      }
      const [result, interrupted] = await this.waitOperation(this.promptPromise, {
        timeoutSeconds: config.prompt_timeout_seconds ? Number(config.prompt_timeout_seconds) : null,
        checkAttempt: true,
      });
      this.promptPending = false;
      if (interrupted) { this.exitReason = interrupted === "timeout" ? "prompt_timeout" : interrupted; return; }
      this.recordPromptEnd(String(run.root_id), result!, reprompt);
      if (this.attemptTerminal()) { this.exitReason = "attempt_terminal"; return; }
      if (reprompt < limit) {
        text = "The Runtime Attempt is still unfinished. Submit the required Runtime finish(status=done|failed) Action now, or report failure through that Action.";
      } else {
        this.exitReason = `without_finish:${result!.stopReason}`;
        executionState.recordTurnEnd(this.launchId, this.candidateNonce, this.exitReason);
      }
    }
  }

  async run(): Promise<number> {
    if (!stateStore.claimLaunchOwnership(this.launchId, this.candidateNonce, process.pid)) return 3;
    return this.runOwned();
  }

  private async runOwned(): Promise<number> {
    const [run, task, attempt, launch] = this.records();
    this.openLog(String(run.root_id));
    const endpoint = endpointPath(stateStore.runtimeRoot(), String(run.root_id), this.launchId);
    this.control = new ControlServer(endpoint, (request) => this.controlRequest(request));
    await this.control.start();
    if (!executionState.registerControlEndpoint(this.launchId, this.candidateNonce, endpoint)) {
      this.exitReason = "control_endpoint_fence_rejected";
      await this.cleanup();
      return 4;
    }
    this.heartbeatTimer = setInterval(() => this.heartbeat(), 500);
    const config = parseObject(launch.config_json);
    let command: string;
    try { command = ensureAvailable(config); ensureSdkAvailable(); }
    catch (error) {
      this.exitReason = error instanceof Error ? error.message : "ACP dependencies are unavailable";
      executionState.recordTurnEnd(this.launchId, this.candidateNonce, this.exitReason, true);
      await this.cleanup();
      return 5;
    }
    const token = executionSecrets.deriveAttemptToken(run, Number(attempt.attempt_id));
    const childEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      const suffix = key.startsWith("AGENTS_ORCHESTRATOR_") ? key.slice("AGENTS_ORCHESTRATOR_".length) : null;
      if (value !== undefined && !(suffix && IDENTITY_SUFFIXES.has(suffix))) childEnv[key] = value;
    }
    const identities: Record<string, string> = {
      ROOT_ID: String(run.root_id), TASK_ID: String(task.task_id), ATTEMPT_ID: String(attempt.attempt_id),
      ACTOR_TOKEN: token, HOME: stateStore.runtimeRoot(), SKILL_DIR,
    };
    for (const [suffix, value] of Object.entries(identities)) {
      childEnv[`AGENTS_ORCHESTRATOR_${suffix}`] = value;
    }
    try {
      if (this.stopRequested || !executionState.ownershipIsLive(this.launchId, this.candidateNonce)) {
        this.exitReason = "stopped_before_agent_popen";
        return 0;
      }
      this.agent = spawn(command, Array.isArray(config.args) ? config.args.map(String) : [], {
        cwd: String(run.cwd), env: childEnv, stdio: ["pipe", "pipe", "ignore"], detached: true,
      });
      const agentPid = this.agent.pid;
      if (!agentPid || !executionState.registerAgentProcess(this.launchId, this.candidateNonce, agentPid) ||
          !executionState.ownershipIsLive(this.launchId, this.candidateNonce)) {
        this.exitReason = "agent_popen_fence_rejected";
        return 6;
      }
      const stdin = this.agent.stdin;
      const stdout = this.agent.stdout;
      if (!stdin || !stdout) throw new RuntimeError("ACP Agent process did not expose stdio streams");
      const app = createAcpClient((request) => this.permission(request), (notification) => this.sessionUpdate(notification));
      const stream = acp.ndJsonStream(
        Writable.toWeb(stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(stdout) as ReadableStream<Uint8Array>,
      );
      this.connection = app.connect(stream);
      this.context = this.connection.agent;
      const [initialized, initializeInterrupted] = await this.waitOperation(
        this.context.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: { name: "agents-orchestrator", title: "Agents Orchestrator Runtime", version: "1" },
        }),
        { timeoutSeconds: 30 },
      );
      if (initializeInterrupted) { this.exitReason = initializeInterrupted === "timeout" ? "initialize_timeout" : "stopped_during_initialize"; return 0; }
      if (initialized!.protocolVersion !== acp.PROTOCOL_VERSION) throw new RuntimeError(`ACP agent did not negotiate protocolVersion=${acp.PROTOCOL_VERSION}`);
      this.capabilities = (initialized!.agentCapabilities ?? {}) as RuntimeRecord;
      this.protocolVersion = acp.PROTOCOL_VERSION;
      stateStore.transaction((connection) => stateStore.appendEvent(
        connection, String(run.root_id), "AcpInitialized",
        { protocol_version: acp.PROTOCOL_VERSION, auth_methods: (initialized!.authMethods ?? []).map((method) => method.id) },
        null, this.attemptId,
      ));
      if (this.stopRequested || !executionState.ownershipIsLive(this.launchId, this.candidateNonce)) {
        this.exitReason = "stopped_during_initialize"; return 0;
      }
      const [session, sessionInterrupted] = await this.waitOperation(
        this.context.request(acp.methods.agent.session.new, { cwd: String(run.cwd), mcpServers: [] }),
        { timeoutSeconds: 30 },
      );
      if (sessionInterrupted) { this.exitReason = sessionInterrupted === "timeout" ? "session_new_timeout" : "stopped_during_session_new"; return 0; }
      this.sessionId = session!.sessionId;
      this.configured = await configureSession(this.context, this.sessionId, session!.configOptions ?? [], {
        model: typeof config.model === "string" ? config.model : null,
        permissionPolicy: String(config.permission_policy || "allow_in_workspace"),
      });
      stateStore.transaction((connection) => stateStore.appendEvent(
        connection, String(run.root_id), "AcpSessionCreated",
        { session_id: this.sessionId, configured: this.configured }, null, this.attemptId,
      ));
      if (this.stopRequested || !executionState.ownershipIsLive(this.launchId, this.candidateNonce)) {
        this.exitReason = "stopped_before_prompt"; return 0;
      }
      const bootstrap = stateStore.transaction(
        (connection) => promptBuilder.buildPrompt(run, task, attempt, connection), false,
      );
      await this.runPromptTurns(run, config, bootstrap);
      return 0;
    } catch (error) {
      this.exitReason = safeAcpError(error);
      if (!this.stopRequested && !this.attemptTerminal()) {
        executionState.recordTurnEnd(this.launchId, this.candidateNonce, this.exitReason, true);
      }
      return 7;
    } finally { await this.cleanup(); }
  }

  private async cleanup(): Promise<void> {
    if (this.cleanupStarted) return this.cleanupDone;
    this.cleanupStarted = true;
    this.stopRequested = true;
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.context && this.sessionId) {
      if (this.promptPending) {
        try {
          await Promise.race([
            this.context.notify(acp.methods.agent.session.cancel, { sessionId: this.sessionId }),
            delay(1000),
          ]);
        } catch { /* cleanup continues */ }
      }
      const sessionCapabilities = this.capabilities.sessionCapabilities;
      if (sessionCapabilities && typeof sessionCapabilities === "object" && "close" in sessionCapabilities) {
        try {
          await Promise.race([
            this.context.request(acp.methods.agent.session.close, { sessionId: this.sessionId }),
            delay(1000),
          ]);
        } catch { /* optional capability */ }
      }
    }
    this.connection?.close();
    const pid = this.agent?.pid;
    const agentClean = pid ? terminateProcessGroup(pid, { graceSeconds: 0.5, trusted: true }) : true;
    try { this.agent?.stdin?.destroy(); } catch { /* ignore */ }
    if (this.control) { await this.control.close(); this.control = null; }
    if (agentClean) {
      executionState.markClosed(this.launchId, this.candidateNonce, this.exitReason);
      try { executionSecrets.cleanupRunSeedIfSafe(String(this.records()[0].root_id)); } catch { /* run may already be removed */ }
      this.cleanupSucceeded = true;
    } else {
      this.exitReason = "process_group_cleanup_failed";
      executionState.markCleanupFailed(this.launchId, this.candidateNonce, this.exitReason);
    }
    if (this.logDescriptor !== null) {
      this.log("closed", { reason: this.exitReason });
      closeSync(this.logDescriptor);
      this.logDescriptor = null;
    }
    this.cleanupResolve();
  }
}

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

if (import.meta.main) {
  const launchId = Number(argument("--launch-id"));
  const nonce = argument("--candidate-nonce");
  if (!Number.isSafeInteger(launchId) || launchId <= 0 || !nonce) process.exit(2);
  const worker = new Worker(launchId, nonce);
  process.exit(await worker.run());
}
