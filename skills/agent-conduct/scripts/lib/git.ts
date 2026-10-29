import { existsSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";

const SKIP_DIRS = new Set(["node_modules", ".git"]);

export interface RunResult {
  ok: boolean;
  out: string;
  err: string;
}

export function run(cmd: string[], cwd?: string): RunResult {
  try {
    const result = Bun.spawnSync({ cmd, cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    return { ok: result.exitCode === 0, out: result.stdout.toString(), err: result.stderr.toString() };
  } catch (error) {
    return { ok: false, out: "", err: error instanceof Error ? error.message : String(error) };
  }
}

export function git(repo: string, ...args: string[]): RunResult {
  return run(["git", "-C", repo, ...args]);
}

export function lines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}

export function isRepository(path: string): boolean {
  return existsSync(join(path, ".git"));
}

export function findRepositories(root: string, depth = 3): string[] {
  const found: string[] = [];
  const walk = (dir: string, level: number) => {
    if (isRepository(dir)) found.push(dir);
    if (level >= depth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), level + 1);
    }
  };
  walk(root, 0);
  return found;
}

/** origin/HEAD when the remote declares one, otherwise a local main or master. */
export function defaultRef(repo: string): string | null {
  const remote = git(repo, "rev-parse", "--abbrev-ref", "origin/HEAD");
  if (remote.ok && remote.out.trim() && remote.out.trim() !== "origin/HEAD") return remote.out.trim();
  for (const name of ["main", "master"]) {
    if (git(repo, "rev-parse", "--verify", "-q", `refs/heads/${name}`).ok) return name;
  }
  return null;
}

export function isAncestor(repo: string, commit: string, ref: string): boolean {
  return git(repo, "merge-base", "--is-ancestor", commit, ref).ok;
}

export interface WorktreeEntry {
  path: string;
  head: string;
  branch: string | null;
  prunable: boolean;
  locked: boolean;
}

/** Linked worktrees of a repository; the main worktree is excluded. */
export function listWorktrees(repo: string): WorktreeEntry[] {
  const blocks = git(repo, "worktree", "list", "--porcelain").out.split("\n\n").slice(1);
  const entries: WorktreeEntry[] = [];
  for (const block of blocks) {
    const fields = lines(block);
    const path = fields.find((line) => line.startsWith("worktree "))?.slice(9);
    if (!path) continue;
    const branchRef = fields.find((line) => line.startsWith("branch "))?.slice(7);
    entries.push({
      path,
      head: fields.find((line) => line.startsWith("HEAD "))?.slice(5) ?? "",
      branch: branchRef ? branchRef.replace(/^refs\/heads\//u, "") : null,
      prunable: fields.some((line) => line === "prunable" || line.startsWith("prunable ")),
      locked: fields.some((line) => line === "locked" || line.startsWith("locked ")),
    });
  }
  return entries;
}

/** The main worktree that owns a (possibly linked) worktree path. */
export function mainWorktree(path: string): string | null {
  const first = lines(git(path, "worktree", "list", "--porcelain").out)[0];
  return first?.startsWith("worktree ") ? first.slice(9) : null;
}

/** The per-worktree administrative directory (.git/worktrees/<id>) of a linked worktree. */
export function worktreeGitDir(path: string): string | null {
  try {
    const pointer = readFileSync(join(path, ".git"), "utf8").trim();
    if (!pointer.startsWith("gitdir: ")) return null;
    const target = pointer.slice(8);
    return isAbsolute(target) ? target : resolve(path, target);
  } catch {
    return null;
  }
}

/** Most recent activity on a linked worktree: its checkout root and Git HEAD/index. */
export function lastActivity(path: string): number {
  const gitDir = worktreeGitDir(path);
  const candidates = [path, ...(gitDir ? [join(gitDir, "HEAD"), join(gitDir, "index")] : [])];
  let latest = 0;
  for (const candidate of candidates) {
    try {
      latest = Math.max(latest, statSync(candidate).mtimeMs);
    } catch {
      // A missing index just means nothing was staged yet.
    }
  }
  return latest;
}

/** PIDs whose working directory is inside the path; empty when /proc is unavailable. */
export function processesInside(path: string): number[] {
  const pids: number[] = [];
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return pids;
  }
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) continue;
    try {
      const cwd = readlinkSync(`/proc/${entry}/cwd`);
      if (cwd === path || cwd.startsWith(path + sep)) pids.push(Number(entry));
    } catch {
      // Other users' processes and exited ones are not readable.
    }
  }
  return pids;
}
