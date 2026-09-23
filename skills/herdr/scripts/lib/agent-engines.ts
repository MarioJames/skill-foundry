import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CliError } from "./herdr-route";

export type Complexity = "ordinary" | "moderate" | "complex";
export type Reasoning =
  { mode: "effort"; value: string } | { mode: "engine_default" };
export type ExecutionProfile = {
  engine_id: string;
  model: string;
  reasoning: Reasoning;
};
export type RoutingConfig = {
  version: 1;
  engines: Record<
    string,
    { adapter: "codex" | "qodercli"; max_parallel: number }
  >;
  routes: Record<Complexity, ExecutionProfile>;
  limits: { max_parallel: number };
};
export type LaunchSpec = { kind: "codex" | "qodercli"; argv: string[] };
export type ProfileProbe = {
  status: "supported" | "unsupported" | "unknown";
  checked_at: string;
  adapter_version: string;
  cli_version: string | null;
  reason: string;
  launch: LaunchSpec;
  profile: ExecutionProfile;
  evidence: string[];
};
export type ProbeRunner = (
  argv: string[],
) => Promise<{ status: number; stdout: string; stderr: string }>;
export type ProbeOptions = {
  runner?: ProbeRunner;
  now?: () => Date;
  /** Read-only test seam. Production uses the active CODEX_HOME model cache. */
  readCodexCatalog?: () => string;
};

const ADAPTER_VERSION = "1";
const COMPLEXITIES: Complexity[] = ["ordinary", "moderate", "complex"];
// Native syntax only. A valid token does NOT establish model support.
// Qoder auto is explicit CLI auto selection; engine_default omits the flag.
// ultracode is a workflow/delegation mode, outside this effort-only contract.
const NATIVE_EFFORTS = {
  codex: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
  qodercli: ["auto", "none", "low", "medium", "high", "xhigh", "max"],
};
// Observed in codex-cli 0.156.0 model metadata on 2026-09-23. Unknown
// models remain syntactically valid and require a model-specific runtime probe.
const CODEX_MODEL_EFFORTS: Record<string, readonly string[]> = {
  "gpt-6-astra": ["low", "medium", "high", "xhigh", "max", "ultra"],
  "gpt-6-sol": ["low", "medium", "high", "xhigh", "max", "ultra"],
};
// Deliberately exact versions and combinations, not an engine-wide allowlist.
// 2026-09-23: no-tool real CLI samples in task-owned /tmp directories.
// Codex exec --ephemeral --sandbox read-only: startup read back model and effort;
// both gpt-6-astra/medium and /high returned ENGINE_OK, exit 0.
// Qoder --no-session-persistence --tools '' --strict-mcp-config: Flash/xhigh
// stdin prompt returned ENGINE_OK, stream-json init read back Qwen3.8-Flash,
// tools=[] and mcp_servers=[], exit 0. Its UI maps xhigh to "Extra High";
// no authoritative effort readback: only launch_only compatibility is asserted.
const ACCEPTED = [
  {
    kind: "codex",
    version: "0.156.0",
    model: "gpt-6-astra",
    effort: "medium",
    evidence:
      "2026-09-23 codex exec sample: model=gpt-6-astra; reasoning effort=medium; ENGINE_OK; exit=0",
  },
  {
    kind: "codex",
    version: "0.156.0",
    model: "gpt-6-astra",
    effort: "high",
    evidence:
      "2026-09-23 codex exec sample: model=gpt-6-astra; reasoning effort=high; ENGINE_OK; exit=0",
  },
  {
    kind: "qodercli",
    version: "1.1.61",
    model: "Qwen3.8-Flash",
    effort: "xhigh",
    evidence:
      "2026-09-23 qodercli print sample: init.model=Qwen3.8-Flash; --reasoning-effort xhigh; ENGINE_OK; exit=0; installed UI labels xhigh as Extra High; effort readback unavailable",
  },
] as const;

