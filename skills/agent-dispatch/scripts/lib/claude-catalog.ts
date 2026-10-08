import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { CliError } from "./cli";

/** Claude Agent SDK initialize contract; no user message or model turn is sent. */
export async function claudeCatalog(options: {
  /** Process-boundary test seam; never exposed by the public CLI or routing config. */
  command?: string[];
  timeoutMs?: number;
} = {}): Promise<any[]> {
  const argv = options.command ?? [
    "claude", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--no-session-persistence", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--settings", '{"disableAllHooks":true}',
  ];
  const child = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "sdk-ts", CLAUDECODE: undefined } });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  const requestId = "agent-dispatch-catalog";
  let count = 0;
  const timeout = setTimeout(() => { child.kill("SIGKILL"); lines.close(); }, options.timeoutMs ?? 30_000);
  child.on("error", () => lines.close());
  child.stdin.on("error", () => lines.close());
  try {
    child.stdin.write(JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "initialize", hooks: null } }) + "\n");
    for await (const line of lines) {
      if (++count > 10_000 || line.length > 4_000_000) throw Error();
      const msg = JSON.parse(line);
      if (msg.type !== "control_response" || msg.response?.request_id !== requestId) continue;
      const models = msg.response.response?.models;
      if (msg.response.subtype !== "success" || !Array.isArray(models) || !models.length || models.length > 1000 || models.some((m) => typeof m?.value !== "string" || !m.value.trim())) throw Error();
      return models;
    }
    throw Error();
  } catch {
    throw new CliError("claude_catalog_unknown", "Claude CLI initialize model catalog unavailable; no model substitution");
  } finally {
    clearTimeout(timeout); lines.close(); child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const kill = setTimeout(() => child.kill("SIGKILL"), 1000);
      await closed; clearTimeout(kill);
    }
  }
}
