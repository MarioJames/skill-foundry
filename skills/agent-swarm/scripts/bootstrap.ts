#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CANONICAL_PREFIX = "AGENTS_ORCHESTRATOR_";
const LEGACY_PREFIX = "AGENT_SWARM_";
const IDENTITY_SUFFIXES = ["ROOT_ID", "TASK_ID", "ATTEMPT_ID", "ACTOR_TOKEN"];
const canonicalBootstrap = resolve(
  dirname(fileURLToPath(import.meta.url)), "..", "..", "agents-orchestrator", "scripts", "bootstrap.ts",
);

function fail(message: string): never {
  process.stderr.write(`agent-swarm: ${message}\n`);
  process.exit(2);
}

if (!existsSync(canonicalBootstrap)) {
  fail("compatibility alias requires the sibling agents-orchestrator skill");
}

const suffixes = new Set<string>();
for (const key of Object.keys(process.env)) {
  if (key.startsWith(CANONICAL_PREFIX)) suffixes.add(key.slice(CANONICAL_PREFIX.length));
  if (key.startsWith(LEGACY_PREFIX)) suffixes.add(key.slice(LEGACY_PREFIX.length));
}
for (const suffix of suffixes) {
  const canonical = process.env[`${CANONICAL_PREFIX}${suffix}`]?.trim();
  const legacy = process.env[`${LEGACY_PREFIX}${suffix}`]?.trim();
  if (canonical && legacy && canonical !== legacy) {
    fail(`conflicting orchestration environment: ${CANONICAL_PREFIX}${suffix} does not match ${LEGACY_PREFIX}${suffix}`);
  }
}

const hasIdentity = IDENTITY_SUFFIXES.some((suffix) =>
  Boolean(process.env[`${CANONICAL_PREFIX}${suffix}`] || process.env[`${LEGACY_PREFIX}${suffix}`]),
);
if (process.argv[2] === "init" && hasIdentity) {
  fail("refuses init with an injected orchestration identity; use the existing canonical Run");
}

if (process.argv[2] === "init") {
  const canonicalMode = process.env.AGENTS_ORCHESTRATOR_MODE?.trim();
  const legacyMode = process.env.AGENT_SWARM_MODE?.trim();
  const mode = canonicalMode || legacyMode || "swarm";
  process.env.AGENTS_ORCHESTRATOR_MODE = mode;
  process.env.AGENT_SWARM_MODE = mode;
}

const child = Bun.spawn({
  cmd: [process.execPath, canonicalBootstrap, ...process.argv.slice(2)],
  env: process.env,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => { try { child.kill(signal); } catch { /* already exited */ } });
}
process.exit(await child.exited);
