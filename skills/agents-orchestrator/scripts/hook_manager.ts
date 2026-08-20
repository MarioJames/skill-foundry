import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as stateStore from "./state_store.ts";
import { RuntimeError, type RuntimeRecord } from "./runtime_types.ts";

export const OWNER_FIELD = "agents_orchestrator_owner";
export const OWNER_VALUE = "agents-orchestrator";
export const ROOT_FIELD = "agents_orchestrator_root_id";
export const WORKTREE_SETTINGS_PATH = ".claude/settings.local.json";
export const WORKTREE_INCLUDE_FILE = ".worktreeinclude";
export const HOOK_BINDINGS: ReadonlyArray<readonly [string, string]> = [
  ["SessionStart", "heartbeat.ts"], ["PostToolUse", "heartbeat.ts"],
  ["PostToolUseFailure", "failure_context.ts"], ["Stop", "finish_gate.ts"], ["SessionEnd", "clean.ts"],
];
const LEGACY_HOOK_NAMES = ["heartbeat.sh", "failure_context.sh", "finish_gate.sh", "clean.sh"] as const;
const SKILL_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

function settingsPath(cwd: string): string { return join(cwd, WORKTREE_SETTINGS_PATH); }
function sourceHookPath(name: string): string { return resolve(SKILL_DIR, "hooks", name); }
function shellQuote(value: string): string { return `'${value.replaceAll("'", `'\\''`)}'`; }
export function runtimeHookCommand(name: string): string {
  return `${shellQuote(process.execPath)} "\${AGENTS_ORCHESTRATOR_HOME:-$HOME/.agents-orchestrator}/hooks/${name}"`;
}

function legacyBunRuntimeHookCommand(name: string): string {
  return `bun "\${AGENTS_ORCHESTRATOR_HOME:-$HOME/.agents-orchestrator}/hooks/${name}"`;
}

function legacyRuntimeHookCommand(name: string): string {
  return `bash -c 'exec "\${AGENTS_ORCHESTRATOR_HOME:-$HOME/.agents-orchestrator}/hooks/${name}"'`;
}

function gitOutput(cwd: string, ...args: string[]): string | null {
  const result = Bun.spawnSync({ cmd: ["git", "-C", cwd, ...args], stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 5000 });
  return result.exitCode === 0 ? result.stdout.toString().trim() : null;
}

function gitRoot(cwd: string): string | null {
  const output = gitOutput(cwd, "rev-parse", "--show-toplevel");
  return output ? resolve(output) : null;
}

function worktreeRoots(cwd: string): string[] {
  const primary = gitRoot(cwd) ?? resolve(cwd);
  const roots = [primary];
  const output = gitOutput(primary, "worktree", "list", "--porcelain");
  if (output === null) return roots;
  for (const line of output.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const candidate = resolve(line.slice("worktree ".length));
    if (!roots.includes(candidate)) roots.push(candidate);
  }
  return roots;
}

function appendUniqueLine(path: string, line: string): void {
  const lines = existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/u).filter(Boolean) : [];
  if (lines.includes(line)) return;
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${[...lines, line].join("\n")}\n`, "utf8");
  renameSync(temporary, path);
}

function prepareFutureWorktrees(cwd: string): string | null {
  const root = gitRoot(cwd);
  if (!root) return null;
  const include = join(root, WORKTREE_INCLUDE_FILE);
  appendUniqueLine(include, WORKTREE_SETTINGS_PATH);
  const excludeOutput = gitOutput(root, "rev-parse", "--git-path", "info/exclude");
  if (excludeOutput) {
    const exclude = isAbsolute(excludeOutput) ? excludeOutput : join(root, excludeOutput);
    for (const relativePath of [WORKTREE_SETTINGS_PATH, WORKTREE_INCLUDE_FILE]) {
      const tracked = gitOutput(root, "ls-files", "--error-unmatch", "--", relativePath) !== null;
      const ignored = gitOutput(root, "check-ignore", "-q", "--", relativePath) !== null;
      if (!tracked && !ignored) appendUniqueLine(exclude, relativePath);
    }
  }
  return include;
}

function ownedHook(name: string, rootId?: string | null): RuntimeRecord {
  const hook: RuntimeRecord = { type: "command", command: runtimeHookCommand(name), [OWNER_FIELD]: OWNER_VALUE };
  if (rootId) hook[ROOT_FIELD] = rootId;
  return hook;
}

