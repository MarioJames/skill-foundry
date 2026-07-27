import { describe, expect, test } from "bun:test";
import {
  cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Database } from "bun:sqlite";

import * as hookManager from "../scripts/hook_manager.ts";
import * as recovery from "../scripts/recovery.ts";
import * as stateStore from "../scripts/state_store.ts";
import { hashToken } from "../scripts/state_store.ts";
import { DEPENDENCY_HOME, SKILL_DIR, isolatedRuntime } from "./helpers.ts";

const BOOTSTRAP = join(SKILL_DIR, "scripts", "bootstrap.ts");
const ALIAS = resolve(SKILL_DIR, "..", "agent-swarm", "scripts", "bootstrap.ts");

function run(command: string[], options: { cwd?: string; env?: Record<string, string>; input?: string; timeout?: number } = {}) {
  return Bun.spawnSync({
    cmd: command, cwd: options.cwd, env: { ...process.env, ...options.env },
    stdin: options.input ? Buffer.from(options.input) : "ignore", stdout: "pipe", stderr: "pipe",
    timeout: options.timeout ?? 120_000,
  });
}

describe("content-addressed first launch", () => {
  test("clean init installs exact shared dependencies, reuses, rebuilds, and serializes concurrent launch", async () => {
    const root = mkdtempSync(join(tmpdir(), "agents-orchestrator-bootstrap-"));
    const home = join(root, "home");
    const dependencies = join(root, "dependencies");
    const workspace = join(root, "workspace");
    mkdirSync(home, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    const environment = {
      HOME: home,
      AGENTS_ORCHESTRATOR_HOME: join(root, "runtime"),
      AGENT_SWARM_HOME: join(root, "runtime"),
      AGENTS_ORCHESTRATOR_DEPENDENCY_HOME: dependencies,
      AGENT_SWARM_DEPENDENCY_HOME: dependencies,
    };
    try {
      const initialized = run([process.execPath, BOOTSTRAP, "init", "--task", "clean init", "--cwd", workspace], { env: environment });
      expect(initialized.exitCode).toBe(0);
      const identity = JSON.parse(initialized.stdout.toString());
      const targets = readdirSync(dependencies).filter((name) => name.startsWith("runtime-"));
      expect(targets).toHaveLength(1);
      const target = join(dependencies, targets[0]!);
      const manifestPath = join(target, ".agents-orchestrator-manifest.json");
      const firstManifest = readFileSync(manifestPath, "utf8");
      const manifest = JSON.parse(firstManifest);
      expect(manifest.packages).toEqual({
        "@agentclientprotocol/sdk": "1.3.0",
        "@agentclientprotocol/codex-acp": "1.1.7",
        "@agentclientprotocol/claude-agent-acp": "0.62.0",
        "@openai/codex": "0.145.0",
        "@anthropic-ai/claude-agent-sdk": "0.3.219",
      });
      expect(statSync(dependencies).mode & 0o777).toBe(0o700);
      expect(statSync(manifestPath).mode & 0o777).toBe(0o600);
      expect(existsSync(join(dependencies, "bin", "codex-acp"))).toBe(true);
      expect(existsSync(join(dependencies, "bin", "claude-agent-acp"))).toBe(true);
      expect(existsSync(join(target, "node_modules", "@google", "gemini-cli"))).toBe(false);
      const inspected = run([
        process.execPath, BOOTSTRAP, "inspect", "--run", identity.root_id, "--actor-token", identity.actor_token,
      ], { env: environment });
      expect(inspected.exitCode).toBe(0);
      const facts = JSON.parse(inspected.stdout.toString());
      const execution = JSON.parse(facts.run.execution_config_json);
      const rootSnapshot = JSON.parse(facts.attempts[0].config_json);
      expect(execution.default_profile).toBe("codex");
      expect(execution.profile_allowlist).toEqual(["codex"]);
      expect(rootSnapshot.agent).toBe("codex");
      expect(rootSnapshot.command).toBe(join(dependencies, "bin", "codex-acp"));
      expect(facts.launches).toEqual([]);

      const reaped = run([
        process.execPath, BOOTSTRAP, "reap", "--root-id", identity.root_id, "--actor-token", identity.actor_token,
      ], { env: environment });
      expect(reaped.exitCode).toBe(0);
      expect(JSON.parse(reaped.stdout.toString())).toMatchObject({ ok: true, reconciled: [], stalled_attempts: [] });

      const reused = run([process.execPath, BOOTSTRAP, "action-schema", "finish"], { env: environment });
      expect(reused.exitCode).toBe(0);
      expect(readFileSync(manifestPath, "utf8")).toBe(firstManifest);

      const sdkMetadata = join(target, "node_modules", "@agentclientprotocol", "sdk", "package.json");
      const broken = JSON.parse(readFileSync(sdkMetadata, "utf8"));
      broken.version = "0.0.0";
      writeFileSync(sdkMetadata, JSON.stringify(broken));
      const rebuilt = run([process.execPath, BOOTSTRAP, "action-schema", "finish"], { env: environment });
      expect(rebuilt.exitCode).toBe(0);
      expect(JSON.parse(readFileSync(sdkMetadata, "utf8")).version).toBe("1.3.0");
      expect(lstatSync(join(dependencies, "bin", "codex-acp")).isSymbolicLink()).toBe(true);

      rmSync(target, { recursive: true, force: true });
      const first = Bun.spawn({ cmd: [process.execPath, BOOTSTRAP, "action-schema", "finish"], env: { ...process.env, ...environment }, stdout: "pipe", stderr: "pipe" });
      const second = Bun.spawn({ cmd: [process.execPath, BOOTSTRAP, "action-schema", "finish"], env: { ...process.env, ...environment }, stdout: "pipe", stderr: "pipe" });
      expect(await Promise.all([first.exited, second.exited])).toEqual([0, 0]);
      expect(readdirSync(dependencies).filter((name) => name.startsWith("runtime-"))).toHaveLength(1);
      expect(readdirSync(dependencies).some((name) => name.startsWith(".staging-") || name === ".install.lock")).toBe(false);

      rmSync(target, { recursive: true, force: true });
      const staleLock = join(dependencies, ".install.lock");
      mkdirSync(staleLock, { mode: 0o700 });
      writeFileSync(join(staleLock, "owner.json"), JSON.stringify({ pid: 2_147_483_647 }), { mode: 0o600 });
      const recoveredLock = run([process.execPath, BOOTSTRAP, "action-schema", "finish"], { env: environment });
      expect(recoveredLock.exitCode).toBe(0);
      expect(existsSync(staleLock)).toBe(false);
      expect(existsSync(target)).toBe(true);

      const stopped = run([process.execPath, BOOTSTRAP, "stop", "--root-id", identity.root_id, "--actor-token", identity.actor_token], { env: environment });
      expect(stopped.exitCode).toBe(0);
      expect(JSON.parse(stopped.stdout.toString()).status).toBe("cancelled");
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 180_000);

  test("frozen-lock failure leaves no target, staging, lock, or Run", () => {
    const root = mkdtempSync(join(tmpdir(), "agents-orchestrator-install-failure-"));
    const skill = join(root, "skill");
    const dependencies = join(root, "dependencies");
    cpSync(SKILL_DIR, skill, { recursive: true, filter: (source) => !source.includes(`${join(SKILL_DIR, "node_modules")}`) });
    const packagePath = join(skill, "package.json");
    const metadata = JSON.parse(readFileSync(packagePath, "utf8"));
    metadata.dependencies["@invalid/not-in-lock"] = "1.0.0";
    writeFileSync(packagePath, JSON.stringify(metadata, null, 2));
    try {
      const result = run([process.execPath, join(skill, "scripts", "bootstrap.ts"), "init", "--task", "must fail", "--cwd", root], {
        env: {
          HOME: join(root, "home"), AGENTS_ORCHESTRATOR_HOME: join(root, "runtime"), AGENT_SWARM_HOME: join(root, "runtime"),
          AGENTS_ORCHESTRATOR_DEPENDENCY_HOME: dependencies, AGENT_SWARM_DEPENDENCY_HOME: dependencies,
        }, timeout: 30_000,
      });
      expect(result.exitCode).not.toBe(0);
      expect(existsSync(join(root, "runtime", "runtime.sqlite3"))).toBe(false);
      const residue = existsSync(dependencies) ? readdirSync(dependencies) : [];
      expect(residue.some((name) => name.startsWith("runtime-") || name.startsWith(".staging-") || name === ".install.lock")).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 60_000);
});

describe("legacy alias and hooks", () => {
  test("alias rejects injected init and canonical/legacy conflicts before forwarding", () => {
    let result = run([process.execPath, ALIAS, "init", "--task", "x", "--cwd", "/tmp"], {
      env: { AGENTS_ORCHESTRATOR_ROOT_ID: "existing" },
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("refuses init");
    result = run([process.execPath, ALIAS, "action-schema", "finish"], {
      env: { AGENTS_ORCHESTRATOR_MODE: "swarm", AGENT_SWARM_MODE: "review" },
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("conflicting orchestration environment");
  });

  test("alias forwards through canonical bootstrap and injects swarm mode", () => {
    const root = mkdtempSync(join(tmpdir(), "agents-orchestrator-alias-"));
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const environment = {
      HOME: join(root, "home"),
      AGENTS_ORCHESTRATOR_HOME: join(root, "runtime"),
      AGENT_SWARM_HOME: join(root, "runtime"),
      AGENTS_ORCHESTRATOR_DEPENDENCY_HOME: DEPENDENCY_HOME,
      AGENT_SWARM_DEPENDENCY_HOME: DEPENDENCY_HOME,
    };
    try {
      const schema = run([process.execPath, ALIAS, "action-schema", "finish"], { env: environment, timeout: 120_000 });
      expect(schema.exitCode).toBe(0);
      expect(JSON.parse(schema.stdout.toString()).title).toBe("finish");
      const initialized = run([process.execPath, ALIAS, "init", "--task", "alias", "--cwd", workspace, "--backend", "claude_cli"], {
        env: environment, timeout: 120_000,
      });
      expect(initialized.exitCode).toBe(0);
      const identity = JSON.parse(initialized.stdout.toString());
      expect(identity.entry_mode).toBe("swarm");
      const stopped = run([process.execPath, ALIAS, "stop", "--root-id", identity.root_id, "--actor-token", identity.actor_token], {
        env: environment, timeout: 120_000,
      });
      expect(stopped.exitCode).toBe(0);
      expect(JSON.parse(stopped.stdout.toString()).status).toBe("cancelled");
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 120_000);

  test("hook manager preserves user hooks and removes only owned entries", async () => isolatedRuntime(({ cwd }) => {
    run(["git", "init", "-q", cwd]);
    const settings = join(cwd, ".claude", "settings.local.json");
    mkdirSync(dirname(settings), { recursive: true });
    writeFileSync(settings, JSON.stringify({ hooks: { Stop: [{ matcher: "*", hooks: [{ type: "command", command: "user-hook" }] }] } }));
    hookManager.ensureProjectHooks(cwd, "root-test");
    let parsed = JSON.parse(readFileSync(settings, "utf8"));
    expect(JSON.stringify(parsed)).toContain("user-hook");
    expect(JSON.stringify(parsed)).toContain("agent-swarm");
    hookManager.cleanupProjectHooks(cwd, "root-test");
    parsed = JSON.parse(readFileSync(settings, "utf8"));
    expect(JSON.stringify(parsed)).toContain("user-hook");
    expect(JSON.stringify(parsed)).not.toContain("agent-swarm");
  }));
});

describe("legacy SQLite recovery", () => {
  test("v1 schema migrates in place and an old Run supports inspect, doctor, recover, and stop", async () => isolatedRuntime(({ cwd }) => {
    const database = new Database(stateStore.dbPath(), { create: true });
    database.exec(stateStore.SCHEMA_SQL);
    const now = stateStore.now();
    database.query("INSERT INTO schema_migrations(version, applied_at) VALUES (1, ?)").run(now);
    const token = "legacy-owner";
    database.query(`INSERT INTO runs(
      root_id, goal, cwd, status, root_task_id, max_concurrent_agents, max_total_tasks,
      max_attempts_per_task, max_delegation_depth, max_replans_per_task, max_children_per_action,
      require_final_review, model_tiers_json, execution_config_json, owner_token_hash, lease_epoch, lease_expires_at,
      created_at, updated_at)
      VALUES ('legacy-root','legacy',?,'running',NULL,8,100,2,5,2,12,0,'{"strong":"opus","balanced":"sonnet","fast":"haiku"}','{"backend":"claude_cli"}',?,0,?,?,?)`).run(cwd, hashToken(token), now - 1, now, now);
    const task = database.query(`INSERT INTO tasks(root_id,goal,intent_hint,status,priority,complexity_hint,
      output_contract,constraints_json,delegation_depth,replan_count,created_at)
      VALUES ('legacy-root','legacy','implement','active',100,'high','legacy','{}',0,0,?) RETURNING task_id`).get(now) as { task_id: number };
    database.query("UPDATE runs SET root_task_id=? WHERE root_id='legacy-root'").run(task.task_id);
    database.query(`INSERT INTO attempts(task_id,attempt_no,state,actor_token_hash,backend_id,agent_type,
      config_json,heartbeat_at,created_at,started_at) VALUES (?,1,'evaluating',?,'claude_cli','claude','{}',?,?,?)`).run(task.task_id, hashToken(token), now, now, now);
    database.close();
    stateStore.initializeSchema();
    expect(stateStore.fetchall("SELECT version FROM schema_migrations ORDER BY version").map((row) => row.version)).toEqual([1, 2, 3]);
    const runtime = join(SKILL_DIR, "scripts", "agent_orchestrator.ts");
    const inspected = run([process.execPath, runtime, "inspect", "--run", "legacy-root", "--actor-token", token], { cwd });
    expect(inspected.exitCode).toBe(0);
    expect(JSON.parse(inspected.stdout.toString()).run.root_id).toBe("legacy-root");
    const diagnosed = run([process.execPath, runtime, "doctor", "--root-id", "legacy-root", "--actor-token", token], { cwd });
    expect(diagnosed.exitCode).toBe(0);
    expect(JSON.parse(diagnosed.stdout.toString()).run_status).toBe("running");
    const recovered = run([process.execPath, runtime, "recover", "--root-id", "legacy-root"], { cwd });
    expect(recovered.exitCode).toBe(0);
    const newIdentity = JSON.parse(recovered.stdout.toString());
    expect(newIdentity.root_id).toBe("legacy-root");
    expect(newIdentity.attempt_id).not.toBe(1);
    const stopped = run([process.execPath, runtime, "stop", "--root-id", "legacy-root", "--actor-token", newIdentity.actor_token], { cwd });
    expect(stopped.exitCode).toBe(0);
    expect(JSON.parse(stopped.stdout.toString()).status).toBe("cancelled");
  }));
});
