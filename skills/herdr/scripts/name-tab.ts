#!/usr/bin/env bun
import { emit, parseFlags, resolveCaller, requireHerdr, runCli, CliError, herdr, type ResourceIds } from "./lib/herdr-route";
import { codexThreadId, withCodexDaemon } from "./lib/codex-session";
import { withVerifiedCodexPane, renameVerifiedTab } from "./lib/codex-pane";

await runCli(async () => {
  const flags = parseFlags(process.argv.slice(2), ["--label"], ["--help"]);
  if (flags.has("--help")) {
    console.log("Usage: name-tab.ts --label '<label>'\nSets the label of the Herdr tab this process owns and reads it back. Ownership is OS process ancestry; only when that fails for a Codex thread under a running shared app-server, a fresh native-title challenge. The label is used verbatim: the caller decides it.");
    return;
  }
  const label = flags.get("--label");
  if (typeof label !== "string" || !label.trim() || /[\r\n]/u.test(label)) {
    throw new CliError("invalid_label", "--label must be a nonempty single line");
  }
  requireHerdr();

  // Process ancestry covers Claude Code, a Codex TUI with its in-process app-server and other
  // terminal hosts. A running daemon on the host does not mean this thread is served by it.
  let caller: ResourceIds | null = null;
  let unproven: CliError | null = null;
  try {
    caller = await resolveCaller();
  } catch (error) {
    if (!(error instanceof CliError) || !["unverified_caller", "invalid_caller"].includes(error.code)) throw error;
    unproven = error;
  }
  if (caller) {
    const proven = caller;
    const verify = async () => {
      const again = await resolveCaller();
      if (again.paneId !== proven.paneId || again.tabId !== proven.tabId || again.workspaceId !== proven.workspaceId) {
        throw new CliError("binding_conflict", "Process ownership moved to another pane; no alternate target may be selected");
      }
    };
    emit({ ok: true, tab: await renameVerifiedTab(herdr, proven, label, "process-ancestry", verify) });
    return;
  }

  // Tools of a thread served by a shared daemon do not descend from its TUI: challenge instead.
  if (!process.env.CODEX_THREAD_ID) throw unproven!;
  const id = codexThreadId(process.env);
  try {
    const tab = await withCodexDaemon(request =>
      withVerifiedCodexPane(request, id, herdr, (proved, proof, verify) => renameVerifiedTab(herdr, proved, label, proof, verify)));
    emit({ ok: true, tab });
  } catch (error) {
    if (error instanceof CliError && error.code === "codex_daemon_unavailable") throw unproven!;
    throw error;
  }
});
