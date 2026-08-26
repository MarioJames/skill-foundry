import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CQT_VERSION = "0.4.0";

const LIFECYCLE_MODULE = fileURLToPath(import.meta.url);
const PID_WAIT_ATTEMPTS = 30;
const URL_WAIT_ATTEMPTS = 30;

export class CqtError extends Error {
  readonly exitCode: number;

  constructor(exitCode: number, message: string) {
    super(message);
    this.name = "CqtError";
    this.exitCode = exitCode;
  }
}

export interface TunnelInfo {
  originUrl: string;
  publicUrl: string;
  pid: number;
  logPath: string;
  stateDir: string;
}

export interface TunnelStatus {
  status: "running" | "stale" | "stopped";
  pid: number | null;
  originUrl: string;
  publicUrl: string;
  logPath: string;
  stateDir: string;
}

interface StatePaths {
  dir: string;
  pid: string;
  label: string;
  publicUrl: string;
  originUrl: string;
  logPath: string;
  workerEnvironment: string;
  config: string;
  log: string;
}

function fail(exitCode: number, message: string): never {
  throw new CqtError(exitCode, message);
}

export function log(message: string): void {
  process.stderr.write(`[cqt] ${message}\n`);
}

function warn(message: string): void {
  process.stderr.write(`[cqt][warn] ${message}\n`);
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function physicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function stableKey(value: string): string {
  return new Bun.CryptoHasher("sha256")
    .update(value)
    .digest("hex")
    .slice(0, 16);
}

export function defaultStateDir(startDir = process.cwd()): string {
  const root = join(
    process.env.HOME || "/tmp",
    ".cloudflare-quick-tunnel",
    "state",
  );
  return join(root, stableKey(physicalPath(startDir)));
}

export function resolveStateDir(value = "", startDir = process.cwd()): string {
  const result = value ? resolve(startDir, value) : defaultStateDir(startDir);
  const root = parse(result).root;
  if (result === root) fail(2, "state-dir 不能是文件系统根目录");
  return result;
}

function statePaths(stateDir: string): StatePaths {
  return {
    dir: stateDir,
    pid: join(stateDir, "tunnel.pid"),
    label: join(stateDir, "launchd-label"),
    publicUrl: join(stateDir, "public-url"),
    originUrl: join(stateDir, "origin-url"),
    logPath: join(stateDir, "log-path"),
    workerEnvironment: join(stateDir, "worker-environment.json"),
    config: join(stateDir, "empty-config.yml"),
    log: join(stateDir, "tunnel.log"),
  };
}

function ensureStateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try {
    chmodSync(path, 0o700);
  } catch {
    // Some filesystems do not support chmod.
  }
}

