import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import * as compatEnv from "../scripts/compat_env.ts";
import * as executionConfig from "../scripts/execution_config.ts";
import * as registry from "../scripts/backends/acp/registry.ts";
import * as stateStore from "../scripts/state_store.ts";
import { initializeRun } from "../scripts/agent_orchestrator.ts";
import { isolatedRuntime } from "./helpers.ts";

describe("environment compatibility", () => {
  test("canonical and legacy names resolve identically and conflicts fail closed", () => {
    expect(compatEnv.value("ROOT_ID", { AGENTS_ORCHESTRATOR_ROOT_ID: "root" })).toBe("root");
    expect(compatEnv.value("ROOT_ID", { AGENT_SWARM_ROOT_ID: "root" })).toBe("root");
    expect(() => compatEnv.value("ROOT_ID", {
      AGENTS_ORCHESTRATOR_ROOT_ID: "a", AGENT_SWARM_ROOT_ID: "b",
    })).toThrow("conflicting orchestration environment");
  });

  test("partial identity is rejected and exportBoth scrubs parent identity", () => {
    expect(() => compatEnv.validateIdentity({ AGENT_SWARM_ROOT_ID: "root" })).toThrow("partial orchestration identity");
    const exported = compatEnv.exportBoth({ ROOT_ID: "child", TASK_ID: 2 }, {
      base: { AGENTS_ORCHESTRATOR_ROOT_ID: "parent", AGENT_SWARM_ACTOR_TOKEN: "secret" }, scrubIdentity: true,
    });
    expect(exported.AGENTS_ORCHESTRATOR_ROOT_ID).toBe("child");
    expect(exported.AGENT_SWARM_ROOT_ID).toBe("child");
    expect(exported.AGENT_SWARM_ACTOR_TOKEN).toBeUndefined();
  });
});

describe("schema and profile registry", () => {
  test("schema migrations 1..3 initialize at the legacy-compatible location", async () => isolatedRuntime(({ runtimeHome }) => {
    stateStore.initializeSchema();
    expect(stateStore.dbPath()).toBe(join(runtimeHome, "runtime.sqlite3"));
    expect(stateStore.fetchall("SELECT version FROM schema_migrations ORDER BY version").map((row) => row.version)).toEqual([1, 2, 3]);
    expect(stateStore.fetchall("PRAGMA table_info(launches)").some((row) => row.name === "owner_nonce")).toBe(true);
  }));

  test("default execution is ACP Codex and Claude is installed but not selected", async () => isolatedRuntime(({ cwd }) => {
    const execution = executionConfig.resolveRunExecution({ installDependencies: true });
    expect(execution.backend).toBe("acp");
    expect(execution.default_profile).toBe("codex");
    expect(execution.profile_allowlist).toEqual(["codex"]);
    expect(execution.acp.agent).toBe("codex");
    expect(registry.installDefaultProfiles().claude!.agent).toBe("claude");
    const identity = initializeRun("default profile", cwd);
    const run = stateStore.getRun(identity.root_id)!;
    expect(JSON.parse(run.execution_config_json).default_profile).toBe("codex");
  }));

  test("custom command remains exact and is never replaced by managed install", async () => isolatedRuntime(() => {
    const custom = registry.resolveProfile("custom", { command: "/bin/true", args: ["--flag"] });
    const installed = registry.installProfile(custom);
    const frozen = registry.freezeProfile(installed);
    expect(frozen.command).toBe("/bin/true");
    expect(frozen.resolved_command).toBe("/bin/true");
    expect(frozen.managed_install).toEqual({});
  }));

  test("managed package version tampering is rejected", async () => isolatedRuntime(() => {
    const path = join(registry.managedRoot(), "node_modules", "@agentclientprotocol", "sdk", "package.json");
    const original = readFileSync(path, "utf8");
    try {
      const metadata = JSON.parse(original);
      metadata.version = "0.0.0";
      writeFileSync(path, JSON.stringify(metadata));
      expect(() => registry.ensureSdkAvailable()).toThrow("managed ACP SDK 1.3.0 is unavailable");
    } finally { writeFileSync(path, original); chmodSync(path, 0o644); }
  }));

  test("unsupported profiles and prompt permission fail closed", async () => isolatedRuntime(() => {
    expect(() => registry.resolveProfile("unknown")).toThrow("unsupported ACP agent profile");
    expect(() => executionConfig.resolveRunExecution({
      acpAgent: "custom", acpCommand: "/bin/true", acpPermissionPolicy: "prompt", installDependencies: true,
    })).toThrow("prompt");
  }));
});
