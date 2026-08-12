#!/usr/bin/env bun

import { parseCli, formatUsageError, CliUsageError, type ParsedCommand } from "./cli.ts";
import { runCommand } from "./commands.ts";
import * as db from "./db.ts";
import { jsonDumps } from "./json-utils.ts";
import { redactSecrets } from "./redact.ts";
import { redactPersistedEvidence } from "./rounds.ts";

export function emit(payload: Record<string, unknown>): void {
  console.log(redactSecrets(jsonDumps(payload)));
}

export function main(argv: string[] = Bun.argv.slice(2)): number {
  let parsed: ParsedCommand | { help: string };
  try {
    parsed = parseCli(argv);
  } catch (error) {
    if (error instanceof CliUsageError) {
      console.error(formatUsageError(error));
      return 2;
    }
    throw error;
  }
  if ("help" in parsed) {
    console.log(parsed.help);
    return 0;
  }
  let connection: db.Connection | undefined;
  try {
    connection = db.connect();
    redactPersistedEvidence(connection);
    const result = runCommand(connection, parsed);
    emit(result.payload);
    return result.exitCode ?? 0;
  } catch (error) {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    return 1;
  } finally {
    connection?.close();
  }
}

if (import.meta.main) {
  process.exitCode = main();
}
