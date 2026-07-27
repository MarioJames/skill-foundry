import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";

import * as compatEnv from "./compat_env.ts";
import { isRecord, type RuntimeRecord, ValueError } from "./runtime_types.ts";
import * as registry from "./backends/acp/registry.ts";

export const BACKENDS = new Set(["claude_cli", "acp"]);
export const PERMISSION_POLICIES = new Set(["allow_in_workspace", "allow_all", "deny_all", "prompt"]);
export const DEFAULT_BACKEND = "acp";
export const DEFAULT_PROFILE = "codex";

compatEnv.promoteCanonicalEnvironment();

function configured(
  explicit: string | undefined,
  environment: compatEnv.Environment,
  suffix: string,
  fallback?: string,
): string | undefined {
  return explicit ?? compatEnv.value(suffix, environment, fallback);
}

function executable(path: string): boolean {
  try {
    return statSync(path).isFile() && (accessSync(path, fsConstants.X_OK), true);
  } catch {
    return false;
  }
}

function claudeCommand(environment: compatEnv.Environment): string {
  const override = configured(undefined, environment, "CLAUDE_BIN");
  if (override) return override;
  for (const entry of (environment.PATH ?? "").split(delimiter)) {
    if (!entry) continue;
    const candidate = join(entry, "claude");
    if (executable(candidate) && !candidate.split(/[\\/]/u).includes(".superconductor")) return candidate;
  }
  return Bun.which("claude", { PATH: environment.PATH }) ?? "claude";
}

function parseArgs(value: unknown): string[] {
  let selected: unknown = value;
  if (selected === null || selected === undefined) return [];
  if (typeof selected === "string") {
    try {
      selected = JSON.parse(selected) as unknown;
    } catch {
      throw new ValueError("AGENTS_ORCHESTRATOR_ACP_ARGS must be a JSON array");
    }
  }
  if (!Array.isArray(selected) || !selected.every((item): item is string => typeof item === "string")) {
    throw new ValueError("ACP args must be an array of strings");
  }
  return [...selected];
}

function parseProfileNames(value: unknown): string[] | null {
  if (value === null || value === undefined) return null;
  let selected: unknown = value;
  if (typeof selected === "string") {
    const stripped = selected.trim();
    if (!stripped) return null;
    try {
      selected = JSON.parse(stripped) as unknown;
    } catch {
      selected = stripped.split(",").map((item) => item.trim()).filter(Boolean);
    }
  }
  if (isRecord(selected)) selected = Object.keys(selected);
  if (!Array.isArray(selected) || !selected.every((item): item is string => typeof item === "string" && item.trim().length > 0)) {
    throw new ValueError("profile allowlist must be an array of profile names");
  }
  const names = selected.map((item) => item.trim());
  if (new Set(names).size !== names.length) throw new ValueError("profile allowlist contains duplicate profiles");
  if (names.length === 0) throw new ValueError("profile allowlist must not be empty");
  return names;
}

function profileAllowlist(explicit: unknown, environment: compatEnv.Environment): string[] | null {
  if (explicit !== undefined && explicit !== null) return parseProfileNames(explicit);
  let raw: string | undefined;
  let selectedSuffix: string | undefined;
  for (const suffix of [
    "ACP_PROFILE_ALLOWLIST",
    "PROFILE_ALLOWLIST",
    "ACP_PROFILES",
    "PROFILES",
    "ALLOWED_PROFILES",
  ]) {
    const candidate = compatEnv.value(suffix, environment);
    if (candidate === undefined) continue;
    if (raw !== undefined && candidate !== raw) {
      throw new ValueError(`conflicting profile allowlist environment: ${selectedSuffix} and ${suffix}`);
    }
    raw = candidate;
    selectedSuffix = suffix;
  }
  return parseProfileNames(raw);
}

function defaultProfile(explicit: string | undefined, environment: compatEnv.Environment): string | undefined {
  if (explicit !== undefined) return explicit;
  const primary = compatEnv.value("ACP_DEFAULT_PROFILE", environment);
  const alias = compatEnv.value("DEFAULT_PROFILE", environment);
  if (primary !== undefined && alias !== undefined && primary !== alias) {
    throw new ValueError("conflicting default profile environment: ACP_DEFAULT_PROFILE and DEFAULT_PROFILE");
  }
  return primary ?? alias;
}

