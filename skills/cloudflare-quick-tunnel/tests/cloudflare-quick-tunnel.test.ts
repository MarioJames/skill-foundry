import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { waitForPublicReady } from "../scripts/lib/lifecycle";

const skillDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cqtEntry = join(skillDir, "scripts", "cqt.ts");
const temporaryRoots = new Set<string>();

interface Harness {
  root: string;
  stateDir: string;
  callsPath: string;
  env: Record<string, string>;
}

interface CliResult {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
}

function createHarness(): Harness {
  const root = mkdtempSync(join(tmpdir(), "cloudflare-quick-tunnel-test-"));
  temporaryRoots.add(root);
  const binDir = join(root, "bin");
  const homeDir = join(root, "home");
  const callsPath = join(root, "cloudflared-calls.jsonl");
  const stateDir = join(root, "state with spaces");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });

  const fakeCloudflared = join(binDir, "cloudflared");
  writeFileSync(
    fakeCloudflared,
    `#!${process.execPath}
import { appendFileSync } from "node:fs";
const args = Bun.argv.slice(2);
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n");
console.error("INF Your quick Tunnel has been created! Visit it at https://fixture-remote.trycloudflare.com");
const stop = () => process.exit(0);
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
setInterval(() => {}, 1_000);
`,
  );
  chmodSync(fakeCloudflared, 0o755);

  const fakeCurl = join(binDir, "curl");
  writeFileSync(
    fakeCurl,
    `#!${process.execPath}
process.stdout.write("200");
`,
  );
  chmodSync(fakeCurl, 0o755);

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.PATH = `${binDir}${delimiter}${process.env.PATH || ""}`;
  env.HOME = homeDir;

  return { root, stateDir, callsPath, env };
}

function runCqt(
  arguments_: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): CliResult {
  const result = Bun.spawnSync({
    cmd: [process.execPath, cqtEntry, ...arguments_],
    cwd: options.cwd || skillDir,
    env: options.env || process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode ?? -1,
    stdout: Buffer.from(result.stdout || []),
    stderr: Buffer.from(result.stderr || []),
  };
}

function assignment(stdout: string, name: string): string {
  const line = stdout.split("\n").find((entry) => entry.startsWith(`${name}=`));
  if (!line) throw new Error(`missing ${name} in ${stdout}`);
  const value = line.slice(name.length + 1);
  if (!value.startsWith("'") || !value.endsWith("'")) {
    throw new Error(`invalid shell assignment: ${line}`);
  }
  return value.slice(1, -1).replaceAll("'\\''", "'");
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await Bun.sleep(50);
  }
  return !isAlive(pid);
}

