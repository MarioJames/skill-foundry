import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  realpathSync,
} from "node:fs";
import { basename, delimiter, dirname, join, resolve } from "node:path";

export const BH_VERSION = "0.5.0";
export const BH_MIN_AGENT_BROWSER_VERSION = "0.29.0";

export class BhError extends Error {
  readonly exitCode: number;

  constructor(exitCode: number, message: string) {
    super(message);
    this.name = "BhError";
    this.exitCode = exitCode;
  }
}

export function fail(exitCode: number, message: string): never {
  throw new BhError(exitCode, message);
}

export function log(message: string): void {
  process.stderr.write(`[bh] ${message}\n`);
}

export function warn(message: string): void {
  process.stderr.write(`[bh][warn] ${message}\n`);
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function logDir(): string {
  return process.env.BH_LOG_DIR || "/tmp/browser-harness";
}

export function ensureLogDir(): void {
  mkdirSync(logDir(), { recursive: true });
}

export function profileRoot(): string {
  return (
    process.env.BH_PROFILE_ROOT ||
    join(process.env.HOME || "", ".browser-harness", "profiles")
  );
}

function profileNameSegment(value: string): string {
  return (
    value
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
      .replace(/^-+|-+$/g, "") || "project"
  );
}

export function profileProjectRoot(startDir = process.cwd()): string {
  const original = physicalProjectPath(resolve(startDir));
  let current = original;

  while (true) {
    if (
      existsSync(join(current, ".git")) ||
      existsSync(join(current, "package.json"))
    ) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return original;
    current = parent;
  }
}

export function projectProfileName(startDir = process.cwd()): string {
  const projectRoot = profileProjectRoot(startDir);
  const project = profileNameSegment(basename(projectRoot));
  const parent = profileNameSegment(basename(dirname(projectRoot)));
  return parent === project ? project : `${parent}-${project}`;
}

export function defaultProfile(startDir = process.cwd()): string {
  return process.env.BH_DEFAULT_PROFILE || projectProfileName(startDir);
}

export function profileDir(name = "", startDir = process.cwd()): string {
  const effectiveName = name || defaultProfile(startDir);
  if (effectiveName.includes("/") || effectiveName.startsWith("~")) {
    return effectiveName;
  }
  return join(profileRoot(), effectiveName);
}

export function physicalProjectPath(projectDir: string): string {
  try {
    return realpathSync(projectDir);
  } catch {
    return projectDir;
  }
}

export function projectKey(projectDir: string): string {
  const normalized = physicalProjectPath(projectDir);
  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    result = Bun.spawnSync({
      cmd: ["cksum"],
      stdin: Buffer.from(normalized),
      stdout: "pipe",
      stderr: "ignore",
    });
  } catch {
    fail(2, "无法执行 cksum 生成 dev server 状态键");
  }

  const key = (result.stdout?.toString() || "").trim().split(/\s+/, 1)[0];
  if (result.exitCode !== 0 || !key || !/^\d+$/.test(key)) {
    fail(2, "cksum 未能生成有效的 dev server 状态键");
  }
  return key;
}

export function pidFile(projectDir: string): string {
  return join(logDir(), `dev-${projectKey(projectDir)}.pid`);
}

export function labelFile(projectDir: string): string {
  return join(logDir(), `dev-${projectKey(projectDir)}.label`);
}

export function appUrlFile(projectDir: string): string {
  return join(logDir(), `dev-${projectKey(projectDir)}.url`);
}

export function tunnelPidFile(projectDir: string): string {
  return join(logDir(), `tunnel-${projectKey(projectDir)}.pid`);
}

export function tunnelLabelFile(projectDir: string): string {
  return join(logDir(), `tunnel-${projectKey(projectDir)}.label`);
}

export function tunnelUrlFile(projectDir: string): string {
  return join(logDir(), `tunnel-${projectKey(projectDir)}.url`);
}

export function findExecutable(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (command.includes("/")) {
    try {
      accessSync(command, constants.X_OK);
      return command;
    } catch {
      return null;
    }
  }

  for (const directory of (env.PATH || "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue searching PATH.
    }
  }
  return null;
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function parsePositiveInteger(
  raw: string | undefined,
  fallback: number,
): number {
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