function invalid(message: string): never {
  throw new CliError("invalid_config", message, 2);
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    invalid(`${label} must be a plain object`);
  return value as Record<string, unknown>;
}
function exact(
  value: Record<string, unknown>,
  keys: string[],
  label: string,
): void {
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(value, k))
  ) {
    invalid(`${label} must contain exactly: ${keys.join(", ")}`);
  }
}
function positive(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1)
    invalid(`${label} must be a positive safe integer`);
  return value as number;
}
function nativeText(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    invalid(
      `${label} must be nonempty text without control characters or surrounding whitespace`,
    );
  }
  return value;
}
function validateProfile(
  engines: RoutingConfig["engines"],
  value: unknown,
): ExecutionProfile {
  const p = object(value, "profile");
  exact(p, ["engine_id", "model", "reasoning"], "profile");
  const engine_id = nativeText(p.engine_id, "profile.engine_id");
  if (!Object.hasOwn(engines, engine_id))
    invalid("profile.engine_id must reference a declared engine");
  const model = nativeText(p.model, "profile.model");
  const r = object(p.reasoning, "profile.reasoning");
  if (r.mode === "engine_default") {
    exact(r, ["mode"], "profile.reasoning");
    return { engine_id, model, reasoning: { mode: "engine_default" } };
  }
  if (r.mode !== "effort")
    invalid("profile.reasoning.mode must be effort or engine_default");
  exact(r, ["mode", "value"], "profile.reasoning");
  const effort = nativeText(r.value, "profile.reasoning.value");
  const adapter = engines[engine_id]!.adapter;
  if (!NATIVE_EFFORTS[adapter].includes(effort))
    invalid(
      "profile.reasoning.value is not a native effort supported by this adapter",
    );
  const known =
    adapter === "codex" && Object.hasOwn(CODEX_MODEL_EFFORTS, model)
      ? CODEX_MODEL_EFFORTS[model]
      : undefined;
  if (known && !known.includes(effort))
    invalid("profile.reasoning.value is unsupported for this model");
  return { engine_id, model, reasoning: { mode: "effort", value: effort } };
}

export function validateRoutingConfig(value: unknown): RoutingConfig {
  const c = object(value, "config");
  exact(c, ["version", "engines", "routes", "limits"], "config");
  if (c.version !== 1) invalid("config.version must be 1");
  const rawEngines = object(c.engines, "engines");
  if (!Object.keys(rawEngines).length) invalid("engines must not be empty");
  const engines: RoutingConfig["engines"] = {};
  const adapters = new Set<string>();
  for (const [id, raw] of Object.entries(rawEngines)) {
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/u.test(id) ||
      ["__proto__", "constructor", "prototype"].includes(id)
    )
      invalid("engine ID must be a simple identifier");
    const e = object(raw, "engine");
    exact(e, ["adapter", "max_parallel"], "engine");
    if (e.adapter !== "codex" && e.adapter !== "qodercli")
      invalid("engine.adapter must be codex or qodercli");
    if (adapters.has(e.adapter))
      invalid("only one engine instance per adapter is supported");
    adapters.add(e.adapter);
    engines[id] = {
      adapter: e.adapter,
      max_parallel: positive(e.max_parallel, "engine.max_parallel"),
    };
  }
  const routes = object(c.routes, "routes");
  exact(routes, COMPLEXITIES, "routes");
  const limits = object(c.limits, "limits");
  exact(limits, ["max_parallel"], "limits");
  return {
    version: 1,
    engines,
    routes: Object.fromEntries(
      COMPLEXITIES.map((k) => [k, validateProfile(engines, routes[k])]),
    ) as RoutingConfig["routes"],
    limits: {
      max_parallel: positive(limits.max_parallel, "limits.max_parallel"),
    },
  };
}

