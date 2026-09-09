import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

setDefaultTimeout(30_000);
const cli = resolve(import.meta.dir, "../scripts/cow.ts");
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "CoW Test", GIT_AUTHOR_EMAIL: "cow@example.invalid",
  GIT_COMMITTER_NAME: "CoW Test", GIT_COMMITTER_EMAIL: "cow@example.invalid" };
let scratch: string;
let repo: string;
let root: string;
let holders: ReturnType<typeof Bun.spawn>[];

function run(cmd: string[], cwd = scratch) {
  return Bun.spawnSync({ cmd, cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
}
function git(cwd: string, ...args: string[]) {
  const result = run(["git", ...args], cwd);
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
function call(...args: string[]) {
  return run([process.execPath, cli, ...args, "--root", root]);
}
function ok(...args: string[]): any {
  const result = call(...args);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return JSON.parse(result.stdout.toString());
}
function fails(args: string[], message: string) {
  const result = call(...args);
  expect(result.exitCode).not.toBe(0);
  expect(JSON.parse(result.stderr.toString()).error).toContain(message);
}
function prepare() { return ok("prepare", "--repo", repo, "--id", "base"); }
function create(id: string) {
  return ok("create", "--base", "base", "--id", id,
    ...(process.env.COW_TEST_FUSE_OVERLAYFS ? ["--fuse-overlayfs", process.env.COW_TEST_FUSE_OVERLAYFS] : []));
}
function commit(cwd: string) { git(cwd, "add", "-A"); git(cwd, "commit", "-m", "Task changes"); }

beforeEach(() => {
  scratch = mkdtempSync(join(process.env.COW_TEST_TMPDIR ?? tmpdir(), "cow-workspace-test-"));
  repo = join(scratch, "source repo");
  root = join(scratch, "store with spaces");
  holders = [];
  mkdirSync(repo);
  git(repo, "init", "-b", "main");
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n.env\n.env.local\n.build/\n");
  writeFileSync(join(repo, "source.txt"), "original source\n");
  writeFileSync(join(repo, "delete.txt"), "delete in one task only\n");
  writeFileSync(join(repo, "binary.dat"), new Uint8Array([0, 1, 2, 255]));
  commit(repo);
  mkdirSync(join(repo, "node_modules/pkg"), { recursive: true });
  writeFileSync(join(repo, "node_modules/pkg/index.js"), "original dependency\n");
  writeFileSync(join(repo, ".env"), "SHARED=fixture\n");
});

afterEach(async () => {
  for (const holder of holders) { holder.kill(); await holder.exited; }
  const workspaces = join(root, "workspaces");
  if (existsSync(workspaces)) {
    for (const id of readdirSync(workspaces)) {
      const cwd = join(workspaces, id, "merged");
      run(["fusermount3", "-u", cwd]);
    }
  }
  const mounts = readFileSync("/proc/self/mountinfo", "utf8").replaceAll("\\040", " ");
  if (mounts.includes(scratch)) throw new Error(`Cleanup could not unmount fixture; retained at ${scratch}`);
  rmSync(scratch, { recursive: true });
});

test("two real CoW views isolate source, dependencies, deletes and Git, then export binary commits", () => {
  const base = prepare();
  writeFileSync(join(repo, "source.txt"), "source changed after snapshot\n");
  commit(repo);
  const a = create("agent-a").cwd;
  const b = create("agent-b").cwd;
  expect(readFileSync(join(a, "source.txt"), "utf8")).toBe("original source\n");
  expect(readdirSync(join(root, "workspaces/agent-a/upper"))).not.toContain("node_modules");
  expect(git(a, "branch", "--show-current")).toBe("cow/agent-a");
  expect(git(b, "branch", "--show-current")).toBe("cow/agent-b");
  writeFileSync(join(a, "source.txt"), "agent a\n");
  writeFileSync(join(a, "node_modules/pkg/index.js"), "agent dependency\n");
  writeFileSync(join(a, ".env.local"), "SHARED=agent-a\n");
  writeFileSync(join(a, "binary.dat"), new Uint8Array([0, 90, 91, 255, 0]));
  writeFileSync(join(a, "added.bin"), new Uint8Array([0, 42, 0]));
  rmSync(join(a, "delete.txt"));
  expect(readFileSync(join(b, "source.txt"), "utf8")).toBe("original source\n");
  expect(readFileSync(join(b, "node_modules/pkg/index.js"), "utf8")).toBe("original dependency\n");
  expect(readFileSync(join(repo, "node_modules/pkg/index.js"), "utf8")).toBe("original dependency\n");
  expect(readFileSync(join(base.path, "source.txt"), "utf8")).toBe("original source\n");
  expect(existsSync(join(b, "delete.txt"))).toBe(true);
  expect(existsSync(join(b, ".env.local"))).toBe(false);
  writeFileSync(join(repo, ".env"), "SHARED=updated\n");
  expect(readFileSync(join(a, ".env"), "utf8")).toBe("SHARED=updated\n");
  expect(readFileSync(join(b, ".env"), "utf8")).toBe("SHARED=updated\n");
  fails(["remove", "--id", "agent-a"], "Commit task source first");
  fails(["remove-base", "--id", "base"], "still referenced");
  commit(a);
  expect(git(b, "rev-parse", "HEAD")).toBe(base.commit);
  expect(git(base.path, "rev-parse", "HEAD")).toBe(base.commit);
  expect(git(a, "ls-files", "--", ".env.local", ".env")).toBe("");
  fails(["remove", "--id", "agent-a"], "without an intact current export");
  const bundle = join(scratch, "result.bundle");
  const exported = ok("export", "--id", "agent-a", "--output", bundle);
  fails(["export", "--id", "agent-a", "--output", bundle], "already exists");
  const imported = join(scratch, "imported");
  git(scratch, "clone", repo, imported);
  git(imported, "fetch", bundle, "HEAD");
  expect(git(imported, "rev-parse", "FETCH_HEAD")).toBe(exported.head);
  git(imported, "checkout", "--detach", "FETCH_HEAD");
  expect([...readFileSync(join(imported, "binary.dat"))]).toEqual([0, 90, 91, 255, 0]);
  expect([...readFileSync(join(imported, "added.bin"))]).toEqual([0, 42, 0]);
  expect(existsSync(join(imported, "delete.txt"))).toBe(false);
  expect(git(repo, "branch", "--show-current")).toBe("main");
  ok("remove", "--id", "agent-a");
  ok("remove", "--id", "agent-b");
  ok("remove-base", "--id", "base");
  expect(ok("list").workspaces).toEqual([]);
  expect(ok("list").baselines).toEqual([]);
  expect(existsSync(bundle)).toBe(true);
});

test("remount retains writes, refuses mismatched baselines, and protects busy mounts", async () => {
  prepare();
  const cwd = create("resume").cwd;
  writeFileSync(join(cwd, "source.txt"), "keep across remount\n");
  expect(run(["fusermount3", "-u", cwd]).exitCode).toBe(0);
  expect(ok("status", "--id", "resume").mounted).toBe(false);
  fails(["remove", "--id", "resume"], "not mounted");
  expect(create("resume").resumed).toBe(true);
  expect(readFileSync(join(cwd, "source.txt"), "utf8")).toBe("keep across remount\n");
  ok("prepare", "--repo", repo, "--id", "other");
  fails(["create", "--base", "other", "--id", "resume"], "another baseline");
  const holder = Bun.spawn(["sleep", "25"], { cwd, stdout: "ignore", stderr: "ignore" });
  holders.push(holder);
  await Bun.sleep(100);
  fails(["remove", "--id", "resume", "--discard"], "fusermount3 failed");
  expect(ok("status", "--id", "resume").mounted).toBe(true);
  expect(readFileSync(join(cwd, "source.txt"), "utf8")).toBe("keep across remount\n");
  holder.kill();
  await holder.exited;
  holders = [];
  ok("remove", "--id", "resume", "--discard");
});

test("preparation rejects dirty source and escaping links without leaving partial baselines", () => {
  writeFileSync(join(repo, "untracked.txt"), "do not omit me\n");
  fails(["prepare", "--repo", repo, "--id", "dirty"], "Commit task source first");
  rmSync(join(repo, "untracked.txt"));
  symlinkSync(join(repo, "source.txt"), join(repo, "node_modules/escape"));
  fails(["prepare", "--repo", repo, "--id", "escape"], "Symlink escapes");
  expect(existsSync(join(root, "bases/escape"))).toBe(false);
  rmSync(join(repo, "node_modules/escape"));
  prepare();
  fails(["prepare", "--repo", repo, "--id", "base"], "already exists");
  fails(["create", "--base", "base", "--id", "../escape"], "IDs must");
  fails(["create", "--base", "base", "--id", "missing", "--fuse-overlayfs", join(scratch, "missing")], "fuse-overlayfs is required");
  expect(existsSync(join(root, "workspaces/missing"))).toBe(false);
});

test("removal protects damaged exports and commits on another task branch", () => {
  prepare();
  const cwd = create("guard").cwd;
  writeFileSync(join(cwd, "source.txt"), "committed task\n");
  commit(cwd);
  const output = join(scratch, "guard.bundle");
  ok("export", "--id", "guard", "--output", output);
  writeFileSync(output, "damaged export");
  fails(["remove", "--id", "guard"], "without an intact current export");
  ok("export", "--id", "guard", "--output", join(scratch, "guard-intact.bundle"));
  git(cwd, "switch", "-c", "other-task");
  writeFileSync(join(cwd, "other.txt"), "other branch\n");
  commit(cwd);
  git(cwd, "switch", "cow/guard");
  fails(["remove", "--id", "guard"], "Other branches or tags");
  ok("remove", "--id", "guard", "--discard");
});

test("prepared dependencies stay ignored even when the source used local excludes", () => {
  git(repo, "switch", "-c", "cow/same-name");
  const dependency = "prepared [deps]";
  writeFileSync(join(repo, ".git/info/exclude"), "/prepared \\[deps\\]/\n", { flag: "a" });
  mkdirSync(join(repo, dependency));
  writeFileSync(join(repo, dependency, "tool.dat"), "prepared tool\n");
  ok("prepare", "--repo", repo, "--id", "base", "--include", dependency);
  const cwd = create("same-name").cwd;
  expect(ok("status", "--id", "same-name").dirty).toBe(false);
  writeFileSync(join(cwd, dependency, "tool.dat"), "rebuilt tool\n");
  expect(ok("status", "--id", "same-name").dirty).toBe(false);
  expect(readFileSync(join(repo, dependency, "tool.dat"), "utf8")).toBe("prepared tool\n");
  ok("remove", "--id", "same-name");
});
