import { afterEach, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { loadRoutingConfig } from "../scripts/lib/agent-engines";
import { prepareAssessment, prepareWave } from "../scripts/lib/jev-decision";
import { rpcProbe } from "../scripts/lib/rpc-catalog";
import { hash } from "../scripts/lib/scheduling";
import { buildPublicBatch, mergePublicContext, validatePublicInput } from "../scripts/lib/public-input";
import { SQLiteStateStore } from "../scripts/lib/sqlite-state";
import type { Decision } from "../scripts/lib/dispatch-state";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const cliFile = resolve(import.meta.dir, "../scripts/agent-dispatch.ts");

test("frozen two-task wave starts separate RPC runners and needs parent acceptance", async () => {
  const root = mkdtempSync(join(tmpdir(), "dispatch-cli-")); roots.push(root);
  const bin = join(root, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "codex"), `#!/bin/sh\nexec '${process.execPath}' '${join(import.meta.dir, "fixtures/mock-codex-cli.ts")}' "$@"\n`, { mode: 0o700 });
  const db = join(root, "state.sqlite"), configFile = join(root, "agents.json"), scope = "two-tasks";
  writeFileSync(configFile, JSON.stringify({ version: 1, manual_override: { route: "ordinary" }, engines: { codex: { adapter: "codex", max_parallel: 3 } }, routes: { ordinary: { engine_id: "codex", model: "gpt-6-luna", reasoning: { mode: "effort", value: "max" } }, moderate: { engine_id: "codex", model: "gpt-6-luna", reasoning: { mode: "effort", value: "max" } }, complex: { engine_id: "codex", model: "gpt-6-luna", reasoning: { mode: "effort", value: "max" } } }, limits: { max_parallel: 4 } }));
  const config = loadRoutingConfig(configFile);
  const publicInput = validatePublicInput({ version: 1, cwd: root, goal: "Review two frozen documents while parent works", owner: { id: "parent", adapter: "codex", work: "Editing an unrelated module", reads: ["src"], writes: ["src"] }, external: [], authorization: { delegate: true, basis: "user-authorized review" }, tasks: ["a", "b"].map((key) => ({ key, prompt: `Review ${key}.md`, deliverable: "findings", acceptance: ["cite findings"], reads: [`${key}.md`], writes: [], depends_on: [] })) }).input!;
  const store = new SQLiteStateStore(scope, db), context = mergePublicContext(undefined, publicInput);
  let decisionId = "";
  await store.transaction(async (state, save) => {
    state.public_context = context;
    const batch = buildPublicBatch(scope, context, state), assessment = prepareAssessment(batch, {}, [], config);
    Object.assign(state.assessments, assessment.cached);
    const profile = assessment.cached.a?.outcome === "configured" ? config.routes.ordinary : config.routes.ordinary;
    const probe = rpcProbe(config, { engine_id: profile.engine_id, model: profile.model, reasoning: profile.reasoning }, { version: "0.156.1", models: [{ model: "gpt-6-luna", supportedReasoningEfforts: [{ reasoningEffort: "max" }] }] });
    const prepared = prepareWave(batch, config, state.assessments, { observed_at: new Date().toISOString(), agents: [{ pane_id: "parent", adapter: "codex", engine_id: "codex", state: "working" }], probes: { ordinary: probe, moderate: probe, complex: probe } }, []);
    const wave = prepared.waves.find((w) => w.assignments.length === 2);
    expect(wave).toBeDefined();
    const d: Decision = { id: randomUUID(), created_at: new Date().toISOString(), input_hash: hash(batch), prepared, result: { status: "selected", assignments: wave!.assignments }, assessment_request: null, assessment_response: null, wave_response: null };
    decisionId = d.id; state.decisions.push(d); save();
  });
  store.close();
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  const call = (args: string[]) => {
    const r = spawnSync(process.execPath, [cliFile, ...args, "--scope", scope, "--db", db], { cwd: root, env, encoding: "utf8", timeout: 12_000 });
    return { code: r.status, lines: r.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)), stderr: r.stderr };
  };
  const started = call(["start", "--decision", decisionId, "--config", configFile]);
  expect(started.code).toBe(0);
  expect(started.lines[0].attempts).toHaveLength(2);
  expect(new Set(started.lines[0].attempts.map((a: any) => a.runner_pid)).size).toBe(2);
  let attempts: any[] = [];
  for (let n = 0; n < 100; n++) {
    const status = call(["status"]);
    expect(status.code).toBe(0);
    attempts = status.lines[0].attempts;
    if (attempts.every((a) => a.phase === "finished")) break;
    await Bun.sleep(50);
  }
  expect(attempts.map((a) => a.phase)).toEqual(["finished", "finished"]);
  expect(attempts.every((a) => a.writes_held && a.acceptance === "pending" && a.cleanup?.stopped)).toBe(true);
  expect(call(["start", "--decision", decisionId, "--config", configFile]).code).not.toBe(0);
  expect(call(["resolve", "--attempt", attempts[0].attempt_id, "--outcome", "not_performed", "--evidence", "checked"]).code).not.toBe(0);
  for (const a of attempts) {
    const file = join(root, `${a.attempt_id}.json`);
    writeFileSync(file, JSON.stringify({ artifact_refs: a.result.artifact_refs, delivery_evidence_ref: "mock-result-verified", owner_evidence_ref: "parent-review" }));
    const accepted = call(["accept", "--attempt", a.attempt_id, "--input", file]);
    expect(accepted.code).toBe(0);
    expect(accepted.lines[0].attempt.writes_held).toBe(false);
  }
});

