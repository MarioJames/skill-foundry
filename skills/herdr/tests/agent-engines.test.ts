import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildLaunch,
  loadRoutingConfig,
  probeProfile,
  validateRoutingConfig,
  executionProfile,
  type ProbeRunner,
} from "../scripts/lib/agent-engines";
import { CliError } from "../scripts/lib/herdr-route";

const fixture = () => ({
  version: 1,
  engines: {
    qoder: { adapter: "qodercli", max_parallel: 1 },
    codex: { adapter: "codex", max_parallel: 2 },
  },
  routes: {
    ordinary: {
      engine_id: "qoder",
      model: "Qwen3.8-Flash",
      reasoning: { mode: "effort", value: "xhigh" },
    },
    moderate: {
      engine_id: "codex",
      model: "gpt-6-astra",
      reasoning: { mode: "effort", value: "medium" },
    },
    complex: {
      engine_id: "codex",
      model: "gpt-6-astra",
      reasoning: { mode: "effort", value: "high" },
    },
  },
  limits: { max_parallel: 3 },
});
const now = () => new Date("2026-09-23T08:00:00Z");

test("manual override accepts a route or complete profile and can restore automatic routing", () => {
  for (const override of [{ route: "ordinary" }, fixture().routes.ordinary]) {
    const c = validateRoutingConfig({ ...fixture(), manual_override: override });
    for (const difficulty of ["ordinary", "moderate", "complex"] as const)
      expect(executionProfile(c, difficulty)).toEqual(c.routes.ordinary);
    expect(executionProfile(validateRoutingConfig({ ...c, manual_override: null }), "complex"))
      .toEqual(c.routes.complex);
  }
  expect(executionProfile(validateRoutingConfig(fixture()), "moderate"))
    .toEqual(fixture().routes.moderate);
  for (const manual_override of [
    {}, "ordinary", { route: "missing" },
    { route: "ordinary", ...fixture().routes.ordinary },
    { engine_id: "qoder", model: "Qwen3.8-Flash" },
    { ...fixture().routes.ordinary, engine_id: "missing" },
    { ...fixture().routes.ordinary, reasoning: { mode: "effort", value: "Extra High" } },
  ]) expect(() => validateRoutingConfig({ ...fixture(), manual_override })).toThrow(CliError);
});
const runner: ProbeRunner = async (argv) => ({
  status: 0,
  stderr: "",
  stdout:
    argv[1] === "--version"
      ? argv[0] === "codex"
        ? "codex-cli 0.156.0"
        : "1.1.61"
      : "MODEL\nQwen3.8-Max\nQwen3.8-Flash\n",
});
const catalog = (efforts = ["medium", "high"]) =>
  JSON.stringify({
    client_version: "0.156.0",
    fetched_at: "2026-09-23T07:00:00Z",
    models: [
      {
        slug: "gpt-6-astra",
        supported_reasoning_levels: efforts.map((effort) => ({ effort })),
      },
    ],
  });

test("strict schema rejects missing/extra fields, unsafe counts and ambiguous engines", () => {
  const changes = [
    (c: any) => {
      c.secret = "token";
    },
    (c: any) => {
      delete c.routes.complex;
    },
    (c: any) => {
      c.routes.ordinary.engine_id = "missing";
    },
    (c: any) => {
      c.engines.qoder.executable = "sh";
    },
    (c: any) => {
      c.engines.qoder.adapter = "unknown";
    },
    (c: any) => {
      c.engines.other = { adapter: "codex", max_parallel: 1 };
    },
    (c: any) => {
      c.routes.ordinary.reasoning = { mode: "engine_default", value: "xhigh" };
    },
    (c: any) => {
      c.routes.ordinary.reasoning = {};
    },
    (c: any) => {
      c.routes.ordinary.model = "bad\nmodel";
    },
    (c: any) => {
      c.version = 2;
    },
    (c: any) => {
      c.limits.extra = true;
    },
    ...[0, -1, 1.1, Infinity, Number.MAX_SAFE_INTEGER + 1, "2"].map(
      (n) => (c: any) => {
        c.limits.max_parallel = n;
      },
    ),
  ];
  for (const change of changes) {
    const c = fixture();
    change(c);
    expect(() => validateRoutingConfig(c)).toThrow(CliError);
  }
});

