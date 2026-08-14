import { describe, expect, spyOn, test } from "bun:test";

import * as observe from "../scripts/observe.ts";
import * as profiles from "../scripts/profiles.ts";
import type { PluginInstall } from "../scripts/plugin-runtime.ts";
import type { LaunchTarget } from "../scripts/rounds.ts";

describe("host-specific skill staging", () => {
  test("launches Codex with repository skill staging instead of add-dir", () => {
    const row = {
      id: "round_test",
      round_tag: "1-test",
      sandbox_path: "/sandbox",
      asset_name: "herdr",
      asset_type: "skill",
      asset_source: "/source/herdr",
    } as LaunchTarget;
    const installed: PluginInstall = {
      installed: true,
      skill_dir: "/sandbox/.agents/skills/herdr",
      cli_args: [
        "-c",
        'skills.config=[{path="/source/herdr/SKILL.md",enabled=false}]',
      ],
    };
    const install = spyOn(observe, "installCodexSkillSource").mockImplementation(
      () => installed,
    );
    const launch = spyOn(observe, "launchRound").mockImplementation(
      () => ({ session: "acc-1-test", pane: "acc-1-test:0.0", existing: false }),
    );

    try {
      const result = profiles.launchRoundForTarget(row, "/usr/local/bin/codex");
      expect(install).toHaveBeenCalledWith(
        "/sandbox",
        "/source/herdr",
        { name: "herdr" },
      );
      expect(launch).toHaveBeenCalledWith(
        "1-test",
        "/sandbox",
        "/usr/local/bin/codex",
        installed.cli_args,
      );
      expect(result.plugin_install).toBe(installed);
      expect(result.cli_args).not.toContain("--add-dir");
    } finally {
      install.mockRestore();
      launch.mockRestore();
    }
  });
});
