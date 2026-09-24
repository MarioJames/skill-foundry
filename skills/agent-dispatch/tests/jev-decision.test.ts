import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  prepareAssessment,
  resolveAssessment,
  prepareWave,
  resolveWave,
  callJev,
  waveConfidenceThreshold,
} from "../scripts/lib/jev-decision";
import { buildLaunch, executionProfile } from "../scripts/lib/agent-engines";
import { hash, validateBatch } from "../scripts/lib/scheduling";

const fixture = () =>
  JSON.parse(
    readFileSync(
      new URL("../examples/jev-batch.json", import.meta.url),
      "utf8",
    ),
  );
const config = () => ({
  version: 1,
  engines: {
    codex: { adapter: "codex", max_parallel: 3 },
    qoder: { adapter: "qodercli", max_parallel: 2 },
  },
  routes: {
    ordinary: {
      engine_id: "qoder",
      model: "Qwen3.8-Flash",
      reasoning: { mode: "effort", value: "xhigh" },
    },
    moderate: {
      engine_id: "codex",
      model: "gpt-6-astra",
      reasoning: { mode: "effort", value: "medium" },
    },
    complex: {
      engine_id: "codex",
      model: "gpt-6-astra",
      reasoning: { mode: "effort", value: "high" },
    },
  },
  limits: { max_parallel: 4 },
});
const reply = (
  questions: Record<string, any>,
  choices: Record<string, string> = {},
  confidence: number | undefined = 0.95,
) => ({
  model: "typesafe/jev-1.13",
  answers: Object.fromEntries(
    Object.keys(questions).map((k) => [
      k,
      {
        type: "choice",
        choice: choices[k] ?? "ordinary",
        ...(confidence === undefined ? {} : { confidence }),
      },
    ]),
  ),
  usage: { input_tokens: 100, output_tokens: 0 },
});
const runtime = (c: any) => ({
  observed_at: "2026-09-23T00:00:00Z",
  agents: [],
  probes: Object.fromEntries(
    Object.entries(c.routes).map(([k, p]: any) => [
      k,
      {
        status: "supported",
        checked_at: "2026-09-23T00:00:00Z",
        adapter_version: "fixture",
        cli_version: "fixture",
        reason: "validated fixture",
        launch: buildLaunch(c, p),
        profile: p,
        evidence: ["fixture boundary"],
      },
    ]),
  ),
});
function classified(b: any) {
  const p = prepareAssessment(b, {});
  return {
    ...p.cached,
    ...resolveAssessment(
      p,
      reply(
        p.request!.questions,
        Object.fromEntries(
          Object.keys(p.request!.questions).map((k) => [
            k,
            k.includes("money") ? "moderate" : "ordinary",
          ]),
        ),
      ),
    ).assessments,
  };
}

test("task classification is separate from execution routing and dependency release", () => {
  const b = validateBatch(fixture()),
    c = config();
  const a = prepareAssessment(b, {});
  expect(Object.keys(a.request!.questions)).toHaveLength(2);
  expect(JSON.stringify(a.request)).not.toContain("Qwen");
  const p = prepareWave(b, c as any, classified(b), runtime(c) as any, []);
  expect(
    p.waves[0].assignments.map((x) => x.binding.profile.engine_id),
  ).toEqual(["qoder", "codex"]);
  expect(
    p.waves.some((w) => w.assignments.some((x) => x.task_id === "integrate")),
  ).toBe(false);
  const result = resolveWave(
    p,
    reply(p.request!.questions, { schedule: p.waves[0].id }),
  );
  expect(result.status).toBe("selected");
  expect(result.assignments).toHaveLength(2);
});