test("accepting one wave member schedules a newly unlocked task while its peer stays active", async () => {
  const root = mkdtempSync(join(tmpdir(), "dispatch-unlock-")); roots.push(root);
  const bin = join(root, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "codex"), `#!/bin/sh\nexec '${process.execPath}' '${join(import.meta.dir, "fixtures/mock-codex-cli.ts")}' "$@"\n`, { mode: 0o700 });
  const db = join(root, "state.sqlite"), configFile = join(root, "agents.json"), jevCount = join(root, "jev.log"), scope = "unlock";
  writeFileSync(configFile, JSON.stringify({ version: 1, manual_override: { route: "ordinary" }, engines: { codex: { adapter: "codex", max_parallel: 3 } }, routes: Object.fromEntries(["ordinary", "moderate", "complex"].map((key) => [key, { engine_id: "codex", model: "gpt-6-luna", reasoning: { mode: "effort", value: "max" } }])), limits: { max_parallel: 4 } }));
  const config = loadRoutingConfig(configFile);
  const input = validatePublicInput({ version: 1, cwd: root, goal: "Review three contracts", owner: { id: "parent", adapter: "codex", work: "Editing src", reads: ["src"], writes: ["src"] }, external: [], authorization: { delegate: true, basis: "user authorized review" }, tasks: ["a", "b", "c"].map((key) => ({ key, prompt: `Review ${key}.md`, deliverable: "findings", acceptance: ["cite findings"], reads: [`${key}.md`], writes: [], depends_on: key === "c" ? ["a"] : [] })) }).input!;
  const store = new SQLiteStateStore(scope, db), context = mergePublicContext(undefined, input);
  let decisionId = "";
  await store.transaction(async (state, save) => {
    state.public_context = context;
    const batch = buildPublicBatch(scope, context, state), assessment = prepareAssessment(batch, {}, [], config);
    Object.assign(state.assessments, assessment.cached);
    const probe = rpcProbe(config, { engine_id: "codex", model: "gpt-6-luna", reasoning: { mode: "effort", value: "max" } }, { version: "0.156.1", models: [{ model: "gpt-6-luna", supportedReasoningEfforts: [{ reasoningEffort: "max" }] }] });
    const prepared = prepareWave(batch, config, state.assessments, { observed_at: new Date().toISOString(), agents: [{ pane_id: "parent", adapter: "codex", engine_id: "codex", state: "working" }], probes: { ordinary: probe, moderate: probe, complex: probe } }, []);
    const wave = prepared.waves.find((w) => w.assignments.length === 2 && w.assignments.some((a) => a.task_id === "a") && w.assignments.some((a) => a.task_id === "b"))!;
    expect(wave).toBeDefined();
    const decision: Decision = { id: randomUUID(), created_at: new Date().toISOString(), input_hash: hash(batch), prepared, result: { status: "selected", assignments: wave.assignments }, assessment_request: null, assessment_response: null, wave_response: null };
    decisionId = decision.id;
    state.decisions.push(decision);
    state.public_request = { hash: hash({ context, config, agents: [], external_resources: batch.external_resources }), decision_id: decisionId, lifecycle_hash: hash([]) };
    save();
  });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, MOCK_TURN_HOLD_TASK: "b", OPENROUTER_API_KEY: "test-only", MOCK_JEV_COUNT_FILE: jevCount };
  const call = (args: string[], mockJev = false) => {
    const r = spawnSync(process.execPath, [...(mockJev ? ["--preload", join(import.meta.dir, "fixtures/mock-jev.ts")] : []), cliFile, ...args, "--scope", scope, "--db", db], { cwd: root, env, encoding: "utf8", timeout: 12_000 });
    return { code: r.status, lines: r.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)), stderr: r.stderr };
  };
  const first = call(["start", "--decision", decisionId, "--config", configFile]);
  expect(first.code).toBe(0);
  const byTask = Object.fromEntries(first.lines[0].attempts.map((a: any) => [a.task.id, a]));
  let observed: any[] = [];
  for (let n = 0; n < 100; n++) {
    observed = call(["status"]).lines[0].attempts;
    if (observed.find((a) => a.task.id === "a")?.phase === "finished" && observed.find((a) => a.task.id === "b")?.phase === "running") break;
    await Bun.sleep(50);
  }
  expect(observed.find((a) => a.task.id === "a")?.phase).toBe("finished");
  const bRunner = observed.find((a) => a.task.id === "b")?.runner_pid;
  expect(bRunner).toBeTruthy();
  const aId = byTask.a.attempt_id;
  const aResult = `${store.read().attempts.find((a) => a.id === aId)!.result_path}.rpc.json`;
  const proofFile = join(root, "proof.json");
  writeFileSync(proofFile, JSON.stringify({ artifact_refs: [aResult], delivery_evidence_ref: "mock delivery inspected", owner_evidence_ref: "parent accepted" }));
  expect(call(["accept", "--attempt", aId, "--input", proofFile]).code).toBe(0);
  const second = call(["run", "--config", configFile], true);
  expect(second.code).toBe(0);
  expect(second.lines.map((line) => line.status)).toEqual(["selected", "started"]);
  expect(second.lines[0].decision_id).not.toBe(decisionId);
  expect(second.lines[1].attempts.map((a: any) => a.task.id)).toEqual(["c"]);
  const attempts = store.read().attempts;
  expect(attempts.filter((a) => a.task.id === "a")).toHaveLength(1);
  expect(attempts.filter((a) => a.task.id === "b")).toHaveLength(1);
  expect(attempts.find((a) => a.task.id === "b")?.runner_pid).toBe(bRunner);
  expect(attempts.find((a) => a.task.id === "b")?.slot).toBe("held");
  expect(call(["cancel", "--attempt", byTask.b.attempt_id]).code).toBe(0);
  let stopped = false;
  for (let n = 0; n < 100; n++) {
    const b = call(["status", "--attempt", byTask.b.attempt_id]).lines[0].attempts[0];
    if (b.phase === "cancelled") { stopped = true; break; }
    await Bun.sleep(50);
  }
  expect(stopped).toBe(true);
  store.close();
});

