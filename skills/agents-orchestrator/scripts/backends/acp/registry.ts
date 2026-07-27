import { accessSync, constants as fsConstants, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import * as compatEnv from "../../compat_env.ts";
import { isRecord, RuntimeError, type RuntimeRecord, ValueError } from "../../runtime_types.ts";

export const SDK_DISTRIBUTION = "@agentclientprotocol/sdk";
export const SDK_VERSION = "1.3.0";
export const SDK_REQUIREMENT = `${SDK_DISTRIBUTION}@${SDK_VERSION}`;
export const DEFAULT_INSTALL_PROFILES = ["codex", "claude"] as const;

export interface AgentProfile extends RuntimeRecord {
  agent: string;
  command: string;
  args: string[];
  model_tiers: Record<string, string>;
  default_permission_policy: string;
  sandbox: RuntimeRecord;
}

function executable(path: unknown): path is string {
  if (typeof path !== "string" || !isAbsolute(path)) return false;
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function environmentValue(suffix: string, environment: compatEnv.Environment): string | undefined {
  return compatEnv.value(suffix, environment);
}

export function managedRoot(environment: compatEnv.Environment = process.env): string {
  const root = environmentValue("MANAGED_ROOT", environment);
  if (!root || !isAbsolute(root)) {
    throw new RuntimeError("managed TypeScript dependency cache is unavailable; run through scripts/bootstrap.ts");
  }
  return resolve(root);
}

export function dependencyHome(environment: compatEnv.Environment = process.env): string {
  const configured = environmentValue("DEPENDENCY_HOME", environment);
  if (configured) {
    if (!isAbsolute(configured)) throw new ValueError("dependency home must be an absolute path");
    return resolve(configured);
  }
  return dirname(managedRoot(environment));
}

function packageMetadata(root: string, packageName: string): RuntimeRecord | null {
  const path = join(root, "node_modules", ...packageName.split("/"), "package.json");
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

export function ensureSdkAvailable(
  environment: compatEnv.Environment = process.env,
): RuntimeRecord {
  const root = managedRoot(environment);
  const metadata = packageMetadata(root, SDK_DISTRIBUTION);
  if (metadata?.name !== SDK_DISTRIBUTION || metadata.version !== SDK_VERSION) {
    throw new RuntimeError(
      `managed ACP SDK ${SDK_VERSION} is unavailable; retry through scripts/bootstrap.ts to rebuild the dependency cache`,
    );
  }
  return {
    distribution: SDK_DISTRIBUTION,
    version: SDK_VERSION,
    requirement: SDK_REQUIREMENT,
    source: "managed-bun-cache",
    installed: false,
    installer: "bun",
    runtime_key: basenameForRoot(root),
    target: root,
    available: true,
  };
}

function basenameForRoot(path: string): string {
  const parts = path.split(/[\\/]/u).filter(Boolean);
  return parts.at(-1) ?? path;
}

export const PROFILES: Readonly<Record<string, Omit<AgentProfile, "agent">>> = Object.freeze({
  claude: {
    command: "claude-agent-acp",
    args: [],
    model_tiers: { strong: "opus", balanced: "sonnet", fast: "haiku" },
    auth_prerequisites: ["Existing Claude login or ANTHROPIC_API_KEY"],
    default_permission_policy: "allow_all",
    profile_version: "0.62.0",
    package: "@agentclientprotocol/claude-agent-acp",
    install_hint: "retry through scripts/bootstrap.ts to install @agentclientprotocol/claude-agent-acp@0.62.0",
    sandbox: {
      mechanism: "agent-mode",
      workspace_write_mode: "default",
      outside_workspace: "agent-defined",
      missing_behavior: "fail_closed",
    },
  },
  codex: {
    command: "codex-acp",
    args: [],
    model_tiers: {
      strong: "gpt-5.6-sol",
      balanced: "gpt-5.6-terra",
      fast: "gpt-5.6-luna",
    },
    auth_prerequisites: ["Existing ChatGPT login, CODEX_API_KEY, or OPENAI_API_KEY"],
    default_permission_policy: "allow_all",
    profile_version: "1.1.7",
    package: "@agentclientprotocol/codex-acp",
    install_hint: "retry through scripts/bootstrap.ts to install @agentclientprotocol/codex-acp@1.1.7",
    sandbox: {
      mechanism: "agent-mode",
      workspace_write_mode: "auto",
      outside_workspace: "agent-defined",
      missing_behavior: "fail_closed",
    },
  },
  gemini: {
    command: "gemini",
    args: ["--acp"],
    model_tiers: { strong: "default", balanced: "default", fast: "default" },
    auth_prerequisites: ["Existing Gemini login or GEMINI_API_KEY"],
    default_permission_policy: "allow_in_workspace",
    profile_version: "0.41.0",
    package: "@google/gemini-cli",
    install_hint: "select the gemini profile through scripts/bootstrap.ts to install @google/gemini-cli@0.41.0",
    sandbox: {
      mechanism: "agent-mode",
      workspace_write_mode: "default",
      outside_workspace: "agent-defined",
      missing_behavior: "fail_closed",
    },
  },
});

function cloneProfile(profile: Omit<AgentProfile, "agent">): Omit<AgentProfile, "agent"> {
  return {
    ...profile,
    args: [...profile.args],
    model_tiers: { ...profile.model_tiers },
    auth_prerequisites: [...(profile.auth_prerequisites as string[])],
    sandbox: { ...profile.sandbox },
  };
}

export function resolveProfile(
  agent: string,
  options: { command?: string; args?: string[] } = {},
): AgentProfile {
  if (agent === "custom") {
    if (!options.command) throw new ValueError("custom ACP agent requires an explicit command");
    return {
      agent,
      command: options.command,
      args: [...(options.args ?? [])],
      model_tiers: { strong: "default", balanced: "default", fast: "default" },
      auth_prerequisites: ["Agent-specific authentication"],
      default_permission_policy: "allow_in_workspace",
      profile_version: null,
      package: null,
      install_hint: null,
      user_override: true,
      command_override: true,
      sandbox: {
        mechanism: "agent-specific",
        workspace_write_mode: null,
        outside_workspace: "unknown",
        missing_behavior: "fail_closed",
      },
    };
  }
  const builtIn = PROFILES[agent];
  if (!builtIn) throw new ValueError(`unsupported ACP agent profile: ${agent}`);
  const cloned = cloneProfile(builtIn);
  const profile: AgentProfile = {
    agent,
    command: cloned.command,
    args: [...cloned.args],
    model_tiers: { ...cloned.model_tiers },
    default_permission_policy: cloned.default_permission_policy,
    sandbox: { ...cloned.sandbox },
    ...cloned,
    user_override: options.command !== undefined || options.args !== undefined,
    command_override: options.command !== undefined,
  };
  if (options.command !== undefined) profile.command = options.command;
  if (options.args !== undefined) profile.args = [...options.args];
  return profile;
}

function managedCommand(profile: RuntimeRecord, environment: compatEnv.Environment): string | null {
  if (profile.command_override || profile.agent === "custom") return null;
  const name = profile.command;
  if (typeof name !== "string" || !name) return null;
  return join(dependencyHome(environment), "bin", name);
}

export function freezeProfile(
  profile: AgentProfile,
  environment: compatEnv.Environment = process.env,
): AgentProfile {
  const frozen: AgentProfile = {
    ...profile,
    args: [...(profile.args ?? [])],
    model_tiers: { ...(profile.model_tiers ?? {}) },
    sandbox: { ...(profile.sandbox ?? {}) },
  };
  const command = profile.command;
  if (!command) throw new ValueError("ACP Agent command is not configured");
  if (profile.agent === "custom" && !isAbsolute(command)) {
    throw new ValueError("custom ACP command must be an absolute path");
  }
  let resolvedCommand: string | null = null;
  if (isAbsolute(command)) resolvedCommand = resolve(command);
  else {
    const managed = managedCommand(profile, environment);
    if (managed && executable(managed)) resolvedCommand = resolve(managed);
    else resolvedCommand = Bun.which(command, { PATH: environment.PATH }) ?? null;
  }
  frozen.requested_command = profile.requested_command ?? command;
  frozen.resolved_command = resolvedCommand;
  frozen.managed_install = profile.managed_install ? { ...profile.managed_install } : {};
  return frozen;
}

export function installProfile(
  profile: AgentProfile,
  environment: compatEnv.Environment = process.env,
): AgentProfile {
  if (profile.agent === "custom" || profile.command_override) return profile;
  ensureSdkAvailable(environment);
  const expectedPackage = profile.package;
  const expectedVersion = profile.profile_version;
  const metadata = typeof expectedPackage === "string"
    ? packageMetadata(managedRoot(environment), expectedPackage)
    : null;
  if (metadata?.name !== expectedPackage || metadata?.version !== expectedVersion) {
    throw new RuntimeError(
      `managed ACP Agent ${profile.agent}@${expectedVersion} is unavailable; retry through scripts/bootstrap.ts`,
    );
  }
  const command = managedCommand(profile, environment);
  if (!executable(command)) {
    throw new RuntimeError(`managed ACP Agent executable is unavailable: ${profile.command}`);
  }
  return {
    ...profile,
    command,
    requested_command: profile.command,
    managed_install: {
      dependency_home: dependencyHome(environment),
      managed_root: managedRoot(environment),
      package: expectedPackage,
      version: expectedVersion,
      command,
    },
  };
}

export function installDefaultProfiles(
  environment: compatEnv.Environment = process.env,
): Record<string, AgentProfile> {
  return Object.fromEntries(
    DEFAULT_INSTALL_PROFILES.map((name) => [name, installProfile(resolveProfile(name), environment)]),
  );
}

export function ensureAvailable(
  profile: RuntimeRecord,
  environment: compatEnv.Environment = process.env,
): string {
  const command = profile.resolved_command ?? profile.command;
  if (executable(command)) return command;
  const managed = managedCommand(profile, environment);
  if (executable(managed)) {
    const frozen = profile.resolved_command;
    if (typeof frozen === "string" && resolve(managed) !== resolve(frozen)) {
      throw new RuntimeError("managed ACP Agent reinstall changed its frozen executable");
    }
    return managed;
  }
  const requested = profile.requested_command ?? profile.command ?? "<unset>";
  let message = `ACP Agent executable is unavailable or not executable: ${requested}`;
  if (profile.install_hint && !profile.user_override) message += `; ${profile.install_hint}`;
  throw new RuntimeError(message);
}

export function preflight(
  profile: RuntimeRecord,
  environment: compatEnv.Environment = process.env,
): RuntimeRecord {
  const report: RuntimeRecord = {
    backend: "acp",
    agent: profile.agent,
    command: profile.requested_command ?? profile.command,
    resolved_command: profile.resolved_command,
    args: [...(profile.args ?? [])],
    profile_version: profile.profile_version,
    package: profile.package,
    auth_prerequisites: [...(profile.auth_prerequisites ?? [])],
    default_permission_policy: profile.default_permission_policy,
    sandbox: { ...(profile.sandbox ?? {}) },
    available: false,
  };
  try {
    report.sdk = ensureSdkAvailable(environment);
  } catch (error) {
    report.sdk = {
      requirement: SDK_REQUIREMENT,
      available: false,
      error: error instanceof Error ? error.message : "managed SDK is unavailable",
    };
  }
  try {
    report.executable = ensureAvailable(profile, environment);
    report.available = Boolean(report.sdk.available);
  } catch (error) {
    report.error = error instanceof Error ? error.message : "ACP Agent is unavailable";
  }
  return report;
}
