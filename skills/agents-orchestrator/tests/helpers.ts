import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as stateStore from "../scripts/state_store.ts";
import type { RuntimeRecord } from "../scripts/runtime_types.ts";

export const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SCRIPTS_DIR = join(SKILL_DIR, "scripts");
export const FAKE_AGENT = join(SKILL_DIR, "tests", "fixtures", "fake_acp_agent.ts");
const PREFIXES = ["AGENTS_ORCHESTRATOR_", "AGENT_SWARM_"];
export const DEPENDENCY_HOME = mkdtempSync(join(tmpdir(), "agents-orchestrator-test-dependencies-"));

process.once("exit", () => rmSync(DEPENDENCY_HOME, { recursive: true, force: true }));

function prepareManagedTree(): void {
  const bin = join(DEPENDENCY_HOME, "bin");
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  for (const name of ["codex-acp", "claude-agent-acp"]) {
    const source = join(SKILL_DIR, "node_modules", ".bin", name);
    const target = join(bin, name);
    try { symlinkSync(source, target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  chmodSync(DEPENDENCY_HOME, 0o700);
}
prepareManagedTree();

export function cleanupGlobalFixtures(): void { rmSync(DEPENDENCY_HOME, { recursive: true, force: true }); }

export async function isolatedRuntime<T>(
  callback: (fixture: { root: string; runtimeHome: string; cwd: string }) => T | Promise<T>,
): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "agents-orchestrator-test-"));
  const runtimeHome = join(root, "runtime");
  const cwd = join(root, "workspace");
  mkdirSync(runtimeHome, { recursive: true, mode: 0o700 });
  mkdirSync(cwd, { recursive: true });
  const before = { ...process.env };
  try {
    for (const name of Object.keys(process.env)) if (PREFIXES.some((prefix) => name.startsWith(prefix))) delete process.env[name];
    Object.assign(process.env, {
      AGENTS_ORCHESTRATOR_HOME: runtimeHome,
      AGENT_SWARM_HOME: runtimeHome,
      AGENTS_ORCHESTRATOR_DEPENDENCY_HOME: DEPENDENCY_HOME,
      AGENT_SWARM_DEPENDENCY_HOME: DEPENDENCY_HOME,
      AGENTS_ORCHESTRATOR_MANAGED_ROOT: SKILL_DIR,
      AGENT_SWARM_MANAGED_ROOT: SKILL_DIR,
    });
    return await callback({ root, runtimeHome, cwd });
  } finally {
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, before);
    rmSync(root, { recursive: true, force: true });
  }
}

export function insertReadyChild(connection: stateStore.Connection, run: RuntimeRecord): number {
  const cursor = connection.execute(
    `INSERT INTO tasks(root_id, parent_task_id, goal, intent_hint, status, priority,
      complexity_hint, output_contract, constraints_json, delegation_depth, replan_count, created_at)
     VALUES (?, ?, 'child goal', 'implement', 'ready', 50, 'medium', 'finish child', '{}', 1, 0, ?)`,
    [run.root_id, run.root_task_id, stateStore.now()],
  );
  return Number(cursor.lastrowid);
}

export function waitFor<T>(probe: () => T | null | undefined | false, timeoutSeconds = 10): T {
  const deadline = performance.now() + timeoutSeconds * 1000;
  while (performance.now() < deadline) {
    const value = probe();
    if (value) return value;
    Bun.sleepSync(50);
  }
  const value = probe();
  if (value) return value;
  throw new Error("condition did not become true before timeout");
}

export function parseColumn(row: RuntimeRecord, key: string): RuntimeRecord {
  return JSON.parse(String(row[key]));
}
