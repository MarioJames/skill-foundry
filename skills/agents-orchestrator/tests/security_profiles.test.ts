import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import * as actionProcessor from "../scripts/action_processor.ts";
import { initializeRun, entryMode } from "../scripts/agent_orchestrator.ts";
import * as executionConfig from "../scripts/execution_config.ts";
import * as executionSecrets from "../scripts/execution_secrets.ts";
import * as executionState from "../scripts/execution_state.ts";
import * as modelPolicy from "../scripts/model_policy.ts";
import * as promptBuilder from "../scripts/prompt_builder.ts";
import * as recovery from "../scripts/recovery.ts";
import * as scheduler from "../scripts/scheduler.ts";
import * as stateStore from "../scripts/state_store.ts";
import * as registry from "../scripts/backends/acp/registry.ts";
import { insertReadyChild, isolatedRuntime } from "./helpers.ts";
import type { RuntimeRecord } from "../scripts/runtime_types.ts";

function envelope(identity: RuntimeRecord, type: string, payload: RuntimeRecord, actionId: string): RuntimeRecord {
  return {
    schema_version: 1, action_id: actionId, root_id: identity.root_id,
    task_id: identity.task_id, attempt_id: identity.attempt_id,
    actor_token: identity.actor_token, type, payload,
  };
}

function estimate(identity: RuntimeRecord, strategy = "direct"): RuntimeRecord {
  return actionProcessor.processAction(envelope(identity, "submit_estimate", {
    revision: false, strategy, resolved_intent: "implement", complexity: "medium",
    concerns: [], unknowns: [], estimated_files: [], reason: "contract",
  }, "estimate"));
}

function createChild(identity: RuntimeRecord): RuntimeRecord {
  stateStore.transaction((connection) => insertReadyChild(connection, stateStore.getRun(String(identity.root_id), connection)!));
  return scheduler.schedule(String(identity.root_id))[0]!;
}

describe("secret material and launch fencing", () => {
  test("Run seed is 0600 and Attempt tokens are deterministic and distinct", async () => isolatedRuntime(({ cwd }) => {
    const identity = initializeRun("root", cwd, { backend: "claude_cli" });
    const child = createChild(identity);
    const run = stateStore.getRun(String(identity.root_id))!;
    const first = executionSecrets.deriveAttemptToken(run, Number(child.attempt_id));
    expect(executionSecrets.deriveAttemptToken(run, Number(child.attempt_id))).toBe(first);
    expect(executionSecrets.deriveAttemptToken(run, Number(identity.attempt_id))).not.toBe(first);
    expect(statSync(executionSecrets.resolveSeedPath(run.token_seed_ref)).mode & 0o777).toBe(0o600);
    expect(stateStore.tokenMatches(first, stateStore.getAttempt(Number(child.attempt_id))!.actor_token_hash)).toBe(true);
  }));

  test("plaintext child token is absent from prompt, effects, events, and SQLite bytes", async () => isolatedRuntime(({ cwd }) => {
    const identity = initializeRun("root", cwd, { backend: "claude_cli" });
    const child = createChild(identity);
    const run = stateStore.getRun(String(identity.root_id))!;
    const token = executionSecrets.deriveAttemptToken(run, Number(child.attempt_id));
    const prompt = promptBuilder.buildPrompt(run, stateStore.getTask(Number(child.task_id))!, stateStore.getAttempt(Number(child.attempt_id))!);
    expect(prompt).not.toContain(token);
    expect(JSON.stringify(stateStore.listEffects(String(identity.root_id)))).not.toContain(token);
    expect(JSON.stringify(stateStore.listEvents(String(identity.root_id)))).not.toContain(token);
    expect(readFileSync(stateStore.dbPath()).includes(Buffer.from(token))).toBe(false);
  }));

  test("seed cleanup waits for closed Launches and terminal stop removes it", async () => {
    await isolatedRuntime(({ cwd }) => {
      const identity = initializeRun("with child", cwd, { backend: "claude_cli" });
      const child = createChild(identity);
      const path = executionSecrets.resolveSeedPath(stateStore.getRun(String(identity.root_id))!.token_seed_ref);
      stateStore.transaction((connection) => {
        connection.execute("UPDATE runs SET status='cancelled' WHERE root_id=?", [identity.root_id]);
        connection.execute("UPDATE effects SET status='completed' WHERE root_id=?", [identity.root_id]);
      });
      expect(executionSecrets.cleanupRunSeedIfSafe(String(identity.root_id))).toBe(false);
      expect(existsSync(path)).toBe(true);
      stateStore.execute("UPDATE launches SET status='closed', closed_at=? WHERE launch_id=?", [stateStore.now(), child.launch_id]);
      expect(executionSecrets.cleanupRunSeedIfSafe(String(identity.root_id))).toBe(true);
      expect(existsSync(path)).toBe(false);
    });
    await isolatedRuntime(({ cwd }) => {
      const identity = initializeRun("root only", cwd, { backend: "claude_cli" });
      const path = executionSecrets.resolveSeedPath(stateStore.getRun(String(identity.root_id))!.token_seed_ref);
      expect(recovery.stopRun(String(identity.root_id), String(identity.actor_token)).status).toBe("cancelled");
      expect(existsSync(path)).toBe(false);
    });
  });

  test("Launch ownership CAS and stop fence admit exactly one Worker", async () => isolatedRuntime(({ cwd }) => {
    const identity = initializeRun("root", cwd, { backend: "claude_cli" });
    const child = createChild(identity);
    expect(stateStore.claimLaunchOwnership(Number(child.launch_id), "first", 1234)).toBe(true);
    expect(stateStore.claimLaunchOwnership(Number(child.launch_id), "second", 5678)).toBe(false);
    expect(stateStore.getLaunch(Number(child.launch_id))!.owner_nonce).toBe("first");
    expect(executionState.registerControlEndpoint(Number(child.launch_id), "wrong", "/tmp/not-owned.sock")).toBe(false);
    const stoppedBeforeClaim = createChild(identity);
    stateStore.execute("UPDATE launches SET stop_requested_at=? WHERE launch_id=?", [stateStore.now(), stoppedBeforeClaim.launch_id]);
    expect(stateStore.claimLaunchOwnership(Number(stoppedBeforeClaim.launch_id), "late", 9999)).toBe(false);
  }));
});

