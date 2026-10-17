import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, EFFORTS, type Config, addDuration, loadSchema, parseReleaseAt, run, validateConfig } from "../scripts/agents-config.ts";
import { lintSchema, validate } from "../scripts/lib/json-schema.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const tmp = () => { const root = mkdtempSync(join(tmpdir(), "agents-config-")); roots.push(root); return root; };
const base = (): any => JSON.parse(readFileSync(DEFAULT_CONFIG, "utf8"));
const NOW = "2026-10-16T12:00:00Z";

/** Fixture: temp config + state + HOME (so opencode's remembered variants are never read from the real home) with an injected clock. */
function fixture(mutate: (config: any) => void = () => {}) {
  const root = tmp();
  const config = base(); mutate(config);
  const configFile = join(root, "config.json");
  const stateFile = join(root, "state", "availability.json");
  const home = join(root, "home");
  writeFileSync(configFile, JSON.stringify(config));
  const cli = (args: string[], now = NOW) => {
    const result = run([...args, "--config", configFile, "--state", stateFile], { AGENTS_COOPERATION_NOW: now, HOME: home });
    return { ...result, json: result.stdout ? JSON.parse(result.stdout) : undefined };
  };
  return { root, home, configFile, stateFile, cli };
}
const paths = (config: unknown) => validateConfig(config).map(i => i.path);
const enableGrok = (c: any) => {
  c.engines.grok.enabled = true; c.workers.grok_worker.enabled = true;
};
const enableOpencode = (c: any) => { c.engines.opencode.enabled = true; c.workers.opencode_worker.enabled = true; };
const OPENCODE_ARGV = ["-m", "opencode/glm-5.3-flash-free", "--auto"];
/** Writes the opencode TUI's remembered per-model variants under the fixture HOME. */
const rememberVariants = (home: string, variant: Record<string, string>) => {
  const dir = join(home, ".local", "state", "opencode");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "model.json"), JSON.stringify({ recent: [], favorite: [], variant }));
};
/** Everything enabled, so tag routing sees all five workers. */
const enableQoder = (c: any) => { c.engines.qoder.enabled = true; c.workers.qoder_worker.enabled = true; };
const enableAll = (c: any) => { enableGrok(c); enableOpencode(c); enableQoder(c); };
/** Drops every block_ttl so a block without --release-at stays until unblock (keeps skip reasons free of release_at). */
const noTtl = (c: any) => { for (const e of Object.values<any>(c.engines)) delete e.block_ttl; };
const CODEX_BYPASS = "--dangerously-bypass-approvals-and-sandbox";

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
test("class and prefer_task are no longer fields", () => {
  const worker = base(); worker.workers.claude_worker.class = "worker";
  expect(paths(worker)).toEqual(["$.workers.claude_worker.class"]);
  const owner = base(); owner.owners.claude_owner.prefer_task = true;
  expect(paths(owner)).toEqual(["$.owners.claude_owner.prefer_task"]);
});
test("worker ids must end with _worker", () => {
  const config = base(); config.workers.helper = config.workers.opencode_worker;
  expect(paths(config)).toContain("$.workers.helper");
  const owner = base(); owner.owners.claude_owner.workers = ["claude_worker", "helper"];
  expect(paths(owner)).toContain("$.owners.claude_owner.workers[1]");
});
test("legacy top-level agents field is rejected as unknown", () => {
  const config = base(); config.agents = config.workers; delete config.workers;
  expect(paths(config)).toContain("$.agents");
  expect(paths(config)).toContain("$.workers");
});
test("native_subagents is limited to claude and codex", () => {
  const config = base(); config.engines.opencode.native_subagents = true;
  expect(paths(config)).toEqual(["$.engines.opencode.kind"]);
  const grok = base(); grok.engines.grok.native_subagents = true;
  expect(paths(grok)).toEqual(["$.engines.grok.kind"]);
  expect(base().engines.grok.native_subagents).toBe(false);
  expect(base().owners.grok_owner).toBeUndefined();
});
test("workers list must be non-empty and unique", () => {
  const empty = base(); empty.owners.claude_owner.workers = [];
  expect(paths(empty)).toEqual(["$.owners.claude_owner.workers"]);
  const dup = base(); dup.owners.claude_owner.workers = ["claude_worker", "claude_worker"];
  expect(paths(dup)).toEqual(["$.owners.claude_owner.workers[1]"]);
});

