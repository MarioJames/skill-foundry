import { readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { capture, CliError, listSessionWorkspaces, sessionUnit } from "./herdr-route";

// `route-lane.ts --create-session`: create a brand-new hidden session and prove which server instance
// we started. It never adopts a session that already exists, running or stopped.

export interface SessionProof {
  unit: string;
  invocation_id: string;
  server_pid: number;
  server_starttime: number;
  boot_id: string;
}

export interface CreatedSession {
  name: string;
  created: true;
  proof: SessionProof;
  dir_id: { dev: number; ino: number };
}

const LAUNCHER = resolve(import.meta.dir, "../session-launcher.sh");
const EXIT_SESSION_EXISTS = 73;
const EXIT_SESSION_FOREIGN = 75;
// systemd refuses a second scope with the same name (wording differs between versions).
const UNIT_TAKEN = /already (?:loaded|exists)|fragment file/iu;
function tail(text: string): string {
  return text.split("\n").filter((line) => line.trim() && !line.startsWith("Running as unit:")).slice(-3).join(" | ");
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Field 22 of /proc/<pid>/stat; comm (field 2) may contain spaces and parentheses, so cut after the last ')'. */
export function parseStartTicks(stat: string): number | null {
  const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const ticks = Number(rest[19]);
  return Number.isSafeInteger(ticks) ? ticks : null;
}

function socketInode(socketPath: string): string | null {
  for (const line of (readText("/proc/net/unix") ?? "").split("\n")) {
    const fields = line.trim().split(/\s+/u);
    if (fields.at(-1) === socketPath && fields.length >= 8) return fields[6]!;
  }
  return null;
}

/** True when `pid` is a `... --session NAME server` process holding the listening socket. */
function isServingProcess(pid: number, name: string, socketPath: string): boolean {
  const argv = (readText(`/proc/${pid}/cmdline`) ?? "").split("\0").slice(0, -1);
  if (argv.slice(-3).join("\0") !== ["--session", name, "server"].join("\0")) return false;
  const inode = socketInode(socketPath);
  if (!inode) return false;
  try {
    return readdirSync(`/proc/${pid}/fd`).some((fd) => {
      try {
        return readlinkSync(`/proc/${pid}/fd/${fd}`) === `socket:[${inode}]`;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

async function showUnit(unit: string): Promise<{ invocationId: string; controlGroup: string }> {
  const shown = await capture(["systemctl", "--user", "show", `${unit}.scope`, "-p", "InvocationID", "-p", "ControlGroup"]);
  const field = (key: string) => shown.stdout.split("\n").find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1) ?? "";
  const invocationId = field("InvocationID");
  const controlGroup = field("ControlGroup");
  if (shown.status !== 0 || !invocationId || !controlGroup) {
    throw new CliError("session_start_failed", `Could not read InvocationID/ControlGroup of ${unit}.scope: ${tail(shown.stderr)}`);
  }
  return { invocationId, controlGroup };
}

export async function createSession(name: string, opTag: string, timeoutMs = 10_000): Promise<CreatedSession> {
  if (!Bun.which("systemd-run")) {
    throw new CliError("missing_dependency", "systemd-run is required to create a hidden session; not falling back to a bare server", 127);
  }
  const unit = sessionUnit(name);
  const fail = (message: string, session: Record<string, unknown> = { name, unit: `${unit}.scope` }) =>
    new CliError("session_start_failed", message, 1, { session });

  // The scope name is the atomic claim: systemd refuses a second active unit with the same name. The
  // launcher then refuses an existing directory or registered name before forking the server.
  const child = Bun.spawn([
    "systemd-run", "--user", "--scope", "--collect", `--unit=${unit}`,
    "-p", "MemoryHigh=8G", "-p", "MemoryMax=10G",
    "--", "sh", LAUNCHER, "--op-tag", opTag, name,
  ], { stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true, env: process.env });
  child.unref();
  const stdout = Bun.readableStreamToText(child.stdout);
  const stderr = Bun.readableStreamToText(child.stderr);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const exited = await Promise.race([
    child.exited,
    new Promise<null>((done) => { timer = setTimeout(() => done(null), timeoutMs); }),
  ]);
  clearTimeout(timer);
  if (exited === null) {
    child.kill();
    throw fail(`Launcher for session ${name} did not finish within ${timeoutMs} ms (unit ${unit}.scope)`);
  }
  const [out, err] = [await stdout, await stderr];
  if (exited === EXIT_SESSION_EXISTS || (exited !== 0 && UNIT_TAKEN.test(err))) {
    throw new CliError("session_exists", `Session ${name} already exists (${tail(err)}); not reusing or restoring it`, 1);
  }
  if (exited === EXIT_SESSION_FOREIGN) {
    throw new CliError(
      "session_foreign",
      `Session ${name} directory was written to by someone else before its server started (${tail(err)}); no server was started and the directory was left untouched`,
      1,
      { session: { name, unit: `${unit}.scope` } },
    );
  }
  const serverPid = Number(out.trim().split("\n").at(-1));
  if (exited !== 0 || !Number.isSafeInteger(serverPid) || serverPid <= 0) {
    throw fail(`Could not start session ${name} (launcher exit ${exited}): ${tail(err) || tail(out)}`);
  }

  // Wait for the socket, then verify what is listening is the process the launcher forked.
  const deadline = Date.now() + timeoutMs;
  let workspaces: unknown[] | null = null;
  while (Date.now() < deadline && !workspaces) {
    workspaces = await listSessionWorkspaces(name).catch(() => null);
    if (!workspaces) {
      if (!statSafe(`/proc/${serverPid}`)) throw fail(`Server of session ${name} exited during startup`);
      await Bun.sleep(100);
    }
  }
  if (!workspaces) throw fail(`Session ${name} did not become available within ${timeoutMs} ms`);

  const listed = JSON.parse((await capture(["herdr", "session", "list", "--json"])).stdout || "{}");
  const entry = (listed?.sessions ?? []).find((candidate: any) => candidate?.name === name);
  const dir: unknown = entry?.session_dir;
  const socketPath: unknown = entry?.socket_path;
  if (typeof dir !== "string" || typeof socketPath !== "string") {
    throw fail(`Herdr does not list session ${name} after starting it`);
  }
  if (!isServingProcess(serverPid, name, socketPath)) {
    // The socket answers but not through our process: another server already owned this session.
    throw new CliError(
      "session_foreign",
      `Session ${name} is served by a process other than the server this call started (pid ${serverPid}); left untouched`,
      1,
      { session: { name, unit: `${unit}.scope` } },
    );
  }
  const { invocationId, controlGroup } = await showUnit(unit);
  if (!(readText(`/proc/${serverPid}/cgroup`) ?? "").split("\n").includes(`0::${controlGroup}`)) {
    throw fail(`Server ${serverPid} is not inside ${unit}.scope`);
  }
  const startTicks = parseStartTicks(readText(`/proc/${serverPid}/stat`) ?? "");
  const bootId = (readText("/proc/sys/kernel/random/boot_id") ?? "").trim();
  if (startTicks === null || !bootId) throw fail(`Could not read the identity of server ${serverPid}`);

  const dirInfo = statSync(dir, { bigint: true });
  const created: CreatedSession = {
    name,
    created: true,
    proof: { unit: `${unit}.scope`, invocation_id: invocationId, server_pid: serverPid, server_starttime: startTicks, boot_id: bootId },
    dir_id: { dev: Number(dirInfo.dev), ino: Number(dirInfo.ino) },
  };

  // A restored workspace means the server loaded state someone else saved; a brand-new session has none.
  if (workspaces.length > 0) {
    throw new CliError(
      "session_foreign",
      `Session ${name} came up with ${workspaces.length} restored workspace(s) it did not create; left untouched`,
      1,
      { session: created },
    );
  }
  return created;
}

function statSafe(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}
