import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";

import { RuntimeError, type RuntimeRecord } from "../../runtime_types.ts";

const ACTION_TYPE = /^[a-z][a-z0-9_]*$/u;
const ENV_RUNTIME_ENTRYPOINTS = new Set([
  "$AGENTS_ORCHESTRATOR_SKILL_DIR/scripts/agent_orchestrator.ts",
  "$AGENTS_ORCHESTRATOR_SKILL_DIR/scripts/bootstrap.ts",
]);
const TRUSTED_SHELLS = new Set(
  ["/bin/bash", "/bin/sh", "/bin/zsh", "/usr/bin/bash", "/usr/bin/sh", "/usr/bin/zsh"]
    .filter(existsSync)
    .map((path) => realpathSync(path)),
);

export interface PermissionDecision {
  selectedOptionId: string | null;
  allowed: boolean;
}

function payload(value: unknown): RuntimeRecord {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as RuntimeRecord;
  throw new TypeError("ACP permission request must be an official schema object");
}

function kind(option: RuntimeRecord): string {
  return String(option.kind ?? option.name ?? "").toLowerCase();
}

function option(options: unknown[], allow: boolean, onceOnly = false): string | null {
  for (const candidate of options) {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const item = candidate as RuntimeRecord;
    if (typeof item.optionId !== "string" || !item.optionId) continue;
    const value = kind(item);
    const deny = ["deny", "reject", "cancel"].some((token) => value.includes(token));
    const approve = value.includes("allow") || value.includes("approve");
    if (allow && onceOnly && !value.includes("once")) continue;
    if ((allow && approve && !deny) || (!allow && deny)) return item.optionId;
  }
  return null;
}

export function selectedOptionAllows(params: unknown, optionId: string): boolean {
  const options = payload(params).options;
  for (const candidate of Array.isArray(options) ? options : []) {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const item = candidate as RuntimeRecord;
    if (item.optionId !== optionId) continue;
    const value = kind(item);
    const denied = ["deny", "reject", "cancel"].some((token) => value.includes(token));
    return !denied && (value.includes("allow") || value.includes("approve"));
  }
  return false;
}

