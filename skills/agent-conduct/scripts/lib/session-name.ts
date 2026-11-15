// Session naming: one label format and the hosts whose conversation title an agent can set.

import WebSocket from "ws";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export class NamingError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export const SESSION_TYPES = ["FEA", "DES", "FIX", "OPT", "REL", "EXP", "DOC", "RES"] as const;

/** `MMDD｜TYPE｜Topic`, dated by the session's creation in Asia/Shanghai, never by update time or today. */
export function sessionLabel(createdAtMs: number, type: string, topic: string): string {
  if (!Number.isFinite(createdAtMs) || createdAtMs <= 0) {
    throw new NamingError("missing_created_at", "Session createdAt is unavailable; keep the current title and report the gap");
  }
  if (!(SESSION_TYPES as readonly string[]).includes(type) || !topic.trim() || /[\r\n｜]/u.test(topic)) {
    throw new NamingError("invalid_label", `Use one of ${SESSION_TYPES.join("/")} and a nonempty single-line topic without ｜`);
  }
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(createdAtMs));
  const part = (name: string) => parts.find((item) => item.type === name)!.value;
  return `${part("month")}${part("day")}｜${type}｜${topic.trim()}`;
}

export interface TargetResult {
  target: "lobehub-topic" | "codex-thread" | "claude-code" | "herdr-tab";
  status: "named" | "unchanged" | "dry-run" | "skipped" | "failed";
  [key: string]: unknown;
}

/** Runs `lh` with the inherited run environment; resolves stdout, rejects on a nonzero exit. */
export type Lh = (...args: string[]) => Promise<string>;

/** Agent runtimes set these for their own tool processes; an outer runtime's value may be inherited. */
const SESSION_KEYS = ["CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID"] as const;

/** Exec-time environments of this process and its ancestors, innermost first; `null` entries are unreadable. */
export type ProcessChain = (Map<string, string> | null)[];

/** Linux `/proc` view of this process's ancestry; `null` where `/proc` is unavailable. */
export function processChain(): ProcessChain | null {
  if (!existsSync("/proc/self/environ")) return null;
  const chain: ProcessChain = [];
  let pid = process.pid;
  while (pid > 1 && chain.length < 64) {
    let env: Map<string, string> | null = null;
    try {
      env = new Map(readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter(Boolean).map((entry) => {
        const at = entry.indexOf("=");
        return [entry.slice(0, at), entry.slice(at + 1)] as [string, string];
      }));
    } catch {
      // Unreadable (another user's process): the chain cannot vouch past this point.
    }
    chain.push(env);
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      pid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    } catch {
      break;
    }
  }
  return chain;
}

/** Index of the outermost process carrying key=value without a gap from this one; null if unreadable first. */
function carriedUpTo(chain: ProcessChain, key: string, value: string): number | null {
  let depth = -1;
  for (const env of chain) {
    if (env === null) return null;
    if (env.get(key) !== value) break;
    depth += 1;
  }
  return depth;
}

/**
 * Why this run's LobeHub identity is not its own, or null when nothing contradicts it.
 *
 * The innermost agent is the runtime whose session variable is set nearest to this process;
 * the process just above that holder is the agent itself. LobeHub hands the operation to the
 * agent it starts, so the operation may reach at most the agent's parent (the launcher). An
 * operation carried further up came through a long-lived host started inside some other run
 * (a terminal server, a multiplexer), and the topic belongs to that run. When the topic has
 * recorded its agent session, it must also be the innermost agent's.
 */
