#!/usr/bin/env bun
// Close-out scan. With --task it reports what carries that task's name (temporary roots, containers, share pages,
// worktrees) plus what appeared in the window without any owner mark; without it, it inventories the whole host.
// Read-only unless --clean. With --task that removes only what carries the task's name (its temporary roots and
// merged worktrees); without it, what the sibling scripts judge safe host-wide (merged idle worktrees, stale
// worktree records, merged local branches).
// Containers, volumes, share objects and untracked files are never deleted.

import { existsSync, lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
  findRepositories,
  lines,
  listWorktrees,
  mergeEvidence,
  processesInside,
  remoteDefaults,
  run,
  trustedDefaultRef,
} from "./lib/git";

const HELP = `用法: bun scan.ts --task <任务名> --workspace <工作区根>... [--clean] [--since <时间>] [--no-docker] [--json]
      bun scan.ts --workspace <工作区根>... [--since <时间>] [--clean] [--temp-root <目录>]... [--no-docker] [--json]

带 --task 是任务收尾：只报带这个任务名的资源，和窗口内新出现却没有任何归属标记的东西，其余只给个数。
  任务名的标记：临时根 <临时目录>/<任务名>.XXXXXX（mktemp -d 建），容器标签 owner=<任务名>，
                分享登记的 task，worktree 目录名或分支 wt/<任务名>。
  窗口起点默认取任务临时根的创建时间，没有临时根时取 24h 前。
不带 --task 是整机盘点：列出窗口内所有候选，用于整理环境。

  --clean       清理低风险项，其余只列出。
                带 --task 只清带任务名的：临时根（没有进程在用），已合入、无改动、无进程占用的 worktree
                  及其本地分支（同 wt.ts remove）。别人的东西不动。
                不带 --task 清整机的：已合入、无改动、无进程占用且闲置超过 24h 的 worktree 和失效的 worktree
                  记录（同 wt.ts gc --apply），已合入默认分支的本地分支（同 branch.ts --apply，不动远端，
                  记录写入 <工作区根>/evidence/branch-cleanup/）。
  --since       时间窗起点：ISO 时间或相对时长（90m、6h、2d）
  --workspace   工作区根（仓库的上一级目录，如 ~/workspaces/<项目组>），可重复
  --temp-root   整机盘点时替换默认临时位置（$TMPDIR、/tmp、~/.cache、~/.local/share），可重复
  --no-docker   跳过 Docker
  --json        输出完整结果
容器、卷、分享对象、未跟踪文件和工作区根杂项从不自动删除。`;

const WORKSPACE_KEEP = new Set(["reports", "evidence"]);
// 与 agent-conduct 同级安装的 feature-delivery；不存在时跳过
const SHARE_SCRIPT = join(dirname(import.meta.dir), "..", "feature-delivery", "scripts", "share.ts");
const ARTIFACT_NAME = /^\.?(task-artifacts|reports?|evidence|screenshots?|worktrees|tmp)$/i;
const WT_SCRIPT = join(import.meta.dir, "wt.ts");
const BRANCH_SCRIPT = join(import.meta.dir, "branch.ts");
// Desktop apps drop plain files here all day; only directories look like task leftovers.
const APP_DATA_ROOTS = new Set([join(homedir(), ".cache"), join(homedir(), ".local", "share")]);
const TEXT_GROUP_LIMIT = 10;
const TASK_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

interface Options {
  since: Date;
  workspaces: string[];
  tempRoots: string[];
  docker: boolean;
  json: boolean;
  clean: boolean;
  task: string | null;
  sinceGiven: boolean;
}

interface WorktreeAction {
  repo: string;
  path: string;
  branch: string | null;
  action: "prune" | "remove" | "keep";
  reason: string;
  done?: string;
}

interface BranchCleanup {
  repo: string;
  branches: string[];
  record?: string;
  failed?: string[];
}

interface Cleanup {
  worktrees: WorktreeAction[];
  branches: BranchCleanup[];
  roots: { path: string; created: string; done?: string }[];
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
  labelled: { name: string; image: string; created: string; owner: string; releaseWhen: string; status: string }[];
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
  const options: Options = { since: parseSince("24h"), workspaces: [], tempRoots: [], docker: true, json: false, clean: false, task: null, sinceGiven: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined) throw new UsageError(`${arg} 缺少参数`);
      return next;
    };
    if (arg === "--since") {
      options.since = parseSince(value());
      options.sinceGiven = true;
    }
    else if (arg === "--workspace") options.workspaces.push(resolve(value()));
    else if (arg === "--temp-root") options.tempRoots.push(resolve(value()));
    else if (arg === "--no-docker") options.docker = false;
    else if (arg === "--json") options.json = true;
    else if (arg === "--clean") options.clean = true;
    else if (arg === "--task") {
      options.task = value();
      if (!TASK_NAME.test(options.task)) throw new UsageError("--task 只能用字母、数字、点、下划线和连字符，且以字母或数字开头");
    }
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
    merged: Boolean(ref && head && !prunable && mergeEvidence(repo, head, ref)),
    insideRepository: path.startsWith(repo + sep),
  }));
}

