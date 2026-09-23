import { readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";

export interface ProcessInfo {
  pid: number;
  parentPid: number;
  tty: string | null;
  token: string;
}

export function capture(command: string[]): string {
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe", timeout: 15_000 });
  if (result.exitCode !== 0) throw new Error(`${command[0]} failed (exit ${result.exitCode})`);
  return result.stdout.toString();
}

export function processes(): Map<number, ProcessInfo> {
  const text = capture(["ps", "-axo", "pid=,ppid=,tty=,lstart="]);
  const result = new Map<number, ProcessInfo>();
  for (const line of text.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (match) result.set(Number(match[1]), {
      pid: Number(match[1]), parentPid: Number(match[2]),
      tty: ["?", "??"].includes(match[3]!) ? null : match[3]!, token: match[4]!,
    });
  }
  return result;
}

export function identity(pid: number): string | null {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return fields[0] === "Z" ? null : fields[19] ?? null;
    }
    return processes().get(pid)?.token ?? null;
  } catch { return null; }
}

export function ancestry(pid: number, table: Map<number, ProcessInfo>): number[] {
  const result: number[] = [];
  while (pid > 1 && !result.includes(pid)) {
    result.push(pid);
    pid = table.get(pid)?.parentPid ?? 0;
  }
  return result;
}

export function canonical(path: string): string | null {
  try { return realpathSync(path); } catch { return null; }
}

export function belongs(cwd: string | null, project: string): boolean {
  return cwd !== null && (cwd === project || cwd.startsWith(`${project}/`));
}

export function processCwd(pid: number): string | null {
  try {
    if (process.platform === "linux") return canonical(readlinkSync(`/proc/${pid}/cwd`));
    const output = capture(["lsof", "-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
    const path = output.split("\n").find((line) => line.startsWith("n"))?.slice(1);
    return path ? canonical(path) : null;
  } catch { return null; }
}

export function outputFiles(pid: number): { fd: number; kind: string; path: string | null }[] {
  return [1, 2].map((fd) => {
    if (process.platform !== "linux") return { fd, kind: "unavailable", path: null };
    try {
      const path = readlinkSync(`/proc/${pid}/fd/${fd}`);
      if (path.startsWith("/dev/pts/") || path.startsWith("/dev/tty")) return { fd, kind: "terminal", path };
      // Never read pipes/TTYs: that can consume the service's output.
      if (path.startsWith("/") && statSync(path).isFile()) return { fd, kind: "file", path };
      return { fd, kind: "unavailable", path: null };
    } catch { return { fd, kind: "unavailable", path: null }; }
  });
}

export interface PaneInfo { pane_id: string; tab_id: string; shell_pid: number; foreground_pids: number[] }
export function matchingPanes(pid: number, table: Map<number, ProcessInfo>, panes: PaneInfo[]): PaneInfo[] {
  const chain = ancestry(pid, table);
  const tty = table.get(pid)?.tty;
  return panes.filter((pane) => {
    const anchors = [pane.shell_pid, ...pane.foreground_pids];
    return anchors.some((anchor) => chain.includes(anchor))
      || (!!tty && anchors.some((anchor) => table.get(anchor)?.tty === tty));
  });
}

export function herdrPanes(): { panes: PaneInfo[]; warning: string | null } {
  if (!Bun.which("herdr")) return { panes: [], warning: "herdr unavailable" };
  try {
    const workspaces = JSON.parse(capture(["herdr", "workspace", "list"])).result.workspaces;
    const panes: PaneInfo[] = [];
    for (const workspace of workspaces) {
      const listed = JSON.parse(capture(["herdr", "pane", "list", "--workspace", workspace.workspace_id])).result.panes;
      for (const pane of listed) {
        const info = JSON.parse(capture(["herdr", "pane", "process-info", "--pane", pane.pane_id])).result.process_info;
        panes.push({ pane_id: pane.pane_id, tab_id: pane.tab_id, shell_pid: info.shell_pid,
          foreground_pids: (info.foreground_processes ?? []).map((p: { pid: number }) => p.pid) });
      }
    }
    return { panes, warning: null };
  } catch { return { panes: [], warning: "Herdr pane inventory incomplete; do not infer that no pane exists" }; }
}

export function inspect(projectInput: string, rootPid?: number) {
  const project = canonical(projectInput);
  if (!project || !statSync(project).isDirectory()) throw new Error("project must be an existing directory");
  if (!Bun.which("strayd")) throw new Error("strayd unavailable; use native socket/PID inspection as documented, never treat this as no service");
  // --no-config avoids user display-hide rules concealing a running service.
  const scan = JSON.parse(capture(["strayd", "--no-config", "list", "--json"]));
  if (!Array.isArray(scan.groups) || !Array.isArray(scan.warnings)) throw new Error("unsupported strayd JSON schema");
  const warnings: string[] = [...scan.warnings];
  const table = processes();
  if (rootPid && !table.has(rootPid)) throw new Error("root PID is no longer running");
  const inventory = herdrPanes();
  const seen = new Set<number>();
  const candidates = scan.groups.flatMap((group: any) => group.services).filter((service: any) => {
    if (!Number.isInteger(service.pid) || seen.has(service.pid)) return false;
    seen.add(service.pid);
    return true;
  }).flatMap((service: any) => {
    const pid = service.pid as number;
    const chain = ancestry(pid, table);
    if (rootPid && !chain.includes(rootPid)) return [];
    // Verify current cwd rather than trusting a cached scanner label or project name.
    const cwd = processCwd(pid);
    if (!cwd && (rootPid || belongs(canonical(service.cwd ?? ""), project))) {
      warnings.push(`PID ${pid}: current working directory unavailable; ownership cannot be verified`);
    }
    if (!belongs(cwd, project)) return [];
    const token = identity(pid);
    if (!token) return [];
    const ports = (service.ports ?? []).filter((port: number) => Number.isInteger(port) && port > 0 && port <= 65535);
    if (!ports.length) return [];
    return [{ pid, identity: token, parent_pid: table.get(pid)?.parentPid ?? null, cwd,
      match: cwd === project ? "exact" : "descendant", ports, hosts: service.hosts ?? [],
      runtime: service.runtime, kind: service.resourceKind,
      pane_matches: matchingPanes(pid, table, inventory.panes), output: outputFiles(pid),
    }];
  });
  return { project, status: warnings.length ? "incomplete" : candidates.length === 0 ? "none" : candidates.length === 1 ? "single" : "multiple",
    candidates, warnings, pane_warning: inventory.warning,
    // Listening inventory is not proof that a starting/hung dev process is absent.
    http_verified: false };
}
