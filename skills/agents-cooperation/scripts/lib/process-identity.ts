import { readFileSync, readdirSync } from "node:fs";
export interface ProcessIdentity {
  pid: number;
  starttime: string;
  boot_id: string;
  source: string;
}
export type Life = "alive" | "dead" | "unknown";
export function procStat(pid: number) {
  const text = readFileSync(`/proc/${pid}/stat`, "utf8");
  const closing = text.lastIndexOf(")");
  const fields = text
    .slice(closing + 2)
    .trim()
    .split(/\s+/);
  if (
    closing < 0 ||
    !text.startsWith(`${pid} (`) ||
    fields.length < 20 ||
    !/^[A-Za-z]$/.test(fields[0]) ||
    !/^\d+$/.test(fields[1]) ||
    !/^\d+$/.test(fields[19])
  )
    throw new Error("invalid process stat evidence");
  return { ppid: Number(fields[1]), starttime: fields[19], state: fields[0] };
}
export function processIdentity(pid = process.pid, source = "runtime"): ProcessIdentity {
  return {
    pid,
    starttime: procStat(pid).starttime,
    boot_id: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
    source
  };
}
export function processLife(identity: ProcessIdentity | null): Life {
  if (
    !identity ||
    !Number.isInteger(identity.pid) ||
    identity.pid < 1 ||
    typeof identity.starttime !== "string" ||
    !/^\d+$/.test(identity.starttime) ||
    typeof identity.boot_id !== "string" ||
    !identity.boot_id
  )
    return "unknown";
  let boot: string;
  try {
    boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return "unknown";
  }
  if (boot !== identity.boot_id) return "dead";
  try {
    const s = procStat(identity.pid);
    return s.starttime !== identity.starttime || s.state === "Z" ? "dead" : "alive";
  } catch (error) {
    return (error as any).code === "ENOENT" || (error as any).code === "ESRCH" ? "dead" : "unknown";
  }
}
export function ownerIdentity(
  engine: string,
  env: Record<string, string | undefined> = process.env
): ProcessIdentity | null {
  try {
    let pid = process.pid;
    const visited = new Set<number>();
    while (pid > 1 && !visited.has(pid)) {
      visited.add(pid);
      const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
      const executable = (cmd[0] ?? "").split("/").at(-1)!;
      if (engine === "claude" && env.CLAUDE_PID && pid === Number(env.CLAUDE_PID))
        return processIdentity(pid, "claude-ancestor");
      if (engine === "codex" && /^codex(?:[-_].*)?$/.test(executable) && !cmd.includes("app-server"))
        return processIdentity(pid, "codex-tui-ancestor");
      pid = procStat(pid).ppid;
    }
  } catch {
    /* Missing evidence is deliberately not inferred from environment alone. */
  }
  return null;
}
export function operationInFlight(op: string, boot: string, holderStarttime?: string): boolean {
  if (readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() !== boot) return false;
  const holderTicks =
    typeof holderStarttime === "string" && /^\d+$/.test(holderStarttime) ? BigInt(holderStarttime) : null;
  const realUid = process.getuid?.(),
    effectiveUid = process.geteuid?.();
  if (realUid === undefined || effectiveUid === undefined) throw new Error("cannot inspect current process uid");
  const currentUids = new Set([realUid, effectiveUid]);
  for (const name of readdirSync("/proc").filter((n) => /^\d+$/.test(n))) {
    if (Number(name) === process.pid) continue;
    try {
      // status retains real/effective uid evidence even for non-dumpable processes whose proc directory is root-owned.
      const status = readFileSync(`/proc/${name}/status`, "utf8");
      const uid = /^Uid:\s+(\d+)\s+(\d+)\s+\d+\s+\d+\s*$/m.exec(status);
      if (!uid) throw new Error("missing process uid evidence");
      if (!currentUids.has(Number(uid[1])) && !currentUids.has(Number(uid[2]))) continue;
      // A confirmed zombie has exited and cannot perform side effects; its descendants are scanned independently.
      if (procStat(Number(name)).state === "Z") continue;
      const args = readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0");
      if (args[0] === `agents-cooperation-op:${op}` || args.some((a, i) => a === "--op-tag" && args[i + 1] === op))
        return true;
      let environment: string[];
      try {
        environment = readFileSync(`/proc/${name}/environ`).toString("utf8").split("\0");
      } catch (error) {
        if (!["ENOENT", "ESRCH"].includes((error as any).code) && holderTicks !== null) {
          // Only strictly older same-boot processes can be excluded as descendants of this lock operation.
          // Same-tick/newer processes and missing or malformed stat evidence remain fail-closed.
          if (BigInt(procStat(Number(name)).starttime) < holderTicks) continue;
        }
        throw error;
      }
      if (environment.includes(`AGENTS_COOPERATION_OP_TAG=${op}`)) return true;
    } catch (error) {
      if (!["ENOENT", "ESRCH"].includes((error as any).code))
        throw new Error(`cannot inspect in-flight process ${name}`);
    }
  }
  return false;
}
