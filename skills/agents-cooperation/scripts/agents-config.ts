#!/usr/bin/env bun
/** Validate, inspect and resolve the agents-cooperation owner/worker config and its quota block state. */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { type Issue, type Schema, lintSchema, validate } from "./lib/json-schema.ts";

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");
export const DEFAULT_CONFIG = join(ASSETS, "config.default.json");
const CONFIG_SCHEMA = join(ASSETS, "config.schema.json");
const STATE_SCHEMA = join(ASSETS, "availability.schema.json");

/** The single kind -> legal effort table; kinds not listed accept any non-empty string. */
export const EFFORTS: Record<string, string[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high", "xhigh", "max"],
  grok: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
  qodercli: ["auto", "none", "low", "medium", "high", "xhigh", "max", "ultracode"],
};
const BYPASS = ["--permission-mode", "bypassPermissions"];
const CODEX_BYPASS = "--dangerously-bypass-approvals-and-sandbox";
const QODER_BYPASS = ["--permission-mode", "bypass_permissions"];
const codexEffort = (e: string) => `model_reasoning_effort=${e}`;
const TASK_PROMPT = "执行附件中的任务说明，结果按任务文件要求回报";
const TASK_FILE = "{task_file}";
const INTERACTIVE: Record<string, (m: string, e: string) => string[]> = {
  claude: (m, e) => ["--model", m, "--effort", e, ...BYPASS],
  codex: (m, e) => ["-m", m, "-c", codexEffort(e), CODEX_BYPASS],
  qodercli: (m, e) => ["-m", m, "--reasoning-effort", e, ...QODER_BYPASS],
  grok: (m, e) => ["-m", m, "--effort", e, ...BYPASS],
};
const ONESHOT: Record<string, (m: string, e: string) => { argv: string[]; stdin?: string }> = {
  claude: (m, e) => ({ argv: ["claude", "-p", "--model", m, "--effort", e, ...BYPASS], stdin: TASK_FILE }),
  codex: (m, e) => ({ argv: ["codex", "exec", "-m", m, "-c", codexEffort(e), CODEX_BYPASS, "-"], stdin: TASK_FILE }),
  // The message positional must precede -f: -f is an array option and swallows any positional after it.
  opencode: (m, e) => ({ argv: ["opencode", "run", TASK_PROMPT, "-m", m, "--variant", e, "--format", "json", "--auto", "-f", TASK_FILE] }),
  // The prompt positional must precede --attachment, mirroring the opencode -f ordering rule.
  qodercli: (m, e) => ({ argv: ["qodercli", "-p", TASK_PROMPT, "-m", m, "--reasoning-effort", e, ...QODER_BYPASS, "--output-format", "json", "--no-session-persistence", "--attachment", TASK_FILE] }),
  grok: (m, e) => ({ argv: ["grok", "--prompt-file", TASK_FILE, "-m", m, "--effort", e, ...BYPASS, "--output-format", "json"] }),
};
const GROK_EFFORT_WARNING = "grok spawn_subagent 不支持按次设置 effort，子 agent 沿用 owner 会话的 effort";

export class CliError extends Error {
  constructor(message: string, public issues: Issue[] = []) { super(message); }
}
export interface Engine { enabled: boolean; kind: string; native_subagents?: boolean }
export interface Owner { enabled: boolean; engine: string; model: string; effort: string; workers: string[]; max_parallel: number; prefer_task?: boolean }
export interface Worker { enabled: boolean; engine: string; class: "worker" | "task"; model: string; effort: string; description?: string; tags?: string[] }
export interface Config { version: 1; engines: Record<string, Engine>; owners: Record<string, Owner>; workers: Record<string, Worker> }
export interface Block { engine: string; model?: string; reason: string; since: string; until?: string; by?: string }
export interface State { version: 1; blocks: Block[] }
export interface Availability { status: "available" | "disabled" | "engine_disabled" | "blocked"; engine?: string; model?: string; reason?: string; until?: string }

const readJson = (path: string): any => {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw new CliError(`cannot read JSON ${path}: ${(error as Error).message}`); }
};
export function loadSchema(path: string): Schema {
  const schema = readJson(path);
  lintSchema(schema);
  return schema;
}

