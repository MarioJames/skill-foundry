import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, parse, resolve, relative, sep } from "node:path";
import { CliError } from "./cli";
import { hash, validateBatch, type Batch, type Task } from "./scheduling";
import type { State } from "./dispatch-state";

export type Issue = { path: string; expected: string; received: string; next_step: string };
type Access = { id: string; adapter: "codex" | "qodercli" | "other"; reads: string[] | null; writes: string[] | null; work?: string };
type PublicTask = { key: string; revision: number; prompt: string; deliverable: string; acceptance: string[]; reads: string[] | null; writes: string[] | null; depends_on: string[] | null; mode: "oneshot" | "persistent"; blockers: string[]; cancelled?: boolean; complexity?: "ordinary" | "moderate" | "complex"; assessment_evidence?: string };
export type PublicContext = { version: 1; cwd: string; goal: string; constraints: string[]; owner: Access; external: Access[] | null; authorization: { delegate: boolean; basis: string }; tasks: PublicTask[] };

const safeId = (x: unknown) => typeof x === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/u.test(x);
const safeAccessId = (x: unknown) => typeof x === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,119}$/u.test(x);
const object = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x);
const summary = (x: unknown) => x === undefined ? "missing" : x === null ? "null" : Array.isArray(x) ? "array" : typeof x;

/** Fill unchanged facts from SQLite; callers send only facts that changed. */
export function expandPublicPatch(previous: PublicContext | undefined, raw: unknown): unknown {
  if (!previous || !object(raw)) return raw;
  const take = (key: keyof PublicContext) => Object.hasOwn(raw, key) ? raw[key] : previous[key];
  const tasks = Object.hasOwn(raw, "tasks") && Array.isArray(raw.tasks) ? raw.tasks.map((item: unknown) => {
    if (!object(item)) return item;
    const old = previous.tasks.find((t) => t.key === item.key);
    if (!old) return item;
    const { revision, cancelled, ...definition } = old;
    return { ...definition, ...item };
  }) : Object.hasOwn(raw, "tasks") ? raw.tasks : [];
  return { version: take("version"), cwd: take("cwd"), goal: take("goal"), constraints: take("constraints"),
    owner: object(raw.owner) ? { ...previous.owner, ...raw.owner } : take("owner"),
    external: take("external"), authorization: object(raw.authorization) ? { ...previous.authorization, ...raw.authorization } : take("authorization"), tasks };
}

