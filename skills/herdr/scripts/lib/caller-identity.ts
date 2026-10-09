import { execFileSync } from "node:child_process";

/** Read OS ancestry, rather than trusting inherited Agent or Herdr IDs. */
export function ancestorPids(): number[] {
  const ancestors: number[] = [];
  let pid = process.pid;
  while (pid > 1 && !ancestors.includes(pid)) {
    ancestors.push(pid);
    const parent = Number(execFileSync("ps", ["-p", String(pid), "-o", "ppid="], { encoding: "utf8" }).trim());
    if (!Number.isSafeInteger(parent) || parent <= 0) break;
    pid = parent;
  }
  // The resolver itself is not an Agent identity.
  return ancestors.slice(1).filter((value) => value > 1);
}

export function ownsPane(paneId: string, info: any, ancestors: readonly number[]): boolean {
  if (info?.pane_id !== paneId || !Array.isArray(info.foreground_processes)) return false;
  return info.foreground_processes.some((entry: any) =>
    Number.isSafeInteger(entry?.pid) && entry.pid > 1 && ancestors.includes(entry.pid));
}
