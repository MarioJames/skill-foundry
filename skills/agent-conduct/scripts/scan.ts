#!/usr/bin/env bun
// Read-only scan for leftovers an agent task may have left on this host. Deletes nothing.

import { lstatSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { defaultRef, findRepositories, isAncestor, lines, listWorktrees, run } from "./lib/git";

const HELP = `用法: bun scan.ts [--since <时间>] [--workspace <目录>]... [--temp-root <目录>]... [--no-docker] [--json]

只读扫描本机可能遗留的任务资源，不删除任何内容。结果是待核实的候选，不是删除清单。
  --since       时间窗起点：ISO 时间或相对时长（90m、6h、2d），默认 24h；作用于临时位置和 Docker
  --workspace   工作区根（仓库的上一级目录，如 ~/workspaces/<项目组>），可重复；检查其下仓库和根目录杂项
  --temp-root   替换默认临时位置（$TMPDIR、/tmp、~/.cache、~/.local/share），可重复
  --no-docker   跳过 Docker
  --json        输出 JSON`;

const WORKSPACE_KEEP = new Set(["reports", "evidence"]);
const ARTIFACT_NAME = /^\.?(task-artifacts|reports?|evidence|screenshots?|worktrees|tmp)$/i;

interface Options {
  since: Date;
  workspaces: string[];
  tempRoots: string[];
  docker: boolean;
  json: boolean;
}

interface Worktree {
  path: string;
  branch: string | null;
  prunable: boolean;
  merged: boolean;
  insideRepository: boolean;
}

interface RepositoryReport {
  path: string;
  defaultRef: string | null;
  worktrees: Worktree[];
  untracked: string[];
  ignoredArtifacts: string[];
  mergedBranches: string[];
}

interface TemporaryGroup {
  root: string;
  pattern: string;
  count: number;
  example: string;
  newest: string;
}

interface DockerReport {
  stoppedContainers: { name: string; image: string; created: string; owner: string; status: string }[];
  unlabeledRunning: { name: string; image: string; created: string }[];
  danglingVolumes: { total: number; inWindow: number; anonymousInWindow: number };
}

class UsageError extends Error {}

function parseSince(value: string): Date {
  const relative = /^(\d+)([mhd])$/u.exec(value);
  if (relative) {
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[relative[2] as "m" | "h" | "d"];
    return new Date(Date.now() - Number(relative[1]) * unit);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new UsageError(`--since 无法解析: ${value}`);
  return date;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { since: parseSince("24h"), workspaces: [], tempRoots: [], docker: true, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined) throw new UsageError(`${arg} 缺少参数`);
      return next;
    };
    if (arg === "--since") options.since = parseSince(value());
    else if (arg === "--workspace") options.workspaces.push(resolve(value()));
    else if (arg === "--temp-root") options.tempRoots.push(resolve(value()));
    else if (arg === "--no-docker") options.docker = false;
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(HELP);
      process.exit(0);
    } else throw new UsageError(`未知参数: ${arg}`);
  }
  if (options.tempRoots.length === 0) {
    const home = homedir();
    options.tempRoots = [...new Set([tmpdir(), "/tmp", join(home, ".cache"), join(home, ".local", "share")])];
  }
  return options;
}

function scanWorktrees(repo: string, ref: string | null): Worktree[] {
  return listWorktrees(repo).map(({ path, head, branch, prunable }) => ({
    path,
    branch,
    prunable,
    merged: Boolean(ref && head && !prunable && isAncestor(repo, head, ref)),
    insideRepository: path.startsWith(repo + sep),
  }));
}

