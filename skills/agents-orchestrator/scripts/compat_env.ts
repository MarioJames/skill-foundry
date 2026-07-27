import { homedir } from "node:os";
import { resolve } from "node:path";

import { ValueError } from "./runtime_types.ts";

export const CANONICAL_PREFIX = "AGENTS_ORCHESTRATOR_";
export const LEGACY_PREFIX = "AGENT_SWARM_";
export const RUNTIME_HOME_DIRECTORY = ".agent-swarm";
export const RUNTIME_SQLITE_FILENAME = "runtime.sqlite3";

export const IDENTITY_SUFFIXES = ["ROOT_ID", "TASK_ID", "ATTEMPT_ID", "ACTOR_TOKEN"] as const;
export const BOUNDARY_SUFFIXES = [...IDENTITY_SUFFIXES, "HOME", "SKILL_DIR"] as const;
export const TRANSIENT_IDENTITY_SUFFIXES = ["AGENT_ID", "EXECUTION_NONCE"] as const;

export type Environment = Record<string, string | undefined>;

export function canonicalName(suffix: string): string {
  return `${CANONICAL_PREFIX}${suffix}`;
}

export function legacyName(suffix: string): string {
  return `${LEGACY_PREFIX}${suffix}`;
}

function nonempty(environment: Environment, name: string): string | undefined {
  const raw = environment[name];
  if (typeof raw !== "string") return undefined;
  const rendered = raw.trim();
  return rendered === "" ? undefined : rendered;
}

export function value(
  suffix: string,
  environment: Environment = process.env,
  defaultValue?: string,
): string | undefined {
  const primaryName = canonicalName(suffix);
  const fallbackName = legacyName(suffix);
  const primary = nonempty(environment, primaryName);
  const fallback = nonempty(environment, fallbackName);
  if (primary !== undefined && fallback !== undefined && primary !== fallback) {
    throw new ValueError(`conflicting orchestration environment: ${primaryName} does not match ${fallbackName}`);
  }
  return primary ?? fallback ?? defaultValue;
}

export function validateIdentity(environment: Environment = process.env): Record<string, string | undefined> {
  for (const prefix of [CANONICAL_PREFIX, LEGACY_PREFIX]) {
    const present = IDENTITY_SUFFIXES.filter((suffix) => nonempty(environment, `${prefix}${suffix}`) !== undefined);
    if (present.length > 0 && present.length !== IDENTITY_SUFFIXES.length) {
      const missing = IDENTITY_SUFFIXES
        .filter((suffix) => !present.includes(suffix))
        .map((suffix) => `${prefix}${suffix}`);
      throw new ValueError(`partial orchestration identity: missing ${missing.join(", ")}`);
    }
  }
  return Object.fromEntries(IDENTITY_SUFFIXES.map((suffix) => [suffix, value(suffix, environment)]));
}

export function promoteCanonicalEnvironment(environment: Environment = process.env): Environment {
  validateIdentity(environment);
  const suffixes = new Set<string>(BOUNDARY_SUFFIXES);
  for (const name of Object.keys(environment)) {
    if (name.startsWith(CANONICAL_PREFIX) && name.length > CANONICAL_PREFIX.length) {
      suffixes.add(name.slice(CANONICAL_PREFIX.length));
    }
  }
  for (const suffix of [...suffixes].sort()) {
    const primary = nonempty(environment, canonicalName(suffix));
    const fallback = nonempty(environment, legacyName(suffix));
    if (primary !== undefined && fallback !== undefined && primary !== fallback) value(suffix, environment);
    if (primary !== undefined && fallback === undefined) environment[legacyName(suffix)] = primary;
  }
  return environment;
}

export function exportBoth(
  values: Record<string, unknown>,
  options: { base?: Environment; scrubIdentity?: boolean } = {},
): Environment {
  const result: Environment = { ...(options.base ?? {}) };
  if (options.scrubIdentity) {
    for (const suffix of [...IDENTITY_SUFFIXES, ...TRANSIENT_IDENTITY_SUFFIXES]) {
      delete result[canonicalName(suffix)];
      delete result[legacyName(suffix)];
    }
  }
  for (const [suffix, raw] of Object.entries(values)) {
    if (raw === null || raw === undefined) continue;
    const rendered = String(raw);
    result[canonicalName(suffix)] = rendered;
    result[legacyName(suffix)] = rendered;
  }
  return result;
}

export function withProcessBoundary<T>(values: Record<string, unknown>, callback: () => T): T {
  const names = [
    ...[...IDENTITY_SUFFIXES, ...TRANSIENT_IDENTITY_SUFFIXES, "HOME", "SKILL_DIR"].flatMap((suffix) => [
      canonicalName(suffix),
      legacyName(suffix),
    ]),
  ];
  const before = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    Object.assign(process.env, exportBoth(values));
    return callback();
  } finally {
    for (const name of names) delete process.env[name];
    for (const [name, prior] of Object.entries(before)) {
      if (prior !== undefined) process.env[name] = prior;
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
  return resolve(expandHome(configured ?? `${homedir()}/${RUNTIME_HOME_DIRECTORY}`));
}

export function runtimeSqlitePath(environment: Environment = process.env): string {
  return `${runtimeHome(environment)}/${RUNTIME_SQLITE_FILENAME}`;
}

export const runtimeRoot = runtimeHome;
export const dbPath = runtimeSqlitePath;
