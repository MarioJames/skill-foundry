#!/usr/bin/env bun
import { controlRequest } from "./worker_protocol.ts";

const [endpoint, timeoutText] = process.argv.slice(2);
if (!endpoint) process.exit(2);
let request: unknown;
try { request = await Bun.stdin.json(); } catch { process.exit(2); }
if (request === null || typeof request !== "object" || Array.isArray(request)) process.exit(2);
const item = request as Record<string, unknown>;
const command = item.command;
if (typeof command !== "string") process.exit(2);
delete item.command;
try {
  const response = await controlRequest(endpoint, command, item, Number(timeoutText ?? 2));
  process.stdout.write(JSON.stringify(response));
} catch {
  process.exit(1);
}
