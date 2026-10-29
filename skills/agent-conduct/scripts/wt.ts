#!/usr/bin/env bun
// One entry for task worktrees: fixed location, ready to run, and reclaimed after merge.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  defaultRef,
  findRepositories,
  git,
  lastActivity,
  lines,
  listWorktrees,
  mainWorktree,
  mergeEvidence,
  processesInside,
  remoteDefault,
  run,
  worktreeGitDir,
  type WorktreeEntry,
} from "./lib/git";

const HELP = `用法:
  bun wt.ts add --repo <仓库> --name <任务名> [--branch <分支>] [--base <提交>] [--no-install]
  bun wt.ts remove --path <worktree> [--force]
  bun wt.ts gc --workspace <工作区根>... [--min-idle <时长>] [--apply] [--json]

add     在 $AGENT_WORKTREE_ROOT（默认 ~/.local/share/worktrees）/<仓库名>/<任务名> 建 worktree：
        从 --base（默认先 fetch origin 实际的默认分支；不是主仓库当前检出的分支）新建分支（默认 wt/<任务名>），
        或检出 --branch 指定的已有分支；链接仓库的 .env，
        子模块优先从主仓库本地副本检出，按锁文件离线安装依赖。stdout 输出 JSON。
remove  核对无未提交改动、无未合入提交、无进程占用后删除 worktree，并删除已合入的任务分支；
        祖先、rebase、squash 合入都算已合入。远端还有同名分支时在 remoteBranch 中列出，由 branch.ts 处理。
        --force 跳过前两项核对，保留未合入的分支；有进程占用时始终拒绝。
gc      列出工作区内所有仓库的 worktree（不论由谁创建）：失效记录标 prune（HEAD 不在任何分支上的保留），
        已合入、无改动、无进程且闲置超过 --min-idle（默认 24h）的标 remove，其余 keep。
        默认只列出；加 --apply 才执行。`;

class UsageError extends Error {}
class Refusal extends Error {}

function fail(message: string): never {
  throw new Refusal(message);
}

function parseDuration(value: string): number {
  const match = /^(\d+)([mhd])$/u.exec(value);
  if (!match) throw new UsageError(`时长格式应为 90m、6h、2d：${value}`);
  return Number(match[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as "m" | "h" | "d"];
}

function parseFlags(argv: string[], booleans: string[]): Map<string, string[]> {
  const flags = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) throw new UsageError(`未知参数: ${arg}`);
    const key = arg.slice(2);
    if (booleans.includes(key)) {
      flags.set(key, ["true"]);
      continue;
    }
    const value = argv[++index];
    if (value === undefined) throw new UsageError(`${arg} 缺少参数`);
    flags.set(key, [...(flags.get(key) ?? []), value]);
  }
  return flags;
}

function required(flags: Map<string, string[]>, key: string): string {
  const value = flags.get(key)?.[0];
  if (!value) throw new UsageError(`缺少 --${key}`);
  return value;
}

function mustGit(repo: string, ...args: string[]): string {
  const result = git(repo, ...args);
  if (!result.ok) fail(`git ${args.join(" ")} 失败：${result.err.trim() || result.out.trim()}`);
  return result.out.trim();
}

function worktreeRoot(): string {
  return resolve(process.env.AGENT_WORKTREE_ROOT || join(homedir(), ".local", "share", "worktrees"));
}

function branchExists(repo: string, branch: string): boolean {
  return git(repo, "rev-parse", "--verify", "-q", `refs/heads/${branch}`).ok;
}

interface SubmoduleResult {
  path: string;
  source: "local" | "remote";
}