test("native effort validation never translates display labels or silently supplies a default", () => {
  for (const value of ["Extra High", "extra_high", "ultracode", "INVALID"]) {
    const c = fixture();
    c.routes.ordinary.reasoning.value = value;
    expect(() => validateRoutingConfig(c)).toThrow(CliError);
  }
  const c = fixture();
  c.routes.complex.reasoning.value = "minimal";
  expect(() => validateRoutingConfig(c)).toThrow("model");
});

test("launch uses literal argv and preserves engine_default as omitted effort", () => {
  const c = validateRoutingConfig(fixture());
  expect(buildLaunch(c, c.routes.ordinary)).toEqual({
    kind: "qodercli",
    argv: ["--model", "Qwen3.8-Flash", "--reasoning-effort", "xhigh"],
  });
  expect(buildLaunch(c, c.routes.complex)).toEqual({
    kind: "codex",
    argv: ["--model", "gpt-6-astra", "-c", 'model_reasoning_effort="high"'],
  });
  const profile = {
    ...c.routes.complex,
    model: "vendor/model with spaces;$(echo unsafe)",
    reasoning: { mode: "engine_default" as const },
  };
  expect(buildLaunch(c, profile)).toEqual({
    kind: "codex",
    argv: ["--model", profile.model],
  });
  expect(() => buildLaunch(c, { ...profile, engine_id: "toString" })).toThrow(
    CliError,
  );
});

