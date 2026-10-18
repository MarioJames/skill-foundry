#!/usr/bin/env bun
/** Validate, inspect and resolve the agents-cooperation owner/worker config and its quota block state. */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { type Issue, type Schema, lintSchema, validate } from "./lib/json-schema.ts";

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");
export const DEFAULT_CONFIG = join(ASSETS, "config.default.json");
const CONFIG_SCHEMA = join(ASSETS, "config.schema.json");
import { openConfiguredState, statePath, listBlocks, upsertBlock, removeBlock, purgeExpired, transaction, migrateAvailability, stateWarnings } from "./lib/state-db.ts";

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
const INTERACTIVE: Record<string, (m: string, e: string) => string[]> = {
  claude: (m, e) => ["--model", m, "--effort", e, ...BYPASS],
  codex: (m, e) => ["-m", m, "-c", codexEffort(e), CODEX_BYPASS],
  // opencode's TUI has no per-launch variant flag; the effort comes from its remembered variant (see opencodeVariantWarning).
  opencode: (m) => ["-m", m, "--auto"],
  qodercli: (m, e) => ["-m", m, "--reasoning-effort", e, ...QODER_BYPASS],
  grok: (m, e) => ["-m", m, "--effort", e, ...BYPASS],
};

/** Reserved class tags: a worker carrying one is a free worker picked by resolve --class; every other tag is a domain tag. */
export const CLASS_TAGS = ["mechanical", "routine"];
export const CLASSES = [...CLASS_TAGS, "judgment"];
const isFree = (worker: Worker) => CLASS_TAGS.some(t => worker.tags?.includes(t));

export class CliError extends Error {
  constructor(message: string, public issues: Issue[] = []) { super(message); }
}
export interface Engine { enabled: boolean; kind: string; native_subagents?: boolean }
export interface Owner { enabled: boolean; engine: string; model: string; effort: string; workers: string[]; max_parallel: number }
export interface Worker { enabled: boolean; engine: string; model: string; effort: string; description?: string; tags?: string[] }
export interface Herdr { max_wait_minutes: number }
export interface Config { version: 1; engines: Record<string, Engine>; owners: Record<string, Owner>; workers: Record<string, Worker>; herdr: Herdr }
export interface Block { engine: string; model?: string; reason: string; since: string; release_at?: string; by?: string }
export interface State { version: 1; blocks: Block[] }
export interface Availability { status: "available" | "disabled" | "engine_disabled" | "blocked"; engine?: string; model?: string; reason?: string; release_at?: string }

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
  if (config && typeof config === "object" && (config as any).herdr && typeof (config as any).herdr === "object" && "worker_session" in (config as any).herdr) {
    const i = issues.find(i=>i.path==="$.herdr.worker_session");
    if(i) i.message = "remove herdr.worker_session; agents-runtime allocates a private session for each run";
  }
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
    if (engine && !engine.native_subagents) bad(`${at}.engine`, `engine ${owner.engine} must set native_subagents: true to host an owner`);
    if (!owner.enabled) continue;
    if (engine && !engine.enabled) bad(`${at}.engine`, `engine ${owner.engine} is disabled`);
    const other = owned.get(owner.engine);
    if (other) bad(at, `engine ${owner.engine} already has enabled owner ${other}`);
    else owned.set(owner.engine, id);
    const hasWorker = owner.workers.some(w => { const a = c.workers[w]; return a?.enabled && c.engines[a.engine]?.enabled; });
    if (!hasWorker) bad(`${at}.workers`, "enabled owner needs at least one enabled worker on an enabled engine");
  }
  // Kinds that can host native sub-agents come from the schema (engine.then), not from a second table here.
  const nativeKinds: string[] = schema.$defs?.engine?.then?.properties?.kind?.enum ?? [];
  for (const [id, worker] of Object.entries(c.workers)) {
    const at = `$.workers.${id}`;
    const kind = c.engines[worker.engine]?.kind;
    if (!kind) { bad(`${at}.engine`, `unknown engine ${worker.engine}`); continue; }
    checkEffort(at, worker.engine, worker.effort);
    if (CLASS_TAGS.every(t => worker.tags?.includes(t))) bad(`${at}.tags`, `a worker cannot carry both ${CLASS_TAGS.join(" and ")}`);
    if (!INTERACTIVE[kind] && !nativeKinds.includes(kind)) bad(`${at}.engine`, `kind ${kind} supports neither interactive launch nor native sub-agents`);
  }
  return issues;
}