function freezeAcpProfile(
  name: string,
  options: {
    environment: compatEnv.Environment;
    command?: string;
    args?: string[];
    permission?: string;
    installDependencies?: boolean;
  },
): RuntimeRecord {
  let profile = registry.resolveProfile(name, { command: options.command, args: options.args });
  const selectedPermission = options.permission ?? profile.default_permission_policy ?? "allow_in_workspace";
  if (!PERMISSION_POLICIES.has(selectedPermission)) {
    throw new ValueError(`unsupported ACP permission policy: ${selectedPermission}`);
  }
  if (selectedPermission === "prompt") throw new ValueError("ACP permission policy 'prompt' has no headless UI");
  if (options.installDependencies && !profile.command_override) {
    profile = registry.installProfile(profile, options.environment);
  }
  profile = registry.freezeProfile(profile, options.environment);
  return {
    backend: "acp",
    agent: name,
    command: profile.command,
    requested_command: profile.requested_command,
    resolved_command: profile.resolved_command,
    args: [...profile.args],
    model_tiers: { ...profile.model_tiers },
    auth_prerequisites: [...(profile.auth_prerequisites as string[])],
    default_permission_policy: profile.default_permission_policy,
    profile_version: profile.profile_version,
    package: profile.package,
    install_hint: profile.install_hint,
    user_override: profile.user_override,
    command_override: Boolean(profile.command_override),
    managed_install: { ...(profile.managed_install ?? {}) },
    sandbox: { ...profile.sandbox },
    permission_policy: selectedPermission,
    prompt_timeout_seconds: null,
    session_close_on_stop: true,
    turn_end_reprompt_limit: 1,
  };
}

function legacyClaudeProfile(environment: compatEnv.Environment): RuntimeRecord {
  return {
    backend: "claude_cli",
    agent: "claude",
    command: claudeCommand(environment),
    args: [],
    model_tiers: { strong: "opus", balanced: "sonnet", fast: "haiku" },
    permission_policy: "bypassPermissions",
  };
}

export interface ResolveRunExecutionOptions {
  backend?: string;
  acpAgent?: string;
  acpCommand?: string;
  acpArgs?: unknown;
  acpPermissionPolicy?: string;
  profileAllowlist?: unknown;
  allowedProfiles?: unknown;
  profiles?: unknown;
  defaultProfile?: string;
  environment?: compatEnv.Environment;
  installDependencies?: boolean;
}

export function resolveRunExecution(options: ResolveRunExecutionOptions = {}): RuntimeRecord {
  const environment = options.environment ?? process.env;
  compatEnv.validateIdentity(environment);
  const backend = configured(options.backend, environment, "BACKEND", DEFAULT_BACKEND)!;
  if (!BACKENDS.has(backend)) throw new ValueError("backend must be claude_cli or acp");
  const declaredArguments = [options.profileAllowlist, options.allowedProfiles, options.profiles].filter(
    (item) => item !== undefined && item !== null,
  );
  if (declaredArguments.length > 1) {
    throw new ValueError("provide only one of profile_allowlist, allowed_profiles, or profiles");
  }
  let declaredProfiles = profileAllowlist(declaredArguments[0], environment);
  const explicitDefault = defaultProfile(options.defaultProfile, environment);
  const agent = configured(options.acpAgent, environment, "ACP_AGENT");
  const command = configured(options.acpCommand, environment, "ACP_COMMAND");
  const rawArgs = options.acpArgs !== undefined
    ? options.acpArgs
    : configured(undefined, environment, "ACP_ARGS");
  const args = parseArgs(rawArgs);
  const permission = configured(options.acpPermissionPolicy, environment, "ACP_PERMISSION_POLICY");
  if (command !== undefined && !command) throw new ValueError("ACP command must be a non-empty string");

  if (backend === "claude_cli") {
    const profile = legacyClaudeProfile(environment);
    return {
      backend: "claude_cli",
      default_profile: "claude_cli",
      profile_allowlist: ["claude_cli"],
      profiles: { claude_cli: profile },
      claude_cli: { command: profile.command },
      acp: {},
      routing: { strategy: "round_robin", by_intent: {}, by_model_tier: {} },
    };
  }

  if (agent !== undefined && !agent) throw new ValueError("ACP agent must be a non-empty string");
  if (explicitDefault !== undefined && !explicitDefault.trim()) {
    throw new ValueError("default profile must be a non-empty string");
  }
  let selectedDefault = explicitDefault?.trim() || agent;
  if (declaredProfiles === null) {
    selectedDefault = selectedDefault ?? DEFAULT_PROFILE;
    declaredProfiles = [selectedDefault];
  } else {
    selectedDefault = selectedDefault ?? (declaredProfiles.includes(DEFAULT_PROFILE) ? DEFAULT_PROFILE : declaredProfiles[0]);
  }
  if (selectedDefault === undefined) throw new ValueError("default profile is unavailable");
  if (agent !== undefined && selectedDefault !== agent) throw new ValueError("ACP agent conflicts with the default profile");
  if (!declaredProfiles.includes(selectedDefault)) {
    throw new ValueError("default profile must be present in the profile allowlist");
  }
  if (declaredProfiles.includes("custom") && (declaredProfiles.length !== 1 || selectedDefault !== "custom")) {
    throw new ValueError("custom ACP profile must be the sole allowlisted profile");
  }

  if (options.installDependencies) {
    registry.ensureSdkAvailable(environment);
    registry.installDefaultProfiles(environment);
  }
  const profiles: Record<string, RuntimeRecord> = {};
  for (const name of declaredProfiles) {
    profiles[name] = freezeAcpProfile(name, {
      environment,
      command: name === selectedDefault ? command : undefined,
      args: name === selectedDefault && rawArgs !== undefined ? args : undefined,
      permission,
      installDependencies: options.installDependencies,
    });
  }
  const defaultRecord = profiles[selectedDefault]!;
  return {
    backend: "acp",
    default_profile: selectedDefault,
    profile_allowlist: [...declaredProfiles],
    profiles,
    claude_cli: { command: claudeCommand(environment) },
    acp: { ...defaultRecord },
    routing: { strategy: "round_robin", by_intent: {}, by_model_tier: {} },
  };
}