test("ordinary run uses one Jev decision and identical submission reuses it", async () => {
  const root = mkdtempSync(join(tmpdir(), "dispatch-run-")); roots.push(root);
  const bin = join(root, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "codex"), `#!/bin/sh\nexec '${process.execPath}' '${join(import.meta.dir, "fixtures/mock-codex-cli.ts")}' "$@"\n`, { mode: 0o700 });
  const db = join(root, "state.sqlite"), configFile = join(root, "agents.json"), inputFile = join(root, "input.json"), jevCount = join(root, "jev.log");
  writeFileSync(configFile, JSON.stringify({ version: 1, manual_override: { route: "ordinary" }, engines: { codex: { adapter: "codex", max_parallel: 2 } }, routes: Object.fromEntries(["ordinary", "moderate", "complex"].map((key) => [key, { engine_id: "codex", model: "gpt-6-luna", reasoning: { mode: "effort", value: "max" } }])), limits: { max_parallel: 3 } }));
  writeFileSync(inputFile, JSON.stringify({ version: 1, cwd: root, goal: "Review a frozen document while parent edits src", owner: { id: "parent", adapter: "codex", work: "Editing src", reads: ["src"], writes: ["src"] }, external: [], authorization: { delegate: true, basis: "user authorized review" }, tasks: [{ key: "review", prompt: "Review a.md", deliverable: "findings", acceptance: ["cite findings"], reads: ["a.md"], writes: [], depends_on: [] }] }));
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, OPENROUTER_API_KEY: "test-only", MOCK_JEV_COUNT_FILE: jevCount };
  const run = (input?: string) => {
    const r = spawnSync(process.execPath, ["--preload", join(import.meta.dir, "fixtures/mock-jev.ts"), cliFile, "run", "--scope", "one-task", "--db", db, "--config", configFile, ...(input ? ["--input", input] : [])], { cwd: root, env, encoding: "utf8", timeout: 12_000 });
    return { code: r.status, lines: r.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) };
  };
  const first = run(inputFile);
  expect(first.code).toBe(0);
  expect(first.lines.map((x) => x.status)).toEqual(["selected", "started"]);
  expect(first.lines[1].attempts).toHaveLength(1);
  const second = run();
  expect(second.code).toBe(0);
  expect(second.lines[0].reused).toBe(true);
  expect(readFileSync(jevCount, "utf8").trim().split("\n")).toHaveLength(1);
  const status = () => spawnSync(process.execPath, [cliFile, "status", "--scope", "one-task", "--db", db], { cwd: root, env, encoding: "utf8" });
  let attempt: any;
  for (let n = 0; n < 100; n++) {
    attempt = JSON.parse(status().stdout).attempts[0];
    if (attempt.phase === "finished") break;
    await Bun.sleep(50);
  }
  expect(attempt.phase).toBe("finished");
  const failedDb = join(root, "failed.sqlite"), failedCount = join(root, "failed-jev.log");
  const failEnv = { ...env, MOCK_JEV_FAIL: "1", MOCK_JEV_COUNT_FILE: failedCount };
  const failRun = () => spawnSync(process.execPath, ["--preload", join(import.meta.dir, "fixtures/mock-jev.ts"), cliFile, "run", "--scope", "failed-task", "--db", failedDb, "--config", configFile, "--input", inputFile], { cwd: root, env: failEnv, encoding: "utf8", timeout: 12_000 });
  expect(failRun().status).not.toBe(0);
  const repeatedFailure = failRun();
  expect(repeatedFailure.status).not.toBe(0);
  expect(JSON.parse(repeatedFailure.stdout).error.code).toBe("network_error");
  expect(readFileSync(failedCount, "utf8").trim().split("\n")).toHaveLength(6);
  const recovered = spawnSync(process.execPath, ["--preload", join(import.meta.dir, "fixtures/mock-jev.ts"), cliFile, "run", "--scope", "failed-task", "--db", failedDb, "--config", configFile], { cwd: root, env: { ...env, MOCK_JEV_COUNT_FILE: failedCount }, encoding: "utf8", timeout: 12_000 });
  expect(recovered.status).toBe(0);
  expect(recovered.stdout.trim().split("\n").map((line) => JSON.parse(line).status)).toEqual(["selected", "started"]);
  expect(readFileSync(failedCount, "utf8").trim().split("\n")).toHaveLength(7);
  let recoveredPhase = "";
  for (let n = 0; n < 100; n++) {
    const observed = spawnSync(process.execPath, [cliFile, "status", "--scope", "failed-task", "--db", failedDb], { cwd: root, env, encoding: "utf8" });
    expect(observed.status).toBe(0);
    recoveredPhase = JSON.parse(observed.stdout).attempts[0].phase;
    if (recoveredPhase === "finished") break;
    await Bun.sleep(50);
  }
  expect(recoveredPhase).toBe("finished");
});