// ---- availability ----
const stamp = (value: string) => Date.parse(value);
export function activeBlocks(state: State, now: number): Block[] {
  return state.blocks.filter(b => !b.release_at || stamp(b.release_at) > now);
}
export function availabilityOf(config: Config, blocks: Block[], entity: Owner | Worker): Availability {
  if (!entity.enabled) return { status: "disabled" };
  if (!config.engines[entity.engine]?.enabled) return { status: "engine_disabled" };
  const hit = blocks.find(b => b.engine === entity.engine && (b.model === undefined || b.model === entity.model));
  if (hit) return { status: "blocked", engine: hit.engine, ...(hit.model ? { model: hit.model } : {}), reason: hit.reason, ...(hit.release_at ? { release_at: hit.release_at } : {}) };
  return { status: "available" };
}
const describeUnavailable = (a: Availability) =>
  a.status === "blocked" ? `blocked (${a.model ? `${a.engine}/${a.model}` : a.engine}: ${a.reason}${a.release_at ? `, release_at ${a.release_at}` : ""})` : a.status;
/** --release-at: an ISO 8601 timestamp with timezone (returned as given), or +<n>m|h|d counted from now (n >= 1). */
export function parseReleaseAt(value: string, now: number): string {
  const relative = /^\+([1-9][0-9]*)([mhd])$/.exec(value);
  if (relative) return new Date(now + Number(relative[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[relative[2] as "m" | "h" | "d"]).toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value) || Number.isNaN(stamp(value))) {
    throw new CliError(`invalid --release-at ${value}; use ISO 8601 with timezone or +<n>m|h|d`);
  }
  return value;
}