test("loading reads a whole selected file without merging and does not echo malformed secrets", () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-config-test-"));
  try {
    const path = join(dir, "agents.json");
    writeFileSync(path, JSON.stringify(fixture()));
    expect(loadRoutingConfig(path)).toEqual(validateRoutingConfig(fixture()));
    writeFileSync(path, '{"token":"DO_NOT_ECHO"');
    try {
      loadRoutingConfig(path);
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect(String(error)).not.toContain("DO_NOT_ECHO");
    }
    expect(() => loadRoutingConfig(join(dir, "missing"))).toThrow(CliError);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("default config path is HOME/.config/herdr/agents.json, not cwd or a merged fallback", () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-home-test-"));
  try {
    const run = () =>
      Bun.spawnSync(
        [
          process.execPath,
          "-e",
          "import {loadRoutingConfig} from './skills/herdr/scripts/lib/agent-engines.ts'; try { console.log(JSON.stringify(loadRoutingConfig())); } catch(e) { console.log(e.code); }",
        ],
        {
          cwd: join(import.meta.dir, "../../.."),
          env: { ...process.env, HOME: dir },
        },
      );
    expect(run().stdout.toString().trim()).toBe("config_read_failed");
    mkdirSync(join(dir, ".config/herdr"), { recursive: true });
    writeFileSync(
      join(dir, ".config/herdr/agents.json"),
      JSON.stringify(fixture()),
    );
    expect(JSON.parse(run().stdout.toString())).toEqual(fixture());
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("read-only probe binds exact profile, tested CLI and authenticated Qoder model listing", async () => {
  const c = validateRoutingConfig(fixture());
  const calls: string[][] = [];
  const result = await probeProfile(c, c.routes.ordinary, {
    now,
    runner: async (argv) => {
      calls.push(argv);
      return runner(argv);
    },
  });
  expect(result.status).toBe("supported");
  expect(result.profile).toEqual(c.routes.ordinary);
  expect(result.cli_version).toBe("1.1.61");
  expect(result.evidence.join(" ")).toContain("launch_only");
  expect(calls).toEqual([
    ["qodercli", "--version"],
    ["qodercli", "--list-models"],
  ]);
});

test("unknown version, model and default effort stay unknown despite valid help/native syntax", async () => {
  const c = validateRoutingConfig(fixture());
  const unknownVersion: ProbeRunner = async () => ({
    status: 0,
    stdout: "9.9.9",
    stderr: "",
  });
  expect(
    (await probeProfile(c, c.routes.ordinary, { runner: unknownVersion, now }))
      .status,
  ).toBe("unknown");
  const unknownModel = { ...c.routes.ordinary, model: "future model" };
  const futureRunner: ProbeRunner = async (args) =>
    args[1] === "--list-models"
      ? { status: 0, stdout: "MODEL\nfuture model", stderr: "" }
      : runner(args);
  expect(
    (await probeProfile(c, unknownModel, { runner: futureRunner, now })).status,
  ).toBe("unknown");
  expect(
    (
      await probeProfile(
        c,
        { ...c.routes.ordinary, reasoning: { mode: "engine_default" } },
        { runner, now },
      )
    ).status,
  ).toBe("unknown");
  expect(
    (
      await probeProfile(
        c,
        { ...c.routes.ordinary, reasoning: { mode: "effort", value: "high" } },
        { runner, now },
      )
    ).status,
  ).toBe("unknown");
  expect(
    (
      await probeProfile(
        c,
        { ...c.routes.ordinary, model: "absent model" },
        { runner, now },
      )
    ).status,
  ).toBe("unsupported");
});

test("Codex catalog is model-specific; compatibility requires fresh version-matched metadata", async () => {
  const c = validateRoutingConfig(fixture());
  const probe = (data: string) =>
    probeProfile(c, c.routes.complex, {
      runner,
      now,
      readCodexCatalog: () => data,
    });
  expect((await probe(catalog())).status).toBe("supported");
  expect((await probe(catalog(["medium"]))).status).toBe("unsupported");
  expect((await probe(catalog().replace("07:00:00", "09:00:00"))).status).toBe(
    "unknown",
  );
  expect(
    (await probe(catalog().replace("2026-09-23", "2026-09-20"))).status,
  ).toBe("unknown");
  expect((await probe(catalog().replace("0.156.0", "0.155.0"))).status).toBe(
    "unknown",
  );
  expect((await probe("{}")).status).toBe("unknown");
  let clockCalls = 0;
  const refreshed = await probeProfile(c, c.routes.complex, {
    runner,
    readCodexCatalog: () => catalog().replace("07:00:00", "08:00:01"),
    now: () =>
      new Date(
        clockCalls++ === 0 ? "2026-09-23T08:00:00Z" : "2026-09-23T08:00:02Z",
      ),
  });
  expect(refreshed.status).toBe("supported");
});

test("CLI failures and malformed metadata never leak raw stdout, stderr or exceptions", async () => {
  const c = validateRoutingConfig(fixture());
  for (const r of [
    async () => ({ status: 1, stdout: "SECRET", stderr: "SECRET" }),
    async () => {
      throw new Error("SECRET");
    },
    async () => ({ status: 0, stdout: "SECRET", stderr: "SECRET" }),
  ]) {
    const result = await probeProfile(c, c.routes.ordinary, { runner: r, now });
    expect(result.status).toBe("unknown");
    expect(JSON.stringify(result)).not.toContain("SECRET");
  }
  const missing = await probeProfile(c, c.routes.ordinary, {
    now,
    runner: async () => {
      throw Object.assign(new Error("SECRET"), { code: "ENOENT" });
    },
  });
  expect(missing.status).toBe("unsupported");
});

test("Sol high compatibility is exact and does not approve other Sol efforts or versions", async () => {
  const c = validateRoutingConfig(fixture());
  const profile = { ...c.routes.complex, model: "gpt-6-sol" };
  const readCodexCatalog = () => catalog().replace("gpt-6-astra", "gpt-6-sol");
  expect(
    (await probeProfile(c, profile, { runner, now, readCodexCatalog })).status,
  ).toBe("supported");
  expect(
    (
      await probeProfile(
        c,
        { ...profile, reasoning: { mode: "effort", value: "medium" } },
        { runner, now, readCodexCatalog },
      )
    ).status,
  ).toBe("unknown");
  expect(
    (
      await probeProfile(c, profile, {
        runner: async () => ({
          status: 0,
          stdout: "codex-cli 0.157.0",
          stderr: "",
        }),
        now,
        readCodexCatalog,
      })
    ).status,
  ).toBe("unknown");
});