// ---- semantics ----
test("effort is checked per engine kind from a single table", () => {
  expect(Object.keys(EFFORTS).sort()).toEqual(["claude", "codex", "grok", "qodercli"]);
  const claude = base(); claude.workers.claude_worker.effort = "minimal";
  expect(paths(claude)).toEqual(["$.workers.claude_worker.effort"]);
  const codex = base(); codex.workers.codex_worker.effort = "minimal";
  expect(paths(codex)).toEqual([]);
  const opencode = base(); opencode.workers.opencode_worker.effort = "low";
  expect(paths(opencode)).toEqual([]);
  const free = base(); free.workers.opencode_worker.effort = "whatever-variant";
  expect(paths(free)).toEqual([]);
  const qoder = base(); qoder.workers.qoder_worker.effort = "ultracode";
  expect(paths(qoder)).toEqual([]);
  const qoderBad = base(); qoderBad.workers.qoder_worker.effort = "minimal";
  expect(paths(qoderBad)).toEqual(["$.workers.qoder_worker.effort"]);
  const grok = base(); grok.workers.grok_worker.effort = "none";
  expect(paths(grok)).toEqual([]);
  const owner = base(); owner.owners.codex_owner.effort = "bogus";
  expect(paths(owner)).toEqual(["$.owners.codex_owner.effort"]);
});
test("dangling references are reported", () => {
  const owner = base(); owner.owners.claude_owner.engine = "ghost";
  expect(paths(owner)).toEqual(["$.owners.claude_owner.engine"]);
  const worker = base(); worker.workers.opencode_worker.engine = "ghost";
  expect(paths(worker)).toEqual(["$.workers.opencode_worker.engine"]);
  const workers = base(); workers.owners.claude_owner.workers.push("ghost_worker");
  expect(paths(workers)).toEqual(["$.owners.claude_owner.workers[5]"]);
  const enabledButEngineOff = base(); enabledButEngineOff.owners.claude_owner.workers = ["opencode_worker"]; enabledButEngineOff.workers.opencode_worker.enabled = true;
  expect(paths(enabledButEngineOff)).toEqual(["$.owners.claude_owner.workers"]);
});
test("every owner needs a native engine; enabled owners also need an enabled engine and a usable worker", () => {
  const native = base(); native.engines.claude.native_subagents = false;
  expect(paths(native)).toEqual(["$.owners.claude_owner.engine"]);
  const disabled = base(); disabled.engines.claude.enabled = false;
  expect(paths(disabled)).toContain("$.owners.claude_owner.engine");
  const noWorker = base(); noWorker.owners.claude_owner.workers = ["opencode_worker"];
  expect(paths(noWorker)).toEqual(["$.owners.claude_owner.workers"]);
  const offline = base(); offline.workers.claude_worker.enabled = false; offline.workers.codex_worker.enabled = false;
  expect(paths(offline)).toEqual(["$.owners.claude_owner.workers", "$.owners.codex_owner.workers"]);
  const grokOwner = base(); enableGrok(grokOwner); grokOwner.owners.grok_owner = { enabled: true, engine: "grok", model: "grok-4.7", effort: "high", workers: ["grok_worker"], max_parallel: 1 };
  expect(paths(grokOwner)).toEqual(["$.owners.grok_owner.engine"]);
  // The native_subagents rule applies to disabled owners too, whether or not the engine is enabled.
  for (const engineOn of [true, false]) {
    const off = base(); off.engines.grok.enabled = engineOn;
    off.owners.grok_owner = { enabled: false, engine: "grok", model: "grok-4.7", effort: "high", workers: ["grok_worker"], max_parallel: 1 };
    expect(paths(off)).toEqual(["$.owners.grok_owner.engine"]);
  }
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
  const semantic = fixture(c => { c.workers.codex_worker.effort = "minimal"; c.workers.claude_worker.effort = "minimal"; c.workers.opencode_worker.engine = "ghost"; }).cli(["validate"]);
  expect(semantic.code).toBe(1);
  expect(semantic.stderr).toContain("$.workers.claude_worker.effort");
  expect(semantic.stderr).toContain("$.workers.opencode_worker.engine");
});

