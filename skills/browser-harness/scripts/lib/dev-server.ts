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
  labelFile,
  log,
  logDir,
  parsePositiveInteger,
  pidFile,
  sleep,
  warn,
} from "./common.ts";

const DEV_SERVER_MODULE = fileURLToPath(import.meta.url);

interface DevServerInfo {
  appUrl: string;
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

export function resolveDevCommand(projectDir: string): string {
  if (!projectDir || !existsSync(projectDir)) {
    fail(2, `项目目录不存在：${projectDir}`);
  }

  const packagePath = join(projectDir, "package.json");
  if (!existsSync(packagePath)) {
    fail(2, `目录缺少 package.json：${projectDir}`);
  }

  if (process.env.BH_DEV_COMMAND) {
    return process.env.BH_DEV_COMMAND;
  }

  let scripts: Record<string, unknown> = {};
  try {
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    scripts = packageJson.scripts || {};
  } catch {
    // 与旧实现一致：无法读取 scripts 时最终走显式命令错误。
  }

  for (const script of ["dev", "start", "serve"]) {
    if (scripts[script]) return `bun run ${script}`;
  }

  fail(
    2,
    "package.json 里找不到 dev/start/serve 之一；请用 BH_DEV_COMMAND=... 显式指定",
  );
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
    // 进程可能在信号发送前已经退出。
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

export async function stopDevServer(projectDir: string): Promise<void> {
  const statePidFile = pidFile(projectDir);
  const stateLabelFile = labelFile(projectDir);
  const label = readText(stateLabelFile).trim();
  rmSync(stateLabelFile, { force: true });

  if (!existsSync(statePidFile)) {
    log("无 pid 文件，跳过");
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
    log(`pid ${pid} 不存活，跳过`);
    removeLaunchctlJob(label);
    return;
  }

  const pgid = processGroupId(pid);
  const currentPgid = processGroupId(process.pid);
  const useProcessGroup =
    pgid !== null && currentPgid !== null && pgid !== currentPgid;

  if (useProcessGroup) {
    signalProcessGroup(pgid, "SIGTERM");
  } else {
    killDescendants(pid, "SIGTERM");
  }
  signalPid(pid, "SIGTERM");
  removeLaunchctlJob(label);

  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (!isProcessAlive(pid)) {
      log(`dev server ${pid} 已退出`);
      return;
    }
    await sleep(1_000);
  }

  if (useProcessGroup && pgid !== null) {
    signalProcessGroup(pgid, "SIGKILL");
  } else {
    killDescendants(pid, "SIGKILL");
  }
  signalPid(pid, "SIGKILL");

  for (let attempt = 0; attempt < 40 && isProcessAlive(pid); attempt += 1) {
    await sleep(50);
  }
  log(`dev server ${pid} force-killed`);
}

function launchWithLaunchctl(
  label: string,
  devLog: string,
  statePidFile: string,
  projectDir: string,
  devCommand: string,
): void {
  const result = syncCommand([
    "launchctl",
    "submit",
    "-l",
    label,
    "-o",
    devLog,
    "-e",
    devLog,
    "--",
    process.execPath,
    DEV_SERVER_MODULE,
    "__worker",
    statePidFile,
    projectDir,
    devCommand,
  ]);
  if (result.exitCode !== 0) {
    fail(2, `launchctl submit 失败（exit ${result.exitCode}）`);
  }
}

function launchDetached(
  devLog: string,
  statePidFile: string,
  projectDir: string,
  devCommand: string,
): number {
  const logDescriptor = openSync(devLog, "a");
  try {
    const child = Bun.spawn(["bash", "-lc", devCommand], {
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

function readPortFromLog(path: string): string {
  const match = readText(path).match(
    /http:\/\/(?:localhost|127\.0\.0\.1):([0-9]+)/,
  );
  return match?.[1] || "";
}

function curlStatus(url: string, noProxy: string): string {
  const result = syncCommand(
    [
      "curl",
      "--noproxy",
      noProxy,
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

export async function startDevServer(
  iteration: string,
  projectDir: string,
  devCommand: string,
): Promise<DevServerInfo> {
  ensureLogDir();
  const timestamp = Math.floor(Date.now() / 1_000);
  const devLog = join(logDir(), `dev-${iteration}-${timestamp}.log`);
  const statePidFile = pidFile(projectDir);
  const stateLabelFile = labelFile(projectDir);

  const oldPid = readPid(statePidFile);
  if (oldPid !== null && isProcessAlive(oldPid)) {
    warn(`已有 dev server pid ${oldPid} 仍存活，先停掉`);
    await stopDevServer(projectDir);
  }

  log(`启动 dev：${devCommand}`);
  log(`log: ${devLog}`);

  let devPid: number | null = null;
  if (process.platform === "darwin" && findExecutable("launchctl")) {
    const sanitizedIteration = iteration.replace(/[^A-Za-z0-9_.-]/g, "-");
    const label = `com.codex.browser-harness.${sanitizedIteration}.${timestamp}`;
    writeFileSync(stateLabelFile, `${label}\n`);
    try {
      launchWithLaunchctl(
        label,
        devLog,
        statePidFile,
        projectDir,
        devCommand,
      );
    } catch (error) {
      rmSync(statePidFile, { force: true });
      rmSync(stateLabelFile, { force: true });
      removeLaunchctlJob(label);
      throw error;
    }

    const pidWaitAttempts = parsePositiveInteger(
      process.env.BH_DEV_PID_WAIT_ATTEMPTS,
      30,
    );
    for (let attempt = 0; attempt < pidWaitAttempts; attempt += 1) {
      devPid = readPid(statePidFile);
      if (devPid !== null && isProcessAlive(devPid)) break;
      await sleep(1_000);
    }
    if (devPid === null || !isProcessAlive(devPid)) {
      tailLog(devLog);
      await stopDevServer(projectDir);
      fail(2, "launchctl job 没有发布存活 pid");
    }
  } else {
    devPid = launchDetached(devLog, statePidFile, projectDir, devCommand);
  }

  log(`dev server pid: ${devPid}`);

  try {
    const portWaitAttempts = parsePositiveInteger(
      process.env.BH_DEV_PORT_WAIT_ATTEMPTS,
      60,
    );
    let port = "";
    for (let attempt = 0; attempt < portWaitAttempts; attempt += 1) {
      if (!isProcessAlive(devPid)) {
        tailLog(devLog);
        fail(2, "dev 进程在打印端口前退出");
      }
      port = readPortFromLog(devLog);
      if (port) break;
      await sleep(2_000);
    }
    if (!port) {
      tailLog(devLog);
      fail(2, "等待 dev 端口超时");
    }

    const appHost = process.env.BH_APP_HOST || "localhost";
    const basePath = process.env.BASE_PATH || "/";
    const curlNoProxy = process.env.BH_CURL_NO_PROXY || "*";
    const appUrl = `http://${appHost}:${port}${basePath}`;

    const readyWaitAttempts = parsePositiveInteger(
      process.env.BH_DEV_READY_WAIT_ATTEMPTS,
      60,
    );
    let readyCode = "000";
    for (let attempt = 0; attempt < readyWaitAttempts; attempt += 1) {
      readyCode = curlStatus(appUrl, curlNoProxy);
      const numericCode = Number(readyCode);
      if (readyCode !== "000" && numericCode < 500) break;
      await sleep(2_000);
    }
    if (readyCode === "000" || Number(readyCode) >= 500) {
      tailLog(devLog);
      fail(3, `APP_URL ${appUrl} 不可达`);
    }

    log(`ready: ${appUrl} (http ${readyCode})`);
    return { appUrl, pid: devPid, logPath: devLog };
  } catch (error) {
    await stopDevServer(projectDir);
    throw error;
  }
}

async function runWorker(arguments_: string[]): Promise<number> {
  const [mode, statePidFile, projectDir, devCommand] = arguments_;
  if (
    mode !== "__worker" ||
    !statePidFile ||
    !projectDir ||
    devCommand === undefined
  ) {
    process.stderr.write("browser-harness dev worker: invalid arguments\n");
    return 2;
  }

  writeFileSync(statePidFile, `${process.pid}\n`);
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn(["bash", "-lc", devCommand], {
      cwd: projectDir,
      env: process.env,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    });
  } catch (error) {
    process.stderr.write(
      `browser-harness dev worker: ${error instanceof Error ? error.message : String(error)}\n`,
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
