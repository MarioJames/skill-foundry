#!/usr/bin/env bun

/** Probe an explicitly selected ACP Agent through the official TypeScript SDK. */

import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

import { createAcpClient } from "../scripts/backends/acp/client.ts";
import { processGroupAlive, terminateProcessGroup } from "../scripts/backends/acp/processes.ts";
import type { RuntimeRecord } from "../scripts/runtime_types.ts";

interface Options {
  command: string;
  commandArgs: string[];
  cwd: string;
}

function parseArguments(argv: string[]): Options {
  const options: Options = { command: "", commandArgs: [], cwd: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]!;
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${name} requires a value`);
    if (name === "--command") options.command = value;
    else if (name === "--command-arg") options.commandArgs.push(value);
    else if (name === "--cwd") options.cwd = value;
    else throw new Error(`unknown argument: ${name}`);
    index += 1;
  }
  if (!options.command || !options.cwd) throw new Error("--command and --cwd are required");
  return options;
}

function safeError(error: unknown): RuntimeRecord {
  const record: RuntimeRecord = { type: error instanceof Error ? error.name : "Error" };
  if (error !== null && typeof error === "object" && Number.isInteger((error as RuntimeRecord).code)) {
    record.code = Number((error as RuntimeRecord).code);
  }
  return record;
}

async function withTimeout<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("TimeoutError")), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function probe(options: Options): Promise<RuntimeRecord> {
  const updates: RuntimeRecord[] = [];
  const report: RuntimeRecord = { ok: false };
  let child: ChildProcess | null = null;
  let connection: acp.ClientConnection | null = null;
  try {
    child = spawn(options.command, options.commandArgs, {
      cwd: options.cwd,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (!child.stdin || !child.stdout) throw new Error("ACP Agent did not expose stdio streams");
    const app = createAcpClient(
      () => ({ selectedOptionId: null, allowed: false }),
      (notification) => {
        updates.push({
          sessionId: notification.sessionId,
          type: notification.update.sessionUpdate,
        });
      },
    );
    connection = app.connect(acp.ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    ));
    const context = connection.agent;
    const initialized = await withTimeout(context.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "agents-orchestrator-handshake", version: "1" },
    }), 30_000);
    report.initialized = {
      protocolVersion: initialized.protocolVersion,
      agentInfo: initialized.agentInfo ?? null,
      agentCapabilities: initialized.agentCapabilities ?? null,
      authMethods: initialized.authMethods ?? [],
    };
    const session = await withTimeout(context.request(acp.methods.agent.session.new, {
      cwd: options.cwd,
      mcpServers: [],
    }), 30_000);
    report.sessionId = session.sessionId;
    report.configOptions = session.configOptions ?? [];
    const prompted = await withTimeout(context.request(acp.methods.agent.session.prompt, {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "Reply with hello. Do not use tools." }],
    }), 90_000);
    report.prompt = prompted;
    report.ok = true;
  } catch (error) {
    report.error = safeError(error);
  } finally {
    report.updates = updates;
    try { connection?.close(); } catch { report.connectionClose = false; }
    const pid = child?.pid;
    const cleaned = pid ? terminateProcessGroup(pid, { graceSeconds: 3, trusted: true }) : true;
    if (child?.stdin) child.stdin.destroy();
    if (child?.stderr) {
      const chunks: Buffer[] = [];
      child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
      await Promise.race([
        new Promise<void>((resolve) => child!.stderr!.once("close", () => resolve())),
        Bun.sleep(500),
      ]);
      report.stderrBytes = Buffer.concat(chunks).byteLength;
    }
    report.cleanup = { processGroupAbsent: Boolean(cleaned && (!pid || !processGroupAlive(pid))) };
    if (!(report.cleanup as RuntimeRecord).processGroupAbsent) report.ok = false;
  }
  return report;
}

if (import.meta.main) {
  try {
    const report = await probe(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exit(report.ok ? 0 : 1);
  } catch (error) {
    process.stderr.write(`manual_acp_handshake.ts: ${error instanceof Error ? error.message : "invalid arguments"}\n`);
    process.exit(2);
  }
}
