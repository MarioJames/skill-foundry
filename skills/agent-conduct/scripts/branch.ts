#!/usr/bin/env bun
// Reclaims branches whose work already reached the default branch, locally and on origin.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { git, isAncestor, lines, mergeEvidence, remoteDefault, run, type MergeEvidence } from "./lib/git";

const HELP = `用法:
  bun branch.ts --repo <仓库> [--branch <分支>]... [--remote] [--apply --record <文件>] [--json]

先 fetch --prune origin，按远端实际默认分支判断每个分支的成果是否已合入：
  本地分支  内容已在默认分支上（祖先、rebase 或 squash 合入），或有已合入的 PR 覆盖分支头，标 delete；
  远端分支  加 --remote 才处理；GitHub 仓库要求有已合入的 PR 覆盖分支头且合并提交在默认分支上，
            其他远端按内容判断。
默认分支、在任一工作树检出的分支、有未关闭 PR 的分支、有未合入提交的分支一律 keep。
--branch 只处理指定分支（可多次）；不传时盘点整个仓库。
默认只列出；--apply 执行删除，必须同时用 --record 指定一个新的记录文件，写入每个分支删除前的 SHA 和证据。
远端删除带 --force-with-lease，分支头在判断后被别人更新时拒绝删除。`;

class UsageError extends Error {}

type Scope = "local" | "remote";

interface PullRequest {
  number: number;
  url: string;
  headRefName: string;
  headRefOid?: string;
  mergeCommit?: { oid: string } | null;
  isCrossRepository: boolean;
}

interface Decision {
  scope: Scope;
  branch: string;
  sha: string;
  action: "delete" | "keep";
  reason: string;
  evidence?: MergeEvidence | "pull-request";
  pr?: string;
  done?: string;
}

function parseFlags(argv: string[]) {
  const options = { repo: "", branches: [] as string[], remote: false, apply: false, record: "", json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined) throw new UsageError(`${arg} 缺少参数`);
      return next;
    };
    if (arg === "--repo") options.repo = resolve(value());
    else if (arg === "--branch") options.branches.push(value());
    else if (arg === "--record") options.record = resolve(value());
    else if (arg === "--remote") options.remote = true;
    else if (arg === "--apply") options.apply = true;
    else if (arg === "--json") options.json = true;
    else throw new UsageError(`未知参数: ${arg}`);
  }
  if (!options.repo) throw new UsageError("缺少 --repo");
  if (options.apply && !options.record) throw new UsageError("--apply 必须同时指定 --record <文件>");
  if (options.record && existsSync(options.record)) throw new UsageError(`记录文件已存在，换一个新文件：${options.record}`);
  return options;
}

function mustGit(repo: string, ...args: string[]): string {
  const result = git(repo, ...args);
  if (!result.ok) throw new Error(`git ${args.join(" ")} 失败：${result.err.trim() || result.out.trim()}`);
  return result.out.trim();
}

/** Every branch checked out in the main or a linked worktree. */
function checkedOut(repo: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const block of git(repo, "worktree", "list", "--porcelain").out.split("\n\n")) {
    const fields = lines(block);
    const path = fields.find((line) => line.startsWith("worktree "))?.slice(9);
    const branch = fields.find((line) => line.startsWith("branch refs/heads/"))?.slice(18);
    if (path && branch) map.set(branch, path);
  }
  return map;
}

function branchTips(repo: string, prefix: string): Map<string, string> {
  const tips = new Map<string, string>();
  for (const line of lines(git(repo, "for-each-ref", "--format=%(refname) %(objectname)", prefix).out)) {
    const [name, sha] = line.split(" ");
    tips.set(name.slice(prefix.length), sha);
  }
  return tips;
}

function pullRequests(repo: string, state: "open" | "merged"): PullRequest[] | null {
  const fields = state === "open" ? "number,url,headRefName,isCrossRepository" : "number,url,headRefName,headRefOid,mergeCommit,isCrossRepository";
  const result = run(["gh", "pr", "list", "--state", state, "--limit", "1000", "--json", fields], repo);
  if (!result.ok) return null;
  return (JSON.parse(result.out) as PullRequest[]).filter((pr) => !pr.isCrossRepository);
}

