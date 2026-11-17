// Merge gate for a community pull request: pure judgement over a fetched snapshot.

export interface Comment {
  author: string;
  bot: boolean;
  body: string;
  createdAt: string;
  updatedAt?: string;
  url: string;
  databaseId?: number;
}

export interface Thread {
  id: string;
  resolved: boolean;
  path: string | null;
  comments: Comment[];
}

export interface Check {
  name: string;
  workflow: string | null;
  /** COMPLETED once finished; anything else is still running or queued. */
  status: string;
  conclusion: string | null;
}

export interface Review {
  author: string;
  bot: boolean;
  state: string;
  body: string;
  createdAt: string;
  url: string;
}

export interface Reaction {
  author: string;
  content: string;
  createdAt: string;
}

export interface Snapshot {
  repo: string;
  number: number;
  url: string;
  title: string;
  body: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  base: string;
  headSha: string;
  headCommittedAt: string;
  createdAt: string;
  author: string;
  mergeable: string;
  reviewDecision: string | null;
  checks: Check[];
  checksTruncated: boolean;
  threads: Thread[];
  threadsTruncated: boolean;
  comments: Comment[];
  commentsTruncated: boolean;
  reviews: Review[];
  reactions: Reaction[];
}

export type ItemState = "pass" | "pending" | "action";
export type Verdict = "ready" | "waiting" | "action" | "merged" | "closed";

export interface GateItem {
  id: "pr" | "mergeable" | "ci" | "codex" | "threads" | "comments" | "content";
  state: ItemState;
  summary: string;
  details: string[];
}

export interface GateResult {
  verdict: Verdict;
  repo: string;
  number: number;
  url: string;
  headSha: string;
  items: GateItem[];
}

export interface GateOptions {
  base: string;
  now: string;
}

const CODEX = "chatgpt-codex-connector";
const REVIEW_REQUEST = /^@codex\s+review\b/iu;
const PASSING = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);
const MINUTE = 60_000;
/** Codex reviews a newly opened pull request on its own; give it this long to show up. */
const AUTO_REVIEW_GRACE = 5 * MINUTE;
/** A review request Codex has not picked up after this long needs to be sent again. */
const REQUEST_PATIENCE = 15 * MINUTE;

const login = (name: string) => name.replace(/\[bot\]$/u, "");
const time = (value: string | undefined) => (value ? Date.parse(value) : 0);
const short = (sha: string) => sha.slice(0, 7);
const firstLine = (text: string) => text.replace(/<[^>]+>|!\[[^\]]*\]\([^)]*\)|\*\*/gu, "").trim().split("\n")[0].trim().slice(0, 100);

interface CodexState {
  sha: string | null;
  status: string | null;
  anyFindings: boolean;
  unresolved: boolean;
  updatedAt: number;
}

function codexState(comments: Comment[]): CodexState | null {
  for (const comment of [...comments].reverse()) {
    if (login(comment.author) !== CODEX) continue;
    const match = comment.body.match(/<!--\s*codex-review-state:v1\s+(\{.*?\})\s*-->/su);
    if (!match) continue;
    try {
      const review = JSON.parse(match[1]).code_review ?? {};
      return {
        sha: review.commit_sha ?? null,
        status: review.status ?? null,
        anyFindings: review.has_any_findings === true,
        unresolved: review.has_unresolved_findings === true,
        updatedAt: time(comment.updatedAt ?? comment.createdAt),
      };
    } catch {
      return null;
    }
  }
  return null;
}

function judgeCodex(snapshot: Snapshot, now: number): GateItem {
  const item = (state: ItemState, summary: string): GateItem => ({ id: "codex", state, summary, details: [] });
  const state = codexState(snapshot.comments);
  const head = snapshot.headSha;

  if (!state || state.sha !== head) {
    const answeredAt = state?.updatedAt ?? 0;
    const request = snapshot.comments
      .filter((comment) => !comment.bot && REVIEW_REQUEST.test(comment.body.trim()))
      .map((comment) => time(comment.createdAt))
      .filter((at) => at > time(snapshot.headCommittedAt) && at > answeredAt)
      .sort((a, b) => b - a)[0];
    if (request !== undefined) {
      return now - request < REQUEST_PATIENCE
        ? item("pending", `已对 ${short(head)} 请求复审，等待 Codex 开始`)
        : item("action", `对 ${short(head)} 的复审请求超过 15 分钟没有回应：用 request-review --force 重新请求`);
    }
    if (!state) {
      return now - time(snapshot.createdAt) < AUTO_REVIEW_GRACE
        ? item("pending", "PR 刚创建，等待 Codex 自动评审")
        : item("action", "没有 Codex 评审记录：用 request-review 请求评审");
    }
    return item("action", `Codex 的结论停在 ${state.sha ? short(state.sha) : "旧提交"}，不覆盖最新提交 ${short(head)}：用 request-review 请求复审`);
  }

  if (state.status !== "completed") return item("pending", `Codex 正在评审 ${short(head)}（${state.status ?? "未知状态"}）`);
  if (state.unresolved) return item("action", `Codex 在 ${short(head)} 上有未解决的意见：逐条修复或说明后回复并解决线程，再请求复审`);

  const approvedAt = snapshot.reactions
    .filter((reaction) => login(reaction.author) === CODEX && reaction.content === "THUMBS_UP")
    .map((reaction) => time(reaction.createdAt))
    .sort((a, b) => b - a)[0];
  if (state.anyFindings) {
    // An approval left over from an earlier review says nothing about this one.
    return approvedAt !== undefined && approvedAt >= state.updatedAt - MINUTE
      ? item("pass", `Codex 已复审 ${short(head)} 并 👍`)
      : item("action", `Codex 在 ${short(head)} 上提过意见，线程已解决但没有新的 👍：用 request-review --force 请求复审`);
  }
  if (approvedAt !== undefined) return item("pass", `Codex 评审 ${short(head)} 无意见并 👍`);
  return now - state.updatedAt < AUTO_REVIEW_GRACE
    ? item("pending", `Codex 评审 ${short(head)} 无意见，等待 👍`)
    : item("action", `Codex 评审 ${short(head)} 无意见但没有 👍：用 request-review --force 请求复审`);
}

