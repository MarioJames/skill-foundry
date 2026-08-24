#!/usr/bin/env bun
/** Install the persistent-ssh-ops zsh runtime and user profile template. */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const RUNTIME_SOURCE = join(SCRIPT_DIRECTORY, "server-runtime.zsh");
const PROFILES_SOURCE = join(SCRIPT_DIRECTORY, "..", "assets", "servers.zsh");
const MANAGED_MARKER = "Managed by persistent-ssh-ops";
const RUNTIME_SOURCE_LINE = '[[ -f "$HOME/.config/zsh/server-runtime.zsh" ]] && source "$HOME/.config/zsh/server-runtime.zsh"';
const PROFILES_SOURCE_LINE = '[[ -f "$HOME/.config/zsh/servers.zsh" ]] && source "$HOME/.config/zsh/servers.zsh"';

type FileStatus = "created" | "updated" | "unchanged" | "preserved";

export interface InitResult {
  runtime: FileStatus;
  profiles: FileStatus;
  zshrc: FileStatus;
}

function installRuntime(target: string): FileStatus {
  const desired = readFileSync(RUNTIME_SOURCE, "utf8");
  if (!existsSync(target)) {
    writeFileSync(target, desired, { mode: 0o700 });
    chmodSync(target, 0o700);
    return "created";
  }

  const current = readFileSync(target, "utf8");
  if (!current.includes(MANAGED_MARKER)) {
    throw new Error(`refusing to overwrite unmanaged runtime: ${target}`);
  }
  if (current === desired) {
    chmodSync(target, 0o700);
    return "unchanged";
  }

  writeFileSync(target, desired);
  chmodSync(target, 0o700);
  return "updated";
}

function installProfiles(target: string): FileStatus {
  if (existsSync(target)) {
    chmodSync(target, 0o600);
    return "preserved";
  }

  writeFileSync(target, readFileSync(PROFILES_SOURCE, "utf8"), { mode: 0o600 });
  chmodSync(target, 0o600);
  return "created";
}

function updateZshrc(target: string): FileStatus {
  const exists = existsSync(target);
  const current = exists ? readFileSync(target, "utf8") : "";
  const lines = current.split("\n");
  const hasRuntime = lines.includes(RUNTIME_SOURCE_LINE);
  const hasProfiles = lines.includes(PROFILES_SOURCE_LINE);
  if (hasRuntime && hasProfiles) return "unchanged";

  let updated = current;
  if (!hasRuntime && hasProfiles) {
    updated = updated.replace(PROFILES_SOURCE_LINE, `${RUNTIME_SOURCE_LINE}\n${PROFILES_SOURCE_LINE}`);
  } else {
    if (updated.length > 0 && !updated.endsWith("\n")) updated += "\n";
    if (updated.length > 0 && !updated.endsWith("\n\n")) updated += "\n";
    if (!hasRuntime) updated += `${RUNTIME_SOURCE_LINE}\n`;
    if (!hasProfiles) updated += `${PROFILES_SOURCE_LINE}\n`;
  }

  const mode = exists ? statSync(target).mode & 0o777 : 0o600;
  writeFileSync(target, updated, { mode });
  chmodSync(target, mode);
  return "updated";
}

export function initializeServerConfig(home: string = homedir()): InitResult {
  const resolvedHome = resolve(home);
  const configDirectory = join(resolvedHome, ".config", "zsh");
  const runtimeTarget = join(configDirectory, "server-runtime.zsh");
  const profilesTarget = join(configDirectory, "servers.zsh");
  const zshrcTarget = join(resolvedHome, ".zshrc");

  mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
  const runtime = installRuntime(runtimeTarget);
  const profiles = installProfiles(profilesTarget);
  const zshrc = updateZshrc(zshrcTarget);
  return { runtime, profiles, zshrc };
}

function printHelp(): void {
  console.log("Usage: bun init-server-config.ts [--home <path>]");
  console.log("Install the zsh server runtime, user profile template, and .zshrc source lines.");
}

export function main(args: string[] = Bun.argv.slice(2)): number {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    printHelp();
    return 0;
  }

  let home = homedir();
  if (args.length === 2 && args[0] === "--home") {
    home = args[1]!;
  } else if (args.length > 0) {
    console.error(`init-server-config: unexpected arguments: ${args.join(" ")}`);
    return 2;
  }

  try {
    console.log(JSON.stringify(initializeServerConfig(home), null, 2));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`init-server-config: ${message}`);
    return 1;
  }
}

if (import.meta.main) process.exit(main());