function inspect(options: ReturnType<typeof parseFlags>) {
  const { repo } = options;
  mustGit(repo, "rev-parse", "--git-dir");
  const originUrl = git(repo, "remote", "get-url", "origin");
  let defaultName: string;
  let ref: string;
  const notes: string[] = [];
  if (originUrl.ok) {
    mustGit(repo, "fetch", "--prune", "--quiet", "origin");
    const name = remoteDefault(repo);
    if (!name) throw new Error("无法从 origin 读取默认分支");
    defaultName = name;
    ref = `origin/${name}`;
    const recorded = git(repo, "symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD").out.trim();
    if (recorded !== ref) notes.push(`本地 origin/HEAD ${recorded ? `指向 ${recorded}` : "未记录"}，远端实际默认分支是 ${name}；可运行 git remote set-head origin --auto 更新`);
  } else {
    const local = ["main", "master"].find((name) => git(repo, "rev-parse", "--verify", "-q", `refs/heads/${name}`).ok);
    if (!local) throw new Error("没有 origin，也没有本地 main/master，无法确定默认分支");
    defaultName = local;
    ref = local;
    notes.push("没有 origin，只按本地默认分支判断");
  }

  const github = originUrl.ok && /github\.com[:/]/u.test(originUrl.out);
  const openPrs = github ? pullRequests(repo, "open") : [];
  const mergedPrs = github ? pullRequests(repo, "merged") : [];
  if (github && (!openPrs || !mergedPrs)) notes.push("gh 查询 PR 失败：远端分支一律保留，本地分支只按内容判断，有未关闭 PR 的情况无法识别");

  const wanted = options.branches.length > 0 ? new Set(options.branches) : null;
  const worktrees = checkedOut(repo);

  const prCovering = (branch: string, sha: string) =>
    mergedPrs?.find(
      (pr) =>
        pr.headRefName === branch &&
        pr.headRefOid &&
        pr.mergeCommit &&
        (pr.headRefOid === sha || isAncestor(repo, sha, pr.headRefOid)) &&
        isAncestor(repo, pr.mergeCommit.oid, ref),
    );

  const decide = (scope: Scope, branch: string, sha: string): Decision => {
    const base = { scope, branch, sha };
    if (branch === defaultName) return { ...base, action: "keep", reason: "默认分支" };
    if (scope === "local" && worktrees.has(branch)) return { ...base, action: "keep", reason: `在 ${worktrees.get(branch)} 检出` };
    const open = openPrs?.find((pr) => pr.headRefName === branch);
    if (open) return { ...base, action: "keep", reason: `PR #${open.number} 未关闭`, pr: open.url };
    const pr = prCovering(branch, sha);
    if (scope === "remote" && github) {
      if (!openPrs || !mergedPrs) return { ...base, action: "keep", reason: "无法查询 PR" };
      if (!pr) return { ...base, action: "keep", reason: `没有覆盖分支头 ${sha.slice(0, 10)} 且已合入 ${ref} 的 PR` };
      return { ...base, action: "delete", reason: `PR #${pr.number} 已合入 ${ref}`, evidence: "pull-request", pr: pr.url };
    }
    const evidence = mergeEvidence(repo, sha, ref);
    if (evidence) {
      const how = { ancestor: "已是其祖先", rebased: "提交已 rebase 合入", squashed: "已 squash 合入" }[evidence];
      return { ...base, action: "delete", reason: `${ref} ${how}`, evidence, ...(pr ? { pr: pr.url } : {}) };
    }
    if (pr) return { ...base, action: "delete", reason: `PR #${pr.number} 已合入 ${ref}`, evidence: "pull-request", pr: pr.url };
    return { ...base, action: "keep", reason: `有未合入 ${ref} 的提交` };
  };

  const decisions: Decision[] = [];
  const scopes: [Scope, string][] = [["local", "refs/heads/"]];
  if (options.remote && originUrl.ok) scopes.push(["remote", "refs/remotes/origin/"]);
  for (const [scope, prefix] of scopes) {
    for (const [branch, sha] of branchTips(repo, prefix)) {
      if (branch === "HEAD" || (wanted && !wanted.has(branch))) continue;
      decisions.push(decide(scope, branch, sha));
    }
  }
  const seen = new Set(decisions.map((decision) => decision.branch));
  const missing = options.branches.filter((branch) => !seen.has(branch));
  return { repo, defaultRef: ref, notes, missing, decisions };
}

function apply(report: ReturnType<typeof inspect>, record: string) {
  const write = () => {
    mkdirSync(dirname(record), { recursive: true });
    writeFileSync(record, JSON.stringify({ at: new Date().toISOString(), ...report }, null, 2) + "\n", { mode: 0o600 });
  };
  write();
  for (const decision of report.decisions) {
    if (decision.action !== "delete") continue;
    if (decision.scope === "local") {
      const current = git(report.repo, "rev-parse", "--verify", "-q", `refs/heads/${decision.branch}`).out.trim();
      if (current !== decision.sha) decision.done = `未删除：分支头已变为 ${current.slice(0, 10) || "不存在"}`;
      else {
        const result = git(report.repo, "branch", "-D", decision.branch);
        decision.done = result.ok ? `已删除；恢复：git branch ${decision.branch} ${decision.sha}` : `删除失败：${result.err.trim()}`;
      }
    } else {
      const lease = `--force-with-lease=refs/heads/${decision.branch}:${decision.sha}`;
      const result = git(report.repo, "push", "--quiet", "origin", lease, `:refs/heads/${decision.branch}`);
      decision.done = result.ok
        ? `已删除；恢复：git push origin ${decision.sha}:refs/heads/${decision.branch}`
        : `删除失败：${result.err.trim().split("\n").pop()}`;
    }
    write();
  }
}

function print(report: ReturnType<typeof inspect>, applied: boolean, record: string): void {
  const out = [applied ? `${report.repo} 分支清理结果（记录：${record}）：` : `${report.repo} 分支盘点（只列出，加 --apply --record <文件> 执行）：`];
  out.push(`  默认分支 ${report.defaultRef}`);
  for (const note of report.notes) out.push(`  注意：${note}`);
  for (const branch of report.missing) out.push(`  [不存在] ${branch}`);
  for (const item of report.decisions) {
    const label = item.action === "delete" ? "可删除" : "保留";
    const where = item.scope === "local" ? "本地" : "远端";
    out.push(`  [${label}] ${where} ${item.branch} ${item.sha.slice(0, 10)} — ${item.reason}${item.done ? `；${item.done}` : ""}`);
  }
  if (report.decisions.length === 0) out.push("  没有要处理的分支");
  console.log(out.join("\n"));
}

try {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    process.exit(argv.length === 0 ? 2 : 0);
  }
  const options = parseFlags(argv);
  const report = inspect(options);
  if (options.apply) apply(report, options.record);
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else print(report, options.apply, options.record);
  if (report.decisions.some((decision) => decision.done && !decision.done.startsWith("已删除"))) process.exit(1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(error instanceof UsageError ? 2 : 1);
}