describe("profile registry and immutable execution", () => {
  test("built-in profiles pin exact commands, packages, models, and sandbox failure", () => {
    const claude = registry.resolveProfile("claude");
    const codex = registry.resolveProfile("codex");
    const gemini = registry.resolveProfile("gemini");
    expect([claude.command, claude.profile_version, claude.package]).toEqual([
      "claude-agent-acp", "0.62.0", "@agentclientprotocol/claude-agent-acp",
    ]);
    expect([codex.command, codex.profile_version, codex.package]).toEqual([
      "codex-acp", "1.1.7", "@agentclientprotocol/codex-acp",
    ]);
    expect(codex.model_tiers).toEqual({ strong: "gpt-5.6-sol", balanced: "gpt-5.6-terra", fast: "gpt-5.6-luna" });
    expect(gemini.args).toEqual(["--acp"]);
    expect(gemini.profile_version).toBe("0.41.0");
    for (const profile of [claude, codex, gemini]) expect(profile.sandbox.missing_behavior).toBe("fail_closed");
  });

  test("permission defaults are profile-specific and explicit opt-down is frozen", async () => isolatedRuntime(() => {
    expect(executionConfig.resolveRunExecution({ acpAgent: "claude", installDependencies: true }).acp.permission_policy).toBe("allow_all");
    expect(executionConfig.resolveRunExecution({ acpAgent: "codex", installDependencies: true }).acp.permission_policy).toBe("allow_all");
    expect(executionConfig.resolveRunExecution({
      acpAgent: "gemini", installDependencies: false,
      environment: { ...process.env, AGENTS_ORCHESTRATOR_MANAGED_ROOT: process.env.AGENTS_ORCHESTRATOR_MANAGED_ROOT },
    }).acp.permission_policy).toBe("allow_in_workspace");
    expect(executionConfig.resolveRunExecution({
      acpAgent: "custom", acpCommand: "/bin/true", installDependencies: true,
    }).acp.permission_policy).toBe("allow_in_workspace");
    expect(executionConfig.resolveRunExecution({
      acpAgent: "codex", acpPermissionPolicy: "allow_in_workspace", installDependencies: true,
    }).acp.permission_policy).toBe("allow_in_workspace");
  }));

  test("custom profile requires an absolute command and preserves symlink entrypoint", async () => isolatedRuntime(({ root }) => {
    expect(() => registry.resolveProfile("custom")).toThrow("explicit command");
    expect(() => executionConfig.resolveRunExecution({ acpAgent: "custom", acpCommand: "relative" })).toThrow("absolute");
    const target = join(root, "agent-real");
    const link = join(root, "agent-link");
    writeFileSync(target, "#!/bin/sh\nexit 0\n");
    chmodSync(target, 0o700);
    symlinkSync(target, link);
    const frozen = registry.freezeProfile(registry.resolveProfile("custom", { command: link, args: ["serve"] }));
    expect(frozen.resolved_command).toBe(link);
    expect(frozen.args).toEqual(["serve"]);
    expect(registry.ensureAvailable(frozen)).toBe(link);
  }));

  test("attempt snapshot stays unchanged after environment mutation", async () => isolatedRuntime(({ cwd }) => {
    process.env.AGENTS_ORCHESTRATOR_CLAUDE_BIN = "/first/claude";
    const identity = initializeRun("root", cwd, { backend: "claude_cli" });
    const child = createChild(identity);
    const before = String(stateStore.getAttempt(Number(child.attempt_id))!.config_json);
    process.env.AGENTS_ORCHESTRATOR_CLAUDE_BIN = "/second/claude";
    expect(stateStore.getAttempt(Number(child.attempt_id))!.config_json).toBe(before);
    expect(JSON.parse(before).command).toBe("/first/claude");
    expect(stateStore.getLaunch(Number(child.launch_id))!.config_json).toBe(before);
  }));

  test("allowlisted profiles round-robin and task hints cannot inject commands", async () => isolatedRuntime(({ cwd }) => {
    const identity = initializeRun("root", cwd, {
      profileAllowlist: ["codex", "claude"], defaultProfile: "codex",
      maxConcurrentAgents: 4,
    });
    stateStore.transaction((connection) => {
      const run = stateStore.getRun(String(identity.root_id), connection)!;
      insertReadyChild(connection, run);
      insertReadyChild(connection, run);
    });
    const created = scheduler.schedule(String(identity.root_id));
    const configs = created.map((item) => JSON.parse(String(stateStore.getAttempt(Number(item.attempt_id))!.config_json)) as RuntimeRecord);
    expect(configs.map((item) => item.agent)).toEqual(["codex", "claude"]);
    expect(configs.map((item) => item.model)).toEqual(["gpt-5.6-terra", "sonnet"]);
    const run = stateStore.getRun(String(identity.root_id))!;
    const selected = modelPolicy.selectProfile(run, {
      constraints_json: JSON.stringify({ profile_hint: "claude", command: "/tmp/injected", args: ["--bad"] }),
    });
    const hinted = executionConfig.snapshotAttempt(run, { profileHint: selected, modelTier: "fast" });
    expect(hinted.agent).toBe("claude");
    expect(hinted.command).not.toBe("/tmp/injected");
    expect(hinted.args).toEqual([]);
    expect(() => executionConfig.snapshotAttempt(run, { profileHint: "gemini" })).toThrow("allowlist");
  }));

  test("missing execution config recovers explicitly as legacy claude_cli", () => {
    expect(executionConfig.snapshotAttempt({}, { model: "sonnet" })).toMatchObject({
      backend: "claude_cli", agent: "claude", model: "sonnet",
    });
    expect(executionConfig.snapshotAttempt({
      execution_config_json: JSON.stringify({ backend: "claude_cli", claude_cli: { command: "/frozen/claude" } }),
    }, { model: "opus" })).toMatchObject({ backend: "claude_cli", command: "/frozen/claude", model: "opus" });
  });
});

