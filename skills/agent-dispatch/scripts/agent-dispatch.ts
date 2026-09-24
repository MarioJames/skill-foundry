#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CliError, emit, parseFlags, runCli } from "./lib/cli";
import { loadRoutingConfig } from "./lib/agent-engines";
import { command, cleanupAttempt, observeAttempt, transport } from "./lib/agent-runtime";
import { acceptAttempt, bindBatch, reserve, resolveAttempt, runAttempt, type Decision, type State } from "./lib/dispatch-state";
import { callJev, prepareAssessment, prepareWave, resolveAssessment, resolveWave, waveConfidenceThreshold } from "./lib/jev-decision";
import { contextBlockers, expandPublicPatch, mergePublicContext, validatePublicInput, buildPublicBatch, type PublicContext } from "./lib/public-input";
import { taskRuntime } from "./lib/task-input";
import { hash, validateBatch, type Attempt, type Batch } from "./lib/scheduling";
import { runRpc } from "./lib/rpc-runner";
import { SQLiteStateStore, defaultDatabase } from "./lib/sqlite-state";

const HELP = `Usage: bun scripts/agent-dispatch.ts COMMAND [--scope ID] [--db PATH] [--config PATH] [options]
Commands:
  check [--input -|FILE] [--live]  Validate stored facts or supplied changes
  run [--input -|FILE]            Merge changes, decide one wave, and start selected attempts
  plan [--input -|FILE]           Decide and freeze one wave without starting it
  start --decision ID            Start a frozen decision without another Jev request
  status [--attempt ID] [--cached]  Observe execution and report delivery, acceptance, cleanup
  accept --attempt ID --input -|FILE  Record parent verification of delivered artifacts
  cancel --task KEY|--attempt ID  Cancel pending work or request exact execution stop
  resolve --attempt ID --outcome OUTCOME --evidence TEXT  Reconcile stopped/unknown work
  cleanup --attempt ID --caller-pane PANE  Release an accepted/resolved owned Herdr lane

Scope defaults to a verified current Herdr parent session; otherwise pass --scope ID. State defaults to ${defaultDatabase()}.
--input - reads bounded JSON from stdin; FILE uses the same public schema. No internal Batch JSON.
First run supplies task facts once. Later run/check/plan read SQLite directly; --input may contain only changed fields or new tasks.
Input: {"version":1,"cwd":"/absolute/repo","goal":"goal","owner":{"id":"parent","adapter":"codex","work":"Editing src while contract is frozen","reads":["src"],"writes":["src"]},"external":[],"authorization":{"delegate":true,"basis":"user request"},"tasks":[{"key":"review","prompt":"Review the contract","deliverable":"findings","acceptance":["cite concrete findings"],"reads":["contracts"],"writes":[],"depends_on":[]}]}
Unknown reads/writes, external inventory, or dependencies use null; [] means confirmed empty. Changed tasks require if_revision. Optional task mode is oneshot|persistent. Resource paths are cwd-relative; db/service/redis/bucket keys identify external resources.
Selected Herdr work additionally needs --caller-pane and --label MMDD｜TYPE｜Topic. No automatic retry, model fallback, acceptance, or unknown-write release.`;

