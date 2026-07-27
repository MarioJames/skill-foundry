import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

import * as stateStore from "./state_store.ts";
import { type RuntimeRecord } from "./runtime_types.ts";
import { createAcpClient } from "./backends/acp/client.ts";
import { terminateProcessGroup } from "./backends/acp/processes.ts";
import { ensureAvailable, ensureSdkAvailable } from "./backends/acp/registry.ts";

export function findRecords(agentType: string, externalSessionId: string, rootId?: string): RuntimeRecord[] {
  stateStore.initializeSchema();
  return stateStore.findSession(agentType, externalSessionId, rootId);
}

function unavailable(record: RuntimeRecord | null, reason: string, message: string): RuntimeRecord {
  return {
    available: false, reason, message,
    agent_type: record?.agent_type ?? null,
    session_id: record?.external_session_id ?? null,
    root_id: record?.root_id ?? null,
  };
}

function delay(milliseconds: number): Promise<void> { return Bun.sleep(milliseconds); }
async function timeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return Promise.race([
    promise,
    delay(milliseconds).then(() => { throw new Error("timeout"); }),
  ]);
}

async function load(record: RuntimeRecord): Promise<RuntimeRecord> {
  ensureSdkAvailable();
  const config = JSON.parse(String(record.profile_config_json || "{}")) as RuntimeRecord;
  const command = ensureAvailable(config);
  let child: ChildProcess | null = null;
  let connection: acp.ClientConnection | null = null;
  const updates: RuntimeRecord[] = [];
  try {
    child = spawn(command, Array.isArray(config.args) ? config.args.map(String) : [], {
      cwd: String(record.cwd), stdio: ["pipe", "pipe", "ignore"], detached: true,
    });
    if (!child.stdin || !child.stdout) throw new Error("streams unavailable");
    const app = createAcpClient(
      () => ({ selectedOptionId: null, allowed: false }),
      (notification) => { updates.push({ session_id: notification.sessionId, update: notification.update }); },
    );
    connection = app.connect(acp.ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    ));
    const context = connection.agent;
    const initialized = await timeout(context.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "agents-orchestrator-history", title: "Agents Orchestrator History Viewer", version: "1" },
    }), 30_000);
    if (!initialized.agentCapabilities?.loadSession) {
      return unavailable(record, "load_unsupported", "该 ACP Agent 不支持 session/load，无法恢复对话历史。");
    }
    let loaded: acp.LoadSessionResponse;
    try {
      loaded = await timeout(context.request(acp.methods.agent.session.load, {
        cwd: String(record.cwd), sessionId: String(record.external_session_id), mcpServers: [],
      }), 60_000);
    } catch (error) {
      if (error instanceof acp.RequestError) return {
        ...unavailable(record, "session_missing", "ACP 会话不可用或已丢失，无法恢复对话历史。"),
        error_code: error.code,
      };
      throw error;
    }
    return {
      available: true, agent_type: record.agent_type, session_id: record.external_session_id,
      root_id: record.root_id, task_id: record.task_id, attempt_id: record.attempt_id,
      launch_id: record.launch_id, load_response: loaded ?? {}, history: updates,
    };
  } catch (error) {
    return {
      ...unavailable(record, "agent_unavailable", "无法启动对应的 ACP Agent 或加载会话，历史暂不可用。"),
      error_type: error instanceof Error ? error.name : "Error",
    };
  } finally {
    connection?.close();
    if (child?.pid) terminateProcessGroup(child.pid, { graceSeconds: 2, trusted: true });
    child?.stdin?.destroy();
  }
}

export async function loadHistory(
  agentType: string,
  externalSessionId: string,
  rootId?: string,
): Promise<RuntimeRecord> {
  const records = findRecords(agentType, externalSessionId, rootId);
  if (!records.length) return unavailable(
    { agent_type: agentType, external_session_id: externalSessionId, root_id: rootId ?? null },
    "not_recorded", "没有找到匹配的 ACP 会话记录。",
  );
  if (records.length !== 1) return {
    available: false, reason: "ambiguous", message: "匹配到多个 ACP profile，请同时指定 root_id。",
    agent_type: agentType, session_id: externalSessionId,
    matches: records.map((item) => ({ root_id: item.root_id, profile_id: item.profile_id, state_namespace: item.state_namespace })),
  };
  return load(records[0]!);
}
