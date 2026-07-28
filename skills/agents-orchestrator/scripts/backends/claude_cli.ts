import { accessSync, constants as fsConstants, realpathSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

import { AgentBackend, ObserveResult, SpawnRequest, SpawnResult, StopRequest } from "./base.ts";
import { isRecord, RuntimeError, type RuntimeRecord, ValueError } from "../runtime_types.ts";

const JOB_RE = /backgrounded\s*[·:]\s*(\S+)/iu;
const ATTACH_RE = /claude\s+attach\s+(\S+)/u;
const TERMINAL_STATES = new Set(["done", "completed", "exited", "failed", "stopped", "error", "cancelled"]);

function executable(path: string): boolean {
  try {
    statSync(path);
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function claudeBin(environment: Record<string, string | undefined> = process.env): string {
  const override = (environment.AGENTS_ORCHESTRATOR_CLAUDE_BIN ?? "").trim();
  if (override) return override;
  for (const entry of (environment.PATH ?? "").split(delimiter)) {
    if (!entry) continue;
    const candidate = join(entry, "claude");
    if (executable(candidate) && !candidate.split(/[\\/]/u).includes(".superconductor")) return candidate;
  }
  return "claude";
}

function timeout(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  const value = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(value) ? Math.max(1, value) : fallback;
}

function jobId(output: string): string | null {
  return JOB_RE.exec(output)?.[1] ?? ATTACH_RE.exec(output)?.[1] ?? null;
}

function run(command: string[], options: { cwd?: string; env?: Record<string, string>; timeout: number }): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  const result = Bun.spawnSync(command, {
    cwd: options.cwd,
    env: options.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: options.timeout * 1_000,
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString("utf8"),
    stderr: result.stderr.toString("utf8"),
  };
}

export class ClaudeCliBackend extends AgentBackend {
  readonly backendId = "claude_cli";
  readonly config: RuntimeRecord;

  constructor(config: RuntimeRecord = {}) {
    super();
    this.config = { ...config };
  }

  private command(): string {
    return typeof this.config.command === "string" && this.config.command ? this.config.command : claudeBin();
  }

  spawn(request: SpawnRequest): SpawnResult {
    if (!(request instanceof SpawnRequest)) throw new TypeError("spawn requires SpawnRequest");
    const command = [
      this.command(),
      "--bg",
      "--name",
      request.sessionName,
      "--permission-mode",
      "bypassPermissions",
    ];
    if (request.model) command.push("--model", request.model);
    command.push(request.prompt);
    const completed = run(command, {
      cwd: request.cwd,
      env: { ...process.env, ...request.env } as Record<string, string>,
      timeout: timeout("AGENTS_ORCHESTRATOR_BG_LAUNCH_TIMEOUT_SECONDS", 90),
    });
    const identifier = jobId(`${completed.stdout}\n${completed.stderr}`);
    if (!identifier) {
      throw new RuntimeError(
        completed.exitCode === 124
          ? "claude --bg timed out without a job id"
          : `claude --bg failed without a job id (exit=${completed.exitCode})`,
      );
    }
    return new SpawnResult(identifier, request.sessionName);
  }

  stop(request: StopRequest): RuntimeRecord {
    if (!(request instanceof StopRequest)) throw new TypeError("stop requires StopRequest");
    let identifier = request.jobId;
    if (!identifier && request.sessionName) {
      const matching = this.listSessions({ cwd: request.cwd }).filter((session) => {
        const name = session.name ?? session.session_name;
        const state = session.state ?? session.status;
        return name === request.sessionName && !TERMINAL_STATES.has(state);
      });
      if (matching.length > 1) throw new RuntimeError(`multiple live Claude sessions match ${request.sessionName}`);
      if (matching.length === 1) {
        identifier = matching[0]!.job_id ?? matching[0]!.id ?? null;
        if (!identifier) throw new RuntimeError(`live Claude session ${request.sessionName} has no stoppable job id`);
      }
    }
    if (!identifier) return { stopped: true, not_required: true };
    const completed = run([this.command(), "stop", identifier], {
      timeout: timeout("AGENTS_ORCHESTRATOR_AGENT_CONTROL_TIMEOUT_SECONDS", 10),
    });
    if (completed.exitCode !== 0) throw new RuntimeError("claude stop failed");
    return { stopped: true };
  }

  observe(options: { jobId?: string | null; sessionName?: string | null; cwd?: string | null }): ObserveResult {
    if (!options.jobId && !options.sessionName) return new ObserveResult("unknown", null, "session identity is missing");
    let sessions: RuntimeRecord[];
    try {
      sessions = this.listSessions({ cwd: options.cwd });
    } catch {
      return new ObserveResult("unknown", null, "session observation failed");
    }
    const matching = sessions.filter((session) =>
      (options.jobId && (session.job_id ?? session.id) === options.jobId) ||
      (options.sessionName && (session.name ?? session.session_name) === options.sessionName));
    if (matching.length === 0) return new ObserveResult("absent");
    const present = matching.find((session) => !TERMINAL_STATES.has(session.state ?? session.status));
    return present ? new ObserveResult("present", present) : new ObserveResult("absent", matching.at(-1)!);
  }

  listSessions(options: { cwd?: string | null } = {}): RuntimeRecord[] {
    const completed = run([this.command(), "agents", "--json"], {
      timeout: timeout("AGENTS_ORCHESTRATOR_AGENT_CONTROL_TIMEOUT_SECONDS", 10),
    });
    if (completed.exitCode !== 0) throw new RuntimeError("claude agents failed");
    let value: unknown;
    try {
      value = JSON.parse(completed.stdout || "[]") as unknown;
    } catch {
      throw new RuntimeError("claude agents returned invalid JSON");
    }
    if (!Array.isArray(value) || !value.every(isRecord)) throw new RuntimeError("claude agents returned a non-array result");
    if (!options.cwd) return value;
    const expected = realpathSync(options.cwd);
    return value.filter((item) => {
      try {
        return typeof item.cwd === "string" && realpathSync(item.cwd) === expected;
      } catch {
        return false;
      }
    });
  }

  supportsHooks(): boolean {
    return true;
  }
}