// ---- config validation ----
export function validateConfig(config: unknown, schema: Schema = loadSchema(CONFIG_SCHEMA)): Issue[] {
  const issues = validate(schema, config);
  if (issues.length) return issues;
  const c = config as Config;
  const bad = (path: string, message: string) => issues.push({ path, message });
  const checkEffort = (path: string, engineId: string, effort: string) => {
    const kind = c.engines[engineId]?.kind;
    const allowed = kind ? EFFORTS[kind] : undefined;
    if (allowed && !allowed.includes(effort)) bad(`${path}.effort`, `${kind} effort must be one of ${allowed.join("|")}`);
  };
  const owned = new Map<string, string>();
  for (const [id, owner] of Object.entries(c.owners)) {
    const at = `$.owners.${id}`;
    const engine = c.engines[owner.engine];
    if (!engine) bad(`${at}.engine`, `unknown engine ${owner.engine}`);
    else checkEffort(at, owner.engine, owner.effort);
    owner.workers.forEach((worker, i) => { if (!c.workers[worker]) bad(`${at}.workers[${i}]`, `unknown worker ${worker}`); });
    if (!owner.enabled) continue;
    if (engine && !engine.enabled) bad(`${at}.engine`, `engine ${owner.engine} is disabled`);
    if (engine && !engine.native_subagents) bad(`${at}.engine`, `engine ${owner.engine} must set native_subagents: true to host an owner`);
    const other = owned.get(owner.engine);
    if (other) bad(at, `engine ${owner.engine} already has enabled owner ${other}`);
    else owned.set(owner.engine, id);
    const hasWorker = owner.workers.some(w => { const a = c.workers[w]; return a?.enabled && a.class === "worker" && c.engines[a.engine]?.enabled; });
    if (!hasWorker) bad(`${at}.workers`, "enabled owner needs at least one enabled class=worker worker on an enabled engine");
  }
  // Kinds that can host native sub-agents come from the schema (engine.then), not from a second table here.
  const nativeKinds: string[] = schema.$defs?.engine?.then?.properties?.kind?.enum ?? [];
  for (const [id, worker] of Object.entries(c.workers)) {
    const at = `$.workers.${id}`;
    const kind = c.engines[worker.engine]?.kind;
    if (!kind) { bad(`${at}.engine`, `unknown engine ${worker.engine}`); continue; }
    checkEffort(at, worker.engine, worker.effort);
    if (worker.class === "worker" && !INTERACTIVE[kind] && !nativeKinds.includes(kind)) bad(`${at}.class`, `kind ${kind} supports neither interactive launch nor native sub-agents; use class=task`);
    if (worker.class === "task" && !ONESHOT[kind]) bad(`${at}.class`, `kind ${kind} has no one-shot launch; class=task is unsupported`);
  }
  return issues;
}

// ---- availability ----
const stamp = (value: string) => Date.parse(value);
export function activeBlocks(state: State, now: number): Block[] {
  return state.blocks.filter(b => !b.until || stamp(b.until) > now);
}
export function availabilityOf(config: Config, blocks: Block[], entity: Owner | Worker): Availability {
  if (!entity.enabled) return { status: "disabled" };
  if (!config.engines[entity.engine]?.enabled) return { status: "engine_disabled" };
  const hit = blocks.find(b => b.engine === entity.engine && (b.model === undefined || b.model === entity.model));
  if (hit) return { status: "blocked", engine: hit.engine, ...(hit.model ? { model: hit.model } : {}), reason: hit.reason, ...(hit.until ? { until: hit.until } : {}) };
  return { status: "available" };
}
const describeUnavailable = (a: Availability) =>
  a.status === "blocked" ? `blocked (${a.model ? `${a.engine}/${a.model}` : a.engine}: ${a.reason}${a.until ? `, until ${a.until}` : ""})` : a.status;
