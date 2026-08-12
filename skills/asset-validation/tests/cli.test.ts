import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseCli } from "../scripts/cli.ts";

const ACC = join(import.meta.dir, "..", "scripts", "acc.ts");
const temporaryPaths: string[] = [];

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  json: Record<string, unknown> | null;
}

function runCli(root: string, args: string[], extraEnv: Record<string, string> = {}): CliResult {
  const result = Bun.spawnSync({
    cmd: [process.execPath, ACC, ...args],
    env: {
      ...process.env,
      ACCEPTANCE_HOME: join(root, "state"),
      ACCEPTANCE_TMPDIR: join(root, "sandboxes"),
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString().trim();
  return {
    exitCode: result.exitCode,
    stdout,
    stderr: result.stderr.toString(),
    json: stdout ? JSON.parse(stdout) as Record<string, unknown> : null,
  };
}

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("acc CLI contract", () => {
  test("retains every legacy command and subcommand route", () => {
    const routes = [
      ["bootstrap"],
      ["asset", "add"],
      ["asset", "list"],
      ["accept", "new"],
      ["accept", "update"],
      ["accept", "list"],
      ["start"],
      ["launch"],
      ["round", "list"],
      ["show"],
      ["feed-task"],
      ["capture"],
      ["wait"],
      ["record"],
      ["finding"],
      ["finding", "add"],
      ["finding", "list"],
      ["finalize"],
      ["cleanup"],
      ["profile", "list"],
      ["profile", "run-task"],
      ["history"],
    ];
    for (const route of routes) {
      const parsed = parseCli([...route, "--help"]);
      expect("help" in parsed).toBe(true);
    }
  });

  test("accepts separate negative option values like argparse", () => {
    const capture = parseCli(["capture", "--pane", "demo", "--start", "-2000"]);
    expect("help" in capture).toBe(false);
    if (!("help" in capture)) expect(capture.options.start).toBe("-2000");
    const wait = parseCli([
      "wait", "--pane", "demo", "--idle-seconds", "-1.5", "--max-seconds", "-2",
    ]);
    expect("help" in wait).toBe(false);
    if (!("help" in wait)) {
      expect(wait.options.idleSeconds).toBe(-1.5);
      expect(wait.options.maxSeconds).toBe(-2);
    }
  });

  test("keeps bootstrap registration ordering, JSON shapes, and exit codes", () => {
    const root = mkdtempSync(join(tmpdir(), "acc-cli-"));
    temporaryPaths.push(root);
    const source = join(root, "source");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "SKILL.md"), "---\nname: demo\ndescription: demo\n---\n", "utf8");

    const missing = runCli(root, [
      "bootstrap", "--name", "demo", "--type", "skill", "--source", source,
    ]);
    expect(missing.exitCode).toBe(2);
    expect(missing.json).toEqual({ error: "missing required --goal or --goal-file" });
    expect(missing.stdout).toBe('{"error": "missing required --goal or --goal-file"}');

    const bootstrap = runCli(root, [
      "bootstrap", "--name", "demo", "--type", "skill", "--source", source,
      "--goal", "demo-goal",
    ]);
    expect(bootstrap.exitCode).toBe(0);
    expect(bootstrap.json?.asset_created).toBe(false);
    expect(bootstrap.json?.warning).toBeNull();
    expect(String(bootstrap.json?.asset_id)).toStartWith("asset_");
    expect(String(bootstrap.json?.acceptance_id)).toStartWith("acc_");

    const tasksFile = join(root, "tasks.json");
    const fixture = join(root, "fixture");
    mkdirSync(fixture, { recursive: true });
    writeFileSync(join(fixture, "input.txt"), "fixture\n", "utf8");
    writeFileSync(tasksFile, '{"emoji":"😀中"}\n', "utf8");
    const updated = runCli(root, [
      "accept", "update", "--id", String(bootstrap.json?.acceptance_id),
      "--task-prompts-file", tasksFile, "--fixture", fixture,
    ]);
    expect(updated.exitCode).toBe(0);

    const assets = runCli(root, ["asset", "list", "--name", "demo"]);
    expect(assets.exitCode).toBe(0);
    expect((assets.json?.assets as unknown[]).length).toBe(1);
    const acceptances = runCli(root, ["accept", "list", "--asset", "demo"]);
    const acceptance = (acceptances.json?.acceptances as Array<Record<string, unknown>>)[0];
    expect(acceptance?.task_prompts).toBe('{"emoji": "😀中"}');
    expect(acceptance?.fixture_path).toBe(realpathSync(fixture));

    const invalid = runCli(root, ["nope"]);
    expect(invalid.exitCode).toBe(2);
    expect(invalid.stdout).toBe("");
    expect(invalid.stderr).toContain("invalid choice: 'nope'");

    const pythonFloat = runCli(root, [
      "wait", "--pane", "unused", "--idle-seconds", "NaN", "--max-seconds", "0",
    ]);
    expect(pythonFloat.exitCode).toBe(0);
    expect(pythonFloat.json?.idle).toBe(false);
  });

  test("starts an isolated round and removes only its explicit sandbox", () => {
    const root = mkdtempSync(join(tmpdir(), "acc-start-"));
    temporaryPaths.push(root);
    const source = join(root, "source");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "SKILL.md"), "---\nname: demo\ndescription: demo\n---\n", "utf8");
    const bootstrap = runCli(root, [
      "bootstrap", "--name", "demo", "--type", "skill", "--source", source,
      "--goal", "demo-goal",
    ]);
    const acceptanceId = String(bootstrap.json?.acceptance_id);
    const started = runCli(
      root,
      ["start", "--acceptance", acceptanceId, "--mode", "stop-loss"],
      {
        ACCEPTANCE_SKIP_PREFLIGHT: "1",
        HERDR_ENV: "1",
        HERDR_PANE_ID: "w-test:p1",
        HERDR_TAB_ID: "w-test:t1",
        HERDR_WORKSPACE_ID: "w-test",
        HERDR_SOCKET_PATH: join(root, "herdr.sock"),
      },
    );
    expect(started.exitCode).toBe(0);
    expect(started.json?.preflight).toBe("ok");
    const sandbox = String(started.json?.sandbox);
    expect(sandbox).toStartWith(join(root, "sandboxes", "acc-"));
    const isolation = started.json?.isolation_env as Record<string, string>;
    expect(isolation.ACCEPTANCE_HOME).toStartWith(sandbox);
    expect(isolation.HERDR_ENV).toBe("1");
    expect(isolation.HERDR_PANE_ID).toBe("w-test:p1");
    expect(isolation.HERDR_SOCKET_PATH).toBe(join(root, "herdr.sock"));

    const cleaned = runCli(root, ["cleanup", "--sandbox", sandbox]);
    expect(cleaned.exitCode).toBe(0);
    expect(cleaned.json?.removed).toBe(sandbox);
    expect(cleaned.json?.existed).toBe(true);
  });

  test("recognizes current Claude and Codex plugin manifest locations", () => {
    const root = mkdtempSync(join(tmpdir(), "acc-plugin-shape-"));
    temporaryPaths.push(root);
    for (const host of ["claude", "codex"]) {
      const source = join(root, host);
      const manifestDir = join(source, `.${host}-plugin`);
      mkdirSync(manifestDir, { recursive: true });
      writeFileSync(
        join(manifestDir, "plugin.json"),
        JSON.stringify({ name: `demo-${host}` }),
        "utf8",
      );
      const bootstrap = runCli(root, [
        "bootstrap", "--name", `demo-${host}`, "--type", "plugin", "--source", source,
        "--goal", "demo-goal",
      ]);
      expect(bootstrap.exitCode).toBe(0);
      expect(bootstrap.json?.warning).toBeNull();
    }
  });
});
