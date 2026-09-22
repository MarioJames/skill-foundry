import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareDecision, resolveDecision, requestDecision } from "../scripts/lib/jev-decision";

const fixture = () => JSON.parse(readFileSync(new URL("../examples/jev-batch.json", import.meta.url), "utf8"));
const reply = (choice = "parallel_mixed_effort", confidence: unknown = 0.95) => ({
  model: "typesafe/jev-1.13", answers: { schedule: { type: "choice", choice, confidence } },
  usage: { input_tokens: 1000, output_tokens: 0, cost: 0.000042 },
});

test("one typed choice returns parallelism and task/effort assignments on one fixed model together", () => {
  const prepared = prepareDecision(fixture());
  expect(prepared.plans.map(p => p.id)).toEqual(["parallel_mixed_effort", "date_first"]);
  expect(prepared.rejected).toEqual([{ plan_id: "integrate_result", reason: "dependency_not_done:integrate" }]);
  expect(prepared.request.model).toBe("~typesafe/jev-latest");
  const result = resolveDecision(prepared, reply());
  expect(result.status).toBe("selected");
  expect(result.can_parallel).toBe(true);
  expect(result.usage).toEqual({ input_tokens: 1000, output_tokens: 0, cost: 0.000042 });
  expect(result.assignments.map(a => [a.task_id, a.model_id, a.reasoning_effort, a.agent])).toEqual([
    ["date", "gpt-6-astra", "low", "codex"], ["money", "gpt-6-astra", "medium", "codex"],
  ]);
});

test("write/write and read/write overlaps exclude unsafe plans including parent paths", () => {
  for (const key of ["reads", "writes"]) {
    const input = fixture();
    input.tasks[1][key] = ["repo/project/src"];
    const prepared = prepareDecision(input);
    expect(prepared.plans.map(p => p.id)).toEqual(["date_first"]);
  }
});

test("running tasks consume slots and reserve resources", () => {
  const input = fixture();
  input.tasks[1].status = "running";
  input.max_concurrency = 1;
  expect(prepareDecision(input).local_status).toBe("wait");
  input.max_concurrency = 2;
  input.tasks[1].writes = ["repo/project/src"];
  expect(prepareDecision(input).plans).toEqual([]);
});

test("integration becomes eligible only after accepted results; failures do not retry automatically", () => {
  const input = fixture();
  input.tasks[0].status = "done";
  input.tasks[1].status = "done";
  expect(prepareDecision(input).plans.map(p => p.id)).toEqual(["integrate_result"]);
  input.tasks[1].status = "failed";
  expect(prepareDecision(input).local_status).toBe("escalate");
});

test("only supported reasoning efforts are accepted", () => {
  for (const effort of ["none", "xhigh", "max", "", null]) {
    const input = fixture(); input.plans[0].assignments[0].reasoning_effort = effort;
    expect(() => prepareDecision(input)).toThrow("reasoning_effort");
  }
});

test("every selected unit inherits the one explicitly supplied executor", () => {
  const input = fixture(); input.executor.model_id = "gpt-5.6-sol";
  const result = resolveDecision(prepareDecision(input), reply());
  expect(result.assignments.map(a => [a.model_id, a.reasoning_effort])).toEqual([
    ["gpt-5.6-sol", "low"], ["gpt-5.6-sol", "medium"],
  ]);
});

test("invalid graph and ambiguous resource names fail before a network call", () => {
  for (const deps of [["unknown"], ["integrate"]]) {
    const input = fixture();
    input.tasks[0].depends_on = deps;
    expect(() => prepareDecision(input)).toThrow();
  }
  for (const resource of ["repo/project/../src", "repo//src", "repo/src/*"]) {
    const input = fixture(); input.tasks[0].writes = [resource];
    expect(() => prepareDecision(input)).toThrow();
  }
});

test("context overflow rejects instead of truncating task constraints", () => {
  const input = fixture(); input.constraints = ["不能丢失的约束".repeat(2000)];
  expect(() => prepareDecision(input)).toThrow("context_budget");
});

test("unknown or filtered choices and malformed confidence never produce assignments", () => {
  const prepared = prepareDecision(fixture());
  for (const response of [reply("invented"), reply("integrate_result"), reply("parallel_mixed_effort", null), reply("parallel_mixed_effort", 1.1), { answers: {} }]) {
    expect(() => resolveDecision(prepared, response)).toThrow();
  }
  const low = resolveDecision(prepared, reply("parallel_mixed_effort", 0.3));
  expect(low.status).toBe("escalate"); expect(low.assignments).toEqual([]);
  for (const choice of ["need_context", "escalate"]) {
    const result = resolveDecision(prepared, reply(choice));
    expect(result.status).toBe(choice); expect(result.assignments).toEqual([]);
  }
});

test("unknown ownership is blocked and malformed accounting cannot produce a proposal", () => {
  const input = fixture(); input.tasks[0].status = "blocked";
  expect(prepareDecision(input).plans).toEqual([]);
  const prepared = prepareDecision(fixture());
  for (const usage of [undefined, {}, { input_tokens: -1, output_tokens: 0 }, { input_tokens: 1, output_tokens: 0, cost: "bad" }]) {
    expect(() => resolveDecision(prepared, { ...reply(), usage })).toThrow("invalid");
  }
});

