#!/usr/bin/env bun
/** Install the managed JSON profile runtime. */
import { chmodSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");
const MANAGED_MARKER = "Managed by persistent-ssh-ops";
const RUNTIME_SOURCE_LINE = '[[ -f "$HOME/.config/zsh/server-runtime.zsh" ]] && source "$HOME/.config/zsh/server-runtime.zsh"';
type FileStatus = "created" | "updated" | "unchanged" | "preserved";
export interface InitResult { runtime: FileStatus; validator: FileStatus; profiles: FileStatus; zshrc: FileStatus }

function present(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
function validateProfiles(content: string): void {
  const result = Bun.spawnSync({
    cmd: ["jq", "--stream", "--slurp", "--raw-output0", "--arg", "mode", "validate", "-f", join(ASSETS, "server-config.jq")],
    stdin: new TextEncoder().encode(content), stdout: "pipe", stderr: "pipe",
  });
  if (result.exitCode !== 0 || Buffer.from(result.stdout).toString() !== "ok\0") {
    throw new Error("invalid JSON configuration or jq 1.7+ unavailable");
  }
}
function installAsset(name: string, target: string, managed = false): FileStatus {
  const desired = readFileSync(join(ASSETS, name), "utf8");
  const exists = present(target);
  const current = exists ? readFileSync(target, "utf8") : "";
  if (managed && exists && !current.includes(MANAGED_MARKER)) throw new Error("refusing to overwrite unmanaged runtime");
  if (current !== desired) writeFileSync(target, desired, { mode: 0o700 });
  chmodSync(target, 0o700);
  return !exists ? "created" : current === desired ? "unchanged" : "updated";
}
export function initializeServerConfig(home: string = homedir()): InitResult {
  const resolvedHome = resolve(home);
  const configDirectory = join(resolvedHome, ".config", "zsh");
  const profilesTarget = join(configDirectory, "servers.json");
  const profilesExist = present(profilesTarget);
  // Validate before any user file changes, including creation of directories.
  const profiles = profilesExist ? readFileSync(profilesTarget, "utf8") : readFileSync(join(ASSETS, "servers.json"), "utf8");
  validateProfiles(profiles);
  mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
  const runtime = installAsset("server-runtime.zsh", join(configDirectory, "server-runtime.zsh"), true);
  const validator = installAsset("server-config.jq", join(configDirectory, "server-config.jq"));
  if (!profilesExist) writeFileSync(profilesTarget, profiles, { mode: 0o600 });
  chmodSync(profilesTarget, 0o600);
  const zshrcTarget = join(resolvedHome, ".zshrc");
  const zshrcExists = present(zshrcTarget);
  const current = zshrcExists ? readFileSync(zshrcTarget, "utf8") : "";
  let zshrc: FileStatus = "unchanged";
  if (!current.split("\n").includes(RUNTIME_SOURCE_LINE)) {
    const updated = current + (current && !current.endsWith("\n") ? "\n" : "") + RUNTIME_SOURCE_LINE + "\n";
    const mode = zshrcExists ? statSync(zshrcTarget).mode & 0o777 : 0o600;
    writeFileSync(zshrcTarget, updated, { mode });
    chmodSync(zshrcTarget, mode);
    zshrc = "updated";
  }
  return { runtime, validator, profiles: profilesExist ? "preserved" : "created", zshrc };
}
function printHelp(): void {
  console.log("Usage: bun init-server-config.ts [--home <path>]");
  console.log("Install the managed JSON server runtime and .zshrc source line.");
}
export function main(args: string[] = Bun.argv.slice(2)): number {
  if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) { printHelp(); return 0; }
  let home = homedir();
  if (args.length === 2 && args[0] === "--home") home = args[1]!;
  else if (args.length) { console.error("init-server-config: unexpected arguments"); return 2; }
  try { console.log(JSON.stringify(initializeServerConfig(home), null, 2)); return 0; }
  catch { console.error("init-server-config: initialization failed; check JSON, jq 1.7+, managed runtime and file access"); return 1; }
}
if (import.meta.main) process.exit(main());
