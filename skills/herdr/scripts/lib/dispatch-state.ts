import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  lstatSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { CliError } from "./herdr-route";
import {
  hash,
  validateAcceptance,
  validateBatch,
  type Acceptance,
  type Assessment,
  type Attempt,
  type Batch,
  type Lane,
  type RoutingConfig,
  type Runtime,
} from "./scheduling";
import { prepareWave } from "./jev-decision";
export type Decision = {
  dispatch_checks?: { runtime: Runtime; status: string; error?: string }[];
  id: string;
  created_at: string;
  input_hash: string;
  prepared: ReturnType<typeof prepareWave>;
  result: {
    status: string;
    assignments: ReturnType<typeof prepareWave>["waves"][number]["assignments"];
    reason?: string;
  };
  assessment_request: unknown;
  assessment_response: unknown;
  wave_response: unknown;
};
export type State = {
  version: 1;
  batch_id: string | null;
  assessments: Record<string, Assessment>;
  decisions: Decision[];
  classification_runs: {
    id: string;
    request: unknown;
    response?: unknown;
    status: string;
    error?: string;
  }[];
  attempts: Attempt[];
};
const blank = (): State => ({
  version: 1,
  batch_id: null,
  assessments: {},
  decisions: [],
  classification_runs: [],
  attempts: [],
});
function fail(message: string): never {
  throw new CliError("dispatch_blocked", message);
}
export function readJson(path: string, max = 16_000_000): any {
  try {
    const s = lstatSync(path);
    if (!s.isFile() || s.isSymbolicLink() || s.size > max) throw Error();
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new CliError(
      "invalid_file",
      "Expected a readable bounded regular JSON file",
      2,
    );
  }
}
export class StateStore {
  readonly path: string;
  constructor(path: string) {
    this.path = resolve(path);
  }
  read(): State {
    if (!existsSync(this.path)) return blank();
    const s = readJson(this.path);
    if (
      s.version !== 1 ||
      !Array.isArray(s.decisions) ||
      !Array.isArray(s.attempts) ||
      !s.assessments
    )
      fail("Invalid scheduling state");
    return s;
  }
  async transaction<T>(
    work: (state: State, save: () => void) => Promise<T>,
  ): Promise<T> {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const lock = `${this.path}.lock`;
    let fd: number;
    try {
      fd = openSync(lock, "wx", 0o600);
    } catch {
      fail(
        "Scheduling state is locked; inspect the recorded PID before any manual stale-lock recovery",
      );
    }
    try {
      writeFileSync(
        fd!,
        JSON.stringify({
          pid: process.pid,
          created_at: new Date().toISOString(),
        }),
      );
      fsyncSync(fd!);
      const state = this.read();
      const save = () => {
        const serialized = JSON.stringify(state, null, 2) + "\n";
        if (Buffer.byteLength(serialized) > 16_000_000)
          throw new CliError(
            "state_budget",
            "State write exceeds 16 MB; previous durable state retained",
          );
        const temp = `${this.path}.${randomUUID()}.tmp`;
        let out: number | undefined;
        try {
          out = openSync(temp, "wx", 0o600);
          writeFileSync(out, serialized);
          fsyncSync(out);
          closeSync(out);
          out = undefined;
          renameSync(temp, this.path);
          const parent = openSync(dirname(this.path), "r");
          try {
            fsyncSync(parent);
          } finally {
            closeSync(parent);
          }
        } finally {
          if (out !== undefined) closeSync(out);
          if (existsSync(temp)) unlinkSync(temp);
        }
      };
      return await work(state, save);
    } finally {
      closeSync(fd!);
      unlinkSync(lock);
    }
  }
}
export function applyAcceptances(batch: Batch, state: State): Batch {
  const b = validateBatch(batch);
  for (const t of b.tasks) {
    const accepted = state.attempts.find(
      (a) =>
        a.task.id === t.id && a.task.revision === t.revision && a.acceptance,
    );
    if (accepted) {
      // Compare task definition independently from lifecycle fields before applying a delivered revision.
      const definition = (x: any) => {
        const { status, acceptance_record, ...rest } = x;
        return rest;
      };
      if (hash(definition(t)) !== hash(definition(accepted.binding.task)))
        fail("Accepted task definition changed without a revision");
      t.status = "accepted";
      t.acceptance_record = structuredClone(accepted.acceptance!);
    }
  }
  return b;
}
export function bindBatch(state: State, batch: Batch) {
  if (state.batch_id && state.batch_id !== batch.id)
    fail("State belongs to another batch; do not mix task identities");
  state.batch_id = batch.id;
}
export function reserve(
  state: State,
  d: Decision,
  batch: Batch,
  config: RoutingConfig,
  runtime: Runtime,
  path: string,
): Attempt[] {
  bindBatch(state, batch);
  if (d.result.status !== "selected" || !d.result.assignments.length)
    fail("Decision is not dispatchable");
  if (state.attempts.some((a) => a.decision_id === d.id))
    fail("Decision already reserved; observe existing attempts");
  if (hash(batch) !== d.input_hash || hash(config) !== hash(d.prepared.config))
    fail("Task or configuration changed since decision");
  const live = prepareWave(
    batch,
    config,
    d.prepared.assessments,
    runtime,
    state.attempts,
  );
  const ids = (items: { task_id: string }[]) =>
    items
      .map((a) => a.task_id)
      .sort()
      .join("|");
  const wave = live.waves.find(
    (w) => ids(w.assignments) === ids(d.result.assignments),
  );
  if (!wave)
    fail(
      `Selected wave no longer passes live checks: ${JSON.stringify(live.blocked)}`,
    );
  for (const a of d.result.assignments) {
    if (a.binding_hash !== hash(a.binding)) fail("Binding was modified");
    const current = wave!.assignments.find((x) => x.task_id === a.task_id)!;
    const contract = (x: typeof a) => ({
      goal: x.binding.goal,
      constraints: x.binding.constraints,
      task: x.binding.task,
      profile: x.binding.profile,
      launch: x.binding.launch,
      config: x.binding.config,
      dependencies: x.binding.dependencies,
      cli: x.binding.probe.cli_version,
      adapter: x.binding.probe.adapter_version,
    });
    if (hash(contract(a)) !== hash(contract(current)))
      fail("Execution contract changed");
  }
  const attempts = d.result.assignments.map((a) => {
    const id = randomUUID();
    return {
      id,
      task: { id: a.task_id, revision: a.task_revision },
      decision_id: d.id,
      binding: structuredClone(a.binding),
      binding_hash: a.binding_hash,
      slot: "held" as const,
      writes_held: true,
      phase: "prepared" as const,
      effects: [],
      lane: null,
      result_path: resolve(`${path}.results`, `${id}.json`),
    };
  });
  state.attempts.push(...attempts);
  return attempts;
}
export type Transport = {
  create: (attempt: Attempt) => Promise<Lane>;
  start: (
    attempt: Attempt,
  ) => Promise<{ session_id?: string; [key: string]: unknown }>;
  submit: (attempt: Attempt) => Promise<unknown>;
};
export async function runAttempt(
  a: Attempt,
  save: () => void,
  transport: Transport,
  beforeEffect?: () => void,
) {
  if (a.phase !== "prepared" || a.effects.length)
    fail(
      "Attempt already started; observation or owner reconciliation is required",
    );
  for (const operation of ["create_lane", "start_agent", "submit"] as const) {
    try {
      beforeEffect?.();
    } catch {
      a.resolution = {
        outcome: "authorization_changed",
        evidence: "Current task facts changed before next effect",
      };
      if (!a.effects.length) {
        a.phase = "cancelled";
        a.slot = "released";
        a.writes_held = false;
      }
      save();
      return;
    }
    const effect = {
      operation,
      state: "intent" as "intent" | "confirmed" | "unknown",
      correlation_key: randomUUID(),
      at: new Date().toISOString(),
      evidence: undefined as unknown,
    };
    a.effects.push(effect);
    a.phase = "starting";
    save();
    try {
      const result =
        operation === "create_lane"
          ? await transport.create(a)
          : operation === "start_agent"
            ? await transport.start(a)
            : await transport.submit(a);
      effect.evidence = result;
      effect.state = "confirmed";
      if (operation === "create_lane") a.lane = result as Lane;
      if (operation === "start_agent" && (result as any)?.session_id)
        a.session_id = (result as any).session_id;
      if (operation === "submit") a.phase = "running";
      save();
    } catch (error) {
      effect.state = "unknown";
      effect.evidence = {
        reason: "side_effect_reply_unconfirmed",
        code: error instanceof CliError ? error.code : "unclassified_error",
      };
      save();
      return;
    }
  }
}
export function acceptAttempt(state: State, id: string, value: unknown) {
  const proof = validateAcceptance(value),
    a = state.attempts.find((a) => a.id === id);
  if (!a) fail("Unknown attempt");
  if (
    a.resolution &&
    ["not_performed", "failed_stopped", "cancelled_stopped"].includes(
      a.resolution.outcome,
    )
  )
    fail("Owner-terminated attempt cannot be accepted");
  if (
    state.attempts.some(
      (other) =>
        other !== a &&
        other.task.id === a.task.id &&
        other.task.revision === a.task.revision &&
        other.acceptance,
    )
  )
    fail("This task revision already has an accepted attempt");
  if (
    a.phase !== "finished" ||
    a.slot !== "released" ||
    a.result?.status !== "completed"
  )
    fail("Only an observed completed attempt can be accepted");
  if (
    proof.attempt_id !== id ||
    proof.task_revision !== a.task.revision ||
    !proof.artifact_refs.length ||
    proof.artifact_refs.some((ref) => !a.result!.artifact_refs.includes(ref))
  )
    fail("Acceptance must bind exact delivered artifacts and task revision");
  if (
    state.attempts.some(
      (other) =>
        other !== a &&
        other.task.id === a.task.id &&
        (other.slot === "held" || other.writes_held),
    )
  )
    fail("Another revision still owns this task");
  a.acceptance = structuredClone(proof);
  a.writes_held = false;
}
export function resolveAttempt(a: Attempt, outcome: string, evidence: string) {
  if (!evidence.trim()) fail("Owner evidence is required");
  if (
    !["not_performed", "failed_stopped", "cancelled_stopped"].includes(outcome)
  )
    fail("Unknown resolution outcome");
  if (a.acceptance) fail("Accepted attempt cannot be reconciled again");
  if (
    outcome === "not_performed" &&
    a.effects.some((e) => e.state === "confirmed")
  )
    fail("Confirmed effects exist; inspect and resolve as stopped instead");
  a.resolution = { outcome, evidence };
  a.slot = "released";
  a.writes_held = false;
  a.phase = outcome === "failed_stopped" ? "failed" : "cancelled";
}