/** Validate only the small caller contract and report every field error in one pass. */
export function validatePublicInput(raw: unknown): { input?: Omit<PublicContext, "tasks"> & { tasks: (Omit<PublicTask, "revision"> & { if_revision?: number })[] }; issues: Issue[] } {
  const issues: Issue[] = [];
  const add = (path: string, expected: string, value: unknown, next_step = "Correct this field and retry the same request") => issues.push({ path, expected, received: summary(value), next_step });
  if (!object(raw)) { add("/", "object", raw); return { issues }; }
  const r = raw;
  const text = (v: unknown, p: string) => { if (typeof v !== "string" || !v.trim()) add(p, "nonempty string", v); return typeof v === "string" ? v : ""; };
  const strings = (v: unknown, p: string, nullable = false): string[] | null => {
    if (nullable && (v === null || v === undefined)) return null;
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !x.trim())) add(p, nullable ? "array<string> | null" : "array<string>", v, "Use [] only when you have confirmed there are none; use null for unknown");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : nullable ? null : [];
  };
  if (r.version !== 1) add("/version", "1", r.version);
  const cwd = text(r.cwd, "/cwd");
  if (cwd && !isAbsolute(cwd)) add("/cwd", "absolute path", cwd);
  const goal = text(r.goal, "/goal");
  const constraints = strings(r.constraints ?? [], "/constraints")!;
  const access = (v: unknown, p: string): Access => {
    if (!object(v)) { add(p, "object", v); v = {}; }
    const x = v as Record<string, any>;
    if (!safeAccessId(x.id)) add(`${p}/id`, "safe caller or pane identifier", x.id);
    if (!["codex", "qodercli", "other"].includes(x.adapter)) add(`${p}/adapter`, "codex | qodercli | other", x.adapter);
    const reads = strings(x.reads, `${p}/reads`, true), writes = strings(x.writes, `${p}/writes`, true);
    return { id: x.id, adapter: x.adapter, reads, writes, ...(typeof x.work === "string" ? { work: x.work } : {}) };
  };
  const owner = access(r.owner, "/owner");
  text(owner.work, "/owner/work");
  let external: Access[] | null = null;
  if (r.external === undefined || r.external === null) external = null;
  else if (!Array.isArray(r.external)) add("/external", "array<object> | null", r.external);
  else external = r.external.map((x: unknown, i: number) => access(x, `/external/${i}`));
  if (!object(r.authorization)) add("/authorization", "object", r.authorization);
  const authorization = object(r.authorization) ? r.authorization : {};
  if (typeof authorization.delegate !== "boolean") add("/authorization/delegate", "boolean", authorization.delegate);
  text(authorization.basis, "/authorization/basis");
  if (!Array.isArray(r.tasks) || r.tasks.length > 32) add("/tasks", "array<object> (max 32)", r.tasks);
  const keys = new Set<string>();
  const tasks = (Array.isArray(r.tasks) ? r.tasks : []).map((item: unknown, i: number) => {
    const p = `/tasks/${i}`;
    if (!object(item)) { add(p, "object", item); item = {}; }
    const t = item as Record<string, any>;
    if (!safeId(t.key)) add(`${p}/key`, "safe identifier", t.key);
    else if (keys.has(t.key)) add(`${p}/key`, "unique task key", t.key);
    keys.add(t.key);
    text(t.prompt, `${p}/prompt`); text(t.deliverable, `${p}/deliverable`);
    const acceptance = strings(t.acceptance, `${p}/acceptance`)!;
    if (!acceptance.length) add(`${p}/acceptance`, "nonempty array<string>", t.acceptance);
    const reads = strings(t.reads, `${p}/reads`, true), writes = strings(t.writes, `${p}/writes`, true);
    const depends_on = strings(t.depends_on, `${p}/depends_on`, true);
    const blockers = strings(t.blockers ?? [], `${p}/blockers`)!;
    const mode = t.mode ?? "oneshot";
    if (!["oneshot", "persistent"].includes(mode)) add(`${p}/mode`, "oneshot | persistent", t.mode);
    if (t.if_revision !== undefined && (!Number.isSafeInteger(t.if_revision) || t.if_revision < 1)) add(`${p}/if_revision`, "positive integer", t.if_revision);
    if (t.complexity !== undefined && !["ordinary", "moderate", "complex"].includes(t.complexity)) add(`${p}/complexity`, "ordinary | moderate | complex", t.complexity);
    if (t.complexity !== undefined) text(t.assessment_evidence, `${p}/assessment_evidence`);
    return { key: t.key, prompt: t.prompt, deliverable: t.deliverable, acceptance, reads, writes, depends_on, blockers, mode, ...(t.if_revision === undefined ? {} : { if_revision: t.if_revision }), ...(t.complexity === undefined ? {} : { complexity: t.complexity, assessment_evidence: t.assessment_evidence }) };
  });
  return issues.length ? { issues } : { issues, input: { version: 1, cwd: resolve(cwd), goal, constraints, owner, external, authorization: { delegate: authorization.delegate, basis: authorization.basis }, tasks } };
}

export function mergePublicContext(previous: PublicContext | undefined, next: NonNullable<ReturnType<typeof validatePublicInput>["input"]>): PublicContext {
  if (previous && previous.cwd !== next.cwd) throw new CliError("scope_mismatch", "This scope is bound to a different working directory");
  const merged: PublicContext = { ...next, tasks: previous ? structuredClone(previous.tasks) : [] };
  for (const item of next.tasks) {
    const old = merged.tasks.find((t) => t.key === item.key);
    const { if_revision, ...definition } = item;
    if (!old) { if (if_revision !== undefined) throw new CliError("revision_conflict", `New task ${item.key} cannot have if_revision`); merged.tasks.push({ ...definition, revision: 1 }); continue; }
    const { revision, cancelled, ...oldDefinition } = old;
    if (hash(oldDefinition) === hash(definition)) continue;
    if (if_revision !== revision) throw new CliError("revision_conflict", `Task ${item.key} changed; set if_revision=${revision} after reviewing the prior attempt`);
    Object.assign(old, definition, { revision: revision + 1, cancelled: false });
  }
  if (!merged.tasks.length) throw new CliError("invalid_input", "First request needs at least one task", 2);
  const known = new Set(merged.tasks.map((t) => t.key));
  for (const t of merged.tasks) if (t.depends_on?.some((id) => !known.has(id))) throw new CliError("invalid_input", `Task ${t.key} has an unknown dependency`, 2);
  return merged;
}

