import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

import * as db from "./db.ts";
import { parsePythonInteger } from "./number-utils.ts";
import { isStrictDescendant, stablePath } from "./path-utils.ts";
import { sleepSeconds } from "./process.ts";

export interface IsolationEnv {
  [key: string]: string;
  ACCEPTANCE_SANDBOX: string;
  ACCEPTANCE_HOME: string;
  ACCEPTANCE_TMPDIR: string;
  ACCEPTANCE_DEPTH: string;
  TMPDIR: string;
  TMP: string;
  TEMP: string;
  HOME: string;
  CMDAI_CODEX_MARKETPLACE_ROOT: string;
  CMDAI_CLAUDE_MARKETPLACE_ROOT: string;
  CMDAI_CODEX_AGENTS_ROOT: string;
  CMDAI_CLAUDE_SETTINGS_PATH: string;
  BH_PROFILE_ROOT: string;
}

export function temporaryRoot(): string {
  for (const key of ["ACCEPTANCE_TMPDIR", "TMPDIR", "TMP", "TEMP"] as const) {
    const value = process.env[key];
    if (value) return value;
  }
  return tmpdir();
}

export function makeSandbox(roundTag: string): string {
  const base = join(temporaryRoot(), `acc-${roundTag}`);
  mkdirSync(base, { recursive: true });
  return base;
}

export function rsyncFixture(fixturePath: string | null, sandbox: string): string | null {
  if (!fixturePath || !existsSync(fixturePath)) {
    return null;
  }
  const destination = join(sandbox, basename(fixturePath));
  cpSync(fixturePath, destination, {
    recursive: true,
    force: true,
    dereference: true,
  });
  return destination;
}

function ensureJsonObject(path: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  if (existsSync(path)) {
    try {
      const data = JSON.parse(readFileSync(path, "utf8"));
      if (typeof data === "object" && data !== null && !Array.isArray(data)) {
        return;
      }
    } catch {
      // Replace invalid or unreadable settings with an empty JSON object.
    }
  }
  writeFileSync(path, "{}\n", "utf8");
}

function sandboxClaudeSettings(home: string): Record<string, unknown> {
  let data: unknown = {};
  try {
    data = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
  } catch {
    data = {};
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    data = {};
  }
  const source = data as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of ["env", "permissions", "model"]) {
    if (key in source) output[key] = source[key];
  }
  return output;
}

function parseDepth(): number {
  const raw = process.env.ACCEPTANCE_DEPTH ?? "0";
  const parsed = parsePythonInteger(raw);
  return parsed === null ? 1 : parsed + 1;
}

export function prepareRoundEnvironment(
  sandbox: string,
  sourceHome?: string,
): IsolationEnv {
  const acceptanceHome = join(sandbox, ".aut-acceptance");
  const isolation = join(sandbox, ".iso");
  const temporary = join(sandbox, ".tmp");
  const home = sourceHome || homedir();
  const settings = join(isolation, "claude-settings.json");
  for (const path of [acceptanceHome, isolation, temporary]) {
    mkdirSync(path, { recursive: true });
  }
  ensureJsonObject(settings);
  writeFileSync(
    settings,
    `${JSON.stringify(sandboxClaudeSettings(home), null, 2)}\n`,
    "utf8",
  );
  const herdrEnvironment = Object.fromEntries(
    ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "HERDR_SOCKET_PATH"]
      .flatMap((key) => process.env[key] ? [[key, process.env[key] as string]] : []),
  );
  return {
    ...herdrEnvironment,
    ACCEPTANCE_SANDBOX: sandbox,
    ACCEPTANCE_HOME: acceptanceHome,
    ACCEPTANCE_TMPDIR: temporary,
    ACCEPTANCE_DEPTH: String(parseDepth()),
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    HOME: home,
    CMDAI_CODEX_MARKETPLACE_ROOT: join(isolation, "codex-marketplace"),
    CMDAI_CLAUDE_MARKETPLACE_ROOT: join(isolation, "claude-marketplace"),
    CMDAI_CODEX_AGENTS_ROOT: join(isolation, "codex-agents"),
    CMDAI_CLAUDE_SETTINGS_PATH: settings,
    BH_PROFILE_ROOT: join(isolation, "bh-profiles"),
  };
}

export function isolationEnv(sandbox: string): IsolationEnv {
  return prepareRoundEnvironment(sandbox);
}

export interface NestedSandboxCleanup {
  path: string;
  existed: boolean;
  removed: boolean;
}

export interface SandboxCleanup {
  removed: string;
  existed: boolean;
  tmpdir: string;
  tmpdir_existed: boolean;
  tmpdir_removed: boolean;
  nested_sandboxes: NestedSandboxCleanup[];
  [key: string]: unknown;
}

export function cleanupSandbox(sandbox: string): SandboxCleanup {
  const temporary = join(sandbox, ".tmp");
  const nested = cleanupNestedSandboxes(sandbox);
  const existed = existsSync(sandbox);
  const temporaryExisted = existsSync(temporary);
  if (existed) removeTreeRetry(sandbox);
  return {
    removed: sandbox,
    existed,
    tmpdir: temporary,
    tmpdir_existed: temporaryExisted,
    tmpdir_removed: temporaryExisted && !existsSync(temporary),
    nested_sandboxes: nested,
  };
}

function cleanupNestedSandboxes(sandbox: string): NestedSandboxCleanup[] {
  const stateDatabase = join(sandbox, ".aut-acceptance", "state.sqlite3");
  return db.roundSandboxPathsFrom(stateDatabase)
    .filter((path) => isSafeNestedSandbox(path, sandbox))
    .map((path) => cleanupNestedSandbox(path));
}

function cleanupNestedSandbox(path: string): NestedSandboxCleanup {
  const existed = existsSync(path);
  if (existed) removeTreeRetry(path);
  return { path, existed, removed: existed && !existsSync(path) };
}

function isSafeNestedSandbox(path: string, parentSandbox: string): boolean {
  if (!isAbsolute(path) || !basename(path).startsWith("acc-")) {
    return false;
  }
  try {
    const nested = stablePath(path) as string;
    const parent = stablePath(parentSandbox) as string;
    const temporary = stablePath(temporaryRoot()) as string;
    if (nested === parent) return false;
    return isStrictDescendant(nested, parent)
      || isStrictDescendant(nested, temporary)
      || resolve(join(nested, "..")) === resolve(temporary);
  } catch {
    return false;
  }
}

interface RemoveTreeOps {
  remove(path: string): void;
  exists(path: string): boolean;
  sleep(seconds: number): void;
}

const defaultRemoveTreeOps: RemoveTreeOps = {
  remove: (path) => rmSync(path, { recursive: true, force: true }),
  exists: existsSync,
  sleep: sleepSeconds,
};

export function removeTreeRetry(
  path: string,
  attempts = 6,
  operations: RemoveTreeOps = defaultRemoveTreeOps,
): void {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      operations.remove(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      if (attempt + 1 >= attempts) throw error;
      operations.sleep(0.1 * (attempt + 1));
      continue;
    }
    // tmux kill-session can return just before a pane child exits. That child
    // may recreate an absolute sandbox path after the first successful rm.
    // Require a short absence window and retry the exact validated target.
    operations.sleep(0.1 * (attempt + 1));
    if (!operations.exists(path)) return;
  }
  throw new Error(`cleanup target reappeared after ${attempts} attempts: ${path}`);
}
