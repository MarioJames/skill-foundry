#!/usr/bin/env bun
import { closeSync, mkdirSync, openSync, writeFileSync, writeSync } from "node:fs";
import { resolve, join } from "node:path";
import { ancestry, canonical, identity, processes } from "./lib/dev-process";

const usage = `Usage: dev-run.ts --project PATH --state-dir PATH -- COMMAND [ARG...]
Run in a fresh Herdr service pane. Foreground output is also saved to dev.log.
Writes dev-process.json with runner PID, identity, child PID and log path.
Use a fresh task state directory. SIGTERM/SIGINT stop only this runner's children.`;

async function main() {
  const args = Bun.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") { console.log(usage); return; }
  const separator = args.indexOf("--");
  if (separator < 0) throw new Error(usage);
  const flags = args.slice(0, separator);
  let project: string | null = null;
  let stateDir: string | null = null;
  for (let i = 0; i < flags.length; i += 2) {
    if (!flags[i + 1]) throw new Error(usage);
    if (flags[i] === "--project") project = canonical(flags[i + 1]!);
    else if (flags[i] === "--state-dir") stateDir = resolve(flags[i + 1]!);
    else throw new Error(usage);
  }
  const command = args.slice(separator + 1);
  if (!project || !stateDir || !command.length) throw new Error(usage);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const statePath = join(stateDir, "dev-process.json");
  const logPath = join(stateDir, "dev.log");
  // Exclusive creation prevents accidental duplicate starts and preserves failed-run evidence.
  const stateFd = openSync(statePath, "wx", 0o600);
  closeSync(stateFd);
  const logFd = openSync(logPath, "ax", 0o600);
  const owned = new Map<number, string>();
  let stopping: Promise<void> | null = null;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let exitCode = 1;
  const state = { project, runner_pid: process.pid, runner_identity: identity(process.pid), child_pid: 0, log_path: logPath, running: true, exit_code: null as number | null };
  const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  const remember = () => {
    const table = processes();
    for (const pid of table.keys()) {
      if (pid !== process.pid && ancestry(pid, table).includes(process.pid)) {
        const token = identity(pid);
        if (token) owned.set(pid, token);
      }
    }
  };
  const signal = (sig: NodeJS.Signals) => {
    for (const [pid, token] of [...owned].reverse()) {
      if (identity(pid) === token) {
        try { process.kill(pid, sig); } catch { /* exited */ }
      }
    }
  };
  const stop = () => stopping ??= (async () => {
    remember();
    signal("SIGTERM");
    for (let n = 0; n < 30 && [...owned].some(([pid, token]) => identity(pid) === token); n++) await Bun.sleep(100);
    signal("SIGKILL");
  })();
  const onSignal = () => { void stop().catch((error) => console.error(`DEV cleanup failed: ${error.message}`)); };
  let monitor: ReturnType<typeof setInterval> | undefined;
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  process.on("SIGHUP", onSignal);
  try {
    child = Bun.spawn(command, { cwd: project, stdin: "inherit", stdout: "pipe", stderr: "pipe" });
    state.child_pid = child.pid;
    save();
    remember();
    monitor = setInterval(() => {
      try { remember(); } catch { /* Final cleanup retries the process inventory. */ }
    }, 500);
    const copy = async (stream: ReadableStream<Uint8Array>, fd: number) => {
      for await (const chunk of stream) {
        writeSync(logFd, chunk);
        writeSync(fd, chunk);
      }
    };
    const streams = Promise.all([copy(child.stdout as ReadableStream<Uint8Array>, 1), copy(child.stderr as ReadableStream<Uint8Array>, 2)]);
    // Observe both promises immediately; terminate remaining descendants on normal exit too.
    const exited = child.exited.then(async (code) => { await stop(); return code; });
    [exitCode] = await Promise.all([exited, streams]);
  } catch (error) {
    if (child) await stop();
    throw error;
  } finally {
    if (monitor) clearInterval(monitor);
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    process.off("SIGHUP", onSignal);
    closeSync(logFd);
    state.running = false;
    state.exit_code = exitCode;
    save();
  }
  process.exitCode = exitCode;
}

if (import.meta.main) {
  try { await main(); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