// ---- resolve ----
test("resolve: claude and codex native dispatch", () => {
  const f = fixture();
  const claude = f.cli(["resolve", "--owner", "claude_owner", "--worker", "claude_worker"]);
  expect(claude.json).toMatchObject({ dispatch: "native", tool: "Agent", params: { model: "sonnet", effort: "high", subagent_type: "general-purpose" }, warnings: [] });
  const codex = f.cli(["resolve", "--owner", "codex_owner", "--worker", "codex_worker"]);
  expect(codex.json).toMatchObject({ dispatch: "native", tool: "spawn_agent", params: { model: "gpt-6.1-sol", reasoning_effort: "high", fork_turns: "none" } });
});
test("resolve: cross-engine worker is a herdr interactive pane for each kind", () => {
  const f = fixture(c => { enableGrok(c); enableQoder(c); enableOpencode(c); });
  rememberVariants(f.home, { "opencode/glm-5.3-flash-free": "max" });
  const interactive = (owner: string, worker: string) => f.cli(["resolve", "--owner", owner, "--worker", worker]).json;
  expect(interactive("claude_owner", "codex_worker")).toMatchObject({ dispatch: "herdr", mode: "interactive", kind: "codex", argv: ["-m", "gpt-6.1-sol", "-c", "model_reasoning_effort=high", CODEX_BYPASS] });
  expect(interactive("claude_owner", "qoder_worker")).toMatchObject({ dispatch: "herdr", mode: "interactive", kind: "qodercli", argv: ["-m", "Qwen3.8-Flash", "--reasoning-effort", "xhigh", "--permission-mode", "bypass_permissions"] });
  expect(interactive("codex_owner", "claude_worker")).toMatchObject({ kind: "claude", argv: ["--model", "sonnet", "--effort", "high", "--permission-mode", "bypassPermissions"] });
  expect(interactive("claude_owner", "grok_worker")).toMatchObject({ kind: "grok", argv: ["-m", "grok-4.7", "--effort", "high", "--permission-mode", "bypassPermissions"] });
  expect(interactive("claude_owner", "opencode_worker")).toMatchObject({ dispatch: "herdr", mode: "interactive", kind: "opencode", argv: OPENCODE_ARGV, warnings: [] });
});
test("every heterogeneous launch argv carries its kind's explicit no-approval flag", () => {
  const f = fixture(enableAll);
  const argv = (owner: string, worker: string) => f.cli(["resolve", "--owner", owner, "--worker", worker]).json.argv as string[];
  const pair = (a: string[], flag: string, value: string) => a[a.indexOf(flag) + 1] === value && a.includes(flag);
  expect(pair(argv("codex_owner", "claude_worker"), "--permission-mode", "bypassPermissions")).toBe(true);
  expect(argv("claude_owner", "codex_worker")).toContain(CODEX_BYPASS);
  expect(pair(argv("claude_owner", "grok_worker"), "--permission-mode", "bypassPermissions")).toBe(true);
  expect(pair(argv("claude_owner", "qoder_worker"), "--permission-mode", "bypass_permissions")).toBe(true);
  expect(argv("claude_owner", "opencode_worker")).toContain("--auto");
  expect(argv("claude_owner", "qoder_worker")).toEqual(["-m", "Qwen3.8-Flash", "--reasoning-effort", "xhigh", "--permission-mode", "bypass_permissions"]);
});
test("every worker kind needs an interactive launch or native sub-agents", () => {
  const kimi = base(); kimi.engines.opencode.kind = "kimi";
  expect(validateConfig(kimi)).toEqual([{ path: "$.workers.opencode_worker.engine", message: "kind kimi supports neither interactive launch nor native sub-agents" }]);
  const cli = fixture(c => { enableOpencode(c); c.engines.opencode.kind = "kimi"; }).cli(["resolve", "--owner", "claude_owner", "--worker", "opencode_worker"]);
  expect(cli.code).toBe(1);
  expect(cli.stderr).toContain("$.workers.opencode_worker.engine");
  // claude/codex/grok/opencode/qodercli are all fine
  expect(paths(base())).toEqual([]);
});
test("resolve: opencode variant is verified against the TUI's remembered value without writing it", () => {
  const f = fixture(enableOpencode);
  const resolve = () => f.cli(["resolve", "--owner", "claude_owner", "--worker", "opencode_worker"]).json;
  const model = "opencode/glm-5.3-flash-free";
  // file missing: cannot verify
  const missing = resolve();
  expect(missing.argv).toEqual(OPENCODE_ARGV);
  expect(missing.warnings).toHaveLength(1);
  expect(missing.warnings[0]).toContain("无法核实 opencode variant");
  // consistent: no warning
  rememberVariants(f.home, { [model]: "max" });
  expect(resolve().warnings).toEqual([]);
  // inconsistent: warning carries the remembered value and the fix
  rememberVariants(f.home, { [model]: "high" });
  const wrong = resolve();
  expect(wrong.warnings).toHaveLength(1);
  expect(wrong.warnings[0]).toContain("记忆的 variant 为 high");
  expect(wrong.warnings[0]).toContain("切换一次 variant 为 max");
  // no entry for this model
  rememberVariants(f.home, { "opencode/other": "max" });
  expect(resolve().warnings[0]).toContain("未记忆");
  // unparseable file counts as unreadable
  writeFileSync(join(f.home, ".local", "state", "opencode", "model.json"), "{");
  expect(resolve().warnings[0]).toContain("无法核实");
  // the check is read-only
  rememberVariants(f.home, { [model]: "max" });
  const file = join(f.home, ".local", "state", "opencode", "model.json");
  const before = readFileSync(file, "utf8");
  resolve();
  expect(readFileSync(file, "utf8")).toBe(before);
  expect(readdirSync(join(f.home, ".local", "state", "opencode"))).toEqual(["model.json"]);
  // other kinds never touch it
  expect(f.cli(["resolve", "--owner", "claude_owner", "--worker", "codex_worker"]).json.warnings).toEqual([]);
});
test("resolve: grok worker is always a herdr interactive pane, never native", () => {
  const f = fixture(enableGrok);
  for (const owner of ["claude_owner", "codex_owner"]) {
    const result = f.cli(["resolve", "--owner", owner, "--worker", "grok_worker"]).json;
    expect(result).toMatchObject({ dispatch: "herdr", mode: "interactive", kind: "grok", argv: ["-m", "grok-4.7", "--effort", "high", "--permission-mode", "bypassPermissions"], warnings: [] });
    expect(result.tool).toBeUndefined();
  }
  expect(f.cli(["resolve", "--owner", "grok_owner", "--worker", "grok_worker"]).stderr).toContain("unknown owner");
});
test("resolve: disabled owner, worker and engine are rejected", () => {
  const f = fixture();
  const offline = fixture(c => { c.workers.codex_worker.enabled = false; });
  expect(offline.cli(["resolve", "--owner", "claude_owner", "--worker", "codex_worker"])).toMatchObject({ code: 1 });
  expect(offline.cli(["resolve", "--owner", "claude_owner", "--worker", "codex_worker"]).stderr).toContain("disabled");
  expect(f.cli(["resolve", "--owner", "claude_owner", "--worker", "opencode_worker"]).stderr).toContain("disabled");
  const engine = fixture(c => { c.workers.opencode_worker.enabled = true; });
  expect(engine.cli(["resolve", "--owner", "claude_owner", "--worker", "opencode_worker"]).stderr).toContain("engine_disabled");
  expect(f.cli(["resolve", "--owner", "ghost", "--worker", "claude_worker"]).stderr).toContain("unknown owner");
  expect(f.cli(["resolve", "--owner", "claude_owner", "--worker", "ghost_worker"]).stderr).toContain("unknown worker");
  const unknown = f.cli(["resolve", "--owner", "claude_owner", "--class", "worker"]);
  expect(unknown.code).toBe(2);
  expect(unknown.stderr).toContain("--class");
});
test("resolve: worker outside the owner's workers list works with a warning", () => {
  const f = fixture(c => { c.owners.claude_owner.workers = ["claude_worker"]; });
  const result = f.cli(["resolve", "--owner", "claude_owner", "--worker", "codex_worker"]).json;
  expect(result.dispatch).toBe("herdr");
  expect(result.warnings).toHaveLength(1);
  expect(result.warnings[0]).toContain("codex_worker");
});
test("resolve --owner --peer builds the collaborating owner's interactive argv", () => {
  const f = fixture();
  expect(f.cli(["resolve", "--owner", "codex_owner", "--peer", "claude_owner"]).json).toMatchObject({
    dispatch: "herdr", mode: "interactive", role: "peer_owner", kind: "claude", peer: "claude_owner",
    argv: ["--model", "claude-opus-5-5", "--effort", "high", "--permission-mode", "bypassPermissions"],
  });
  expect(f.cli(["resolve", "--owner", "claude_owner", "--peer", "codex_owner"]).json.argv).toEqual(["-m", "gpt-6-astra", "-c", "model_reasoning_effort=high", CODEX_BYPASS]);
  expect(f.cli(["resolve", "--owner", "claude_owner", "--peer", "claude_owner"]).code).toBe(1);
  expect(f.cli(["resolve", "--owner", "claude_owner", "--peer", "ghost"]).stderr).toContain("unknown peer owner");
  const disabled = fixture(c => { c.owners.codex_owner.enabled = false; });
  expect(disabled.cli(["resolve", "--owner", "claude_owner", "--peer", "codex_owner"]).stderr).toContain("disabled");
  expect(f.cli(["resolve", "--owner", "claude_owner", "--peer", "grok_owner"]).stderr).toContain("unknown peer owner");
});

