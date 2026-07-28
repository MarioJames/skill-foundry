import { readFileSync } from "node:fs";

function integer(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function pidAlive(pid: unknown): boolean {
  const value = integer(pid);
  if (!value) return false;
  try {
    process.kill(value, 0);
    const status = Bun.spawnSync({ cmd: ["ps", "-o", "stat=", "-p", String(value)], stdout: "pipe", stderr: "ignore", timeout: 1000 });
    if (status.exitCode === 0 && status.stdout.toString().trim().toUpperCase().startsWith("Z")) return false;
    return true;
  }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

export function processGroupLeaderAlive(pid: unknown): boolean {
  const value = integer(pid);
  if (!value || !pidAlive(value)) return false;
  const result = Bun.spawnSync({ cmd: ["ps", "-o", "pgid=", "-p", String(value)], stdout: "pipe", stderr: "ignore", timeout: 1000 });
  return result.exitCode === 0 && Number(result.stdout.toString().trim()) === value;
}

export function processGroupMembers(pgid: unknown): number[] | null {
  const value = integer(pgid);
  if (!value) return [];
  const result = Bun.spawnSync({ cmd: ["ps", "-axo", "pid=,pgid=,stat="], stdout: "pipe", stderr: "ignore", timeout: 1000 });
  if (result.exitCode !== 0) return null;
  const members: number[] = [];
  for (const line of result.stdout.toString().split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)/u.exec(line);
    if (match && Number(match[2]) === value && !match[3]!.toUpperCase().startsWith("Z")) members.push(Number(match[1]));
  }
  return members;
}

export function processGroupAlive(pgid: unknown): boolean {
  const value = integer(pgid);
  if (!value) return false;
  const members = processGroupMembers(value);
  if (members !== null) return members.length > 0;
  try { process.kill(-value, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

export function processHasNonce(pid: unknown, expectedNonce: unknown): boolean {
  const value = integer(pid);
  if (!value || !pidAlive(value) || typeof expectedNonce !== "string" || !expectedNonce) return false;
  const needle = `AGENTS_ORCHESTRATOR_EXECUTION_NONCE=${expectedNonce}`;
  try { return readFileSync(`/proc/${value}/environ`).toString().split("\0").includes(needle); } catch { /* macOS */ }
  const result = Bun.spawnSync({ cmd: ["ps", "eww", "-p", String(value), "-o", "command="], stdout: "pipe", stderr: "ignore", timeout: 1000 });
  return result.exitCode === 0 && result.stdout.toString().split(/\s/u).includes(needle);
}

function waitUntil(check: () => boolean, timeoutSeconds: number): boolean {
  const deadline = performance.now() + Math.max(0, timeoutSeconds) * 1000;
  while (performance.now() < deadline) {
    if (check()) return true;
    Bun.sleepSync(50);
  }
  return check();
}

export function waitAbsent(pid: unknown, timeoutSeconds = 3): boolean {
  return waitUntil(() => !pidAlive(pid), timeoutSeconds);
}

export function waitProcessGroupAbsent(pgid: unknown, timeoutSeconds = 3): boolean {
  return waitUntil(() => !processGroupAlive(pgid), timeoutSeconds);
}

function signalGroup(pgid: number, signal: NodeJS.Signals): boolean {
  const members = processGroupMembers(pgid);
  try { process.kill(-pgid, signal); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
    let signalled = false;
    for (const member of members ?? []) {
      try { process.kill(member, signal); signalled = true; }
      catch (memberError) { if ((memberError as NodeJS.ErrnoException).code !== "ESRCH") return false; }
    }
    return signalled;
  }
}

export function terminateProcessGroup(
  pid: unknown,
  options: { graceSeconds?: number; expectedNonce?: string | null; trusted?: boolean } = {},
): boolean {
  const value = integer(pid);
  if (!value || !processGroupAlive(value)) return true;
  if (!options.trusted && (!processGroupLeaderAlive(value) || !processHasNonce(value, options.expectedNonce))) return false;
  if (!signalGroup(value, "SIGTERM")) return !processGroupAlive(value);
  if (waitProcessGroupAbsent(value, options.graceSeconds ?? 1)) return true;
  if (!signalGroup(value, "SIGKILL")) return !processGroupAlive(value);
  return waitProcessGroupAbsent(value, options.graceSeconds ?? 1);
}
