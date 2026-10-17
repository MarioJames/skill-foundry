import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, EFFORTS, type Config, loadSchema, parseUntil, run, validateConfig } from "../scripts/agents-config.ts";
import { lintSchema, validate } from "../scripts/lib/json-schema.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const tmp = () => { const root = mkdtempSync(join(tmpdir(), "agents-config-")); roots.push(root); return root; };
const base = (): any => JSON.parse(readFileSync(DEFAULT_CONFIG, "utf8"));
const NOW = "2026-10-16T12:00:00Z";

/** Fixture: temp config + state with an injected clock. */
function fixture(mutate: (config: any) => void = () => {}) {
  const root = tmp();
  const config = base(); mutate(config);
  const configFile = join(root, "config.json");
  const stateFile = join(root, "state", "availability.json");
  writeFileSync(configFile, JSON.stringify(config));
  const cli = (args: string[], now = NOW) => {
    const result = run([...args, "--config", configFile, "--state", stateFile], { AGENTS_COOPERATION_NOW: now });
    return { ...result, json: result.stdout ? JSON.parse(result.stdout) : undefined };
  };
  return { root, configFile, stateFile, cli };
}
const paths = (config: unknown) => validateConfig(config).map(i => i.path);
const enableGrok = (c: any) => {
  c.engines.grok.enabled = true; c.owners.grok_owner.enabled = true; c.agents.grok_worker.enabled = true;
};
const enablePi = (c: any) => { c.engines.pi.enabled = true; c.agents.pi_worker.enabled = true; };

// ---- schema and structure ----
test("default config and both schemas load and validate", () => {
  expect(validateConfig(base())).toEqual([]);
  lintSchema(loadSchema(join(DEFAULT_CONFIG, "..", "config.schema.json")));
  lintSchema(loadSchema(join(DEFAULT_CONFIG, "..", "availability.schema.json")));
  expect(run(["validate", "--config", DEFAULT_CONFIG], {}).code).toBe(0);
});
test("validator rejects unsupported schema keywords and implements the used ones", () => {
  expect(() => lintSchema({ type: "object", oneOf: [] })).toThrow(/oneOf/);
  const schema = { type: "object", required: ["a"], additionalProperties: false, properties: { a: { type: "integer", minimum: 2 }, b: { enum: ["x"] }, c: { type: "array", uniqueItems: true, minItems: 1, items: { type: "string", minLength: 1 } } } };
  const issues = validate(schema, { a: 1, b: "y", c: ["", "", "q"], z: 0 });
  expect(issues.map(i => i.path).sort()).toEqual(["$.a", "$.b", "$.c[0]", "$.c[1]", "$.c[1]", "$.z"].sort());
  expect(validate(schema, {}).map(i => i.path)).toEqual(["$.a"]);
});
test("structural errors carry JSON paths", () => {
  const unknown = base(); unknown.engines.claude.extra = 1;
  expect(paths(unknown)).toEqual(["$.engines.claude.extra"]);
  const kind = base(); kind.engines.claude.kind = "nope";
  expect(new Set(paths(kind))).toEqual(new Set(["$.engines.claude.kind"]));
  const missing = base(); delete missing.owners.claude_owner.max_parallel;
  expect(validateConfig(missing)).toEqual([{ path: "$.owners.claude_owner.max_parallel", message: "required property missing" }]);
  const removed = base(); removed.limits = { max_parallel: 6 };
  expect(paths(removed)).toEqual(["$.limits"]);
  const engineCap = base(); engineCap.engines.claude.max_parallel = 2;
  expect(paths(engineCap)).toEqual(["$.engines.claude.max_parallel"]);
  const zero = base(); zero.owners.claude_owner.max_parallel = 0;
  expect(paths(zero)).toEqual(["$.owners.claude_owner.max_parallel"]);
  const id = base(); id.engines.Bad = id.engines.claude;
  expect(paths(id)).toContain("$.engines.Bad");
});
test("agent ids must end with _worker", () => {
  const config = base(); config.agents.helper = config.agents.pi_worker;
  expect(paths(config)).toContain("$.agents.helper");
  const owner = base(); owner.owners.claude_owner.workers = ["claude_worker", "helper"];
  expect(paths(owner)).toContain("$.owners.claude_owner.workers[1]");
});
test("native_subagents is limited to claude, codex and grok", () => {
  const config = base(); config.engines.pi.native_subagents = true;
  expect(paths(config)).toEqual(["$.engines.pi.kind"]);
  const grok = base(); grok.engines.grok.native_subagents = true;
  expect(paths(grok)).toEqual([]);
});
test("workers list must be non-empty and unique", () => {
  const empty = base(); empty.owners.claude_owner.workers = [];
  expect(paths(empty)).toEqual(["$.owners.claude_owner.workers"]);
  const dup = base(); dup.owners.claude_owner.workers = ["claude_worker", "claude_worker"];
  expect(paths(dup)).toEqual(["$.owners.claude_owner.workers[1]"]);
});