function judgeCi(snapshot: Snapshot): GateItem {
  const label = (check: Check) => (check.workflow ? `${check.workflow} / ${check.name}` : check.name);
  const running = snapshot.checks.filter((check) => check.status !== "COMPLETED");
  const failed = snapshot.checks.filter((check) => check.status === "COMPLETED" && !PASSING.has(check.conclusion ?? ""));
  if (failed.length > 0) {
    return {
      id: "ci",
      state: "action",
      summary: `CI 有 ${failed.length} 项未通过（失败、取消、超时都不算通过）`,
      details: failed.map((check) => `${label(check)}: ${check.conclusion ?? "无结论"}`),
    };
  }
  if (snapshot.checksTruncated) return { id: "ci", state: "action", summary: "检查项超过单次查询上限，需在 PR 页面人工核对 CI", details: [] };
  if (snapshot.checks.length === 0) return { id: "ci", state: "pending", summary: "最新提交还没有任何检查项", details: [] };
  if (running.length > 0) {
    return { id: "ci", state: "pending", summary: `CI 还有 ${running.length} 项未完成`, details: running.map((check) => `${label(check)}: ${check.status}`) };
  }
  const skipped = snapshot.checks.filter((check) => check.conclusion === "SKIPPED").length;
  return { id: "ci", state: "pass", summary: `CI ${snapshot.checks.length - skipped} 项通过${skipped ? `、${skipped} 项跳过` : ""}`, details: [] };
}

function judgeThreads(snapshot: Snapshot): GateItem {
  if (snapshot.threadsTruncated) return { id: "threads", state: "action", summary: "评审线程超过单次查询上限，需在 PR 页面人工核对", details: [] };
  const open = snapshot.threads.filter((thread) => !thread.resolved);
  if (open.length === 0) return { id: "threads", state: "pass", summary: `评审线程全部已解决（共 ${snapshot.threads.length} 条）`, details: [] };
  return {
    id: "threads",
    state: "action",
    summary: `${open.length} 条评审线程未解决`,
    details: open.map((thread) => {
      const first = thread.comments[0];
      return `${thread.id} ${login(first?.author ?? "?")} ${thread.path ?? ""}: ${firstLine(first?.body ?? "")} ${first?.url ?? ""}`.trim();
    }),
  };
}

function judgeComments(snapshot: Snapshot): GateItem {
  if (snapshot.commentsTruncated) return { id: "comments", state: "action", summary: "评论超过单次查询上限，需在 PR 页面人工核对", details: [] };
  const authorSpoke = snapshot.comments
    .filter((comment) => comment.author === snapshot.author && !REVIEW_REQUEST.test(comment.body.trim()))
    .map((comment) => time(comment.createdAt))
    .sort((a, b) => b - a)[0] ?? 0;
  const others = [
    ...snapshot.comments.filter((comment) => !comment.bot && comment.author !== snapshot.author),
    ...snapshot.reviews.filter((review) => !review.bot && review.author !== snapshot.author && (review.body.trim() !== "" || review.state === "CHANGES_REQUESTED")),
  ];
  const waiting = others.filter((entry) => time(entry.createdAt) > authorSpoke);
  const details = waiting.map((entry) => `${entry.author}: ${firstLine(entry.body) || "(无正文)"} ${entry.url}`);
  if (snapshot.reviewDecision === "CHANGES_REQUESTED") details.unshift("评审结论为 CHANGES_REQUESTED，需评审者重新批准");
  if (details.length === 0) return { id: "comments", state: "pass", summary: "没有待回应的人工评论", details: [] };
  return { id: "comments", state: "action", summary: `${details.length} 条人工评审意见待回应`, details };
}

