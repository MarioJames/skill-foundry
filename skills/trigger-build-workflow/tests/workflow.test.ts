import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, chmodSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { detectBuildWorkflow, inspectWorkflowText } from "../scripts/lib/workflow";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "../scripts/dispatch-build-workflow.ts");
const temporaryDirectories: string[] = [];

function command(args: string[], cwd?: string): { code: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function git(args: string[], cwd: string): string {
  const result = command(["git", ...args], cwd);
  if (result.code !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

function createRepo(): string {
  const directory = mkdtempSync(join(tmpdir(), "trigger-build-workflow-"));
  temporaryDirectories.push(directory);
  git(["init", "-q"], directory);
  git(["config", "user.name", "Fixture User"], directory);
  git(["config", "user.email", "fixture@example.invalid"], directory);
  writeFileSync(join(directory, "tracked.txt"), "initial\n");
  git(["add", "tracked.txt"], directory);
  git(["commit", "-q", "-m", "initial"], directory);
  return directory;
}

function writeWorkflow(repo: string, name: string, content: string): void {
  const directory = join(repo, ".github", "workflows");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, name), content);
}

const compatibleWorkflow = `name: Build
'on':
  workflow_dispatch:
    inputs:
      environment:
        required: true
      version:
        required: false
      changelog_content:
        required: true
      changelog_summary:
        required: true
jobs:
  build:
    runs-on: ubuntu-latest
    steps: []
`;

afterEach(() => {
  while (temporaryDirectories.length > 0) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

describe("workflow capability detection", () => {
  test("extracts dispatch inputs from quoted on keys", () => {
    const capabilities = inspectWorkflowText(compatibleWorkflow);
    expect(capabilities.workflowDispatch).toBe(true);
    expect(capabilities.channelInput).toBe("environment");
    expect(capabilities.versionInput).toBe("version");
    expect(capabilities.changelogInput).toBe("changelog_content");
    expect(capabilities.changelogSummaryInput).toBe("changelog_summary");
  });

  test("treats an ordinary workflow as incompatible", () => {
    const repo = createRepo();
    writeWorkflow(repo, "checks.yml", "on: [push]\njobs: {}\n");
    const result = detectBuildWorkflow(repo);
    expect(result.compatible).toBe(false);
    expect(result.reason).toBe("no-compatible-workflow");
    expect(result.candidates[0].missing).toContain("workflow_dispatch");
  });

  test("selects one compatible workflow and rejects ambiguous matches", () => {
    const repo = createRepo();
    writeWorkflow(repo, "release.yml", compatibleWorkflow);
    expect(detectBuildWorkflow(repo).workflow?.name).toBe("release.yml");
    writeWorkflow(repo, "publish.yml", compatibleWorkflow);
    expect(detectBuildWorkflow(repo).reason).toBe("multiple-compatible-workflows");
    writeWorkflow(repo, "package-orchestrator.yml", compatibleWorkflow);
    expect(detectBuildWorkflow(repo).workflow?.name).toBe("package-orchestrator.yml");
  });
});

// Git mutations stay inside fixtures. Network-facing git commands and every gh call
// are intercepted; no installed gh executable or external account is used.
const realGit = command(["which", "git"]).stdout.trim();
const changelog = JSON.stringify({
  changelog: "Release notes\n\n- Fix configuration",
  changelog_summary: "Fix configuration",
  changelog_content: "- Fix configuration",
});

function fixture(workflow = true) {
  const repo = createRepo();
  if (workflow) {
    writeWorkflow(repo, "release.yml", compatibleWorkflow);
    git(["add", ".github"], repo);
    git(["commit", "-qm", "workflow"], repo);
  }
  git(["remote", "add", "origin", "https://github.com/fixture/origin.git"], repo);
  git(["remote", "add", "release", "git@github.com:fixture/release.git"], repo);
  const bin = join(repo, ".stub-bin");
  mkdirSync(bin);
  // Keep fixture harness out of the default commit scope.
  writeFileSync(join(repo, ".git", "info", "exclude"), ".stub-bin/\n.calls\n");
  const log = join(repo, ".calls");
  writeFileSync(log, "");
  const stub = `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const tool = process.argv[1].endsWith('/gh') ? 'gh' : 'git';
appendFileSync(process.env.CALL_LOG, JSON.stringify([tool, ...args]) + '\\n');
if (tool === 'git') {
  if (args[0] === 'push') process.exit(process.env.FAIL_PUSH ? 1 : 0);
  if (args[0] === 'ls-remote') {
    if (!process.env.MISSING_REF) console.log(process.env.REMOTE_SHA + '\\t' + args.at(-1));
    process.exit(0);
  }
  if (['fetch', 'pull', 'clone'].includes(args[0])) throw new Error('unexpected network git');
  const result = Bun.spawnSync([process.env.REAL_GIT, ...args], {stdout:'inherit', stderr:'inherit'});
  process.exit(result.exitCode);
}
if (args.includes('auth') && process.env.FAIL_AUTH) process.exit(1);
if (args.includes('list')) {
  if (args.includes('--jq')) console.log('10');
  else {
    const sha = readFileSync(process.env.CALL_LOG, 'utf8').includes('["git","push"') ? Bun.spawnSync([process.env.REAL_GIT,'rev-parse','HEAD']).stdout.toString().trim() : process.env.REMOTE_SHA;
    console.log(JSON.stringify([{databaseId:readFileSync(process.env.CALL_LOG, 'utf8').includes('\"workflow\",\"run\"') ? 11 : 10,headSha:sha,event:'workflow_dispatch'}]));
  }
}
if (args.includes('watch') && process.env.FAIL_WATCH) process.exit(1);
if (args.includes('view')) console.log(args.includes('status,conclusion,url') ? 'status=completed\\nconclusion=' + (process.env.FAIL_WATCH ? 'failure' : 'success') : 'https://github.com/fixture/release/actions/runs/11');
`;
  for (const name of ["git", "gh"]) {
    writeFileSync(join(bin, name), stub);
    chmodSync(join(bin, name), 0o755);
  }
  const head = git(["rev-parse", "HEAD"], repo);
  return {
    repo, head,
    run(args: string[], extraEnv: Record<string, string> = {}) {
      const result = Bun.spawnSync([process.execPath, script, "--repo", repo, ...args], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, REAL_GIT: realGit, CALL_LOG: log, REMOTE_SHA: head, ...extraEnv },
        stdout: "pipe", stderr: "pipe",
      });
      return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
    },
    calls() { return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as string[]); },
  };
}