function canonical(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

function inside(path: string, roots: string[]): boolean {
  return roots.some((root) => {
    const segment = relative(root, path);
    return segment === "" || (!segment.startsWith("..") && !isAbsolute(segment));
  });
}

function locations(params: RuntimeRecord): string[] | null {
  const toolCall = params.toolCall;
  const candidates: unknown[] = [];
  for (const owner of [params, toolCall]) {
    if (owner === null || typeof owner !== "object" || Array.isArray(owner)) continue;
    const value = (owner as RuntimeRecord).locations;
    if (Array.isArray(value)) candidates.push(...value);
  }
  const paths: string[] = [];
  for (const location of candidates) {
    const path = location !== null && typeof location === "object" && !Array.isArray(location)
      ? (location as RuntimeRecord).path : location;
    if (typeof path !== "string" || !isAbsolute(path)) return null;
    paths.push(canonical(path));
  }
  return paths.length ? paths : null;
}

function locationsDeclared(params: RuntimeRecord): boolean {
  for (const owner of [params, params.toolCall]) {
    if (owner === null || typeof owner !== "object" || Array.isArray(owner)) continue;
    const item = owner as RuntimeRecord;
    if (!("locations" in item)) continue;
    if (item.locations !== null && !(Array.isArray(item.locations) && item.locations.length === 0)) return true;
  }
  return false;
}

function runtimeEntrypointMatches(value: string, runtimeEntrypoint?: string): boolean {
  if (ENV_RUNTIME_ENTRYPOINTS.has(value)) return true;
  if (!runtimeEntrypoint || !isAbsolute(value)) return false;
  if (canonical(value) === canonical(runtimeEntrypoint)) return true;
  const bootstrap = runtimeEntrypoint.replace(/agent_orchestrator\.ts$/u, "bootstrap.ts");
  return bootstrap !== runtimeEntrypoint && canonical(value) === canonical(bootstrap);
}

// Deliberately tiny POSIX lexer. It accepts words and the punctuation needed by
// the documented printf pipeline, while rejecting substitutions and malformed quotes.
function shellTokens(script: unknown): string[] | null {
  if (typeof script !== "string" || !script || /[`\n\r]/u.test(script)) return null;
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let started = false;
  const punctuation = new Set(["|", "&", ";", "(", ")", "<", ">"]);
  for (let index = 0; index < script.length; index += 1) {
    const char = script[index]!;
    if (quote !== "'" && char === "\\") {
      const next = script[index + 1];
      if (next === undefined) return null;
      current += next;
      started = true;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      if (quote === null) { quote = char; started = true; continue; }
      if (quote === char) { quote = null; continue; }
      current += char;
      started = true;
      continue;
    }
    if (quote === null && /\s/u.test(char)) {
      if (started) { tokens.push(current); current = ""; started = false; }
      continue;
    }
    if (quote === null && punctuation.has(char)) {
      if (started) { tokens.push(current); current = ""; started = false; }
      tokens.push(char);
      continue;
    }
    if (quote !== "'" && char === "$" && script[index + 1] === "(") return null;
    current += char;
    started = true;
  }
  if (quote !== null) return null;
  if (started) tokens.push(current);
  return tokens;
}

function runtimeCliRequest(params: RuntimeRecord, cwd: string, runtimeEntrypoint?: string): boolean {
  if (!runtimeEntrypoint) return false;
  const toolCall = params.toolCall;
  if (toolCall === null || typeof toolCall !== "object" || Array.isArray(toolCall)) return false;
  const call = toolCall as RuntimeRecord;
  if (call.kind !== "execute") return false;
  const raw = call.rawInput;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return false;
  const input = raw as RuntimeRecord;
  const requestCwd = input.cwd;
  if (typeof requestCwd !== "string" || !isAbsolute(requestCwd) || !inside(canonical(requestCwd), [canonical(cwd)])) return false;
  const command = input.command;
  if (!Array.isArray(command) || command.length !== 3 || !command.every((item) => typeof item === "string")) return false;
  const [shell, flag, script] = command as string[];
  if (!isAbsolute(shell!) || !TRUSTED_SHELLS.has(canonical(shell!)) || !new Set(["-c", "-lc"]).has(flag!)) return false;
  const tokens = shellTokens(script);
  if (!tokens) return false;
  const runtimeCommand = (parts: string[]): boolean => (
    parts.length >= 3 &&
    (parts[0] === "bun" || (isAbsolute(parts[0]!) && canonical(parts[0]!) === canonical(process.execPath))) &&
    runtimeEntrypointMatches(parts[1]!, runtimeEntrypoint)
  );
  if (runtimeCommand(tokens)) {
    if (tokens.length === 3 && tokens[2] === "bootstrap-cwd") return true;
    return tokens.length === 4 && tokens[2] === "action-schema" && ACTION_TYPE.test(tokens[3]!);
  }
  const prefix = "printf '%s' '";
  const separator = "' | ";
  if (!script!.startsWith(prefix)) return false;
  const remainder = script!.slice(prefix.length);
  if (remainder.split(separator).length !== 2) return false;
  const [encoded, consumerScript] = remainder.split(separator) as [string, string];
  if (encoded.includes("'")) return false;
  let decoded: unknown;
  try { decoded = JSON.parse(encoded); } catch { return false; }
  const consumer = shellTokens(consumerScript);
  return Boolean(
    decoded !== null && typeof decoded === "object" && !Array.isArray(decoded) && consumer &&
    runtimeCommand(consumer) && consumer.length === 6 && consumer[2] === "action" &&
    consumer[3] === "--type" && ACTION_TYPE.test(consumer[4]!) && consumer[5] === "--stdin",
  );
}

export function decidePermission(
  request: RequestPermissionRequest | RuntimeRecord,
  options: {
    policy: string;
    cwd: string;
    additionalDirectories?: string[];
    runtimeEntrypoint?: string;
  },
): PermissionDecision {
  const params = payload(request);
  const offered = Array.isArray(params.options) ? params.options : [];
  let allow: boolean;
  let runtimeException = false;
  if (options.policy === "prompt") throw new RuntimeError("ACP permission policy 'prompt' has no headless UI");
  if (options.policy === "allow_all") allow = true;
  else if (options.policy === "deny_all") allow = false;
  else if (options.policy === "allow_in_workspace") {
    const paths = locations(params);
    const roots = [canonical(options.cwd), ...(options.additionalDirectories ?? []).map(canonical)];
    if (paths) allow = paths.every((path) => inside(path, roots));
    else if (locationsDeclared(params)) allow = false;
    else {
      runtimeException = runtimeCliRequest(params, options.cwd, options.runtimeEntrypoint);
      allow = runtimeException;
    }
  } else throw new RuntimeError(`unknown ACP permission policy: ${options.policy}`);
  let selectedOptionId = option(offered, allow, runtimeException);
  if (selectedOptionId === null && allow) selectedOptionId = option(offered, false);
  if (selectedOptionId === null) return { selectedOptionId: null, allowed: false };
  return { selectedOptionId, allowed: selectedOptionAllows(params, selectedOptionId) };
}