function scanRepository(repo: string): RepositoryReport {
  const ref = defaultRef(repo);
  const status = lines(
    run(["git", "-C", repo, "status", "--porcelain=v1", "--untracked-files=normal", "--ignored=matching"]).out,
  );
  const untracked = status.filter((line) => line.startsWith("?? ")).map((line) => line.slice(3));
  const ignoredArtifacts = status
    .filter((line) => line.startsWith("!! "))
    .map((line) => line.slice(3))
    .filter((path) => ARTIFACT_NAME.test(basename(path.replace(/\/$/u, ""))));
  const current = run(["git", "-C", repo, "branch", "--show-current"]).out.trim();
  const defaultName = ref?.replace(/^origin\//u, "");
  const mergedBranches = ref
    ? lines(run(["git", "-C", repo, "for-each-ref", "--format=%(refname:short)", "--merged", ref, "refs/heads"]).out)
        .filter((name) => name !== current && name !== defaultName && name !== "main" && name !== "master")
        .sort()
    : [];
  return { path: repo, defaultRef: ref, worktrees: scanWorktrees(repo, ref), untracked, ignoredArtifacts, mergedBranches };
}

function scanWorkspaceRoot(workspace: string, repositories: string[]): string[] {
  const repoNames = new Set(repositories.map((repo) => repo.slice(workspace.length + 1)));
  let entries;
  try {
    entries = readdirSync(workspace, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .map((entry) => entry.name)
    .filter((name) => !WORKSPACE_KEEP.has(name) && !repoNames.has(name) && name !== ".git")
    .sort();
}

// Collapses random suffixes (mkdtemp's 6 characters, hex/nanoid names) so one test run reads as one line.
function groupName(name: string): string {
  if (/^tmp[A-Za-z0-9_]{6,}$/u.test(name)) return "tmp*";
  const stripped = name
    .replace(/([-_.])[A-Za-z0-9]{6}$/u, "$1*")
    .replace(/([-_.])(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{7,}$/u, "$1*");
  if (stripped !== name) return stripped;
  const random =
    /^[A-Za-z0-9_-]{16,}$/u.test(name) && ((/[A-Z]/u.test(name) && /[a-z]/u.test(name)) || /^[0-9a-f]+$/u.test(name));
  return random ? "<随机名>" : name;
}

function scanTemporary(roots: string[], since: Date): TemporaryGroup[] {
  const uid = process.getuid?.();
  const groups = new Map<string, TemporaryGroup>();
  for (const root of roots) {
    let names: string[];
    try {
      names = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(root, name);
      let stat;
      try {
        stat = lstatSync(path);
      } catch {
        continue;
      }
      if (uid !== undefined && stat.uid !== uid) continue;
      const created = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
      if (created < since.getTime()) continue;
      const pattern = groupName(name);
      const key = `${root}\0${pattern}`;
      const createdIso = new Date(created).toISOString();
      const group = groups.get(key);
      if (group) {
        group.count += 1;
        if (createdIso > group.newest) group.newest = createdIso;
      } else groups.set(key, { root, pattern, count: 1, example: path, newest: createdIso });
    }
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.pattern.localeCompare(b.pattern));
}

function dockerTime(value: string): Date {
  const match = /^(\S+) (\S+) ([+-]\d{2})(\d{2})/u.exec(value);
  return match ? new Date(`${match[1]}T${match[2]}${match[3]}:${match[4]}`) : new Date(value);
}

function scanDocker(since: Date): DockerReport | null {
  const format = "{{.Names}}\t{{.Image}}\t{{.CreatedAt}}\t{{.Label \"owner\"}}\t{{.Status}}";
  const all = run(["docker", "ps", "-a", "--format", format]);
  if (!all.ok) return null;
  const containers = lines(all.out).map((line) => {
    const [name, image, created, owner, status] = line.split("\t");
    return { name, image, created: dockerTime(created).toISOString(), owner, status };
  });
  const inWindow = containers.filter((container) => new Date(container.created) >= since);
  const volumeNames = lines(run(["docker", "volume", "ls", "-q", "--filter", "dangling=true"]).out);
  let windowCount = 0;
  let anonymous = 0;
  for (let index = 0; index < volumeNames.length; index += 200) {
    const batch = volumeNames.slice(index, index + 200);
    const inspected = run(["docker", "volume", "inspect", "--format", "{{.CreatedAt}}\t{{json .Labels}}", ...batch]);
    for (const line of lines(inspected.out)) {
      const [created, labels] = line.split("\t");
      if (new Date(created) < since) continue;
      windowCount += 1;
      if (labels.includes("com.docker.volume.anonymous")) anonymous += 1;
    }
  }
  return {
    stoppedContainers: inWindow.filter((container) => !container.status.startsWith("Up")),
    unlabeledRunning: inWindow
      .filter((container) => container.status.startsWith("Up") && !container.owner)
      .map(({ name, image, created }) => ({ name, image, created })),
    danglingVolumes: { total: volumeNames.length, inWindow: windowCount, anonymousInWindow: anonymous },
  };
}

function printText(report: ReturnType<typeof buildReport>): void {
  const out: string[] = [`扫描窗口起点：${report.since}（只读，未删除任何内容）`];
  const docker = report.docker;
  if (docker) {
    out.push("", "[Docker]");
    for (const c of docker.stoppedContainers) out.push(`  已停止容器 ${c.name} (${c.image}) ${c.status} owner=${c.owner || "-"}`);
    for (const c of docker.unlabeledRunning) out.push(`  运行中未加 owner 标签 ${c.name} (${c.image}) 创建于 ${c.created}`);
    const v = docker.danglingVolumes;
    out.push(`  悬空卷：窗口内新增 ${v.inWindow} 个（匿名 ${v.anonymousInWindow}），全部 ${v.total} 个`);
  }
  if (report.temporary.length > 0) {
    out.push("", "[临时位置：窗口内新建]");
    for (const g of report.temporary) out.push(`  ${g.root}/${g.pattern} ×${g.count}（最新 ${g.newest}）例：${g.example}`);
  }
  for (const repo of report.repositories) {
    const notes: string[] = [];
    for (const w of repo.worktrees) {
      const state = w.prunable ? "目录已不存在（失效记录）" : w.merged ? `已并入 ${repo.defaultRef}` : "未并入默认分支";
      notes.push(`  worktree ${w.path} [${w.branch ?? "detached"}] ${state}${w.insideRepository ? "，位于仓库内" : ""}`);
    }
    if (repo.untracked.length > 0) notes.push(`  未跟踪：${repo.untracked.join(", ")}`);
    if (repo.ignoredArtifacts.length > 0) notes.push(`  被忽略的产物目录：${repo.ignoredArtifacts.join(", ")}`);
    if (repo.mergedBranches.length > 0) {
      const shown = repo.mergedBranches.slice(0, 8).join(", ");
      const more = repo.mergedBranches.length > 8 ? ` 等 ${repo.mergedBranches.length} 个` : "";
      notes.push(`  已并入 ${repo.defaultRef} 的本地分支：${shown}${more}`);
    }
    if (notes.length > 0) out.push("", `[仓库] ${repo.path}`, ...notes);
  }
  for (const stray of report.workspaceStrays) {
    if (stray.entries.length > 0) out.push("", `[工作区根] ${stray.workspace}`, `  非仓库、非 reports/evidence：${stray.entries.join(", ")}`);
  }
  out.push("", "以上为候选：逐项核实归属，只回收本任务创建且已无依赖的资源；不确定的保留并在回复中说明。");
  console.log(out.join("\n"));
}

function buildReport(options: Options) {
  const repositories: RepositoryReport[] = [];
  const workspaceStrays: { workspace: string; entries: string[] }[] = [];
  for (const workspace of options.workspaces) {
    const repos = findRepositories(workspace).filter((repo) => repo !== workspace);
    repositories.push(...repos.map(scanRepository));
    workspaceStrays.push({ workspace, entries: scanWorkspaceRoot(workspace, repos) });
  }
  return {
    since: options.since.toISOString(),
    docker: options.docker ? scanDocker(options.since) : null,
    temporary: scanTemporary(options.tempRoots, options.since),
    repositories,
    workspaceStrays,
  };
}

try {
  const options = parseArgs(process.argv.slice(2));
  const report = buildReport(options);
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else printText(report);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(error instanceof UsageError ? 2 : 1);
}