function scanRepository(repo: string, remoteDefault: string | null): RepositoryReport {
  const ref = trustedDefaultRef(repo, remoteDefault);
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
    ? lines(run(["git", "-C", repo, "for-each-ref", "--format=%(refname:short)", "refs/heads"]).out)
        .filter((name) => name !== current && name !== defaultName && name !== "main" && name !== "master")
        .filter((name) => mergeEvidence(repo, name, ref))
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
  if (/^\.?tmp[A-Za-z0-9_]{6,}$/u.test(name)) return name.startsWith(".") ? ".tmp*" : "tmp*";
  const stripped = name
    .replace(/([-_.])[A-Za-z0-9]{6}$/u, "$1*")
    .replace(/([-_.])(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{7,}$/u, "$1*");
  if (stripped !== name) return stripped;
  const random =
    /^[A-Za-z0-9_-]{16,}$/u.test(name) && ((/[A-Z]/u.test(name) && /[a-z]/u.test(name)) || /^[0-9a-f]+$/u.test(name));
  return random ? "<随机名>" : name;
}

function scanTemporary(roots: string[], since: Date, skip: Set<string>): TemporaryGroup[] {
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
      if (skip.has(name)) continue;
      const path = join(root, name);
      let stat;
      try {
        stat = lstatSync(path);
      } catch {
        continue;
      }
      if (uid !== undefined && stat.uid !== uid) continue;
      if (stat.isSymbolicLink() || stat.isSocket() || stat.isFIFO()) continue;
      if (!stat.isDirectory() && APP_DATA_ROOTS.has(root)) continue;
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
  const format = "{{.Names}}\t{{.Image}}\t{{.CreatedAt}}\t{{.Label \"owner\"}}\t{{.Label \"release-when\"}}\t{{.Status}}";
  const all = run(["docker", "ps", "-a", "--format", format]);
  if (!all.ok) return null;
  const containers = lines(all.out).map((line) => {
    const [name, image, created, owner, releaseWhen, status] = line.split("\t");
    return { name, image, created: dockerTime(created).toISOString(), owner, releaseWhen, status };
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
    stoppedContainers: inWindow
      .filter((container) => !container.status.startsWith("Up"))
      .map(({ name, image, created, owner, status }) => ({ name, image, created, owner, status })),
    unlabeledRunning: inWindow
      .filter((container) => container.status.startsWith("Up") && !container.owner)
      .map(({ name, image, created }) => ({ name, image, created })),
    labelled: containers.filter((container) => container.owner),
    danglingVolumes: { total: volumeNames.length, inWindow: windowCount, anonymousInWindow: anonymous },
  };
}

interface ShareReport {
  ledger: string;
  objects: { task: string; releaseWhen: string; at: string; key: string; url: string; entry: string }[];
  error?: string;
}

function scanShares(): ShareReport | null {
  if (!existsSync(SHARE_SCRIPT)) return null;
  const result = run([process.execPath, SHARE_SCRIPT, "list"]);
  try {
    if (result.ok) return JSON.parse(result.out) as ShareReport;
  } catch {}
  return { ledger: "", objects: [], error: result.err.trim() || "share.ts list 输出无法解析" };
}

/** Merged local branches that no worktree has checked out; branch.ts makes the final call when it deletes. */
function deletableBranches(repo: RepositoryReport): string[] {
  return repo.mergedBranches.filter((name) => !repo.worktrees.some((worktree) => worktree.branch === name));
}

function worktreeActions(workspaces: string[], apply: boolean): WorktreeAction[] {
  if (workspaces.length === 0) return [];
  const args = [process.execPath, WT_SCRIPT, "gc", "--json", ...workspaces.flatMap((workspace) => ["--workspace", workspace])];
  const result = run(apply ? [...args, "--apply"] : args);
  try {
    return (JSON.parse(result.out) as { worktrees: WorktreeAction[] }).worktrees.filter((item) => item.action !== "keep");
  } catch {
    throw new Error(`wt.ts gc 失败：${result.err.trim() || result.out.trim()}`);
  }
}

function deleteMergedBranches(repo: string, workspace: string, stamp: string): BranchCleanup {
  const record = join(workspace, "evidence", "branch-cleanup", `${basename(repo)}-${stamp}.json`);
  const result = run([process.execPath, BRANCH_SCRIPT, "--repo", repo, "--apply", "--record", record, "--json"]);
  let decisions: { scope: string; branch: string; action: string; done?: string }[];
  try {
    decisions = (JSON.parse(result.out) as { decisions: typeof decisions }).decisions;
  } catch {
    return { repo, branches: [], failed: [result.err.trim() || "branch.ts 输出无法解析"] };
  }
  const handled = decisions.filter((decision) => decision.scope === "local" && decision.action === "delete");
  if (handled.length === 0) {
    rmSync(record, { force: true });
    return { repo, branches: [] };
  }
  const failed = handled.filter((d) => !d.done?.startsWith("已删除")).map((d) => `${d.branch}：${d.done ?? "未处理"}`);
  return {
    repo,
    branches: handled.filter((d) => d.done?.startsWith("已删除")).map((d) => d.branch),
    record,
    ...(failed.length > 0 ? { failed } : {}),
  };
}

/** Temporary roots named `<task>.XXXXXX` by mktemp: the name is the owner mark, the creation time is the task's start. */
function taskRoots(task: string): { path: string; created: string }[] {
  const pattern = new RegExp(`^${task.replace(/[.]/gu, "\\.")}\\.[A-Za-z0-9]{6,}$`, "u");
  const parents = new Set<string>();
  for (const dir of [tmpdir(), "/tmp"]) {
    try {
      parents.add(realpathSync(dir));
    } catch {}
  }
  // Commands run with TMPDIR pointed at the task root itself: the root's siblings are one level up.
  for (const dir of [...parents]) if (pattern.test(basename(dir))) parents.add(dirname(dir));
  const uid = process.getuid?.();
  const roots = new Map<string, string>();
  for (const parent of parents) {
    let names: string[];
    try {
      names = readdirSync(parent);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!pattern.test(name)) continue;
      try {
        const stat = lstatSync(join(parent, name));
        if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid)) continue;
        roots.set(join(parent, name), new Date(stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs).toISOString());
      } catch {}
    }
  }
  return [...roots].map(([path, created]) => ({ path, created })).sort((a, b) => a.created.localeCompare(b.created));
}

