#!/usr/bin/env bun

/** Dependency-free, content-addressed bootstrap for the TypeScript Runtime. */

import {
  constants as fsConstants,
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  closeSync,
  fsyncSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir, platform, arch } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const MANIFEST_SCHEMA_VERSION = 1;
const MANIFEST_NAME = ".agents-orchestrator-manifest.json";
const LOCK_NAME = ".install.lock";
const LOCK_INFO_NAME = "owner.json";
const LOCK_WAIT_MS = 120_000;
const LOCK_STALE_MS = 10 * 60_000;
const POLL_MS = 100;

const BASE_PACKAGES = Object.freeze({
  "@agentclientprotocol/sdk": "1.3.0",
  "@agentclientprotocol/codex-acp": "1.1.7",
  "@agentclientprotocol/claude-agent-acp": "0.62.0",
  "@openai/codex": "0.145.0",
  "@anthropic-ai/claude-agent-sdk": "0.3.219",
});

const GEMINI_PACKAGES = Object.freeze({
  "@google/gemini-cli": "0.41.0",
});

const REQUIRED_BINS = Object.freeze({
  "@agentclientprotocol/codex-acp": "codex-acp",
  "@agentclientprotocol/claude-agent-acp": "claude-agent-acp",
});

type JsonObject = Record<string, unknown>;

interface BootstrapManifest extends JsonObject {
  schemaVersion: number;
  digest: string;
  platform: string;
  arch: string;
  bunVersion: string;
  installVariant: "base" | "gemini";
  packages: Record<string, string>;
  executables: Record<string, string>;
  runtimeEntry: string;
  createdAt: string;
}

interface InstallLock {
  path: string;
  release: () => void;
}

function fail(message: string): never {
  throw new Error(message);
}

function sleep(milliseconds: number): void {
  Bun.sleepSync(milliseconds);
}

function readJson(path: string): JsonObject | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as JsonObject)
      : null;
  } catch {
    return null;
  }
}

function writePrivateJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function isWithin(path: string, parent: string): boolean {
  const child = resolve(path);
  const root = resolve(parent);
  const offset = relative(root, child);
  return offset === "" || (!offset.startsWith(`..${sep}`) && offset !== ".." && !isAbsolute(offset));
}

function repositoryRoot(skillDirectory: string): string | null {
  let cursor = resolve(skillDirectory);
  while (true) {
    if (existsSync(join(cursor, ".git"))) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

function compatibleEnvironmentValue(suffix: string): string | undefined {
  const canonicalName = `AGENTS_ORCHESTRATOR_${suffix}`;
  const legacyName = `AGENT_SWARM_${suffix}`;
  const canonical = process.env[canonicalName]?.trim() || undefined;
  const legacy = process.env[legacyName]?.trim() || undefined;
  if (canonical && legacy && canonical !== legacy) {
    fail(`conflicting orchestration environment: ${canonicalName} does not match ${legacyName}`);
  }
  return canonical ?? legacy;
}

function dependencyHome(skillDirectory: string): string {
  const configured = compatibleEnvironmentValue("DEPENDENCY_HOME");
  const selected = resolve(configured ?? join(homedir(), ".agents-orchestrator", "dependencies"));
  const repo = repositoryRoot(skillDirectory);
  if (isWithin(selected, skillDirectory) || (repo !== null && isWithin(selected, repo))) {
    fail("dependency home must be outside the Skill directory and repository");
  }
  return selected;
}

function runtimeFiles(skillDirectory: string): string[] {
  const included = [join(skillDirectory, "package.json"), join(skillDirectory, "bun.lock")];
  const roots = [join(skillDirectory, "scripts"), join(skillDirectory, "hooks")];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const pending = [root];
    while (pending.length > 0) {
      const directory = pending.pop()!;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          pending.push(path);
        } else if (entry.isFile() && (path.endsWith(".ts") || root.endsWith(`${sep}hooks`))) {
          included.push(path);
        }
      }
    }
  }
  for (const required of included.slice(0, 2)) {
    if (!existsSync(required)) fail(`bootstrap source is incomplete: missing ${basename(required)}`);
  }
  return included.sort((left, right) => relative(skillDirectory, left).localeCompare(relative(skillDirectory, right)));
}

