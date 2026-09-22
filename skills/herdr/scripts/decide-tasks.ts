#!/usr/bin/env bun

import { readFileSync, statSync } from "node:fs";
import { CliError, emit, parseFlags, runCli } from "./lib/herdr-route";
import { prepareDecision, requestDecision } from "./lib/jev-decision";

const usage = `Usage:
  bun decide-tasks.ts --input BATCH.json [--dry-run] [options]

Select the next task wave and its execution models with OpenRouter Jev.
This script returns a decision; the main Agent owns Herdr dispatch and verification.

Options:
  --input PATH              Explicit task snapshot; see examples/jev-batch.json.
  --dry-run                 Validate and print the exact request without calling Jev.
  --timeout-ms N            Request deadline, 1..120000; default: 20000. No retries.
  --min-confidence N        Local escalation policy, 0..1; default: 0.8 (uncalibrated).
  -h, --help                Show help.

Environment: OPENROUTER_API_KEY (never read from the input JSON).
Endpoint: https://openrouter.ai/api/alpha/decisions
Model: ~typesafe/jev-latest
Budget: 24000 UTF-8 bytes for the complete request; no silent truncation.
Only ok=true AND status=selected is dispatchable. Recheck live state before dispatch.`;

await runCli(async () => {
  const flags = parseFlags(process.argv.slice(2), ["--input", "--timeout-ms", "--min-confidence"], ["--help", "--dry-run"]);
  if (flags.has("--help")) { process.stdout.write(`${usage}\n`); return; }
  const path = flags.get("--input");
  if (typeof path !== "string") throw new CliError("missing_argument", "--input is required", 2);
  const timeoutMs = Number(flags.get("--timeout-ms") ?? 20_000);
  const minConfidence = Number(flags.get("--min-confidence") ?? 0.8);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new CliError("invalid_argument", "--timeout-ms must be 1..120000", 2);
  if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) throw new CliError("invalid_argument", "--min-confidence must be 0..1", 2);
  let input: unknown;
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 64_000) throw new Error();
    input = JSON.parse(readFileSync(path, "utf8"));
  } catch { throw new CliError("invalid_input", "--input must be a readable JSON file no larger than 64000 bytes", 2); }
  const prepared = prepareDecision(input);
  if (flags.has("--dry-run")) {
    emit({ ok: true, status: "dry_run", snapshot_id: prepared.snapshot_id, input_bytes: prepared.input_bytes,
      local_status: prepared.local_status ?? null, rejected_plans: prepared.rejected, request: prepared.request });
    return;
  }
  emit(await requestDecision(prepared, { apiKey: process.env.OPENROUTER_API_KEY, timeoutMs, minConfidence }));
});
