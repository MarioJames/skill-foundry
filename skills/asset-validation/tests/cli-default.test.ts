import { expect, spyOn, test } from "bun:test";
import { parseCli } from "../scripts/cli.ts";
import { preflight } from "../scripts/profiles.ts";

const routes = [
  ["start", "--acceptance", "example", "--mode", "collect-first"],
  ["launch", "--round", "example"],
  ["profile", "run-task", "--acceptance", "example", "--task", "example", "--mode", "collect-first"],
];

test("all CLI-selecting commands default to Codex and preserve explicit selection", () => {
  for (const route of routes) {
    for (const [args, expected] of [[[], "codex"], [["--cli", "codex"], "codex"], [["--cli", "claude"], "claude"]] as const) {
      const parsed = parseCli([...route, ...args]);
      if ("help" in parsed) throw new Error("Expected an executable command");
      expect(parsed.options.cli).toBe(expected);
    }
  }
});

test("default preflight retains Codex identity even if the executable is unavailable", () => {
  const which = spyOn(Bun, "which").mockImplementation((name) => name === "claude" ? "/mock/claude" : null);
  try {
    expect(preflight()).toMatchObject({ ok: false, cli: "codex" });
    expect(which.mock.calls.map(([name]) => name)).toEqual(["codex"]);
  } finally {
    which.mockRestore();
  }
});
