#!/usr/bin/env bun
// Follows a community pull request to its merge gate: judge it, wait on it, ask Codex again, answer a thread.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { run } from "./lib/git";
import { evaluate, textProblems, type Check, type Comment, type GateResult, type Snapshot } from "./lib/pr-gate";

const HELP = `用法:
  bun community-pr.ts check <PR 号或链接> [--repo <owner/name>] [--base <分支>] [--json]
  bun community-pr.ts watch <PR 号或链接> [--until ready|merged] [--interval <秒>] [--timeout <时长>] [--json]
  bun community-pr.ts request-review <PR 号或链接> [--force] [--json]
  bun community-pr.ts reply <PR 号或链接> --thread <线程 ID> --body-file <文件> [--resolve] [--json]

check           只读。按最新提交逐项判定合并门槛：PR 形态、冲突、CI、Codex 评审、评审线程、人工评论、公开内容。
watch           轮询 check，出现需要处理的事项、达到门槛、被合并或关闭时退出；--until merged 在达到门槛后继续等合并。
request-review  评论 "@codex review"。Codex 已在评审最新提交或已有待响应的请求时跳过，--force 强制再请求一次。
reply           回复一条评审线程，--resolve 同时把它标为已解决；正文不是英文或带生产数据标识、本机路径时拒绝发送。

--repo 默认 lobehub/lobehub，--base 默认 canary；给 PR 链接时仓库取自链接。
--interval 默认 60 秒，--timeout 默认 110m（可写 90s、45m、2h）。

退出码: 0 达到门槛或已合并；10 有需要处理的事项；11 仍在等待（watch 超时）；12 PR 未合并就被关闭；2 用法错误；1 运行失败。`;

class UsageError extends Error {}

const EXIT = { ready: 0, merged: 0, action: 10, waiting: 11, closed: 12 } as const;

interface Options {
  command: string;
  repo: string;
  number: number;
  base: string;
  json: boolean;
  until: "ready" | "merged";
  interval: number;
  timeout: number;
  force: boolean;
  thread: string;
  bodyFile: string;
  resolve: boolean;
}

function duration(text: string): number {
  const match = text.match(/^(\d+)(s|m|h)?$/u);
  if (!match) throw new UsageError(`无法识别的时长：${text}`);
  return Number(match[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[(match[2] ?? "s") as "s" | "m" | "h"];
}

function parseFlags(argv: string[]): Options {
  const options: Options = {
    command: argv[0] ?? "",
    repo: "lobehub/lobehub",
    number: 0,
    base: "canary",
    json: false,
    until: "ready",
    interval: 60_000,
    timeout: 110 * 60_000,
    force: false,
    thread: "",
    bodyFile: "",
    resolve: false,
  };
  if (!["check", "watch", "request-review", "reply"].includes(options.command)) throw new UsageError(`未知子命令: ${options.command || "(空)"}`);
  let target = "";
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined) throw new UsageError(`${arg} 缺少参数`);
      return next;
    };
    if (arg === "--repo") options.repo = value();
    else if (arg === "--base") options.base = value();
    else if (arg === "--until") {
      const until = value();
      if (until !== "ready" && until !== "merged") throw new UsageError("--until 只能是 ready 或 merged");
      options.until = until;
    } else if (arg === "--interval") options.interval = duration(value());
    else if (arg === "--timeout") options.timeout = duration(value());
    else if (arg === "--thread") options.thread = value();
    else if (arg === "--body-file") options.bodyFile = resolve(value());
    else if (arg === "--json") options.json = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--resolve") options.resolve = true;
    else if (arg.startsWith("--")) throw new UsageError(`未知参数: ${arg}`);
    else if (target) throw new UsageError(`多余的参数: ${arg}`);
    else target = arg;
  }
  const link = target.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/u);
  if (link) {
    options.repo = link[1];
    options.number = Number(link[2]);
  } else if (/^#?\d+$/u.test(target)) options.number = Number(target.replace("#", ""));
  else throw new UsageError("缺少 PR 号或链接");
  if (!/^[^/\s]+\/[^/\s]+$/u.test(options.repo)) throw new UsageError(`--repo 应为 owner/name：${options.repo}`);
  if (options.interval < 10_000) throw new UsageError("--interval 不小于 10 秒");
  if (options.command === "reply") {
    if (!options.thread) throw new UsageError("reply 缺少 --thread");
    if (!options.bodyFile || !existsSync(options.bodyFile)) throw new UsageError("reply 需要 --body-file 指向一个存在的文件");
  }
  return options;
}