test("unified CLI cancellation lets the exact RPC runner stop its owned server", async () => {
  const root = mkdtempSync(join(tmpdir(), "dispatch-cancel-")); roots.push(root);
  const bin = join(root, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "codex"), `#!/bin/sh\nexec '${process.execPath}' '${join(import.meta.dir, "fixtures/mock-codex-cli.ts")}' "$@"\n`, { mode: 0o700 });
  const db = join(root, "state.sqlite"), configFile = join(root, "agents.json"), scope = "cancel-task";
  writeFileSync(configFile, JSON.stringify({ version: 1, manual_override: { route: "ordinary" }, engines: { codex: { adapter: "codex", max_parallel: 2 } }, routes: Object.fromEntries(["ordinary", "moderate", "complex"].map((key) => [key, { engine_id: "codex", model: "gpt-6-luna", reasoning: { mode: "effort", value: "max" } }])), limits: { max_parallel: 3 } }));
  const config = loadRoutingConfig(configFile);
  const input = validatePublicInput({ version: 1, cwd: root, goal: "Review a frozen contract", owner: { id: "parent", adapter: "codex", work: "Editing src", reads: ["src"], writes: ["src"] }, external: [], authorization: { delegate: true, basis: "user authorized review" }, tasks: [{ key: "review", prompt: "Review a.md", deliverable: "findings", acceptance: ["cite findings"], reads: ["a.md"], writes: [], depends_on: [] }] }).input!;
  const store = new SQLiteStateStore(scope, db), context = mergePublicContext(undefined, input);
  let decisionId = "";
  await store.transaction(async (state, save) => {
    state.public_context = context;
    const batch = buildPublicBatch(scope, context, state), assessment = prepareAssessment(batch, {}, [], config);
    Object.assign(state.assessments, assessment.cached);
    const probe = rpcProbe(config, { engine_id: "codex", model: "gpt-6-luna", reasoning: { mode: "effort", value: "max" } }, { version: "0.156.1", models: [{ model: "gpt-6-luna", supportedReasoningEfforts: [{ reasoningEffort: "max" }] }] });
    const prepared = prepareWave(batch, config, state.assessments, { observed_at: new Date().toISOString(), agents: [{ pane_id: "parent", adapter: "codex", engine_id: "codex", state: "working" }], probes: { ordinary: probe, moderate: probe, complex: probe } }, []);
    const wave = prepared.waves.find((w) => w.assignments.length === 1)!;
    const d: Decision = { id: randomUUID(), created_at: new Date().toISOString(), input_hash: hash(batch), prepared, result: { status: "selected", assignments: wave.assignments }, assessment_request: null, assessment_response: null, wave_response: null };
    decisionId = d.id; state.decisions.push(d); save();
  });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, MOCK_TURN_HOLD: "1" };
  const call = (args: string[]) => spawnSync(process.execPath, [cliFile, ...args, "--scope", scope, "--db", db], { cwd: root, env, encoding: "utf8", timeout: 12_000 });
  const started = call(["start", "--decision", decisionId, "--config", configFile]);
  expect(started.status).toBe(0);
  const attemptId = JSON.parse(started.stdout).attempts[0].attempt_id;
  const resultPath = `${store.read().attempts[0].result_path}.rpc.json`;
  for (let n = 0; n < 100; n++) {
    try { if (JSON.parse(readFileSync(resultPath, "utf8")).phase === "running") break; } catch {}
    await Bun.sleep(50);
  }
  expect(JSON.parse(readFileSync(resultPath, "utf8")).phase).toBe("running");
  const cancelled = call(["cancel", "--attempt", attemptId]);
  expect(cancelled.status).toBe(0);
  expect(JSON.parse(cancelled.stdout).status).toBe("stop_requested");
  let attempt: any;
  for (let n = 0; n < 100; n++) {
    attempt = JSON.parse(call(["status", "--attempt", attemptId]).stdout).attempts[0];
    if (attempt.phase === "cancelled") break;
    await Bun.sleep(50);
  }
  expect(attempt.phase).toBe("cancelled");
  expect(attempt.cleanup?.stopped).toBe(true);
  expect(attempt.writes_held).toBe(true);
  expect(JSON.parse(readFileSync(resultPath, "utf8")).outcome).toBe("cancelled");
  await store.transaction(async (state, save) => {
    const current = state.attempts.find((a) => a.id === attemptId)!;
    current.cleanup = undefined;
    current.runner_pid = undefined;
    current.runner_start_ticks = undefined;
    save();
  });
  const uncertainRecord = JSON.parse(readFileSync(resultPath, "utf8"));
  delete uncertainRecord.server_pid;
  uncertainRecord.cleanup = "unknown";
  writeFileSync(resultPath, JSON.stringify(uncertainRecord));
  const unconfirmed = call(["resolve", "--attempt", attemptId, "--outcome", "cancelled_stopped", "--evidence", "server stopped after owner inspection"]);
  expect(unconfirmed.status).not.toBe(0);
  expect(JSON.parse(unconfirmed.stdout).error.code).toBe("server_stop_unconfirmed");
  expect(call(["resolve", "--attempt", attemptId, "--outcome", "cancelled_stopped", "--evidence", "server stopped after owner inspection", "--server-stopped"]).status).toBe(0);
  store.close();
});

