import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { startServer } from "./server.ts";
import { HttpError } from "./lib/errors.ts";

export async function launch(args: string[], env: Record<string, string | undefined> = process.env) {
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let stop: (() => void) | undefined;
  try {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { config: { type: "string" }, state: { type: "string" }, port: { type: "string" }, "no-open": { type: "boolean" }, help: { type: "boolean", short: "h" } } });
    if (values.help) { process.stdout.write("Usage: bun agents-config.ts web [--config PATH] [--state PATH] [--port N] [--no-open]\n"); return 0; }
    if (positionals.length) throw new HttpError(400, "web 不接受额外位置参数。");
    const port = values.port === undefined ? 3000 : Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535 || (values.port !== undefined && !/^\d+$/.test(values.port))) throw new HttpError(400, "--port 必须是 0–65535 的整数。");
    const manifest = JSON.parse(readFileSync(`${import.meta.dir}/package.json`, "utf8"));
    const dependencies = Object.keys(manifest.dependencies ?? {});
    if (dependencies.some(dependency => { try { Bun.resolveSync(dependency, import.meta.dir); return false; } catch { return true; } })) {
      process.stderr.write(`Web 依赖尚未安装，请执行一次：bun install --cwd ${JSON.stringify(import.meta.dir)}\n`);
      return 1;
    }
    server = await startServer({ config: values.config, state: values.state, port, env });
    const url = `http://127.0.0.1:${server.port}/`;
    const stopped = new Promise<void>(resolve => { stop = () => { server?.stop(true); resolve(); }; });
    process.once("SIGINT", stop!);
    process.once("SIGTERM", stop!);
    process.stdout.write(`本地配置页已启动：${url}\n保存采用原子替换；外部编辑器在最终重读与替换之间仍存在窄竞态。\n`);
    if (!values["no-open"]) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const command = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
        // The opener may be the browser itself. It owns its lifetime and must
        // survive terminal signals sent to this service's foreground group.
        const browser = Bun.spawn(command, { env, detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
        browser.unref();
        const result = await Promise.race([
          browser.exited.then(code => ({ kind: "exited" as const, code })),
          stopped.then(() => ({ kind: "stopped" as const })),
          new Promise<{ kind: "pending" }>(resolve => { timeout = setTimeout(() => resolve({ kind: "pending" }), 5000); }),
        ]);
        if (result.kind === "exited") {
          if (result.code === 0) process.stdout.write(`浏览器打开命令已完成（未确认窗口显示），如未出现请访问：${url}\n`);
          else process.stderr.write(`无法自动打开浏览器，请访问：${url}\n`);
        } else if (result.kind === "pending") process.stderr.write(`尚未确认浏览器打开命令的结果，请自行访问：${url}\n`);
      } catch { process.stderr.write(`无法自动打开浏览器，请访问：${url}\n`); }
      finally { if (timeout) clearTimeout(timeout); }
    }
    await stopped;
    return 0;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    process.stderr.write(code === "EADDRINUSE" ? "本地端口已被占用，请用 --port 指定其他端口。\n" : error instanceof HttpError ? `Web 启动失败：${error.message}\n` : code?.startsWith("ERR_PARSE_ARGS") ? "Web 参数错误，请查看 web --help。\n" : "Web 启动失败，请检查参数、配置 JSON、目录权限和本地页面依赖。\n");
    return 1;
  } finally {
    server?.stop(true);
    if (stop) { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
  }
}