test("override eliminates classification requests but keeps Jev parallel selection and local guards", () => {
  const b = validateBatch(fixture()), c: any = { ...config(), manual_override: { route: "moderate" } };
  const a = prepareAssessment(b, {}, [], c);
  expect(a.request).toBeNull();
  expect(a.cached.date.source).toBe("config");
  expect(a.cached.date.outcome).toBe("configured");
  const r = runtime(c);
  for (const k of ["ordinary", "moderate", "complex"] as const) {
    const profile = executionProfile(c, k);
    r.probes[k] = { ...r.probes[k], profile, launch: buildLaunch(c, profile) };
  }
  const w = prepareWave(b, c, a.cached, r as any, []);
  expect(Object.keys(w.request!.questions)).toEqual(["schedule"]);
  expect(w.waves[0].assignments).toHaveLength(2);
  expect(w.waves[0].assignments.every((x) => x.binding.profile.model === c.routes.moderate.model)).toBe(true);
  expect(w.blocked.some((x) => x.task_id === "integrate")).toBe(true);
  b.owner_wave = { task_ids: ["date", "money"], evidence: "Owner prefers these independent tasks" };
  expect(Object.keys(prepareWave(b, c, a.cached, r as any, []).request!.questions)).toEqual(["schedule"]);
  // Removing override must ask A again rather than reusing a made-up difficulty.
  expect(prepareAssessment(b, a.cached, [], config() as any).request).not.toBeNull();
  // An unresolved RPC attempt shares capacity and writes with the Herdr batch.
  const held: any = { id: "rpc", backend: "rpc", task: { id: "rpc-other", revision: 1 }, slot: "held", writes_held: true, lane: null, binding: { launch: { kind: "codex" }, task: { resources: { status: "known", reads: [], writes: ["repo/date"] } } } };
  c.limits.max_parallel = 1;
  const blocked = prepareWave(b, c, a.cached, r as any, [held]);
  expect(blocked.waves).toHaveLength(0);
  expect(blocked.blocked.some((x) => x.reason === "capacity")).toBe(true);
});

test("native difficulty never upgrades just to escape an unavailable engine", () => {
  const b = validateBatch(fixture()),
    c = config(),
    r = runtime(c);
  r.probes.ordinary.status = "unsupported";
  const p = prepareWave(b, c as any, classified(b), r as any, []);
  expect(
    p.waves.flatMap((w) => w.assignments).every((a) => a.task_id !== "date"),
  ).toBe(true);
  expect(
    p.blocked.some(
      (x) => x.task_id === "date" && x.reason.includes("capability"),
    ),
  ).toBe(true);
});

test("manual routing wins over all difficulty levels while preserving guards and engine capacity", () => {
  const b = validateBatch(fixture()), c: any = config();
  b.tasks[0].owner_assessment = { complexity: "complex", evidence: "cross-module reasoning" };
  const a = classified(b);
  expect(a.date.outcome).toBe("complex");
  expect(a.money.outcome).toBe("moderate");
  for (const override of [{ route: "ordinary" }, c.routes.ordinary]) {
    c.manual_override = override;
    const r: any = runtime(c);
    r.probes.moderate = r.probes.complex = structuredClone(r.probes.ordinary);
    const p = prepareWave(b, c, a, r, []);
    expect(p.waves[0].assignments.map(x => x.binding.launch)).toEqual([
      { kind: "qodercli", argv: ["--model", "Qwen3.8-Flash", "--reasoning-effort", "xhigh"] },
      { kind: "qodercli", argv: ["--model", "Qwen3.8-Flash", "--reasoning-effort", "xhigh"] },
    ]);
    expect(p.assessments.date.outcome).toBe("complex");
    expect(p.blocked.some(x => x.task_id === "integrate")).toBe(true);
    c.engines.qoder.max_parallel = 1;
    expect(prepareWave(b, c, a, r, []).waves.every(w => w.assignments.length === 1)).toBe(true);
    c.engines.qoder.max_parallel = 2;
    const exits = { ...a, date: { ...a.date, outcome: "owner_required" }, money: { ...a.money, outcome: "need_context" } };
    expect(prepareWave(b, c, exits, r, []).waves).toHaveLength(0);
    r.probes.moderate.status = r.probes.complex.status = "unknown";
    expect(prepareWave(b, c, a, r, []).waves).toHaveLength(0);
  }
  c.manual_override = { route: "ordinary" };
  // Old automatic probes must not authorize the new target profile.
  expect(prepareWave(b, c, a, runtime(c) as any, []).waves).toHaveLength(0);
});

