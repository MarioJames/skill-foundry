import {
  BH_MIN_AGENT_BROWSER_VERSION,
  fail,
  findExecutable,
  warn,
} from "./common.ts";

export function versionAtLeast(actual: string, minimum: string): boolean {
  const parse = (value: string): number[] =>
    value
      .split(".", 3)
      .map((part) => Number.parseInt(part, 10))
      .map((part) => (Number.isFinite(part) ? part : 0));

  const left = parse(actual);
  const right = parse(minimum);
  for (let index = 0; index < 3; index += 1) {
    const a = left[index] || 0;
    const b = right[index] || 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return true;
}

export function requireAgentBrowser(): void {
  if (!findExecutable("agent-browser")) {
    fail(
      2,
      "未找到 agent-browser CLI；请按 https://github.com/vercel-labs/agent-browser 安装并运行 'agent-browser install' 拉取 Chrome for Testing",
    );
  }

  let version = "";
  try {
    const result = Bun.spawnSync({
      cmd: ["agent-browser", "--version"],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    version = (result.stdout?.toString() || "").trim().split(/\s+/)[1] || "";
  } catch {
    // 版本探测失败不阻断，与旧运行时保持一致。
  }

  if (version && !versionAtLeast(version, BH_MIN_AGENT_BROWSER_VERSION)) {
    warn(
      `agent-browser ${version} 低于技能适配下限 ${BH_MIN_AGENT_BROWSER_VERSION}，` +
        "证据采集契约（--json 信封 / screenshot 位置参数）可能不匹配；建议执行 agent-browser upgrade",
    );
  }
}