function resourceKey(cwd: string, value: string): string {
  if (value.startsWith("db/") || value.startsWith("service/") || value.startsWith("redis/") || value.startsWith("bucket/")) return value;
  if (value.startsWith("/") || value.split("/").some((x) => x === "..")) throw new CliError("invalid_resource", `Resource ${value} must be relative to cwd or use db/service/redis/bucket`);
  const absolute = resolve(cwd, value);
  let ancestor = absolute;
  while (true) {
    try { lstatSync(ancestor); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new CliError("invalid_resource", `Cannot resolve resource ${value}`);
    ancestor = parent;
  }
  let canonical: string;
  try { canonical = resolve(realpathSync(ancestor), relative(ancestor, absolute)); }
  catch { throw new CliError("invalid_resource", `Cannot resolve resource ${value}; inspect symlinks and permissions`); }
  const parts = canonical.slice(parse(canonical).root.length).split(sep).filter(Boolean);
  return `file/root${parts.length ? `/${parts.map((part) => Buffer.from(part).toString("base64url")).join("/")}` : ""}`;
}
const resources = (cwd: string, a: { reads: string[] | null; writes: string[] | null }) =>
  a.reads === null || a.writes === null ? { status: "unknown" as const, reason: "read/write ownership not confirmed" } :
    { status: "known" as const, reads: a.reads.map((x) => resourceKey(cwd, x)), writes: a.writes.map((x) => resourceKey(cwd, x)) };

export function buildPublicBatch(scope: string, context: PublicContext, state: State): Batch {
  const tasks: Task[] = context.tasks.map((t) => {
    const attempts = state.attempts.filter((a) => a.task.id === t.key && a.task.revision === t.revision);
    const accepted = attempts.find((a) => a.acceptance);
    const active = attempts.find((a) => a.slot === "held" || a.writes_held);
    const status = accepted ? "accepted" : active ? active.slot === "held" ? "running" : "awaiting_acceptance" : t.cancelled ? "cancelled" : attempts.length ? "failed" : "pending";
    return {
      id: t.key, revision: t.revision, status,
      summary: t.prompt, inputs: [], deliverable: t.deliverable, acceptance: t.acceptance,
      depends_on: t.depends_on ?? [], resources: resources(context.cwd, t),
      uncertainties: [...t.blockers, ...(t.depends_on === null ? ["Dependencies not confirmed"] : [])].map((description) => ({ description, blocking: true })),
      requirements: { capabilities: [], owner_only: !context.authorization.delegate },
      decision_boundary: { delegated: [t.prompt], reserved_for_owner: ["integration, Git commits, shared configuration, approval, acceptance"], authorization_refs: [context.authorization.basis] },
      execution: { cwd: context.cwd, workspace_ref: context.cwd },
      ...(t.complexity ? { owner_assessment: { complexity: t.complexity, evidence: t.assessment_evidence! } } : {}),
      ...(accepted ? { acceptance_record: accepted.acceptance! } : {}),
    } as Task;
  });
  const access = [context.owner, ...(context.external ?? [])];
  return validateBatch({ version: 1, id: scope, goal: context.goal, constraints: [...context.constraints, `Parent currently: ${context.owner.work}`, ...(context.external ?? []).filter((x) => x.work).map((x) => `External ${x.id}: ${x.work}`)], goal_accepted: false, tasks,
    external_resources: access.filter((a) => a.reads !== null && a.writes !== null).map((a) => ({ id: a.id, reads: a.reads!.map((x) => resourceKey(context.cwd, x)), writes: a.writes!.map((x) => resourceKey(context.cwd, x)) })) });
}

export function contextBlockers(context: PublicContext): Issue[] {
  const issues: Issue[] = [];
  const add = (path: string) => issues.push({ path, expected: "confirmed array", received: "unknown", next_step: "Inspect the actual ownership and enter [] only if confirmed empty" });
  if (context.external === null) add("/external");
  if (context.owner.reads === null) add("/owner/reads");
  if (context.owner.writes === null) add("/owner/writes");
  context.external?.forEach((a, i) => { if (a.reads === null) add(`/external/${i}/reads`); if (a.writes === null) add(`/external/${i}/writes`); });
  return issues;
}