export function validateState(state: unknown, schema: Schema = loadSchema(STATE_SCHEMA)): Issue[] {
  const issues = validate(schema, state);
  if (issues.length) return issues;
  const seen = new Set<string>();
  (state as State).blocks.forEach((b, i) => {
    const key = `${b.engine}\0${b.model ?? ""}`;
    if (seen.has(key)) issues.push({ path: `$.blocks[${i}]`, message: "duplicate (engine, model) block" });
    seen.add(key);
  });
  return issues;
}
export function readState(path: string): State {
  if (!existsSync(path)) return { version: 1, blocks: [] };
  const state = readJson(path);
  const issues = validateState(state);
  if (issues.length) throw new CliError(`invalid state file ${path}`, issues);
  return state;
}
export function writeState(path: string, state: State): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try { writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 }); renameSync(tmp, path); }
  catch (error) { rmSync(tmp, { force: true }); throw error; }
}
export function parseUntil(value: string, now: number): string {
  const relative = /^\+(\d+)([mhd])$/.exec(value);
  if (relative) return new Date(now + Number(relative[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[relative[2] as "m" | "h" | "d"]).toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value) || Number.isNaN(stamp(value))) {
    throw new CliError(`invalid --until ${value}; use ISO 8601 with timezone or +<n>m|h|d`);
  }
  return value;
}

// ---- resolve ----
export interface Dispatch { [key: string]: unknown; warnings: string[] }
function launch(config: Config, ownerId: string, workerId: string, warnings: string[]): Dispatch {
  const owner = config.owners[ownerId]!;
  const worker = config.workers[workerId]!;
  const engine = config.engines[worker.engine]!;
  const base = { owner: ownerId, worker: workerId, class: worker.class, engine: worker.engine, model: worker.model, effort: worker.effort };
  if (worker.class === "task") {
    const build = ONESHOT[engine.kind];
    if (!build) throw new CliError(`kind ${engine.kind} does not support building one-shot argv`);
    const { argv, stdin } = build(worker.model, worker.effort);
    return { ...base, dispatch: "herdr", mode: "oneshot", kind: engine.kind, argv, ...(stdin ? { stdin } : {}), task_file_placeholder: TASK_FILE, warnings };
  }
  if (worker.engine === owner.engine) {
    const params = { model: worker.model };
    switch (engine.kind) {
      case "claude": return { ...base, dispatch: "native", tool: "Agent", params: { ...params, effort: worker.effort, subagent_type: "general-purpose" }, warnings };
      case "codex": return { ...base, dispatch: "native", tool: "spawn_agent", params: { ...params, reasoning_effort: worker.effort, fork_turns: "none" }, warnings };
      case "grok": return { ...base, dispatch: "native", tool: "spawn_subagent", params: { ...params, subagent_type: "general-purpose" }, warnings: [...warnings, GROK_EFFORT_WARNING] };
      default: throw new CliError(`kind ${engine.kind} has no native sub-agent tool`);
    }
  }
  return { ...base, dispatch: "herdr", ...interactive(engine.kind, worker.model, worker.effort), warnings };
}
function interactive(kind: string, model: string, effort: string) {
  const build = INTERACTIVE[kind];
  if (!build) throw new CliError(`kind ${kind} does not support building launch argv`);
  return { mode: "interactive", kind, argv: build(model, effort) };
}
function requireOwner(config: Config, blocks: Block[], id: string, what = "owner"): Owner {
  const owner = config.owners[id];
  if (!owner) throw new CliError(`unknown ${what} ${id}`);
  const a = availabilityOf(config, blocks, owner);
  if (a.status !== "available") throw new CliError(`${what} ${id} unavailable: ${describeUnavailable(a)}`);
  return owner;
}
export function resolveDispatch(config: Config, blocks: Block[], opts: { owner: string; worker?: string; class?: string; tag?: string; peer?: string }): Dispatch {
  const owner = requireOwner(config, blocks, opts.owner);
  if (opts.peer !== undefined) {
    if (opts.worker || opts.class || opts.tag !== undefined) throw new CliError("--peer cannot be combined with --worker, --class or --tag");
    if (opts.peer === opts.owner) throw new CliError("--peer must differ from --owner");
    const peer = requireOwner(config, blocks, opts.peer, "peer owner");
    const kind = config.engines[peer.engine]!.kind;
    return { owner: opts.owner, peer: opts.peer, role: "peer_owner", dispatch: "herdr", ...interactive(kind, peer.model, peer.effort), engine: peer.engine, model: peer.model, effort: peer.effort, warnings: [] };
  }
  if (!!opts.worker === !!opts.class) throw new CliError("provide exactly one of --worker, --class or --peer");
  if (opts.tag !== undefined && !opts.class) throw new CliError("--tag requires --class");
  if (opts.worker) {
    const worker = config.workers[opts.worker];
    if (!worker) throw new CliError(`unknown worker ${opts.worker}`);
    const a = availabilityOf(config, blocks, worker);
    if (a.status !== "available") throw new CliError(`worker ${opts.worker} unavailable: ${describeUnavailable(a)}`);
    const warnings = owner.workers.includes(opts.worker) ? [] : [`worker ${opts.worker} 不在 owner ${opts.owner} 的 workers 列表中`];
    return launch(config, opts.owner, opts.worker, warnings);
  }
  if (opts.class !== "worker" && opts.class !== "task") throw new CliError("--class must be worker or task");
  const candidates = owner.workers
    .filter(id => config.workers[id]!.class === opts.class)
    .map(id => ({ id, availability: availabilityOf(config, blocks, config.workers[id]!), tagged: opts.tag !== undefined && !!config.workers[id]!.tags?.includes(opts.tag) }));
  const usable = (c: { availability: Availability }) => c.availability.status === "available";
  const warnings: string[] = [];
  let chosen = opts.tag !== undefined ? candidates.find(c => c.tagged && usable(c)) : undefined;
  if (opts.tag !== undefined && !chosen) warnings.push(`无可用的 ${opts.tag} 标签候选，已按顺序回退`);
  chosen ??= candidates.find(usable);
  if (!chosen) throw new CliError(`no available class=${opts.class} worker for owner ${opts.owner}`, candidates.map(c => ({ path: `$.owners.${opts.owner}.workers`, message: `${c.id}: ${describeUnavailable(c.availability)}` })));
  const at = candidates.indexOf(chosen);
  const skipped = candidates.filter((c, i) => !usable(c) && (i < at || c.tagged)).map(c => ({ worker: c.id, reason: describeUnavailable(c.availability) }));
  return { ...launch(config, opts.owner, chosen.id, warnings), selected_by: "class", skipped };
}