function isTaskWorktree(worktree: Worktree, task: string): boolean {
  return basename(worktree.path) === task || worktree.branch === `wt/${task}`;
}

/** The task's own merged worktrees. wt.ts remove refuses uncommitted changes, unmerged commits and live processes. */
function taskWorktrees(repositories: RepositoryReport[], task: string, apply: boolean): WorktreeAction[] {
  const actions: WorktreeAction[] = [];
  for (const repo of repositories) {
    for (const w of repo.worktrees) {
      if (!isTaskWorktree(w, task) || !w.merged || w.prunable) continue;
      const action: WorktreeAction = { repo: repo.path, path: w.path, branch: w.branch, action: "remove", reason: `已合入 ${repo.defaultRef}` };
      if (apply) {
        const result = run([process.execPath, WT_SCRIPT, "remove", "--path", w.path]);
        if (!result.ok) action.done = `未删除：${result.err.trim().split("\n").pop()}`;
        else {
          const removed = JSON.parse(result.out) as { branchDeleted: string | null; remoteBranch: string | null };
          action.done = [
            removed.branchDeleted ? `已删除，分支 ${removed.branchDeleted} 已删除` : "已删除",
            ...(removed.remoteBranch ? [`远端 ${removed.remoteBranch} 还在，用 branch.ts --remote 清理`] : []),
          ].join("；");
        }
      }
      actions.push(action);
    }
  }
  return actions;
}

function removeTaskRoot(path: string): string {
  const pids = processesInside(path);
  if (pids.length > 0) return `未删除：进程 ${pids.slice(0, 5).join(",")} 正在使用`;
  rmSync(path, { recursive: true, force: true });
  return "已删除";
}

function freshEntries(base: string, entries: string[], windowStart: Date): string[] {
  return entries.filter((entry) => {
    try {
      const stat = lstatSync(join(base, entry));
      return Math.max(stat.birthtimeMs, stat.mtimeMs) >= windowStart.getTime();
    } catch {
      return false;
    }
  });
}

