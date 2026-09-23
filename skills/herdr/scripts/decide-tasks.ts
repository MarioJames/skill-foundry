#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { CliError, emit, parseFlags, runCli } from "./lib/herdr-route";
import { loadRoutingConfig } from "./lib/agent-engines";
import { validateBatch, hash } from "./lib/scheduling";
import {
  prepareAssessment,
  resolveAssessment,
  prepareWave,
  resolveWave,
  callJev,
} from "./lib/jev-decision";
import {
  StateStore,
  readJson,
  applyAcceptances,
  bindBatch,
  type Decision,
} from "./lib/dispatch-state";
import { observeRuntime } from "./lib/agent-runtime";
await runCli(async () => {
  const f = parseFlags(
    process.argv.slice(2),
    ["--input", "--config", "--state", "--timeout-ms"],
    ["--dry-run", "--help"],
  );
  if (f.has("--help")) {
    console.log(
      `Usage: bun decide-tasks.ts --input BATCH.json [--config agents.json] [--state PRIVATE.json] [--dry-run] [--timeout-ms 20000]\nConfig defaults to ~/.config/herdr/agents.json. Live decisions require --state.\nDry-run validates and prints classification only; no probes, API calls or writes.\nLive: read-only profile probes + Herdr inventory, classification A then wave B; OPENROUTER_API_KEY is read only from environment.\nOutputs a decision ID, never starts Agents. Confidence adoption threshold 0.8 is local policy, not calibrated certainty.`,
    );
    return;
  }
  if (typeof f.get("--input") !== "string")
    throw new CliError("missing_argument", "--input is required", 2);
  const input = validateBatch(readJson(f.get("--input") as string, 64_000)),
    config = loadRoutingConfig(f.get("--config") as string | undefined);
  const timeoutMs = Number(f.get("--timeout-ms") ?? 20000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
    throw new CliError("invalid_argument", "timeout-ms must be 1..120000", 2);
  if (f.has("--dry-run")) {
    emit({
      ok: true,
      status: "dry_run",
      classification: prepareAssessment(input, {}),
      config,
      wave: "requires accepted assessments and live probes",
    });
    return;
  }
  if (typeof f.get("--state") !== "string")
    throw new CliError("missing_argument", "Live decisions require --state", 2);
  const store = new StateStore(f.get("--state") as string);
  await store.transaction(async (state, save) => {
    if (Buffer.byteLength(JSON.stringify(state, null, 2)) > 12_000_000)
      throw new CliError(
        "state_budget",
        "Decision admission stops at 12 MB; retain remaining space for observation and owner reconciliation",
      );
    bindBatch(state, input);
    const batch = applyAcceptances(input, state),
      a = prepareAssessment(batch, state.assessments, state.attempts);
    let ar: unknown = null;
    state.assessments = { ...state.assessments, ...a.cached };
    if (a.request) {
      const run = {
        id: randomUUID(),
        request: a.request,
        status: "intent",
        response: undefined as unknown,
        error: undefined as string | undefined,
      };
      state.classification_runs.push(run);
      save();
      try {
        ar = await callJev(a.request, {
          apiKey: process.env.OPENROUTER_API_KEY,
          timeoutMs,
        });
        run.response = ar;
        run.status = "confirmed";
        Object.assign(state.assessments, resolveAssessment(a, ar).assessments);
        save();
      } catch (error) {
        run.status = "failed";
        run.error = error instanceof CliError ? error.code : "request_failed";
        save();
        throw error;
      }
    }
    const runtime = await observeRuntime(config),
      prepared = prepareWave(
        batch,
        config,
        state.assessments,
        runtime,
        state.attempts,
      );
    const d: Decision = {
      id: randomUUID(),
      created_at: new Date().toISOString(),
      input_hash: hash(batch),
      prepared,
      result: { status: "pending", assignments: [] },
      assessment_request: a.request,
      assessment_response: ar,
      wave_response: null,
    };
    state.decisions.push(d);
    save();
    try {
      d.wave_response = prepared.request
        ? await callJev(prepared.request, {
            apiKey: process.env.OPENROUTER_API_KEY,
            timeoutMs,
          })
        : null;
      d.result = resolveWave(prepared, d.wave_response);
      save();
    } catch (error) {
      d.result = {
        status: "failed",
        assignments: [],
        reason: error instanceof CliError ? error.code : "request_failed",
      };
      save();
      throw error;
    }
    emit({
      ok: true,
      decision_id: d.id,
      ...d.result,
      blocked: prepared.blocked,
    });
  });
});
