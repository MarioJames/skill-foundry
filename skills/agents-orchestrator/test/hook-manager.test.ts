import { describe, expect, test } from "bun:test";

import { runtimeHookCommand } from "../scripts/hook_manager.ts";

describe("hook runtime command", () => {
  test("persists the active Bun executable instead of relying on PATH", () => {
    const quotedRuntime = `'${process.execPath.replaceAll("'", `'\\''`)}'`;
    const runtimeHome = "${AGENTS_ORCHESTRATOR_HOME:-$HOME/.agents-orchestrator}";
    const command = runtimeHookCommand("finish_gate.ts");

    expect(command).toBe(`${quotedRuntime} "${runtimeHome}/hooks/finish_gate.ts"`);
    expect(command.startsWith("bun ")).toBe(false);
  });
});