test("unknown ownership, cycles, duplicate IDs and malformed declarations are not empty access", () => {
  const b = fixture();
  b.tasks[0].resources = { status: "unknown", reason: "not inspected" };
  expect(
    prepareAssessment(validateBatch(b), {}).blocked.some(
      (x) => x.task_id === "date",
    ),
  ).toBe(true);
  for (const mutate of [
    (v: any) => v.tasks[0].depends_on.push("integrate"),
    (v: any) => v.tasks.push(v.tasks[0]),
    (v: any) => (v.tasks[0].resources.writes = ["repo/../x"]),
  ]) {
    const x = fixture();
    mutate(x);
    expect(() => validateBatch(x)).toThrow();
  }
});

test("classification cache follows evidence and accepted dependency versions, not capacity", () => {
  const b = validateBatch(fixture()),
    a = classified(b);
  expect(prepareAssessment(b, a).request).toBeNull();
  const x = structuredClone(b);
  x.constraints.push("changed execution boundary");
  expect(prepareAssessment(x, a).request).not.toBeNull();
  expect(hash({ a: 1, b: 2 })).toBe(hash({ b: 2, a: 1 }));
});

test("response shape is validated separately from confidence adoption", () => {
  const p = prepareAssessment(validateBatch(fixture()), {});
  const noConfidence = reply(p.request!.questions);
  Object.values(noConfidence.answers).forEach((a: any) => delete a.confidence);
  const missing = resolveAssessment(p, noConfidence);
  expect(
    Object.values(missing.assessments).every(
      (a) =>
        a.outcome === "owner_required" && a.reason === "confidence_missing",
    ),
  ).toBe(true);
  const exits = reply(
    p.request!.questions,
    Object.fromEntries(
      Object.keys(p.request!.questions).map((k) => [k, "need_context"]),
    ),
    0.1,
  );
  expect(
    Object.values(resolveAssessment(p, exits).assessments).every(
      (a) => a.outcome === "need_context",
    ),
  ).toBe(true);
  const malformed = reply(p.request!.questions);
  delete malformed.answers[Object.keys(malformed.answers)[0]];
  expect(() => resolveAssessment(p, malformed)).toThrow();
  const extra = reply(p.request!.questions);
  extra.answers.invented = { type: "choice", choice: "ordinary" };
  expect(() => resolveAssessment(p, extra)).toThrow();
});

test("resource conflicts, external occupancy, and same-task earlier revisions constrain waves", () => {
  const b = validateBatch(fixture()),
    c = config(),
    r = runtime(c);
  b.tasks[1].resources = {
    status: "known",
    reads: ["repo/project/src"],
    writes: [],
  };
  const a = classified(b);
  expect(
    prepareWave(b, c as any, a, r as any, []).waves.every(
      (w) => w.assignments.length === 1,
    ),
  ).toBe(true);
  const busy: any = {
    id: "old",
    task: { id: "date", revision: 0 },
    slot: "held",
    writes_held: true,
    binding: { task: b.tasks[0], profile: c.routes.ordinary },
    lane: null,
  };
  expect(
    prepareWave(b, c as any, a, r as any, [busy])
      .waves.flatMap((w) => w.assignments)
      .every((x) => x.task_id !== "date"),
  ).toBe(true);
  r.agents = Array.from({ length: 4 }, (_, i) => ({
    pane_id: `p${i}`,
    engine_id: null,
    state: "working",
  })) as any;
  expect(prepareWave(b, c as any, a, r as any, []).local_status).toBe("wait");
});

test("complete needs accepted results plus owner goal coverage; cancelled is not complete", () => {
  const b = validateBatch(fixture()),
    c = config();
  b.tasks.forEach((t) => {
    t.status = "cancelled";
  });
  expect(prepareWave(b, c as any, {}, runtime(c) as any, []).local_status).toBe(
    "owner_required",
  );
});