// ---- semantics ----
test("effort is checked per engine kind from a single table", () => {
  expect(Object.keys(EFFORTS).sort()).toEqual(["claude", "codex", "grok", "pi"]);
  const claude = base(); claude.agents.claude_worker.effort = "minimal";
  expect(paths(claude)).toEqual(["$.agents.claude_worker.effort"]);
  const codex = base(); codex.agents.codex_worker.effort = "minimal";
  expect(paths(codex)).toEqual([]);
  const pi = base(); pi.agents.pi_worker.effort = "off";
  expect(paths(pi)).toEqual([]);
  const grok = base(); grok.agents.grok_worker.effort = "none";
  expect(paths(grok)).toEqual([]);
  const owner = base(); owner.owners.codex_owner.effort = "bogus";
  expect(paths(owner)).toEqual(["$.owners.codex_owner.effort"]);
  const other = base(); other.engines.pi.kind = "kimi"; other.agents.pi_worker.effort = "whatever";
  expect(paths(other)).toEqual([]);
});
test("dangling references are reported", () => {
  const owner = base(); owner.owners.claude_owner.engine = "ghost";
  expect(paths(owner)).toEqual(["$.owners.claude_owner.engine"]);
  const agent = base(); agent.agents.pi_worker.engine = "ghost";
  expect(paths(agent)).toEqual(["$.agents.pi_worker.engine"]);
  const workers = base(); workers.owners.claude_owner.workers.push("ghost_worker");
  expect(paths(workers)).toEqual(["$.owners.claude_owner.workers[3]"]);
});
test("enabled owner needs a native engine, an enabled engine and a usable class=worker agent", () => {
  const native = base(); native.engines.claude.native_subagents = false;
  expect(paths(native)).toEqual(["$.owners.claude_owner.engine"]);
  const disabled = base(); disabled.engines.claude.enabled = false;
  expect(paths(disabled)).toContain("$.owners.claude_owner.engine");
  const noWorker = base(); noWorker.owners.claude_owner.workers = ["pi_worker"]; enablePi(noWorker);
  expect(paths(noWorker)).toEqual(["$.owners.claude_owner.workers"]);
  const offline = base(); offline.agents.claude_worker.enabled = false; offline.agents.codex_worker.enabled = false;
  expect(paths(offline)).toEqual(["$.owners.claude_owner.workers", "$.owners.codex_owner.workers"]);
  const disabledOwner = base(); disabledOwner.owners.grok_owner.workers = ["pi_worker"];
  expect(paths(disabledOwner)).toEqual([]);
});
test("each engine has at most one enabled owner", () => {
  const config = base();
  config.owners.claude_owner_2 = { ...config.owners.claude_owner };
  expect(paths(config)).toEqual(["$.owners.claude_owner_2"]);
  config.owners.claude_owner_2.enabled = false;
  expect(paths(config)).toEqual([]);
});
test("CLI validate prints every error with its path and exits non-zero", () => {
  const f = fixture(c => { c.engines.claude.extra = 1; c.owners.claude_owner.max_parallel = 0; });
  const result = f.cli(["validate"]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("$.engines.claude.extra");
  expect(result.stderr).toContain("$.owners.claude_owner.max_parallel");
  expect(result.stdout).toBe("");
  const semantic = fixture(c => { c.agents.codex_worker.effort = "minimal"; c.agents.claude_worker.effort = "minimal"; c.agents.pi_worker.engine = "ghost"; }).cli(["validate"]);
  expect(semantic.code).toBe(1);
  expect(semantic.stderr).toContain("$.agents.claude_worker.effort");
  expect(semantic.stderr).toContain("$.agents.pi_worker.engine");
});

// ---- resolve ----
test("resolve: claude and codex native dispatch", () => {
  const f = fixture();
  const claude = f.cli(["resolve", "--owner", "claude_owner", "--agent", "claude_worker"]);
  expect(claude.json).toMatchObject({ dispatch: "native", tool: "Agent", params: { model: "sonnet", effort: "high", subagent_type: "general-purpose" }, warnings: [] });
  const codex = f.cli(["resolve", "--owner", "codex_owner", "--agent", "codex_worker"]);
  expect(codex.json).toMatchObject({ dispatch: "native", tool: "spawn_agent", params: { model: "gpt-6.1-sol", reasoning_effort: "high", fork_turns: "none" } });
});
test("resolve: cross-engine worker is a herdr interactive pane for each kind", () => {
  const f = fixture(c => { enableGrok(c); enablePi(c); c.agents.pi_worker.class = "worker"; });
  const interactive = (owner: string, agent: string) => f.cli(["resolve", "--owner", owner, "--agent", agent]).json;
  expect(interactive("claude_owner", "codex_worker")).toMatchObject({ dispatch: "herdr", mode: "interactive", kind: "codex", argv: ["-m", "gpt-6.1-sol", "-c", "model_reasoning_effort=high"] });
  expect(interactive("codex_owner", "claude_worker")).toMatchObject({ kind: "claude", argv: ["--model", "sonnet", "--effort", "high", "--permission-mode", "bypassPermissions"] });
  expect(interactive("claude_owner", "pi_worker")).toMatchObject({ kind: "pi", argv: ["--model", "cc-switch-agentplan/deepseek-v4.1-flash", "--thinking", "medium"] });
  expect(interactive("claude_owner", "grok_worker")).toMatchObject({ kind: "grok", argv: ["-m", "grok-4.7", "--effort", "high", "--permission-mode", "bypassPermissions"] });
});
test("resolve: unsupported kinds have no launch argv", () => {
  const f = fixture(c => { enablePi(c); c.engines.pi.kind = "kimi"; c.agents.pi_worker.effort = "x"; });
  const result = f.cli(["resolve", "--owner", "claude_owner", "--class", "task"]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("kimi");
  const worker = fixture(c => { enablePi(c); c.engines.pi.kind = "kimi"; c.agents.pi_worker.class = "worker"; c.agents.pi_worker.effort = "x"; });
  expect(worker.cli(["resolve", "--owner", "claude_owner", "--agent", "pi_worker"]).stderr).toContain("kimi");
});
test("resolve: task agents run one-shot through herdr", () => {
  const f = fixture(c => { enablePi(c); enableGrok(c); c.owners.claude_owner.workers.push("grok_worker"); c.agents.grok_worker.class = "task"; c.agents.codex_worker.class = "task"; });
  const pi = f.cli(["resolve", "--owner", "claude_owner", "--agent", "pi_worker"]).json;
  expect(pi).toMatchObject({ dispatch: "herdr", mode: "oneshot", kind: "pi", task_file_placeholder: "{task_file}" });
  expect(pi.argv).toEqual(["pi", "-p", "--mode", "json", "--no-session", "--model", "cc-switch-agentplan/deepseek-v4.1-flash", "--thinking", "medium", "@{task_file}"]);
  expect(pi.stdin).toBeUndefined();
  const codex = f.cli(["resolve", "--owner", "claude_owner", "--agent", "codex_worker"]).json;
  expect(codex).toMatchObject({ mode: "oneshot", stdin: "{task_file}", argv: ["codex", "exec", "-m", "gpt-6.1-sol", "-c", "model_reasoning_effort=high", "-"] });
  const grok = f.cli(["resolve", "--owner", "claude_owner", "--agent", "grok_worker"]).json;
  expect(grok.argv).toEqual(["grok", "--prompt-file", "{task_file}", "-m", "grok-4.7", "--effort", "high", "--permission-mode", "bypassPermissions", "--output-format", "json"]);
  expect(grok.argv).not.toContain("-p");
  // same-engine task agents are still one-shot, never native
  const same = f.cli(["resolve", "--owner", "claude_owner", "--agent", "claude_worker"]);
  expect(same.json.dispatch).toBe("native");
  const sameTask = fixture(c => { c.agents.claude_worker.class = "task"; });
  expect(sameTask.cli(["resolve", "--owner", "claude_owner", "--agent", "claude_worker"]).json).toMatchObject({ dispatch: "herdr", mode: "oneshot", stdin: "{task_file}", argv: ["claude", "-p", "--model", "sonnet", "--effort", "high", "--permission-mode", "bypassPermissions"] });
});
test("resolve: grok native dispatch warns that effort is inherited", () => {
  const f = fixture(c => { enableGrok(c); });
  const result = f.cli(["resolve", "--owner", "grok_owner", "--agent", "grok_worker"]).json;
  expect(result).toMatchObject({ dispatch: "native", tool: "spawn_subagent", params: { model: "grok-4.7", subagent_type: "general-purpose" } });
  expect(result.params.effort).toBeUndefined();
  expect(result.warnings).toEqual(["grok spawn_subagent 不支持按次设置 effort，子 agent 沿用 owner 会话的 effort"]);
});
test("resolve: disabled owner, agent and engine are rejected", () => {
  const f = fixture();
  expect(f.cli(["resolve", "--owner", "grok_owner", "--agent", "claude_worker"])).toMatchObject({ code: 1 });
  expect(f.cli(["resolve", "--owner", "grok_owner", "--agent", "claude_worker"]).stderr).toContain("disabled");
  expect(f.cli(["resolve", "--owner", "claude_owner", "--agent", "pi_worker"]).stderr).toContain("disabled");
  const engine = fixture(c => { c.agents.pi_worker.enabled = true; });
  expect(engine.cli(["resolve", "--owner", "claude_owner", "--agent", "pi_worker"]).stderr).toContain("engine_disabled");
  expect(f.cli(["resolve", "--owner", "ghost", "--agent", "claude_worker"]).stderr).toContain("unknown owner");
  expect(f.cli(["resolve", "--owner", "claude_owner", "--agent", "ghost_worker"]).stderr).toContain("unknown agent");
  expect(f.cli(["resolve", "--owner", "claude_owner"]).code).toBe(1);
  expect(f.cli(["resolve", "--owner", "claude_owner", "--agent", "claude_worker", "--class", "worker"]).code).toBe(1);
});
test("resolve: agent outside the owner's workers list works with a warning", () => {
  const f = fixture(c => { c.owners.claude_owner.workers = ["claude_worker"]; });
  const result = f.cli(["resolve", "--owner", "claude_owner", "--agent", "codex_worker"]).json;
  expect(result.dispatch).toBe("herdr");
  expect(result.warnings).toHaveLength(1);
  expect(result.warnings[0]).toContain("codex_worker");
});
test("resolve --owner --peer builds the collaborating owner's interactive argv", () => {
  const f = fixture(c => { enableGrok(c); });
  expect(f.cli(["resolve", "--owner", "codex_owner", "--peer", "claude_owner"]).json).toMatchObject({
    dispatch: "herdr", mode: "interactive", role: "peer_owner", kind: "claude", peer: "claude_owner",
    argv: ["--model", "claude-opus-5-5", "--effort", "high", "--permission-mode", "bypassPermissions"],
  });
  expect(f.cli(["resolve", "--owner", "claude_owner", "--peer", "codex_owner"]).json.argv).toEqual(["-m", "gpt-6-astra", "-c", "model_reasoning_effort=high"]);
  expect(f.cli(["resolve", "--owner", "claude_owner", "--peer", "grok_owner"]).json.argv).toEqual(["-m", "grok-4.7", "--effort", "high", "--permission-mode", "bypassPermissions"]);
  expect(f.cli(["resolve", "--owner", "claude_owner", "--peer", "claude_owner"]).code).toBe(1);
  expect(f.cli(["resolve", "--owner", "claude_owner", "--peer", "ghost"]).stderr).toContain("unknown peer owner");
  const disabled = fixture();
  expect(disabled.cli(["resolve", "--owner", "claude_owner", "--peer", "grok_owner"]).stderr).toContain("disabled");
});

// ---- block / unblock / status ----
test("block writes a state file atomically and replaces the same (engine, model)", () => {
  const f = fixture();
  const first = f.cli(["block", "--engine", "codex", "--model", "gpt-6.1-sol", "--reason", "usage limit", "--until", "2026-10-17T03:00:00-04:00", "--by", "claude_owner"]);
  expect(first.code).toBe(0);
  expect(first.json.block).toEqual({ engine: "codex", model: "gpt-6.1-sol", reason: "usage limit", since: "2026-10-16T12:00:00.000Z", until: "2026-10-17T03:00:00-04:00", by: "claude_owner" });
  f.cli(["block", "--engine", "codex", "--model", "gpt-6.1-sol", "--reason", "again", "--until", "+3h"]);
  f.cli(["block", "--engine", "claude", "--reason", "account quota"]);
  const state = JSON.parse(readFileSync(f.stateFile, "utf8"));
  expect(state.version).toBe(1);
  expect(state.blocks).toHaveLength(2);
  expect(state.blocks[0]).toMatchObject({ engine: "codex", reason: "again", until: "2026-10-16T15:00:00.000Z" });
  expect(state.blocks[1].until).toBeUndefined();
  expect(readdirSync(join(f.root, "state"))).toEqual(["availability.json"]);
  expect(f.cli(["block", "--engine", "ghost", "--reason", "x"]).code).toBe(1);
  expect(f.cli(["block", "--engine", "codex"]).code).toBe(1);
  expect(f.cli(["block", "--engine", "codex", "--reason", "x", "--until", "2026-10-16T11:00:00Z"]).stderr).toContain("future");
  expect(f.cli(["block", "--engine", "codex", "--reason", "x", "--until", "tomorrow"]).code).toBe(1);
});
test("relative --until parsing", () => {
  const now = Date.parse(NOW);
  expect(parseUntil("+2h", now)).toBe("2026-10-16T14:00:00.000Z");
  expect(parseUntil("+30m", now)).toBe("2026-10-16T12:30:00.000Z");
  expect(parseUntil("+1d", now)).toBe("2026-10-17T12:00:00.000Z");
  expect(parseUntil("2026-10-17T03:00:00-04:00", now)).toBe("2026-10-17T03:00:00-04:00");
  expect(() => parseUntil("+2w", now)).toThrow();
});
test("model-level block affects only that model and the owner running it", () => {
  const f = fixture();
  f.cli(["block", "--engine", "codex", "--model", "gpt-6.1-sol", "--reason", "limit"]);
  const status = f.cli(["status"]).json;
  expect(status.agents.codex_worker).toMatchObject({ status: "blocked", engine: "codex", model: "gpt-6.1-sol", reason: "limit" });
  expect(status.agents.claude_worker).toEqual({ status: "available" });
  expect(status.owners.codex_owner).toEqual({ status: "available" });
  f.cli(["block", "--engine", "codex", "--model", "gpt-6-astra", "--reason", "owner limit"]);
  expect(f.cli(["status"]).json.owners.codex_owner.status).toBe("blocked");
  const refused = f.cli(["resolve", "--owner", "codex_owner", "--agent", "claude_worker"]);
  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain("owner codex_owner unavailable");
  expect(f.cli(["resolve", "--owner", "claude_owner", "--agent", "claude_worker"]).code).toBe(0);
});
test("engine-level block makes every owner and agent on the engine unavailable", () => {
  const f = fixture();
  f.cli(["block", "--engine", "codex", "--reason", "account quota"]);
  const status = f.cli(["status"]).json;
  expect(status.owners.codex_owner.status).toBe("blocked");
  expect(status.agents.codex_worker.status).toBe("blocked");
  expect(status.owners.claude_owner.status).toBe("available");
  expect(status.agents.pi_worker.status).toBe("disabled");
  const show = f.cli(["show"]).json;
  expect(show.config.owners.codex_owner.availability.status).toBe("blocked");
  expect(show.config.agents.claude_worker.availability).toEqual({ status: "available" });
  expect(show.config.owners.claude_owner.workers).toEqual(["claude_worker", "codex_worker", "pi_worker"]);
  expect(f.cli(["resolve", "--owner", "claude_owner", "--agent", "codex_worker"]).code).toBe(1);
});
test("expired blocks are ignored on read and purged on the next write", () => {
  const f = fixture();
  f.cli(["block", "--engine", "codex", "--reason", "limit", "--until", "+2h"]);
  const early = f.cli(["status"], "2026-10-16T13:59:59Z").json;
  expect(early.blocks).toHaveLength(1);
  expect(early.agents.codex_worker.status).toBe("blocked");
  const late = f.cli(["status"], "2026-10-16T14:00:00Z").json;
  expect(late.blocks).toEqual([]);
  expect(late.agents.codex_worker).toEqual({ status: "available" });
  expect(f.cli(["resolve", "--owner", "claude_owner", "--agent", "codex_worker"], "2026-10-16T15:00:00Z").code).toBe(0);
  // reading does not rewrite the file
  expect(JSON.parse(readFileSync(f.stateFile, "utf8")).blocks).toHaveLength(1);
  const write = f.cli(["block", "--engine", "claude", "--reason", "other"], "2026-10-16T15:00:00Z");
  expect(write.json.purged_expired).toBe(1);
  expect(JSON.parse(readFileSync(f.stateFile, "utf8")).blocks.map((b: any) => b.engine)).toEqual(["claude"]);
});
test("unblock removes exactly the matching entry", () => {
  const f = fixture();
  f.cli(["block", "--engine", "codex", "--reason", "a"]);
  f.cli(["block", "--engine", "codex", "--model", "gpt-6.1-sol", "--reason", "b"]);
  expect(f.cli(["unblock", "--engine", "codex", "--model", "other"]).json.removed).toBe(0);
  expect(f.cli(["unblock", "--engine", "codex", "--model", "gpt-6.1-sol"]).json.removed).toBe(1);
  expect(JSON.parse(readFileSync(f.stateFile, "utf8")).blocks.map((b: any) => b.model)).toEqual([undefined]);
  expect(f.cli(["unblock", "--engine", "codex"]).json.removed).toBe(1);
  expect(f.cli(["status"]).json.blocks).toEqual([]);
  expect(f.cli(["unblock", "--engine", "codex"]).json.removed).toBe(0);
});
test("missing state file means no blocks and is not created by reads", () => {
  const f = fixture();
  expect(f.cli(["status"]).json.blocks).toEqual([]);
  expect(existsSync(f.stateFile)).toBe(false);
});
test("invalid state file is reported with paths", () => {
  const f = fixture();
  f.cli(["block", "--engine", "codex", "--reason", "a"]);
  writeFileSync(f.stateFile, JSON.stringify({ version: 1, blocks: [{ engine: "codex", reason: "", since: "yesterday" }] }));
  const result = f.cli(["status"]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("$.blocks[0].reason");
  expect(result.stderr).toContain("$.blocks[0].since");
  writeFileSync(f.stateFile, JSON.stringify({ version: 1, blocks: [{ engine: "codex", reason: "a", since: NOW }, { engine: "codex", reason: "b", since: NOW }] }));
  expect(f.cli(["status"]).stderr).toContain("duplicate");
});
test("resolve --class picks the first available candidate and falls over when blocked", () => {
  const f = fixture();
  expect(f.cli(["resolve", "--owner", "claude_owner", "--class", "worker"]).json).toMatchObject({ agent: "claude_worker", selected_by: "class", skipped: [] });
  f.cli(["block", "--engine", "claude", "--model", "sonnet", "--reason", "limit"]);
  const next = f.cli(["resolve", "--owner", "claude_owner", "--class", "worker"]).json;
  expect(next).toMatchObject({ agent: "codex_worker", dispatch: "herdr", mode: "interactive" });
  expect(next.skipped).toEqual([{ agent: "claude_worker", reason: "blocked (claude/sonnet: limit)" }]);
  // After the reset time the first choice is back with no manual unblock.
  f.cli(["block", "--engine", "claude", "--model", "sonnet", "--reason", "limit", "--until", "+1h"]);
  expect(f.cli(["resolve", "--owner", "claude_owner", "--class", "worker"], "2026-10-16T13:00:01Z").json.agent).toBe("claude_worker");
});
test("resolve --class lists every unavailable candidate and exits non-zero", () => {
  const f = fixture(c => { enablePi(c); c.owners.claude_owner.workers = ["pi_worker", "codex_worker", "claude_worker"]; });
  f.cli(["block", "--engine", "codex", "--reason", "account quota"]);
  f.cli(["block", "--engine", "claude", "--model", "sonnet", "--reason", "limit"]);
  const result = f.cli(["resolve", "--owner", "claude_owner", "--class", "worker"]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("codex_worker: blocked (codex: account quota)");
  expect(result.stderr).toContain("claude_worker: blocked (claude/sonnet: limit)");
  expect(result.stdout).toBe("");
  const task = f.cli(["resolve", "--owner", "claude_owner", "--class", "task"]);
  expect(task.json).toMatchObject({ agent: "pi_worker", mode: "oneshot" });
  const none = fixture();
  expect(none.cli(["resolve", "--owner", "claude_owner", "--class", "task"]).stderr).toContain("pi_worker: disabled");
});

// ---- process-level behaviour ----
test("CLI entry point: shebang, stdout JSON, stderr and exit code, with env-injected paths", () => {
  const f = fixture();
  const env = { ...process.env, AGENTS_COOPERATION_CONFIG: f.configFile, AGENTS_COOPERATION_STATE: f.stateFile, AGENTS_COOPERATION_NOW: NOW };
  const script = join(DEFAULT_CONFIG, "..", "..", "scripts", "agents-config.ts");
  const ok = Bun.spawnSync({ cmd: [script, "block", "--engine", "pi", "--reason", "test"], env, stdout: "pipe", stderr: "pipe" });
  expect(ok.exitCode).toBe(0);
  expect(JSON.parse(ok.stdout.toString()).block.engine).toBe("pi");
  const bad = Bun.spawnSync({ cmd: [script, "resolve", "--owner", "nobody", "--agent", "claude_worker"], env, stdout: "pipe", stderr: "pipe" });
  expect(bad.exitCode).toBe(1);
  expect(bad.stdout.toString()).toBe("");
  expect(bad.stderr.toString()).toContain("unknown owner nobody");
  expect(JSON.parse(readFileSync(f.stateFile, "utf8")).blocks).toHaveLength(1);
  const usage = Bun.spawnSync({ cmd: [script, "bogus"], env, stdout: "pipe", stderr: "pipe" });
  expect(usage.exitCode).toBe(1);
});
test("default config source is reported when no user config exists", () => {
  const home = tmp();
  const result = run(["validate"], { HOME: home });
  // homedir() follows HOME on POSIX, so the real ~/.config is never read here.
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, source: "default", path: DEFAULT_CONFIG });
});
