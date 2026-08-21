import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { projectProfileName } from "../scripts/lib/common.ts";

const skillDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bhEntry = join(skillDir, "scripts", "bh.ts");
const temporaryRoots = new Set<string>();

interface Harness {
  root: string;
  binDir: string;
  env: Record<string, string>;
  callsPath: string;
  logDir: string;
}

interface CliResult {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
}

function cleanEnvironment(
  overrides: Record<string, string | undefined> = {},
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...process.env, ...overrides })) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function createHarness(): Harness {
  const root = mkdtempSync(join(tmpdir(), "browser-harness-test-"));
  temporaryRoots.add(root);
  const binDir = join(root, "bin");
  const homeDir = join(root, "home");
  const callsPath = join(root, "agent-browser-calls.jsonl");
  const logDir = join(root, "logs");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });

  const fakeAgentBrowser = join(binDir, "agent-browser");
  writeFileSync(
    fakeAgentBrowser,
    `#!${process.execPath}
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
const args = Bun.argv.slice(2);
if (process.env.FAKE_AGENT_BROWSER_LOG) {
  appendFileSync(process.env.FAKE_AGENT_BROWSER_LOG, JSON.stringify(args) + "\\n");
}
if (args[0] === "--version") {
  console.log("agent-browser " + (process.env.FAKE_AGENT_BROWSER_VERSION || "0.29.1"));
  process.exit(0);
}
if (args[0] === "open") {
  if (process.env.FAKE_OPEN_FAIL === "1") process.exit(9);
  console.log("opened " + args[1]);
  process.exit(0);
}
if (args[0] === "snapshot") {
  console.log(JSON.stringify({ success: true, data: { origin: "https://example.test", refs: {}, snapshot: "page" }, error: null }));
  process.exit(0);
}
if (args[0] === "console") {
  if (process.env.FAKE_FAIL_CONSOLE === "1") {
    console.log("not-json");
    process.exit(7);
  }
  console.log(JSON.stringify({ success: true, data: { messages: [{ type: "warn", text: "sample" }] }, error: null }));
  process.exit(0);
}
if (args[0] === "network" && args[1] === "requests") {
  const requests = args.includes("--status")
    ? [{ requestId: "bad-1", status: 500 }]
    : [{ requestId: "xhr-1", status: 200 }, { requestId: "xhr-2", status: 204 }];
  console.log(JSON.stringify({ success: true, data: { requests }, error: null }));
  process.exit(0);
}
if (args[0] === "screenshot") {
  const index = args.indexOf("--annotate");
  const path = args[index + 1];
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "fake-png");
  process.exit(process.env.FAKE_FAIL_SCREENSHOT === "1" ? 8 : 0);
}
if (args[0] === "network" && args[1] === "har" && args[2] === "start") {
  process.exit(0);
}
if (args[0] === "network" && args[1] === "har" && args[2] === "stop") {
  writeFileSync(args[3], "fake-har");
  process.exit(process.env.FAKE_FAIL_HAR === "1" ? 6 : 0);
}
process.exit(4);
`,
  );
  chmodSync(fakeAgentBrowser, 0o755);

  return {
    root,
    binDir,
    callsPath,
    logDir,
    env: cleanEnvironment({
      PATH: `${binDir}${delimiter}${process.env.PATH || ""}`,
      HOME: homeDir,
      BH_LOG_DIR: logDir,
      BH_PROFILE_ROOT: join(root, "profiles"),
      FAKE_AGENT_BROWSER_LOG: callsPath,
    }),
  };
}

function installFakeCloudflare(harness: Harness): string {
  const callsPath = join(harness.root, "cloudflared-calls.jsonl");
  const fakeCloudflared = join(harness.binDir, "cloudflared");
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

  const fakeCurl = join(harness.binDir, "curl");
  writeFileSync(
    fakeCurl,
    `#!${process.execPath}
process.stdout.write("200");
`,
  );
  chmodSync(fakeCurl, 0o755);
  return callsPath;
}

