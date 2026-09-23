import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { CliError } from "./herdr-route";
import type {
  Complexity,
  ExecutionProfile,
  LaunchSpec,
  ProfileProbe,
  RoutingConfig,
} from "./agent-engines";
export type { Complexity, ExecutionProfile, RoutingConfig };
export type ResourceAccess =
  | { status: "known"; reads: string[]; writes: string[] }
  | { status: "unknown"; reason: string };
export type TaskKey = { id: string; revision: number };
export type Acceptance = {
  task_revision: number;
  attempt_id: string;
  artifact_refs: string[];
  delivery_evidence_ref: string;
  owner_evidence_ref: string;
};
export type Task = {
  id: string;
  revision: number;
  status:
    | "pending"
    | "blocked"
    | "running"
    | "awaiting_acceptance"
    | "accepted"
    | "failed"
    | "cancelled";
  summary: string;
  inputs: { summary: string; evidence_refs: string[] }[];
  deliverable: string;
  acceptance: string[];
  depends_on: string[];
  resources: ResourceAccess;
  uncertainties: { description: string; blocking: boolean }[];
  requirements: { capabilities: string[]; owner_only: boolean };
  decision_boundary: {
    delegated: string[];
    reserved_for_owner: string[];
    authorization_refs: string[];
  };
  execution: { cwd: string; workspace_ref: string };
  owner_assessment?: { complexity: Complexity; evidence: string };
  acceptance_record?: Acceptance;
};
export type Batch = {
  owner_wave?: { task_ids: string[]; evidence: string };
  version: 1;
  id: string;
  goal: string;
  constraints: string[];
  goal_accepted: boolean;
  tasks: Task[];
  external_resources: { id: string; reads: string[]; writes: string[] }[];
};
export type Assessment = {
  task_id: string;
  task_revision: number;
  input_hash: string;
  template_version: string;
  source: "jev" | "owner";
  outcome: Complexity | "need_context" | "owner_required";
  reason: string;
  answer?: unknown;
  evidence?: string;
};
export type RuntimeAgent = {
  adapter?: string;
  pane_id: string;
  engine_id: string | null;
  state: string;
  session_id?: string;
  cwd?: string;
};
export type Runtime = {
  observed_at: string;
  agents: RuntimeAgent[];
  probes: Record<Complexity, ProfileProbe>;
};
export type Binding = {
  goal: string;
  constraints: string[];
  task: Task;
  config: RoutingConfig;
  profile: ExecutionProfile;
  launch: LaunchSpec;
  probe: ProfileProbe;
  dependencies: { task: TaskKey; acceptance: Acceptance }[];
};
export type Assignment = {
  task_id: string;
  task_revision: number;
  binding: Binding;
  binding_hash: string;
};
export type Wave = { id: string; assignments: Assignment[] };
export type Lane = {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  cleanup_command: string[];
  ownership: "created";
};
export type Effect = {
  operation: "create_lane" | "start_agent" | "submit";
  state: "intent" | "confirmed" | "unknown" | "rejected";
  correlation_key: string;
  at: string;
  evidence?: unknown;
};
export type Attempt = {
  id: string;
  task: TaskKey;
  decision_id: string;
  binding: Binding;
  binding_hash: string;
  slot: "held" | "released";
  writes_held: boolean;
  phase:
    "prepared" | "starting" | "running" | "finished" | "failed" | "cancelled";
  effects: Effect[];
  lane: Lane | null;
  session_id?: string;
  result_path: string;
  result?: {
    attempt_id: string;
    task_id: string;
    task_revision: number;
    status: "completed" | "failed";
    summary: string;
    artifact_refs: string[];
  };
  observed?: unknown;
  observation_error?: string;
  acceptance?: Acceptance;
  cleanup?: unknown;
  resolution?: { outcome: string; evidence: string };
};
export function invalid(message: string): never {
  throw new CliError("invalid_input", message, 2);
}
export function object(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid(`${label} must be an object`);
  return value as Record<string, any>;
}
export function fields(
  v: Record<string, any>,
  required: string[],
  optional: string[] = [],
  label = "object",
) {
  if (
    required.some((k) => !Object.hasOwn(v, k)) ||
    Object.keys(v).some((k) => ![...required, ...optional].includes(k))
  )
    invalid(
      `${label}: expected ${required.join(", ")}${optional.length ? `; optional ${optional.join(", ")}` : ""}`,
    );
}
export function textValue(v: unknown, label: string): string {
  if (
    typeof v !== "string" ||
    !v.trim() ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(v)
  )
    invalid(`${label} must be nonempty text`);
  return v;
}
export function identifier(v: unknown, label: string): string {
  const s = textValue(v, label);
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/u.test(s) ||
    ["constructor", "prototype", "__proto__"].includes(s)
  )
    invalid(`${label} must be a safe identifier`);
  return s;
}
export function list(v: unknown, label: string, max = 64): any[] {
  if (!Array.isArray(v) || v.length > max)
    invalid(`${label} must be an array (max ${max})`);
  return v;
}
export function strings(v: unknown, label: string): string[] {
  return list(v, label).map((x) => textValue(x, label));
}
function integer(v: unknown, label: string) {
  if (!Number.isSafeInteger(v) || Number(v) < 1)
    invalid(`${label} must be a positive integer`);
}
function bool(v: unknown, label: string) {
  if (typeof v !== "boolean") invalid(`${label} must be boolean`);
}
function unique(v: string[], label: string) {
  if (new Set(v).size !== v.length) invalid(`${label} must be unique`);
}
function resourceKeys(v: unknown, label: string) {
  const a = strings(v, label);
  unique(a, label);
  for (const s of a) {
    if (
      s !== s.trim() ||
      /[\\*?\[\]{}\s]/u.test(s) ||
      s.split("/").some((x) => !x || x === "." || x === "..")
    )
      invalid(`${label} requires canonical resource keys`);
  }
  return a;
}
export function validateAcceptance(v: unknown): Acceptance {
  const a = object(v, "acceptance_record");
  fields(a, [
    "task_revision",
    "attempt_id",
    "artifact_refs",
    "delivery_evidence_ref",
    "owner_evidence_ref",
  ]);
  integer(a.task_revision, "task_revision");
  identifier(a.attempt_id, "attempt_id");
  strings(a.artifact_refs, "artifact_refs");
  textValue(a.delivery_evidence_ref, "delivery_evidence_ref");
  textValue(a.owner_evidence_ref, "owner_evidence_ref");
  return a as Acceptance;
}
export function validateBatch(value: unknown): Batch {
  const b = object(structuredClone(value), "batch");
  fields(
    b,
    [
      "version",
      "id",
      "goal",
      "constraints",
      "goal_accepted",
      "tasks",
      "external_resources",
    ],
    ["owner_wave"],
  );
  if (b.version !== 1) invalid("batch.version must be 1");
  identifier(b.id, "batch.id");
  textValue(b.goal, "goal");
  strings(b.constraints, "constraints");
  bool(b.goal_accepted, "goal_accepted");
  for (const raw of list(b.tasks, "tasks", 32)) {
    const t = object(raw, "task");
    fields(
      t,
      [
        "id",
        "revision",
        "status",
        "summary",
        "inputs",
        "deliverable",
        "acceptance",
        "depends_on",
        "resources",
        "uncertainties",
        "requirements",
        "decision_boundary",
        "execution",
      ],
      ["owner_assessment", "acceptance_record"],
      "task",
    );
    identifier(t.id, "task.id");
    integer(t.revision, "task.revision");
    if (
      ![
        "pending",
        "blocked",
        "running",
        "awaiting_acceptance",
        "accepted",
        "failed",
        "cancelled",
      ].includes(t.status)
    )
      invalid("invalid task.status");
    textValue(t.summary, "summary");
    textValue(t.deliverable, "deliverable");
    strings(t.acceptance, "acceptance");
    if (!t.acceptance.length) invalid("acceptance cannot be empty");
    strings(t.depends_on, "depends_on");
    unique(t.depends_on, "depends_on");
    for (const raw of list(t.inputs, "inputs")) {
      const x = object(raw, "input");
      fields(x, ["summary", "evidence_refs"]);
      textValue(x.summary, "input.summary");
      strings(x.evidence_refs, "evidence_refs");
    }
    const r = object(t.resources, "resources");
    if (r.status === "known") {
      fields(r, ["status", "reads", "writes"]);
      resourceKeys(r.reads, "reads");
      resourceKeys(r.writes, "writes");
    } else if (r.status === "unknown") {
      fields(r, ["status", "reason"]);
      textValue(r.reason, "resources.reason");
    } else invalid("invalid resources.status");
    for (const raw of list(t.uncertainties, "uncertainties")) {
      const u = object(raw, "uncertainty");
      fields(u, ["description", "blocking"]);
      textValue(u.description, "uncertainty");
      bool(u.blocking, "blocking");
    }
    const req = object(t.requirements, "requirements");
    fields(req, ["capabilities", "owner_only"]);
    strings(req.capabilities, "capabilities");
    bool(req.owner_only, "owner_only");
    const d = object(t.decision_boundary, "decision_boundary");
    fields(d, ["delegated", "reserved_for_owner", "authorization_refs"]);
    for (const k of Object.keys(d)) strings(d[k], k);
    const e = object(t.execution, "execution");
    fields(e, ["cwd", "workspace_ref"]);
    if (!isAbsolute(textValue(e.cwd, "cwd"))) invalid("cwd must be absolute");
    textValue(e.workspace_ref, "workspace_ref");
    if (t.owner_assessment !== undefined) {
      const a = object(t.owner_assessment, "owner_assessment");
      fields(a, ["complexity", "evidence"]);
      if (!["ordinary", "moderate", "complex"].includes(a.complexity))
        invalid("invalid complexity");
      textValue(a.evidence, "assessment evidence");
    }
    if (t.acceptance_record !== undefined) {
      validateAcceptance(t.acceptance_record);
      if (t.acceptance_record.task_revision !== t.revision)
        invalid("acceptance revision mismatch");
    }
    if (t.status === "accepted" && !t.acceptance_record)
      invalid("accepted task requires acceptance_record");
  }
  if (!b.tasks.length) invalid("tasks must not be empty");
  unique(
    b.tasks.map((t: Task) => t.id),
    "task IDs",
  );
  const tasks = new Map<string, Task>(b.tasks.map((t: Task) => [t.id, t]));
  const visited = new Set<string>(),
    visiting = new Set<string>();
  function visit(t: Task) {
    if (visiting.has(t.id)) invalid("dependency cycle");
    if (visited.has(t.id)) return;
    visiting.add(t.id);
    for (const id of t.depends_on) {
      const d = tasks.get(id);
      if (!d) invalid("unknown dependency");
      visit(d);
    }
    visiting.delete(t.id);
    visited.add(t.id);
  }
  tasks.forEach(visit);
  for (const raw of list(b.external_resources, "external_resources")) {
    const r = object(raw, "external resource");
    fields(r, ["id", "reads", "writes"]);
    textValue(r.id, "reservation id");
    resourceKeys(r.reads, "reads");
    resourceKeys(r.writes, "writes");
  }
  if (b.owner_wave !== undefined) {
    const w = object(b.owner_wave, "owner_wave");
    fields(w, ["task_ids", "evidence"]);
    strings(w.task_ids, "task_ids");
    unique(w.task_ids, "task_ids");
    textValue(w.evidence, "owner wave evidence");
    if (!w.task_ids.length || w.task_ids.some((id: string) => !tasks.has(id)))
      invalid("owner_wave requires existing unique tasks");
  }
  return b as Batch;
}
export function canonical(v: any): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v)
    .sort()
    .filter((k) => v[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
    .join(",")}}`;
}
export function hash(v: unknown): string {
  return createHash("sha256").update(canonical(v)).digest("hex");
}
export function overlaps(a: string, b: string) {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}
export function conflicts(
  a: { reads: string[]; writes: string[] },
  b: { reads: string[]; writes: string[] },
) {
  return (
    a.writes.some((x) =>
      [...b.reads, ...b.writes].some((y) => overlaps(x, y)),
    ) || b.writes.some((x) => a.reads.some((y) => overlaps(x, y)))
  );
}
export function eligibility(
  batch: Batch,
  task: Task,
  attempts: Attempt[] = [],
): string | null {
  if (task.status !== "pending") return `task_${task.status}`;
  if (task.requirements.owner_only) return "owner_only";
  if (task.resources.status !== "known") return "ownership_unknown";
  if (task.uncertainties.some((u) => u.blocking)) return "blocking_context";
  if (
    attempts.some(
      (a) => a.task.id === task.id && (a.slot === "held" || a.writes_held),
    )
  )
    return "unresolved_attempt";
  if (
    task.depends_on.some(
      (id) => batch.tasks.find((t) => t.id === id)!.status !== "accepted",
    )
  )
    return "dependency_not_accepted";
  return null;
}