// ---- resolve ----
export interface Dispatch { [key: string]: unknown; warnings: string[] }
const opencodeFix = (effort: string) => `请在 opencode TUI 中对该模型切换一次 variant 为 ${effort}`;
/** opencode's TUI cannot take a variant per launch, so read the one it remembers (read-only) and compare with the configured effort. */
function opencodeVariantWarning(home: string, model: string, effort: string): string | undefined {
  const file = join(home, ".local", "state", "opencode", "model.json");
  let variant: unknown;
  try { variant = JSON.parse(readFileSync(file, "utf8"))?.variant?.[model]; }
  catch { return `无法核实 opencode variant：${file} 不可读；opencode TUI 使用其记忆的 variant，须与 effort ${effort} 一致`; }
  if (variant === effort) return undefined;
  if (typeof variant !== "string") return `opencode 未记忆 ${model} 的 variant，TUI 将使用模型默认值而非配置的 effort ${effort}；${opencodeFix(effort)}`;
  return `opencode TUI 对 ${model} 记忆的 variant 为 ${variant}，与配置 effort ${effort} 不一致；${opencodeFix(effort)}`;
}
function launch(config: Config, ownerId: string, workerId: string, warnings: string[], home: string): Dispatch {
  const owner = config.owners[ownerId]!;
  const worker = config.workers[workerId]!;
  const engine = config.engines[worker.engine]!;
  const base = { owner: ownerId, worker: workerId, engine: worker.engine, model: worker.model, effort: worker.effort };
  if (worker.engine === owner.engine) {
    const params = { model: worker.model };
    switch (engine.kind) {
      case "claude": return { ...base, dispatch: "native", tool: "Agent", params: { ...params, effort: worker.effort, subagent_type: "general-purpose" }, warnings };
      case "codex": return { ...base, dispatch: "native", tool: "spawn_agent", params: { ...params, reasoning_effort: worker.effort, fork_turns: "none" }, warnings };
      default: throw new CliError(`kind ${engine.kind} has no native sub-agent tool`);
    }
  }
  const variant = engine.kind === "opencode" ? opencodeVariantWarning(home, worker.model, worker.effort) : undefined;
  return { ...base, dispatch: "herdr", ...interactive(engine.kind, worker.model, worker.effort), wait_timeout_ms: waitTimeoutMs(config), warnings: variant ? [...warnings, variant] : warnings };
}
/** Longest single herdr wait; every herdr agent prompt --wait / agent wait must pass it as --timeout. */
const waitTimeoutMs = (config: Config) => config.herdr.max_wait_minutes * 60_000;
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
/** The tag is another available enabled owner's strength and the owner's own native workers lack it: suggest handing the package over via assign. */
function peerSuggestion(config: Config, blocks: Block[], owner: Owner, listed: Worker[], tag: string): { owner: string; reason: string } | undefined {
  if (listed.some(w => w.engine === owner.engine && w.tags?.includes(tag))) return undefined;
  for (const [id, other] of Object.entries(config.owners)) {
    if (other.engine === owner.engine || availabilityOf(config, blocks, other).status !== "available") continue;
    if (Object.values(config.workers).some(w => w.engine === other.engine && !isFree(w) && w.tags?.includes(tag))) {
      return { owner: id, reason: `${tag} 是 ${id} 侧 worker 的强项，可经 assign 交给该 owner` };
    }
  }
  return undefined;
}
export function resolveDispatch(config: Config, blocks: Block[], opts: { owner: string; worker?: string; class?: string; tag?: string; peer?: string }, home: string = homedir()): Dispatch {
  const owner = requireOwner(config, blocks, opts.owner);
  if (opts.peer !== undefined) {
    if (opts.worker || opts.class !== undefined || opts.tag !== undefined) throw new CliError("--peer cannot be combined with --worker, --class or --tag");
    if (opts.peer === opts.owner) throw new CliError("--peer must differ from --owner");
    const peer = requireOwner(config, blocks, opts.peer, "peer owner");
    const kind = config.engines[peer.engine]!.kind;
    return { owner: opts.owner, peer: opts.peer, role: "peer_owner", dispatch: "herdr", ...interactive(kind, peer.model, peer.effort), engine: peer.engine, model: peer.model, effort: peer.effort, wait_timeout_ms: waitTimeoutMs(config), warnings: [] };
  }
  if (opts.worker) {
    if (opts.class !== undefined || opts.tag !== undefined) throw new CliError("--worker cannot be combined with --class or --tag");
    const worker = config.workers[opts.worker];
    if (!worker) throw new CliError(`unknown worker ${opts.worker}`);
    const a = availabilityOf(config, blocks, worker);
    if (a.status !== "available") throw new CliError(`worker ${opts.worker} unavailable: ${describeUnavailable(a)}`);
    const warnings = owner.workers.includes(opts.worker) ? [] : [`worker ${opts.worker} 不在 owner ${opts.owner} 的 workers 列表中`];
    return { ...launch(config, opts.owner, opts.worker, warnings, home), selected_by: "worker" };
  }
  const cls = opts.class;
  if (cls === undefined || !CLASSES.includes(cls)) throw new CliError(cls === undefined ? `--class is required (${CLASSES.join("|")}) unless --worker or --peer is given` : `--class must be one of ${CLASSES.join("|")}`);
  if (opts.tag !== undefined) {
    if (cls !== "judgment") throw new CliError("--tag is only valid with --class judgment");
    if (CLASS_TAGS.includes(opts.tag)) throw new CliError(`--tag ${opts.tag} is a class tag; use --class ${opts.tag}`);
  }
  const all = owner.workers.map(id => ({ id, worker: config.workers[id]!, availability: availabilityOf(config, blocks, config.workers[id]!) }));
  const usable = (c: { availability: Availability }) => c.availability.status === "available";
  const paid = all.filter(c => !isFree(c.worker));
  // Attempt order: free class workers first (mechanical, then routine), then the judgment pool.
  // A domain tag only matches heterogeneous workers; the owner's own-engine (native) worker is the implicit judgment default and needs no tag.
  const sequence: { c: (typeof all)[number]; by: "class" | "tag" | "native" | "order" }[] = [];
  const add = (list: typeof all, by: "class" | "tag" | "native" | "order") => list.forEach(c => { if (!sequence.some(s => s.c === c)) sequence.push({ c, by }); });
  if (cls === "mechanical") add(all.filter(c => c.worker.tags?.includes("mechanical")), "class");
  if (cls !== "judgment") add(all.filter(c => c.worker.tags?.includes("routine")), "class");
  if (opts.tag !== undefined) {
    add(paid.filter(c => c.worker.engine !== owner.engine && c.worker.tags?.includes(opts.tag!)), "tag");
    add(paid.filter(c => c.worker.engine === owner.engine), "native");
  }
  add(paid, "order");
  const hit = sequence.find(s => usable(s.c));
  if (!hit) {
    const considered = sequence.map(s => s.c);
    throw new CliError(`no available worker for owner ${opts.owner} (class ${cls})`, considered.map(c => ({ path: `$.owners.${opts.owner}.workers`, message: `${c.id}: ${describeUnavailable(c.availability)}` })));
  }
  const warnings: string[] = [];
  if (hit.by === "native" && sequence.some(s => s.by === "tag")) warnings.push(`带 ${opts.tag} 标签的异构候选不可用，已回落到本引擎原生 worker`);
  if (hit.by === "order") {
    if (cls !== "judgment") warnings.push("无可用免费 worker，已按 judgment 回退");
    else if (opts.tag !== undefined) warnings.push(`无可用的 ${opts.tag} 标签候选，已按顺序回退`);
  }
  const skipped = sequence.slice(0, sequence.indexOf(hit)).filter(s => !usable(s.c)).map(s => ({ worker: s.c.id, reason: describeUnavailable(s.c.availability) }));
  const suggestion = hit.by === "native" && opts.tag !== undefined ? peerSuggestion(config, blocks, owner, paid.map(c => c.worker), opts.tag) : undefined;
  return { ...launch(config, opts.owner, hit.c.id, warnings, home), class: cls, selected_by: hit.by, skipped, ...(suggestion ? { peer_suggestion: suggestion } : {}) };
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
function loadConfig(path: string, schema: Schema): Config {
  const config = readJson(path);
  const issues = validateConfig(config, schema);
  if (issues.length) throw new CliError(`invalid config ${path}`, issues);
  return config;
}
const USAGE = `Usage: bun agents-config.ts <command> [options]
  validate                         Validate the config (structure + semantics)
  show                             Print the effective config with availability
  resolve --owner <id> --class mechanical|routine|judgment [--tag <domain>] | --worker <id> | --peer <owner-id>
                                   (--class is required for pool selection: mechanical -> mechanical worker, then routine worker, then judgment;
                                    routine -> routine worker, then judgment; judgment -> non-free workers in order, --tag <domain> prefers a tagged heterogeneous worker, else the
                                    owner's native worker (peer_suggestion names another owner whose workers are strong at the tag when the owner's list has no such worker);
                                    --tag only with judgment; --worker only for a user-chosen worker or continuing the same package)
  block --engine <id> [--model <m>] [--release-at <ISO8601|+<n>m|h|d>] --reason <text> [--by <owner-id>]
  unblock --engine <id> [--model <m>]
  migrate-availability --from <path> Import a legacy availability JSON snapshot
  status                           Print active blocks and per-owner/worker availability
Common: --config <path> --state <path>; env AGENTS_COOPERATION_CONFIG, AGENTS_COOPERATION_STATE, AGENTS_COOPERATION_NOW (tests only)`;

export function run(args: string[], env: Record<string, string | undefined> = process.env): RunResult {
  let db: ReturnType<typeof openConfiguredState> | undefined;
  try {
    const { values, positionals } = parseArgs({
      args, allowPositionals: true,
      options: { from: { type: "string" }, config: { type: "string" }, state: { type: "string" }, owner: { type: "string" }, worker: { type: "string" }, class: { type: "string" }, tag: { type: "string" }, peer: { type: "string" }, engine: { type: "string" }, model: { type: "string" }, "release-at": { type: "string" }, reason: { type: "string" }, by: { type: "string" }, help: { type: "boolean", short: "h" } },
    });
    const command = positionals[0];
    if (values.help || !command) return { code: values.help ? 0 : 2, stdout: values.help ? USAGE + "\n" : "", stderr: values.help ? "" : USAGE + "\n" };
    if (positionals.length > 1) throw new CliError(`unexpected argument ${positionals[1]}`);
    const nowEnv = env.AGENTS_COOPERATION_NOW;
    const now = nowEnv ? stamp(nowEnv) : Date.now();
    if (Number.isNaN(now)) throw new CliError("invalid AGENTS_COOPERATION_NOW");
    const out = (value: unknown): RunResult => ({ code: 0, stdout: JSON.stringify(db && stateWarnings(db).length ? {...(value as object), state_warnings:stateWarnings(db)} : value, null, 2) + "\n", stderr: "" });
    const { path, source } = configPath(values.config, env);
    const schema = loadSchema(CONFIG_SCHEMA);
    if (command === "validate") {
      const issues = validateConfig(readJson(path), schema);
      if (issues.length) throw new CliError(`invalid config ${path}`, issues);
      return out({ ok: true, source, path });
    }
    const config = loadConfig(path, schema);
    const file = statePath(values.state, env);
    db = openConfiguredState(values.state, env);
    const state: State = {version:1,blocks:listBlocks(db)};
    const blocks = activeBlocks(state, now);
    const need = (name: string, value: string | undefined) => { if (!value) throw new CliError(`--${name} is required`); return value; };
    const availability = () => ({
      owners: Object.fromEntries(Object.entries(config.owners).map(([id, o]) => [id, availabilityOf(config, blocks, o)])),
      workers: Object.fromEntries(Object.entries(config.workers).map(([id, w]) => [id, availabilityOf(config, blocks, w)])),
    });
    switch (command) {
      case "migrate-availability": return out(migrateAvailability(db,need("from",values.from)));
      case "show": {
        const withAvailability = <T extends Owner | Worker>(group: Record<string, T>) =>
          Object.fromEntries(Object.entries(group).map(([id, e]) => [id, { ...e, availability: availabilityOf(config, blocks, e) }]));
        return out({ source, path, state: file, config: { ...config, owners: withAvailability(config.owners), workers: withAvailability(config.workers) } });
      }
      case "status": return out({ now: new Date(now).toISOString(), state: file, blocks, ...availability() });
      case "resolve": return out(resolveDispatch(config, blocks, { owner: need("owner", values.owner), worker: values.worker, class: values.class, tag: values.tag, peer: values.peer }, env.HOME ?? homedir()));
      case "block": {
        const engine = need("engine", values.engine);
        if (!config.engines[engine]) throw new CliError(`unknown engine ${engine}`);
        const entry: Block = { engine, ...(values.model ? { model: values.model } : {}), reason: need("reason", values.reason), since: new Date(now).toISOString() };
        // Without --release-at no release_at is written: the block stays until a manual unblock.
        if (values["release-at"]) {
          entry.release_at = parseReleaseAt(values["release-at"], now);
          if (stamp(entry.release_at) <= now) throw new CliError("--release-at must be in the future");
        }
        if (values.by) entry.by = values.by;
        const purged = transaction(db,()=>{ const n=purgeExpired(db!,now); upsertBlock(db!,entry); return n; });
        return out({ block: entry, purged_expired: purged });
      }
      case "unblock": {
        const engine = need("engine", values.engine);
        const result = transaction(db,()=>{const purged_expired=purgeExpired(db!,now); const removed=removeBlock(db!,engine,values.model); return {removed,purged_expired};});
        return out(result);
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
  finally { db?.close(); }
}
if (import.meta.main) {
  const result = run(Bun.argv.slice(2));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.code);
}
