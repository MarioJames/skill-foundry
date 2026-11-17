import { describe, expect, test } from "bun:test";
import { evaluate, type Snapshot } from "../../skills/agent-conduct/scripts/lib/pr-gate";

const HEAD = "09b13ddc42b024d33d89763dbbff524092b039cb";
const OLD = "9e79717ad4c2f1d3a5b6c7d8e9f0a1b2c3d4e5f6";
const NOW = "2026-11-17T09:00:00Z";
const CODEX = "chatgpt-codex-connector[bot]";

function summary(sha: string, state: { status?: string; any?: boolean; unresolved?: boolean } = {}) {
  const codeReview = {
    commit_sha: sha,
    has_any_findings: state.any ?? false,
    has_unresolved_findings: state.unresolved ?? false,
    status: state.status ?? "completed",
  };
  return {
    author: CODEX,
    bot: true,
    body: `<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 ${JSON.stringify({ code_review: codeReview, security_review: { commit_sha: null, status: null } })} -->\n\n<details>…</details>`,
    createdAt: "2026-11-17T07:51:39Z",
    updatedAt: "2026-11-17T08:33:01Z",
    url: "https://github.com/acme/app/pull/7#issuecomment-1",
  };
}

/** A pull request that meets every gate; each test breaks one thing. */
function ready(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    repo: "acme/app",
    number: 7,
    url: "https://github.com/acme/app/pull/7",
    title: "🐛 fix(labs): expose the Codex entry on web",
    body: "### Summary\n\nContribution source: AI-assisted\n\nThe switch was desktop-only.\n\n- Acceptance: Not needed: tooling only",
    state: "OPEN",
    isDraft: false,
    base: "canary",
    headSha: HEAD,
    headCommittedAt: "2026-11-17T08:17:55Z",
    createdAt: "2026-11-17T07:51:22Z",
    author: "octo",
    mergeable: "MERGEABLE",
    reviewDecision: null,
    checks: [
      { name: "Test App (shard 1/3)", workflow: "Test CI", status: "COMPLETED", conclusion: "SUCCESS" },
      { name: "Build Desktop App", workflow: "Desktop PR Build", status: "COMPLETED", conclusion: "SKIPPED" },
      { name: "Vercel", workflow: null, status: "COMPLETED", conclusion: "SUCCESS" },
    ],
    checksTruncated: false,
    threads: [],
    threadsTruncated: false,
    comments: [summary(HEAD)],
    commentsTruncated: false,
    reviews: [],
    reactions: [{ author: CODEX, content: "THUMBS_UP", createdAt: "2026-11-17T08:33:03Z" }],
    ...overrides,
  };
}

function item(snapshot: Snapshot, id: string) {
  const result = evaluate(snapshot, { base: "canary", now: NOW });
  const found = result.items.find((entry) => entry.id === id);
  if (!found) throw new Error(`no gate item ${id}`);
  return { verdict: result.verdict, ...found };
}

