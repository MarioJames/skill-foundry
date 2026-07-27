import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { initializeRun } from "../scripts/agent_orchestrator.ts";
import * as executionSecrets from "../scripts/execution_secrets.ts";
import * as outbox from "../scripts/outbox.ts";
import * as recovery from "../scripts/recovery.ts";
import * as scheduler from "../scripts/scheduler.ts";
import * as sessionHistory from "../scripts/session_history.ts";
import * as stateStore from "../scripts/state_store.ts";
import { pidAlive } from "../scripts/backends/acp/processes.ts";
import { FAKE_AGENT, insertReadyChild, isolatedRuntime, waitFor } from "./helpers.ts";
import type { RuntimeRecord } from "../scripts/runtime_types.ts";

function createChild(cwd: string, scenario: string): { identity: RuntimeRecord; child: RuntimeRecord } {
  const identity = initializeRun("root", cwd, {
    backend: "acp", acpAgent: "custom", acpCommand: process.execPath,
    acpArgs: [FAKE_AGENT, "--scenario", scenario], acpPermissionPolicy: "allow_in_workspace",
    maxAttemptsPerTask: 2, requireFinalReview: false,
  });
  stateStore.transaction((connection) => insertReadyChild(connection, stateStore.getRun(identity.root_id, connection)!));
  return { identity, child: scheduler.schedule(identity.root_id)[0]! };
}

function stopQuietly(identity: RuntimeRecord): void {
  const run = stateStore.getRun(identity.root_id);
  if (run && !new Set(["done", "cancelled"]).has(run.status)) {
    try { recovery.stopRun(identity.root_id, identity.actor_token); } catch { /* fixture cleanup */ }
  }
}

function allFileBytes(root: string): Buffer {
  const chunks: Buffer[] = [];
  const pending = [root];
  while (pending.length) {
    const current = pending.pop()!;
    if (!existsSync(current)) continue;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) chunks.push(readFileSync(path));
    }
  }
  return Buffer.concat(chunks);
}

describe("detached ACP Worker", () => {
  test("fake handshake persists the real session ID and closes after finish", async () => isolatedRuntime(({ runtimeHome, cwd }) => {
    const { identity, child } = createChild(cwd, "finish");
    try {
      const token = executionSecrets.deriveAttemptToken(stateStore.getRun(identity.root_id)!, child.attempt_id);
      expect(outbox.drain(identity.root_id).completed).toBe(1);
      waitFor(() => stateStore.getTask(child.task_id)?.status === "done" ? true : false, 12);
      const launch = waitFor(() => {
        const item = stateStore.getLaunch(child.launch_id);
        return item?.status === "closed" ? item : null;
      }, 12);
      const session = stateStore.getSessionForLaunch(child.launch_id)!;
      expect(String(session.external_session_id).startsWith("fake-session-")).toBe(true);
      expect(session.status).toBe("closed");
      expect(stateStore.getAttempt(child.attempt_id)!.state).toBe("done");
      expect(existsSync(launch.control_endpoint)).toBe(false);
      expect(allFileBytes(runtimeHome).includes(Buffer.from(token))).toBe(false);
    } finally { stopQuietly(identity); }
  }));

  test("permission callback is audited without persisting raw Agent errors", async () => isolatedRuntime(({ cwd }) => {
    const { identity, child } = createChild(cwd, "permission");
    try {
      outbox.drain(identity.root_id);
      waitFor(() => stateStore.getLaunch(child.launch_id)?.status === "closed", 12);
      const event = stateStore.listEvents(identity.root_id).find((item) => item.type === "AcpPermissionDecision");
      expect(event).toBeDefined();
      expect(JSON.parse(event!.payload_json)).toEqual({ allowed: true, selected: "allow-once" });
    } finally { stopQuietly(identity); }
  }));

  test("stop proves Worker, Agent, and socket cleanup", async () => isolatedRuntime(({ cwd }) => {
    const { identity, child } = createChild(cwd, "hold");
    outbox.drain(identity.root_id);
    const running = stateStore.getLaunch(child.launch_id)!;
    expect(pidAlive(running.worker_pid)).toBe(true);
    expect(pidAlive(running.agent_pid)).toBe(true);
    const result = recovery.stopRun(identity.root_id, identity.actor_token);
    expect(result.status).toBe("cancelled");
    expect(pidAlive(running.worker_pid)).toBe(false);
    expect(pidAlive(running.agent_pid)).toBe(false);
    expect(existsSync(running.control_endpoint)).toBe(false);
  }));

  test("Agent crash becomes a retryable failure with no process residue", async () => isolatedRuntime(({ cwd }) => {
    const { identity, child } = createChild(cwd, "crash");
    try {
      outbox.drain(identity.root_id);
      const launch = waitFor(() => {
        const item = stateStore.getLaunch(child.launch_id);
        return item?.status === "closed" ? item : null;
      }, 12);
      recovery.reapChildren(identity.root_id, identity.actor_token);
      expect(stateStore.getAttempt(child.attempt_id)!.state).toBe("failed");
      expect(pidAlive(launch.worker_pid)).toBe(false);
      expect(pidAlive(launch.agent_pid)).toBe(false);
    } finally { stopQuietly(identity); }
  }));

  test("raw Agent exception text is redacted from database and logs", async () => isolatedRuntime(({ runtimeHome, cwd }) => {
    const { identity, child } = createChild(cwd, "raw-error");
    try {
      outbox.drain(identity.root_id);
      waitFor(() => stateStore.getLaunch(child.launch_id)?.status === "closed", 12);
      const launch = stateStore.getLaunch(child.launch_id)!;
      expect(String(launch.exit_reason).startsWith("acp_error:")).toBe(true);
      expect(allFileBytes(runtimeHome).includes(Buffer.from("AGENT_RAW_SECRET_SENTINEL"))).toBe(false);
      expect(JSON.stringify(stateStore.listEvents(identity.root_id))).not.toContain("AGENT_RAW_SECRET_SENTINEL");
    } finally { stopQuietly(identity); }
  }));
});

describe("transient session history", () => {
  test("session/load returns updates and missing sessions are unavailable", async () => isolatedRuntime(async ({ cwd }) => {
    const { identity, child } = createChild(cwd, "history");
    try {
      outbox.drain(identity.root_id);
      waitFor(() => stateStore.getLaunch(child.launch_id)?.status === "closed", 12);
      const session = stateStore.getSessionForLaunch(child.launch_id)!;
      const loaded = await sessionHistory.loadHistory("custom", session.external_session_id, identity.root_id);
      expect(loaded.available).toBe(true);
      expect(JSON.stringify(loaded.history)).toContain("remembered user message");
      stateStore.execute("UPDATE acp_sessions SET external_session_id='missing-session' WHERE launch_id=?", [child.launch_id]);
      const missing = await sessionHistory.loadHistory("custom", "missing-session", identity.root_id);
      expect(missing.available).toBe(false);
      expect(missing.reason).toBe("session_missing");
    } finally { stopQuietly(identity); }
  }));
});
