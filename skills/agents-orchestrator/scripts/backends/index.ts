import { AcpBackend } from "./acp/adapter.ts";
import { ClaudeCliBackend } from "./claude_cli.ts";
import { isRecord, type RuntimeRecord, ValueError } from "../runtime_types.ts";
import type { AgentBackend } from "./base.ts";

function config(record: RuntimeRecord): RuntimeRecord {
  const raw = record.config_json;
  if (!raw) return {};
  if (typeof raw !== "string") throw new ValueError("execution config_json is invalid");
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) throw new Error();
    return value;
  } catch {
    throw new ValueError("execution config_json is invalid");
  }
}

export function resolveExecutionBackend(executionRecord: RuntimeRecord | null): AgentBackend {
  if (!executionRecord) throw new ValueError("execution record is required");
  if (executionRecord.backend_id === "claude_cli") return new ClaudeCliBackend(config(executionRecord));
  if (executionRecord.backend_id === "acp") return new AcpBackend(config(executionRecord), executionRecord);
  throw new ValueError(`unsupported execution backend: ${executionRecord.backend_id}`);
}

export const resolveSpawnBackend = resolveExecutionBackend;