type Report = Awaited<ReturnType<typeof buildReport>>;

/** Share pages grouped by entry page: the ones the filter keeps, and how many it left out. */
function sharePages(report: Report, keep: (object: ShareReport["objects"][number]) => boolean) {
  const entries = new Map<string, ShareReport["objects"]>();
  for (const o of report.shares?.objects ?? []) entries.set(o.entry, [...(entries.get(o.entry) ?? []), o]);
  const listed: string[] = [];
  let omitted = 0;
  for (const group of entries.values()) {
    // Delivered links are kept for good: listing every page ever uploaded floods the caller's context.
    if (!group.some(keep)) {
      omitted += 1;
      continue;
    }
    const page = group.find((o) => o.key === o.entry) ?? group[0];
    const more = group.length > 1 ? `（含资源共 ${group.length} 个对象）` : "";
    listed.push(`task=${page.task} release-when=${page.releaseWhen}${more} ${page.url}`);
  }
  return { listed, omitted };
}

function containerGroups(containers: DockerReport["labelled"]): string[] {
  const groups = new Map<string, DockerReport["labelled"]>();
  for (const c of containers) {
    const key = `owner=${c.owner} release-when=${c.releaseWhen || "-"}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  return [...groups].map(([key, group]) => {
    const running = group.filter((c) => c.status.startsWith("Up")).length;
    return `容器 ${key}：${group.map((c) => c.name).join("、")}（${running}/${group.length} 在运行）`;
  });
}

function safeLines(report: Report): string[] {
  const actions = report.cleaned ?? report.cleanable;
  const safe: string[] = [];
  for (const root of actions.roots) safe.push(`  临时根 ${root.path}${root.done ? ` — ${root.done}` : ""}`);
  for (const w of actions.worktrees) {
    const what = w.action === "prune" ? "失效 worktree 记录" : "worktree";
    safe.push(`  ${what} ${w.path} [${w.branch ?? "detached"}]${w.done ? ` — ${w.done}` : ""}`);
  }
  for (const b of actions.branches) {
    if (b.branches.length > 0) safe.push(`  本地分支 ${b.repo}：${b.branches.join(", ")}${b.record ? `（记录 ${b.record}）` : ""}`);
    for (const failure of b.failed ?? []) safe.push(`  本地分支 ${b.repo} 未删除 — ${failure}`);
  }
  return safe.length > 0 ? ["", report.cleaned ? "已清理：" : "可直接清理（加 --clean 执行）：", ...safe] : [];
}

function printTask(report: Report, task: NonNullable<Report["task"]>): void {
  const windowStart = new Date(report.since);
  const out: string[] = [`任务 ${task.name}，窗口起点 ${report.since}${task.sinceFromRoot ? "（临时根创建时间）" : ""}`, ...safeLines(report)];
  const omitted: string[] = [];
  const handled = new Set((report.cleaned ?? report.cleanable).worktrees.map((w) => w.path));

  const own: string[] = [];
  const docker = report.docker;
  if (docker) {
    own.push(...containerGroups(docker.labelled.filter((c) => c.owner === task.name)));
    const others = docker.labelled.filter((c) => c.owner !== task.name).length;
    if (others > 0) omitted.push(`其他任务的容器 ${others} 个`);
  }
  let otherWorktrees = 0;
  for (const repo of report.repositories) {
    for (const w of repo.worktrees) {
      if (handled.has(w.path)) continue;
      if (!isTaskWorktree(w, task.name)) {
        otherWorktrees += 1;
        continue;
      }
      own.push(
        w.prunable
          ? `worktree 记录 ${w.path} 的目录已不存在：wt.ts gc 清理`
          : `worktree ${w.path} [${w.branch ?? "detached"}] 未合入：保留，在回复里写明分支和 PR`,
      );
    }
  }
  if (otherWorktrees > 0) omitted.push(`其他 worktree ${otherWorktrees} 个`);
  const shares = sharePages(report, (o) => o.task === task.name);
  own.push(...shares.listed.map((line) => `分享页面 ${line}`));
  if (shares.omitted > 0) omitted.push(`其他任务的分享页面 ${shares.omitted} 个`);
  if (report.shares?.error) own.push(`分享登记读取失败：${report.shares.error}`);
  const noReport = report.shares && !report.shares.error && shares.listed.length === 0;
  if (own.length > 0) {
    out.push(
      "",
      "本任务的（脚本不删）：",
      ...own.map((line) => `  ${line}`),
      "  处理：释放条件已满足的容器用 docker rm -v 删除；交给用户的分享链接保留，自测的用 share.ts remove 删除。",
    );
  }

  const unmarked: string[] = [];
  if (docker) {
    for (const c of docker.stoppedContainers) if (!c.owner) unmarked.push(`已停止的容器 ${c.name} (${c.image}) ${c.status}`);
    for (const c of docker.unlabeledRunning) unmarked.push(`运行中的容器 ${c.name} (${c.image}) 创建于 ${c.created}`);
    if (docker.danglingVolumes.inWindow > 0) unmarked.push(`新增悬空卷 ${docker.danglingVolumes.inWindow} 个（匿名 ${docker.danglingVolumes.anonymousInWindow}）`);
  }
  for (const repo of report.repositories) {
    const fresh = [...freshEntries(repo.path, repo.untracked, windowStart), ...freshEntries(repo.path, repo.ignoredArtifacts, windowStart)];
    if (fresh.length > 0) unmarked.push(`仓库 ${repo.path} 新增未跟踪或被忽略的产物：${fresh.join(", ")}`);
  }
  for (const stray of report.workspaceStrays) {
    const fresh = freshEntries(stray.workspace, stray.entries, windowStart);
    if (fresh.length > 0) unmarked.push(`工作区根 ${stray.workspace} 新增杂项：${fresh.join(", ")}`);
  }
  if (unmarked.length > 0) {
    out.push(
      "",
      "窗口内新出现、没有归属标记的（脚本不删）：",
      ...unmarked.map((line) => `  ${line}`),
      "  处理：是本任务建的就回收；不是的不动，在回复里单独列出。",
    );
  }
  if (report.temporary.length > 0) omitted.push(`不带任务名的临时项 ${report.temporary.length} 组`);

  if (out.length === 1) out.push("", "没有遗留。");
  if (noReport) out.push("", "提醒：本任务没有登记分享页面。改了用户可见的行为，就要交 HTML 验收报告和分享链接。");
  if (omitted.length > 0) out.push("", `未列出：${omitted.join("；")}。不带 --task 可做整机盘点。`);
  console.log(out.join("\n"));
}

function printInventory(report: Report): void {
  const windowStart = new Date(report.since);
  const out: string[] = [`整机盘点，窗口起点 ${report.since}`, ...safeLines(report)];
  const omitted: string[] = [];
  const handled = new Set((report.cleaned ?? report.cleanable).worktrees.map((w) => w.path));

  const review: string[] = [];
  const docker = report.docker;
  if (docker) {
    for (const c of docker.stoppedContainers) if (!c.owner) review.push(`已停止且未加 owner 标签的容器 ${c.name} (${c.image}) ${c.status}`);
    for (const c of docker.unlabeledRunning) review.push(`运行中未加 owner 标签的容器 ${c.name} (${c.image}) 创建于 ${c.created}`);
    review.push(...containerGroups(docker.labelled));
    const v = docker.danglingVolumes;
    if (v.inWindow > 0) review.push(`窗口内新增悬空卷 ${v.inWindow} 个（匿名 ${v.anonymousInWindow}）`);
    if (v.total > v.inWindow) omitted.push(`更早的悬空卷 ${v.total - v.inWindow} 个`);
  }
  for (const g of report.temporary.slice(0, TEXT_GROUP_LIMIT)) {
    review.push(g.count > 1 ? `临时位置 ${g.root}/${g.pattern} ×${g.count}，例 ${g.example}` : `临时位置 ${g.example}`);
  }
  if (report.temporary.length > TEXT_GROUP_LIMIT) omitted.push(`临时位置另 ${report.temporary.length - TEXT_GROUP_LIMIT} 组`);
  if (report.shares?.error) review.push(`分享登记读取失败：${report.shares.error}`);
  const shares = sharePages(report, (o) => new Date(o.at) >= windowStart);
  review.push(...shares.listed.map((line) => `分享页面 ${line}`));
  if (shares.omitted > 0) omitted.push(`更早上传的分享页面 ${shares.omitted} 个`);
  let otherWorktrees = 0;
  let olderUntracked = 0;
  for (const repo of report.repositories) {
    const fresh = freshEntries(repo.path, repo.untracked, windowStart);
    olderUntracked += repo.untracked.length - fresh.length;
    const inside = repo.worktrees.filter((w) => w.insideRepository && !w.prunable);
    otherWorktrees += repo.worktrees.filter((w) => !w.insideRepository && !handled.has(w.path)).length;
    const notes: string[] = [];
    if (fresh.length > 0) notes.push(`窗口内新增未跟踪 ${fresh.join(", ")}`);
    if (repo.ignoredArtifacts.length > 0) notes.push(`被忽略的产物目录 ${repo.ignoredArtifacts.join(", ")}`);
    if (inside.length > 0) notes.push(`位于仓库内的 worktree ${inside.map((w) => w.path.slice(repo.path.length + 1)).join(", ")}`);
    if (notes.length > 0) review.push(`仓库 ${repo.path}：${notes.join("；")}`);
  }
  if (otherWorktrees > 0) omitted.push(`未合入、有改动或在用的 worktree ${otherWorktrees} 个`);
  if (olderUntracked > 0) omitted.push(`更早的未跟踪项 ${olderUntracked} 个`);
  for (const stray of report.workspaceStrays) {
    if (stray.entries.length > 0) review.push(`工作区根 ${stray.workspace} 的杂项：${stray.entries.join(", ")}`);
  }

  if (review.length > 0) {
    out.push(
      "",
      "需要判断（脚本不会删除）：",
      ...review.map((line) => `  ${line}`),
      "  处理：归属明确且已无依赖的回收；带标签且释放条件已满足的交用户确认；归属不明的保留。",
    );
  } else out.push("", "没有需要判断的遗留。");
  if (omitted.length > 0) out.push("", `未列出：${omitted.join("；")}。加 --json 查看全部。`);
  console.log(out.join("\n"));
}

async function buildReport(options: Options) {
  const scopes: { workspace: string; repos: string[]; defaults: Map<string, string | null> }[] = [];
  for (const workspace of options.workspaces) {
    const repos = findRepositories(workspace).filter((repo) => repo !== workspace);
    scopes.push({ workspace, repos, defaults: await remoteDefaults(repos) });
  }
  const roots = options.task ? taskRoots(options.task) : [];
  const sinceFromRoot = !options.sinceGiven && roots.length > 0;
  const since = sinceFromRoot ? new Date(roots[0].created) : options.since;
  const scanAll = () => scopes.flatMap((scope) => scope.repos.map((repo) => scanRepository(repo, scope.defaults.get(repo) ?? null)));
  let cleaned: Cleanup | null = null;
  if (options.clean && options.task) {
    // A task's close-out touches only what carries the task's name; other people's leftovers wait for an inventory run.
    cleaned = {
      worktrees: taskWorktrees(scanAll(), options.task, true),
      branches: [],
      roots: roots.map((root) => ({ ...root, done: removeTaskRoot(root.path) })),
    };
  } else if (options.clean) {
    // Worktrees first: removing one frees its branch for the branch pass.
    const worktrees = worktreeActions(options.workspaces, true);
    const stamp = new Date().toISOString().replace(/\D/gu, "").slice(0, 14);
    const branches: BranchCleanup[] = [];
    for (const scope of scopes) {
      for (const repo of scope.repos) {
        if (deletableBranches(scanRepository(repo, scope.defaults.get(repo) ?? null)).length === 0) continue;
        branches.push(deleteMergedBranches(repo, scope.workspace, stamp));
      }
    }
    cleaned = { worktrees, branches, roots: [] };
  }
  const repositories = scanAll();
  let cleanable: Cleanup = { worktrees: [], branches: [], roots: [] };
  if (!options.clean && options.task) cleanable = { worktrees: taskWorktrees(repositories, options.task, false), branches: [], roots };
  else if (!options.clean) {
    cleanable = {
      worktrees: worktreeActions(options.workspaces, false),
      branches: repositories.map((repo) => ({ repo: repo.path, branches: deletableBranches(repo) })).filter((b) => b.branches.length > 0),
      roots: [],
    };
  }
  return {
    since: since.toISOString(),
    task: options.task ? { name: options.task, sinceFromRoot } : null,
    cleaned,
    cleanable,
    docker: options.docker ? scanDocker(since) : null,
    temporary: scanTemporary(options.tempRoots, since, new Set(roots.map((root) => basename(root.path)))),
    shares: scanShares(),
    repositories,
    workspaceStrays: scopes.map((scope) => ({ workspace: scope.workspace, entries: scanWorkspaceRoot(scope.workspace, scope.repos) })),
  };
}

try {
  const options = parseArgs(process.argv.slice(2));
  const report = await buildReport(options);
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else if (report.task) printTask(report, report.task);
  else printInventory(report);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(error instanceof UsageError ? 2 : 1);
}
