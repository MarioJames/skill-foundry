import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BhError,
  fail,
  log,
  logDir,
  projectKey,
} from "./common.ts";

const BROWSER_HARNESS_SKILL_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

export interface QuickTunnelInfo {
  publicUrl: string;
  pid: number;
  logPath: string;
}

function companionEntry(): string {
  const configured = process.env.CLOUDFLARE_QUICK_TUNNEL_SKILL_DIR;
  if (configured) {
    const entry = join(configured, "scripts", "cqt.ts");
    if (!existsSync(entry)) {
      fail(
        2,
        `CLOUDFLARE_QUICK_TUNNEL_SKILL_DIR 中未找到 scripts/cqt.ts：${configured}`,
      );
    }
    return entry;
  }

  const skillRoot = dirname(BROWSER_HARNESS_SKILL_DIR);
  const candidates = [
    join(skillRoot, "cloudflare-quick-tunnel", "scripts", "cqt.ts"),
    join(
      process.env.HOME || "",
      ".agents",
      "skills",
      "cloudflare-quick-tunnel",
      "scripts",
      "cqt.ts",
    ),
    join(
      process.env.HOME || "",
      ".codex",
      "skills",
      "cloudflare-quick-tunnel",
      "scripts",
      "cqt.ts",
    ),
    join(
      process.env.HOME || "",
      ".claude",
      "skills",
      "cloudflare-quick-tunnel",
      "scripts",
      "cqt.ts",
    ),
    join(
      process.env.HOME || "",
      ".cc-switch",
      "skills",
      "cloudflare-quick-tunnel",
      "scripts",
      "cqt.ts",
    ),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  fail(
    2,
    "未找到 cloudflare-quick-tunnel 伴生技能；请安装后再执行 share/publish",
  );
}

function parseAssignmentValue(line: string): [string, string] | null {
  const matched = line.match(/^([A-Z][A-Z0-9_]*)=('(?:[^']|'\\'')*')$/);
  if (!matched) return null;
  const name = matched[1] || "";
  const quoted = matched[2] || "";
  return [name, quoted.slice(1, -1).replaceAll("'\\''", "'")];
}

function runCompanion(arguments_: string[]): Record<string, string> {
  const entry = companionEntry();
  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    result = Bun.spawnSync({
      cmd: [process.execPath, entry, ...arguments_],
      cwd: process.cwd(),
      env: process.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    fail(
      2,
      `无法执行 cloudflare-quick-tunnel：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const stderr = result.stderr?.toString() || "";
  if (stderr) process.stderr.write(stderr);
  const exitCode = result.exitCode ?? 1;
  if (exitCode !== 0) {
    throw new BhError(
      exitCode,
      `cloudflare-quick-tunnel ${arguments_[0] || "command"} 失败（exit ${exitCode}）`,
    );
  }

  const assignments: Record<string, string> = {};
  for (const line of (result.stdout?.toString() || "").split("\n")) {
    if (!line) continue;
    const parsed = parseAssignmentValue(line);
    if (!parsed) fail(2, `cloudflare-quick-tunnel 输出不是安全赋值：${line}`);
    assignments[parsed[0]] = parsed[1];
  }
  return assignments;
}

export function quickTunnelStateDir(projectDir: string): string {
  return join(logDir(), "cloudflare-quick-tunnel", projectKey(projectDir));
}

export function startQuickTunnel(
  projectDir: string,
  appUrl: string,
): QuickTunnelInfo {
  const assignments = runCompanion([
    "start",
    appUrl,
    "--state-dir",
    quickTunnelStateDir(projectDir),
  ]);
  const publicUrl = assignments.PUBLIC_URL || "";
  const logPath = assignments.TUNNEL_LOG || "";
  const pid = Number(assignments.TUNNEL_PID || "");
  if (
    !publicUrl ||
    !logPath ||
    !Number.isSafeInteger(pid) ||
    pid <= 0
  ) {
    fail(2, "cloudflare-quick-tunnel start 缺少 PUBLIC_URL/PID/LOG 输出");
  }
  return { publicUrl, pid, logPath };
}

export function cleanupQuickTunnel(projectDir: string): void {
  const stateDir = quickTunnelStateDir(projectDir);
  if (!existsSync(stateDir)) {
    log("无 Quick Tunnel 状态目录，跳过");
    return;
  }
  runCompanion(["cleanup", "--state-dir", stateDir]);
}
