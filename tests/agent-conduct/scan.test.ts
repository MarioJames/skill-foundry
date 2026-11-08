import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "../../skills/agent-conduct/scripts/scan.ts");
let fixtureRoot = "";
let workspace = "";
let repo = "";
let worktree = "";
let tempRoot = "";

function git(args: string[], cwd: string): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString() || result.stdout.toString());
  return result.stdout.toString().trim();
}

function scan(args: string[], env?: Record<string, string>): { code: number; stdout: string; stderr: string } {
  // 分享登记读自 XDG_STATE_HOME，指向夹具目录，不读本机真实登记
  const result = Bun.spawnSync(["bun", script, ...args], {
    env: { ...process.env, XDG_STATE_HOME: join(fixtureRoot, "state"), ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "agent-conduct-scan-"));
  workspace = join(fixtureRoot, "workspace");
  repo = join(workspace, "app");
  worktree = join(fixtureRoot, "worktrees", "app-feat");
  tempRoot = join(fixtureRoot, "temp");
  mkdirSync(repo, { recursive: true });
  git(["init", "-q", "-b", "main"], repo);
  git(["config", "user.name", "Fixture User"], repo);
  git(["config", "user.email", "fixture@example.invalid"], repo);
  writeFileSync(join(repo, ".gitignore"), ".task-artifacts/\nnode_modules/\n");
  git(["add", ".gitignore"], repo);
  git(["commit", "-q", "-m", "initial"], repo);
  git(["branch", "merged-feature"], repo);
  git(["worktree", "add", "-q", "-b", "feat", worktree], repo);
  writeFileSync(join(repo, "REPORT.html"), "<p>report</p>\n");
  mkdirSync(join(repo, ".task-artifacts", "run-1"), { recursive: true });
  mkdirSync(join(repo, "node_modules"), { recursive: true });
  mkdirSync(join(workspace, "reports"), { recursive: true });
  mkdirSync(join(workspace, "node_modules"), { recursive: true });
  mkdirSync(join(tempRoot, "ami-runtime-jobs-Ab12Cd"), { recursive: true });
  mkdirSync(join(tempRoot, "ami-runtime-jobs-akstdp"), { recursive: true });
  mkdirSync(join(tempRoot, "AQuCzRXFGztCppOvcVqMK"), { recursive: true });
  mkdirSync(join(tempRoot, "titu-sandbox-claims-fix-1023"), { recursive: true });
});

