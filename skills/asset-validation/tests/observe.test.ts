import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as catalog from "../scripts/catalog.ts";
import * as db from "../scripts/db.ts";
import * as observe from "../scripts/observe.ts";
import type { Runner } from "../scripts/process.ts";

const temporaryPaths: string[] = [];

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("tmux task transport", () => {
  test("uses one bracketed paste and explicit Enter pulses for multiline tasks", () => {
    const root = mkdtempSync(join(tmpdir(), "acc-observe-"));
    temporaryPaths.push(root);
    const previous = process.env.ACCEPTANCE_HOME;
    process.env.ACCEPTANCE_HOME = join(root, "state");
    let connection: db.Connection | undefined;
    try {
      connection = db.connect();
      const assetId = catalog.addAsset(connection, "demo", "skill", root);
      const taskBody = "line one\nline two\nline three";
      const acceptanceId = catalog.newAcceptance(connection, assetId, "goal", {
        taskPrompts: { t1: taskBody },
      });
      const commands: string[][] = [];
      const runner: Runner = (command) => {
        commands.push([...command]);
        return { stdout: "", stderr: "", exitCode: 0 };
      };
      const body = observe.feedTask(connection, acceptanceId, "t1", "acc-demo:0.0", {
        runner,
        readyTimeout: 0,
        submitDelay: 0,
        submitAttempts: 4,
        resubmitDelay: 0,
        pasteAttempts: 1,
        pasteRetryDelay: 0,
      });
      expect(body).toBe(taskBody);
      const setBuffer = commands.find((command) => command[1] === "set-buffer");
      expect(setBuffer?.at(-1)).toBe(taskBody);
      const pasteBuffer = commands.find((command) => command[1] === "paste-buffer");
      expect(pasteBuffer).toContain("-p");
      expect(pasteBuffer).toContain("-d");
      expect(commands.filter((command) => command.at(-1) === "Enter")).toHaveLength(4);
      expect(commands.flat()).not.toContain("kill-server");

      const parallelCommands: string[][] = [];
      observe.feedTask(connection, acceptanceId, "t1", "acc-demo:0.1", {
        runner: (command) => {
          parallelCommands.push([...command]);
          return { stdout: "", stderr: "", exitCode: 0 };
        },
        readyTimeout: 0,
        submitDelay: 0,
        submitAttempts: 1,
        pasteAttempts: 1,
      });
      const parallelBuffer = parallelCommands.find((command) => command[1] === "set-buffer");
      expect(parallelBuffer?.[3]).not.toBe(setBuffer?.[3]);
    } finally {
      connection?.close();
      if (previous === undefined) delete process.env.ACCEPTANCE_HOME;
      else process.env.ACCEPTANCE_HOME = previous;
    }
  });
});

describe("sandbox-local skill staging", () => {
  test("stages and removes only the generated session plugin", () => {
    const root = mkdtempSync(join(tmpdir(), "acc-plugin-"));
    temporaryPaths.push(root);
    const source = join(root, "source");
    const sandbox = join(root, "sandbox");
    mkdirSync(source, { recursive: true });
    writeFileSync(
      join(source, "SKILL.md"),
      "---\nname: staged-demo\ndescription: demo\n---\n",
      "utf8",
    );
    const installed = observe.installSkillSource(sandbox, source);
    expect(installed.installed).toBe(true);
    expect(installed.plugin_dir).toStartWith(sandbox);
    expect(installed.cli_args).toContain("--bare");
    expect(installed.cli_args).toContain("--plugin-dir");
    const pluginManifest = join(
      String(installed.plugin_dir),
      ".claude-plugin",
      "plugin.json",
    );
    expect(existsSync(pluginManifest)).toBe(true);
    expect(JSON.parse(readFileSync(pluginManifest, "utf8"))).toEqual({
      name: "acc-skill-staged-demo",
      version: "1.0.0",
      description: "Acceptance-isolated staging plugin for acc-skill-staged-demo.",
      author: { name: "asset-validation" },
    });
    expect(existsSync(join(String(installed.plugin_dir), "plugin.json"))).toBe(false);
    const cleaned = observe.cleanupPluginInstall(sandbox);
    expect(cleaned?.removed_plugin_dir).toBe(true);
    expect(cleaned?.plugin_dir).toBe(installed.plugin_dir);
  });
});