function gh(args: string[], input?: string): string {
  const result = run(["gh", ...args], undefined, input, 60_000);
  if (!result.ok) throw new Error(`gh ${args.slice(0, 3).join(" ")} 失败：${result.err.trim() || result.out.trim()}`);
  return result.out;
}

const QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      url title body state isDraft baseRefName headRefOid createdAt mergeable reviewDecision
      author { login }
      reactions(first: 100) { nodes { content createdAt user { login } } }
      comments(first: 100) {
        pageInfo { hasNextPage }
        nodes { databaseId url body createdAt updatedAt author { login __typename } }
      }
      reviews(first: 100) { nodes { state body submittedAt url author { login __typename } } }
      reviewThreads(first: 100) {
        pageInfo { hasNextPage }
        nodes {
          id isResolved path
          comments(first: 50) { nodes { databaseId url body createdAt author { login __typename } } }
        }
      }
      commits(last: 1) {
        nodes {
          commit {
            committedDate
            statusCheckRollup {
              contexts(first: 100) {
                pageInfo { hasNextPage }
                nodes {
                  __typename
                  ... on CheckRun { name status conclusion checkSuite { workflowRun { workflow { name } } } }
                  ... on StatusContext { context state }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

function toComment(node: any): Comment {
  return {
    author: node.author?.login ?? "ghost",
    bot: node.author?.__typename === "Bot",
    body: node.body ?? "",
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    url: node.url,
    databaseId: node.databaseId,
  };
}

function toCheck(node: any): Check {
  if (node.__typename === "CheckRun") {
    return { name: node.name, workflow: node.checkSuite?.workflowRun?.workflow?.name ?? null, status: node.status, conclusion: node.conclusion };
  }
  const state = String(node.state);
  const done = state === "SUCCESS" || state === "FAILURE" || state === "ERROR";
  return { name: node.context, workflow: null, status: done ? "COMPLETED" : state, conclusion: done ? state : null };
}

function fetchSnapshot(repo: string, number: number): Snapshot {
  const [owner, name] = repo.split("/");
  const out = gh(["api", "graphql", "-f", `query=${QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${number}`]);
  const pr = JSON.parse(out).data?.repository?.pullRequest;
  if (!pr) throw new Error(`找不到 ${repo}#${number}`);
  const commit = pr.commits.nodes[0]?.commit;
  const contexts = commit?.statusCheckRollup?.contexts;
  return {
    repo,
    number,
    url: pr.url,
    title: pr.title,
    body: pr.body ?? "",
    state: pr.state,
    isDraft: pr.isDraft,
    base: pr.baseRefName,
    headSha: pr.headRefOid,
    headCommittedAt: commit?.committedDate ?? pr.createdAt,
    createdAt: pr.createdAt,
    author: pr.author?.login ?? "ghost",
    mergeable: pr.mergeable,
    reviewDecision: pr.reviewDecision,
    checks: (contexts?.nodes ?? []).map(toCheck),
    checksTruncated: contexts?.pageInfo?.hasNextPage === true,
    threads: pr.reviewThreads.nodes.map((thread: any) => ({
      id: thread.id,
      resolved: thread.isResolved,
      path: thread.path,
      comments: thread.comments.nodes.map(toComment),
    })),
    threadsTruncated: pr.reviewThreads.pageInfo.hasNextPage,
    comments: pr.comments.nodes.map(toComment),
    commentsTruncated: pr.comments.pageInfo.hasNextPage,
    reviews: pr.reviews.nodes.map((review: any) => ({
      author: review.author?.login ?? "ghost",
      bot: review.author?.__typename === "Bot",
      state: review.state,
      body: review.body ?? "",
      createdAt: review.submittedAt,
      url: review.url,
    })),
    reactions: pr.reactions.nodes.map((reaction: any) => ({ author: reaction.user?.login ?? "ghost", content: reaction.content, createdAt: reaction.createdAt })),
  };
}

const judge = (options: Options) => evaluate(fetchSnapshot(options.repo, options.number), { base: options.base, now: new Date().toISOString() });

const VERDICT_TEXT = {
  ready: "已达到合并门槛，交用户合并",
  waiting: "仍在等待",
  action: "有需要处理的事项",
  merged: "已合并：回收 worktree 和分支",
  closed: "未合并就被关闭：停下并告知用户",
} as const;
const MARK = { pass: "✓", pending: "…", action: "✗" } as const;

function render(result: GateResult, extra: Record<string, unknown> = {}): string {
  const lines = [`${result.repo}#${result.number}  ${VERDICT_TEXT[result.verdict]}`, `${result.url}  最新提交 ${result.headSha}`];
  if (extra.timedOut) lines[0] += "（watch 超时，重新启动 watch 继续等）";
  if (result.verdict === "merged" || result.verdict === "closed") return lines.join("\n");
  for (const item of result.items) {
    lines.push(`${MARK[item.state]} ${item.id.padEnd(9)} ${item.summary}`);
    for (const detail of item.details) lines.push(`    - ${detail}`);
  }
  return lines.join("\n");
}

function emit(options: Options, payload: Record<string, unknown>, text: string) {
  console.log(options.json ? JSON.stringify(payload, null, 2) : text);
}

async function watch(options: Options): Promise<number> {
  const deadline = Date.now() + options.timeout;
  let failures = 0;
  let last = "";
  let result: GateResult | null = null;
  for (;;) {
    try {
      result = judge(options);
      failures = 0;
    } catch (error) {
      failures += 1;
      if (failures >= 5) throw error;
      console.error(`查询失败（第 ${failures} 次），稍后重试：${error instanceof Error ? error.message : error}`);
    }
    if (result && failures === 0) {
      const settled = result.verdict !== "waiting" && !(result.verdict === "ready" && options.until === "merged");
      if (settled) {
        emit(options, { ...result }, render(result));
        return EXIT[result.verdict];
      }
      const progress = result.items.map((item) => `${item.id}:${item.state}`).join(" ");
      if (progress !== last) {
        console.error(`[${new Date().toISOString()}] ${result.verdict} ${progress}`);
        last = progress;
      }
    }
    if (Date.now() + options.interval > deadline) break;
    await Bun.sleep(options.interval);
  }
  if (!result) throw new Error("watch 期间没有取到 PR 状态");
  emit(options, { ...result, timedOut: true }, render(result, { timedOut: true }));
  return EXIT.waiting;
}

function requestReview(options: Options): number {
  const result = judge(options);
  const codex = result.items.find((item) => item.id === "codex")!;
  if (result.verdict === "merged" || result.verdict === "closed") throw new Error(`PR 已${result.verdict === "merged" ? "合并" : "关闭"}，不再请求评审`);
  if (codex.state !== "action" && !options.force) {
    emit(options, { requested: false, reason: codex.summary, headSha: result.headSha }, `未请求：${codex.summary}`);
    return 0;
  }
  const created = JSON.parse(gh(["api", `repos/${options.repo}/issues/${options.number}/comments`, "-f", "body=@codex review"]));
  emit(options, { requested: true, headSha: result.headSha, comment: created.html_url }, `已对 ${result.headSha.slice(0, 10)} 请求 Codex 复审：${created.html_url}`);
  return 0;
}

function reply(options: Options): number {
  const body = readFileSync(options.bodyFile, "utf8").trim();
  if (!body) throw new UsageError("回复正文为空");
  const problems = textProblems(body);
  if (problems.length > 0) throw new UsageError(`回复不能公开发送：\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
  const snapshot = fetchSnapshot(options.repo, options.number);
  const thread = snapshot.threads.find((entry) => entry.id === options.thread);
  const first = thread?.comments[0]?.databaseId;
  if (!thread || !first) throw new Error(`PR 上没有线程 ${options.thread}；用 check 列出未解决线程的 ID`);
  const created = JSON.parse(gh(["api", `repos/${options.repo}/pulls/${options.number}/comments/${first}/replies`, "-F", "body=@-"], body));
  let resolved = thread.resolved;
  if (options.resolve && !resolved) {
    const mutation = "mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { isResolved } } }";
    const out = JSON.parse(gh(["api", "graphql", "-f", `query=${mutation}`, "-f", `id=${thread.id}`]));
    resolved = out.data?.resolveReviewThread?.thread?.isResolved === true;
    if (!resolved) throw new Error(`回复已发送（${created.html_url}），但线程 ${thread.id} 没有标为已解决`);
  }
  emit(options, { replied: created.html_url, thread: thread.id, resolved }, `已回复 ${created.html_url}${resolved ? "，线程已解决" : "，线程未解决"}`);
  return 0;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return argv.length === 0 ? 2 : 0;
  }
  const options = parseFlags(argv);
  if (options.command === "watch") return watch(options);
  if (options.command === "request-review") return requestReview(options);
  if (options.command === "reply") return reply(options);
  const result = judge(options);
  emit(options, { ...result }, render(result));
  return EXIT[result.verdict];
}

try {
  process.exit(await main());
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(error instanceof UsageError ? 2 : 1);
}
