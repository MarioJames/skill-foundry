#!/usr/bin/env bun
import { emit, parseFlags, runCli, CliError } from "./lib/herdr-route";
import { codexThreadId, nameCodexSession, withCodexDaemon } from "./lib/codex-session";

await runCli(async () => {
  const flags = parseFlags(process.argv.slice(2), ["--type", "--topic"], ["--dry-run", "--help"]);
  if (flags.has("--help")) {
    console.log("Usage: name-codex-session.ts --type FIX --topic '具体任务' [--dry-run]\nNames only CODEX_THREAD_ID through the existing daemon; never targets a Herdr tab.");
    return;
  }
  const type = flags.get("--type"); const topic = flags.get("--topic");
  if (typeof type !== "string" || typeof topic !== "string") throw new CliError("missing_argument", "--type and --topic are required");
  const id = codexThreadId(process.env);
  emit({ ok: true, ...await withCodexDaemon(request => nameCodexSession(request, id, type, topic, flags.has("--dry-run"))) });
});