const script = fileURLToPath(import.meta.url);
function procTicks(pid: number): string | undefined {
  try { return readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /u, "").split(" ")[19]; } catch { return undefined; }
}
async function readInput(source: string): Promise<unknown> {
  let value: string;
  if (source === "-") {
    if (process.stdin.isTTY) throw new CliError("missing_input", "Pipe JSON to --input -", 2);
    value = await Bun.stdin.text();
  } else {
    const { readJson } = await import("./lib/dispatch-state");
    return readJson(source, 64_000);
  }
  if (Buffer.byteLength(value) > 64_000) throw new CliError("input_budget", "Input exceeds 64 KB", 2);
  try { return JSON.parse(value); } catch { throw new CliError("invalid_json", "Input must be valid JSON", 2); }
}
function inputError(issues: ReturnType<typeof validatePublicInput>["issues"]) {
  emit({ ok: false, status: "invalid_input", stage: "validation", issues, workers_started: 0 });
  process.exitCode = 2;
}
function externalAgents(context: PublicContext, config: ReturnType<typeof loadRoutingConfig>) {
  return [context.owner, ...(context.external ?? [])].map((a) => ({
    pane_id: a.id, adapter: a.adapter === "other" ? undefined : a.adapter,
    engine_id: Object.keys(config.engines).find((k) => config.engines[k].adapter === a.adapter) ?? null,
    state: "working", session_id: undefined,
  }));
}
function otherActivity(store: SQLiteStateStore, batch: Batch, config: ReturnType<typeof loadRoutingConfig>) {
  const active = store.otherActiveAttempts();
  const supplemented = validateBatch({ ...batch, external_resources: [...batch.external_resources,
    ...active.map((a) => {
      const r = a.binding.task.resources;
      if (r.status !== "known") throw new CliError("ownership_unknown", "Another scope has unresolved unknown ownership");
      return { id: `attempt:${a.id}`, reads: r.reads, writes: r.writes };
    })] });
  const agents = active.map((a) => ({ pane_id: `attempt:${a.id}`, adapter: a.binding.launch.kind,
    engine_id: Object.keys(config.engines).find((k) => config.engines[k].adapter === a.binding.launch.kind) ?? null,
    state: a.slot === "held" ? "working" : "idle", session_id: undefined }));
  return { batch: supplemented, agents };
}
function summary(a: Attempt) {
  return { attempt_id: a.id, task: a.task, backend: a.backend, phase: a.phase,
    execution: a.slot === "held" ? "active_or_unknown" : "stopped",
    delivery: a.result?.status ?? "unconfirmed", acceptance: a.acceptance ? "accepted" : "pending",
    cleanup: a.cleanup ?? null, writes_held: a.writes_held, result: a.result ?? null,
    runner_pid: a.runner_pid ?? null, lane: a.lane ?? null, observation_error: a.observation_error ?? null };
}
function lifecycleHash(state: State) {
  return hash(state.attempts.map((a) => ({ id: a.id, task: a.task, phase: a.phase, slot: a.slot, writes_held: a.writes_held, acceptance: !!a.acceptance, resolution: !!a.resolution })));
}
function publicDecisionStatus(d: Decision) {
  return d.result.reason === "local_guard" && d.prepared.blocked.length ? "blocked" : d.result.status;
}
async function startDecision(store: SQLiteStateStore, decisionId: string, configPath: string | undefined, caller: string | undefined, label: string | undefined, timeoutMs: number) {
  const rpc: Attempt[] = [];
  const result = await store.admission(() => store.transaction(async (state, save) => {
    const context = state.public_context as PublicContext | undefined;
    if (!context) throw new CliError("unknown_scope", "Scope has no task facts");
    const external = otherActivity(store, buildPublicBatch(store.scope, context, state), loadRoutingConfig(configPath));
    const batch = external.batch;
    const d = state.decisions.find((x) => x.id === decisionId);
    if (!d) throw new CliError("unknown_decision", "Decision does not exist");
    if (state.attempts.some((a) => a.decision_id === d.id)) throw new CliError("decision_started", "Decision already has attempts; use status");
    if (d.result.status !== "selected") throw new CliError("decision_not_selected", `Decision is ${d.result.status}`);
    const config = loadRoutingConfig(configPath);
    const native = d.result.assignments.some((a) => {
      const task = context.tasks.find((t) => t.key === a.task_id)!;
      return task.mode === "persistent" || a.binding.launch.kind !== "codex";
    });
    if (native) {
      if (!caller || !label || !/^\d{4}｜(?:FEA|DES|FIX|OPT|REL|EXP|DOC|RES)｜.+$/u.test(label))
        throw new CliError("native_caller_required", "Selected Herdr work needs --caller-pane and --label MMDD｜TYPE｜Topic", 2);
      const pane = (await command(["herdr", "pane", "current", "--current"]))?.result?.pane;
      if (pane?.pane_id !== caller || context.owner.id !== caller)
        throw new CliError("caller_mismatch", "Caller pane and owner id must match the actual parent pane");
    }
    const runtime = await taskRuntime(config, [...externalAgents(context, config), ...external.agents]);
    const attempts = reserve(state, d, batch, config, runtime, store.path, store.results);
    save();
    for (const a of attempts) {
      const task = context.tasks.find((t) => t.key === a.task.id)!;
      a.backend = task.mode === "oneshot" && a.binding.launch.kind === "codex" ? "rpc" : "herdr";
      if (a.backend === "rpc") { a.phase = "starting"; rpc.push(structuredClone(a)); save(); continue; }
      await runAttempt(a, save, transport(caller!, label!));
    }
    save();
    return { decision_id: d.id, attempts: attempts.map(summary) };
  }));
  // A bounded runner is one process per attempt. This allows precise cancellation and
  // prevents one slow RPC worker from serializing an entire selected wave.
  for (const a of rpc) {
    const child = spawn(process.execPath, [script, "worker", "--scope", store.scope, "--db", store.path, "--attempt", a.id, "--timeout-ms", String(timeoutMs)], { detached: true, stdio: "ignore" });
    try { await new Promise<void>((ok, fail) => { child.once("spawn", () => ok()); child.once("error", fail); }); }
    catch { await store.transaction(async (state, save) => { const current = state.attempts.find((x) => x.id === a.id)!; current.observation_error = "Runner spawn failed before confirmation; inspect before resolve"; save(); }); continue; }
    await store.transaction(async (state, save) => {
      const current = state.attempts.find((x) => x.id === a.id)!;
      current.runner_pid = child.pid;
      current.runner_start_ticks = child.pid ? procTicks(child.pid) : undefined;
      save();
    });
    child.unref();
  }
  await store.transaction(async (state, save) => {
    if (state.public_request?.decision_id === decisionId) { state.public_request.lifecycle_hash = lifecycleHash(state); save(); }
  });
  return { ...result, attempts: store.read().attempts.filter((a) => a.decision_id === decisionId).map(summary) };
}

