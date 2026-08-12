#!/usr/bin/env bun

import { mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { requireAgentBrowser } from "./lib/agent-browser-runtime.ts";
import {
  BH_VERSION,
  BhError,
  fail,
  log,
  profileDir,
  shellQuote,
} from "./lib/common.ts";
import {
  resolveDevCommand,
  startDevServer,
  stopDevServer,
} from "./lib/dev-server.ts";
import { collectEvidence } from "./lib/evidence.ts";
import { resolveTarget } from "./lib/target-resolve.ts";

function usage(): void {
  process.stderr.write(`usage: bh <subcommand> [args]

subcommands:
  prepare <target>                          target = URL | *.html | project dir
  cleanup [target]                          默认 . ；传 prepare 使用的同一 target
  login <url> [--profile <name>]
  collect-evidence <url> [--profile <n>] [--har] [--reuse-page]
  profile-dir [name]                        打印 profile 目录路径（供直接调 agent-browser）
  --version
`);
}

interface BrowserOptions {
  url: string;
  profile: string;
  har: boolean;
  reusePage: boolean;
}

function parseBrowserOptions(
  subcommand: "login" | "collect-evidence",
  arguments_: string[],
): BrowserOptions {
  let url = "";
  let profile = "";
  let har = false;
  let reusePage = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index] || "";
    if (argument === "--profile") {
      const value = arguments_[index + 1];
      if (value === undefined) fail(2, "--profile 缺少值");
      profile = value;
      index += 1;
      continue;
    }
    if (argument === "--har" && subcommand === "collect-evidence") {
      har = true;
      continue;
    }
    if (argument === "--reuse-page" && subcommand === "collect-evidence") {
      reusePage = true;
      continue;
    }
    if (argument === "-h" || argument === "--help") {
      process.stderr.write(
        subcommand === "login"
          ? "usage: bh login <url> [--profile <name>]\n"
          : "usage: bh collect-evidence <url> [--profile <n>] [--har] [--reuse-page]\n",
      );
      throw new BhError(1, "");
    }
    if (argument === "--") {
      for (const positional of arguments_.slice(index + 1)) {
        if (!url) url = positional;
        else fail(2, `意外参数：${positional}`);
      }
      break;
    }
    if (argument.startsWith("-")) fail(2, `未知 flag: ${argument}`);
    if (!url) url = argument;
    else fail(2, `意外参数：${argument}`);
  }

  if (!url) {
    fail(
      2,
      subcommand === "login"
        ? "usage: bh login <url> [--profile <name>]"
        : "usage: bh collect-evidence <url> [--profile <n>] [--har] [--reuse-page]",
    );
  }
  return { url, profile, har, reusePage };
}

async function prepare(arguments_: string[]): Promise<number> {
  const target = arguments_[0];
  if (!target) fail(2, "usage: bh prepare <target>");

  // prepare 后续的 login/collect 都依赖该 CLI，保持旧入口的前置检查顺序。
  requireAgentBrowser();
  const resolved = resolveTarget(target);
  if (resolved.kind === "url" || resolved.kind === "file") {
    process.stdout.write(`APP_URL=${shellQuote(resolved.url)}\n`);
    return 0;
  }

  const devCommand = resolveDevCommand(resolved.dir);
  const server = await startDevServer(
    process.env.BH_ITERATION || "default",
    resolved.dir,
    devCommand,
  );
  process.stdout.write(`APP_URL=${shellQuote(server.appUrl)}\n`);
  process.stdout.write(`DEV_SERVER_PID=${shellQuote(String(server.pid))}\n`);
  process.stdout.write(`DEV_SERVER_LOG=${shellQuote(server.logPath)}\n`);
  return 0;
}

async function cleanup(arguments_: string[]): Promise<number> {
  const target = arguments_[0] || ".";
  let absolute: string;
  try {
    absolute = resolve(target);
    const stat = statSync(absolute);
    if (stat.isFile()) absolute = dirname(absolute);
    else if (!stat.isDirectory()) throw new Error("unsupported target type");
  } catch {
    fail(2, `cleanup 的 target 不存在或不受支持：${target}`);
  }
  await stopDevServer(absolute);
  return 0;
}

async function login(arguments_: string[]): Promise<number> {
  const options = parseBrowserOptions("login", arguments_);
  requireAgentBrowser();
  const path = profileDir(options.profile);
  mkdirSync(path, { recursive: true });
  log(`profile 存储目录：${path}`);
  log(
    "headed 启动 agent-browser，请在浏览器里完成登录；登录成功后关闭窗口或保持打开均可，profile 会自动持久化",
  );

  try {
    const child = Bun.spawn(
      ["agent-browser", "open", options.url, "--profile", path, "--headed"],
      {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    return await child.exited;
  } catch {
    return 127;
  }
}

async function collect(arguments_: string[]): Promise<number> {
  const options = parseBrowserOptions("collect-evidence", arguments_);
  await collectEvidence(
    options.url,
    options.profile,
    options.har,
    "evidence",
    options.reusePage,
  );
  return 0;
}

export async function main(arguments_ = Bun.argv.slice(2)): Promise<number> {
  const [subcommand, ...rest] = arguments_;
  switch (subcommand) {
    case undefined:
    case "":
    case "-h":
    case "--help":
      usage();
      return 1;
    case "--version":
      process.stdout.write(`browser-harness ${BH_VERSION}\n`);
      return 0;
    case "prepare":
      return await prepare(rest);
    case "cleanup":
      return await cleanup(rest);
    case "login":
      return await login(rest);
    case "collect-evidence":
      return await collect(rest);
    case "profile-dir":
      process.stdout.write(`${profileDir(rest[0] || "")}\n`);
      return 0;
    default:
      process.stderr.write(`[bh][error] unknown subcommand: ${subcommand}\n`);
      usage();
      return 1;
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    if (error instanceof BhError) {
      if (error.message) process.stderr.write(`[bh][error] ${error.message}\n`);
      process.exitCode = error.exitCode;
    } else {
      process.stderr.write(
        `[bh][error] ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    }
  }
}
