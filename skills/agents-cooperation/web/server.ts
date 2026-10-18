import { basename } from "node:path";
import { CliError } from "../scripts/agents-config.ts";
import { enginesOf, planAvailability, writeAvailability } from "./lib/availability.ts";
import { ConfigStore, checkConfig } from "./lib/config-store.ts";
import { HttpError } from "./lib/errors.ts";
import { readAgentBoard, readAgentTask } from "./lib/agent-board.ts";
import { readState } from "./lib/read-state.ts";

export const BODY_LIMIT = 256 * 1024;
export interface ServerOptions { config?: string; state?: string; port?: number; env?: Record<string, string | undefined>; entrypoint?: string }

async function bodyJSON(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw new HttpError(415, "请求必须使用 application/json。");
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "请求需要 JSON 正文。");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > BODY_LIMIT) { await reader.cancel(); throw new HttpError(413, "请求正文超过 256 KiB 上限。"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new HttpError(400, "请求正文必须是有效 JSON 对象。"); }
}

/** Bun's native HTML build stays in memory; every generated asset uses the same guard. */
export async function startServer(options: ServerOptions = {}) {
  const env = { ...(options.env ?? process.env) };
  const store = new ConfigStore(options.config, env);
  await store.read(); // Do not advertise a usable service for unreadable/broken JSON.
  const build = await Bun.build({
    entrypoints: [options.entrypoint ?? `${import.meta.dir}/index.html`],
    target: "browser", minify: true, splitting: true, publicPath: "/",
    naming: { entry: "[name].[ext]", chunk: "[name]-[hash].[ext]", asset: "[name]-[hash].[ext]" },
    define: { "process.env.NODE_ENV": '"production"' },
  });
  if (!build.success) throw new Error("页面构建失败，请检查本地 Web 依赖和入口文件。");
  const assets = new Map(build.outputs.map(output => [`/${basename(output.path)}`, output]));
  const html = build.outputs.find(output => output.path.endsWith(".html"));
  if (!html) throw new Error("页面构建没有生成 HTML。");
  assets.set("/", html);
  const json = (value: unknown, status = 200, headers?: HeadersInit) => Response.json(value, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers } });
  const server = Bun.serve({
    hostname: "127.0.0.1", port: options.port ?? 3000, development: false, reusePort: false,
    // Enforce the small limit while actually reading the stream, inside the Host
    // guard, rather than having Bun reject a Content-Length before that guard.
    maxRequestBodySize: Number.MAX_SAFE_INTEGER,
    async fetch(request, currentServer) {
      const host = request.headers.get("host");
      if (host !== `127.0.0.1:${currentServer.port}` && host !== `localhost:${currentServer.port}`) return json({ ok: false, error: "拒绝非本地或端口不匹配的 Host。" }, 403);
      try {
        const path = new URL(request.url).pathname;
        if (request.method === "POST" || request.method === "PUT" || request.method === "PATCH" || request.method === "DELETE") {
          if (request.headers.get("origin") !== `http://${host}`) throw new HttpError(403, "请求 Origin 与当前本地地址不一致。");
        }
        if (path === "/api/config" && request.method === "GET") {
          const snapshot = await store.read();
          return json(snapshot, 200, { ETag: snapshot.revision });
        }
        if (path === "/api/config" && request.method === "PUT") {
          const body = await bodyJSON(request);
          const snapshot = await store.save(body.config, request.headers.get("if-match"));
          return json(snapshot, 200, { ETag: snapshot.revision });
        }
        if (path === "/api/validate" && request.method === "POST") {
          const body = await bodyJSON(request);
          const issues = checkConfig(body.config);
          if (issues.length) return json({ ok: false, error: "配置校验未通过。", issues }, 422);
          return json({ ok: true, issues: [] });
        }
        if (path === "/api/availability" && request.method === "GET") {
          const state = readState(options.state, env);
          if (state.status === "uncertain") return json({ ok: false, certain: false, error: state.warnings[0] ?? "无法只读确认额度状态。", state }, 503);
          return json({ ok: true, ...state });
        }
        if (path === "/api/availability" && request.method === "PUT") {
          const body = await bodyJSON(request);
          const now = Date.now();
          const snapshot = await store.read();
          const planned = planAvailability(body, enginesOf(snapshot.config), now);
          if (planned.issues.length) throw new HttpError(422, "额度恢复时间校验未通过。", planned.issues);
          const current = readState(options.state, env);
          if (current.status === "uncertain") return json({ ok: false, certain: false, error: current.warnings[0] ?? "无法只读确认额度状态。", state: current }, 503);
          if (planned.updates.length) writeAvailability(options.state, env, planned.updates, now);
          const after = planned.updates.length ? readState(options.state, env) : current;
          if (after.status === "uncertain") return json({ ok: false, certain: false, error: "额度已写入，但无法只读确认写入后的状态。", state: after }, 500);
          return json({ ok: true, ...after });
        }
        if (path === "/api/agents" && request.method === "GET") return json(readAgentBoard(options.state, env));
        if (request.method === "GET" && path.startsWith("/api/agents/")) {
          const encoded = path.slice("/api/agents/".length);
          if (encoded && !encoded.includes("/")) {
            let taskId: string;
            try { taskId = decodeURIComponent(encoded); }
            catch { throw new HttpError(400, "任务标识编码无效。"); }
            return json(readAgentTask(taskId, options.state, env));
          }
        }
        if (request.method === "GET" || request.method === "HEAD") {
          const asset = assets.get(path);
          if (asset) return new Response(request.method === "HEAD" ? null : asset, { headers: { "Content-Type": asset.type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...(asset.path.endsWith(".html") ? { "Content-Security-Policy": "frame-ancestors 'none'" } : {}) } });
        }
        return json({ ok: false, error: "未找到该本地资源。" }, 404);
      } catch (error) {
        if (error instanceof HttpError) return json({ ok: false, error: error.message, ...(error.issues ? { issues: error.issues } : {}) }, error.status);
        if (error instanceof CliError) return json({ ok: false, certain: true, error: error.message, issues: error.issues }, 422);
        return json({ ok: false, error: "本地服务操作失败，请检查配置和文件权限后重试。" }, 500);
      }
    },
    error() { return json({ ok: false, error: "请求处理失败。" }, 500); },
  });
  return server;
}
