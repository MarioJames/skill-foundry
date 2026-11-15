#!/usr/bin/env bun
import { emit, parseFlags, resolveCaller, requireHerdr, runCli, CliError, herdr } from "./lib/herdr-route";
import { codexThreadId, withCodexDaemon } from "./lib/codex-session";
import { withVerifiedCodexPane, renameVerifiedTab } from "./lib/codex-pane";

await runCli(async () => {
  const flags = parseFlags(process.argv.slice(2), ["--label"], ["--help"]);
  if (flags.has("--help")) {
    console.log("Usage: name-tab.ts --label '<label>'\nSets the label of the Herdr tab this process owns, proven by OS process ancestry or, for a Codex thread under a shared app-server, a fresh native-title challenge; reads it back. The label is used verbatim: the caller decides it.");
    return;
  }
  const label = flags.get("--label");
  if (typeof label !== "string" || !label.trim() || /[\r\n]/u.test(label)) {
    throw new CliError("invalid_label", "--label must be a nonempty single line");
  }
  requireHerdr();
  if (process.env.CODEX_THREAD_ID) {
    const id = codexThreadId(process.env);
    try {
      const tab = await withCodexDaemon(request =>
        withVerifiedCodexPane(request, id, herdr, (caller, proof, verify) => renameVerifiedTab(herdr, caller, label, proof, verify)));
      emit({ ok: true, tab });
      return;
    } catch (error) {
      // Without a daemon the thread runs in its own TUI process: process ancestry below applies.
      if (!(error instanceof CliError) || error.code !== "codex_daemon_unavailable") throw error;
    }
  }
  const caller = await resolveCaller();
  const verify = async () => {
    const again = await resolveCaller();
    if (again.paneId !== caller.paneId || again.tabId !== caller.tabId || again.workspaceId !== caller.workspaceId) {
      throw new CliError("binding_conflict", "Process ownership moved to another pane; no alternate target may be selected");
    }
  };
  emit({ ok: true, tab: await renameVerifiedTab(herdr, caller, label, "process-ancestry", verify) });
});
