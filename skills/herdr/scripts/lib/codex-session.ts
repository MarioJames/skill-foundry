import WebSocket from "ws";
import { execFileSync } from "node:child_process";
import { CliError } from "./herdr-route";

export function codexThreadId(env: Record<string, string | undefined>): string {
  // THREAD identifies the current thread; SESSION may identify its parent tree.
  const id = env.CODEX_THREAD_ID?.trim();
  if (!id || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) {
    throw new CliError("missing_thread", "A runtime-provided CODEX_THREAD_ID is required; do not infer it from Herdr, cwd, or a session list");
  }
  return id;
}

export function taskLabel(createdAt: number, type: string, topic: string): string {
  if (!Number.isFinite(createdAt) || createdAt <= 0) throw new CliError("missing_created_at", "Thread createdAt is unavailable");
  if (!/^(FEA|DES|FIX|OPT|REL|EXP|DOC|RES)$/.test(type) || !topic.trim() || /[\r\n｜]/.test(topic)) {
    throw new CliError("invalid_label", "Use a supported TYPE and a nonempty single-line topic without ｜");
  }
  const date = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit" }).formatToParts(new Date(createdAt * 1000));
  return `${date.find(p => p.type === "month")!.value}${date.find(p => p.type === "day")!.value}｜${type}｜${topic.trim()}`;
}

/** The daemon control socket uses WebSocket, not the stdio JSONL transport. */
export async function withCodexDaemon<T>(work: (request: (method: string, params: unknown) => Promise<any>) => Promise<T>): Promise<T> {
  const status = JSON.parse(execFileSync("codex", ["app-server", "daemon", "version"], { encoding: "utf8", timeout: 5000 }));
  if (status.status !== "running" || typeof status.socketPath !== "string" || !status.socketPath.startsWith("/") || status.socketPath.includes(":")) {
    throw new CliError("codex_daemon_unavailable", "No supported running local Codex daemon; preserve native title and use verified terminal naming if available");
  }
  // Bun supplies ws compatibility; no dependency installation or daemon restart.
  const socket = new WebSocket(`ws+unix://${status.socketPath}:/`);
  let sequence = 0;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  const fail = (error: Error) => { for (const item of pending.values()) item.reject(error); pending.clear(); };
  socket.on("error", () => fail(new CliError("codex_connection_failed", "Codex daemon connection failed")));
  socket.on("close", () => fail(new CliError("codex_connection_closed", "Codex daemon connection closed")));
  socket.on("message", raw => {
    try {
      const message = JSON.parse(String(raw));
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id);
      if (message.error) item.reject(new CliError("codex_rpc_error", String(message.error.message ?? "RPC rejected")));
      else item.resolve(message.result);
    } catch { fail(new CliError("codex_invalid_response", "Invalid daemon response")); }
  });
  const request = async (method: string, params: unknown): Promise<any> => {
    const id = ++sequence;
    let timer: ReturnType<typeof setTimeout>;
    try {
      return await new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        timer = setTimeout(() => { pending.delete(id); reject(new CliError("codex_rpc_timeout", `${method} timed out; inspect the thread before retrying a write`)); }, 5000);
        socket.send(JSON.stringify({ id, method, params }));
      });
    } finally { clearTimeout(timer!); pending.delete(id); }
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new CliError("codex_connection_timeout", "Codex daemon connection timed out")), 5000);
      socket.once("open", () => { clearTimeout(timer); resolve(); });
      socket.once("error", () => { clearTimeout(timer); reject(new CliError("codex_connection_failed", "Codex daemon connection failed")); });
    });
    await request("initialize", { clientInfo: { name: "herdr-session-naming", version: "1.0.0" }, capabilities: null });
    socket.send(JSON.stringify({ method: "initialized" }));
    return await work(request);
  } finally { socket.terminate(); }
}

export async function nameCodexSession(request: (method: string, params: unknown) => Promise<any>, threadId: string, type: string, topic: string, dryRun: boolean) {
  const read = async () => {
    const thread = (await request("thread/read", { threadId, includeTurns: false }))?.thread;
    if (thread?.id !== threadId) throw new CliError("thread_mismatch", "Daemon returned a different thread; no title write is allowed");
    return thread;
  };
  const thread = await read();
  const label = taskLabel(thread.createdAt, type, topic);
  if (!dryRun && thread.name !== label) {
    await request("thread/name/set", { threadId, name: label });
    if ((await read()).name !== label) throw new CliError("verification_failed", "Native thread title read-back did not match");
  }
  return { target: "codex-thread", threadId, label, dryRun, changed: !dryRun && thread.name !== label };
}