test("Jev uses bounded Decisions requests and redacts provider failures without retry", async () => {
  const p = prepareAssessment(validateBatch(fixture()), {});
  let calls = 0;
  const data = await callJev(p.request!, {
    apiKey: "secret",
    fetch: (async (url, init) => {
      calls++;
      expect(url).toBe("https://openrouter.ai/api/alpha/decisions");
      expect(new Headers(init!.headers).get("authorization")).toBe(
        "Bearer secret",
      );
      return Response.json(reply(p.request!.questions));
    }) as typeof fetch,
  });
  expect(data.model).toBe("typesafe/jev-1.13");
  expect(calls).toBe(1);
  await expect(
    callJev(p.request!, {
      apiKey: "secret",
      fetch: (async () =>
        new Response("secret", { status: 429 })) as unknown as typeof fetch,
    }),
  ).rejects.toThrow("429");
  const b = fixture();
  b.constraints = ["约束".repeat(20000)];
  expect(() => prepareAssessment(validateBatch(b), {})).toThrow();
});

test("single wave keeps semantic exits and permanent blocks do not become wait", () => {
  const b = validateBatch(fixture()),
    c = config();
  b.tasks[1].status = "cancelled";
  const r = runtime(c),
    p = prepareWave(b, c as any, classified(b), r as any, []);
  expect(p.request?.questions.schedule.criteria.need_context).toBeDefined();
  const serial = resolveWave(p, reply(p.request!.questions, { schedule: "serial" }, 0.4));
  expect(serial.status).toBe("serial");
  expect(serial.assignments).toHaveLength(0);
  expect(
    resolveWave(p, reply(p.request!.questions, { schedule: "owner_required" }))
      .status,
  ).toBe("owner_required");
  b.tasks[0].requirements.owner_only = true;
  r.agents = [
    { pane_id: "external", engine_id: "codex", state: "working" },
  ] as any;
  expect(prepareWave(b, c as any, {}, r as any, []).local_status).toBe(
    "owner_required",
  );
});

test("bounded Codex handoffs use the calibrated B threshold without relaxing other routes", () => {
  const b = validateBatch(fixture()), c: any = { ...config(), manual_override: { route: "moderate" } };
  b.tasks[1].status = "cancelled";
  const r = runtime(c);
  for (const k of ["ordinary", "moderate", "complex"] as const) {
    const profile = executionProfile(c, k);
    r.probes[k] = { ...r.probes[k], profile, launch: buildLaunch(c, profile) };
  }
  const p = prepareWave(b, c, prepareAssessment(b, {}, [], c).cached, r as any, []);
  expect(waveConfidenceThreshold(p, "oneshot")).toBe(0.65);
  expect(waveConfidenceThreshold(p, "persistent")).toBe(0.8);
  const answer = (confidence: number | undefined) => reply(p.request!.questions, { schedule: "wave_1" }, confidence);
  expect(resolveWave(p, answer(0.65), waveConfidenceThreshold(p, "oneshot")).status).toBe("selected");
  const rejected = resolveWave(p, answer(0.64), waveConfidenceThreshold(p, "oneshot"));
  expect(rejected.reason).toBe("below_confidence_policy");
  expect(rejected.selection).toEqual({ choice: "wave_1", confidence: 0.64, min_confidence: 0.65 });
  expect(resolveWave(p, answer(0.78)).status).toBe("owner_required");
  const missing = answer(0.65); delete (missing.answers.schedule as any).confidence;
  expect(resolveWave(p, missing, 0.65).reason).toBe("confidence_missing");
  p.waves[0].assignments[0].binding.launch.kind = "qodercli";
  expect(waveConfidenceThreshold(p, "oneshot")).toBe(0.8);
});
test("unknown external ownership blocks and engine rename cannot reset capacity", () => {
  const b = validateBatch(fixture()),
    c = config(),
    r = runtime(c);
  r.agents = [
    { pane_id: "external", engine_id: "codex", state: "working" },
  ] as any;
  expect(
    prepareWave(b, c as any, classified(b), r as any, []).waves,
  ).toHaveLength(0);
  r.agents = [];
  c.engines.codex.max_parallel = 1;
  const old: any = {
    task: { id: "other", revision: 1 },
    slot: "held",
    writes_held: true,
    lane: null,
    binding: {
      profile: { engine_id: "old-codex" },
      launch: { kind: "codex" },
      task: { resources: { status: "known", reads: [], writes: [] } },
    },
  };
  expect(
    prepareWave(b, c as any, classified(b), r as any, [old])
      .waves.flatMap((w) => w.assignments)
      .some((a) => a.task_id === "money"),
  ).toBe(false);
});
test("cached answers are adopted under current threshold and malformed optional probabilities rejected", () => {
  const b = validateBatch(fixture()),
    p = prepareAssessment(b, {}),
    response = reply(p.request!.questions, {}, 0.5);
  const cache = resolveAssessment(p, response, 0.4).assessments;
  expect(
    Object.values(prepareAssessment(b, cache).cached).every(
      (a) => a.outcome === "owner_required",
    ),
  ).toBe(true);
  (response.answers[Object.keys(response.answers)[0]] as any).probabilities = {
    ordinary: -2,
    unexpected: 7,
  };
  expect(() => resolveAssessment(p, response)).toThrow();
});
test("classification receives accepted upstream artifacts whose content is hashed", () => {
  const b = validateBatch(fixture());
  for (const t of b.tasks.slice(0, 2)) {
    t.status = "accepted";
    t.acceptance_record = {
      task_revision: 1,
      attempt_id: "a",
      artifact_refs: [`artifact-${t.id}`],
      delivery_evidence_ref: "delivered",
      owner_evidence_ref: "accepted",
    };
  }
  expect(JSON.stringify(prepareAssessment(b, {}).request)).toContain(
    "artifact-date",
  );
});

