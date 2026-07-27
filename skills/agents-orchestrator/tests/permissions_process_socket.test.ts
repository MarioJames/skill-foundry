import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { decidePermission, selectedOptionAllows } from "../scripts/backends/acp/permissions.ts";
import { configureSession } from "../scripts/backends/acp/session_config.ts";
import { ControlServer, controlRequest, endpointPath } from "../scripts/backends/acp/worker_protocol.ts";
import { pidAlive, processGroupAlive, processHasNonce, terminateProcessGroup } from "../scripts/backends/acp/processes.ts";
import { isolatedRuntime } from "./helpers.ts";

const offered = [
  { optionId: "allow", name: "Allow", kind: "allow_once" },
  { optionId: "deny", name: "Deny", kind: "reject_once" },
];

describe("ACP permission policy", () => {
  test("workspace locations allow only paths inside an authorized root", () => {
    expect(decidePermission({ options: offered, toolCall: { locations: [{ path: "/tmp/work/a" }] } } as any,
      { policy: "allow_in_workspace", cwd: "/tmp/work" }).selectedOptionId).toBe("allow");
    expect(decidePermission({ options: offered, toolCall: { locations: [{ path: "/tmp/out/a" }] } } as any,
      { policy: "allow_in_workspace", cwd: "/tmp/work" }).selectedOptionId).toBe("deny");
    expect(decidePermission({ options: offered, toolCall: { title: "opaque" } } as any,
      { policy: "allow_in_workspace", cwd: "/tmp/work" }).selectedOptionId).toBe("deny");
  });

  test("only exact Bun Runtime commands receive the narrow no-location exception", () => {
    const entry = "/opt/agents-orchestrator/scripts/agent_orchestrator.ts";
    const request = (script: string) => ({
      toolCall: { kind: "execute", rawInput: { cwd: "/tmp/work", command: ["/bin/sh", "-c", script] } }, options: offered,
    });
    expect(decidePermission(request('bun "$AGENT_SWARM_SKILL_DIR/scripts/bootstrap.ts" bootstrap-cwd') as any,
      { policy: "allow_in_workspace", cwd: "/tmp/work", runtimeEntrypoint: entry }).selectedOptionId).toBe("allow");
    expect(decidePermission(request('bun "$AGENT_SWARM_SKILL_DIR/scripts/bootstrap.ts" bootstrap-cwd; touch /tmp/x') as any,
      { policy: "allow_in_workspace", cwd: "/tmp/work", runtimeEntrypoint: entry }).selectedOptionId).toBe("deny");
  });

  test("opaque option IDs are classified by offered option kind", () => {
    expect(selectedOptionAllows({ options: offered }, "allow")).toBe(true);
    expect(selectedOptionAllows({ options: offered }, "deny")).toBe(false);
    expect(decidePermission({ options: offered } as any, { policy: "allow_all", cwd: "/tmp" }).allowed).toBe(true);
    expect(decidePermission({ options: offered } as any, { policy: "deny_all", cwd: "/tmp" }).allowed).toBe(false);
  });

  test("session configuration selects only advertised safe model/mode", async () => {
    const calls: unknown[] = [];
    const client = { request: async (_method: string, params: unknown) => { calls.push(params); return { configOptions: [] }; } } as any;
    const result = await configureSession(client, "s", [
      { id: "model", category: "model", currentValue: "default", options: [{ value: "default" }, { value: "sonnet" }] },
      { id: "mode", category: "mode", currentValue: "bypassPermissions", options: [{ value: "default" }, { value: "bypassPermissions" }] },
    ], { model: "sonnet", permissionPolicy: "allow_in_workspace" });
    expect(result).toEqual({ model: "sonnet", mode: "default" });
    expect(calls).toHaveLength(2);
    await expect(configureSession(client, "s", [
      { id: "model", category: "model", currentValue: "safe", options: [{ value: "safe" }] },
    ], { model: "unknown", permissionPolicy: "deny_all" })).rejects.toThrow("not offered");
  });
});

describe("private control sockets and process groups", () => {
  test("long identities hash to a private socket and request round-trips", async () => isolatedRuntime(async ({ runtimeHome }) => {
    const endpoint = endpointPath(join(runtimeHome, `nested-${"x".repeat(90)}`), `root_${"r".repeat(64)}`, 12);
    expect(Buffer.byteLength(endpoint)).toBeLessThanOrEqual(100);
    expect(statSync(join(endpoint, "..")).mode & 0o777).toBe(0o700);
    const server = new ControlServer(endpoint, (request) => ({ ok: true, command: request.command }));
    await server.start();
    expect((await controlRequest(endpoint, "ping")).command).toBe("ping");
    await server.close();
    expect(existsSync(endpoint)).toBe(false);
  }));

  test("nonce fencing and trusted cleanup kill an isolated process group", () => {
    const nonce = `nonce-${Date.now()}`;
    const child = Bun.spawn({ cmd: [process.execPath, "-e", "setInterval(()=>{},1000)"],
      env: { ...process.env, AGENT_SWARM_EXECUTION_NONCE: nonce }, stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
    try {
      expect(pidAlive(child.pid)).toBe(true);
      expect(processGroupAlive(child.pid)).toBe(true);
      expect(processHasNonce(child.pid, nonce)).toBe(true);
      expect(terminateProcessGroup(child.pid, { graceSeconds: 0.2, expectedNonce: "wrong" })).toBe(false);
      expect(terminateProcessGroup(child.pid, { graceSeconds: 0.5, trusted: true })).toBe(true);
      expect(processGroupAlive(child.pid)).toBe(false);
    } finally { if (processGroupAlive(child.pid)) terminateProcessGroup(child.pid, { trusted: true }); }
  });
});
