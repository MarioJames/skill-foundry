#!/usr/bin/env bun
import { emit, parseFlags, runCli, CliError, herdr } from "./lib/herdr-route";
import { codexThreadId, nameCodexSession, withCodexDaemon } from "./lib/codex-session";
import { withVerifiedCodexPane, renameVerifiedTab } from "./lib/codex-pane";

await runCli(async () => {
  const flags = parseFlags(process.argv.slice(2), ["--type", "--topic"], ["--dry-run", "--native-only", "--help"]);
  if (flags.has("--help")) {
    console.log("Usage: name-codex-session.ts --type FIX --topic '具体任务' [--dry-run] [--native-only]\nNames CODEX_THREAD_ID and verifies its Herdr tab through a temporary native-title challenge. Dry-run never writes or claims tab ownership.");
    return;
  }
  const type = flags.get("--type"); const topic = flags.get("--topic");
  if (typeof type !== "string" || typeof topic !== "string") throw new CliError("missing_argument", "--type and --topic are required");
  const id = codexThreadId(process.env);
  await withCodexDaemon(async request => {
    const native = await nameCodexSession(request, id, type, topic, flags.has("--dry-run"));
    if (flags.has("--dry-run") || flags.has("--native-only")) {
      emit({ ok: true, ...native, tab: { status: "not-verified" } });
      return;
    }
    try {
      const tab = await withVerifiedCodexPane(request, id, herdr, caller => renameVerifiedTab(herdr, caller, native.label));
      emit({ ok: true, ...native, tab });
    } catch (error) {
      emit({ ok: false, native, tab: { status: "failed", error: error instanceof Error ? error.message : String(error) } });
      process.exitCode = 1;
    }
  });
});