export function loadRoutingConfig(
  path = join(homedir(), ".config", "herdr", "agents.json"),
): RoutingConfig {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch {
    throw new CliError(
      "config_read_failed",
      "Cannot read routing config; supply --config or create ~/.config/herdr/agents.json",
      2,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new CliError(
      "invalid_config",
      "Routing config must be valid JSON",
      2,
    );
  }
  return validateRoutingConfig(parsed);
}

export function buildLaunch(
  config: RoutingConfig,
  profile: ExecutionProfile,
): LaunchSpec {
  const c = validateRoutingConfig(config);
  const p = validateProfile(c.engines, profile);
  const kind = c.engines[p.engine_id]!.adapter;
  const argv = ["--model", p.model];
  if (p.reasoning.mode === "effort") {
    if (kind === "codex")
      argv.push(
        "-c",
        `model_reasoning_effort=${JSON.stringify(p.reasoning.value)}`,
      );
    else argv.push("--reasoning-effort", p.reasoning.value);
  }
  return { kind, argv };
}

const runProbe: ProbeRunner = (argv) =>
  new Promise((resolve, reject) => {
    // No shell, prompt, model execution, environment dump or raw diagnostic output.
    const child = execFile(
      argv[0]!,
      argv.slice(1),
      {
        timeout: 60_000,
        killSignal: "SIGKILL",
        maxBuffer: 1_048_576,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") reject(error);
        else resolve({ status: (error?.code as number) ?? 0, stdout, stderr });
      },
    );
    child.stdin?.end();
  });

export async function probeProfile(
  config: RoutingConfig,
  profile: ExecutionProfile,
  options: ProbeOptions = {},
): Promise<ProfileProbe> {
  const launch = buildLaunch(config, profile);
  const p = validateProfile(config.engines, profile);
  const checked = (options.now ?? (() => new Date()))();
  const result: ProfileProbe = {
    status: "unknown",
    checked_at: checked.toISOString(),
    adapter_version: ADAPTER_VERSION,
    cli_version: null,
    reason: "compatibility_not_verified",
    launch,
    profile: p,
    evidence: [],
  };
  const finish = (status: ProfileProbe["status"], reason: string) => ({
    ...result,
    status,
    reason,
  });
  const run = options.runner ?? runProbe;
  try {
    const version = await run([launch.kind, "--version"]);
    if (version.status !== 0)
      return finish("unknown", "cli_version_probe_failed");
    const match = version.stdout
      .trim()
      .match(
        launch.kind === "codex"
          ? /^codex-cli (\d+\.\d+\.\d+)$/u
          : /^(\d+\.\d+\.\d+)$/u,
      );
    if (!match) return finish("unknown", "cli_version_unrecognized");
    result.cli_version = match[1]!;
    result.evidence.push(`${launch.kind} --version: ${result.cli_version}`);
    if (
      !ACCEPTED.some(
        (a) => a.kind === launch.kind && a.version === result.cli_version,
      )
    )
      return finish("unknown", "cli_version_not_verified");
    if (launch.kind === "qodercli") {
      const models = await run(["qodercli", "--list-models"]);
      if (models.status !== 0) return finish("unknown", "model_listing_failed");
      const rows = models.stdout
        .trim()
        .split(/\r?\n/u)
        .map((s) => s.trim());
      // Exact known CLI output grammar. Never interpret a help/error page as a list.
      if (
        rows[0] !== "MODEL" ||
        rows.length < 2 ||
        rows.slice(1).some((s) => !s || /[\u0000-\u001f\u007f]/u.test(s))
      )
        return finish("unknown", "model_listing_unrecognized");
      if (!rows.slice(1).includes(p.model))
        return finish("unsupported", "model_not_available");
      result.evidence.push(
        "qodercli --list-models: requested model present in current account listing",
      );
    } else {
      let cache: any;
      try {
        const read =
          options.readCodexCatalog ??
          (() =>
            readFileSync(
              join(
                process.env.CODEX_HOME || join(homedir(), ".codex"),
                "models_cache.json",
              ),
              "utf8",
            ));
        cache = JSON.parse(read());
      } catch {
        return finish("unknown", "model_catalog_unavailable");
      }
      // Another CLI may refresh the shared cache while --version is in flight.
      // Compare against read time, not the earlier probe-start timestamp.
      const age =
        (options.now ?? (() => new Date()))().getTime() -
        Date.parse(cache?.fetched_at);
      if (
        cache?.client_version !== result.cli_version ||
        !Number.isFinite(age) ||
        age < 0 ||
        age > 86_400_000 ||
        !Array.isArray(cache.models)
      ) {
        result.evidence.push(
          `catalog checks: version_matches=${cache?.client_version === result.cli_version}; age_ms=${Number.isFinite(age) ? age : "invalid"}; models_array=${Array.isArray(cache?.models)}`,
        );
        return finish("unknown", "model_catalog_stale_or_unrecognized");
      }
      const matches = cache.models.filter((m: any) => m?.slug === p.model);
      if (matches.length !== 1)
        return finish("unknown", "model_not_in_catalog");
      const levels = matches[0].supported_reasoning_levels;
      if (
        !Array.isArray(levels) ||
        !levels.length ||
        levels.some((l: any) => typeof l?.effort !== "string")
      )
        return finish("unknown", "model_efforts_unrecognized");
      if (
        p.reasoning.mode === "effort" &&
        !levels.some(
          (l: any) => l.effort === (p.reasoning as { value: string }).value,
        )
      )
        return finish("unsupported", "model_effort_not_supported");
      result.evidence.push(
        "Codex model cache: requested model and native effort metadata; CLI version matched; age <= 24h; cached availability does not verify current account authorization",
      );
    }
    if (p.reasoning.mode === "engine_default")
      return finish("unknown", "engine_default_unresolved");
    const accepted = ACCEPTED.find(
      (a) =>
        a.kind === launch.kind &&
        a.version === result.cli_version &&
        a.model === p.model &&
        a.effort === (p.reasoning as { value: string }).value,
    );
    if (!accepted)
      return finish("unknown", "model_effort_combination_not_verified");
    result.evidence.push(
      accepted.evidence,
      "launch_only: version/model/effort compatibility; no current session readback, tool-context or authorization guarantee",
    );
    return finish("supported", "tested_cli_model_effort_contract");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT")
      return finish("unsupported", "cli_not_found");
    return finish("unknown", "cli_probe_failed");
  }
}
