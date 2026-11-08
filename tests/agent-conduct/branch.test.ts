import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "../../skills/agent-conduct/scripts/branch.ts");
let fixtureRoot = "";
let origin = "";
let repo = "";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Fixture User",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture User",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

function git(args: string[], cwd = repo): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, env: GIT_ENV, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString() || result.stdout.toString());
  return result.stdout.toString().trim();
}

function branchCli(args: string[]): { code: number; json: any; stderr: string } {
  const result = Bun.spawnSync(["bun", script, "--repo", repo, "--json", ...args], { env: GIT_ENV, stdout: "pipe", stderr: "pipe" });
  const stdout = result.stdout.toString();
  let json: any = null;
  try {
    json = JSON.parse(stdout);
  } catch {
    json = stdout;
  }
  return { code: result.exitCode, json, stderr: result.stderr.toString() };
}

function commit(file: string, content: string, message = file): string {
  writeFileSync(join(repo, file), content);
  git(["add", file]);
  git(["commit", "-q", "-m", message]);
  return git(["rev-parse", "HEAD"]);
}

/** A feature branch with two commits, pushed to origin, then back on main. */
function feature(name: string, files: string[]): string {
  git(["checkout", "-q", "-b", name, "main"]);
  for (const file of files) commit(file, `${file}\n`);
  git(["push", "-q", "-u", "origin", name]);
  git(["checkout", "-q", "main"]);
  return git(["rev-parse", name]);
}

function decision(json: any, scope: string, branch: string) {
  return json.decisions.find((item: any) => item.scope === scope && item.branch === branch);
}

beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "agent-conduct-branch-"));
  origin = join(fixtureRoot, "origin.git");
  repo = join(fixtureRoot, "app");
  git(["init", "-q", "--bare", "-b", "main", origin], fixtureRoot);
  git(["clone", "-q", origin, repo], fixtureRoot);
  commit("README.md", "fixture\n", "initial");
  git(["push", "-q", "-u", "origin", "main"]);
});

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("classification", () => {
  test("recognises fast-forward, squash and rebase merges, and keeps unmerged work", () => {
    feature("ff", ["ff.txt"]);
    git(["merge", "-q", "--ff-only", "ff"]);
    feature("squashed", ["s1.txt", "s2.txt"]);
    git(["merge", "-q", "--squash", "squashed"]);
    git(["commit", "-q", "-m", "squash merge"]);
    feature("rebased", ["r1.txt", "r2.txt"]);
    commit("later.txt", "later\n");
    git(["cherry-pick", "HEAD~1..rebased"]);
    feature("open-work", ["wip.txt"]);
    git(["push", "-q", "origin", "main"]);

    const result = branchCli([]);
    expect(result.stderr).toBe("");
    expect(result.json.defaultRef).toBe("origin/main");
    expect(decision(result.json, "local", "ff")).toMatchObject({ action: "delete", evidence: "ancestor" });
    expect(decision(result.json, "local", "squashed")).toMatchObject({ action: "delete", evidence: "squashed" });
    expect(decision(result.json, "local", "rebased")).toMatchObject({ action: "delete", evidence: "rebased" });
    expect(decision(result.json, "local", "open-work")).toMatchObject({ action: "keep" });
    expect(decision(result.json, "local", "main")).toMatchObject({ action: "keep", reason: "默认分支" });
    expect(decision(result.json, "remote", "squashed")).toBeUndefined();
  });

  test("judges against the fetched remote default branch, not a stale local main", () => {
    feature("done", ["done.txt"]);
    const other = join(fixtureRoot, "other");
    git(["clone", "-q", origin, other], fixtureRoot);
    git(["fetch", "-q", "origin", "done"], other);
    git(["merge", "-q", "--ff-only", "origin/done"], other);
    git(["push", "-q", "origin", "main"], other);

    expect(decision(branchCli([]).json, "local", "done")).toMatchObject({ action: "delete" });
  });

  test("keeps a merged branch that is checked out in a worktree", () => {
    feature("busy", ["busy.txt"]);
    git(["merge", "-q", "--ff-only", "busy"]);
    git(["push", "-q", "origin", "main"]);
    const path = join(fixtureRoot, "busy-wt");
    git(["worktree", "add", "-q", path, "busy"]);

    expect(decision(branchCli([]).json, "local", "busy")).toMatchObject({ action: "keep", reason: `在 ${path} 检出` });
  });

  test("uses the remote's real default branch when origin/HEAD is stale", () => {
    git(["push", "-q", "origin", "main:legacy"]);
    git(["remote", "set-head", "origin", "legacy"]);
    const result = branchCli(["--branch", "legacy"]);
    expect(result.json.defaultRef).toBe("origin/main");
    expect(result.json.notes.join("\n")).toContain("远端实际默认分支是 main");
  });

  test("--branch limits the run and reports names that do not exist", () => {
    feature("one", ["one.txt"]);
    feature("two", ["two.txt"]);
    const result = branchCli(["--branch", "one", "--branch", "ghost"]);
    expect(result.json.decisions.map((item: any) => item.branch)).toEqual(["one"]);
    expect(result.json.missing).toEqual(["ghost"]);
  });
});

describe("apply", () => {
  test("requires a new record file", () => {
    expect(branchCli(["--apply"]).code).toBe(2);
    const record = join(fixtureRoot, "record.json");
    writeFileSync(record, "{}");
    expect(branchCli(["--apply", "--record", record]).code).toBe(2);
  });

  test("deletes merged local and remote branches and records their tips", () => {
    const sha = feature("squashed", ["s1.txt", "s2.txt"]);
    git(["merge", "-q", "--squash", "squashed"]);
    git(["commit", "-q", "-m", "squash merge"]);
    feature("open-work", ["wip.txt"]);
    git(["push", "-q", "origin", "main"]);
    const record = join(fixtureRoot, "evidence", "branch-cleanup.json");

    const result = branchCli(["--remote", "--apply", "--record", record]);
    expect(result.code).toBe(0);
    expect(git(["branch", "--list", "squashed"])).toBe("");
    expect(git(["ls-remote", "--heads", "origin", "squashed"])).toBe("");
    expect(git(["ls-remote", "--heads", "origin", "open-work"])).not.toBe("");
    expect(git(["branch", "--list", "open-work"])).not.toBe("");

    const saved = JSON.parse(readFileSync(record, "utf8"));
    const remote = saved.decisions.find((item: any) => item.scope === "remote" && item.branch === "squashed");
    expect(remote).toMatchObject({ action: "delete", sha, done: `已删除；恢复：git push origin ${sha}:refs/heads/squashed` });
    expect(saved.decisions.find((item: any) => item.scope === "local" && item.branch === "squashed").done).toContain(`git branch squashed ${sha}`);
  });

  test("lists only without --apply", () => {
    feature("ff", ["ff.txt"]);
    git(["merge", "-q", "--ff-only", "ff"]);
    git(["push", "-q", "origin", "main"]);
    expect(decision(branchCli(["--remote"]).json, "remote", "ff")).toMatchObject({ action: "delete" });
    expect(git(["branch", "--list", "ff"])).not.toBe("");
    expect(existsSync(join(fixtureRoot, "evidence"))).toBe(false);
  });
});
