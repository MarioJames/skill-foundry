#!/usr/bin/env bun

import { resolve } from "node:path";
import { detectBuildWorkflow } from "./lib/workflow";

function usage(): void {
  console.log(`Usage:
  detect-build-workflow.ts [--repo <path>] [--workflow <file>] [--compact]

Detect whether a repository has one unambiguous GitHub Actions workflow that
supports workflow_dispatch plus channel, version, and changelog inputs.
Incompatible or missing workflows are a successful git-only result.`);
}

let repo = ".";
let workflow: string | undefined;
let compact = false;

for (let index = 0; index < process.argv.slice(2).length; index += 1) {
  const args = process.argv.slice(2);
  const argument = args[index];
  const next = () => {
    const value = args[index + 1];
    if (!value) throw new Error(`${argument} requires a value`);
    index += 1;
    return value;
  };

  if (argument === "--repo") repo = next();
  else if (argument === "--workflow") workflow = next();
  else if (argument === "--compact") compact = true;
  else if (argument === "-h" || argument === "--help") {
    usage();
    process.exit(0);
  } else {
    throw new Error(`unknown argument: ${argument}`);
  }
}

try {
  const rootResult = Bun.spawnSync(["git", "-C", repo, "rev-parse", "--show-toplevel"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (rootResult.exitCode !== 0) throw new Error(`not a git repository: ${resolve(repo)}`);

  const repoRoot = rootResult.stdout.toString().trim();
  const detection = detectBuildWorkflow(repoRoot, workflow);
  console.log(JSON.stringify(detection, null, compact ? 0 : 2));
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
