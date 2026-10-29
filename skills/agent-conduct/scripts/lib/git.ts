import { existsSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";

const SKIP_DIRS = new Set(["node_modules", ".git"]);

export interface RunResult {
  ok: boolean;
  out: string;
  err: string;
}

export function run(cmd: string[], cwd?: string, input?: string, timeout?: number): RunResult {
  try {
    const stdin = input === undefined ? "ignore" : Buffer.from(input);
    const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    const result = Bun.spawnSync({ cmd, cwd, env, stdin, stdout: "pipe", stderr: "pipe", timeout });
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

/** origin/HEAD when recorded, then origin/main or origin/master, then a local main or master. */
export function defaultRef(repo: string): string | null {
  const remote = git(repo, "symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD").out.trim();
  if (remote) return remote;
  for (const ref of ["refs/remotes/origin/main", "refs/remotes/origin/master", "refs/heads/main", "refs/heads/master"]) {
    if (git(repo, "rev-parse", "--verify", "-q", ref).ok) return ref.replace(/^refs\/(remotes|heads)\//u, "");
  }
  return null;
}

function parseSymref(out: string): string | null {
  return lines(out).find((line) => line.startsWith("ref: "))?.match(/^ref: refs\/heads\/(\S+)/u)?.[1] ?? null;
}

/** The default branch name origin actually declares; null without origin or network. */
export function remoteDefault(repo: string): string | null {
  if (!git(repo, "remote", "get-url", "origin").ok) return null;
  const result = run(["git", "-C", repo, "ls-remote", "--symref", "origin", "HEAD"], undefined, undefined, 20_000);
  return result.ok ? parseSymref(result.out) : null;
}

/** remoteDefault for many repositories at once; each query is a network round trip. */
export async function remoteDefaults(repos: string[]): Promise<Map<string, string | null>> {
  const query = async (repo: string): Promise<[string, string | null]> => {
    if (!git(repo, "remote", "get-url", "origin").ok) return [repo, null];
    try {
      const proc = Bun.spawn(["git", "-C", repo, "ls-remote", "--symref", "origin", "HEAD"], {
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
        signal: AbortSignal.timeout(20_000),
      });
      const out = await new Response(proc.stdout).text();
      return [repo, (await proc.exited) === 0 ? parseSymref(out) : null];
    } catch {
      return [repo, null];
    }
  };
  return new Map(await Promise.all(repos.map(query)));
}

/**
 * The default branch to judge merges against: origin's declared default when reachable
 * (the local origin/HEAD record can be stale), otherwise the local record.
 */
export function trustedDefaultRef(repo: string, name = remoteDefault(repo)): string | null {
  if (name && git(repo, "rev-parse", "--verify", "-q", `refs/remotes/origin/${name}`).ok) return `origin/${name}`;
  return defaultRef(repo);
}

export function isAncestor(repo: string, commit: string, ref: string): boolean {
  return git(repo, "merge-base", "--is-ancestor", commit, ref).ok;
}

export type MergeEvidence = "ancestor" | "rebased" | "squashed";

function patchId(repo: string, diff: string): string | null {
  return run(["git", "-C", repo, "patch-id", "--stable"], undefined, `commit ${"0".repeat(40)}\n${diff}`).out.split(" ")[0] || null;
}

/**
 * How a commit's content reached `ref`: as an ancestor, as rebased commits, or as one squash commit.
 * Read-only; null means some change is not on `ref`, or the squash was edited and needs PR evidence.
 */
export function mergeEvidence(repo: string, tip: string, ref: string): MergeEvidence | null {
  if (isAncestor(repo, tip, ref)) return "ancestor";
  const base = git(repo, "merge-base", ref, tip).out.trim();
  if (!base) return null;
  const cherry = lines(git(repo, "cherry", ref, tip, base).out);
  if (cherry.length > 0 && cherry.every((line) => line.startsWith("- "))) return "rebased";
  // A squash commit changes exactly the branch's files; only those candidates get a full patch id.
  const files = lines(git(repo, "diff", "--name-only", "--no-renames", base, tip).out).sort();
  if (files.length === 0) return null;
  const sameFiles = lines(git(repo, "log", "--no-merges", "--format=%H", `${base}..${ref}`, "--", ...files).out).filter(
    (commit) => lines(git(repo, "diff-tree", "--no-commit-id", "--name-only", "--no-renames", "-r", commit).out).sort().join("\n") === files.join("\n"),
  );
  if (sameFiles.length === 0) return null;
  const squash = patchId(repo, git(repo, "diff", "--no-color", "--no-renames", base, tip).out);
  if (!squash) return null;
  return sameFiles.some((commit) => patchId(repo, git(repo, "diff-tree", "-p", "--no-color", "--no-renames", "--no-commit-id", commit).out) === squash) ? "squashed" : null;
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
