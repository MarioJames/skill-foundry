#!/usr/bin/env bun

import { CliError, emit, parseFlags, probeWorkspace, requireHerdr, runCli } from "./lib/herdr-route";

await runCli(async () => {
  const flags = parseFlags(process.argv.slice(2), ["--cwd"], ["--help"]);
  if (flags.has("--help")) {
    process.stdout.write("Usage: probe-workspace.ts --cwd PATH\n");
    return;
  }

  requireHerdr();
  const cwd = flags.get("--cwd");
  if (typeof cwd !== "string") throw new CliError("missing_argument", "--cwd is required", 2);
  const probe = await probeWorkspace(cwd);
  emit({
    ok: true,
    target: { cwd: probe.target.cwd, git_root: probe.target.gitRoot },
    match: {
      kind: probe.match.kind,
      score: probe.match.score,
      workspace_id: probe.match.workspaceId,
    },
  });
});
