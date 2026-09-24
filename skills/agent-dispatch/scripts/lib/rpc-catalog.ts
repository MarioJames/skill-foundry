import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { buildLaunch, type RoutingConfig, type ExecutionProfile, type ProfileProbe } from "./agent-engines";
import { CliError } from "./cli";

/** Query the selected installed binary, not a cache another CLI can overwrite. No thread/turn is created. */
export async function rpcCatalog(): Promise<{ models: any[]; version: string }> {
  const child = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  const send = (x: unknown) => child.stdin.write(JSON.stringify(x) + "\n");
  let timedOut = false, failure = false, id = 1, version = "", count = 0;
  const models: any[] = [];
  const timeout = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); lines.close(); }, 30_000);
  child.on("error", () => { failure = true; lines.close(); });
  child.stdin.on("error", () => { failure = true; lines.close(); });
  try {
    send({ id, method: "initialize", params: { clientInfo: { name: "agent_dispatch_catalog", version: "1" }, capabilities: { experimentalApi: false } } });
    for await (const line of lines) {
      if (++count > 10_000 || line.length > 4_000_000) throw Error();
      const msg = JSON.parse(line);
      if (msg.id !== id || msg.method) continue;
      if (msg.error) throw Error();
      if (id === 1) {
        version = msg.result?.userAgent?.match(/agent_dispatch_catalog\/(\d+\.\d+\.\d+)/u)?.[1];
        if (!version) throw Error();
        send({ method: "initialized", params: {} });
        send({ id: ++id, method: "model/list", params: { limit: 100, includeHidden: true } });
      } else {
        if (!Array.isArray(msg.result?.data)) throw Error();
        models.push(...msg.result.data);
        if (models.length > 1000) throw Error();
        if (!msg.result.nextCursor) return { models, version };
        send({ id: ++id, method: "model/list", params: { limit: 100, includeHidden: true, cursor: msg.result.nextCursor } });
      }
    }
    throw Error();
  } catch {
    throw new CliError("rpc_catalog_unknown", `Actual app-server model catalog unavailable${timedOut ? " (timeout)" : failure ? " (process error)" : ""}; no model substitution`);
  } finally {
    clearTimeout(timeout); lines.close(); child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) {
      const kill = setTimeout(() => child.kill("SIGKILL"), 1000);
      await closed; clearTimeout(kill);
    }
  }
}
export function rpcProbe(config: RoutingConfig, profile: ExecutionProfile, catalog: Awaited<ReturnType<typeof rpcCatalog>>): ProfileProbe {
  const launch = buildLaunch(config, profile);
  const model = catalog.models.filter((m) => m.model === profile.model);
  const effort = profile.reasoning;
  const supported = model.length === 1 && Array.isArray(model[0].supportedReasoningEfforts) && (effort.mode === "engine_default" || model[0].supportedReasoningEfforts.some((r: any) => r.reasoningEffort === effort.value));
  return { profile, launch, status: supported ? "supported" : "unknown", checked_at: new Date().toISOString(), cli_version: catalog.version, adapter_version: "rpc-v1", reason: supported ? "live_rpc_model_catalog" : "rpc_model_or_effort_not_listed", evidence: ["Actual app-server initialize + model/list; no task execution or quota guarantee"] };
}