function readSettings(path: string): RuntimeRecord {
  if (!existsSync(path)) return {};
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RuntimeError("Claude settings must contain a JSON object");
  return value as RuntimeRecord;
}

function writeSettings(path: string, settings: RuntimeRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

function isOwned(hook: unknown): boolean {
  if (!hook || typeof hook !== "object" || Array.isArray(hook)) return false;
  const item = hook as RuntimeRecord;
  if (item[OWNER_FIELD] === OWNER_VALUE) return true;
  if (HOOK_BINDINGS.some(([, name]) =>
    item.command === runtimeHookCommand(name) || item.command === legacyBunRuntimeHookCommand(name)
    || item.command === sourceHookPath(name))) return true;
  return LEGACY_HOOK_NAMES.some((name) =>
    item.command === legacyRuntimeHookCommand(name) || item.command === sourceHookPath(name));
}

function ensureAt(cwd: string, rootId?: string | null): string {
  const path = settingsPath(cwd);
  const settings = readSettings(path);
  const hooks = settings.hooks && typeof settings.hooks === "object" && !Array.isArray(settings.hooks)
    ? settings.hooks as RuntimeRecord : (settings.hooks = {} as RuntimeRecord);
  for (const [event, name] of HOOK_BINDINGS) {
    const source = Array.isArray(hooks[event]) ? hooks[event] as unknown[] : [];
    const entries: RuntimeRecord[] = [];
    for (const candidate of source) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) { entries.push(candidate as RuntimeRecord); continue; }
      const entry = candidate as RuntimeRecord;
      if (!Array.isArray(entry.hooks)) { entries.push(entry); continue; }
      const kept = entry.hooks.filter((hook: unknown) => !isOwned(hook));
      if (kept.length) entries.push({ ...entry, hooks: kept });
    }
    hooks[event] = entries;
    let target = entries.find((entry) => entry.matcher === "*");
    if (!target) { target = { matcher: "*", hooks: [] }; entries.push(target); }
    if (!Array.isArray(target.hooks)) target.hooks = [];
    target.hooks.push(ownedHook(name, rootId));
  }
  writeSettings(path, settings);
  return path;
}

export function ensureProjectHooks(cwd: string, rootId?: string | null): string {
  stateStore.ensureRuntimeAssets();
  prepareFutureWorktrees(cwd);
  const paths = worktreeRoots(cwd).map((root) => ensureAt(root, rootId));
  return paths[0] ?? settingsPath(cwd);
}

function cleanupAt(cwd: string, rootId?: string | null): string | null {
  const path = settingsPath(cwd);
  if (!existsSync(path)) return null;
  const settings = readSettings(path);
  const hooks = settings.hooks;
  if (hooks && typeof hooks === "object" && !Array.isArray(hooks)) {
    for (const event of Object.keys(hooks)) {
      const entries = (hooks as RuntimeRecord)[event];
      if (!Array.isArray(entries)) continue;
      const keptEntries: RuntimeRecord[] = [];
      for (const candidate of entries) {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) { keptEntries.push(candidate as RuntimeRecord); continue; }
        const entry = candidate as RuntimeRecord;
        if (!Array.isArray(entry.hooks)) { keptEntries.push(entry); continue; }
        const kept = entry.hooks.filter((hook: unknown) => {
          if (!isOwned(hook)) return true;
          const item = hook as RuntimeRecord;
          const ownedRoot = item[ROOT_FIELD];
          return Boolean(rootId && ownedRoot && ownedRoot !== rootId);
        });
        if (kept.length) keptEntries.push({ ...entry, hooks: kept });
      }
      if (keptEntries.length) (hooks as RuntimeRecord)[event] = keptEntries;
      else delete (hooks as RuntimeRecord)[event];
    }
    if (Object.keys(hooks as RuntimeRecord).length === 0) delete settings.hooks;
  }
  if (Object.keys(settings).length) writeSettings(path, settings); else unlinkSync(path);
  return path;
}

export function cleanupProjectHooks(cwd: string, rootId?: string | null): string | null {
  return worktreeRoots(cwd).map((root) => cleanupAt(root, rootId))[0] ?? null;
}
