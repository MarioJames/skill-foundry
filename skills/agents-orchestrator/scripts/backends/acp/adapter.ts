import { closeSync, constants as fsConstants, existsSync, mkdirSync, openSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as executionState from "../../execution_state.ts";
import * as stateStore from "../../state_store.ts";
import { canonicalJson, RuntimeError, type RuntimeRecord } from "../../runtime_types.ts";
import {
  AgentBackend,
  BackendPendingError,
  BackendUnknownError,
  ObserveResult,
  SpawnRequest,
  SpawnResult,
  StopRequest,
} from "../base.ts";
import { pidAlive, processGroupAlive, terminateProcessGroup } from "./processes.ts";
import { controlRequestSync } from "./worker_protocol.ts";

const WORKER = fileURLToPath(new URL("./worker.ts", import.meta.url));
const MIN_FRESH_WORKER_LAUNCH_TIMEOUT_SECONDS = 1;

function integer(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function unlinkMissingOkay(path: string): void {
  try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

export class AcpBackend extends AgentBackend {
  readonly backendId = "acp";
  private config: RuntimeRecord;
  private executionRecord: RuntimeRecord;

  constructor(config: RuntimeRecord = {}, executionRecord: RuntimeRecord = {}) {
    super();
    this.config = { ...config };
    this.executionRecord = { ...executionRecord };
  }

  private record(launchId?: number | null): RuntimeRecord {
    const id = launchId ?? integer(this.executionRecord.launch_id);
    const record = id ? stateStore.getLaunch(id) : null;
    if (!record) throw new RuntimeError("ACP Launch record not found");
    if (record.backend_id !== "acp") throw new RuntimeError("Launch backend is not ACP");
    this.executionRecord = record;
    return record;
  }

  private static jobId(record: RuntimeRecord): string {
    return typeof record.backend_ref === "string" && record.backend_ref
      ? record.backend_ref : `acp-launch:${record.launch_id}`;
  }

  private ping(record: RuntimeRecord, timeoutSeconds = 0.5): RuntimeRecord | null {
    const endpoint = record.control_endpoint;
    if (typeof endpoint !== "string" || !existsSync(endpoint)) return null;
    try {
      const result = controlRequestSync(endpoint, "ping", { launch_id: record.launch_id }, timeoutSeconds);
      return result.ok && Number(result.launch_id) === Number(record.launch_id) ? result : null;
    } catch { return null; }
  }

  private launchWorker(request: SpawnRequest, record: RuntimeRecord): void {
    const logPath = join(
      stateStore.runtimeRoot(), "logs", String(record.root_id), "acp", `launch-${record.launch_id}.worker.log`,
    );
    mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
    const descriptor = openSync(logPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND, 0o600);
    const candidateNonce = randomBytes(16).toString("hex");
    const environment: Record<string, string> = {};
    const scrubbedSuffixes = new Set(["ROOT_ID", "TASK_ID", "ATTEMPT_ID", "ACTOR_TOKEN", "AGENT_ID", "EXECUTION_NONCE", "SKILL_DIR"]);
    for (const [key, value] of Object.entries(process.env)) {
      const suffix = key.startsWith("AGENTS_ORCHESTRATOR_") ? key.slice("AGENTS_ORCHESTRATOR_".length) : null;
      if (value !== undefined && !(suffix && scrubbedSuffixes.has(suffix))) environment[key] = value;
    }
    environment.AGENTS_ORCHESTRATOR_HOME = stateStore.runtimeRoot();
    environment.AGENTS_ORCHESTRATOR_EXECUTION_NONCE = candidateNonce;
    let child: Bun.Subprocess;
    try {
      child = Bun.spawn({
        cmd: [process.execPath, WORKER, "--launch-id", String(record.launch_id), "--candidate-nonce", candidateNonce],
        cwd: request.cwd,
        env: environment,
        stdin: "ignore",
        stdout: descriptor,
        stderr: descriptor,
        detached: true,
      });
      child.unref();
    } finally { closeSync(descriptor); }
  }

  private advanceAbsentLaunch(record: RuntimeRecord): boolean {
    if (record.status !== "starting" || record.stop_requested_at !== null) return false;
    if (processGroupAlive(record.worker_pid) || processGroupAlive(record.agent_pid)) return false;
    const endpoint = record.control_endpoint;
    if (typeof endpoint === "string") {
      try { unlinkMissingOkay(endpoint); }
      catch { throw new BackendUnknownError("ACP control endpoint could not be removed before Launch retry"); }
    }
    let nextLaunchId: number | null = null;
    stateStore.transaction((connection) => {
      const current = stateStore.getLaunch(Number(record.launch_id), connection);
      const latest = current ? stateStore.getCurrentLaunch(Number(current.attempt_id), connection) : null;
      const attempt = current ? stateStore.getAttempt(Number(current.attempt_id), connection) : null;
      if (!current || !latest || !attempt || Number(latest.launch_id) !== Number(current.launch_id) ||
          current.owner_nonce !== record.owner_nonce || current.status !== "starting" ||
          current.stop_requested_at !== null || attempt.state !== "assigned") return;
      const timestamp = stateStore.now();
      connection.execute(
        `UPDATE launches SET status='closed', prompt_state='cancelled',
            exit_reason='worker_agent_control_absent', closed_at=?, last_event_at=?
          WHERE launch_id=? AND status='starting'`,
        [timestamp, timestamp, current.launch_id],
      );
      const cursor = connection.execute(
        `INSERT INTO launches(attempt_id, launch_no, session_name, status, prompt_state, created_at, last_event_at)
         VALUES (?, ?, ?, 'starting', 'pending', ?, ?)`,
        [current.attempt_id, Number(current.launch_no) + 1, current.session_name, timestamp, timestamp],
      );
      nextLaunchId = Number(cursor.lastrowid);
      const payload = {
        root_id: current.root_id, task_id: current.task_id, attempt_id: current.attempt_id,
        launch_id: nextLaunchId, backend_id: "acp",
      };
      connection.execute(
        `INSERT INTO effects(root_id, attempt_id, launch_id, effect_type, payload_json,
          idempotency_key, status, attempts, created_at)
         VALUES (?, ?, ?, 'spawn_agent', ?, ?, 'pending', 0, ?)`,
        [current.root_id, current.attempt_id, nextLaunchId, canonicalJson(payload), `spawn:${nextLaunchId}`, timestamp],
      );
      stateStore.appendEvent(
        connection, String(current.root_id), "LaunchRetried",
        { previous_launch_id: current.launch_id, launch_id: nextLaunchId, reason: "worker_agent_control_absent" },
        Number(current.task_id), Number(current.attempt_id),
      );
    });
    if (nextLaunchId === null) return false;
    this.executionRecord = stateStore.getLaunch(nextLaunchId)!;
    return true;
  }

  spawn(request: SpawnRequest): SpawnResult {
    if (!(request instanceof SpawnRequest)) throw new TypeError("ACP spawn requires SpawnRequest");
    const launchId = integer(request.metadata.launch_id);
    if (!launchId) throw new RuntimeError("ACP spawn requires an integer launch_id");
    let record = this.record(launchId);
    let ping = this.ping(record);
    if (record.ready_at !== null && (ping || record.status === "closed")) return this.spawnResult(record);
    if (record.status === "closed") throw new RuntimeError(String(record.exit_reason || "ACP Worker closed before ready"));
    const workerAlive = pidAlive(record.worker_pid);
    const agentAlive = pidAlive(record.agent_pid);
    if (record.owner_nonce && !workerAlive && agentAlive) throw new BackendUnknownError("ACP Worker is absent while its Agent Process is still alive");
    const launchedWorker = !record.owner_nonce;
    if (launchedWorker) this.launchWorker(request, record);
    let timeout = Number(this.config.worker_launch_timeout_seconds || 12);
    if (launchedWorker) timeout = Math.max(timeout, MIN_FRESH_WORKER_LAUNCH_TIMEOUT_SECONDS);
    const deadline = performance.now() + timeout * 1000;
    while (performance.now() < deadline) {
      record = this.record(launchId);
      ping = this.ping(record);
      if (record.ready_at !== null && (ping || record.status === "closed")) return this.spawnResult(record);
      if (new Set(["error", "turn_ended", "closed"]).has(String(record.status))) {
        throw new RuntimeError(String(record.exit_reason || "ACP Worker failed before ready"));
      }
      if (record.owner_nonce && !pidAlive(record.worker_pid) && pidAlive(record.agent_pid)) {
        throw new BackendUnknownError("ACP Worker exited before ready while Agent Process remains alive");
      }
      Bun.sleepSync(30);
    }
    record = this.record(launchId);
    if (this.advanceAbsentLaunch(record)) throw new BackendPendingError("absent ACP Launch was fenced; replacement Launch appended");
    throw new BackendPendingError("ACP Worker is still starting");
  }

  private spawnResult(record: RuntimeRecord): SpawnResult {
    const session = stateStore.getSessionForLaunch(Number(record.launch_id));
    return new SpawnResult(AcpBackend.jobId(record), String(record.session_name), {
      launch_id: record.launch_id,
      worker_pid: record.worker_pid,
      agent_pid: record.agent_pid,
      external_session_id: session?.external_session_id ?? null,
      protocol_version: session?.protocol_version ?? null,
    });
  }

  stop(request: StopRequest): RuntimeRecord {
    if (!(request instanceof StopRequest)) throw new TypeError("ACP stop requires StopRequest");
    let record = this.record();
    executionState.requestStop(Number(record.launch_id));
    record = this.record();
    const endpoint = record.control_endpoint;
    if (typeof endpoint === "string" && existsSync(endpoint)) {
      try { controlRequestSync(endpoint, "stop", { launch_id: record.launch_id, timeout: 8 }, 10); } catch { /* bounded fallback below */ }
    }
    const deadline = performance.now() + 4000;
    while (performance.now() < deadline) {
      record = this.record();
      const endpointExists = typeof record.control_endpoint === "string" && existsSync(record.control_endpoint);
      if (!processGroupAlive(record.worker_pid) && !processGroupAlive(record.agent_pid) && !endpointExists) {
        this.closeRecord(record, "stopped");
        return { stopped: true };
      }
      Bun.sleepSync(50);
    }
    const nonce = typeof record.owner_nonce === "string" ? record.owner_nonce : null;
    const agentClean = terminateProcessGroup(record.agent_pid, { graceSeconds: 0.5, expectedNonce: nonce });
    const workerClean = terminateProcessGroup(record.worker_pid, { graceSeconds: 0.5, expectedNonce: nonce });
    if (typeof record.control_endpoint === "string" && !pidAlive(record.worker_pid)) unlinkMissingOkay(record.control_endpoint);
    const endpointClean = typeof record.control_endpoint !== "string" || !existsSync(record.control_endpoint);
    if (agentClean && workerClean && endpointClean) {
      this.closeRecord(record, "forced_stop");
      return { stopped: true, forced: true };
    }
    throw new BackendUnknownError("ACP stop could not prove Worker/Agent cleanup");
  }

  private closeRecord(record: RuntimeRecord, reason: string): void {
    stateStore.transaction((connection) => {
      const timestamp = stateStore.now();
      connection.execute(
        `UPDATE launches SET status='closed', prompt_state='cancelled',
          exit_reason=COALESCE(exit_reason, ?), closed_at=COALESCE(closed_at, ?), last_event_at=?
         WHERE launch_id=?`,
        [reason, timestamp, timestamp, record.launch_id],
      );
      connection.execute(
        "UPDATE acp_sessions SET status='closed', closed_at=COALESCE(closed_at, ?) WHERE launch_id=? AND status='active'",
        [timestamp, record.launch_id],
      );
    });
  }

  observe(options: { jobId?: string | null; sessionName?: string | null; cwd?: string | null } = {}): ObserveResult {
    const record = this.record();
    if (options.jobId && !new Set([record.backend_ref, AcpBackend.jobId(record)]).has(options.jobId)) {
      return new ObserveResult("unknown", null, "job id does not match Launch");
    }
    const workerAlive = pidAlive(record.worker_pid);
    const agentAlive = pidAlive(record.agent_pid);
    const workerGroupAlive = processGroupAlive(record.worker_pid);
    const agentGroupAlive = processGroupAlive(record.agent_pid);
    const endpointExists = typeof record.control_endpoint === "string" && existsSync(record.control_endpoint);
    const ping = endpointExists ? this.ping(record) : null;
    if (ping && workerAlive) return new ObserveResult("present", ping);
    if (!workerAlive && (agentAlive || agentGroupAlive)) {
      return new ObserveResult("unknown", { agent_pid: record.agent_pid }, "orphan Agent Process is alive without its ACP Worker");
    }
    if (!workerGroupAlive && !agentGroupAlive && !endpointExists) return new ObserveResult("absent");
    return new ObserveResult("unknown", null, "ACP Launch facts are contradictory");
  }

  listSessions(): RuntimeRecord[] {
    if (!this.executionRecord.root_id) return [];
    return stateStore.listLaunches(String(this.executionRecord.root_id))
      .filter((row) => row.backend_id === "acp" && !new Set(["closed", "error", "turn_ended"]).has(String(row.status)))
      .map((row) => ({
        id: AcpBackend.jobId(row), job_id: AcpBackend.jobId(row), launch_id: row.launch_id,
        name: row.session_name, session_name: row.session_name, state: row.status,
        worker_pid: row.worker_pid, agent_pid: row.agent_pid,
      }));
  }

  supportsHooks(): boolean { return false; }
}
