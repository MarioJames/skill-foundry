#!/usr/bin/env bun
// Names the current conversation `MMDD｜TYPE｜Topic` on its host and reads it back;
// then names its Herdr tab through the herdr skill installed alongside, when there is one.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  claudeSessionCreatedAt,
  codexThreadId,
  NamingError,
  nameCodexThread,
  nameLobehubTopic,
  sessionLabel,
  SESSION_TYPES,
  withCodexDaemon,
  type Lh,
  type TargetResult,
} from "./lib/session-name";

const HELP = `用法: bun name-session.ts --type <${SESSION_TYPES.join("|")}> --topic '<主题>' [--dry-run]

按 MMDD｜TYPE｜Topic 命名当前会话，日期取会话 createdAt 的 Asia/Shanghai 日期，写后读回核对。
目标按宿主选择，stdout 输出 JSON（label、targets）：
  LobeHub   有 LOBEHUB_TOPIC_ID 与 LOBEHUB_OPERATION_ID，且话题的 runningOperation 是本次运行时改话题标题；
            否则记为 skipped（继承的环境、群组成员、已结束的运行），继续判断下面的宿主
  Codex     有 CODEX_THREAD_ID 且本机 Codex daemon 在运行时改原生线程标题；不启动 daemon
  Claude    有 CLAUDE_CODE_SESSION_ID 时只从会话记录取 createdAt，Claude Code 没有可写的标题接口
不在自己的 LobeHub 话题里、且有 HERDR_PANE_ID 时，再调用同级 herdr 的 name-tab.ts 命名可证明归属的标签页。
  --dry-run  只读取并给出将设置的标题，不写入`;

const HERDR_TAB_SCRIPT = join(dirname(import.meta.dir), "..", "herdr", "scripts", "name-tab.ts");

function parseArgs(argv: string[]) {
  const options = { type: "", topic: "", dryRun: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--type" || arg === "--topic") {
      const value = argv[index + 1];
      if (value === undefined) throw new NamingError("missing_value", `${arg} 需要值`);
      options[arg === "--type" ? "type" : "topic"] = value;
      index += 1;
    } else throw new NamingError("unknown_option", `未知参数: ${arg}`);
  }
  if (!options.help && (!options.type || !options.topic)) throw new NamingError("missing_argument", "--type 和 --topic 必填");
  return options;
}

async function capture(cmd: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", env: process.env });
  const [stdout, stderr, status] = await Promise.all([
    Bun.readableStreamToText(child.stdout),
    Bun.readableStreamToText(child.stderr),
    child.exited,
  ]);
  return { status, stdout: stdout.trim(), stderr: stderr.trim() };
}

const lh: Lh = async (...args) => {
  const result = await capture(["lh", ...args]);
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `lh exited ${result.status}`);
  return result.stdout;
};

async function nameHerdrTab(label: string): Promise<TargetResult> {
  const result = await capture(["bun", HERDR_TAB_SCRIPT, "--label", label]);
  try {
    const json = JSON.parse(result.stdout);
    if (json.ok) return { target: "herdr-tab", status: json.tab?.changed ? "named" : "unchanged", ...json.tab };
    return { target: "herdr-tab", status: "failed", error: json.error ?? json.tab?.error ?? json };
  } catch {
    return { target: "herdr-tab", status: "failed", error: result.stderr || result.stdout };
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return;
  }
  const env = process.env;
  const targets: TargetResult[] = [];
  let label: string | null = null;

  const topic = await nameLobehubTopic(lh, env, options.type, options.topic, options.dryRun);
  if (topic) targets.push(topic);
  const ownsTopic = topic !== null && topic.status !== "skipped";

  if (ownsTopic) {
    // A LobeHub run's conversation is its topic. The terminal hosting the LobeHub daemon is not this conversation.
    label = topic.label as string;
  } else {
    const threadId = codexThreadId(env);
    if (threadId) {
      try {
        const thread = await withCodexDaemon((request) => nameCodexThread(request, threadId, options.type, options.topic, options.dryRun));
        targets.push(thread);
        label = thread.label as string;
      } catch (error) {
        if (!(error instanceof NamingError) || error.code !== "codex_daemon_unavailable") throw error;
        targets.push({ target: "codex-thread", status: "skipped", reason: error.code, message: error.message });
      }
    }
    if (!label) {
      const createdAt = claudeSessionCreatedAt(env, homedir());
      if (createdAt !== null) {
        label = sessionLabel(createdAt, options.type, options.topic);
        targets.push({ target: "claude-code", status: "skipped", reason: "no_title_api", label, createdAt: new Date(createdAt).toISOString() });
      }
    }
    if (label && !options.dryRun && env.HERDR_PANE_ID && existsSync(HERDR_TAB_SCRIPT) && Bun.which("herdr")) {
      targets.push(await nameHerdrTab(label));
    }
  }

  const named = targets.some((item) => item.status === "named" || item.status === "unchanged");
  console.log(JSON.stringify({
    ok: true,
    label,
    named,
    targets,
    ...(named || options.dryRun ? {} : { note: "没有可写且归属本次运行的会话标题；保留原标题并在回复里说明" }),
  }));
}

try {
  await main();
} catch (error) {
  const failure = error instanceof NamingError ? error : new NamingError("internal_error", error instanceof Error ? error.message : String(error));
  console.log(JSON.stringify({ ok: false, error: { code: failure.code, message: failure.message } }));
  process.exitCode = 1;
}