function mutations(f: ReturnType<typeof fixture>) {
  return f.calls().filter(c => c[0] === "gh" ? c.includes("run") && c.includes("workflow") : ["add", "commit", "push"].includes(c[1]) && !c.includes("--dry-run"));
}

describe("explicit operation authorization", () => {
  test("no action fails without staging or external calls", () => {
    const f = fixture(false);
    writeFileSync(join(f.repo, "tracked.txt"), "changed\n");
    const result = f.run([]);
    expect(mutations(f)).toEqual([]);
    expect(result.code).toBe(1);
    expect(git(["rev-parse", "HEAD"], f.repo)).toBe(f.head);
  });

  test("commit alone ignores compatible workflow and preserves unrelated staged changes", () => {
    const f = fixture();
    writeFileSync(join(f.repo, "unrelated.txt"), "keep staged\n");
    git(["add", "unrelated.txt"], f.repo);
    writeFileSync(join(f.repo, "tracked.txt"), "submitted\n");
    const result = f.run(["--commit", "--path", "tracked.txt", "--message", "fix: scoped"]);
    expect(result.code).toBe(0);
    expect(git(["show", "--format=", "--name-only", "HEAD"], f.repo)).toBe("tracked.txt");
    expect(git(["diff", "--cached", "--name-only"], f.repo)).toBe("unrelated.txt");
    expect(f.calls().some(c => c[0] === "gh" || c[1] === "push")).toBe(false);
  });

  test("push alone does not commit or dispatch despite compatible workflow", () => {
    const f = fixture();
    writeFileSync(join(f.repo, "tracked.txt"), "do not stage\n");
    expect(f.run(["--push"]).code).toBe(0);
    expect(mutations(f)).toEqual([["git", "push", "origin", "HEAD:refs/heads/" + git(["branch", "--show-current"], f.repo)]]);
    expect(git(["rev-parse", "HEAD"], f.repo)).toBe(f.head);
    expect(git(["diff", "--cached", "--name-only"], f.repo)).toBe("");
    expect(f.calls().some(c => c[0] === "gh")).toBe(false);
  });

  test("explicit remote and destination branch override existing upstream", () => {
    const f = fixture(false);
    const branch = git(["branch", "--show-current"], f.repo);
    git(["update-ref", `refs/remotes/origin/${branch}`, f.head], f.repo);
    git(["branch", "--set-upstream-to", `origin/${branch}`], f.repo);
    expect(f.run(["--push", "--remote", "release", "--branch", "candidate"]).code).toBe(0);
    expect(mutations(f)).toEqual([["git", "push", "release", "HEAD:refs/heads/candidate"]]);
  });

  test("commit and push can be combined without a workflow", () => {
    const f = fixture(false);
    writeFileSync(join(f.repo, "tracked.txt"), "submitted\n");
    expect(f.run(["--commit", "--push", "--path", "tracked.txt"]).code).toBe(0);
    expect(git(["rev-parse", "HEAD"], f.repo)).not.toBe(f.head);
    expect(mutations(f).map(c => c[1])).toEqual(["add", "commit", "push"]);
  });

  test.each(["missing", "ambiguous"])("explicit dispatch with %s workflow fails before commit or push", kind => {
    const f = fixture(kind !== "missing");
    if (kind === "ambiguous") writeWorkflow(f.repo, "another.yml", compatibleWorkflow);
    writeFileSync(join(f.repo, "tracked.txt"), "changed\n");
    const result = f.run(["--commit", "--push", "--dispatch", "--changelog-json", changelog]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("compatible workflow");
    expect(mutations(f)).toEqual([]);
  });

  test.each([
    { args: ["--environment", "production"] },
    { args: ["--environment", "invalid"] },
    { args: ["--changelog-json", "{"] },
    { args: [] },
  ])("invalid dispatch metadata fails before mutations: %j", ({ args: metadata }) => {
    const f = fixture();
    expect(f.run(["--commit", "--push", "--dispatch", ...metadata]).code).toBe(1);
    expect(mutations(f)).toEqual([]);
  });

  test("invalid remote fails before committing", () => {
    const f = fixture(false);
    writeFileSync(join(f.repo, "tracked.txt"), "changed\n");
    expect(f.run(["--commit", "--push", "--remote", "missing"]).code).toBe(1);
    expect(mutations(f)).toEqual([]);
  });

  test("dispatch-only uses requested remote branch SHA without staging or pushing", () => {
    const f = fixture();
    const result = f.run(["--dispatch", "--remote", "release", "--branch", "candidate", "--changelog-json", changelog, "--no-watch"], {REMOTE_SHA: "a".repeat(40)});
    expect(result.code).toBe(0);
    const dispatched = mutations(f);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toContain("fixture/release");
    expect(dispatched[0]).toContain("candidate");
    expect(dispatched[0]).toContain("environment=beta");
    expect(dispatched[0]).toContain("changelog_content=- Fix configuration");
    expect(dispatched[0]).toContain("changelog_summary=Fix configuration");
    expect(dispatched[0].some(a => a.startsWith("version="))).toBe(false);
    expect(result.stdout).toContain("watch=skipped");
    expect(git(["rev-parse", "HEAD"], f.repo)).toBe(f.head);
  });

  test("dispatch-only missing remote ref fails before commit", () => {
    const f = fixture();
    expect(f.run(["--commit", "--dispatch", "--changelog-json", changelog], {MISSING_REF: "1"}).code).toBe(1);
    expect(mutations(f)).toEqual([]);
  });

  test("dry-run prints only selected actions without auth or mutations", () => {
    const f = fixture();
    writeFileSync(join(f.repo, "tracked.txt"), "changed\n");
    const result = f.run(["--dispatch", "--dry-run", "--version", "v1.2.3", "--changelog-json", changelog]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("environment=production");
    expect(result.stdout).toContain("version=v1.2.3");
    expect(result.stdout).not.toContain("git push");
    expect(result.stdout).not.toContain("git add");
    expect(mutations(f)).toEqual([]);
    expect(f.calls().some(c => c[0] === "gh" || c[1] === "ls-remote")).toBe(false);
  });

  test("all actions dispatch committed HEAD and report watch success", () => {
    const f = fixture();
    writeFileSync(join(f.repo, "tracked.txt"), "changed\n");
    const result = f.run(["--commit", "--push", "--dispatch", "--path", "tracked.txt", "--version", "1.2.3", "--changelog-json", changelog], {PUSH_EXPECTED: "1"});
    expect(result.code).toBe(0);
    expect(mutations(f).map(c => c[1])).toEqual(["add", "commit", "push", "workflow"]);
    expect(result.stdout).toContain("conclusion=success");
    expect(result.stdout).toContain("run_url=https://");
  });

  test("push failure prevents dispatch", () => {
    const f = fixture();
    expect(f.run(["--push", "--dispatch", "--changelog-json", changelog], {FAIL_PUSH: "1"}).code).toBe(1);
    expect(mutations(f).map(c => c[1])).toEqual(["push"]);
  });

  test("authentication failure prevents commit and push", () => {
    const f = fixture();
    expect(f.run(["--commit", "--push", "--dispatch", "--changelog-json", changelog], {FAIL_AUTH: "1"}).code).toBe(1);
    expect(mutations(f)).toEqual([]);
  });

  test("watch failure returns nonzero and reports conclusion", () => {
    const f = fixture();
    const result = f.run(["--dispatch", "--changelog-json", changelog], {FAIL_WATCH: "1"});
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("conclusion=failure");
  });
});

describe("adjacent preflight boundaries", () => {
  test("automatic detection rejects a workflow symlink outside its directory", () => {
    const f = fixture(false);
    writeFileSync(join(f.repo, "outside.yml"), compatibleWorkflow);
    mkdirSync(join(f.repo, ".github/workflows"), { recursive: true });
    symlinkSync("../../outside.yml", join(f.repo, ".github/workflows/release.yml"));
    expect(detectBuildWorkflow(f.repo).compatible).toBe(false);
  });

  test("commit works without any remote configured", () => {
    const f = fixture();
    git(["remote", "remove", "origin"], f.repo);
    git(["remote", "remove", "release"], f.repo);
    writeFileSync(join(f.repo, "new.txt"), "local only\n");
    expect(f.run(["--commit", "--path", "new.txt"]).code).toBe(0);
    expect(git(["show", "HEAD:new.txt"], f.repo)).toBe("local only");
  });

  test("invalid path leaves previously unstaged selected files untouched", () => {
    const f = fixture(false);
    writeFileSync(join(f.repo, "tracked.txt"), "changed\n");
    expect(f.run(["--commit", "--path", "tracked.txt", "--path", "missing.txt"]).code).toBe(1);
    expect(git(["diff", "--cached", "--name-only"], f.repo)).toBe("");
    expect(mutations(f)).toEqual([]);
  });

  test("restaging content restored to HEAD succeeds without an empty commit", () => {
    const f = fixture(false);
    writeFileSync(join(f.repo, "tracked.txt"), "staged\n");
    git(["add", "tracked.txt"], f.repo);
    writeFileSync(join(f.repo, "tracked.txt"), "initial\n");
    expect(f.run(["--commit", "--path", "tracked.txt"]).code).toBe(0);
    expect(git(["rev-parse", "HEAD"], f.repo)).toBe(f.head);
    expect(git(["diff", "--cached", "--name-only"], f.repo)).toBe("");
  });

  test("workflow outside .github/workflows is not a dispatch candidate", () => {
    const f = fixture(false);
    writeFileSync(join(f.repo, "outside.yml"), compatibleWorkflow);
    const result = f.run(["--commit", "--push", "--dispatch", "--workflow", "outside.yml", "--changelog-json", changelog]);
    expect(result.code).toBe(1);
    expect(mutations(f)).toEqual([]);
  });

  test("commit dry-run preserves index and prints no push or dispatch", () => {
    const f = fixture();
    writeFileSync(join(f.repo, "tracked.txt"), "changed\n");
    const result = f.run(["--commit", "--dry-run", "--path", "tracked.txt"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("dry-run: git commit");
    expect(result.stdout).not.toContain("dry-run: git push");
    expect(f.calls().some(c => c[0] === "gh")).toBe(false);
    expect(mutations(f)).toEqual([]);
    expect(git(["diff", "--cached", "--name-only"], f.repo)).toBe("");
  });

  test("release metadata cannot silently expand a push into dispatch", () => {
    const f = fixture();
    expect(f.run(["--push", "--version", "1.2.3"]).code).toBe(1);
    expect(mutations(f)).toEqual([]);
  });

  test("explicit beta omits a supplied semver version", () => {
    const f = fixture();
    const result = f.run(["--dispatch", "--dry-run", "--environment", "beta", "--version", "1.2.3", "--changelog-json", changelog]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("environment=beta");
    expect(result.stdout).not.toContain("version=1.2.3");
  });
});