test("stdin patch uses authorization current when the scope lock is acquired", async () => {
  const root = mkdtempSync(join(tmpdir(), "dispatch-patch-race-")); roots.push(root);
  const bin = join(root, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "codex"), `#!/bin/sh\nexec '${process.execPath}' '${join(import.meta.dir, "fixtures/mock-codex-cli.ts")}' "$@"\n`, { mode: 0o700 });
  const db = join(root, "state.sqlite"), configFile = join(root, "agents.json"), inputFile = join(root, "input.json"), jevCount = join(root, "jev.log"), scope = "patch-race";
  writeFileSync(configFile, JSON.stringify({ version: 1, manual_override: { route: "ordinary" }, engines: { codex: { adapter: "codex", max_parallel: 2 } }, routes: Object.fromEntries(["ordinary", "moderate", "complex"].map((key) => [key, { engine_id: "codex", model: "gpt-6-luna", reasoning: { mode: "effort", value: "max" } }])), limits: { max_parallel: 3 } }));
  writeFileSync(inputFile, JSON.stringify({ version: 1, cwd: root, goal: "Review a frozen contract", owner: { id: "parent", adapter: "codex", work: "Editing src", reads: ["src"], writes: ["src"] }, external: [], authorization: { delegate: true, basis: "user authorized review" }, tasks: [{ key: "review", prompt: "Review a.md", deliverable: "findings", acceptance: ["cite findings"], reads: ["a.md"], writes: [], depends_on: [] }] }));
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, OPENROUTER_API_KEY: "test-only", MOCK_JEV_COUNT_FILE: jevCount };
  const prefix = ["--preload", join(import.meta.dir, "fixtures/mock-jev.ts"), cliFile, "plan", "--scope", scope, "--db", db, "--config", configFile];
  expect(spawnSync(process.execPath, [...prefix, "--input", inputFile], { cwd: root, env, encoding: "utf8" }).status).toBe(0);
  const waiting = spawn(process.execPath, [...prefix, "--input", "-"], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  waiting.stdout.on("data", (data) => { output += data.toString(); });
  await Bun.sleep(100);
  const revocation = join(root, "revoke.json");
  writeFileSync(revocation, JSON.stringify({ authorization: { delegate: false } }));
  expect(spawnSync(process.execPath, [...prefix, "--input", revocation], { cwd: root, env, encoding: "utf8" }).status).toBe(2);
  waiting.stdin.end(JSON.stringify({ owner: { work: "Editing tests now" } }));
  await new Promise<void>((done) => waiting.once("close", () => done()));
  expect(JSON.parse(output).status).toBe("blocked");
  const store = new SQLiteStateStore(scope, db);
  expect((store.read().public_context as any).authorization.delegate).toBe(false);
  expect((store.read().public_context as any).owner.work).toBe("Editing tests now");
  store.close();
});