export function loadRunExecution(run: RuntimeRecord | null): RuntimeRecord {
  const raw = run?.execution_config_json;
  if (!raw) {
    return resolveRunExecution({ backend: "claude_cli", environment: { PATH: process.env.PATH ?? "" } });
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ValueError("run execution_config_json is invalid");
  }
  if (!isRecord(value) || typeof value.backend !== "string" || !BACKENDS.has(value.backend)) {
    throw new ValueError("run execution_config_json has an unsupported backend");
  }
  return value;
}

function allowedProfiles(execution: RuntimeRecord): [string[], Record<string, RuntimeRecord>, string] {
  const profiles = execution.profiles;
  const allowlist = execution.profile_allowlist;
  if (isRecord(profiles) && Array.isArray(allowlist) && allowlist.length > 0) {
    if (!allowlist.every((name): name is string => typeof name === "string" && name in profiles)) {
      throw new ValueError("run profile allowlist is invalid");
    }
    const defaultProfileName = execution.default_profile;
    if (typeof defaultProfileName !== "string" || !allowlist.includes(defaultProfileName)) {
      throw new ValueError("run default profile is not allowlisted");
    }
    return [allowlist, profiles as Record<string, RuntimeRecord>, defaultProfileName];
  }
  if (execution.backend === "claude_cli") {
    const profile = legacyClaudeProfile({ PATH: process.env.PATH ?? "" });
    profile.command = execution.claude_cli?.command ?? "claude";
    return [["claude_cli"], { claude_cli: profile }, "claude_cli"];
  }
  const acp = isRecord(execution.acp) ? { ...execution.acp } : {};
  const name = typeof acp.agent === "string" ? acp.agent : "claude";
  acp.backend = "acp";
  acp.agent = name;
  return [[name], { [name]: acp }, name];
}

export function selectProfile(
  execution: RuntimeRecord,
  options: { profileHint?: string | null; routingIndex?: number } = {},
): [string, RuntimeRecord] {
  const [allowlist, profiles, defaultProfileName] = allowedProfiles(execution);
  const hint = options.profileHint;
  if (hint !== undefined && hint !== null) {
    if (!hint) throw new ValueError("child profile_hint must be a non-empty string");
    if (!allowlist.includes(hint)) {
      throw new ValueError("child profile_hint is not present in the Run profile allowlist");
    }
    return [hint, profiles[hint]!];
  }
  if (allowlist.length === 1) return [defaultProfileName, profiles[defaultProfileName]!];
  const index = options.routingIndex ?? 0;
  if (!Number.isSafeInteger(index)) throw new ValueError("profile routing index must be an integer");
  const start = allowlist.indexOf(defaultProfileName);
  const name = allowlist[(start + index) % allowlist.length]!;
  return [name, profiles[name]!];
}

export function snapshotAttempt(
  run: RuntimeRecord,
  options: {
    model?: string;
    modelTier?: string;
    profileHint?: string | null;
    routingIndex?: number;
  } = {},
): RuntimeRecord {
  const execution = loadRunExecution(run);
  const [profileName, profile] = selectProfile(execution, {
    profileHint: options.profileHint,
    routingIndex: options.routingIndex,
  });
  const backend = profile.backend ?? execution.backend;
  let model = options.model;
  if (options.modelTier !== undefined) model = profile.model_tiers?.[options.modelTier] ?? options.modelTier;
  if (backend === "claude_cli") {
    return {
      backend,
      agent: "claude",
      profile: profileName,
      command: profile.command ?? "claude",
      args: [],
      model,
      permission_policy: "bypassPermissions",
    };
  }
  return {
    backend,
    agent: profile.agent ?? profileName,
    profile: profileName,
    command: profile.resolved_command,
    requested_command: profile.requested_command ?? profile.command,
    args: [...(profile.args ?? [])],
    model,
    permission_policy: profile.permission_policy ?? "allow_in_workspace",
    prompt_timeout_seconds: profile.prompt_timeout_seconds ?? null,
    session_close_on_stop: profile.session_close_on_stop ?? true,
    turn_end_reprompt_limit: profile.turn_end_reprompt_limit ?? 1,
    profile_version: profile.profile_version,
    package: profile.package,
    install_hint: profile.install_hint,
    auth_prerequisites: [...(profile.auth_prerequisites ?? [])],
    user_override: Boolean(profile.user_override),
    command_override: Boolean(profile.command_override),
    managed_install: { ...(profile.managed_install ?? {}) },
    sandbox: { ...(profile.sandbox ?? {}) },
  };
}

export function supportsHooks(execution: RuntimeRecord): boolean {
  return execution.backend === "claude_cli";
}
