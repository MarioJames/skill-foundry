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

/** The daemon control socket uses WebSocket, not the stdio JSONL transport. */
export async function withCodexDaemon<T>(work: (request: (method: string, params: unknown) => Promise<any>) => Promise<T>): Promise<T> {
  let status: any = null;
  try {
    status = JSON.parse(execFileSync("codex", ["app-server", "daemon", "version"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    // No codex binary or no daemon: reported below as unavailable.
  }
  if (status?.status !== "running" || typeof status.socketPath !== "string" || !status.socketPath.startsWith("/") || status.socketPath.includes(":")) {
    throw new CliError("codex_daemon_unavailable", "No supported running local Codex daemon; bind the tab through process ownership instead");
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
    await request("initialize", { clientInfo: { name: "herdr-tab-binding", version: "1.0.0" }, capabilities: null });
    socket.send(JSON.stringify({ method: "initialized" }));
    return await work(request);
  } finally { socket.terminate(); }
}
