#!/usr/bin/env bun

import {
  constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync,
  statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

const help = `Usage: bun cow.ts <command> [options]

  prepare --repo PATH --id BASE [--include RELATIVE_PATH ...] [--env-file PATH]
  create --base BASE --id TASK
  status --id TASK
  list
  export --id TASK --output PATH
  remove --id TASK [--discard]
  remove-base --id BASE

Options:
  --root PATH                 Store (default: ~/.local/share/cow-workspace)
  --fuse-overlayfs PATH       Alternate fuse-overlayfs executable
  --help                      Show this help

prepare copies one committed, idle baseline; create uses real CoW.
Repeated create resumes retained work. remove never force-unmounts.
Output: JSON. Errors: JSON on stderr, nonzero exit.`;

type Base = { kind: "base"; id: string; source: string; commit: string };
type Workspace = {
  kind: "workspace"; id: string; base: string;
  exported?: { head: string; path: string; sha256: string };
};
type State = Base | Workspace;

function fail(message: string): never { throw new Error(message); }
function run(cmd: string[], cwd?: string): string {
  const env = { ...process.env };
  if (cmd[0] === "git") {
    for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE",
      "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) delete env[key];
    env.GIT_TERMINAL_PROMPT = "0";
  }
  const result = Bun.spawnSync({ cmd, cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) fail(`${cmd[0]} failed: ${result.stderr.toString().trim() || `exit ${result.exitCode}`}`);
  return result.stdout.toString().trimEnd();
}
function git(cwd: string, ...args: string[]): string { return run(["git", ...args], cwd); }
function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}
function validId(id: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id)) fail("IDs must be 1–64 letters, digits, dots, underscores or hyphens, starting with a letter or digit");
  return id;
}
function writeState(dir: string, state: State): void {
  const temp = join(dir, `state-${randomUUID()}.tmp`);
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temp, join(dir, "state.json"));
}
function readState<T extends State>(dir: string, kind: T["kind"]): T {
  if (lstatSync(dir).isSymbolicLink()) fail("Managed directories must not be symlinks");
  const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as T;
  if (state.kind !== kind || join(dirname(dir), validId(state.id)) !== dir) fail("Invalid workspace metadata");
  if (state.kind === "workspace") validId(state.base);
  return state;
}
function mounts(): Array<{ path: string; type: string }> {
  return readFileSync("/proc/self/mountinfo", "utf8").trim().split("\n").map((line) => {
    const fields = line.split(" ");
    return {
      path: fields[4].replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8))),
      type: fields[fields.indexOf("-") + 1],
    };
  });
}
function isMounted(path: string): boolean {
  const mount = mounts().find((entry) => entry.path === path);
  if (mount && mount.type !== "fuse.fuse-overlayfs") fail(`Unexpected filesystem at ${path}: ${mount.type}`);
  return Boolean(mount);
}
function removeDirectory(dir: string): void {
  if (mounts().some((mount) => inside(dir, mount.path))) fail(`Mounts remain under ${dir}; retaining data`);
  rmSync(dir, { recursive: true });
}
function digest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function sourceClean(repo: string): void {
  if (git(repo, "status", "--porcelain", "--untracked-files=normal")) {
    fail("Commit task source first: staged, unstaged, or untracked source is present (ignored files are allowed)");
  }
}
function auditLinks(root: string, sharedEnv?: string): void {
  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (dir === root && entry.name === ".git") continue;
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        if (path === join(root, ".env") && sharedEnv && realpathSync(path) === sharedEnv) continue;
        const target = resolve(dirname(path), readlinkSync(path));
        if (!inside(root, target) || (existsSync(target) && !inside(root, realpathSync(target)))) {
          fail(`Symlink escapes the baseline: ${relative(root, path)}; prepare self-contained dependencies`);
        }
      } else if (entry.isDirectory()) walk(path);
    }
  }
  walk(root);
}

const options = {
    repo: { type: "string" }, id: { type: "string" }, base: { type: "string" },
    root: { type: "string" }, output: { type: "string" },
    include: { type: "string", multiple: true }, "env-file": { type: "string" },
    "fuse-overlayfs": { type: "string" }, discard: { type: "boolean" },
    help: { type: "boolean", short: "h" },
} as const;