test("network boundary uses Decisions endpoint and bearer token without chat messages", async () => {
  let calls = 0;
  const result = await requestDecision(prepareDecision(fixture()), {
    apiKey: "test-private-key",
    fetch: (async (url, init) => {
      calls++;
      expect(url).toBe("https://openrouter.ai/api/alpha/decisions");
      expect(new Headers(init!.headers).get("authorization")).toBe("Bearer test-private-key");
      const body = JSON.parse(init!.body as string);
      expect(body.questions.schedule.type).toBe("choice");
      expect(body.questions.schedule.criteria.need_context).toBeString();
      expect(body.messages).toBeUndefined();
      return Response.json(reply());
    }) as typeof fetch,
  });
  expect(calls).toBe(1); expect(result.status).toBe("selected");
});

test("provider failures are bounded, redacted and never silently rerouted or retried", async () => {
  for (const status of [401, 429, 500]) {
    let calls = 0;
    try {
      await requestDecision(prepareDecision(fixture()), {
        apiKey: "private-key", fetch: (async () => {
          calls++; return new Response("private-key and private task text", { status });
        }) as typeof fetch,
      });
      throw new Error("expected failure");
    } catch (e) {
      expect(String(e)).toContain(String(status));
      expect(String(e)).not.toContain("private-key");
    }
    expect(calls).toBe(1);
  }
});

async function cli(input: unknown, args: string[], response?: (req: Request) => Response | Promise<Response>) {
  const dir = mkdtempSync(join(tmpdir(), "herdr-jev-test-"));
  let calls = 0;
  const server = response ? Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: async req => { calls++; return response(req); },
  }) : undefined;
  try {
    const file = join(dir, "batch.json");
    writeFileSync(file, JSON.stringify(input));
    const preload = join(dir, "http-boundary.ts");
    // The actual CLI, request serialization, auth, timeout and reply parsing run unchanged.
    // Only the destination of its exact OpenRouter endpoint is replaced by a local HTTP fixture.
    writeFileSync(preload, `
const original = globalThis.fetch;
globalThis.fetch = ((url, options) => {
  if (url !== "https://openrouter.ai/api/alpha/decisions") throw new Error("wrong endpoint");
  return original(${JSON.stringify(server?.url.toString() ?? "http://127.0.0.1:1")}, options);
});
`);
    const command = [process.execPath, "--no-env-file", "--preload", preload,
      new URL("../scripts/decide-tasks.ts", import.meta.url).pathname, "--input", file, ...args];
    const child = Bun.spawn(command, {
      env: { ...process.env, OPENROUTER_API_KEY: server ? "private-test-key" : "" },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([
      Bun.readableStreamToText(child.stdout), Bun.readableStreamToText(child.stderr), child.exited,
    ]);
    expect(stdout + stderr).not.toContain("private-test-key");
    return { output: JSON.parse(stdout), exit, calls, stderr };
  } finally { server?.stop(true); rmSync(dir, { recursive: true, force: true }); }
}

test("real CLI validates dry-run and missing credentials without network or dispatch", async () => {
  const dry = await cli(fixture(), ["--dry-run"]);
  expect(dry.exit).toBe(0); expect(dry.output.status).toBe("dry_run");
  expect(dry.output.request.questions.schedule.criteria.integrate_result).toBeUndefined();
  const missing = await cli(fixture(), []);
  expect(missing.exit).toBe(2); expect(missing.output.error.code).toBe("missing_api_key");
  expect(missing.output.assignments).toBeUndefined();
});

test("real CLI dispatch proposal progresses from parallel work to accepted integration", async () => {
  const input = fixture();
  const first = await cli(input, [], async req => {
    expect(req.method).toBe("POST");
    expect(req.headers.get("authorization")).toBe("Bearer private-test-key");
    const body = await req.json();
    expect(body.model).toBe("~typesafe/jev-latest");
    expect(body.questions.schedule.criteria.parallel_mixed_effort).toBeString();
    return Response.json(reply());
  });
  expect(first.exit).toBe(0); expect(first.calls).toBe(1);
  expect(first.output.assignments).toHaveLength(2);
  input.tasks[0].status = "running"; input.tasks[1].status = "running";
  const waiting = await cli(input, []);
  expect(waiting.output.status).toBe("wait"); expect(waiting.calls).toBe(0);
  input.tasks[0].status = "done"; input.tasks[1].status = "done";
  const second = await cli(input, [], () => Response.json(reply("integrate_result")));
  expect(second.output.status).toBe("selected"); expect(second.output.can_parallel).toBe(false);
  expect(second.output.assignments[0].model_id).toBe("gpt-6-astra");
  expect(second.output.assignments[0].reasoning_effort).toBe("high");
  expect(second.output.snapshot_id).not.toBe(first.output.snapshot_id);
  input.tasks[2].status = "done";
  const complete = await cli(input, []);
  expect(complete.output.status).toBe("complete"); expect(complete.output.assignments).toEqual([]);
});

test("real CLI rejects timeout, non-JSON and unoffered choices without exposing response bodies", async () => {
  const timeout = await cli(fixture(), ["--timeout-ms", "20"], async () => {
    await Bun.sleep(100); return Response.json(reply());
  });
  expect(timeout.exit).toBe(1); expect(timeout.output.error.code).toBe("request_timeout");
  for (const response of [() => new Response("private-test-key"), () => Response.json(reply("invented"))]) {
    const failed = await cli(fixture(), [], response);
    expect(failed.exit).toBe(1); expect(failed.output.error.code).toBe("invalid_response");
    expect(failed.calls).toBe(1); expect(failed.output.assignments).toBeUndefined();
  }
});