function writePrivate(path: string, value: string): void {
  writeFileSync(path, value, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Some filesystems do not support chmod.
  }
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function readPid(path: string): number | null {
  const value = Number(readText(path).trim());
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function tailLog(path: string): void {
  const text = readText(path);
  if (!text) return;
  const tail = text.split(/\r?\n/).slice(-81).join("\n");
  process.stderr.write(tail.endsWith("\n") ? tail : `${tail}\n`);
}

function findExecutable(
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

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function syncCommand(
  command: string[],
  options: { stdout?: "pipe" | "ignore"; stderr?: "pipe" | "ignore" } = {},
): { exitCode: number; stdout: string } {
  try {
    const result = Bun.spawnSync({
      cmd: command,
      stdin: "ignore",
      stdout: options.stdout || "ignore",
      stderr: options.stderr || "ignore",
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout ? result.stdout.toString() : "",
    };
  } catch {
    return { exitCode: 127, stdout: "" };
  }
}

function removeLaunchctlJob(label: string): void {
  if (!label || process.platform !== "darwin" || !findExecutable("launchctl")) {
    return;
  }
  syncCommand(["launchctl", "remove", label]);
}

function processGroupId(pid: number): number | null {
  const result = syncCommand(["ps", "-o", "pgid=", "-p", String(pid)], {
    stdout: "pipe",
  });
  if (result.exitCode !== 0) return null;
  const value = Number(result.stdout.trim());
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function childProcessIds(parent: number): number[] {
  if (!findExecutable("pgrep")) return [];
  const result = syncCommand(["pgrep", "-P", String(parent)], {
    stdout: "pipe",
  });
  if (result.exitCode !== 0) return [];
  return result.stdout
    .trim()
    .split(/\s+/)
    .map(Number)
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Process may already have exited.
  }
}

function signalProcessGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // Process group may already have exited or be inaccessible.
  }
}

function killDescendants(
  parent: number,
  signal: NodeJS.Signals,
  seen = new Set<number>(),
): void {
  if (seen.has(parent)) return;
  seen.add(parent);
  for (const child of childProcessIds(parent)) {
    killDescendants(child, signal, seen);
    signalPid(child, signal);
  }
}

function removeRuntimeState(paths: StatePaths): void {
  for (const path of [
    paths.pid,
    paths.label,
    paths.publicUrl,
    paths.originUrl,
    paths.workerEnvironment,
    paths.config,
  ]) {
    rmSync(path, { force: true });
  }
}

export function getTunnelStatus(stateDirValue: string): TunnelStatus {
  const paths = statePaths(stateDirValue);
  const pid = readPid(paths.pid);
  const status =
    pid === null ? "stopped" : isProcessAlive(pid) ? "running" : "stale";
  return {
    status,
    pid,
    originUrl: readText(paths.originUrl).trim(),
    publicUrl: readText(paths.publicUrl).trim(),
    logPath: readText(paths.logPath).trim(),
    stateDir: stateDirValue,
  };
}

export async function stopTunnel(stateDirValue: string): Promise<void> {
  const paths = statePaths(stateDirValue);
  if (!existsSync(paths.dir)) {
    log("状态目录不存在，无 tunnel 可停止");
    return;
  }

  const label = readText(paths.label).trim();
  const pid = readPid(paths.pid);
  removeRuntimeState(paths);

  if (pid === null) {
    log("无 tunnel pid 文件，跳过");
    removeLaunchctlJob(label);
    return;
  }
  if (!isProcessAlive(pid)) {
    log(`tunnel pid ${pid} 不存活，跳过`);
    removeLaunchctlJob(label);
    return;
  }

  const pgid = processGroupId(pid);
  const currentPgid = processGroupId(process.pid);
  const useProcessGroup =
    pgid !== null && currentPgid !== null && pgid !== currentPgid;

  if (useProcessGroup) signalProcessGroup(pgid, "SIGTERM");
  else killDescendants(pid, "SIGTERM");
  signalPid(pid, "SIGTERM");
  removeLaunchctlJob(label);

  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (!isProcessAlive(pid)) {
      log(`Cloudflare tunnel ${pid} 已退出`);
      return;
    }
    await sleep(500);
  }

  if (useProcessGroup && pgid !== null) signalProcessGroup(pgid, "SIGKILL");
  else killDescendants(pid, "SIGKILL");
  signalPid(pid, "SIGKILL");
  for (let attempt = 0; attempt < 40 && isProcessAlive(pid); attempt += 1) {
    await sleep(50);
  }
  log(`Cloudflare tunnel ${pid} force-killed`);
}

export async function cleanupTunnel(stateDirValue: string): Promise<void> {
  const paths = statePaths(stateDirValue);
  await stopTunnel(stateDirValue);
  for (const path of [paths.log, paths.logPath]) rmSync(path, { force: true });
  removeRuntimeState(paths);
  try {
    rmdirSync(paths.dir);
    log(`已清理 tunnel 状态目录：${paths.dir}`);
  } catch {
    if (existsSync(paths.dir)) {
      warn(`状态目录包含非本技能文件，已保留：${paths.dir}`);
    }
  }
}

function resolveTunnelCommand(
  originUrl: string,
  paths: StatePaths,
): string[] {
  const cloudflared = findExecutable("cloudflared");
  if (!cloudflared) {
    fail(2, "未找到 cloudflared；请先安装 Cloudflare Tunnel 客户端");
  }

  writePrivate(paths.config, "");
  return [
    cloudflared,
    "tunnel",
    "--config",
    paths.config,
    "--no-autoupdate",
    "--url",
    originUrl,
  ];
}

function launchWithLaunchctl(
  label: string,
  paths: StatePaths,
  command: string[],
): void {
  writePrivate(paths.workerEnvironment, JSON.stringify(process.env));
  const result = syncCommand([
    "launchctl",
    "submit",
    "-l",
    label,
    "-o",
    paths.log,
    "-e",
    paths.log,
    "--",
    process.execPath,
    LIFECYCLE_MODULE,
    "__worker",
    paths.pid,
    paths.dir,
    paths.workerEnvironment,
    JSON.stringify(command),
  ]);
  if (result.exitCode !== 0) {
    fail(2, `launchctl submit Cloudflare tunnel 失败（exit ${result.exitCode}）`);
  }
}

function launchDetached(paths: StatePaths, command: string[]): number {
  const logDescriptor = openSync(paths.log, "a", 0o600);
  try {
    const child = Bun.spawn(command, {
      cwd: paths.dir,
      env: process.env,
      stdin: "ignore",
      stdout: logDescriptor,
      stderr: logDescriptor,
      detached: true,
    });
    child.unref();
    writePrivate(paths.pid, `${child.pid}\n`);
    return child.pid;
  } finally {
    closeSync(logDescriptor);
  }
}

function quickTunnelUrl(path: string): string {
  return (
    readText(path).match(
      /https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.trycloudflare\.com/,
    )?.[0] || ""
  );
}

function parseOrigin(value: string): URL {
  try {
    const origin = new URL(value);
    if (origin.protocol !== "http:" && origin.protocol !== "https:") {
      throw new Error();
    }
    return origin;
  } catch {
    fail(2, `origin 不是有效 HTTP(S) URL：${value}`);
  }
}

export async function startTunnel(
  originValue: string,
  stateDirValue: string,
): Promise<TunnelInfo> {
  const origin = parseOrigin(originValue);
  const paths = statePaths(stateDirValue);
  await stopTunnel(stateDirValue);
  ensureStateDir(paths.dir);
  writePrivate(paths.log, "");
  writePrivate(paths.logPath, `${paths.log}\n`);
  const command = resolveTunnelCommand(originValue, paths);

  log(`启动 Cloudflare Quick Tunnel，origin: ${origin.origin}`);
  log(`state: ${paths.dir}`);
  log(`log: ${paths.log}`);

  let tunnelPid: number | null = null;
  if (process.platform === "darwin" && findExecutable("launchctl")) {
    const label = `com.codex.cloudflare-quick-tunnel.${stableKey(paths.dir)}.${Math.floor(Date.now() / 1_000)}`;
    writePrivate(paths.label, `${label}\n`);
    try {
      launchWithLaunchctl(label, paths, command);
    } catch (error) {
      removeRuntimeState(paths);
      removeLaunchctlJob(label);
      throw error;
    }

    for (let attempt = 0; attempt < PID_WAIT_ATTEMPTS; attempt += 1) {
      tunnelPid = readPid(paths.pid);
      if (tunnelPid !== null && isProcessAlive(tunnelPid)) break;
      await sleep(500);
    }
    if (tunnelPid === null || !isProcessAlive(tunnelPid)) {
      tailLog(paths.log);
      await stopTunnel(paths.dir);
      fail(2, "Cloudflare tunnel job 没有发布存活 pid");
    }
  } else {
    tunnelPid = launchDetached(paths, command);
  }

  log(`Cloudflare tunnel pid: ${tunnelPid}`);
  try {
    let publicUrl = "";
    for (let attempt = 0; attempt < URL_WAIT_ATTEMPTS && !publicUrl; attempt += 1) {
      if (!isProcessAlive(tunnelPid)) {
        tailLog(paths.log);
        fail(2, "Cloudflare tunnel 在生成公网 URL 前退出");
      }
      const base = quickTunnelUrl(paths.log);
      if (base) publicUrl = base;
      else await sleep(500);
    }
    if (!publicUrl) {
      tailLog(paths.log);
      fail(2, "等待 Quick Tunnel 公网 URL 超时");
    }

    writePrivate(paths.originUrl, `${originValue}\n`);
    writePrivate(paths.publicUrl, `${publicUrl}\n`);
    log(`public URL generated: ${publicUrl} (not probed)`);
    return {
      originUrl: originValue,
      publicUrl,
      pid: tunnelPid,
      logPath: paths.log,
      stateDir: paths.dir,
    };
  } catch (error) {
    await stopTunnel(paths.dir);
    throw error;
  }
}

async function runWorker(arguments_: string[]): Promise<number> {
  const [mode, statePidFile, stateDir, environmentPath, commandJson] = arguments_;
  if (
    mode !== "__worker" ||
    !statePidFile ||
    !stateDir ||
    !environmentPath ||
    !commandJson
  ) {
    process.stderr.write("cloudflare-quick-tunnel worker: invalid arguments\n");
    return 2;
  }

  let environment: unknown;
  try {
    environment = JSON.parse(readText(environmentPath));
  } catch {
    return 2;
  } finally {
    rmSync(environmentPath, { force: true });
  }
  if (
    typeof environment !== "object" ||
    environment === null ||
    Array.isArray(environment) ||
    Object.values(environment).some((value) => typeof value !== "string")
  ) {
    return 2;
  }

  let command: unknown;
  try {
    command = JSON.parse(commandJson);
  } catch {
    return 2;
  }
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    command.some((value) => typeof value !== "string" || !value)
  ) {
    return 2;
  }

  writePrivate(statePidFile, `${process.pid}\n`);
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn(command as string[], {
      cwd: stateDir,
      env: environment as Record<string, string>,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    });
  } catch (error) {
    process.stderr.write(
      `cloudflare-quick-tunnel worker: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 127;
  }

  const forward = (signal: NodeJS.Signals): void => signalPid(child.pid, signal);
  const onTerm = (): void => forward("SIGTERM");
  const onInt = (): void => forward("SIGINT");
  const ignoreHup = (): void => {};
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);
  process.on("SIGHUP", ignoreHup);

  const exitCode = await child.exited;
  process.off("SIGTERM", onTerm);
  process.off("SIGINT", onInt);
  process.off("SIGHUP", ignoreHup);
  return exitCode;
}

if (import.meta.main) {
  runWorker(Bun.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      process.stderr.write(
        `cloudflare-quick-tunnel worker: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