// ---- block / unblock / status ----
test("block writes a state file atomically and replaces the same (engine, model)", () => {
  const f = fixture();
  const first = f.cli(["block", "--engine", "codex", "--model", "gpt-6.1-sol", "--reason", "usage limit", "--release-at", "2026-10-17T03:00:00-04:00", "--by", "claude_owner"]);
  expect(first.code).toBe(0);
  expect(first.json.block).toEqual({ engine: "codex", model: "gpt-6.1-sol", reason: "usage limit", since: "2026-10-16T12:00:00.000Z", release_at: "2026-10-17T03:00:00-04:00", by: "claude_owner", release_source: "explicit" });
  f.cli(["block", "--engine", "codex", "--model", "gpt-6.1-sol", "--reason", "again", "--release-at", "+3h"]);
  f.cli(["block", "--engine", "claude", "--reason", "account quota"]);
  const state = JSON.parse(readFileSync(f.stateFile, "utf8"));
  expect(state.version).toBe(1);
  expect(state.blocks).toHaveLength(2);
  expect(state.blocks[0]).toMatchObject({ engine: "codex", reason: "again", release_at: "2026-10-16T15:00:00.000Z" });
  expect(state.blocks[1].release_at).toBe("2026-10-16T17:00:00.000Z");
  expect(state.blocks[0].release_source).toBeUndefined();
  expect(readdirSync(join(f.root, "state"))).toEqual(["availability.json"]);
  expect(f.cli(["block", "--engine", "ghost", "--reason", "x"]).code).toBe(1);
  expect(f.cli(["block", "--engine", "codex"]).code).toBe(1);
  expect(f.cli(["block", "--engine", "codex", "--reason", "x", "--release-at", "2026-10-16T11:00:00Z"]).stderr).toContain("future");
  expect(f.cli(["block", "--engine", "codex", "--reason", "x", "--release-at", "tomorrow"]).code).toBe(1);
});
test("relative --release-at parsing shares addDuration with block_ttl", () => {
  const now = Date.parse(NOW);
  expect(parseReleaseAt("+2h", now)).toBe("2026-10-16T14:00:00.000Z");
  expect(parseReleaseAt("+30m", now)).toBe("2026-10-16T12:30:00.000Z");
  expect(parseReleaseAt("+1d", now)).toBe("2026-10-17T12:00:00.000Z");
  expect(parseReleaseAt("2026-10-17T03:00:00-04:00", now)).toBe("2026-10-17T03:00:00-04:00");
  expect(() => parseReleaseAt("+2w", now)).toThrow();
  expect(() => parseReleaseAt("+0h", now)).toThrow();
  expect(addDuration("5h", now)).toBe("2026-10-16T17:00:00.000Z");
  expect(addDuration("+5h", now)).toBeUndefined();
  expect(addDuration("0m", now)).toBeUndefined();
});
test("block_ttl in config must match <n>m|h|d", () => {
  for (const ttl of ["0h", "5", "5w", "+5h", "05h", "h", "", 5]) {
    const config = base(); config.engines.claude.block_ttl = ttl;
    expect(paths(config)).toEqual(["$.engines.claude.block_ttl"]);
  }
  for (const ttl of ["30m", "5h", "1d"]) {
    const config = base(); config.engines.claude.block_ttl = ttl;
    expect(paths(config)).toEqual([]);
  }
  expect(base().engines.claude.block_ttl).toBe("5h");
  expect(base().engines.codex.block_ttl).toBe("5h");
  expect(base().engines.opencode.block_ttl).toBe("1h");
  expect(base().engines.qoder.block_ttl).toBe("1h");
  expect(base().engines.grok.block_ttl).toBeUndefined();
});
test("block release_at: --release-at beats block_ttl, block_ttl beats none, release_source is output only", () => {
  const f = fixture();
  const explicit = f.cli(["block", "--engine", "claude", "--reason", "limit", "--release-at", "+2h"]).json.block;
  expect(explicit).toMatchObject({ release_at: "2026-10-16T14:00:00.000Z", release_source: "explicit" });
  const ttl = f.cli(["block", "--engine", "codex", "--reason", "limit"]).json.block;
  expect(ttl).toMatchObject({ release_at: "2026-10-16T17:00:00.000Z", release_source: "block_ttl" });
  const none = f.cli(["block", "--engine", "grok", "--reason", "limit"]).json.block;
  expect(none.release_at).toBeUndefined();
  expect(none.release_source).toBe("none");
  const state = JSON.parse(readFileSync(f.stateFile, "utf8"));
  for (const block of state.blocks) expect(block.release_source).toBeUndefined();
  // A block_ttl block releases itself; a block without release_at never does.
  expect(f.cli(["status"], "2026-10-16T16:59:59Z").json.workers.codex_worker.status).toBe("blocked");
  expect(f.cli(["status"], "2026-10-16T17:00:01Z").json.workers.codex_worker.status).toBe("available");
  expect(f.cli(["status"], "2027-10-16T12:00:00Z").json.blocks.map((b: any) => b.engine)).toEqual(["grok"]);
  // Engines without block_ttl keep none; removing block_ttl from the config switches the source.
  const bare = fixture(c => { delete c.engines.codex.block_ttl; });
  const bareBlock = bare.cli(["block", "--engine", "codex", "--reason", "limit"]).json.block;
  expect(bareBlock.release_at).toBeUndefined();
  expect(bareBlock.release_source).toBe("none");
  expect(bare.cli(["status"], "2027-10-16T12:00:00Z").json.workers.codex_worker.status).toBe("blocked");
});
test("state files reject the legacy until field and release_source", () => {
  const f = fixture();
  mkdirSync(join(f.root, "state"), { recursive: true });
  for (const extra of [{ until: "2026-10-17T03:00:00Z" }, { release_source: "explicit" }]) {
    writeFileSync(f.stateFile, JSON.stringify({ version: 1, blocks: [{ engine: "codex", reason: "x", since: "2026-10-16T12:00:00Z", ...extra }] }));
    const result = f.cli(["status"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`$.blocks[0].${Object.keys(extra)[0]}`);
  }
});
test("model-level block affects only that model and the owner running it", () => {
  const f = fixture();
  f.cli(["block", "--engine", "codex", "--model", "gpt-6.1-sol", "--reason", "limit"]);
  const status = f.cli(["status"]).json;
  expect(status.workers.codex_worker).toMatchObject({ status: "blocked", engine: "codex", model: "gpt-6.1-sol", reason: "limit" });
  expect(status.workers.claude_worker).toEqual({ status: "available" });
  expect(status.owners.codex_owner).toEqual({ status: "available" });
  f.cli(["block", "--engine", "codex", "--model", "gpt-6-astra", "--reason", "owner limit"]);
  expect(f.cli(["status"]).json.owners.codex_owner.status).toBe("blocked");
  const refused = f.cli(["resolve", "--owner", "codex_owner", "--worker", "claude_worker"]);
  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain("owner codex_owner unavailable");
  expect(f.cli(["resolve", "--owner", "claude_owner", "--worker", "claude_worker"]).code).toBe(0);
});
test("engine-level block makes every owner and worker on the engine unavailable", () => {
  const f = fixture();
  f.cli(["block", "--engine", "codex", "--reason", "account quota"]);
  const status = f.cli(["status"]).json;
  expect(status.owners.codex_owner.status).toBe("blocked");
  expect(status.workers.codex_worker.status).toBe("blocked");
  expect(status.owners.claude_owner.status).toBe("available");
  expect(status.workers.opencode_worker.status).toBe("disabled");
  const show = f.cli(["show"]).json;
  expect(show.config.owners.codex_owner.availability.status).toBe("blocked");
  expect(show.config.workers.claude_worker.availability).toEqual({ status: "available" });
  expect(show.config.owners.claude_owner.workers).toEqual(["claude_worker", "qoder_worker", "opencode_worker", "codex_worker", "grok_worker"]);
  expect(f.cli(["resolve", "--owner", "claude_owner", "--worker", "codex_worker"]).code).toBe(1);
});
test("expired blocks are ignored on read and purged on the next write", () => {
  const f = fixture();
  f.cli(["block", "--engine", "codex", "--reason", "limit", "--release-at", "+2h"]);
  const early = f.cli(["status"], "2026-10-16T13:59:59Z").json;
  expect(early.blocks).toHaveLength(1);
  expect(early.workers.codex_worker.status).toBe("blocked");
  const late = f.cli(["status"], "2026-10-16T14:00:00Z").json;
  expect(late.blocks).toEqual([]);
  expect(late.workers.codex_worker).toEqual({ status: "available" });
  expect(f.cli(["resolve", "--owner", "claude_owner", "--worker", "codex_worker"], "2026-10-16T15:00:00Z").code).toBe(0);
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
test("resolve without --worker takes the first available worker in order and falls over when blocked", () => {
  const f = fixture(noTtl);
  expect(f.cli(["resolve", "--owner", "claude_owner"]).json).toMatchObject({ worker: "claude_worker", dispatch: "native", selected_by: "order", skipped: [], warnings: [] });
  f.cli(["block", "--engine", "claude", "--model", "sonnet", "--reason", "limit"]);
  const next = f.cli(["resolve", "--owner", "claude_owner"]).json;
  expect(next).toMatchObject({ worker: "codex_worker", dispatch: "herdr", mode: "interactive", selected_by: "order" });
  expect(next.skipped).toEqual([{ worker: "claude_worker", reason: "blocked (claude/sonnet: limit)" }, { worker: "qoder_worker", reason: "disabled" }, { worker: "opencode_worker", reason: "disabled" }]);
  // After the reset time the first choice is back with no manual unblock.
  f.cli(["block", "--engine", "claude", "--model", "sonnet", "--reason", "limit", "--release-at", "+1h"]);
  expect(f.cli(["resolve", "--owner", "claude_owner"], "2026-10-16T13:00:01Z").json.worker).toBe("claude_worker");
  // codex_owner starts at its own engine's worker
  expect(f.cli(["resolve", "--owner", "codex_owner"]).json).toMatchObject({ worker: "codex_worker", dispatch: "native" });
});
test("resolve lists every unavailable candidate and exits non-zero", () => {
  const f = fixture(c => { noTtl(c); c.owners.claude_owner.workers = ["opencode_worker", "codex_worker", "claude_worker"]; });
  f.cli(["block", "--engine", "codex", "--reason", "account quota"]);
  f.cli(["block", "--engine", "claude", "--model", "sonnet", "--reason", "limit"]);
  const result = f.cli(["resolve", "--owner", "claude_owner"]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("opencode_worker: disabled");
  expect(result.stderr).toContain("codex_worker: blocked (codex: account quota)");
  expect(result.stderr).toContain("claude_worker: blocked (claude/sonnet: limit)");
  expect(result.stdout).toBe("");
});
test("show lists worker order and availability without legacy defaults", () => {
  const owners = fixture().cli(["show"]).json.config.owners;
  expect(owners.claude_owner.prefer_task).toBeUndefined();
  expect(owners.claude_owner.availability).toEqual({ status: "available" });
});
test("tags are unique lowercase slugs", () => {
  const bad = base(); bad.workers.claude_worker.tags = ["Frontend", "ui", "ui", "9x", "a".repeat(33)];
  expect(new Set(paths(bad))).toEqual(new Set(["$.workers.claude_worker.tags[0]", "$.workers.claude_worker.tags[2]", "$.workers.claude_worker.tags[3]", "$.workers.claude_worker.tags[4]"]));
  const type = base(); type.workers.claude_worker.tags = "ui";
  expect(paths(type)).toEqual(["$.workers.claude_worker.tags"]);
});
test("resolve --tag prefers the first available tagged candidate over earlier untagged ones", () => {
  const f = fixture(enableAll);
  rememberVariants(f.home, { "opencode/glm-5.3-flash-free": "max" });
  // no tag: first in order, same engine -> native
  expect(f.cli(["resolve", "--owner", "claude_owner"]).json).toMatchObject({ worker: "claude_worker", dispatch: "native", selected_by: "order" });
  const mechanical = f.cli(["resolve", "--owner", "claude_owner", "--tag", "mechanical"]).json;
  expect(mechanical).toMatchObject({ worker: "opencode_worker", dispatch: "herdr", mode: "interactive", kind: "opencode", selected_by: "tag", skipped: [], warnings: [] });
  expect(mechanical.argv).toEqual(OPENCODE_ARGV);
  const routine = f.cli(["resolve", "--owner", "claude_owner", "--tag", "routine"]).json;
  expect(routine).toMatchObject({ worker: "qoder_worker", kind: "qodercli", selected_by: "tag", warnings: [] });
  expect(routine.argv).toEqual(["-m", "Qwen3.8-Flash", "--reasoning-effort", "xhigh", "--permission-mode", "bypass_permissions"]);
  expect(f.cli(["resolve", "--owner", "claude_owner", "--tag", "backend"]).json).toMatchObject({ worker: "codex_worker", dispatch: "herdr", selected_by: "tag", warnings: [] });
  expect(f.cli(["resolve", "--owner", "claude_owner", "--tag", "frontend"]).json).toMatchObject({ worker: "claude_worker", dispatch: "native", selected_by: "tag" });
  expect(f.cli(["resolve", "--owner", "claude_owner", "--tag", "research"]).json).toMatchObject({ worker: "grok_worker", dispatch: "herdr" });
  // codex_owner order differs: test is shared by several workers, the first in its own order wins
  expect(f.cli(["resolve", "--owner", "codex_owner", "--tag", "test"]).json).toMatchObject({ worker: "codex_worker", dispatch: "native", selected_by: "tag" });
  expect(f.cli(["resolve", "--owner", "codex_owner", "--tag", "mechanical"]).json).toMatchObject({ worker: "opencode_worker" });
});
test("resolve --tag falls back in order with a warning when no tagged candidate is usable", () => {
  const f = fixture(c => { enableAll(c); noTtl(c); });
  const unknown = f.cli(["resolve", "--owner", "claude_owner", "--tag", "nonexistent"]).json;
  expect(unknown).toMatchObject({ worker: "claude_worker", selected_by: "order", skipped: [], warnings: ["无可用的 nonexistent 标签候选，已按顺序回退"] });
  f.cli(["block", "--engine", "codex", "--reason", "account quota"]);
  const blocked = f.cli(["resolve", "--owner", "claude_owner", "--tag", "backend"]).json;
  expect(blocked).toMatchObject({ worker: "claude_worker", selected_by: "order", warnings: ["无可用的 backend 标签候选，已按顺序回退"] });
  expect(blocked.skipped).toEqual([{ worker: "codex_worker", reason: "blocked (codex: account quota)" }]);
  // a blocked earlier tagged candidate is skipped in favour of a later tagged one
  const g = fixture(c => { enableAll(c); noTtl(c); c.workers.claude_worker.tags.push("backend"); });
  g.cli(["block", "--engine", "claude", "--model", "sonnet", "--reason", "limit"]);
  const later = g.cli(["resolve", "--owner", "claude_owner", "--tag", "backend"]).json;
  expect(later).toMatchObject({ worker: "codex_worker", selected_by: "tag", warnings: [] });
  expect(later.skipped).toEqual([{ worker: "claude_worker", reason: "blocked (claude/sonnet: limit)" }]);
  // everything blocked still fails with the candidate list
  for (const engine of ["codex", "grok", "qoder", "opencode"]) g.cli(["block", "--engine", engine, "--reason", "x"]);
  const none = g.cli(["resolve", "--owner", "claude_owner", "--tag", "backend"]);
  expect(none.code).toBe(1);
  expect(none.stderr).toContain("codex_worker: blocked");
});
test("resolve --tag cannot combine with --worker or --peer", () => {
  const f = fixture(enableAll);
  const withWorker = f.cli(["resolve", "--owner", "claude_owner", "--worker", "codex_worker", "--tag", "backend"]);
  expect(withWorker.code).toBe(1);
  expect(withWorker.stderr).toContain("--tag cannot be combined with --worker");
  const withPeer = f.cli(["resolve", "--owner", "claude_owner", "--peer", "codex_owner", "--tag", "backend"]);
  expect(withPeer.code).toBe(1);
  expect(withPeer.stderr).toContain("--peer cannot be combined");
  expect(f.cli(["resolve", "--owner", "claude_owner", "--worker", "codex_worker", "--peer", "codex_owner"]).code).toBe(1);
  // explicit --worker reports no selection mode
  expect(f.cli(["resolve", "--owner", "claude_owner", "--worker", "codex_worker"]).json.selected_by).toBeUndefined();
});

// ---- process-level behaviour ----
test("CLI entry point: shebang, stdout JSON, stderr and exit code, with env-injected paths", () => {
  const f = fixture();
  const env = { ...process.env, AGENTS_COOPERATION_CONFIG: f.configFile, AGENTS_COOPERATION_STATE: f.stateFile, AGENTS_COOPERATION_NOW: NOW };
  const script = join(DEFAULT_CONFIG, "..", "..", "scripts", "agents-config.ts");
  const ok = Bun.spawnSync({ cmd: [script, "block", "--engine", "opencode", "--reason", "test"], env, stdout: "pipe", stderr: "pipe" });
  expect(ok.exitCode).toBe(0);
  expect(JSON.parse(ok.stdout.toString()).block.engine).toBe("opencode");
  const bad = Bun.spawnSync({ cmd: [script, "resolve", "--owner", "nobody", "--worker", "claude_worker"], env, stdout: "pipe", stderr: "pipe" });
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
  // The injected HOME decides where the user config is looked up, so the real ~/.config is never read here.
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, source: "default", path: DEFAULT_CONFIG });
});