test("known unconfigured adapters consume global capacity only; replaced sessions are not deduplicated", () => {
  const b = validateBatch(fixture()),
    c = config(),
    r = runtime(c);
  c.engines.qoder.max_parallel = 1;
  r.agents = [
    {
      pane_id: "external",
      engine_id: null,
      adapter: "claude",
      state: "working",
    },
  ] as any;
  b.external_resources = [{ id: "external", reads: [], writes: [] }];
  expect(
    prepareWave(b, c as any, classified(b), r as any, [])
      .waves.flatMap((w) => w.assignments)
      .some((a) => a.task_id === "date"),
  ).toBe(true);
  const held: any = {
    task: { id: "older", revision: 1 },
    slot: "held",
    writes_held: true,
    session_id: "old",
    lane: { pane_id: "external" },
    binding: {
      profile: { engine_id: "codex" },
      launch: { kind: "codex" },
      task: { resources: { status: "known", reads: [], writes: [] } },
    },
  };
  r.agents = [
    {
      pane_id: "external",
      engine_id: "qoder",
      adapter: "qodercli",
      session_id: "new",
      state: "working",
    },
  ] as any;
  expect(
    prepareWave(b, c as any, classified(b), r as any, [held])
      .waves.flatMap((w) => w.assignments)
      .some((a) => a.task_id === "date"),
  ).toBe(false);
});

test("explicit owner wave evidence can determine grouping but cannot bypass local guards", () => {
  const b = fixture();
  b.owner_wave = {
    task_ids: ["date", "money"],
    evidence: "Owner verified independent formatter contracts",
  };
  const valid = validateBatch(b),
    c = config(),
    r = runtime(c);
  const p = prepareWave(valid, c as any, classified(valid), r as any, []);
  expect(p.request).toBeNull();
  expect(resolveWave(p).assignments).toHaveLength(2);
  r.probes.ordinary.status = "unknown";
  const rejected = prepareWave(
    valid,
    c as any,
    classified(valid),
    r as any,
    [],
  );
  expect(resolveWave(rejected).status).toBe("owner_required");
});