await runCli(async () => {
  const [action, ...argv] = process.argv.slice(2);
  if (!action || ["--help", "help"].includes(action)) { process.stdout.write(HELP + "\n"); return; }
  const f = parseFlags(argv, ["--scope", "--db", "--config", "--input", "--decision", "--attempt", "--task", "--outcome", "--evidence", "--caller-pane", "--label", "--timeout-ms"], ["--live", "--cached", "--help"]);
  if (f.has("--help")) { process.stdout.write(HELP + "\n"); return; }
  const req = (key: string) => { const v = f.get(key); if (typeof v !== "string" || !v) throw new CliError("missing_argument", `${key} is required`, 2); return v; };
  const timeoutMs = Number(f.get("--timeout-ms") ?? 1_800_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 86_400_000) throw new CliError("invalid_argument", "--timeout-ms must be 1000..86400000", 2);
  let scope = f.get("--scope") as string | undefined;
  if (!scope && action !== "worker") {
    try {
      const pane = (await command(["herdr", "pane", "current", "--current"]))?.result?.pane;
      const session = pane?.agent_session?.value;
      if (typeof session === "string" && session) scope = `session-${createHash("sha256").update(session).digest("hex").slice(0, 24)}`;
    } catch {}
  }
  if (!scope) throw new CliError("missing_scope", "No caller session could be resolved; pass --scope ID", 2);
  const store = new SQLiteStateStore(scope, f.get("--db") as string | undefined);
  const configPath = f.get("--config") as string | undefined;
  if (action === "worker") {
    const a = store.read().attempts.find((x) => x.id === req("--attempt"));
    if (!a || a.backend !== "rpc" || a.phase !== "starting") throw new CliError("worker_unreserved", "Worker requires one reserved RPC attempt");
    const sandbox = a.binding.task.resources.status === "known" && a.binding.task.resources.writes.length ? "workspace-write" : "read-only";
    const result = await runRpc(a, { sandbox, timeoutMs });
    emit({ ok: result.outcome === "completed" && result.cleanup === "stopped", result });
    if (result.outcome !== "completed" || result.cleanup !== "stopped") process.exitCode = 2;
    return;
  }
  if (action === "check" || action === "plan" || action === "run") {
    const before = store.read();
    const source = f.get("--input") as string | undefined;
    if (!source && !before.public_context) throw new CliError("missing_input", "This scope has no facts yet; first run needs --input -|FILE", 2);
    const parsed = validatePublicInput(expandPublicPatch(before.public_context as PublicContext | undefined,
      source ? await readInput(source) : { tasks: [] }));
    if (parsed.issues.length) { inputError(parsed.issues); return; }
    const context = mergePublicContext(before.public_context as PublicContext | undefined, parsed.input!);
    const blockers = contextBlockers(context);
    const config = loadRoutingConfig(configPath);
    if (action === "check") {
      const cross = otherActivity(store, buildPublicBatch(store.scope, context, before), config);
      const batch = cross.batch;
      const live = f.has("--live") && !blockers.length ? await taskRuntime(config, [...externalAgents(context, config), ...cross.agents]) : null;
      const capabilityIssues = live ? Object.entries(live.probes).filter(([, p]) => p.status !== "supported").map(([route, p]) => ({ path: `/profiles/${route}`, expected: "supported", received: p.status, next_step: `Inspect ${p.reason}; update the selected profile or repair the live CLI catalog, then check again` })) : [];
      const issues = [...blockers, ...capabilityIssues];
      emit({ ok: !issues.length, scope: store.scope, status: issues.length ? "blocked" : "valid", stage: "preflight", issues, tasks: batch.tasks.map((t) => ({ key: t.id, revision: t.revision, status: t.status, resources: t.resources.status })), profiles: live?.probes ?? null, workers_started: 0 });
      if (issues.length) process.exitCode = 2;
      return;
    }
    const decision = await store.transaction(async (state, save) => {
      const merged = mergePublicContext(state.public_context as PublicContext | undefined, parsed.input!);
      state.public_context = merged;
      bindBatch(state, buildPublicBatch(store.scope, merged, state));
      save();
      const missing = contextBlockers(merged);
      if (missing.length) return { status: "blocked", stage: "preflight", issues: missing, workers_started: 0 };
      const cross = otherActivity(store, buildPublicBatch(store.scope, merged, state), config);
      const batch = cross.batch;
      if (state.public_failure?.input_hash === hash(batch) && state.public_failure.config_hash === hash(config))
        return { status: "failed", reason: state.public_failure.code, stage: state.public_failure.stage, workers_started: 0, reused: true };
      const requestHash = hash(merged);
      const repeated = state.public_request?.hash === requestHash && state.public_request.lifecycle_hash === lifecycleHash(state)
        ? state.decisions.find((d) => d.id === state.public_request?.decision_id) : undefined;
      if (repeated) return { status: publicDecisionStatus(repeated), decision_id: repeated.id, reason: repeated.result.reason, selection: repeated.result.selection, blocked: repeated.prepared.blocked, reused: true, workers_started: state.attempts.filter((a) => a.decision_id === repeated.id).length };
      const old = state.decisions.at(-1);
      if (old?.input_hash === hash(batch) && old.result.status !== "failed")
        return { status: publicDecisionStatus(old), decision_id: old.id, reason: old.result.reason, selection: old.result.selection, blocked: old.prepared.blocked, reused: true, workers_started: state.attempts.filter((a) => a.decision_id === old.id).length };
      const assessment = prepareAssessment(batch, state.assessments, state.attempts, config);
      Object.assign(state.assessments, assessment.cached);
      let response: unknown = null;
      if (assessment.request) {
        const record = { id: randomUUID(), request: assessment.request, status: "intent", response: undefined as unknown };
        state.classification_runs.push(record); save();
        try { response = await callJev(assessment.request, { apiKey: process.env.OPENROUTER_API_KEY, timeoutMs: 60_000 }); record.response = response; record.status = "confirmed"; Object.assign(state.assessments, resolveAssessment(assessment, response).assessments); save(); }
        catch (error) { record.status = "failed"; state.public_failure = { input_hash: hash(batch), config_hash: hash(config), stage: "classification", code: error instanceof CliError ? error.code : "jev_failed" }; save(); throw error; }
      }
      const runtime = await taskRuntime(config, [...externalAgents(merged, config), ...cross.agents]);
      const prepared = prepareWave(batch, config, state.assessments, runtime, state.attempts);
      const d: Decision = { id: randomUUID(), created_at: new Date().toISOString(), input_hash: hash(batch), prepared, result: { status: "pending", assignments: [] }, assessment_request: assessment.request, assessment_response: response, wave_response: null };
      state.decisions.push(d); save();
      try {
        d.wave_response = prepared.request ? await callJev(prepared.request, { apiKey: process.env.OPENROUTER_API_KEY, timeoutMs: 60_000 }) : null;
        const selected = prepared.waves.length === 1 && prepared.waves[0].assignments.length === 1;
        const mode = selected ? merged.tasks.find((t) => t.key === prepared.waves[0].assignments[0].task_id)?.mode : undefined;
        d.result = resolveWave(prepared, d.wave_response, selected ? waveConfidenceThreshold(prepared, mode ?? "oneshot") : 0.8); save();
      } catch (error) { d.result = { status: "failed", assignments: [], reason: "jev_failed" }; state.public_failure = { input_hash: hash(batch), config_hash: hash(config), stage: "selection", code: error instanceof CliError ? error.code : "jev_failed" }; save(); throw error; }
      state.public_failure = undefined;
      state.public_request = { hash: requestHash, decision_id: d.id, lifecycle_hash: lifecycleHash(state) }; save();
      return { status: publicDecisionStatus(d), decision_id: d.id, reason: d.result.reason, selection: d.result.selection, blocked: prepared.blocked, workers_started: 0 };
    });
    if (action === "run" && decision.status === "selected" && decision.decision_id && !store.read().attempts.some((a) => a.decision_id === decision.decision_id)) {
      emit({ ok: true, scope: store.scope, status: "selected", decision_id: decision.decision_id, stage: "decision" });
      const started = await startDecision(store, decision.decision_id, configPath, f.get("--caller-pane") as string | undefined, f.get("--label") as string | undefined, timeoutMs);
      emit({ ok: true, scope: store.scope, status: "started", ...started });
    } else emit({ ok: decision.status === "selected" || decision.status === "serial", scope: store.scope, ...decision });
    if (!["selected", "serial"].includes(decision.status)) process.exitCode = 2;
    return;
  }
  if (action === "start") { emit({ ok: true, scope: store.scope, status: "started", ...(await startDecision(store, req("--decision"), configPath, f.get("--caller-pane") as string | undefined, f.get("--label") as string | undefined, timeoutMs)) }); return; }
  if (action === "status") {
    const id = f.get("--attempt") as string | undefined;
    const gather = async (state: State, save?: () => void) => {
      const selected = id ? state.attempts.filter((a) => a.id === id) : state.attempts;
      if (id && !selected.length) throw new CliError("unknown_attempt", "Attempt not found");
      if (save) for (const a of selected.filter((a) => a.slot === "held")) { await observeAttempt(a); save(); }
      return { ok: true, scope: store.scope, locked: save ? null : store.lockInfo(), tasks: (state.public_context as PublicContext | undefined)?.tasks.map((t) => ({ key: t.key, revision: t.revision, cancelled: !!t.cancelled })) ?? [], attempts: selected.map(summary), decisions: state.decisions.map((d) => ({ id: d.id, status: d.result.status, reason: d.result.reason, selection: d.result.selection })) };
    };
    emit(f.has("--cached") ? await gather(store.read()) : await store.transaction(gather));
    return;
  }
  if (action === "accept") {
    const proof = await readInput(req("--input"));
    await store.transaction(async (state, save) => {
      const a = state.attempts.find((x) => x.id === req("--attempt"));
      if (!a) throw new CliError("unknown_attempt", "Attempt not found");
      if (!proof || typeof proof !== "object" || Array.isArray(proof)) throw new CliError("invalid_evidence", "Acceptance needs an object", 2);
      const p = proof as any;
      acceptAttempt(state, a.id, { task_revision: a.task.revision, attempt_id: a.id, artifact_refs: p.artifact_refs, delivery_evidence_ref: p.delivery_evidence_ref, owner_evidence_ref: p.owner_evidence_ref });
      save(); emit({ ok: true, attempt: summary(a) });
    });
    return;
  }
  if (action === "resolve") {
    await store.transaction(async (state, save) => {
      const a = state.attempts.find((x) => x.id === req("--attempt")); if (!a) throw new CliError("unknown_attempt", "Attempt not found");
      const outcome = req("--outcome");
      if (a.backend === "rpc" && a.runner_pid && a.runner_start_ticks && procTicks(a.runner_pid) === a.runner_start_ticks)
        throw new CliError("runner_still_active", "Exact RPC runner is still active; stop and observe it before resolve");
      if (a.backend === "rpc" && outcome === "not_performed" && (a.runner_pid || existsSync(`${a.result_path}.rpc.json.started`)))
        throw new CliError("effect_possible", "RPC start may have occurred; inspect and use a stopped outcome");
      resolveAttempt(a, outcome, req("--evidence")); save(); emit({ ok: true, attempt: summary(a) });
    });
    return;
  }
  if (action === "cleanup") {
    await store.transaction(async (state, save) => {
      const a = state.attempts.find((x) => x.id === req("--attempt")); if (!a) throw new CliError("unknown_attempt", "Attempt not found");
      if (a.cleanup) throw new CliError("cleanup_recorded", "Cleanup is already recorded; inspect its outcome");
      const caller = req("--caller-pane");
      if ((await command(["herdr", "pane", "current", "--current"]))?.result?.pane?.pane_id !== caller) throw new CliError("caller_mismatch", "Cleanup caller must match the actual pane");
      const cleanup = await cleanupAttempt(a, caller); save();
      try { a.cleanup = { ...(a.cleanup as any), state: "confirmed", reply: await cleanup.execute() }; }
      catch { a.cleanup = { ...(a.cleanup as any), state: "unknown" }; }
      save(); emit({ ok: (a.cleanup as any).state === "confirmed", attempt: summary(a) });
    });
    return;
  }
  if (action === "cancel") {
    await store.transaction(async (state, save) => {
      const task = f.get("--task") as string | undefined, id = f.get("--attempt") as string | undefined;
      if (!!task === !!id) throw new CliError("invalid_argument", "Specify exactly one of --task or --attempt", 2);
      if (task) {
        const context = state.public_context as PublicContext | undefined;
        const item = context?.tasks.find((x) => x.key === task);
        if (!item) throw new CliError("unknown_task", "Task not found");
        if (state.attempts.some((a) => a.task.id === task && a.acceptance)) throw new CliError("task_accepted", "Accepted work cannot be cancelled");
        if (state.attempts.some((a) => a.task.id === task && (a.slot === "held" || a.writes_held))) throw new CliError("attempt_active", "Use --attempt to stop and reconcile active work");
        item.cancelled = true; save(); emit({ ok: true, status: "cancelled_pending", task }); return;
      }
      const a = state.attempts.find((x) => x.id === id); if (!a) throw new CliError("unknown_attempt", "Attempt not found");
      if (a.slot !== "held") throw new CliError("attempt_stopped", "Attempt already stopped; use status");
      if (a.backend === "rpc") {
        if (!a.runner_pid || !a.runner_start_ticks || procTicks(a.runner_pid) !== a.runner_start_ticks)
          throw new CliError("runner_identity_unknown", "Runner identity cannot be verified; inspect result and process before resolve");
        a.observation_error = "Cancellation requested; await terminal result and inspect partial writes"; save();
        process.kill(a.runner_pid, "SIGTERM"); emit({ ok: true, status: "stop_requested", attempt: a.id }); return;
      }
      if (!a.lane?.pane_id || !a.session_id) throw new CliError("session_unknown", "Herdr session identity missing; inspect before stopping");
      const live = (await command(["herdr", "agent", "get", a.lane.pane_id]))?.result?.agent;
      if (live?.agent_session?.value !== a.session_id || live?.pane_id !== a.lane.pane_id) throw new CliError("session_changed", "Herdr session changed; no stop sent");
      a.observation_error = "Interrupt requested; inspect exact session and partial writes"; save();
      await command(["herdr", "agent", "send-keys", a.lane.pane_id, "ctrl-c"]);
      emit({ ok: true, status: "stop_requested", attempt: a.id });
    });
    return;
  }
  throw new CliError("invalid_command", `Unknown command ${action}`, 2);
});