export function inheritedRunIdentity(
  env: Record<string, string | undefined>,
  chain: ProcessChain | null,
  heteroSessionId: unknown,
): string | null {
  const sessions = SESSION_KEYS.flatMap((key) => {
    const value = env[key]?.trim();
    if (!value) return [];
    return [{ value, depth: chain ? carriedUpTo(chain, key, value) : null }];
  });
  const innermost = chain
    ? sessions.filter((item) => item.depth !== null && item.depth >= 0).sort((a, b) => a.depth! - b.depth!)[0]
    : sessions.length === 1 ? sessions[0] : undefined;
  if (typeof heteroSessionId === "string" && heteroSessionId && innermost && innermost.value !== heteroSessionId) {
    return "session_mismatch";
  }
  if (!chain) return null;
  const operation = carriedUpTo(chain, "LOBEHUB_OPERATION_ID", env.LOBEHUB_OPERATION_ID!.trim());
  if (operation === null || operation < 0) return "operation_unverified";
  if (innermost && operation > innermost.depth! + 2) return "inherited_operation";
  return null;
}

/**
 * A LobeHub run may name its topic only while the topic's running operation is this run, and the
 * process chain does not show that identity inherited from another run (see inheritedRunIdentity).
 * Anything else (an ancestor's environment, a group member sharing the topic, a finished run)
 * is skipped, never written.
 */
