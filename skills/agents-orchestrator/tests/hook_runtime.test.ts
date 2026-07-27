import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { initializeRun } from "../scripts/agent_orchestrator.ts";
import * as compatEnv from "../scripts/compat_env.ts";
import { handleHookEvent } from "../scripts/hook_runtime.ts";
import * as recovery from "../scripts/recovery.ts";
import * as stateStore from "../scripts/state_store.ts";
import { isolatedRuntime } from "./helpers.ts";

function identityEnvironment(identity: Record<string, unknown>): Record<string, string | undefined> {
  return compatEnv.exportBoth({
    ROOT_ID: identity.root_id,
    TASK_ID: identity.task_id,
    ATTEMPT_ID: identity.attempt_id,
    ACTOR_TOKEN: identity.actor_token,
  });
}

describe("single TypeScript Hook runtime", () => {
  test("wrong events and missing identity are skipped without state mutation", async () => isolatedRuntime(() => {
    expect(handleHookEvent("heartbeat", { hook_event_name: "Stop" })).toEqual({
      skipped: true, reason: "not SessionStart or PostToolUse",
    });
    expect(handleHookEvent("heartbeat", { hook_event_name: "SessionStart" })).toEqual({
      skipped: true, reason: "missing orchestration identity",
    });
  }));

  test("partial or conflicting identity fails closed", async () => isolatedRuntime(() => {
    process.env.AGENTS_ORCHESTRATOR_ROOT_ID = "root";
    expect(() => handleHookEvent("failure", { hook_event_name: "PostToolUseFailure" })).toThrow("partial orchestration identity");
    delete process.env.AGENTS_ORCHESTRATOR_ROOT_ID;
    Object.assign(process.env, compatEnv.exportBoth({ ROOT_ID: "root", TASK_ID: 1, ATTEMPT_ID: 1, ACTOR_TOKEN: "token" }));
    process.env.AGENTS_ORCHESTRATOR_HOME = "/tmp/a";
    process.env.AGENT_SWARM_HOME = "/tmp/b";
    expect(() => handleHookEvent("heartbeat", { hook_event_name: "SessionStart" })).toThrow("conflicting orchestration environment");
  }));

  test("heartbeat, failure context, finish gate, and SessionEnd share one identity validator", async () => isolatedRuntime(({ cwd }) => {
    const identity = initializeRun("hooks", cwd, { backend: "claude_cli", requireFinalReview: false });
    Object.assign(process.env, identityEnvironment(identity));
    const heartbeat = handleHookEvent("heartbeat", { hook_event_name: "SessionStart" });
    expect(heartbeat.accepted).toBe(true);
    const failure = handleHookEvent("failure", { hook_event_name: "PostToolUseFailure" });
    expect(failure.hookSpecificOutput.hookEventName).toBe("PostToolUseFailure");
    expect(handleHookEvent("finish", { hook_event_name: "Stop" }).decision).toBe("block");
    expect(handleHookEvent("finish", { hook_event_name: "Stop", stop_hook_active: true })).toEqual({});
    const ended = handleHookEvent("clean", { hook_event_name: "SessionEnd" });
    expect(ended.observed).toBe(true);
    expect(stateStore.listEvents(String(identity.root_id)).some((item) => item.type === "SessionEndObserved")).toBe(true);
    recovery.stopRun(String(identity.root_id), String(identity.actor_token));
    expect(handleHookEvent("finish", { hook_event_name: "Stop" })).toEqual({});
  }));

  test("shell files contain transport only and forward stdin to hook_runtime.ts", async () => isolatedRuntime(({ runtimeHome, cwd }) => {
    const identity = initializeRun("wrapper", cwd, { backend: "claude_cli", requireFinalReview: false });
    const wrapper = join(runtimeHome, "hooks", "failure_context.sh");
    expect(existsSync(wrapper)).toBe(true);
    const source = readFileSync(wrapper, "utf8");
    expect(source.split("\n").filter(Boolean).length).toBeLessThanOrEqual(4);
    expect(source).toContain("hook_runtime.ts");
    const result = Bun.spawnSync({
      cmd: ["bash", wrapper], cwd,
      env: { ...process.env, ...identityEnvironment(identity) },
      stdin: Buffer.from(JSON.stringify({ hook_event_name: "PostToolUseFailure" })),
      stdout: "pipe", stderr: "pipe", timeout: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString()).hookSpecificOutput.hookEventName).toBe("PostToolUseFailure");
    recovery.stopRun(String(identity.root_id), String(identity.actor_token));
  }));
});
