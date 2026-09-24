import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRpc } from "../scripts/lib/rpc-runner";
import { observeAttempt } from "../scripts/lib/agent-runtime";

function attempt(dir: string): any {
  return { id: "attempt", task: { id: "task", revision: 1 }, backend: "rpc", slot: "held", writes_held: true, phase: "starting", effects: [], lane: null,
    result_path: join(dir, "result.json"), binding: { goal: "test", constraints: [], dependencies: [], profile: { engine_id: "codex", model: "requested", reasoning: { mode: "effort", value: "high" } }, task: { execution: { cwd: dir } } } };
}
async function fixture(scenario: string, check: (a: any, r: any, dir: string) => Promise<void> | void, signal?: AbortSignal) {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-rpc-")), a = attempt(dir);
  try {
    const r = await runRpc(a, { sandbox: "read-only", timeoutMs: scenario === "timeout" ? 150 : 2000, rpcTimeoutMs: 1000, cleanupMs: 100, signal, command: [process.execPath, join(import.meta.dir, "fixtures/rpc-server.ts"), scenario] });
    await check(a, r, dir);
    expect(r.cleanup).toBe("stopped");
    expect(() => process.kill(r.server_pid, 0)).toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
test("early split terminal event is bound to the actual turn; cleanup needs no parent observation", () => fixture("success", async (a, r, dir) => {
  expect(r.outcome).toBe("completed"); expect(r.thread_id).toBe("thread"); expect(r.turn_id).toBe("turn");
  expect(statSync(`${a.result_path}.rpc.json.stderr`).size).toBe(64_000);
  expect(JSON.parse(readFileSync(`${a.result_path}.rpc.json`, "utf8")).cleanup).toBe("stopped");
  await observeAttempt(a, async () => { throw Error("RPC must not call Herdr"); });
  expect(a.slot).toBe("released"); expect(a.writes_held).toBe(true); expect(a.phase).toBe("finished");
  expect(readFileSync(join(dir, "requests.jsonl"), "utf8").match(/"method":"turn\/start"/g)).toHaveLength(1);
  await expect(runRpc(a, { sandbox: "read-only", timeoutMs: 1000 })).rejects.toThrow();
}));
test("failed turn remains failed", () => fixture("failed", (a, r) => { expect(r.outcome).toBe("failed"); }));
test("approval is cancelled and returned to owner without unattended consent", () => fixture("approval", (a, r, dir) => {
  expect(r.outcome).toBe("needs_owner");
  expect(readFileSync(join(dir, "requests.jsonl"), "utf8")).toContain('"decision":"cancel"');
}));
test("lost start reply is unknown and never replayed", () => fixture("eof", (a, r, dir) => {
  expect(r.outcome).toBe("unknown");
  expect(readFileSync(join(dir, "requests.jsonl"), "utf8").match(/"method":"turn\/start"/g)).toHaveLength(1);
}));
test("a different model is refused before submission", () => fixture("wrong-profile", (a, r, dir) => {
  expect(r.outcome).toBe("failed"); expect(r.error_code).toBe("execution_profile_mismatch");
  expect(readFileSync(join(dir, "requests.jsonl"), "utf8")).not.toContain('"method":"turn/start"');
}));
test("task budget stops owned resources without claiming completion", () => fixture("timeout", (a, r) => { expect(r.outcome).toBe("unknown"); expect(r.error_code).toBe("task_timeout"); }));
test("explicit cancellation interrupts the exact turn then stops resources", async () => {
  const c = new AbortController(), timer = setTimeout(() => c.abort(), 120);
  try { await fixture("cancel", (a, r, dir) => {
    expect(r.outcome).toBe("cancelled");
    expect(readFileSync(join(dir, "requests.jsonl"), "utf8")).toContain('"method":"turn/interrupt"');
  }, c.signal); } finally { clearTimeout(timer); }
});