afterEach(() => {
  for (const root of temporaryRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  temporaryRoots.clear();
});

describe("CLI contract", () => {
  test("reports version, usage, and invalid origins", () => {
    const version = runCqt(["--version"]);
    expect(version.exitCode).toBe(0);
    expect(version.stdout.toString()).toBe("cloudflare-quick-tunnel 0.3.0\n");

    const usage = runCqt([]);
    expect(usage.exitCode).toBe(1);
    expect(usage.stderr.toString()).toContain("usage: cqt <subcommand>");

    const invalid = runCqt(["start", "file:///tmp/page.html"]);
    expect(invalid.exitCode).toBe(2);
    expect(invalid.stderr.toString()).toContain("有效 HTTP(S) URL");
  });
});

describe("public readiness", () => {
  test("keeps transport errors and Cloudflare 5xx in the pending state", async () => {
    let now = 0;
    const probes = [
      { exitCode: 35, httpCode: "000" },
      { exitCode: 0, httpCode: "530" },
      { exitCode: 0, httpCode: "200" },
    ];
    const pending: string[] = [];

    const result = await waitForPublicReady({
      now: () => now,
      onPending: ({ probe }) => pending.push(`${probe.exitCode}:${probe.httpCode}`),
      probe: () => probes.shift() || { exitCode: 0, httpCode: "200" },
      retryIntervalMs: 1_000,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      timeoutMs: 10_000,
    });

    expect(result).toEqual({
      attempts: 3,
      elapsedMs: 2_000,
      probe: { exitCode: 0, httpCode: "200" },
      status: "ready",
    });
    expect(pending).toEqual(["35:000", "0:530"]);
  });

  test("times out by elapsed time instead of a fast-failure attempt count", async () => {
    let now = 0;

    const result = await waitForPublicReady({
      now: () => now,
      probe: () => ({ exitCode: 0, httpCode: "530" }),
      retryIntervalMs: 1_000,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      timeoutMs: 2_500,
    });

    expect(result).toEqual({
      attempts: 4,
      elapsedMs: 2_500,
      probe: { exitCode: 0, httpCode: "530" },
      status: "timeout",
    });
  });
});

describe("Quick Tunnel lifecycle", () => {
  test("start, status, stop, and cleanup own the complete lifecycle", async () => {
    const harness = createHarness();
    const origin = "http://127.0.0.1:4173/preview/?mode=review#hero";
    let tunnelPid = 0;

    try {
      const started = runCqt(
        ["start", origin, "--state-dir", harness.stateDir],
        { cwd: harness.root, env: harness.env },
      );
      if (started.exitCode !== 0) {
        throw new Error(`start failed:\n${started.stderr.toString()}`);
      }
      expect(assignment(started.stdout.toString(), "ORIGIN_URL")).toBe(origin);
      expect(assignment(started.stdout.toString(), "PUBLIC_URL")).toBe(
        "https://fixture-remote.trycloudflare.com",
      );
      expect(assignment(started.stdout.toString(), "TUNNEL_STATE_DIR")).toBe(
        harness.stateDir,
      );
      tunnelPid = Number(assignment(started.stdout.toString(), "TUNNEL_PID"));
      const tunnelLog = assignment(started.stdout.toString(), "TUNNEL_LOG");
      expect(tunnelPid).toBeGreaterThan(0);
      expect(isAlive(tunnelPid)).toBe(true);
      expect(existsSync(tunnelLog)).toBe(true);

      const invocation = JSON.parse(
        readFileSync(harness.callsPath, "utf8").trim().split("\n")[0] || "[]",
      ) as string[];
      expect(invocation).toEqual([
        "tunnel",
        "--config",
        join(harness.stateDir, "empty-config.yml"),
        "--no-autoupdate",
        "--url",
        origin,
      ]);

      const running = runCqt(["status", "--state-dir", harness.stateDir], {
        cwd: harness.root,
        env: harness.env,
      });
      expect(running.exitCode).toBe(0);
      expect(assignment(running.stdout.toString(), "TUNNEL_STATUS")).toBe(
        "running",
      );
      expect(Number(assignment(running.stdout.toString(), "TUNNEL_PID"))).toBe(
        tunnelPid,
      );

      const stopped = runCqt(["stop", "--state-dir", harness.stateDir], {
        cwd: harness.root,
        env: harness.env,
      });
      expect(stopped.exitCode).toBe(0);
      expect(await waitForExit(tunnelPid)).toBe(true);
      expect(existsSync(harness.stateDir)).toBe(true);
      expect(existsSync(tunnelLog)).toBe(true);

      const stoppedStatus = runCqt(
        ["status", "--state-dir", harness.stateDir],
        { cwd: harness.root, env: harness.env },
      );
      expect(assignment(stoppedStatus.stdout.toString(), "TUNNEL_STATUS")).toBe(
        "stopped",
      );

      const stoppedAgain = runCqt(
        ["stop", "--state-dir", harness.stateDir],
        { cwd: harness.root, env: harness.env },
      );
      expect(stoppedAgain.exitCode).toBe(0);

      const cleaned = runCqt(
        ["cleanup", "--state-dir", harness.stateDir],
        { cwd: harness.root, env: harness.env },
      );
      expect(cleaned.exitCode).toBe(0);
      expect(existsSync(harness.stateDir)).toBe(false);
    } finally {
      if (tunnelPid > 0 && isAlive(tunnelPid)) process.kill(tunnelPid, "SIGKILL");
    }
  }, 30_000);
});
