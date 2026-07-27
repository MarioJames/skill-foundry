import { RuntimeError, type RuntimeRecord } from "../runtime_types.ts";

export class SpawnRequest {
  constructor(
    readonly prompt: string,
    readonly cwd: string,
    readonly sessionName: string,
    readonly model: string | null = null,
    readonly env: Record<string, string> = {},
    readonly backendConfig: RuntimeRecord = {},
    readonly metadata: Record<string, string> = {},
  ) {}
}

export class SpawnResult {
  constructor(
    readonly jobId: string,
    readonly sessionName: string,
    readonly extras: RuntimeRecord = {},
  ) {}
}

export class ObserveResult {
  constructor(
    readonly presence: "present" | "absent" | "unknown",
    readonly session: RuntimeRecord | null = null,
    readonly error: string | null = null,
  ) {}
}

export class StopRequest {
  constructor(
    readonly jobId: string | null = null,
    readonly sessionName: string | null = null,
    readonly cwd: string | null = null,
    readonly reason: string | null = null,
  ) {}
}

export abstract class AgentBackend {
  abstract readonly backendId: string;
  abstract spawn(request: SpawnRequest): SpawnResult | RuntimeRecord;
  abstract stop(request: StopRequest): RuntimeRecord;
  abstract observe(options: { jobId?: string | null; sessionName?: string | null; cwd?: string | null }): ObserveResult;
  abstract listSessions(options?: { cwd?: string | null }): RuntimeRecord[];
  abstract supportsHooks(): boolean;

  sessionAlive(options: { jobId?: string | null; sessionName?: string | null; cwd?: string | null }): boolean {
    return this.observe(options).presence === "present";
  }
}

export class BackendPendingError extends RuntimeError {
  override name = "BackendPendingError";
}

export class BackendUnknownError extends RuntimeError {
  override name = "BackendUnknownError";
}
