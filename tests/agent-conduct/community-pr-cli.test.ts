import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "../../skills/agent-conduct/scripts/community-pr.ts");
const HEAD = "09b13ddc42b024d33d89763dbbff524092b039cb";
const OLD = "9e79717ad4c2f1d3a5b6c7d8e9f0a1b2c3d4e5f6";
const CODEX_BOT = { login: "chatgpt-codex-connector", __typename: "Bot" };
const AUTHOR = { login: "octo", __typename: "User" };

// Stands in for the GitHub CLI: answers from files in FAKE_GH_DIR and records every call.
const FAKE_GH = `#!/usr/bin/env bun
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.env.FAKE_GH_DIR;
const args = process.argv.slice(2);
const stdin = args.includes("body=@-") ? await Bun.stdin.text() : "";
appendFileSync(join(dir, "calls.jsonl"), JSON.stringify({ args, stdin }) + "\\n");
const query = args.find((arg) => arg.startsWith("query=")) ?? "";
if (args[1] === "graphql" && query.includes("resolveReviewThread")) {
  console.log(JSON.stringify({ data: { resolveReviewThread: { thread: { isResolved: true } } } }));
} else if (args[1] === "graphql") {
  console.log(readFileSync(join(dir, "pr.json"), "utf8"));
} else {
  console.log(JSON.stringify({ html_url: "https://github.com/acme/app/pull/7#posted" }));
}
`;

let dir = "";

function summary(sha: string) {
  const state = { code_review: { commit_sha: sha, has_any_findings: false, has_unresolved_findings: false, status: "completed" } };
  return {
    databaseId: 1,
    url: "https://github.com/acme/app/pull/7#issuecomment-1",
    body: `<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 ${JSON.stringify(state)} -->`,
    createdAt: "2026-11-17T07:51:39Z",
    updatedAt: "2026-11-17T08:33:01Z",
    author: CODEX_BOT,
  };
}

/** The GraphQL answer for a pull request that meets the gate except for what a test changes. */
function pullRequest(overrides: Record<string, unknown> = {}) {
  return {
    url: "https://github.com/acme/app/pull/7",
    title: "🐛 fix(labs): expose the Codex entry on web",
    body: "### Summary\n\nContribution source: AI-assisted",
    state: "OPEN",
    isDraft: false,
    baseRefName: "canary",
    headRefOid: HEAD,
    createdAt: "2026-11-17T07:51:22Z",
    mergeable: "MERGEABLE",
    reviewDecision: null,
    author: { login: "octo" },
    reactions: { nodes: [{ content: "THUMBS_UP", createdAt: "2026-11-17T08:33:03Z", user: { login: "chatgpt-codex-connector[bot]" } }] },
    comments: { pageInfo: { hasNextPage: false }, nodes: [summary(HEAD)] },
    reviews: { nodes: [] },
    reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] },
    commits: {
      nodes: [
        {
          commit: {
            committedDate: "2026-11-17T08:17:55Z",
            statusCheckRollup: {
              contexts: {
                pageInfo: { hasNextPage: false },
                nodes: [
                  { __typename: "CheckRun", name: "Test Database", status: "COMPLETED", conclusion: "SUCCESS", checkSuite: { workflowRun: { workflow: { name: "Test CI" } } } },
                  { __typename: "StatusContext", context: "Vercel", state: "SUCCESS" },
                ],
              },
            },
          },
        },
      ],
    },
    ...overrides,
  };
}

function serve(pr: Record<string, unknown>) {
  writeFileSync(join(dir, "pr.json"), JSON.stringify({ data: { repository: { pullRequest: pr } } }));
}

function cli(args: string[]) {
  const env = { ...process.env, FAKE_GH_DIR: dir, PATH: `${dir}:${process.env.PATH}` };
  const result = Bun.spawnSync(["bun", script, ...args, "--repo", "acme/app", "--json"], { env, stdout: "pipe", stderr: "pipe" });
  const stdout = result.stdout.toString();
  let json: any = null;
  try {
    json = JSON.parse(stdout);
  } catch {
    json = stdout;
  }
  return { code: result.exitCode, json, stderr: result.stderr.toString() };
}