describe("action gates and structural schema", () => {
  test("entry mode aliases are hints only and unsupported values fail closed", () => {
    expect(entryMode("swarm", {})).toBe("swarm");
    expect(entryMode("loop", {})).toBe("develop_review_improve");
    expect(entryMode("review", {})).toBe("multi_session_review");
    expect(() => entryMode("unknown", {})).toThrow("swarm, loop, or review");
  });

  test("final review gate blocks changed Run until structured passing review", async () => isolatedRuntime(({ cwd }) => {
    const identity = initializeRun("review gate", cwd, { backend: "claude_cli", requireFinalReview: true });
    estimate(identity);
    const payload = {
      status: "done", summary: "changed", changed_files: ["src/change.ts"], artifacts: [], caveats: [],
      validation: { status: "passed" }, review: null, integration_check: null, mode_result: null,
    };
    expect(() => actionProcessor.processAction(envelope(identity, "finish", payload, "finish-without-review"))).toThrow("final review");
    const finished = actionProcessor.processAction(envelope(identity, "finish", {
      ...payload, review: { status: "pass", findings: [], source: null },
    }, "finish-with-review"));
    expect(finished.run_status).toBe("done");
  }));

  test("schema has Task/Attempt/Launch/Session layers and no persisted dialogue table", async () => isolatedRuntime(() => {
    stateStore.initializeSchema();
    const tables = stateStore.fetchall("SELECT name FROM sqlite_master WHERE type='table'").map((item) => item.name);
    for (const required of ["runs", "tasks", "attempts", "launches", "acp_sessions", "effects", "modes"]) expect(tables).toContain(required);
    expect(tables.some((name) => /dialog|message|transcript/iu.test(String(name)))).toBe(false);
  }));

  test("doctor reports durable Attempt, Launch, and pending Effect facts", async () => isolatedRuntime(({ cwd }) => {
    const identity = initializeRun("doctor", cwd, { backend: "acp", acpAgent: "custom", acpCommand: "/bin/true" });
    const child = createChild(identity);
    const report = recovery.doctor(String(identity.root_id));
    expect(report.run_status).toBe("running");
    expect(report.open_launches[0].launch_id).toBe(child.launch_id);
    expect(report.pending_effects[0].effect_type).toBe("spawn_agent");
  }));
});