function wantsGemini(arguments_: readonly string[]): boolean {
  const candidates: string[] = [];
  const names = new Set([
    "--acp-agent",
    "--default-profile",
    "--profile",
    "--profile-allowlist",
    "--allowed-profiles",
    "--profiles",
  ]);
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    const separator = argument.indexOf("=");
    if (separator > 0 && names.has(argument.slice(0, separator))) {
      candidates.push(argument.slice(separator + 1));
    } else if (names.has(argument) && arguments_[index + 1] !== undefined) {
      candidates.push(arguments_[index + 1]!);
      index += 1;
    }
  }
  for (const suffix of [
    "ACP_AGENT",
    "ACP_DEFAULT_PROFILE",
    "DEFAULT_PROFILE",
    "ACP_PROFILE_ALLOWLIST",
    "PROFILE_ALLOWLIST",
    "ACP_PROFILES",
    "PROFILES",
    "ALLOWED_PROFILES",
  ]) {
    const value = compatibleEnvironmentValue(suffix);
    if (value) candidates.push(value);
  }
  return candidates.some((candidate) => {
    if (candidate.trim() === "gemini") return true;
    try {
      const parsed: unknown = JSON.parse(candidate);
      return Array.isArray(parsed) && parsed.includes("gemini");
    } catch {
      return candidate.split(",").map((item) => item.trim()).includes("gemini");
    }
  });
}