function runBh(
  arguments_: string[],
  options: {
    cwd?: string;
    env?: Record<string, string>;
  } = {},
): CliResult {
  const result = Bun.spawnSync({
    cmd: [process.execPath, bhEntry, ...arguments_],
    cwd: options.cwd || skillDir,
    env: options.env || cleanEnvironment(),
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

function calls(path: string): string[][] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
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

function assignment(stdout: string, name: string): string {
  const line = stdout.split("\n").find((entry) => entry.startsWith(`${name}=`));
  if (!line) throw new Error(`missing ${name} in ${stdout}`);
  const value = line.slice(name.length + 1);
  if (!value.startsWith("'") || !value.endsWith("'")) {
    throw new Error(`invalid shell assignment: ${line}`);
  }
  return value.slice(1, -1).replaceAll("'\\''", "'");
}

function quoteForShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

afterEach(() => {
  for (const root of temporaryRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  temporaryRoots.clear();
});

describe("CLI contracts", () => {
  test("version, usage, and error exit codes stay stable", () => {
    const version = runBh(["--version"]);
    expect(version.exitCode).toBe(0);
    expect(version.stdout.toString()).toBe("browser-harness 0.6.0\n");

    const usage = runBh([]);
    expect(usage.exitCode).toBe(1);
    expect(usage.stdout.toString()).toBe("");
    expect(usage.stderr.toString()).toContain("usage: bh <subcommand>");

    const missingTarget = runBh(["prepare"]);
    expect(missingTarget.exitCode).toBe(2);
    expect(missingTarget.stderr.toString()).toContain("usage: bh prepare <target>");

    const missingPublishTarget = runBh(["publish"]);
    expect(missingPublishTarget.exitCode).toBe(2);
    expect(missingPublishTarget.stderr.toString()).toContain(
      "usage: bh publish <project-dir>",
    );

    const unknown = runBh(["unknown"]);
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr.toString()).toContain("unknown subcommand: unknown");
  });

  test("prepare emits eval-safe URL and file assignments", () => {
    const harness = createHarness();
    const url = "https://example.test/a'b?x=1";
    const preparedUrl = runBh(["prepare", url], {
      cwd: harness.root,
      env: harness.env,
    });
    expect(preparedUrl.exitCode).toBe(0);
    expect(assignment(preparedUrl.stdout.toString(), "APP_URL")).toBe(url);

    const evaluated = Bun.spawnSync({
      cmd: [
        "bash",
        "-c",
        'eval "$1"; printf "%s" "$APP_URL"',
        "browser-harness-test",
        preparedUrl.stdout.toString(),
      ],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(evaluated.exitCode).toBe(0);
    expect(evaluated.stdout.toString()).toBe(url);

    const htmlPath = join(harness.root, "fixture page.html");
    writeFileSync(htmlPath, "<!doctype html>");
    const preparedFile = runBh(["prepare", htmlPath], {
      cwd: harness.root,
      env: harness.env,
    });
    expect(preparedFile.exitCode).toBe(0);
    expect(assignment(preparedFile.stdout.toString(), "APP_URL")).toBe(
      `file://${htmlPath}`,
    );

    const cleanedFile = runBh(["cleanup", htmlPath], {
      cwd: harness.root,
      env: harness.env,
    });
    expect(cleanedFile.exitCode).toBe(0);
    expect(cleanedFile.stderr.toString()).toContain("无 pid 文件，跳过");
  });

  test("missing agent-browser and invalid targets return exit 2", () => {
    const missingCli = runBh(["prepare", "https://example.test"], {
      env: cleanEnvironment({ PATH: "/usr/bin:/bin" }),
    });
    expect(missingCli.exitCode).toBe(2);
    expect(missingCli.stderr.toString()).toContain("未找到 agent-browser CLI");

    const harness = createHarness();
    const invalid = runBh(["prepare", join(harness.root, "missing")], {
      cwd: harness.root,
      env: harness.env,
    });
    expect(invalid.exitCode).toBe(2);
    expect(invalid.stderr.toString()).toContain("target 不是 URL");
  });

  test("profile-dir and login share the persistent profile path", () => {
    const harness = createHarness();
    const profile = runBh(["profile-dir", "tenant-a"], {
      cwd: harness.root,
      env: harness.env,
    });
    const expected = join(harness.root, "profiles", "tenant-a");
    expect(profile.exitCode).toBe(0);
    expect(profile.stdout.toString()).toBe(`${expected}\n`);

    const login = runBh(
      ["login", "https://example.test/login", "--profile", "tenant-a"],
      { cwd: harness.root, env: harness.env },
    );
    expect(login.exitCode).toBe(0);
    expect(existsSync(expected)).toBe(true);
    expect(calls(harness.callsPath)).toContainEqual([
      "open",
      "https://example.test/login",
      "--profile",
      expected,
      "--headed",
    ]);
  });

  test("default profile follows the nearest project directory", () => {
    const harness = createHarness();
    const projectDir = join(harness.root, "workspaces", "Lobe", "Admin UI");
    const nestedDir = join(projectDir, "src", "features");
    mkdirSync(join(projectDir, ".git"), { recursive: true });
    mkdirSync(nestedDir, { recursive: true });

    const expected = join(harness.root, "profiles", "lobe-admin-ui");
    const profile = runBh(["profile-dir"], {
      cwd: nestedDir,
      env: harness.env,
    });
    expect(profile.exitCode).toBe(0);
    expect(profile.stdout.toString()).toBe(`${expected}\n`);

    const login = runBh(["login", "https://example.test/login"], {
      cwd: nestedDir,
      env: harness.env,
    });
    expect(login.exitCode).toBe(0);
    expect(calls(harness.callsPath)).toContainEqual([
      "open",
      "https://example.test/login",
      "--profile",
      expected,
      "--headed",
    ]);
  });

  test("explicit and environment profiles override the project default", () => {
    const harness = createHarness();
    const projectDir = join(harness.root, "workspaces", "lobe", "admin");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "package.json"), "{}");

    const explicit = runBh(["profile-dir", "tenant-a"], {
      cwd: projectDir,
      env: harness.env,
    });
    expect(explicit.stdout.toString()).toBe(
      `${join(harness.root, "profiles", "tenant-a")}\n`,
    );

    const configured = runBh(["profile-dir"], {
      cwd: projectDir,
      env: { ...harness.env, BH_DEFAULT_PROFILE: "shared-admin" },
    });
    expect(configured.stdout.toString()).toBe(
      `${join(harness.root, "profiles", "shared-admin")}\n`,
    );
  });
});

describe("evidence collection", () => {
  test("collects and unwraps all artifacts while keeping stdout as summary JSON", () => {
    const harness = createHarness();
    const result = runBh(
      ["collect-evidence", "https://example.test/app", "--profile", "qa", "--har"],
      { cwd: harness.root, env: harness.env },
    );
    expect(result.exitCode).toBe(0);
    const summary = JSON.parse(result.stdout.toString()) as {
      profile: string;
      profile_dir: string;
      evidence_dir: string;
      counts: { network_xhr: number; network_errors: number };
      artifact_errors: string[];
    };
    expect(summary.profile).toBe("qa");
    expect(summary.profile_dir).toBe(join(harness.root, "profiles", "qa"));
    expect(summary.evidence_dir).toStartWith(
      join(realpathSync(harness.root), ".browser-harness", "evidence"),
    );
    expect(summary.counts).toEqual({ network_xhr: 2, network_errors: 1 });
    expect(summary.artifact_errors).toEqual([]);
    expect(readFileSync(join(harness.root, ".gitignore"), "utf8")).toBe(
      "/.browser-harness/\n",
    );
    expect(JSON.parse(readFileSync(join(summary.evidence_dir, "console.json"), "utf8"))).toEqual([
      { type: "warn", text: "sample" },
    ]);
    expect(readFileSync(join(summary.evidence_dir, "screenshot.png"), "utf8")).toBe(
      "fake-png",
    );
    expect(readFileSync(join(summary.evidence_dir, "network.har"), "utf8")).toBe(
      "fake-har",
    );

    const invocations = calls(harness.callsPath);
    expect(invocations).toContainEqual([
      "open",
      "https://example.test/app",
      "--profile",
      join(harness.root, "profiles", "qa"),
    ]);
    expect(invocations).toContainEqual([
      "network",
      "har",
      "start",
      "--profile",
      join(harness.root, "profiles", "qa"),
    ]);
    expect(invocations).toContainEqual([
      "screenshot",
      "--annotate",
      join(summary.evidence_dir, "screenshot.png"),
      "--profile",
      join(harness.root, "profiles", "qa"),
    ]);
  });

  test("collects the current interactive page without reopening it", () => {
    const harness = createHarness();
    const result = runBh(
      ["collect-evidence", "https://example.test/app", "--reuse-page"],
      { cwd: harness.root, env: harness.env },
    );
    expect(result.exitCode).toBe(0);
    const summary = JSON.parse(result.stdout.toString()) as {
      target: string;
      profile: string;
      profile_dir: string;
      artifact_errors: string[];
    };
    expect(summary.target).toBe("https://example.test/app");
    expect(summary.profile).toBe(projectProfileName(harness.root));
    expect(summary.profile_dir).toBe(
      join(harness.root, "profiles", summary.profile),
    );
    expect(summary.artifact_errors).toEqual([]);
    expect(calls(harness.callsPath).some((args) => args[0] === "open")).toBe(false);
  });

  test("records artifact fallbacks and hard-fails open without an evidence dir", () => {
    const harness = createHarness();
    const fallback = runBh(
      ["collect-evidence", "https://example.test/app"],
      {
        cwd: harness.root,
        env: { ...harness.env, FAKE_FAIL_CONSOLE: "1" },
      },
    );
    expect(fallback.exitCode).toBe(0);
    const fallbackSummary = JSON.parse(fallback.stdout.toString()) as {
      evidence_dir: string;
      artifact_errors: string[];
    };
    expect(fallbackSummary.artifact_errors).toEqual(["console"]);
    expect(readFileSync(join(fallbackSummary.evidence_dir, "console.json"), "utf8")).toBe(
      "[]",
    );

    rmSync(join(harness.root, ".browser-harness"), {
      recursive: true,
      force: true,
    });
    const failedOpen = runBh(
      ["collect-evidence", "https://example.test/unreachable"],
      {
        cwd: harness.root,
        env: { ...harness.env, FAKE_OPEN_FAIL: "1" },
      },
    );
    expect(failedOpen.exitCode).toBe(3);
    expect(failedOpen.stdout.toString()).toBe("");
    expect(existsSync(join(harness.root, ".browser-harness"))).toBe(false);
  });

  test("preserves .gitignore content and does not duplicate the artifact rule", () => {
    const harness = createHarness();
    const gitignorePath = join(harness.root, ".gitignore");
    writeFileSync(gitignorePath, "dist");

    const first = runBh(["collect-evidence", "https://example.test/app"], {
      cwd: harness.root,
      env: harness.env,
    });
    expect(first.exitCode).toBe(0);
    expect(readFileSync(gitignorePath, "utf8")).toBe(
      "dist\n/.browser-harness/\n",
    );

    const second = runBh(["collect-evidence", "https://example.test/app"], {
      cwd: harness.root,
      env: harness.env,
    });
    expect(second.exitCode).toBe(0);
    expect(readFileSync(gitignorePath, "utf8")).toBe(
      "dist\n/.browser-harness/\n",
    );
  });

  test("stores evidence at the nearest project root when run from a subdirectory", () => {
    const harness = createHarness();
    const projectDir = join(harness.root, "project");
    const nestedDir = join(projectDir, "src", "features");
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(join(projectDir, "package.json"), "{}");

    const result = runBh(["collect-evidence", "https://example.test/app"], {
      cwd: nestedDir,
      env: harness.env,
    });
    expect(result.exitCode).toBe(0);
    const summary = JSON.parse(result.stdout.toString()) as {
      evidence_dir: string;
    };
    expect(summary.evidence_dir).toStartWith(
      join(realpathSync(projectDir), ".browser-harness", "evidence"),
    );
    expect(readFileSync(join(projectDir, ".gitignore"), "utf8")).toBe(
      "/.browser-harness/\n",
    );
    expect(existsSync(join(nestedDir, ".browser-harness"))).toBe(false);
  });
});

describe("dev server lifecycle", () => {
  test("prepare starts a real server and cleanup removes processes and state", async () => {
    const harness = createHarness();
    const projectDir = join(harness.root, "project");
    const serverPath = join(projectDir, "server.ts");
    const serverPidPath = join(harness.root, "server.pid");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "package.json"), JSON.stringify({ name: "fixture" }));
    writeFileSync(
      serverPath,
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(serverPidPath)}, String(process.pid));
const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
console.log(\`http://localhost:\${server.port}\`);
process.on("SIGTERM", () => { server.stop(true); process.exit(0); });
process.on("SIGINT", () => { server.stop(true); process.exit(0); });
`,
    );

    const env: Record<string, string> = {
      ...harness.env,
      BH_ITERATION: "lifecycle-test",
      BH_DEV_PID_WAIT_ATTEMPTS: "10",
      BH_DEV_COMMAND: `${quoteForShell(process.execPath)} ${quoteForShell(serverPath)}`,
    };

    let devPid = 0;
    let serverPid = 0;
    try {
      const prepared = runBh(["prepare", projectDir], {
        cwd: harness.root,
        env,
      });
      if (prepared.exitCode !== 0) {
        throw new Error(
          `prepare failed with ${prepared.exitCode}:\n${prepared.stderr.toString()}`,
        );
      }
      expect(prepared.exitCode).toBe(0);
      const stdout = prepared.stdout.toString();
      const appUrl = assignment(stdout, "APP_URL");
      devPid = Number(assignment(stdout, "DEV_SERVER_PID"));
      expect(devPid).toBeGreaterThan(0);
      expect(isAlive(devPid)).toBe(true);
      expect(await (await fetch(appUrl)).text()).toBe("ok");
      serverPid = Number(readFileSync(serverPidPath, "utf8"));
      expect(serverPid).toBeGreaterThan(0);
      expect(isAlive(serverPid)).toBe(true);

      const cleaned = runBh(["cleanup", projectDir], {
        cwd: harness.root,
        env,
      });
      expect(cleaned.exitCode).toBe(0);
      expect(await waitForExit(devPid)).toBe(true);
      expect(await waitForExit(serverPid)).toBe(true);
      const stateFiles = existsSync(harness.logDir)
        ? readdirSync(harness.logDir).filter(
            (name) => name.endsWith(".pid") || name.endsWith(".label"),
          )
        : [];
      expect(stateFiles).toEqual([]);

      const cleanedAgain = runBh(["cleanup", projectDir], {
        cwd: harness.root,
        env,
      });
      expect(cleanedAgain.exitCode).toBe(0);
      expect(cleanedAgain.stderr.toString()).toContain("无 pid 文件，跳过");
    } finally {
      if (devPid > 0 && isAlive(devPid)) {
        runBh(["cleanup", projectDir], { cwd: harness.root, env });
        await waitForExit(devPid);
      }
      if (serverPid > 0 && isAlive(serverPid)) process.kill(serverPid, "SIGKILL");
    }
  }, 30_000);

  test("failed startup cleans launch state", () => {
    const harness = createHarness();
    const projectDir = join(harness.root, "failing-project");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "package.json"), JSON.stringify({ name: "fixture" }));
    const failed = runBh(["prepare", projectDir], {
      cwd: harness.root,
      env: {
        ...harness.env,
        BH_ITERATION: "failure-test",
        BH_DEV_PID_WAIT_ATTEMPTS: "2",
        BH_DEV_COMMAND: `${quoteForShell(process.execPath)} -e ${quoteForShell("process.exit(5)")}`,
      },
    });
    expect(failed.exitCode).toBe(2);
    const stateFiles = existsSync(harness.logDir)
      ? readdirSync(harness.logDir).filter(
          (name) => name.endsWith(".pid") || name.endsWith(".label"),
        )
      : [];
    expect(stateFiles).toEqual([]);
  }, 10_000);
});