/** Checks out submodules from the superproject's own checkout when it has the commit; falls back to the remote. */
function checkoutSubmodules(repo: string, path: string): SubmoduleResult[] {
  if (!existsSync(join(path, ".gitmodules"))) return [];
  const results: SubmoduleResult[] = [];
  const entries = lines(git(path, "config", "-f", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$").out);
  for (const entry of entries) {
    const [key, subPath] = entry.split(" ");
    const name = key.slice("submodule.".length, -".path".length);
    const url =
      git(repo, "config", "--get", `submodule.${name}.url`).out.trim() ||
      git(path, "config", "-f", ".gitmodules", `submodule.${name}.url`).out.trim();
    const local = join(repo, subPath);
    if (existsSync(join(local, ".git"))) {
      // The URL override lives only on this command line, so the shared config keeps the real URL.
      const fromLocal = run([
        "git", "-C", path,
        "-c", "protocol.file.allow=always",
        "-c", `submodule.${name}.url=${local}`,
        "submodule", "update", "--init", "--", subPath,
      ]);
      if (fromLocal.ok) {
        if (url) git(join(path, subPath), "remote", "set-url", "origin", url);
        results.push({ path: subPath, source: "local" });
        continue;
      }
    }
    const reference = existsSync(join(local, ".git")) ? ["--reference", local] : [];
    const fromRemote = git(path, "submodule", "update", "--init", ...reference, "--", subPath);
    if (!fromRemote.ok) fail(`子模块 ${subPath} 检出失败：${fromRemote.err.trim()}`);
    results.push({ path: subPath, source: "remote" });
  }
  return results;
}

function linkEnv(repo: string, path: string): boolean {
  const source = join(repo, ".env");
  if (!existsSync(source) || existsSync(join(path, ".env"))) return false;
  if (git(repo, "ls-files", "--error-unmatch", ".env").ok) return false;
  symlinkSync(source, join(path, ".env"));
  return true;
}

function installCommands(path: string): string[][] | null {
  if (!existsSync(join(path, "package.json"))) return null;
  const manifest = JSON.parse(readFileSync(join(path, "package.json"), "utf8")) as { packageManager?: string };
  const declared = manifest.packageManager?.split("@")[0];
  const has = (file: string) => existsSync(join(path, file));
  if (has("pnpm-lock.yaml")) {
    return [
      ["pnpm", "install", "--frozen-lockfile", "--offline"],
      ["pnpm", "install", "--frozen-lockfile", "--prefer-offline"],
    ];
  }
  if (has("bun.lock") || has("bun.lockb")) return [["bun", "install", "--frozen-lockfile"]];
  if (has("package-lock.json")) return [["npm", "ci", "--prefer-offline"]];
  if (declared === "pnpm") return [["pnpm", "install", "--prefer-offline"]];
  if (declared === "bun") return [["bun", "install"]];
  return null;
}

function install(path: string): { command: string | null; ok: boolean; log: string | null } {
  const commands = installCommands(path);
  if (!commands) return { command: null, ok: true, log: null };
  const log = join(worktreeGitDir(path) ?? path, "agent-install.log");
  let output = "";
  for (const command of commands) {
    const result = run(command, path);
    output += `$ ${command.join(" ")}\n${result.out}${result.err}\n`;
    if (result.ok) {
      writeFileSync(log, output);
      return { command: command.join(" "), ok: true, log };
    }
  }
  writeFileSync(log, output);
  return { command: commands.at(-1)!.join(" "), ok: false, log };
}

/** Explicit --base, else origin's real default branch freshly fetched, else the local record. */
function chooseBase(repo: string, explicit: string | undefined): { base: string; baseNote?: string } {
  if (explicit) return { base: explicit };
  if (git(repo, "remote", "get-url", "origin").ok) {
    const name = remoteDefault(repo);
    if (name && git(repo, "fetch", "--quiet", "origin", `+refs/heads/${name}:refs/remotes/origin/${name}`).ok) return { base: `origin/${name}` };
    const fallback = defaultRef(repo) ?? "HEAD";
    return { base: fallback, baseNote: `无法从 origin 获取最新默认分支，改用本地记录 ${fallback}，可能不是最新` };
  }
  return { base: defaultRef(repo) ?? "HEAD" };
}

function add(flags: Map<string, string[]>) {
  const repo = resolve(required(flags, "repo"));
  const name = required(flags, "name");
  if (!/^[A-Za-z0-9._-]+$/u.test(name) || name.startsWith(".")) throw new UsageError(`任务名只能包含字母、数字、. _ -：${name}`);
  const top = git(repo, "rev-parse", "--show-toplevel").out.trim();
  if (top !== repo) fail(`--repo 应为仓库根目录：${repo}`);
  const owner = mainWorktree(repo);
  if (owner && owner !== repo) fail(`--repo 应为主工作树，而不是 worktree：${repo}（主工作树 ${owner}）`);

  const path = join(worktreeRoot(), basename(repo), name);
  if (existsSync(path)) fail(`目录已存在：${path}`);
  const explicitBranch = flags.get("branch")?.[0];
  const branch = explicitBranch ?? `wt/${name}`;
  const { base, baseNote } = chooseBase(repo, flags.get("base")?.[0]);
  mkdirSync(join(worktreeRoot(), basename(repo)), { recursive: true });

  if (branchExists(repo, branch)) {
    if (!explicitBranch) fail(`分支 ${branch} 已存在；要继续使用它，请显式传 --branch ${branch}`);
    mustGit(repo, "worktree", "add", path, branch);
  } else {
    mustGit(repo, "worktree", "add", "-b", branch, path, base);
  }

  const submodules = checkoutSubmodules(repo, path);
  const envLinked = linkEnv(repo, path);
  const installed = flags.has("no-install") ? { command: null, ok: true, log: null } : install(path);
  const report = { ok: installed.ok, cwd: path, branch, base, ...(baseNote ? { baseNote } : {}), repo, envLinked, submodules, install: installed };
  if (!installed.ok) {
    console.log(JSON.stringify(report, null, 2));
    console.error(`依赖安装失败，worktree 已保留在 ${path}；日志 ${installed.log}`);
    process.exit(1);
  }
  return report;
}

interface Assessment {
  repo: string;
  path: string;
  branch: string | null;
  action: "prune" | "remove" | "keep";
  reason: string;
}

function assess(repo: string, entry: WorktreeEntry, ref: string | null, minIdle: number): Assessment {
  const base = { repo, path: entry.path, branch: entry.branch };
  if (entry.prunable) {
    if (!entry.branch && entry.head && !isReferenced(repo, entry.head)) {
      return { ...base, action: "keep", reason: `失效记录，但 HEAD ${entry.head.slice(0, 10)} 不在任何分支或标签上；先建分支保存再清理` };
    }
    return { ...base, action: "prune", reason: "目录已不存在（失效记录）" };
  }
  if (entry.locked) return { ...base, action: "keep", reason: "已锁定" };
  const dirty = git(entry.path, "status", "--porcelain", "--untracked-files=normal").out.trim();
  if (dirty) return { ...base, action: "keep", reason: "有未提交改动" };
  if (!ref) return { ...base, action: "keep", reason: "无法确定默认分支" };
  if (!mergeEvidence(repo, entry.head, ref)) return { ...base, action: "keep", reason: `有未合入 ${ref} 的提交` };
  const pids = processesInside(entry.path);
  if (pids.length > 0) return { ...base, action: "keep", reason: `进程 ${pids.slice(0, 5).join(",")} 正在使用` };
  const idle = Date.now() - lastActivity(entry.path);
  if (idle < minIdle) return { ...base, action: "keep", reason: `最近 ${Math.round(idle / 60_000)} 分钟内有活动` };
  return { ...base, action: "remove", reason: `已合入 ${ref}、无改动、无进程占用` };
}

function removeWorktree(repo: string, entry: WorktreeEntry, ref: string | null): string | null {
  mustGit(repo, "worktree", "remove", "--force", entry.path);
  let branchDeleted: string | null = null;
  if (entry.branch && ref && branchExists(repo, entry.branch) && mergeEvidence(repo, entry.branch, ref)) {
    if (git(repo, "branch", "-D", entry.branch).ok) branchDeleted = entry.branch;
  }
  return branchDeleted;
}

function isReferenced(repo: string, commit: string): boolean {
  return Boolean(git(repo, "for-each-ref", "--count=1", "--contains", commit, "refs/heads", "refs/remotes", "refs/tags").out.trim());
}

/** Drops one stale record; `git worktree prune` would drop every stale record in the repository. */
function pruneRecord(repo: string, path: string): boolean {
  const common = mustGit(repo, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const admin = join(common, "worktrees");
  if (!existsSync(admin)) return false;
  for (const id of readdirSync(admin)) {
    try {
      if (readFileSync(join(admin, id, "gitdir"), "utf8").trim() === join(path, ".git")) {
        rmSync(join(admin, id), { recursive: true, force: true });
        return true;
      }
    } catch {
      // A record without a gitdir file is not one we can match safely.
    }
  }
  return false;
}

function remove(flags: Map<string, string[]>) {
  const path = resolve(required(flags, "path"));
  const repo = mainWorktree(path);
  if (!repo) fail(`不是 Git worktree：${path}`);
  if (repo === path) fail(`这是主工作树，不能删除：${path}`);
  const entry = listWorktrees(repo).find((candidate) => candidate.path === path);
  if (!entry) fail(`${repo} 没有登记这个 worktree：${path}`);
  const ref = defaultRef(repo);
  const pids = processesInside(path);
  if (pids.length > 0) fail(`进程 ${pids.join(",")} 正在使用 ${path}，先停止它们`);
  if (!flags.has("force")) {
    if (git(path, "status", "--porcelain", "--untracked-files=normal").out.trim()) fail(`有未提交的改动：${path}；确认可丢弃再加 --force`);
    if (!ref) fail(`无法确定 ${repo} 的默认分支；确认已合入再加 --force`);
    if (!mergeEvidence(repo, entry.head, ref)) fail(`有未合入 ${ref} 的提交：${path}；确认已另行合入或可丢弃再加 --force`);
  }
  const branchDeleted = removeWorktree(repo, entry, ref);
  const remoteBranch = entry.branch && git(repo, "rev-parse", "--verify", "-q", `refs/remotes/origin/${entry.branch}`).ok ? `origin/${entry.branch}` : null;
  return { ok: true, removed: path, repo, branchDeleted, remoteBranch };
}

function gc(flags: Map<string, string[]>) {
  const workspaces = (flags.get("workspace") ?? []).map((workspace) => resolve(workspace));
  if (workspaces.length === 0) throw new UsageError("缺少 --workspace");
  const minIdle = parseDuration(flags.get("min-idle")?.[0] ?? "24h");
  const apply = flags.has("apply");
  const assessments: (Assessment & { done?: string })[] = [];
  for (const workspace of workspaces) {
    for (const repo of findRepositories(workspace)) {
      const ref = defaultRef(repo);
      const entries = listWorktrees(repo);
      const results = entries.map((entry) => assess(repo, entry, ref, minIdle));
      if (apply) {
        results.forEach((result, index) => {
          if (result.action !== "remove") return;
          const deleted = removeWorktree(repo, entries[index], ref);
          (result as Assessment & { done?: string }).done = deleted ? `已删除，分支 ${deleted} 已删除` : "已删除";
        });
        for (const result of results) {
          if (result.action !== "prune") continue;
          (result as Assessment & { done?: string }).done = pruneRecord(repo, result.path) ? "已清理记录" : "未找到对应记录，未处理";
        }
      }
      assessments.push(...results);
    }
  }
  return { ok: true, applied: apply, worktrees: assessments };
}

function printGc(report: ReturnType<typeof gc>): void {
  const label = { prune: "清理记录", remove: "可回收", keep: "保留" };
  const out = [report.applied ? "worktree 回收结果：" : "worktree 盘点（只列出，加 --apply 执行）："];
  for (const item of report.worktrees) {
    out.push(`  [${label[item.action]}] ${item.path} (${item.branch ?? "detached"}) — ${item.reason}${(item as { done?: string }).done ? `；${(item as { done?: string }).done}` : ""}`);
  }
  if (report.worktrees.length === 0) out.push("  没有 worktree");
  console.log(out.join("\n"));
}

try {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    console.log(HELP);
    process.exit(command ? 0 : 2);
  }
  if (command === "add") console.log(JSON.stringify(add(parseFlags(rest, ["no-install"])), null, 2));
  else if (command === "remove") console.log(JSON.stringify(remove(parseFlags(rest, ["force"])), null, 2));
  else if (command === "gc") {
    const flags = parseFlags(rest, ["apply", "json"]);
    const report = gc(flags);
    if (flags.has("json")) console.log(JSON.stringify(report, null, 2));
    else printGc(report);
  } else throw new UsageError(`未知子命令: ${command}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(error instanceof UsageError ? 2 : 1);
}
