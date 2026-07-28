import { homedir } from "node:os";
import { resolve } from "node:path";

import { ValueError } from "./runtime_types.ts";

export const PREFIX = "AGENTS_ORCHESTRATOR_";
export const RUNTIME_HOME_DIRECTORY = ".agents-orchestrator";
export const RUNTIME_SQLITE_FILENAME = "runtime.sqlite3";

export const IDENTITY_SUFFIXES = ["ROOT_ID", "TASK_ID", "ATTEMPT_ID", "ACTOR_TOKEN"] as const;
export const TRANSIENT_IDENTITY_SUFFIXES = ["AGENT_ID", "EXECUTION_NONCE"] as const;

export type Environment = Record<string, string | undefined>;

export function name(suffix: string): string {
  return `${PREFIX}${suffix}`;
}

function nonempty(environment: Environment, key: string): string | undefined {
  const raw = environment[key];
  if (typeof raw !== "string") return undefined;
  const rendered = raw.trim();
  return rendered === "" ? undefined : rendered;
}

export function value(
  suffix: string,
  environment: Environment = process.env,
  defaultValue?: string,
): string | undefined {
  return nonempty(environment, name(suffix)) ?? defaultValue;
}

export function validateIdentity(environment: Environment = process.env): Record<string, string | undefined> {
  const present = IDENTITY_SUFFIXES.filter((suffix) => nonempty(environment, name(suffix)) !== undefined);
  if (present.length > 0 && present.length !== IDENTITY_SUFFIXES.length) {
    const missing = IDENTITY_SUFFIXES
      .filter((suffix) => !present.includes(suffix))
      .map((suffix) => name(suffix));
    throw new ValueError(`partial orchestration identity: missing ${missing.join(", ")}`);
  }
  return Object.fromEntries(IDENTITY_SUFFIXES.map((suffix) => [suffix, value(suffix, environment)]));
}

export function exportEnvironment(
  values: Record<string, unknown>,
  options: { base?: Environment; scrubIdentity?: boolean } = {},
): Environment {
  const result: Environment = { ...(options.base ?? {}) };
  if (options.scrubIdentity) {
    for (const suffix of [...IDENTITY_SUFFIXES, ...TRANSIENT_IDENTITY_SUFFIXES]) {
      delete result[name(suffix)];
    }
  }
  for (const [suffix, raw] of Object.entries(values)) {
    if (raw === null || raw === undefined) continue;
    result[name(suffix)] = String(raw);
  }
  return result;
}

export function withProcessBoundary<T>(values: Record<string, unknown>, callback: () => T): T {
  const names = [...IDENTITY_SUFFIXES, ...TRANSIENT_IDENTITY_SUFFIXES, "HOME", "SKILL_DIR"].map(name);
  const before = Object.fromEntries(names.map((key) => [key, process.env[key]]));
  try {
    for (const key of names) delete process.env[key];
    Object.assign(process.env, exportEnvironment(values));
    return callback();
  } finally {
    for (const key of names) delete process.env[key];
    for (const [key, prior] of Object.entries(before)) {
      if (prior !== undefined) process.env[key] = prior;
    }
  }
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return `${homedir()}/${path.slice(2)}`;
  return path;
}

export function runtimeHome(environment: Environment = process.env): string {
  const configured = value("HOME", environment);
  if (configured) return resolve(expandHome(configured));
  return resolve(`${homedir()}/${RUNTIME_HOME_DIRECTORY}`);
}

export function runtimeSqlitePath(environment: Environment = process.env): string {
  return `${runtimeHome(environment)}/${RUNTIME_SQLITE_FILENAME}`;
}

export const runtimeRoot = runtimeHome;
export const dbPath = runtimeSqlitePath;