function digestSources(
  skillDirectory: string,
  files: readonly string[],
  installVariant: "base" | "gemini",
): string {
  const hash = createHash("sha256");
  hash.update(`schema=${MANIFEST_SCHEMA_VERSION}\0`);
  hash.update(`platform=${platform()}\0arch=${arch()}\0bun=${Bun.version}\0variant=${installVariant}\0`);
  for (const path of files) {
    const name = relative(skillDirectory, path).split(sep).join("/");
    const bytes = readFileSync(path);
    hash.update(`${name}\0${bytes.byteLength}\0`);
    hash.update(bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function staleLock(lockPath: string): boolean {
  try {
    const owner = readJson(join(lockPath, LOCK_INFO_NAME));
    if (owner === null) {
      // Another installer may be between atomic mkdir and publishing owner.json.
      // Only treat an ownerless lock as abandoned after a short creation grace.
      return Date.now() - statSync(lockPath).mtimeMs > 5_000;
    }
    const pid = typeof owner?.pid === "number" ? owner.pid : -1;
    const age = Date.now() - statSync(lockPath).mtimeMs;
    return !processAlive(pid) || age > LOCK_STALE_MS;
  } catch {
    try { return Date.now() - statSync(lockPath).mtimeMs > 5_000; }
    catch { return true; }
  }
}

function acquireInstallLock(home: string, ready: () => boolean): InstallLock | null {
  const lockPath = join(home, LOCK_NAME);
  const started = Date.now();
  while (true) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      chmodSync(lockPath, 0o700);
      writePrivateJson(join(lockPath, LOCK_INFO_NAME), {
        pid: process.pid,
        startedAt: new Date().toISOString(),
      });
      let released = false;
      return {
        path: lockPath,
        release: () => {
          if (released) return;
          released = true;
          try {
            const owner = readJson(join(lockPath, LOCK_INFO_NAME));
            if (owner?.pid === process.pid) rmSync(lockPath, { recursive: true, force: true });
          } catch {
            // A replaced stale lock belongs to another installer and is never removed here.
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (ready()) return null;
      if (staleLock(lockPath)) {
        const stalePath = join(home, `.stale-lock-${randomUUID()}`);
        try {
          renameSync(lockPath, stalePath);
          rmSync(stalePath, { recursive: true, force: true });
          continue;
        } catch {
          // Another process recovered it first.
        }
      }
      if (Date.now() - started >= LOCK_WAIT_MS) {
        fail("timed out waiting for the dependency cache installation lock");
      }
      sleep(POLL_MS);
    }
  }
}

function packagePath(root: string, packageName: string): string {
  return join(root, "node_modules", ...packageName.split("/"), "package.json");
}

function binTarget(root: string, packageName: string, binName: string): string | null {
  const metadata = readJson(packagePath(root, packageName));
  const bin = metadata?.bin;
  let relativeTarget: string | undefined;
  if (typeof bin === "string") relativeTarget = bin;
  if (bin !== null && typeof bin === "object" && !Array.isArray(bin)) {
    const selected = (bin as JsonObject)[binName];
    if (typeof selected === "string") relativeTarget = selected;
  }
  if (!relativeTarget || isAbsolute(relativeTarget) || relativeTarget.split(/[\\/]/u).includes("..")) return null;
  return join(dirname(packagePath(root, packageName)), relativeTarget);
}

function validateCache(
  target: string,
  digest: string,
  installVariant: "base" | "gemini",
): BootstrapManifest | null {
  try {
    const manifest = readJson(join(target, MANIFEST_NAME)) as BootstrapManifest | null;
    if (
      manifest?.schemaVersion !== MANIFEST_SCHEMA_VERSION ||
      manifest.digest !== digest ||
      manifest.platform !== platform() ||
      manifest.arch !== arch() ||
      manifest.bunVersion !== Bun.version ||
      manifest.installVariant !== installVariant
    ) return null;
    const expected = installVariant === "gemini"
      ? { ...BASE_PACKAGES, ...GEMINI_PACKAGES }
      : BASE_PACKAGES;
    for (const [name, version] of Object.entries(expected)) {
      const metadata = readJson(packagePath(target, name));
      if (metadata?.name !== name || metadata.version !== version) return null;
    }
    for (const [packageName, binName] of Object.entries(REQUIRED_BINS)) {
      const targetPath = binTarget(target, packageName, binName);
      const shim = join(target, "node_modules", ".bin", binName);
      if (!targetPath || !existsSync(targetPath) || !existsSync(shim)) return null;
      try {
        Bun.file(shim);
        if ((statSync(shim).mode & 0o111) === 0) return null;
      } catch {
        return null;
      }
    }
    const runtimeEntry = join(target, "scripts", "agent_orchestrator.ts");
    if (!existsSync(runtimeEntry) || !lstatSync(runtimeEntry).isFile()) return null;
    return manifest;
  } catch {
    return null;
  }
}

function copyRuntime(skillDirectory: string, stage: string, files: readonly string[]): void {
  for (const source of files) {
    const relativePath = relative(skillDirectory, source);
    const destination = join(stage, relativePath);
    ensurePrivateDirectory(dirname(destination));
    copyFileSync(source, destination, fsConstants.COPYFILE_EXCL);
    chmodSync(destination, source.endsWith(".sh") ? 0o700 : 0o600);
  }
}

async function installDependencies(stage: string, includeGemini: boolean): Promise<void> {
  const command = [process.execPath, "install", "--frozen-lockfile", "--ignore-scripts"];
  if (!includeGemini) command.push("--production");
  const child = Bun.spawn(command, {
    cwd: stage,
    env: {
      ...process.env,
      CI: "1",
      BUN_INSTALL_SILENT: "1",
      npm_config_ignore_scripts: "true",
    },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    fail(`dependency installation failed (exit code ${exitCode}); verify network access and the frozen lockfile`);
  }
}

function buildManifest(
  stage: string,
  publishedTarget: string,
  digest: string,
  installVariant: "base" | "gemini",
): BootstrapManifest {
  const packages = installVariant === "gemini"
    ? { ...BASE_PACKAGES, ...GEMINI_PACKAGES }
    : { ...BASE_PACKAGES };
  const executables: Record<string, string> = {};
  for (const [packageName, binName] of Object.entries(REQUIRED_BINS)) {
    const target = binTarget(stage, packageName, binName);
    const shim = join(stage, "node_modules", ".bin", binName);
    if (!target || !existsSync(target) || !existsSync(shim) || (statSync(shim).mode & 0o111) === 0) {
      fail(`dependency validation failed: ${packageName} does not provide executable ${binName}`);
    }
    executables[binName] = join(publishedTarget, "node_modules", ".bin", binName);
  }
  for (const [name, version] of Object.entries(packages)) {
    const metadata = readJson(packagePath(stage, name));
    if (metadata?.name !== name || metadata.version !== version) {
      fail(`dependency validation failed: expected ${name}@${version}`);
    }
  }
  const entry = join(stage, "scripts", "agent_orchestrator.ts");
  if (!existsSync(entry)) fail("bootstrap source is incomplete: missing TypeScript Runtime entry");
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    digest,
    platform: platform(),
    arch: arch(),
    bunVersion: Bun.version,
    installVariant,
    packages,
    executables,
    runtimeEntry: join(publishedTarget, "scripts", "agent_orchestrator.ts"),
    createdAt: new Date().toISOString(),
  };
}

async function ensureCache(
  skillDirectory: string,
  home: string,
  files: readonly string[],
  digest: string,
  installVariant: "base" | "gemini",
): Promise<{ target: string; manifest: BootstrapManifest }> {
  const target = join(home, `runtime-${digest}`);
  const existing = validateCache(target, digest, installVariant);
  if (existing) return { target, manifest: existing };

  const lock = acquireInstallLock(home, () => validateCache(target, digest, installVariant) !== null);
  if (lock === null) {
    const installed = validateCache(target, digest, installVariant);
    if (!installed) fail("dependency cache became incomplete after concurrent installation");
    return { target, manifest: installed };
  }

  let stage: string | null = null;
  let prior: string | null = null;
  try {
    const installed = validateCache(target, digest, installVariant);
    if (installed) return { target, manifest: installed };
    stage = mkdtempSync(join(home, ".staging-"));
    chmodSync(stage, 0o700);
    copyRuntime(skillDirectory, stage, files);
    await installDependencies(stage, installVariant === "gemini");
    const manifest = buildManifest(stage, target, digest, installVariant);
    writePrivateJson(join(stage, MANIFEST_NAME), manifest);

    if (existsSync(target)) {
      prior = join(home, `.replaced-${digest}-${randomUUID()}`);
      renameSync(target, prior);
    }
    try {
      renameSync(stage, target);
      stage = null;
    } catch (error) {
      if (prior !== null && !existsSync(target)) renameSync(prior, target);
      prior = null;
      throw error;
    }
    if (prior !== null) {
      rmSync(prior, { recursive: true, force: true });
      prior = null;
    }
    const published = validateCache(target, digest, installVariant);
    if (!published) fail("published dependency cache failed validation");
    return { target, manifest: published };
  } finally {
    if (stage !== null) rmSync(stage, { recursive: true, force: true });
    if (prior !== null && existsSync(prior) && !existsSync(target)) renameSync(prior, target);
    lock.release();
  }
}

function publishManagedBins(
  home: string,
  target: string,
  installVariant: "base" | "gemini",
): string {
  const directory = join(home, "bin");
  ensurePrivateDirectory(directory);
  const bins: Record<string, string> = { ...REQUIRED_BINS };
  if (installVariant === "gemini") bins["@google/gemini-cli"] = "gemini";
  for (const [packageName, binName] of Object.entries(bins)) {
    const source = binTarget(target, packageName, binName);
    if (source === null || !existsSync(source) || (statSync(source).mode & 0o111) === 0) {
      fail(`dependency validation failed: ${packageName} does not provide executable ${binName}`);
    }
    const destination = join(directory, binName);
    const temporary = join(directory, `.${binName}.${randomUUID()}.tmp`);
    try {
      symlinkSync(source, temporary);
      renameSync(temporary, destination);
    } finally {
      if (existsSync(temporary)) rmSync(temporary, { force: true });
    }
  }
  return directory;
}

async function executeRuntime(
  home: string,
  target: string,
  installVariant: "base" | "gemini",
  arguments_: readonly string[],
): Promise<number> {
  const entry = join(target, "scripts", "agent_orchestrator.ts");
  const binDirectory = publishManagedBins(home, target, installVariant);
  const environment = {
    ...process.env,
    AGENTS_ORCHESTRATOR_MANAGED_ROOT: target,
    AGENT_SWARM_MANAGED_ROOT: target,
    AGENTS_ORCHESTRATOR_DEPENDENCY_HOME: home,
    AGENT_SWARM_DEPENDENCY_HOME: home,
    PATH: `${binDirectory}${sep === "\\" ? ";" : ":"}${process.env.PATH ?? ""}`,
  };
  const child = Bun.spawn([process.execPath, entry, ...arguments_], {
    cwd: process.cwd(),
    env: environment,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const forward = (signal: NodeJS.Signals): void => {
    try {
      child.kill(signal);
    } catch {
      // The child may already have exited.
    }
  };
  const onInterrupt = () => forward("SIGINT");
  const onTerminate = () => forward("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  try {
    return await child.exited;
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }
}

async function main(): Promise<number> {
  if (typeof Bun === "undefined" || !Bun.version) {
    fail("Bun is required to run Agents Orchestrator; install Bun and retry");
  }
  const skillDirectory = resolve(dirname(import.meta.path), "..");
  const home = dependencyHome(skillDirectory);
  ensurePrivateDirectory(home);
  const files = runtimeFiles(skillDirectory);
  const installVariant = wantsGemini(process.argv.slice(2)) ? "gemini" : "base";
  const digest = digestSources(skillDirectory, files, installVariant);
  const { target } = await ensureCache(skillDirectory, home, files, digest, installVariant);
  return executeRuntime(home, target, installVariant, process.argv.slice(2));
}

try {
  process.exitCode = await main();
} catch (error) {
  const message = error instanceof Error ? error.message : "bootstrap failed";
  process.stderr.write(`agents-orchestrator: ${message}\n`);
  process.exitCode = 1;
}