describe("community pull request gate", () => {
  test("is ready when CI, Codex on the head commit, threads and content all pass", () => {
    const result = evaluate(ready(), { base: "canary", now: NOW });
    expect(result.items.filter((entry) => entry.state !== "pass")).toEqual([]);
    expect(result.verdict).toBe("ready");
  });

  test("reports merged and closed pull requests instead of judging the gate", () => {
    expect(evaluate(ready({ state: "MERGED" }), { base: "canary", now: NOW }).verdict).toBe("merged");
    expect(evaluate(ready({ state: "CLOSED" }), { base: "canary", now: NOW }).verdict).toBe("closed");
  });

  test("a Codex approval of an earlier commit does not cover the head", () => {
    // The 👍 from the earlier review is still on the pull request.
    const codex = item(ready({ comments: [summary(OLD)] }), "codex");
    expect(codex.state).toBe("action");
    expect(codex.verdict).toBe("action");
    expect(codex.summary).toContain(OLD.slice(0, 7));
  });

  test("waits instead of asking again while a review request for the head is outstanding", () => {
    const request = {
      author: "octo",
      bot: false,
      body: "@codex review",
      createdAt: "2026-11-17T08:58:00Z",
      updatedAt: "2026-11-17T08:58:00Z",
      url: "https://github.com/acme/app/pull/7#issuecomment-2",
    };
    const codex = item(ready({ comments: [summary(OLD), request] }), "codex");
    expect(codex.state).toBe("pending");
  });

  test("a review request Codex never answered turns into an action", () => {
    const request = {
      author: "octo",
      bot: false,
      body: "@codex review",
      createdAt: "2026-11-17T08:20:00Z",
      updatedAt: "2026-11-17T08:20:00Z",
      url: "https://github.com/acme/app/pull/7#issuecomment-2",
    };
    expect(item(ready({ comments: [summary(OLD), request] }), "codex").state).toBe("action");
  });

  test("a review request posted before the head commit does not count", () => {
    const request = {
      author: "octo",
      bot: false,
      body: "@codex review",
      createdAt: "2026-11-17T08:10:00Z",
      updatedAt: "2026-11-17T08:10:00Z",
      url: "https://github.com/acme/app/pull/7#issuecomment-2",
    };
    const snapshot = ready({ comments: [summary(OLD), request], headCommittedAt: "2026-11-17T08:59:00Z" });
    expect(item(snapshot, "codex").state).toBe("action");
  });

  test("waits while Codex is reviewing the head", () => {
    expect(item(ready({ comments: [summary(HEAD, { status: "in_progress" })], reactions: [] }), "codex").state).toBe("pending");
  });

  test("a new pull request without any Codex activity waits briefly, then asks", () => {
    const fresh = ready({ comments: [], reactions: [], createdAt: "2026-11-17T08:58:30Z", headCommittedAt: "2026-11-17T08:50:00Z" });
    expect(item(fresh, "codex").state).toBe("pending");
    const stale = ready({ comments: [], reactions: [] });
    expect(item(stale, "codex").state).toBe("action");
  });

  test("findings on the head block until Codex approves again", () => {
    const unresolved = ready({ comments: [summary(HEAD, { any: true, unresolved: true })], reactions: [] });
    expect(item(unresolved, "codex").state).toBe("action");

    // Threads resolved by hand, but the only 👍 predates this review.
    const disputed = ready({
      comments: [summary(HEAD, { any: true })],
      reactions: [{ author: CODEX, content: "THUMBS_UP", createdAt: "2026-11-17T08:00:00Z" }],
    });
    expect(item(disputed, "codex").state).toBe("action");
  });

  test("an unfinished check keeps the gate waiting; a failed or cancelled one needs action", () => {
    const running = ready({
      checks: [
        { name: "Test Server (shard 2/3)", workflow: "Test CI", status: "IN_PROGRESS", conclusion: null },
        { name: "Test Database", workflow: "Test CI", status: "COMPLETED", conclusion: "SUCCESS" },
      ],
    });
    expect(item(running, "ci").state).toBe("pending");
    expect(item(running, "ci").verdict).toBe("waiting");

    for (const conclusion of ["FAILURE", "CANCELLED", "TIMED_OUT"]) {
      const failed = ready({
        checks: [
          { name: "Test Server (shard 2/3)", workflow: "Test CI", status: "IN_PROGRESS", conclusion: null },
          { name: "Test Database", workflow: "Test CI", status: "COMPLETED", conclusion },
        ],
      });
      const ci = item(failed, "ci");
      expect(ci.state).toBe("action");
      expect(ci.details.join("\n")).toContain("Test Database");
    }
  });

  test("no checks yet is not a pass", () => {
    expect(item(ready({ checks: [] }), "ci").state).toBe("pending");
  });

  test("an unresolved review thread blocks, and so does a list too long to see whole", () => {
    const thread = {
      id: "PRRT_1",
      resolved: false,
      path: "src/a.ts",
      comments: [{ author: CODEX, bot: true, body: "**P1** Add a regression test", createdAt: "2026-11-17T07:54:17Z", url: "https://github.com/acme/app/pull/7#discussion_r1", databaseId: 1 }],
    };
    const threads = item(ready({ threads: [thread] }), "threads");
    expect(threads.state).toBe("action");
    expect(threads.details.join("\n")).toContain("PRRT_1");

    expect(item(ready({ threads: [{ ...thread, resolved: true }] }), "threads").state).toBe("pass");
    expect(item(ready({ threadsTruncated: true }), "threads").state).toBe("action");
  });

  test("a maintainer comment needs a reply from the author; bots and answered comments do not", () => {
    const human = { author: "maintainer", bot: false, body: "Why not reuse the hook?", createdAt: "2026-11-17T08:40:00Z", updatedAt: "2026-11-17T08:40:00Z", url: "https://github.com/acme/app/pull/7#issuecomment-3" };
    const bot = { author: "codecov[bot]", bot: true, body: "## Codecov Report", createdAt: "2026-11-17T08:45:00Z", updatedAt: "2026-11-17T08:45:00Z", url: "https://github.com/acme/app/pull/7#issuecomment-4" };
    const reply = { author: "octo", bot: false, body: "The hook is desktop-only; explained in the description.", createdAt: "2026-11-17T08:50:00Z", updatedAt: "2026-11-17T08:50:00Z", url: "https://github.com/acme/app/pull/7#issuecomment-5" };
    const rerequest = { ...reply, body: "@codex review" };

    expect(item(ready({ comments: [summary(HEAD), human, bot] }), "comments").state).toBe("action");
    expect(item(ready({ comments: [summary(HEAD), bot] }), "comments").state).toBe("pass");
    expect(item(ready({ comments: [summary(HEAD), human, reply] }), "comments").state).toBe("pass");
    // Asking Codex again is not an answer to the maintainer.
    expect(item(ready({ comments: [summary(HEAD), human, rerequest] }), "comments").state).toBe("action");
  });

  test("requested changes block", () => {
    expect(item(ready({ reviewDecision: "CHANGES_REQUESTED" }), "comments").state).toBe("action");
  });

  test("conflicts, drafts and a wrong base need action", () => {
    expect(item(ready({ mergeable: "CONFLICTING" }), "mergeable").state).toBe("action");
    expect(item(ready({ mergeable: "UNKNOWN" }), "mergeable").state).toBe("pending");
    expect(item(ready({ isDraft: true }), "pr").state).toBe("action");
    expect(item(ready({ base: "main" }), "pr").state).toBe("action");
  });

  test("public text must be English: title, description, and the author's own comments", () => {
    expect(item(ready({ title: "🐛 fix: 修复网页入口" }), "content").state).toBe("action");
    expect(item(ready({ body: "### Summary\n\nContribution source: AI-assisted\n\n网页用户无法找到入口。" }), "content").state).toBe("action");

    const chineseRequest = { author: "octo", bot: false, body: "@codex review\n\n请复审最新提交。", createdAt: "2026-11-17T08:30:37Z", updatedAt: "2026-11-17T08:30:37Z", url: "https://github.com/acme/app/pull/7#issuecomment-9" };
    const flagged = item(ready({ comments: [summary(HEAD), chineseRequest] }), "content");
    expect(flagged.state).toBe("action");
    expect(flagged.details.join("\n")).toContain("issuecomment-9");

    const chineseReply = {
      id: "PRRT_1",
      resolved: true,
      path: "src/a.ts",
      comments: [
        { author: CODEX, bot: true, body: "Add a test", createdAt: "2026-11-17T07:54:17Z", url: "https://github.com/acme/app/pull/7#discussion_r1", databaseId: 1 },
        { author: "octo", bot: false, body: "已补充回归测试。", createdAt: "2026-11-17T08:31:33Z", url: "https://github.com/acme/app/pull/7#discussion_r2", databaseId: 2 },
      ],
    };
    expect(item(ready({ threads: [chineseReply] }), "content").details.join("\n")).toContain("discussion_r2");
  });

  test("quoted product strings in code spans are not a language problem", () => {
    const body = "### Summary\n\nContribution source: AI-assisted\n\nThe label `超时默认选项 1` was wrong.\n\n```\n网页\n```";
    expect(item(ready({ body }), "content").state).toBe("pass");
  });

  test("the title follows gitmoji type(scope): description", () => {
    expect(item(ready({ title: "fix(labs): expose the Codex entry" }), "content").state).toBe("action");
    expect(item(ready({ title: "🐛 expose the Codex entry" }), "content").state).toBe("action");
    expect(item(ready({ title: "♻️ refactor: split the gate" }), "content").state).toBe("pass");
  });

  test("production record ids and local home paths are flagged, placeholders are not", () => {
    const leaked = "### Summary\n\nContribution source: AI-assisted\n\nSeen in tpc_Ab3dEf9hIjKl, logs under /home/alice/work/app.";
    const flagged = item(ready({ body: leaked }), "content");
    expect(flagged.state).toBe("action");
    expect(flagged.details.length).toBe(2);

    const placeholders = "### Summary\n\nContribution source: AI-assisted\n\nA topic id looks like tpc_xxx; paths like /Users/user/app.";
    expect(item(ready({ body: placeholders }), "content").state).toBe("pass");
  });
});