function calls(): { args: string[]; stdin: string }[] {
  const log = join(dir, "calls.jsonl");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

const writes = () => calls().filter((call) => call.args[1] !== "graphql" || call.args.some((arg) => arg.includes("mutation")));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-conduct-community-pr-"));
  writeFileSync(join(dir, "gh"), FAKE_GH);
  chmodSync(join(dir, "gh"), 0o755);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("community-pr.ts", () => {
  test("check reads the pull request from GitHub and exits 0 when the gate is met", () => {
    serve(pullRequest());
    const result = cli(["check", "7"]);
    expect(result.json.verdict).toBe("ready");
    expect(result.json.headSha).toBe(HEAD);
    expect(result.code).toBe(0);
    expect(writes()).toEqual([]);
  });

  test("check exits 10 on a failed check and 11 while a status is pending", () => {
    const contexts = (nodes: unknown[]) => ({ nodes: [{ commit: { committedDate: "2026-11-17T08:17:55Z", statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false }, nodes } } } }] });
    serve(pullRequest({ commits: contexts([{ __typename: "StatusContext", context: "Vercel", state: "PENDING" }]) }));
    expect(cli(["check", "7"]).code).toBe(11);

    serve(pullRequest({ commits: contexts([{ __typename: "StatusContext", context: "Vercel", state: "ERROR" }]) }));
    const failed = cli(["check", "7"]);
    expect(failed.code).toBe(10);
    expect(failed.json.items.find((item: any) => item.id === "ci").details[0]).toContain("Vercel");
  });

  test("watch gives up with exit 11 when nothing settles before the timeout", () => {
    serve(pullRequest({ mergeable: "UNKNOWN" }));
    const result = cli(["watch", "7", "--interval", "10s", "--timeout", "1s"]);
    expect(result.code).toBe(11);
    expect(result.json.timedOut).toBe(true);
    expect(result.json.verdict).toBe("waiting");
  });

  test("watch --until merged keeps waiting on a ready pull request and returns once it is merged", () => {
    serve(pullRequest());
    expect(cli(["watch", "7", "--until", "merged", "--interval", "10s", "--timeout", "1s"]).code).toBe(11);
    serve(pullRequest({ state: "MERGED" }));
    const merged = cli(["watch", "7", "--until", "merged", "--interval", "10s", "--timeout", "1s"]);
    expect(merged.code).toBe(0);
    expect(merged.json.verdict).toBe("merged");
  });

  test("request-review posts a bare @codex review when Codex has not seen the head", () => {
    serve(pullRequest({ comments: { pageInfo: { hasNextPage: false }, nodes: [summary(OLD)] } }));
    const result = cli(["request-review", "7"]);
    expect(result.code).toBe(0);
    expect(result.json.requested).toBe(true);
    const posted = writes();
    expect(posted.length).toBe(1);
    expect(posted[0].args).toEqual(["api", "repos/acme/app/issues/7/comments", "-f", "body=@codex review"]);
  });

  test("request-review does not ask again when Codex already covers the head, unless forced", () => {
    serve(pullRequest());
    const skipped = cli(["request-review", "7"]);
    expect(skipped.json.requested).toBe(false);
    expect(writes()).toEqual([]);

    expect(cli(["request-review", "7", "--force"]).json.requested).toBe(true);
    expect(writes().length).toBe(1);
  });

  test("request-review refuses a merged pull request", () => {
    serve(pullRequest({ state: "MERGED" }));
    expect(cli(["request-review", "7", "--force"]).code).toBe(1);
    expect(writes()).toEqual([]);
  });

  describe("reply", () => {
    const thread = {
      id: "PRRT_1",
      isResolved: false,
      path: "src/a.ts",
      comments: { nodes: [{ databaseId: 4596764398, url: "https://github.com/acme/app/pull/7#discussion_r1", body: "Add a regression test", createdAt: "2026-11-17T07:54:17Z", author: CODEX_BOT }] },
    };
    const body = (text: string) => {
      const file = join(dir, "reply.md");
      writeFileSync(file, text);
      return file;
    };

    test("answers the thread's first comment and resolves it", () => {
      serve(pullRequest({ reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [thread] } }));
      const result = cli(["reply", "7", "--thread", "PRRT_1", "--body-file", body("Fixed in 09b13ddc42: added a regression test.\n"), "--resolve"]);
      expect(result.code).toBe(0);
      expect(result.json.resolved).toBe(true);
      const [posted, resolved] = writes();
      expect(posted.args.slice(0, 2)).toEqual(["api", "repos/acme/app/pulls/7/comments/4596764398/replies"]);
      expect(posted.stdin).toBe("Fixed in 09b13ddc42: added a regression test.");
      expect(resolved.args).toContain("id=PRRT_1");
    });

    test("leaves the thread open without --resolve", () => {
      serve(pullRequest({ reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [thread] } }));
      const result = cli(["reply", "7", "--thread", "PRRT_1", "--body-file", body("Could you say more about the case you have in mind?")]);
      expect(result.json.resolved).toBe(false);
      expect(writes().length).toBe(1);
    });

    test("refuses a reply that is not English or names a local path, before touching GitHub", () => {
      serve(pullRequest({ reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [thread] } }));
      expect(cli(["reply", "7", "--thread", "PRRT_1", "--body-file", body("已补充回归测试。"), "--resolve"]).code).toBe(2);
      expect(cli(["reply", "7", "--thread", "PRRT_1", "--body-file", body("See /home/alice/work/app/log.txt"), "--resolve"]).code).toBe(2);
      expect(calls()).toEqual([]);
    });

    test("fails for a thread the pull request does not have", () => {
      serve(pullRequest());
      expect(cli(["reply", "7", "--thread", "PRRT_404", "--body-file", body("Fixed.")]).code).toBe(1);
      expect(writes()).toEqual([]);
    });
  });
});
