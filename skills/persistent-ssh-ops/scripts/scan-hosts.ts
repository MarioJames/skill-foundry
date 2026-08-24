#!/usr/bin/env bun
/** Discover registered server profiles and SSH aliases from the effective login shell. */

import { existsSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, join } from "node:path";

const SAFE_ALIAS = /^[A-Za-z_][A-Za-z0-9_.-]*$/u;
const SAFE_PROFILE = /^[a-z][a-z0-9_]*$/u;
const SSH_COMMAND = /^\s*(?:(?:builtin|command|exec)\s+)?(?<transport>autossh|mosh|ssh)(?:\s|$)/u;

export interface DiscoveryRecord {
  kind: "alias" | "profile";
  name: string;
  value: string;
}

export interface ServerProfile {
  name: string;
  uri: string;
}

export interface HostAlias {
  alias: string;
  transport: "autossh" | "mosh" | "ssh";
  command: string;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

export function loginShell(): string {
  const configured = process.env.SHELL || userInfo().shell;
  const shell = configured ? expandHome(configured) : "";
  if (!shell || !existsSync(shell) || !statSync(shell).isFile()) {
    throw new Error("the configured login shell is unavailable");
  }
  return shell;
}

export function captureCommand(shellName: string, begin: string, end: string): string {
  const quotedBegin = shellQuote(begin);
  const quotedEnd = shellQuote(end);

  if (shellName === "zsh") {
    return `
printf '%s\\0' ${quotedBegin}
for alias_name in \${(ok)aliases}; do
  printf 'alias\\0%s\\0%s\\0' "$alias_name" "$aliases[$alias_name]"
done
if (( \${+functions[server_ssh]} )) && [[ "\${(t)SERVER_PROFILES}" == *association* ]]; then
  for profile_name in \${(ok)SERVER_PROFILES}; do
    printf 'profile\\0%s\\0%s\\0' "$profile_name" "$SERVER_PROFILES[$profile_name]"
  done
fi
printf '%s\\0' ${quotedEnd}
`;
  }

  if (shellName === "bash") {
    return `
printf '%s\\0' ${quotedBegin}
while IFS= read -r alias_name; do
  printf 'alias\\0%s\\0%s\\0' "$alias_name" "\${BASH_ALIASES[$alias_name]}"
done < <(printf '%s\\n' "\${!BASH_ALIASES[@]}" | LC_ALL=C sort)
printf '%s\\0' ${quotedEnd}
`;
  }

  throw new Error(`unsupported login shell: ${shellName}`);
}

export function parseDiscoveryStream(stdout: Uint8Array, begin: string, end: string): DiscoveryRecord[] {
  const bytes = Buffer.from(stdout);
  const beginMarker = Buffer.from(`${begin}\0`);
  const endMarker = Buffer.from(`${end}\0`);
  const start = bytes.indexOf(beginMarker);
  const stop = start < 0 ? -1 : bytes.indexOf(endMarker, start + beginMarker.length);
  if (start < 0 || stop < 0) {
    throw new Error("could not read aliases from the effective login shell");
  }

  const fields = bytes.subarray(start + beginMarker.length, stop).toString("utf8").split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length % 3 !== 0) {
    throw new Error("the login shell returned an invalid discovery stream");
  }

  const records: DiscoveryRecord[] = [];
  for (let index = 0; index < fields.length; index += 3) {
    const kind = fields[index];
    if (kind !== "alias" && kind !== "profile") continue;
    records.push({ kind, name: fields[index + 1]!, value: fields[index + 2]! });
  }
  return records;
}

export function effectiveDiscovery(shell: string): DiscoveryRecord[] {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const begin = `__PERSISTENT_SSH_OPS_BEGIN_${nonce}__`;
  const end = `__PERSISTENT_SSH_OPS_END_${nonce}__`;
  const command = captureCommand(basename(shell), begin, end);
  const result = Bun.spawnSync({
    cmd: [shell, "-lic", command],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return parseDiscoveryStream(result.stdout, begin, end);
}

export function filterHostAliases(records: DiscoveryRecord[]): HostAlias[] {
  const discovered: HostAlias[] = [];
  for (const { kind, name: alias, value: command } of records) {
    if (kind !== "alias") continue;
    const match = SSH_COMMAND.exec(command);
    const transport = match?.groups?.transport;
    if (!SAFE_ALIAS.test(alias) || !transport) continue;
    discovered.push({ alias, transport: transport as HostAlias["transport"], command });
  }
  return discovered.sort((left, right) => left.alias.localeCompare(right.alias, "en"));
}

function isSafeSshUri(value: string): boolean {
  try {
    const uri = new URL(value);
    return uri.protocol === "ssh:"
      && uri.username.length > 0
      && uri.password.length === 0
      && uri.hostname.length > 0
      && uri.search.length === 0
      && uri.hash.length === 0;
  } catch {
    return false;
  }
}

export function filterServerProfiles(records: DiscoveryRecord[]): ServerProfile[] {
  const discovered: ServerProfile[] = [];
  for (const { kind, name, value: uri } of records) {
    if (kind !== "profile" || !SAFE_PROFILE.test(name) || !isSafeSshUri(uri)) continue;
    discovered.push({ name, uri });
  }
  return discovered.sort((left, right) => left.name.localeCompare(right.name, "en"));
}

function printHelp(): void {
  console.log("Usage: bun scan-hosts.ts");
  console.log("Discover server_ssh profiles and legacy SSH aliases from the configured login shell.");
}

export function main(args: string[] = Bun.argv.slice(2)): number {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    printHelp();
    return 0;
  }
  if (args.length > 0) {
    console.error(`scan-hosts: unexpected argument: ${args[0]}`);
    return 2;
  }

  try {
    const shell = loginShell();
    const discovery = effectiveDiscovery(shell);
    const output = {
      schema_version: 2,
      shell,
      server_profiles: filterServerProfiles(discovery),
      host_aliases: filterHostAliases(discovery),
    };
    console.log(JSON.stringify(output, null, 2));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`scan-hosts: ${message}`);
    return 2;
  }
}

if (import.meta.main) process.exit(main());