const NON_ENGLISH = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const TITLE = /^\p{Extended_Pictographic}[\u{FE0F}\u{200D}\p{Extended_Pictographic}]*\s+[a-z]+(?:\([^)]+\))?!?:\s+\S/u;
const RECORD_ID = /\b(?:tpc|msg|op|agt|docs)_[A-Za-z0-9]{10,}\b/gu;
const HOME_PATH = /(?:\/home\/|\/Users\/|[A-Za-z]:\\Users\\)([A-Za-z0-9._-]+)/gu;
const PLACEHOLDER_USERS = new Set(["user", "username", "name", "you", "me", "xxx", "runner"]);

/** Quoted literals (code spans, fences) and HTML comments are not prose. */
const prose = (text: string) => text.replace(/<!--[\s\S]*?-->/gu, "").replace(/```[\s\S]*?```/gu, "").replace(/`[^`\n]*`/gu, "");

/** Problems that make a piece of text unfit to publish on a community pull request. */
export function textProblems(text: string): string[] {
  const problems: string[] = [];
  if (NON_ENGLISH.test(prose(text))) problems.push("含非英文文字");
  const ids = [...new Set(text.match(RECORD_ID) ?? [])].filter((id) => /\d/u.test(id) || (/[a-z]/u.test(id.slice(id.indexOf("_"))) && /[A-Z]/u.test(id)));
  if (ids.length > 0) problems.push(`含疑似生产数据标识 ${ids.join("、")}`);
  const homes = [...new Set([...text.matchAll(HOME_PATH)].filter((match) => !PLACEHOLDER_USERS.has(match[1].toLowerCase())).map((match) => match[0]))];
  if (homes.length > 0) problems.push(`含本机路径 ${homes.join("、")}`);
  return problems;
}

function judgeContent(snapshot: Snapshot): GateItem {
  const details: string[] = [];
  if (!TITLE.test(snapshot.title)) details.push(`标题不符合 <gitmoji> <type>(<scope>): <description>：${snapshot.title}`);
  for (const problem of textProblems(snapshot.title)) details.push(`标题${problem}`);
  for (const problem of textProblems(snapshot.body)) details.push(`正文${problem}`);
  const own = [...snapshot.comments, ...snapshot.threads.flatMap((thread) => thread.comments)].filter((comment) => comment.author === snapshot.author);
  for (const comment of own) for (const problem of textProblems(comment.body)) details.push(`评论${problem} ${comment.url}`);
  if (details.length === 0) return { id: "content", state: "pass", summary: "标题、正文和本人评论符合公开发布要求", details: [] };
  return { id: "content", state: "action", summary: `${details.length} 处公开内容需要修改（一律英文，引用的界面文案放进代码标记；不带生产数据标识和本机路径）`, details };
}

function judgePr(snapshot: Snapshot, base: string): GateItem {
  const details: string[] = [];
  if (snapshot.isDraft) details.push("PR 是 Draft：社区 PR 直接开普通 PR，标为 ready 后 Codex 才会评审");
  if (snapshot.base !== base) details.push(`目标分支是 ${snapshot.base}，应为 ${base}`);
  if (details.length === 0) return { id: "pr", state: "pass", summary: `普通 PR，目标分支 ${base}`, details: [] };
  return { id: "pr", state: "action", summary: "PR 形态不符合约定", details };
}

function judgeMergeable(snapshot: Snapshot): GateItem {
  if (snapshot.mergeable === "MERGEABLE") return { id: "mergeable", state: "pass", summary: "与目标分支无冲突", details: [] };
  if (snapshot.mergeable === "CONFLICTING") return { id: "mergeable", state: "action", summary: "与目标分支有冲突：rebase 到最新目标分支后重新推送", details: [] };
  return { id: "mergeable", state: "pending", summary: "GitHub 还在计算是否可合并", details: [] };
}

export function evaluate(snapshot: Snapshot, options: GateOptions): GateResult {
  const now = Date.parse(options.now);
  const items = [
    judgePr(snapshot, options.base),
    judgeMergeable(snapshot),
    judgeCi(snapshot),
    judgeCodex(snapshot, now),
    judgeThreads(snapshot),
    judgeComments(snapshot),
    judgeContent(snapshot),
  ];
  let verdict: Verdict = "ready";
  if (snapshot.state === "MERGED") verdict = "merged";
  else if (snapshot.state === "CLOSED") verdict = "closed";
  else if (items.some((item) => item.state === "action")) verdict = "action";
  else if (items.some((item) => item.state === "pending")) verdict = "waiting";
  return { verdict, repo: snapshot.repo, number: snapshot.number, url: snapshot.url, headSha: snapshot.headSha, items };
}
