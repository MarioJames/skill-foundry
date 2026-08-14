import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BhError,
  ensureLogDir,
  fail,
  findExecutable,
  isProcessAlive,
  log,
  logDir,
  sleep,
  tunnelLabelFile,
  tunnelPidFile,
  tunnelUrlFile,
  warn,
} from "./common.ts";

const PUBLIC_TUNNEL_MODULE = fileURLToPath(import.meta.url);
const TUNNEL_PID_WAIT_ATTEMPTS = 30;
const TUNNEL_URL_WAIT_ATTEMPTS = 30;
const TUNNEL_READY_WAIT_ATTEMPTS = 30;

export interface PublicTunnelInfo {
  publicUrl: string;
  pid: number;
  logPath: string;
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
    // 进程可能已经退出。
  }
}

function signalProcessGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // 进程组可能已经退出或当前用户无权限。
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

export async function stopPublicTunnel(projectDir: string): Promise<void> {
  const statePidFile = tunnelPidFile(projectDir);
  const stateLabelFile = tunnelLabelFile(projectDir);
  const label = readText(stateLabelFile).trim();
  rmSync(stateLabelFile, { force: true });
  rmSync(tunnelUrlFile(projectDir), { force: true });

  if (!existsSync(statePidFile)) {
    log("无 tunnel pid 文件，跳过");
    removeLaunchctlJob(label);
    return;
  }

  const pid = readPid(statePidFile);
  rmSync(statePidFile, { force: true });
  if (pid === null) {
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

function resolveTunnelCommand(originUrl: string, originHost: string): string[] {
  const executable = findExecutable("cloudflared");
  if (!executable) {
    fail(2, "未找到 cloudflared；请先安装 Cloudflare Tunnel 客户端");
  }

  const configPath = join(logDir(), "quick-tunnel-empty.yml");
  writeFileSync(configPath, "");

  return [
    executable,
    "tunnel",
    "--config",
    configPath,
    "--no-autoupdate",
    "--url",
    originUrl,
    "--http-host-header",
    originHost,
  ];
}

function launchWithLaunchctl(
  label: string,
  tunnelLog: string,
  statePidFile: string,
  projectDir: string,
  command: string[],
): void {
  const result = syncCommand([
    "launchctl",
    "submit",
    "-l",
    label,
    "-o",
    tunnelLog,
    "-e",
    tunnelLog,
    "--",
    process.execPath,
    PUBLIC_TUNNEL_MODULE,
    "__worker",
    statePidFile,
    projectDir,
    JSON.stringify(command),
  ]);
  if (result.exitCode !== 0) {
    fail(2, `launchctl submit Cloudflare tunnel 失败（exit ${result.exitCode}）`);
  }
}

function launchDetached(
  tunnelLog: string,
  statePidFile: string,
  projectDir: string,
  command: string[],
): number {
  const logDescriptor = openSync(tunnelLog, "a");
  try {
    const child = Bun.spawn(command, {
      cwd: projectDir,
      env: process.env,
      stdin: "ignore",
      stdout: logDescriptor,
      stderr: logDescriptor,
      detached: true,
    });
    child.unref();
    writeFileSync(statePidFile, `${child.pid}\n`);
    return child.pid;
  } finally {
    closeSync(logDescriptor);
  }
}

function quickTunnelUrl(path: string): string {
  return readText(path).match(
    /https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.trycloudflare\.com/,
  )?.[0] || "";
}

function appendAppPath(publicBase: string, appUrl: URL): string {
  const result = new URL(publicBase);
  result.pathname = appUrl.pathname;
  result.search = appUrl.search;
  result.hash = appUrl.hash;
  return result.toString();
}

function curlStatus(url: string): string {
  const result = syncCommand(
    [
      "curl",
      "-L",
      "--max-time",
      "10",
      "-s",
      "-o",
      "/dev/null",
      "-w",
      "%{http_code}",
      url,
    ],
    { stdout: "pipe" },
  );
  const value = result.stdout.trim();
  return /^\d{3}$/.test(value) ? value : "000";
}

export async function startPublicTunnel(
  iteration: string,
  projectDir: string,
  appUrlValue: string,
): Promise<PublicTunnelInfo> {
  let appUrl: URL;
  try {
    appUrl = new URL(appUrlValue);
    if (appUrl.protocol !== "http:" && appUrl.protocol !== "https:") {
      throw new Error();
    }
  } catch {
    fail(2, `APP_URL 不是有效 HTTP(S) URL：${appUrlValue}`);
  }

  ensureLogDir();
  const timestamp = Math.floor(Date.now() / 1_000);
  const tunnelLog = join(logDir(), `tunnel-${iteration}-${timestamp}.log`);
  const statePidFile = tunnelPidFile(projectDir);
  const stateLabelFile = tunnelLabelFile(projectDir);
  const command = resolveTunnelCommand(appUrl.origin, appUrl.host);

  const oldPid = readPid(statePidFile);
  if (oldPid !== null && isProcessAlive(oldPid)) {
    warn(`已有 Cloudflare tunnel pid ${oldPid} 仍存活，先停掉`);
    await stopPublicTunnel(projectDir);
  } else {
    rmSync(statePidFile, { force: true });
    rmSync(stateLabelFile, { force: true });
    rmSync(tunnelUrlFile(projectDir), { force: true });
  }

  log(`启动 Cloudflare tunnel，origin: ${appUrl.origin}`);
  log(`log: ${tunnelLog}`);

  let tunnelPid: number | null = null;
  if (process.platform === "darwin" && findExecutable("launchctl")) {
    const sanitizedIteration = iteration.replace(/[^A-Za-z0-9_.-]/g, "-");
    const label = `com.codex.browser-harness.tunnel.${sanitizedIteration}.${timestamp}`;
    writeFileSync(stateLabelFile, `${label}\n`);
    try {
      launchWithLaunchctl(
        label,
        tunnelLog,
        statePidFile,
        projectDir,
        command,
      );
    } catch (error) {
      rmSync(statePidFile, { force: true });
      rmSync(stateLabelFile, { force: true });
      removeLaunchctlJob(label);
      throw error;
    }

    for (let attempt = 0; attempt < TUNNEL_PID_WAIT_ATTEMPTS; attempt += 1) {
      tunnelPid = readPid(statePidFile);
      if (tunnelPid !== null && isProcessAlive(tunnelPid)) break;
      await sleep(500);
    }
    if (tunnelPid === null || !isProcessAlive(tunnelPid)) {
      tailLog(tunnelLog);
      await stopPublicTunnel(projectDir);
      fail(2, "Cloudflare tunnel job 没有发布存活 pid");
    }
  } else {
    tunnelPid = launchDetached(tunnelLog, statePidFile, projectDir, command);
  }

  log(`Cloudflare tunnel pid: ${tunnelPid}`);

  try {
    let publicUrl = "";
    for (
      let attempt = 0;
      attempt < TUNNEL_URL_WAIT_ATTEMPTS && !publicUrl;
      attempt += 1
    ) {
      if (!isProcessAlive(tunnelPid)) {
        tailLog(tunnelLog);
        fail(2, "Cloudflare tunnel 在生成公网 URL 前退出");
      }
      const base = quickTunnelUrl(tunnelLog);
      if (base) publicUrl = appendAppPath(base, appUrl);
      else await sleep(500);
    }
    if (!publicUrl) {
      tailLog(tunnelLog);
      fail(2, "等待 Quick Tunnel 公网 URL 超时");
    }

    let readyCode = "000";
    for (let attempt = 0; attempt < TUNNEL_READY_WAIT_ATTEMPTS; attempt += 1) {
      if (!isProcessAlive(tunnelPid)) {
        tailLog(tunnelLog);
        fail(2, "Cloudflare tunnel 在公网探活前退出");
      }
      readyCode = curlStatus(publicUrl);
      if (readyCode !== "000" && Number(readyCode) < 500) break;
      await sleep(1_000);
    }
    if (readyCode === "000" || Number(readyCode) >= 500) {
      tailLog(tunnelLog);
      fail(3, `远程走查 URL ${publicUrl} 不可达`);
    }

    writeFileSync(tunnelUrlFile(projectDir), `${publicUrl}\n`);
    log(`remote ready: ${publicUrl} (http ${readyCode})`);
    return { publicUrl, pid: tunnelPid, logPath: tunnelLog };
  } catch (error) {
    await stopPublicTunnel(projectDir);
    throw error;
  }
}

async function runWorker(arguments_: string[]): Promise<number> {
  const [mode, statePidFile, projectDir, commandJson] = arguments_;
  if (mode !== "__worker" || !statePidFile || !projectDir || !commandJson) {
    process.stderr.write("browser-harness tunnel worker: invalid arguments\n");
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

  writeFileSync(statePidFile, `${process.pid}\n`);
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn(command as string[], {
      cwd: projectDir,
      env: process.env,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    });
  } catch (error) {
    process.stderr.write(
      `browser-harness tunnel worker: ${error instanceof Error ? error.message : String(error)}\n`,
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
  try {
    process.exitCode = await runWorker(Bun.argv.slice(2));
  } catch (error) {
    if (error instanceof BhError) {
      process.stderr.write(`[bh][error] ${error.message}\n`);
      process.exitCode = error.exitCode;
    } else {
      process.stderr.write(
        `[bh][error] ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    }
  }
}
