import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { RuntimeError, type RuntimeRecord } from "../../runtime_types.ts";

export const UNIX_SOCKET_PATH_LIMIT = 100;
const MAX_MESSAGE_BYTES = 64 * 1024;

function ensurePrivateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new RuntimeError("ACP control path is not a private directory");
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new RuntimeError("ACP control directory is owned by another user");
  }
  chmodSync(directory, 0o700);
}

function byteLength(path: string): number { return Buffer.byteLength(path); }
function digest(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

export function endpointPath(runtimeRoot: string, rootId: string, launchId: number): string {
  const root = resolve(runtimeRoot);
  let directory = join(root, "control", rootId);
  let candidate = join(directory, `launch-${Math.trunc(launchId)}.sock`);
  if (byteLength(candidate) > UNIX_SOCKET_PATH_LIMIT) {
    directory = join(root, "control", ".s");
    candidate = join(directory, `${digest(`${rootId}|${Math.trunc(launchId)}`, 16)}.sock`);
  }
  if (byteLength(candidate) > UNIX_SOCKET_PATH_LIMIT) {
    const uid = typeof process.getuid === "function" ? process.getuid() : "unknown";
    directory = join("/tmp", `.agents-orchestrator-control-${uid}`);
    candidate = join(directory, `${digest(`${root}|${rootId}|${Math.trunc(launchId)}`, 24)}.sock`);
  }
  if (byteLength(candidate) > UNIX_SOCKET_PATH_LIMIT) {
    throw new RuntimeError("AGENTS_ORCHESTRATOR_HOME is too long for a secure Unix control socket path");
  }
  ensurePrivateDirectory(directory);
  return candidate;
}

export type ControlHandler = (request: RuntimeRecord) => RuntimeRecord | Promise<RuntimeRecord>;

function safeUnlink(path: string): void {
  try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

export class ControlServer {
  private server: Server | null = null;
  private sockets = new Set<Socket>();

  constructor(readonly endpoint: string, readonly handler: ControlHandler) {}

  async start(): Promise<void> {
    if (this.server) return;
    safeUnlink(this.endpoint);
    const server = createServer((socket) => {
      this.sockets.add(socket);
      let input = Buffer.alloc(0);
      let handled = false;
      socket.on("data", (chunk: Buffer) => {
        if (handled) return;
        input = Buffer.concat([input, chunk]);
        if (input.byteLength > MAX_MESSAGE_BYTES) { handled = true; socket.end('{"error":"control request too large","ok":false}\n'); return; }
        const newline = input.indexOf(0x0a);
        if (newline < 0) return;
        handled = true;
        void (async () => {
          let response: RuntimeRecord;
          try {
            const decoded: unknown = JSON.parse(input.subarray(0, newline).toString("utf8"));
            if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) throw new RuntimeError("invalid control request");
            response = await this.handler(decoded as RuntimeRecord);
          } catch (error) {
            response = { ok: false, error: error instanceof RuntimeError ? error.message : "control handler failed" };
          }
          socket.end(`${JSON.stringify(response)}\n`);
        })();
      });
      socket.on("close", () => this.sockets.delete(socket));
      socket.on("error", () => this.sockets.delete(socket));
    });
    this.server = server;
    await new Promise<void>((resolveReady, reject) => {
      const onError = (error: Error): void => { server.off("listening", onListening); this.server = null; reject(error); };
      const onListening = (): void => { server.off("error", onError); chmodSync(this.endpoint, 0o600); resolveReady(); };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.endpoint);
    });
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (server) await new Promise<void>((resolveClosed) => server.close(() => resolveClosed()));
    safeUnlink(this.endpoint);
  }
}

export function controlRequest(
  endpoint: string,
  command: string,
  payload: RuntimeRecord = {},
  timeoutSeconds = 2,
): Promise<RuntimeRecord> {
  return new Promise((resolveResponse, reject) => {
    let input = Buffer.alloc(0);
    let settled = false;
    const finish = (error?: Error, value?: RuntimeRecord): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolveResponse(value!);
    };
    const socket = createConnection(endpoint);
    const timer = setTimeout(() => finish(new RuntimeError("ACP Worker control request timed out")), Math.max(1, timeoutSeconds * 1000));
    socket.once("connect", () => socket.write(`${JSON.stringify({ ...payload, command })}\n`));
    socket.on("data", (chunk: Buffer) => {
      input = Buffer.concat([input, chunk]);
      if (input.byteLength > MAX_MESSAGE_BYTES) return finish(new RuntimeError("ACP Worker control response is too large"));
      const newline = input.indexOf(0x0a);
      if (newline < 0) return;
      try {
        const decoded: unknown = JSON.parse(input.subarray(0, newline).toString("utf8"));
        if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error();
        finish(undefined, decoded as RuntimeRecord);
      } catch { finish(new RuntimeError("ACP Worker returned an invalid control response")); }
    });
    socket.once("error", () => finish(new RuntimeError("ACP Worker control endpoint is unavailable")));
    socket.once("end", () => { if (!settled) finish(new RuntimeError("ACP Worker control endpoint closed without a response")); });
  });
}

export function controlRequestSync(
  endpoint: string,
  command: string,
  payload: RuntimeRecord = {},
  timeoutSeconds = 2,
): RuntimeRecord {
  const helper = fileURLToPath(new URL("./control_client.ts", import.meta.url));
  const result = Bun.spawnSync({
    cmd: [process.execPath, helper, endpoint, String(timeoutSeconds)],
    stdin: Buffer.from(JSON.stringify({ ...payload, command })),
    stdout: "pipe",
    stderr: "ignore",
    timeout: Math.ceil(Math.max(0.1, timeoutSeconds + 0.5) * 1000),
  });
  if (result.exitCode !== 0) throw new RuntimeError("ACP Worker control request failed");
  try {
    const decoded: unknown = JSON.parse(result.stdout.toString());
    if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error();
    return decoded as RuntimeRecord;
  } catch { throw new RuntimeError("ACP Worker returned an invalid control response"); }
}

export function endpointDirectory(endpoint: string): string { return dirname(endpoint); }
