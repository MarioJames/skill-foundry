#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { CliError, emit, parseFlags, runCli } from "./lib/cli";
import { loadRoutingConfig } from "./lib/agent-engines";
import { StateStore, readJson, reserve, bindBatch, runAttempt, type Decision } from "./lib/dispatch-state";
import { prepareAssessment, resolveAssessment, prepareWave, resolveWave, callJev, waveConfidenceThreshold } from "./lib/jev-decision";
import { taskBatch, taskRuntime } from "./lib/task-input";
import { observeAttempt, transport } from "./lib/agent-runtime";
import { hash, type Attempt } from "./lib/scheduling";
import { runRpc } from "./lib/rpc-runner";

await runCli(async () => {
  const flags = parseFlags(process.argv.slice(2), ["--input", "--state", "--config", "--mode", "--sandbox", "--timeout-ms", "--jev-timeout-ms", "--caller-pane", "--label"], ["--help"]);
  if (flags.has("--help")) {
    console.log("Usage: bun run-task.ts --input TASK.json --state PRIVATE.json [--config agents.json] [--mode oneshot|persistent] [--sandbox read-only|workspace-write] [--timeout-ms 1800000]\nHerdr path additionally needs --caller-pane ID --label MMDD｜TYPE｜Topic.\nRun through the host background process facility and retain its handle; this runner remains foreground until its owned execution ends.\nDefault: Jev decides parallel grouping; manual_override skips difficulty routing. Parallel selection always uses Jev. No model fallback or automatic retry. Existing ~/.config/herdr/agents.json remains the single default config."); return;
  }
  const required = (key: string) => { const v = flags.get(key); if (typeof v !== "string") throw new CliError("missing_argument", `${key} is required`, 2); return v; };
  const mode = flags.get("--mode") ?? "oneshot", sandbox = flags.get("--sandbox") ?? "read-only";
  if (!["oneshot", "persistent"].includes(mode as string) || !["read-only", "workspace-write"].includes(sandbox as string)) throw new CliError("invalid_argument", "Invalid mode or sandbox", 2);
  const timeoutMs = Number(flags.get("--timeout-ms") ?? 1_800_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 86_400_000) throw new CliError("invalid_argument", "timeout-ms must be 1000..86400000", 2);
  const jevTimeoutMs = Number(flags.get("--jev-timeout-ms") ?? 60_000);
  if (!Number.isInteger(jevTimeoutMs) || jevTimeoutMs < 1000 || jevTimeoutMs > 120_000) throw new CliError("invalid_argument", "jev-timeout-ms must be 1000..120000", 2);
  const input = readJson(required("--input"), 64_000), store = new StateStore(required("--state"));
  const config = loadRoutingConfig(flags.get("--config") as string | undefined);
  let rpc: Attempt | undefined;
  await store.transaction(async (state, save) => {
    // A terminal runner never needs this lock. Reconcile its immutable result before admission.
    for (const a of state.attempts.filter((a) => a.backend === "rpc" && a.slot === "held")) await observeAttempt(a);
    save();
    const { batch, agents } = taskBatch(input, state, config);
    bindBatch(state, batch);
    const assessment = prepareAssessment(batch, state.assessments, state.attempts, config);
    Object.assign(state.assessments, assessment.cached);
    let response: unknown = null;
    if (assessment.request) {
      const record = { id: randomUUID(), request: assessment.request, status: "intent", response: undefined as unknown };
      state.classification_runs.push(record); save();
      try { response = await callJev(assessment.request, { apiKey: process.env.OPENROUTER_API_KEY, timeoutMs: jevTimeoutMs }); record.response = response; record.status = "confirmed"; Object.assign(state.assessments, resolveAssessment(assessment, response).assessments); save(); }
      catch (e) { record.status = "failed"; save(); throw e; }
    }
    const runtime = await taskRuntime(config, agents, mode as string);
    const prepared = prepareWave(batch, config, state.assessments, runtime, state.attempts);
    const d: Decision = { id: randomUUID(), created_at: new Date().toISOString(), input_hash: hash(batch), prepared, result: { status: "pending", assignments: [] }, assessment_request: assessment.request, assessment_response: response, wave_response: null };
    state.decisions.push(d); save();
    try {
      d.wave_response = prepared.request ? await callJev(prepared.request, { apiKey: process.env.OPENROUTER_API_KEY, timeoutMs: jevTimeoutMs }) : null;
      d.result = resolveWave(prepared, d.wave_response, waveConfidenceThreshold(prepared, mode as "oneshot" | "persistent")); save();
    } catch (e) { d.result = { status: "failed", assignments: [] }; save(); throw e; }
    if (d.result.status !== "selected") { emit({ ok: d.result.status === "serial", status: d.result.status, reason: d.result.reason, selection: d.result.selection, blocked: prepared.blocked, decision_id: d.id }); if (d.result.status !== "serial") process.exitCode = 2; return; }
    const backend = mode === "oneshot" && d.result.assignments[0].binding.launch.kind === "codex" ? "rpc" : "herdr";
    let caller = "", label = "";
    if (backend === "herdr") {
      caller = required("--caller-pane"); label = required("--label");
      if (!/^\d{4}｜(?:FEA|DES|FIX|OPT|REL|EXP|DOC|RES)｜.+$/u.test(label)) throw new CliError("invalid_label", "Use the session createdAt date and MMDD｜TYPE｜Topic");
      const { command } = await import("./lib/agent-runtime");
      const pane = (await command(["herdr", "pane", "current", "--current"]))?.result?.pane;
      if (pane?.pane_id !== caller || input.owner.id !== caller) throw new CliError("caller_mismatch", "Owner and caller must match the actual Herdr pane");
    }
    const current = loadRoutingConfig(flags.get("--config") as string | undefined);
    if (hash(current) !== hash(config) || hash(readJson(required("--input"), 64_000)) !== hash(input)) throw new CliError("input_changed", "Task/config changed before reservation");
    const [a] = reserve(state, d, batch, config, runtime, store.path);
    a.backend = backend; save();
    if (backend === "herdr") {
      await runAttempt(a, save, transport(caller, label));
      emit({ ok: a.phase === "running", backend, attempt_id: a.id, lane: a.lane, state: store.path });
    } else {
      a.phase = "starting"; save(); rpc = structuredClone(a);
      emit({ ok: true, backend, attempt_id: a.id, runner_pid: process.pid, state: store.path, result: `${a.result_path}.rpc.json` });
    }
  });
  if (rpc) {
    const abort = new AbortController(), stop = () => abort.abort();
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    try {
      const result = await runRpc(rpc, { sandbox: sandbox as "read-only" | "workspace-write", timeoutMs, signal: abort.signal });
      emit({ ok: result.outcome === "completed" && result.cleanup === "stopped", result });
      if (result.outcome !== "completed" || result.cleanup !== "stopped") process.exitCode = 2;
    } finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
  }
});