async function main(): Promise<void> {
  const { values: flags, positionals } = parseArgs({ args: Bun.argv.slice(2), allowPositionals: true, options });
  const required = (name: "repo" | "id" | "base" | "output"): string => flags[name] || fail(`--${name} is required`);
  if (flags.help || positionals.length === 0) { console.log(help); return; }
  const [command] = positionals;
  const allowed: Record<string, string[]> = {
    prepare: ["repo", "id", "include", "env-file"], create: ["base", "id", "fuse-overlayfs"],
    status: ["id"], list: [], export: ["id", "output"], remove: ["id", "discard"], "remove-base": ["id"],
  };
  if (positionals.length !== 1 || !allowed[command]) fail("Unknown command; use --help");
  for (const key of Object.keys(flags)) {
    if (!["root", ...allowed[command]].includes(key)) fail(`--${key} is not valid for ${command}`);
  }
  if (process.platform !== "linux") fail("This skill's CoW backend requires Linux");
  const rootInput = resolve(flags.root ?? join(homedir(), ".local/share/cow-workspace"));
  mkdirSync(rootInput, { recursive: true, mode: 0o700 });
  const root = realpathSync(rootInput);
  if (/[:,\n]/.test(root)) fail("Store path cannot contain comma, colon, or newline (overlay option separators)");
  for (const kind of ["bases", "workspaces"]) {
    const dir = join(root, kind);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (lstatSync(dir).isSymbolicLink()) fail("Store subdirectories must not be symlinks");
  }
  if (process.env.COW_WORKSPACE_LOCK_HELD !== root) {
    if (!Bun.which("flock")) fail("flock is required");
    const result = Bun.spawnSync({
      cmd: ["flock", "--nonblock", "--conflict-exit-code", "75", join(root, ".lock"), process.execPath, import.meta.path, ...Bun.argv.slice(2)],
      env: { ...process.env, COW_WORKSPACE_LOCK_HELD: root },
      stdin: "ignore", stdout: "inherit", stderr: "inherit",
    });
    if (result.exitCode === 75) fail("Another workspace operation is active; retry after it finishes");
    process.exitCode = result.exitCode;
    return;
  }
  const baseDir = (id: string) => join(root, "bases", validId(id));
  const taskDir = (id: string) => join(root, "workspaces", validId(id));
  const emit = (data: object) => console.log(JSON.stringify({ ok: true, ...data }, null, 2));

  if (command === "prepare") {
    const source = realpathSync(git(realpathSync(required("repo")), "rev-parse", "--show-toplevel"));
    if (inside(source, root) || inside(root, source)) fail("The store and source repository must be outside each other");
    sourceClean(source);
    if (git(source, "ls-files", "--stage").split("\n").some((line) => line.startsWith("160000 "))) fail("Submodule baselines are not supported by this backend");
    if (git(source, "ls-files", "--", ".env", ".env.local")) fail("Shared .env and local overrides must be untracked configuration");
    const commit = git(source, "rev-parse", "HEAD");
    const id = validId(required("id"));
    const dir = baseDir(id);
    if (existsSync(dir)) fail("Baseline ID already exists; use it or prepare a new ID");
    const envInput = flags["env-file"] ?? (existsSync(join(source, ".env")) ? join(source, ".env") : undefined);
    const sharedEnv = envInput ? realpathSync(envInput) : undefined;
    if (sharedEnv && (!statSync(sharedEnv).isFile() || inside(root, sharedEnv))) fail("Shared environment must be a file outside the managed store");
    mkdirSync(dir, { mode: 0o700 });
    try {
      const repo = join(dir, "repo");
      run(["git", "clone", "--no-hardlinks", "--no-checkout", "--", source, repo]);
      git(repo, "checkout", "--detach", commit);
      git(repo, "remote", "remove", "origin");
      git(repo, "config", "gc.auto", "0");
      const includes = new Set(flags.include ?? []);
      if (existsSync(join(source, "node_modules"))) includes.add("node_modules");
      const ignoredIncludes: string[] = [];
      for (const input of includes) {
        const from = resolve(source, input);
        const rel = relative(source, from);
        if (!rel || isAbsolute(input) || !inside(source, from) || rel.split(sep).some((part) => part === ".git" || part.startsWith(".env"))) fail("--include must name a repository-relative dependency path, excluding Git and environment files");
        if (git(source, "ls-files", "--", rel)) fail(`Included path contains tracked source: ${rel}`);
        if (!inside(source, realpathSync(from))) fail(`Included path escapes the source repository: ${rel}`);
        const to = join(repo, rel);
        if (existsSync(to)) fail(`Included paths overlap: ${rel}`);
        mkdirSync(dirname(to), { recursive: true });
        run(["cp", "-a", "--reflink=auto", "--", from, to]);
        ignoredIncludes.push(`/${rel.replace(/[\\*?\[\] !#]/g, "\\$&")}`);
      }
      if (sharedEnv) symlinkSync(sharedEnv, join(repo, ".env"));
      const exclude = join(repo, ".git/info/exclude");
      writeFileSync(exclude, `\n.env\n.env.*\n${ignoredIncludes.join("\n")}\n`, { flag: "a" });
      auditLinks(repo, sharedEnv);
      sourceClean(source);
      if (git(source, "rev-parse", "HEAD") !== commit) fail("Source HEAD changed during preparation; retry while idle");
      const state: Base = { kind: "base", id, source, commit };
      writeState(dir, state);
      emit({ baseline: id, commit, path: repo });
    } catch (error) {
      removeDirectory(dir);
      throw error;
    }
    return;
  }

  if (command === "create") {
    const base = readState<Base>(baseDir(required("base")), "base");
    const id = validId(required("id"));
    const dir = taskDir(id);
    const fresh = !existsSync(dir);
    if (!fresh && readState<Workspace>(dir, "workspace").base !== base.id) fail("Workspace already uses another baseline");
    const binary = flags["fuse-overlayfs"] ? resolve(flags["fuse-overlayfs"]) : Bun.which("fuse-overlayfs");
    if (!binary || !existsSync(binary)) fail("fuse-overlayfs is required; install it or pass --fuse-overlayfs PATH");
    if (!Bun.which("fusermount3") || !existsSync("/dev/fuse")) fail("fusermount3 and /dev/fuse are required");
    if (fresh) {
      mkdirSync(dir, { mode: 0o700 });
      for (const name of ["upper", "work", "merged"]) mkdirSync(join(dir, name));
      writeState(dir, { kind: "workspace", id, base: base.id });
    }
    const cwd = join(dir, "merged");
    if (!isMounted(cwd)) {
      run([binary, "-o", `lowerdir=${join(baseDir(base.id), "repo")},upperdir=${join(dir, "upper")},workdir=${join(dir, "work")}`, cwd]);
      if (!isMounted(cwd)) fail("Mount command returned without a mounted CoW view; retaining state for retry");
    }
    if (fresh) {
      const branch = `cow/${id}`;
      if (git(cwd, "branch", "--list", branch)) git(cwd, "switch", branch);
      else git(cwd, "switch", "-c", branch);
    }
    emit({ id, baseline: base.id, cwd, resumed: !fresh });
    return;
  }

  if (command === "list") {
    const baselines = readdirSync(join(root, "bases")).map((id) => readState<Base>(baseDir(id), "base"));
    const workspaces = readdirSync(join(root, "workspaces")).map((id) => ({
      ...readState<Workspace>(taskDir(id), "workspace"), mounted: isMounted(join(taskDir(id), "merged")),
    }));
    emit({ baselines, workspaces });
    return;
  }

  if (command === "remove-base") {
    const id = validId(required("id"));
    readState<Base>(baseDir(id), "base");
    for (const task of readdirSync(join(root, "workspaces"))) {
      if (readState<Workspace>(taskDir(task), "workspace").base === id) fail("Baseline is still referenced by a workspace; remove that workspace first");
    }
    removeDirectory(baseDir(id));
    emit({ removed_baseline: id });
    return;
  }

  const id = validId(required("id"));
  const dir = taskDir(id);
  const state = readState<Workspace>(dir, "workspace");
  const base = readState<Base>(baseDir(state.base), "base");
  const cwd = join(dir, "merged");
  const mounted = isMounted(cwd);
  if (command === "status") {
    emit({ ...state, cwd, mounted, head: mounted ? git(cwd, "rev-parse", "HEAD") : null,
      dirty: mounted ? Boolean(git(cwd, "status", "--porcelain", "--untracked-files=normal")) : null });
    return;
  }
  if (!mounted && !(command === "remove" && flags.discard)) fail("Workspace is not mounted; repeat create with the same IDs to resume");

  if (command === "export") {
    sourceClean(cwd);
    git(cwd, "merge-base", "--is-ancestor", base.commit, "HEAD");
    const head = git(cwd, "rev-parse", "HEAD");
    if (head === base.commit) fail("No task commits to export");
    const requested = resolve(required("output"));
    const output = join(realpathSync(dirname(requested)), basename(requested));
    if (inside(root, output)) fail("Export output must be outside the managed store");
    if (existsSync(output)) fail("Export output already exists; choose another path");
    const temp = mkdtempSync(join(dirname(output), ".cow-export-"));
    try {
      const bundle = join(temp, "task.bundle");
      git(cwd, "bundle", "create", bundle, `${base.commit}..HEAD`);
      git(cwd, "bundle", "verify", bundle);
      if (git(cwd, "rev-parse", "HEAD") !== head) fail("HEAD changed during export; stop the task and retry");
      sourceClean(cwd);
      copyFileSync(bundle, output, constants.COPYFILE_EXCL);
      state.exported = { head, path: output, sha256: digest(output) };
      writeState(dir, state);
      emit({ id, head, baseline_commit: base.commit, output });
    } finally {
      rmSync(temp, { recursive: true });
    }
    return;
  }

  if (!flags.discard) {
    sourceClean(cwd);
    const head = git(cwd, "rev-parse", "HEAD");
    if (head !== base.commit && (!state.exported || state.exported.head !== head
      || !existsSync(state.exported.path) || digest(state.exported.path) !== state.exported.sha256)) {
      fail("Workspace has commits without an intact current export; export first, or explicitly authorize --discard");
    }
    const baselineRefs = git(join(baseDir(base.id), "repo"), "for-each-ref", "--format=%(objectname)").split("\n").filter(Boolean);
    const extraRefs = git(cwd, "rev-list", "--all", "--not", base.commit, head, ...baselineRefs);
    if (extraRefs) fail("Other branches or tags contain unexported commits; preserve them before removal");
  }
  if (mounted) run(["fusermount3", "-u", cwd]);
  removeDirectory(dir);
  emit({ removed_workspace: id });
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
