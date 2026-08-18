import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
    expect(result.mode).toBe("git-only");
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

describe("dispatch entrypoint", () => {
  test("uses git-only dry-run without release metadata when no workflow exists", () => {
    const repo = createRepo();
    writeFileSync(join(repo, "tracked.txt"), "changed\n");
    const result = command([script, "--repo", repo, "--dry-run", "--message", "fix: update tracked file"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("workflow_mode=git-only");
    expect(result.stdout).toContain("dry-run: git add -A");
    expect(result.stdout).toContain("dry-run: git commit");
    expect(result.stdout).toContain("dry-run: git push");
    expect(result.stdout).toContain("dispatch=skipped");
    expect(result.stdout).not.toContain("beta dispatch requires");
  });

  test("commits and pushes to a local remote in git-only mode", () => {
    const repo = createRepo();
    const remote = mkdtempSync(join(tmpdir(), "trigger-build-workflow-remote-"));
    temporaryDirectories.push(remote);
    git(["init", "-q", "--bare"], remote);
    git(["remote", "add", "origin", remote], repo);
    writeFileSync(join(repo, "unrelated-staged.txt"), "baseline\n");
    git(["add", "unrelated-staged.txt"], repo);
    git(["commit", "-q", "-m", "add unrelated baseline"], repo);
    writeFileSync(join(repo, "unrelated-staged.txt"), "must remain staged\n");
    git(["add", "unrelated-staged.txt"], repo);
    writeFileSync(join(repo, "tracked.txt"), "submitted\n");

    const result = command([
      script,
      "--repo",
      repo,
      "--message",
      "fix: submit without release workflow",
      "--path",
      "tracked.txt",
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("workflow_mode=git-only");
    expect(result.stdout).toContain("dispatch=skipped");

    const branch = git(["branch", "--show-current"], repo);
    const localHead = git(["rev-parse", "HEAD"], repo);
    const remoteHead = git(["--git-dir", remote, "rev-parse", `refs/heads/${branch}`], repo);
    expect(remoteHead).toBe(localHead);
    expect(git(["diff", "--cached", "--name-only"], repo)).toBe("unrelated-staged.txt");
    expect(git(["show", "--format=", "--name-only", "HEAD"], repo)).toBe("tracked.txt");
    expect(git(["--git-dir", remote, "show", `${branch}:unrelated-staged.txt`], repo)).toBe("baseline");
  });

  test("ignores release-only options for an incompatible workflow", () => {
    const repo = createRepo();
    writeWorkflow(repo, "checks.yml", "on:\n  workflow_dispatch:\n\njobs: {}\n");
    const result = command([script, "--repo", repo, "--dry-run", "--version", "not-semver"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("workflow_mode=git-only");
    expect(result.stdout).toContain("release options ignored");
  });

  test("requires changelog only for a compatible workflow", () => {
    const repo = createRepo();
    writeWorkflow(repo, "release.yml", compatibleWorkflow);
    const result = command([script, "--repo", repo, "--dry-run"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("beta dispatch requires changelog content");
  });

  test("maps compatible inputs during a dispatch dry-run", () => {
    const repo = createRepo();
    writeWorkflow(repo, "release.yml", compatibleWorkflow);
    const result = command([
      script,
      "--repo",
      repo,
      "--dry-run",
      "--version",
      "1.2.3",
      "--changelog-json",
      JSON.stringify({
        changelog: "Version 1.2.3, improves release safety.\n\n- Adds workflow capability detection.",
        changelog_summary: "Version 1.2.3, improves release safety.",
        changelog_content: "- Adds workflow capability detection.",
      }),
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("workflow_mode=dispatch");
    expect(result.stdout).toContain("environment=production");
    expect(result.stdout).toContain("version=1.2.3");
    expect(result.stdout).toContain("changelog_content=");
    expect(result.stdout).toContain("changelog_summary=");
  });
});