describe("public tunnel lifecycle", () => {
  test("share and cleanup delegate tunnel ownership to the companion skill", async () => {
    const harness = createHarness();
    const projectDir = join(harness.root, "delegated-project");
    const serverPath = join(projectDir, "server.ts");
    const companionDir = join(harness.root, "cloudflare-quick-tunnel");
    const companionEntry = join(companionDir, "scripts", "cqt.ts");
    const companionCalls = join(harness.root, "companion-calls.jsonl");
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(dirname(companionEntry), { recursive: true });
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ name: "fixture" }),
    );
    writeFileSync(
      serverPath,
      `const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
console.log(\`http://localhost:\${server.port}/preview/\`);
process.on("SIGTERM", () => { server.stop(true); process.exit(0); });
`,
    );
    writeFileSync(
      companionEntry,
      `import { appendFileSync, mkdirSync } from "node:fs";
const args = Bun.argv.slice(2);
appendFileSync(${JSON.stringify(companionCalls)}, JSON.stringify(args) + "\\n");
const quote = (value) => "'" + String(value).replaceAll("'", "'\\\\''") + "'";
if (args[0] === "start") {
  const origin = args[1];
  const stateDir = args[args.indexOf("--state-dir") + 1];
  mkdirSync(stateDir, { recursive: true });
  const url = new URL(origin);
  const publicUrl = new URL("https://delegated.trycloudflare.com");
  publicUrl.pathname = url.pathname;
  console.log("ORIGIN_URL=" + quote(origin));
  console.log("PUBLIC_URL=" + quote(publicUrl.toString()));
  console.log("TUNNEL_PID='4242'");
  console.log("TUNNEL_LOG=" + quote(${JSON.stringify(join(harness.root, "delegated.log"))}));
  console.log("TUNNEL_STATE_DIR=" + quote(stateDir));
  process.exit(0);
}
if (args[0] === "cleanup") process.exit(0);
process.exit(2);
`,
    );

    const env: Record<string, string> = {
      ...harness.env,
      PATH: `${harness.binDir}${delimiter}/usr/bin:/bin`,
      BASE_PATH: "/preview/",
      BH_DEV_COMMAND: `${quoteForShell(process.execPath)} ${quoteForShell(serverPath)}`,
      BH_DEV_PID_WAIT_ATTEMPTS: "10",
      CLOUDFLARE_QUICK_TUNNEL_SKILL_DIR: companionDir,
    };
    let devPid = 0;
    try {
      const prepared = runBh(["prepare", projectDir], {
        cwd: harness.root,
        env,
      });
      expect(prepared.exitCode).toBe(0);
      const appUrl = assignment(prepared.stdout.toString(), "APP_URL");
      devPid = Number(assignment(prepared.stdout.toString(), "DEV_SERVER_PID"));

      const shared = runBh(["share", projectDir], {
        cwd: harness.root,
        env,
      });
      expect(shared.exitCode).toBe(0);
      expect(assignment(shared.stdout.toString(), "REMOTE_REVIEW_URL")).toBe(
        "https://delegated.trycloudflare.com/preview/",
      );
      expect(assignment(shared.stdout.toString(), "CLOUDFLARED_PID")).toBe(
        "4242",
      );

      const cleaned = runBh(["cleanup", projectDir], {
        cwd: harness.root,
        env,
      });
      expect(cleaned.exitCode).toBe(0);
      expect(await waitForExit(devPid)).toBe(true);

      const invocations = calls(companionCalls);
      expect(invocations).toHaveLength(2);
      expect(invocations[0]?.slice(0, 2)).toEqual(["start", appUrl]);
      expect(invocations[0]?.[2]).toBe("--state-dir");
      expect(invocations[1]).toEqual([
        "cleanup",
        "--state-dir",
        invocations[0]?.[3] || "",
      ]);
    } finally {
      if (devPid > 0 && isAlive(devPid)) {
        runBh(["cleanup", projectDir], { cwd: harness.root, env });
        await waitForExit(devPid);
      }
    }
  }, 30_000);

  test("share reuses prepare, publish starts both, and cleanup removes all state", async () => {
    const harness = createHarness();
    const cloudflaredCallsPath = installFakeCloudflare(harness);
    const projectDir = join(harness.root, "public-project");
    const serverPath = join(projectDir, "server.ts");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({
        name: "fixture",
        scripts: {
          dev: `${quoteForShell(process.execPath)} ${quoteForShell(serverPath)}`,
        },
      }),
    );
    writeFileSync(
      serverPath,
      `const server = Bun.serve({ port: 0, fetch: () => new Response("public-ok") });
console.log(\`http://localhost:\${server.port}\`);
process.on("SIGTERM", () => { server.stop(true); process.exit(0); });
process.on("SIGINT", () => { server.stop(true); process.exit(0); });
`,
    );

    const env: Record<string, string> = {
      ...harness.env,
      BASE_PATH: "/preview/",
      BH_ITERATION: "public-test",
      BH_DEV_PID_WAIT_ATTEMPTS: "10",
    };

    const trackedPids: number[] = [];
    try {
      const prepared = runBh(["prepare", projectDir], {
        cwd: harness.root,
        env,
      });
      expect(prepared.exitCode).toBe(0);
      const appUrl = assignment(prepared.stdout.toString(), "APP_URL");
      const firstDevPid = Number(
        assignment(prepared.stdout.toString(), "DEV_SERVER_PID"),
      );
      trackedPids.push(firstDevPid);

      const shared = runBh(["share", projectDir], {
        cwd: harness.root,
        env,
      });
      if (shared.exitCode !== 0) {
        throw new Error(`share failed:\n${shared.stderr.toString()}`);
      }
      expect(assignment(shared.stdout.toString(), "APP_URL")).toBe(appUrl);
      expect(assignment(shared.stdout.toString(), "REMOTE_REVIEW_URL")).toBe(
        "https://fixture-remote.trycloudflare.com/preview/",
      );
      const firstTunnelPid = Number(
        assignment(shared.stdout.toString(), "CLOUDFLARED_PID"),
      );
      trackedPids.push(firstTunnelPid);
      expect(isAlive(firstDevPid)).toBe(true);
      expect(isAlive(firstTunnelPid)).toBe(true);

      const invocation = JSON.parse(
        readFileSync(cloudflaredCallsPath, "utf8").trim().split("\n")[0] || "[]",
      ) as string[];
      expect(invocation).toContain("tunnel");
      expect(invocation).toContain("--config");
      expect(invocation).toContain("--url");
      expect(invocation).toContain(new URL(appUrl).origin);
      expect(invocation).toContain("--http-host-header");
      expect(invocation).toContain(new URL(appUrl).host);

      const cleanedShared = runBh(["cleanup", projectDir], {
        cwd: harness.root,
        env,
      });
      expect(cleanedShared.exitCode).toBe(0);
      expect(await waitForExit(firstTunnelPid)).toBe(true);
      expect(await waitForExit(firstDevPid)).toBe(true);

      const published = runBh(["publish", projectDir], {
        cwd: harness.root,
        env,
      });
      if (published.exitCode !== 0) {
        throw new Error(`publish failed:\n${published.stderr.toString()}`);
      }
      expect(assignment(published.stdout.toString(), "REMOTE_REVIEW_URL")).toBe(
        "https://fixture-remote.trycloudflare.com/preview/",
      );
      const publishedDevPid = Number(
        assignment(published.stdout.toString(), "DEV_SERVER_PID"),
      );
      const publishedTunnelPid = Number(
        assignment(published.stdout.toString(), "CLOUDFLARED_PID"),
      );
      trackedPids.push(publishedDevPid, publishedTunnelPid);
      expect(isAlive(publishedDevPid)).toBe(true);
      expect(isAlive(publishedTunnelPid)).toBe(true);

      const cleanedPublished = runBh(["cleanup", projectDir], {
        cwd: harness.root,
        env,
      });
      expect(cleanedPublished.exitCode).toBe(0);
      expect(await waitForExit(publishedTunnelPid)).toBe(true);
      expect(await waitForExit(publishedDevPid)).toBe(true);

      const stateFiles = existsSync(harness.logDir)
        ? readdirSync(harness.logDir).filter(
            (name) =>
              name.endsWith(".pid") ||
              name.endsWith(".label") ||
              name.endsWith(".url"),
          )
        : [];
      expect(stateFiles).toEqual([]);
    } finally {
      runBh(["cleanup", projectDir], { cwd: harness.root, env });
      for (const pid of trackedPids) {
        if (isAlive(pid)) process.kill(pid, "SIGKILL");
      }
    }
  }, 45_000);
});
