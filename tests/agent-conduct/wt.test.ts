import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "../../skills/agent-conduct/scripts/wt.ts");
let fixtureRoot = "";
let workspace = "";
let repo = "";
let worktreeRoot = "";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Fixture User",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture User",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "protocol.file.allow",
  GIT_CONFIG_VALUE_0: "always",
};

function git(args: string[], cwd: string): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, env: GIT_ENV, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString() || result.stdout.toString());
  return result.stdout.toString().trim();
}

function wt(args: string[]): { code: number; json: any; stderr: string } {
  const result = Bun.spawnSync(["bun", script, ...args], {
    env: { ...GIT_ENV, AGENT_WORKTREE_ROOT: worktreeRoot },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString();
  let json: any = null;
  try {
    json = JSON.parse(stdout);
  } catch {
    json = stdout;
  }
  return { code: result.exitCode, json, stderr: result.stderr.toString() };
}

function initRepo(path: string): void {
  mkdirSync(path, { recursive: true });
  git(["init", "-q", "-b", "main"], path);
  writeFileSync(join(path, "README.md"), "fixture\n");
  git(["add", "README.md"], path);
  git(["commit", "-q", "-m", "initial"], path);
}

beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "agent-conduct-wt-"));
  workspace = join(fixtureRoot, "workspace");
  repo = join(workspace, "app");
  worktreeRoot = join(fixtureRoot, "worktrees");
  initRepo(repo);
  writeFileSync(join(repo, ".gitignore"), ".env\n");
  git(["add", ".gitignore"], repo);
  git(["commit", "-q", "-m", "ignore env"], repo);
  writeFileSync(join(repo, ".env"), "SHARED=1\n");
});

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("add", () => {
  test("creates the worktree under the managed root with a task branch and the shared .env", () => {
    const result = wt(["add", "--repo", repo, "--name", "fix-login", "--no-install"]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const path = join(worktreeRoot, "app", "fix-login");
    expect(result.json).toMatchObject({ ok: true, cwd: path, branch: "wt/fix-login", envLinked: true });
    expect(git(["branch", "--show-current"], path)).toBe("wt/fix-login");
    expect(lstatSync(join(path, ".env")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(path, ".env"))).toBe(join(repo, ".env"));
    expect(git(["status", "--porcelain"], path)).toBe("");
  });

  test("starts from the default branch, not whatever the main checkout has", () => {
    git(["checkout", "-q", "-b", "someone-else"], repo);
    writeFileSync(join(repo, "wip.txt"), "wip\n");
    git(["add", "wip.txt"], repo);
    git(["commit", "-q", "-m", "wip"], repo);
    const result = wt(["add", "--repo", repo, "--name", "clean-start", "--no-install"]);
    expect(result.json).toMatchObject({ ok: true, base: "main" });
    expect(existsSync(join(result.json.cwd, "wip.txt"))).toBe(false);
  });

  test("starts from origin's real default branch, fetched, even when origin/HEAD is stale", () => {
    const origin = join(fixtureRoot, "origin.git");
    git(["clone", "-q", "--bare", repo, origin], fixtureRoot);
    git(["remote", "add", "origin", origin], repo);
    git(["push", "-q", "origin", "main:legacy"], repo);
    git(["fetch", "-q", "origin"], repo);
    git(["remote", "set-head", "origin", "legacy"], repo);
    const other = join(fixtureRoot, "other");
    git(["clone", "-q", origin, other], fixtureRoot);
    writeFileSync(join(other, "upstream.txt"), "upstream\n");
    git(["add", "upstream.txt"], other);
    git(["commit", "-q", "-m", "upstream"], other);
    git(["push", "-q", "origin", "main"], other);

    const result = wt(["add", "--repo", repo, "--name", "fresh", "--no-install"]);
    expect(result.json).toMatchObject({ ok: true, base: "origin/main" });
    expect(existsSync(join(result.json.cwd, "upstream.txt"))).toBe(true);
  });

  test("refuses to reuse an existing default branch or path", () => {
    expect(wt(["add", "--repo", repo, "--name", "dup", "--no-install"]).code).toBe(0);
    const again = wt(["add", "--repo", repo, "--name", "dup", "--no-install"]);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("已存在");
  });

  test("checks out submodules from the local superproject copy", () => {
    const library = join(fixtureRoot, "library");
    initRepo(library);
    git(["submodule", "add", "-q", library, "lib"], repo);
    git(["commit", "-q", "-m", "add submodule"], repo);
    // The original URL must not be needed: make it unreachable after the parent checkout exists.
    rmSync(library, { recursive: true, force: true });

    const result = wt(["add", "--repo", repo, "--name", "with-sub", "--no-install"]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const path = join(worktreeRoot, "app", "with-sub");
    expect(result.json.submodules).toEqual([{ path: "lib", source: "local" }]);
    expect(existsSync(join(path, "lib", "README.md"))).toBe(true);
    expect(git(["remote", "get-url", "origin"], join(path, "lib"))).toBe(library);
  });
});

describe("remove", () => {
  test("removes a clean, merged worktree and its merged branch", () => {
    wt(["add", "--repo", repo, "--name", "done", "--no-install"]);
    const path = join(worktreeRoot, "app", "done");
    const result = wt(["remove", "--path", path]);
    expect(result.stderr).toBe("");
    expect(result.json).toMatchObject({ ok: true, removed: path, branchDeleted: "wt/done" });
    expect(existsSync(path)).toBe(false);
    expect(git(["branch", "--list", "wt/done"], repo)).toBe("");
  });

  test("refuses uncommitted changes and unmerged commits unless forced", () => {
    wt(["add", "--repo", repo, "--name", "wip", "--no-install"]);
    const path = join(worktreeRoot, "app", "wip");
    writeFileSync(join(path, "draft.txt"), "draft\n");
    const dirty = wt(["remove", "--path", path]);
    expect(dirty.code).toBe(1);
    expect(dirty.stderr).toContain("未提交");

    git(["add", "draft.txt"], path);
    git(["commit", "-q", "-m", "draft"], path);
    const unmerged = wt(["remove", "--path", path]);
    expect(unmerged.code).toBe(1);
    expect(unmerged.stderr).toContain("未合入");

    const forced = wt(["remove", "--path", path, "--force"]);
    expect(forced.json).toMatchObject({ ok: true, removed: path, branchDeleted: null });
    expect(git(["branch", "--list", "wt/wip"], repo)).toContain("wt/wip");
  });

  test("treats a squash-merged worktree as merged and deletes its branch without --force", () => {
    wt(["add", "--repo", repo, "--name", "squashed", "--no-install"]);
    const path = join(worktreeRoot, "app", "squashed");
    for (const file of ["a.txt", "b.txt"]) {
      writeFileSync(join(path, file), `${file}\n`);
      git(["add", file], path);
      git(["commit", "-q", "-m", file], path);
    }
    git(["merge", "-q", "--squash", "wt/squashed"], repo);
    git(["commit", "-q", "-m", "squash merge"], repo);

    const result = wt(["remove", "--path", path]);
    expect(result.stderr).toBe("");
    expect(result.json).toMatchObject({ ok: true, removed: path, branchDeleted: "wt/squashed", remoteBranch: null });
  });

  test("judges merges against origin's real default branch, not a stale origin/HEAD", () => {
    const origin = join(fixtureRoot, "origin.git");
    git(["clone", "-q", "--bare", repo, origin], fixtureRoot);
    git(["remote", "add", "origin", origin], repo);
    wt(["add", "--repo", repo, "--name", "legacy-only", "--no-install"]);
    const path = join(worktreeRoot, "app", "legacy-only");
    writeFileSync(join(path, "work.txt"), "work\n");
    git(["add", "work.txt"], path);
    git(["commit", "-q", "-m", "work"], path);
    git(["push", "-q", "origin", "wt/legacy-only:legacy"], repo);
    git(["fetch", "-q", "origin"], repo);
    git(["remote", "set-head", "origin", "legacy"], repo);

    const listed = wt(["gc", "--workspace", workspace, "--min-idle", "0m", "--json"]);
    expect(listed.json.worktrees.find((item: any) => item.path === path)).toMatchObject({ action: "keep", reason: "有未合入 origin/main 的提交" });
    const removed = wt(["remove", "--path", path]);
    expect(removed.code).toBe(1);
    expect(removed.stderr).toContain("origin/main");
  });

  test("refuses the main worktree", () => {
    const result = wt(["remove", "--path", repo]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("主工作树");
  });
});

describe("gc", () => {
  test("lists by default and reclaims only idle, clean, merged worktrees and stale records with --apply", () => {
    wt(["add", "--repo", repo, "--name", "merged", "--no-install"]);
    wt(["add", "--repo", repo, "--name", "ahead", "--no-install"]);
    const ahead = join(worktreeRoot, "app", "ahead");
    writeFileSync(join(ahead, "work.txt"), "work\n");
    git(["add", "work.txt"], ahead);
    git(["commit", "-q", "-m", "work"], ahead);
    const stale = join(fixtureRoot, "elsewhere", "stale");
    git(["worktree", "add", "-q", "--detach", stale], repo);
    rmSync(stale, { recursive: true, force: true });
    const orphan = join(fixtureRoot, "elsewhere", "orphan");
    git(["worktree", "add", "-q", "--detach", orphan], repo);
    writeFileSync(join(orphan, "only-here.txt"), "only here\n");
    git(["add", "only-here.txt"], orphan);
    git(["commit", "-q", "-m", "only here"], orphan);
    rmSync(orphan, { recursive: true, force: true });

    const listed = wt(["gc", "--workspace", workspace, "--min-idle", "0m", "--json"]);
    expect(listed.code).toBe(0);
    const actions = Object.fromEntries(
      listed.json.worktrees.map((entry: { path: string; action: string }) => [entry.path, entry.action]),
    );
    expect(actions).toEqual({
      [join(worktreeRoot, "app", "merged")]: "remove",
      [ahead]: "keep",
      [stale]: "prune",
      [orphan]: "keep",
    });
    expect(existsSync(join(worktreeRoot, "app", "merged"))).toBe(true);

    const applied = wt(["gc", "--workspace", workspace, "--min-idle", "0m", "--apply", "--json"]);
    expect(applied.code).toBe(0);
    expect(existsSync(join(worktreeRoot, "app", "merged"))).toBe(false);
    expect(existsSync(ahead)).toBe(true);
    const remaining = git(["worktree", "list", "--porcelain"], repo);
    expect(remaining).not.toContain(stale);
    expect(remaining).toContain(ahead);
    expect(remaining).toContain(orphan);
  });

  test("keeps recently active worktrees", () => {
    wt(["add", "--repo", repo, "--name", "fresh", "--no-install"]);
    const listed = wt(["gc", "--workspace", workspace, "--json"]);
    const fresh = listed.json.worktrees.find((entry: { path: string }) => entry.path.endsWith("fresh"));
    expect(fresh).toMatchObject({ action: "keep" });
    expect(fresh.reason).toContain("最近");
  });
});