afterAll(() => {
  if (repo) Bun.spawnSync(["git", "-C", repo, "worktree", "remove", "--force", worktree]);
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("scan", () => {
  test("reports leftovers in repositories, the workspace root and temporary roots", () => {
    const result = scan(["--json", "--no-docker", "--since", "10m", "--workspace", workspace, "--temp-root", tempRoot]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout);

    const repoReport = report.repositories.find((entry: { path: string }) => entry.path === repo);
    expect(repoReport.defaultRef).toBe("main");
    expect(repoReport.untracked).toEqual(["REPORT.html"]);
    expect(repoReport.ignoredArtifacts).toEqual([".task-artifacts/"]);
    expect(repoReport.mergedBranches).toEqual(["feat", "merged-feature"]);
    expect(repoReport.worktrees).toEqual([
      { path: worktree, branch: "feat", prunable: false, merged: true, insideRepository: false },
    ]);

    expect(report.workspaceStrays).toEqual([{ workspace, entries: ["node_modules"] }]);
    expect(report.temporary.map((group: { pattern: string; count: number }) => [group.pattern, group.count])).toEqual([
      ["ami-runtime-jobs-*", 2],
      ["<随机名>", 1],
      ["titu-sandbox-claims-fix-1023", 1],
    ]);
    expect(report.docker).toBeNull();
  });

  test("marks a worktree whose directory is gone as prunable", () => {
    const gone = join(fixtureRoot, "worktrees", "gone");
    git(["worktree", "add", "-q", "--detach", gone], repo);
    rmSync(gone, { recursive: true, force: true });
    const report = JSON.parse(scan(["--json", "--no-docker", "--workspace", workspace, "--temp-root", tempRoot]).stdout);
    const repoReport = report.repositories.find((entry: { path: string }) => entry.path === repo);
    expect(repoReport.worktrees).toContainEqual(
      expect.objectContaining({ path: gone, branch: null, prunable: true }),
    );
    git(["worktree", "prune"], repo);
  });

  test("excludes temporary entries created before the window", () => {
    const report = JSON.parse(
      scan(["--json", "--no-docker", "--since", new Date(Date.now() + 60_000).toISOString(), "--temp-root", tempRoot]).stdout,
    );
    expect(report.temporary).toEqual([]);
  });

  test("rejects an unparseable window", () => {
    const result = scan(["--since", "yesterday-ish", "--no-docker"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--since");
  });

  test("lists labelled containers outside the window with their release condition", () => {
    const bin = join(fixtureRoot, "fake-docker-bin");
    mkdirSync(bin, { recursive: true });
    const created = (daysAgo: number) =>
      new Date(Date.now() - daysAgo * 86_400_000).toISOString().replace("T", " ").replace(/\.\d+Z$/u, " +0000 UTC");
    const rows = [
      ["bench-pg", "postgres:18", created(3), "bench-task", "report-delivered", "Up 3 days"],
      ["old-unlabelled", "redis:8", created(3), "", "", "Exited (0) 3 days ago"],
    ].map((row) => row.join("\t"));
    writeFileSync(
      join(bin, "docker"),
      `#!/bin/sh\nif [ "$1" = ps ]; then printf '%s\\n' ${rows.map((row) => `'${row}'`).join(" ")}; fi\n`,
      { mode: 0o755 },
    );
    const env = { PATH: `${bin}:${process.env.PATH}` };

    const report = JSON.parse(scan(["--json", "--since", "1h"], env).stdout);
    expect(report.docker.labelled).toEqual([
      { name: "bench-pg", image: "postgres:18", created: expect.any(String), owner: "bench-task", releaseWhen: "report-delivered", status: "Up 3 days" },
    ]);
    expect(report.docker.stoppedContainers).toEqual([]);

    const text = scan(["--since", "1h"], env).stdout;
    expect(text).toContain("bench-pg");
    expect(text).toContain("release-when=report-delivered");
  });

  test("lists registered R2 share objects that were not deleted, grouped by page", () => {
    const ledgerDir = join(fixtureRoot, "state", "r2-share");
    mkdirSync(ledgerDir, { recursive: true });
    const base = { account: "acc", bucket: "b", md5: "m", size: 1, contentType: "text/html", source: "/src" };
    const upload = (task: string, key: string, entry: string) => ({
      op: "upload", at: "2026-11-08T00:00:00.000Z", task, releaseWhen: "report-delivered", key, entry, url: `https://share.example/${key}`, ...base,
    });
    const lines = [
      upload("orders", "d/orders/evidence/a.png", "d/orders/reports/REPORT.html"),
      upload("orders", "d/orders/reports/REPORT.html", "d/orders/reports/REPORT.html"),
      upload("probe", "d/probe.html", "d/probe.html"),
      { op: "delete", at: "2026-11-08T00:01:00.000Z", task: "probe", account: "acc", bucket: "b", key: "d/probe.html", result: "deleted" },
    ];
    writeFileSync(join(ledgerDir, "ledger.jsonl"), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");

    const report = JSON.parse(scan(["--json", "--no-docker", "--temp-root", tempRoot]).stdout);
    expect(report.shares.objects.map((object: { key: string }) => object.key).sort()).toEqual([
      "d/orders/evidence/a.png",
      "d/orders/reports/REPORT.html",
    ]);

    const text = scan(["--no-docker", "--temp-root", tempRoot]).stdout;
    expect(text).toContain("task=orders release-when=report-delivered");
    expect(text).toContain("共 2 个对象");
    expect(text).toContain("https://share.example/d/orders/reports/REPORT.html");
    expect(text).not.toContain("probe");
    rmSync(join(fixtureRoot, "state"), { recursive: true, force: true });
  });
});
