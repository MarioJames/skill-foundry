#!/usr/bin/env bun

import {
  CQT_VERSION,
  CqtError,
  cleanupTunnel,
  getTunnelStatus,
  log,
  resolveStateDir,
  shellQuote,
  startTunnel,
  stopTunnel,
  type TunnelStatus,
} from "./lib/lifecycle.ts";

function usage(): void {
  process.stderr.write(`usage: cqt <subcommand> [args]

subcommands:
  start <origin-url> [--state-dir <dir>]  启动并输出公网 URL
  status [--state-dir <dir>]              查询精确 PID 与状态
  stop [--state-dir <dir>]                停止 tunnel，保留日志
  cleanup [--state-dir <dir>]             停止并清理本技能状态/日志
  --version
`);
}

interface ParsedOptions {
  origin: string;
  stateDir: string;
}

function fail(exitCode: number, message: string): never {
  throw new CqtError(exitCode, message);
}

function parseOptions(
  command: "start" | "status" | "stop" | "cleanup",
  arguments_: string[],
): ParsedOptions {
  let origin = "";
  let stateDirValue = "";

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index] || "";
    if (argument === "--state-dir") {
      const value = arguments_[index + 1];
      if (value === undefined) fail(2, "--state-dir 缺少值");
      stateDirValue = value;
      index += 1;
      continue;
    }
    if (argument === "-h" || argument === "--help") {
      usage();
      throw new CqtError(1, "");
    }
    if (argument.startsWith("-")) fail(2, `未知 flag: ${argument}`);
    if (command !== "start") fail(2, `意外参数：${argument}`);
    if (!origin) origin = argument;
    else fail(2, `意外参数：${argument}`);
  }

  if (command === "start" && !origin) {
    fail(2, "usage: cqt start <origin-url> [--state-dir <dir>]");
  }
  return { origin, stateDir: resolveStateDir(stateDirValue) };
}

function emitAssignment(name: string, value: string | number): void {
  process.stdout.write(`${name}=${shellQuote(String(value))}\n`);
}

function emitStatus(status: TunnelStatus): void {
  emitAssignment("TUNNEL_STATUS", status.status);
  emitAssignment("TUNNEL_STATE_DIR", status.stateDir);
  if (status.pid !== null) emitAssignment("TUNNEL_PID", status.pid);
  if (status.originUrl) emitAssignment("ORIGIN_URL", status.originUrl);
  if (status.publicUrl) emitAssignment("PUBLIC_URL", status.publicUrl);
  if (status.logPath) emitAssignment("TUNNEL_LOG", status.logPath);
}

async function main(arguments_ = Bun.argv.slice(2)): Promise<number> {
  const [subcommand, ...rest] = arguments_;
  switch (subcommand) {
    case undefined:
    case "":
    case "-h":
    case "--help":
      usage();
      return 1;
    case "--version":
      process.stdout.write(`cloudflare-quick-tunnel ${CQT_VERSION}\n`);
      return 0;
    case "start": {
      const options = parseOptions("start", rest);
      const tunnel = await startTunnel(options.origin, options.stateDir);
      emitAssignment("ORIGIN_URL", tunnel.originUrl);
      emitAssignment("PUBLIC_URL", tunnel.publicUrl);
      emitAssignment("TUNNEL_PID", tunnel.pid);
      emitAssignment("TUNNEL_LOG", tunnel.logPath);
      emitAssignment("TUNNEL_STATE_DIR", tunnel.stateDir);
      return 0;
    }
    case "status": {
      const options = parseOptions("status", rest);
      emitStatus(getTunnelStatus(options.stateDir));
      return 0;
    }
    case "stop": {
      const options = parseOptions("stop", rest);
      await stopTunnel(options.stateDir);
      emitStatus(getTunnelStatus(options.stateDir));
      return 0;
    }
    case "cleanup": {
      const options = parseOptions("cleanup", rest);
      await cleanupTunnel(options.stateDir);
      emitStatus(getTunnelStatus(options.stateDir));
      return 0;
    }
    default:
      process.stderr.write(`[cqt][error] unknown subcommand: ${subcommand}\n`);
      usage();
      return 1;
  }
}

if (import.meta.main) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      if (error instanceof CqtError) {
        if (error.message) process.stderr.write(`[cqt][error] ${error.message}\n`);
        process.exitCode = error.exitCode;
      } else {
        process.stderr.write(
          `[cqt][error] ${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exitCode = 1;
      }
    });
}
