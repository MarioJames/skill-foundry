import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
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