// ---- CLI ----
export interface RunResult { code: number; stdout: string; stderr: string }
export function configPath(flag: string | undefined, env: Record<string, string | undefined>): { path: string; source: string } {
  const explicit = flag ?? env.AGENTS_COOPERATION_CONFIG;
  if (explicit) {
    if (!existsSync(explicit)) throw new CliError(`config file not found: ${explicit}`);
    return { path: resolvePath(explicit), source: resolvePath(explicit) };
  }
  const user = join(env.HOME ?? homedir(), ".config", "agents-cooperation", "config.json");
  return existsSync(user) ? { path: user, source: user } : { path: DEFAULT_CONFIG, source: "default" };
}
const statePath = (flag: string | undefined, env: Record<string, string | undefined>) =>
  resolvePath(flag ?? env.AGENTS_COOPERATION_STATE ?? join(env.HOME ?? homedir(), ".local", "state", "agents-cooperation", "availability.json"));
function loadConfig(path: string, schema: Schema): Config {
  const config = readJson(path);
  const issues = validateConfig(config, schema);
  if (issues.length) throw new CliError(`invalid config ${path}`, issues);
  return config;
}
const USAGE = `Usage: bun agents-config.ts <command> [options]
  validate                         Validate the config (structure + semantics)
  show                             Print the effective config with availability
  resolve --owner <id> --worker <id> | --class worker|task [--tag <t>] | --peer <owner-id>
  block --engine <id> [--model <m>] [--until <ISO8601|+<n>m|h|d>] --reason <text> [--by <owner-id>]
  unblock --engine <id> [--model <m>]
  status                           Print active blocks and per-owner/worker availability
Common: --config <path> --state <path>; env AGENTS_COOPERATION_CONFIG, AGENTS_COOPERATION_STATE, AGENTS_COOPERATION_NOW (tests only)`;