export async function nameLobehubTopic(
  lh: Lh,
  env: Record<string, string | undefined>,
  type: string,
  topic: string,
  dryRun: boolean,
  chain: ProcessChain | null = processChain(),
): Promise<TargetResult | null> {
  const topicId = env.LOBEHUB_TOPIC_ID?.trim();
  const operationId = env.LOBEHUB_OPERATION_ID?.trim();
  if (!topicId || !operationId) return null;

  const read = async () => {
    let data: any;
    try {
      data = JSON.parse(await lh("topic", "view", topicId, "--no-messages", "--json"));
    } catch (error) {
      throw new NamingError("lobehub_read_failed", `Could not read topic ${topicId}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const value = data?.topic;
    if (value?.id !== topicId) throw new NamingError("topic_mismatch", "LobeHub returned a different topic; no title write is allowed");
    return value;
  };

  const current = await read();
  const runningOperation = current.metadata?.runningOperation?.operationId;
  const base = { target: "lobehub-topic" as const, topicId, trigger: current.trigger ?? null, taskId: current.metadata?.taskId ?? null };
  if (runningOperation !== operationId) {
    return {
      ...base,
      status: "skipped",
      reason: "not_running_operation",
      message: "This run is not the topic's running operation (inherited environment, group member or finished run); title left unchanged",
    };
  }
  const inherited = inheritedRunIdentity(env, chain, current.metadata?.heteroSessionId);
  if (inherited) {
    return {
      ...base,
      status: "skipped",
      reason: inherited,
      message: "The LobeHub run identity in this environment belongs to another agent run (inherited through a long-lived host); title left unchanged",
    };
  }
  const label = sessionLabel(Date.parse(current.createdAt), type, topic);
  if (current.title === label) return { ...base, status: "unchanged", label };
  if (dryRun) return { ...base, status: "dry-run", label, title: current.title };

  await lh("topic", "edit", topicId, "--title", label);
  const after = await read();
  if (after.title !== label) {
    throw new NamingError("verification_failed", `Topic title read-back was ${JSON.stringify(after.title)}; inspect before writing again`);
  }
  return { ...base, status: "named", label, previous: current.title };
}

/**
 * Claude Code exposes no title API, but its transcript dates the session: the earliest
 * timestamp among the first records of `<config>/projects/<project>/<CLAUDE_CODE_SESSION_ID>.jsonl`.
 */
export function claudeSessionCreatedAt(env: Record<string, string | undefined>, home: string): number | null {
  const id = env.CLAUDE_CODE_SESSION_ID?.trim();
  if (!id || !/^[0-9a-f-]{36}$/iu.test(id)) return null;
  const projects = join(env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude"), "projects");
  let dirs: string[];
  try {
    dirs = readdirSync(projects);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const file = join(projects, dir, `${id}.jsonl`);
    if (!existsSync(file)) continue;
    const head = readFileSync(file, "utf8").slice(0, 65_536).split("\n").slice(0, 50);
    const times = head.flatMap((line) => {
      try {
        const value = Date.parse(JSON.parse(line)?.timestamp);
        return Number.isFinite(value) ? [value] : [];
      } catch {
        return [];
      }
    });
    return times.length > 0 ? Math.min(...times) : null;
  }
  return null;
}

export function codexThreadId(env: Record<string, string | undefined>): string | null {
  // THREAD identifies the current thread; SESSION may identify its parent tree.
  const id = env.CODEX_THREAD_ID?.trim();
  if (!id) return null;
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(id)) {
    throw new NamingError("invalid_thread", "CODEX_THREAD_ID is not a thread id; do not infer it from Herdr, cwd or a session list");
  }
  return id;
}

export type CodexRequest = (method: string, params: unknown) => Promise<any>;

/** The local daemon control socket speaks WebSocket. Never start or restart the daemon to name a thread. */
export async function withCodexDaemon<T>(work: (request: CodexRequest) => Promise<T>): Promise<T> {
  let status: any;
  try {
    status = JSON.parse(execFileSync("codex", ["app-server", "daemon", "version"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    status = null;
  }
  if (status?.status !== "running" || typeof status.socketPath !== "string" || !status.socketPath.startsWith("/") || status.socketPath.includes(":")) {
    throw new NamingError("codex_daemon_unavailable", "No running local Codex daemon; the native title cannot be set from here");
  }
  const socket = new WebSocket(`ws+unix://${status.socketPath}:/`);
  let sequence = 0;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  const fail = (error: Error) => {
    for (const item of pending.values()) item.reject(error);
    pending.clear();
  };
  socket.on("error", () => fail(new NamingError("codex_connection_failed", "Codex daemon connection failed")));
  socket.on("close", () => fail(new NamingError("codex_connection_closed", "Codex daemon connection closed")));
  socket.on("message", (raw) => {
    try {
      const message = JSON.parse(String(raw));
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id);
      if (message.error) item.reject(new NamingError("codex_rpc_error", String(message.error.message ?? "RPC rejected")));
      else item.resolve(message.result);
    } catch {
      fail(new NamingError("codex_invalid_response", "Invalid daemon response"));
    }
  });
  const request: CodexRequest = async (method, params) => {
    const id = ++sequence;
    let timer: ReturnType<typeof setTimeout>;
    try {
      return await new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        timer = setTimeout(() => {
          pending.delete(id);
          reject(new NamingError("codex_rpc_timeout", `${method} timed out; inspect the thread before retrying a write`));
        }, 5000);
        socket.send(JSON.stringify({ id, method, params }));
      });
    } finally {
      clearTimeout(timer!);
      pending.delete(id);
    }
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new NamingError("codex_connection_timeout", "Codex daemon connection timed out")), 5000);
      socket.once("open", () => { clearTimeout(timer); resolve(); });
      socket.once("error", () => { clearTimeout(timer); reject(new NamingError("codex_connection_failed", "Codex daemon connection failed")); });
    });
    await request("initialize", { clientInfo: { name: "agent-conduct-session-naming", version: "1.0.0" }, capabilities: null });
    socket.send(JSON.stringify({ method: "initialized" }));
    return await work(request);
  } finally {
    socket.terminate();
  }
}

export async function nameCodexThread(request: CodexRequest, threadId: string, type: string, topic: string, dryRun: boolean): Promise<TargetResult> {
  const read = async () => {
    const thread = (await request("thread/read", { threadId, includeTurns: false }))?.thread;
    if (thread?.id !== threadId) throw new NamingError("thread_mismatch", "Daemon returned a different thread; no title write is allowed");
    return thread;
  };
  const thread = await read();
  const label = sessionLabel(Number(thread.createdAt) * 1000, type, topic);
  if (thread.name === label) return { target: "codex-thread", status: "unchanged", threadId, label };
  if (dryRun) return { target: "codex-thread", status: "dry-run", threadId, label, title: thread.name ?? null };
  await request("thread/name/set", { threadId, name: label });
  if ((await read()).name !== label) throw new NamingError("verification_failed", "Native thread title read-back did not match");
  return { target: "codex-thread", status: "named", threadId, label, previous: thread.name ?? null };
}