test("blocked model decision and missing provider key recover in the same SQLite scope", () => {
  const root = mkdtempSync(join(tmpdir(), "dispatch-repair-")); roots.push(root);
  const bin = join(root, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "codex"), `#!/bin/sh\nexec '${process.execPath}' '${join(import.meta.dir, "fixtures/mock-codex-cli.ts")}' "$@"\n`, { mode: 0o700 });
  const db = join(root, "state.sqlite"), configFile = join(root, "agents.json"), inputFile = join(root, "input.json"), jevCount = join(root, "jev.log"), scope = "repair";
  const config = (model: string) => ({ version: 1, manual_override: { route: "ordinary" }, engines: { codex: { adapter: "codex", max_parallel: 2 } }, routes: Object.fromEntries(["ordinary", "moderate", "complex"].map((key) => [key, { engine_id: "codex", model, reasoning: { mode: "effort", value: "max" } }])), limits: { max_parallel: 3 } });
  writeFileSync(configFile, JSON.stringify(config("unsupported-model")));
  writeFileSync(inputFile, JSON.stringify({ version: 1, cwd: root, goal: "Review a frozen contract", owner: { id: "parent", adapter: "codex", work: "Editing src", reads: ["src"], writes: ["src"] }, external: [], authorization: { delegate: true, basis: "user authorized review" }, tasks: [{ key: "review", prompt: "Review a.md", deliverable: "findings", acceptance: ["cite findings"], reads: ["a.md"], writes: [], depends_on: [] }] }));
  const args = ["--preload", join(import.meta.dir, "fixtures/mock-jev.ts"), cliFile, "plan", "--scope", scope, "--db", db, "--config", configFile];
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, OPENROUTER_API_KEY: "test-only", MOCK_JEV_COUNT_FILE: jevCount };
  const call = (extra: string[], override = env) => spawnSync(process.execPath, [...args, ...extra], { cwd: root, env: override, encoding: "utf8", timeout: 12_000 });
  const blocked = call(["--input", inputFile]);
  expect(blocked.status).toBe(2);
  expect(JSON.parse(blocked.stdout).status).toBe("blocked");
  writeFileSync(configFile, JSON.stringify(config("gpt-6-luna")));
  const noKey = call([], { ...env, OPENROUTER_API_KEY: "" });
  expect(noKey.status).toBe(2);
  expect(JSON.parse(noKey.stdout).error.code).toBe("missing_api_key");
  const recovered = call([]);
  expect(recovered.status).toBe(0);
  expect(JSON.parse(recovered.stdout).status).toBe("selected");
  expect(readFileSync(jevCount, "utf8").trim().split("\n")).toHaveLength(1);
});