export function run(args: string[], env: Record<string, string | undefined> = process.env): RunResult {
  try {
    const { values, positionals } = parseArgs({
      args, allowPositionals: true,
      options: { config: { type: "string" }, state: { type: "string" }, owner: { type: "string" }, worker: { type: "string" }, tag: { type: "string" }, class: { type: "string" }, peer: { type: "string" }, engine: { type: "string" }, model: { type: "string" }, until: { type: "string" }, reason: { type: "string" }, by: { type: "string" }, help: { type: "boolean", short: "h" } },
    });
    const command = positionals[0];
    if (values.help || !command) return { code: values.help ? 0 : 2, stdout: values.help ? USAGE + "\n" : "", stderr: values.help ? "" : USAGE + "\n" };
    if (positionals.length > 1) throw new CliError(`unexpected argument ${positionals[1]}`);
    const nowEnv = env.AGENTS_COOPERATION_NOW;
    const now = nowEnv ? stamp(nowEnv) : Date.now();
    if (Number.isNaN(now)) throw new CliError("invalid AGENTS_COOPERATION_NOW");
    const out = (value: unknown): RunResult => ({ code: 0, stdout: JSON.stringify(value, null, 2) + "\n", stderr: "" });
    const { path, source } = configPath(values.config, env);
    const schema = loadSchema(CONFIG_SCHEMA);
    if (command === "validate") {
      const issues = validateConfig(readJson(path), schema);
      if (issues.length) throw new CliError(`invalid config ${path}`, issues);
      return out({ ok: true, source, path });
    }
    const config = loadConfig(path, schema);
    const file = statePath(values.state, env);
    const state = readState(file);
    const blocks = activeBlocks(state, now);
    const need = (name: string, value: string | undefined) => { if (!value) throw new CliError(`--${name} is required`); return value; };
    const availability = () => ({
      owners: Object.fromEntries(Object.entries(config.owners).map(([id, o]) => [id, availabilityOf(config, blocks, o)])),
      workers: Object.fromEntries(Object.entries(config.workers).map(([id, w]) => [id, availabilityOf(config, blocks, w)])),
    });
    switch (command) {
      case "show": {
        // Schema `default` annotations fill omitted optional fields, so the schema stays the single source of defaults.
        const withAvailability = <T extends Owner | Worker>(group: Record<string, T>, def: Schema) =>
          Object.fromEntries(Object.entries(group).map(([id, e]) => {
            const defaults = Object.fromEntries(Object.entries<Schema>(def.properties ?? {}).filter(([key, prop]) => "default" in prop && !(key in e)).map(([key, prop]) => [key, prop.default]));
            return [id, { ...e, ...defaults, availability: availabilityOf(config, blocks, e) }];
          }));
        return out({ source, path, state: file, config: { ...config, owners: withAvailability(config.owners, schema.$defs!.owner), workers: withAvailability(config.workers, schema.$defs!.worker) } });
      }
      case "status": return out({ now: new Date(now).toISOString(), state: file, blocks, ...availability() });
      case "resolve": return out(resolveDispatch(config, blocks, { owner: need("owner", values.owner), worker: values.worker, class: values.class, tag: values.tag, peer: values.peer }));
      case "block": {
        const engine = need("engine", values.engine);
        if (!config.engines[engine]) throw new CliError(`unknown engine ${engine}`);
        const entry: Block = { engine, ...(values.model ? { model: values.model } : {}), reason: need("reason", values.reason), since: new Date(now).toISOString() };
        if (values.until) {
          entry.until = parseUntil(values.until, now);
          if (stamp(entry.until) <= now) throw new CliError("--until must be in the future");
        }
        if (values.by) entry.by = values.by;
        const kept = blocks.filter(b => !(b.engine === engine && b.model === entry.model));
        writeState(file, { version: 1, blocks: [...kept, entry] });
        return out({ block: entry, purged_expired: state.blocks.length - blocks.length });
      }
      case "unblock": {
        const engine = need("engine", values.engine);
        const kept = blocks.filter(b => !(b.engine === engine && b.model === values.model));
        const removed = blocks.length - kept.length;
        if (removed || state.blocks.length !== blocks.length) writeState(file, { version: 1, blocks: kept });
        return out({ removed, purged_expired: state.blocks.length - blocks.length });
      }
      default: throw new CliError(`unknown command ${command}`);
    }
  } catch (error) {
    if (error instanceof CliError) {
      const lines = [`agents-config: ${error.message}`, ...error.issues.map(i => `  ${i.path}: ${i.message}`)];
      return { code: 1, stdout: "", stderr: lines.join("\n") + "\n" };
    }
    if ((error as NodeJS.ErrnoException).code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" || (error as NodeJS.ErrnoException).code?.startsWith("ERR_PARSE_ARGS")) {
      return { code: 2, stderr: `agents-config: ${(error as Error).message}\n${USAGE}\n`, stdout: "" };
    }
    return { code: 1, stdout: "", stderr: `agents-config: ${(error as Error).message}\n` };
  }
}
if (import.meta.main) {
  const result = run(Bun.argv.slice(2));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.code);
}
