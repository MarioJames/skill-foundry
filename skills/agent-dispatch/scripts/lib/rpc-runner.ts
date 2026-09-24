import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, openSync, closeSync, writeSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { Attempt } from "./scheduling";

export type RpcResult = {
  attempt_id: string; task_id: string; task_revision: number;
  backend: "rpc"; outcome: "completed" | "failed" | "needs_owner" | "cancelled" | "unknown";
  requested_profile: Attempt["binding"]["profile"]; observed_profile?: unknown;
  runner_pid: number; server_pid?: number; thread_id?: string; turn_id?: string;
  phase: string; summary: string; artifact_refs: string[];
  cleanup: "pending" | "stopped" | "unknown"; error_code?: string;
  started_at: string; ended_at?: string;
};
export type RpcOptions = {
  sandbox: "read-only" | "workspace-write"; timeoutMs: number;
  rpcTimeoutMs?: number; cleanupMs?: number; signal?: AbortSignal;
  // Injected only by protocol tests. The public CLI always launches codex app-server.
  command?: string[];
};
export function atomicJson(path: string, value: unknown) {
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  renameSync(tmp, path);
}
const outputSchema = {
  type: "object", additionalProperties: false,
  required: ["status", "summary", "artifact_refs"],
  properties: {
    status: { type: "string", enum: ["completed", "failed", "needs_owner"] },
    summary: { type: "string" }, artifact_refs: { type: "array", items: { type: "string" } },
  },
};
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** One owned app-server, one thread, one turn. Never retries model work. */
export async function runRpc(a: Attempt, options: RpcOptions): Promise<RpcResult> {
  const path = `${a.result_path}.rpc.json`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const exclusive = openSync(`${path}.started`, "wx", 0o600);
  closeSync(exclusive); // Permanent attempt marker: a second invocation cannot replay it.
  const result: RpcResult = {
    attempt_id: a.id, task_id: a.task.id, task_revision: a.task.revision,
    backend: "rpc", outcome: "unknown", requested_profile: a.binding.profile,
    runner_pid: process.pid, phase: "starting", summary: "Execution not yet confirmed",
    artifact_refs: [], cleanup: "pending", started_at: new Date().toISOString(),
  };
  const save = () => atomicJson(path, result);
  save();
  let child: ChildProcess | undefined;
  let lines: ReturnType<typeof createInterface> | undefined;
  let exited = false, stopping = false, submitted = false, nextId = 0;
  let stderrBytes = 0;
  const stderr = openSync(`${path}.stderr`, "wx", 0o600);
  const pending = new Map<number, { resolve: (r: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const notices: any[] = [];
  const messages = new Map<string, any>();
  let wake: (() => void) | undefined;
  let fatal: Error | undefined;
  const fail = (code: string) => {
    fatal ??= new Error(code);
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(fatal); }
    pending.clear(); wake?.();
  };
  const send = (value: unknown) => {
    if (!child?.stdin?.writable) throw new Error("rpc_closed");
    child.stdin.write(JSON.stringify(value) + "\n");
  };
  const request = (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
    if (fatal) { reject(fatal); return; }
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`rpc_timeout:${method}`)); }, options.rpcTimeoutMs ?? 60_000);
    pending.set(id, { resolve, reject, timer });
    try { send({ id, method, params }); }
    catch (e) { pending.delete(id); clearTimeout(timer); reject(e); }
  });
  const abort = () => fail("cancelled");
  options.signal?.addEventListener("abort", abort, { once: true });
  const budget = setTimeout(() => fail("task_timeout"), options.timeoutMs);
  try {
    if (options.signal?.aborted) throw new Error("cancelled");
    const argv = options.command ?? ["codex", "app-server"];
    child = spawn(argv[0], argv.slice(1), {
      cwd: a.binding.task.execution.cwd, detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    result.server_pid = child.pid; save();
    child.on("error", () => fail("server_spawn_failed"));
    child.on("exit", () => { exited = true; if (!stopping) fail("server_exited"); });
    child.stdin!.on("error", () => { if (!stopping) fail("rpc_write_failed"); });
    child.stderr!.on("data", (chunk: Buffer) => {
      const remaining = 64_000 - stderrBytes;
      if (remaining > 0) { const b = chunk.subarray(0, remaining); writeSync(stderr, b); stderrBytes += b.length; }
    });
    // readLine handles split and coalesced JSONL frames. Bound an unfinished frame too.
    let frameBytes = 0;
    child.stdout!.on("data", (chunk: Buffer) => {
      for (const part of chunk.toString().split(/(?<=\n)/u)) {
        frameBytes += Buffer.byteLength(part);
        if (frameBytes > 4_000_000) fail("rpc_frame_too_large");
        if (part.endsWith("\n")) frameBytes = 0;
      }
    });
    lines = createInterface({ input: child.stdout! });
    lines.on("close", () => { if (!stopping) fail("rpc_eof"); });
    lines.on("line", (line) => {
      if (fatal || stopping) return;
      try {
        const msg = JSON.parse(line);
        if (typeof msg.method === "string" && Object.hasOwn(msg, "id")) {
          // No automatic consent or fabricated answers in unattended execution.
          if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(msg.method))
            send({ id: msg.id, result: { decision: "cancel" } });
          else send({ id: msg.id, error: { code: -32601, message: "Unattended worker requires parent input" } });
          fail("needs_owner");
        } else if (Object.hasOwn(msg, "id")) {
          const p = pending.get(msg.id);
          if (!p) return;
          pending.delete(msg.id); clearTimeout(p.timer);
          if (msg.error) p.reject(new Error("rpc_response_error"));
          else p.resolve(msg.result);
        } else if (typeof msg.method === "string") {
          if (["turn/completed", "item/completed"].includes(msg.method)) {
            if (notices.length >= 10_000) throw new Error("rpc_event_limit");
            notices.push(msg); wake?.();
          }
        }
      } catch (e) { fail(e instanceof SyntaxError ? "rpc_invalid_json" : (e as Error).message); }
    });
    await request("initialize", { clientInfo: { name: "agent_dispatch", version: "1" }, capabilities: { experimentalApi: false } });
    send({ method: "initialized", params: {} });
    const profile = a.binding.profile;
    const started = await request("thread/start", {
      model: profile.model, cwd: a.binding.task.execution.cwd,
      approvalPolicy: "never", sandbox: options.sandbox, ephemeral: true,
      ...(profile.reasoning.mode === "effort" ? { config: { model_reasoning_effort: profile.reasoning.value } } : {}),
      developerInstructions: "You are a delegated oneshot worker. Complete only the supplied contract. The parent owns integration, Git commits, shared configuration, task scheduling and tab naming. Do not spawn agents, name tabs, start persistent services, or change models. Preserve data. Do not modify scheduling state or runner records. Report needs_owner for missing authorization, required interaction, or a scope change. End after delivering your bounded result.",
    });
    result.thread_id = started?.thread?.id;
    result.observed_profile = { model: started?.model, reasoning: started?.reasoningEffort, sandbox: started?.sandbox, approval: started?.approvalPolicy };
    save();
    if (!result.thread_id || started.model !== profile.model ||
        started.approvalPolicy !== "never" || started.sandbox?.type !== (options.sandbox === "read-only" ? "readOnly" : "workspaceWrite") ||
        (profile.reasoning.mode === "effort" && started.reasoningEffort !== profile.reasoning.value))
      throw new Error("execution_profile_mismatch");
    result.phase = "turn_start_intent"; save();
    submitted = true;
    const turn = await request("turn/start", {
      threadId: result.thread_id,
      ...(profile.reasoning.mode === "effort" ? { effort: profile.reasoning.value } : {}),
      input: [{ type: "text", text: `Overall goal: ${a.binding.goal}\nConstraints: ${JSON.stringify(a.binding.constraints)}\nTask: ${JSON.stringify(a.binding.task)}\nAccepted inputs: ${JSON.stringify(a.binding.dependencies)}\nReturn only the requested result object; completion is not parent acceptance.`, text_elements: [] }],
      outputSchema,
    });
    result.turn_id = turn?.turn?.id;
    if (!result.turn_id) throw new Error("missing_turn_id");
    result.phase = "running"; save();
    while (true) {
      // Drain already-arrived notifications before checking EOF; completion may precede response/exit.
      let terminal: any;
      for (const msg of notices.splice(0)) {
        const p = msg.params;
        if (p?.threadId !== result.thread_id) continue;
        if (msg.method === "item/completed" && p.turnId === result.turn_id && p.item?.type === "agentMessage") messages.set(p.item.id, p.item);
        if (msg.method === "turn/completed" && p.turn?.id === result.turn_id) terminal = p.turn;
      }
      if (terminal) {
        for (const item of terminal.items ?? []) if (item.type === "agentMessage") messages.set(item.id, item);
        if (terminal.status === "completed") {
          const item = [...messages.values()].reverse().find((x) => x.phase === "final_answer") ?? [...messages.values()].at(-1);
          if (item?.questions?.length) throw new Error("needs_owner");
          let body: any;
          try { body = JSON.parse(item?.text ?? ""); } catch { throw new Error("invalid_worker_result"); }
          if (!["completed", "failed", "needs_owner"].includes(body?.status) || typeof body.summary !== "string" || !body.summary.trim() || !Array.isArray(body.artifact_refs) || body.artifact_refs.some((v: any) => typeof v !== "string")) throw new Error("invalid_worker_result");
          result.outcome = body.status; result.summary = body.summary; result.artifact_refs = body.artifact_refs;
        } else if (terminal.status === "failed") { result.outcome = "failed"; result.summary = "Codex turn failed; inspect private diagnostics"; result.error_code = "turn_failed"; }
        else if (terminal.status === "interrupted") { result.outcome = "cancelled"; result.summary = "Codex turn interrupted"; }
        else throw new Error("invalid_terminal_status");
        break;
      }
      if (fatal) throw fatal;
      await new Promise<void>((resolve) => { wake = resolve; });
      wake = undefined;
    }
  } catch (e) {
    const code = e instanceof Error ? e.message : "runner_error";
    result.error_code = code;
    result.outcome = code === "needs_owner" ? "needs_owner" : code === "cancelled" ? "cancelled" : submitted ? "unknown" : "failed";
    result.summary = `Execution requires parent inspection (${code}); no automatic replay`;
  } finally {
    clearTimeout(budget); options.signal?.removeEventListener("abort", abort);
    stopping = true;
    // Interrupt the exact known turn, then close input. Never create another turn to recover.
    if (child && !exited && result.thread_id && result.turn_id && !["completed", "failed"].includes(result.outcome)) {
      try { send({ id: ++nextId, method: "turn/interrupt", params: { threadId: result.thread_id, turnId: result.turn_id } }); } catch {}
    }
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error("runner_stopped")); }
    pending.clear();
    const grace = options.cleanupMs ?? 3000;
    child?.stdin?.end();
    if (child?.pid) {
      const groupAlive = () => { try { process.kill(process.platform === "win32" ? child!.pid! : -child!.pid!, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== "ESRCH"; } };
      const signalGroup = (signal: NodeJS.Signals) => { try { process.kill(process.platform === "win32" ? child!.pid! : -child!.pid!, signal); } catch {} };
      const until = async (ms: number) => { const end = Date.now() + ms; while (groupAlive() && Date.now() < end) await delay(25); };
      await until(grace);
      if (groupAlive()) { signalGroup("SIGTERM"); await until(grace); }
      if (groupAlive()) { signalGroup("SIGKILL"); await until(grace); }
      result.cleanup = groupAlive() ? "unknown" : "stopped";
    } else result.cleanup = "stopped";
    lines?.close(); child?.stdout?.destroy(); child?.stderr?.destroy(); closeSync(stderr);
    result.phase = "terminal"; result.ended_at = new Date().toISOString(); save();
  }
  return result;
}
