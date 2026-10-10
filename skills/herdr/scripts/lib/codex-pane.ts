import { randomUUID } from "node:crypto";
import { CliError, type ResourceIds } from "./herdr-route";

type Request = (method: string, params: any) => Promise<any>;
type Herdr = (...args: string[]) => Promise<any>;

/** Prove a live client subscription, not a title similarity or inherited ID. */
export async function withVerifiedCodexPane<T>(
  request: Request, threadId: string, herdr: Herdr,
  work: (caller: ResourceIds) => Promise<T>,
  sleep: (ms: number) => Promise<unknown> = Bun.sleep,
): Promise<T> {
  const readThread = async () => {
    const thread = (await request("thread/read", { threadId, includeTurns: false }))?.thread;
    if (thread?.id !== threadId) throw new CliError("thread_mismatch", "Cannot verify current thread");
    return thread;
  };
  const original = (await readThread()).name;
  if (typeof original !== "string" || !original) {
    throw new CliError("missing_thread_name", "Set the native task name before binding its pane");
  }
  // Check availability before touching a title. Never consume agent_session here:
  // SessionStart hooks can themselves report a daemon-inherited, incorrect pane.
  await herdr("agent", "list");
  const marker = `herdr-bind-${randomUUID()}`;
  const matches = (pane: any) => pane?.agent === "codex" && (
    pane.terminal_title_stripped === marker ||
    pane.terminal_title_stripped?.startsWith(`${marker} | `)
  );
  const list = async () => {
    const agents = (await herdr("agent", "list"))?.result?.agents;
    if (!Array.isArray(agents)) throw new CliError("invalid_agents", "Herdr did not return its agent list");
    const found = agents.filter(matches);
    if (found.length > 1) throw new CliError("ambiguous_caller", "Multiple panes display this thread; no tab was selected");
    return found[0];
  };
  try {
    await request("thread/name/set", { threadId, name: marker });
    if ((await readThread()).name !== marker) throw new CliError("binding_conflict", "Native title changed during binding");
    let pane: any;
    for (let attempt = 0; attempt < 30; attempt++) {
      pane = await list();
      if (pane) break;
      await sleep(100);
    }
    if (!pane) throw new CliError("unverified_caller", "No Codex client echoed this thread's fresh binding marker; no tab was changed");
    // Allow other subscribed clients to echo, then reject ambiguous/moved panes.
    await sleep(500);
    const settled = await list();
    if (!settled || ["pane_id", "tab_id", "workspace_id", "terminal_id"].some(key => !pane[key] || settled[key] !== pane[key])) {
      throw new CliError("binding_conflict", "Pane ownership changed during binding");
    }
    const current = (await herdr("pane", "current", "--pane", pane.pane_id))?.result?.pane;
    if (!matches(current) || ["pane_id", "tab_id", "workspace_id", "terminal_id"].some(key => current[key] !== pane[key]) || (await readThread()).name !== marker) {
      throw new CliError("binding_conflict", "Live pane no longer proves ownership of this thread");
    }
    return await work({ paneId: pane.pane_id, tabId: pane.tab_id, workspaceId: pane.workspace_id });
  } finally {
    // Restore only our marker. Never overwrite a concurrent user's title edit.
    const name = (await readThread()).name;
    if (name === marker) {
      await request("thread/name/set", { threadId, name: original });
      if ((await readThread()).name !== original) throw new CliError("title_restore_failed", "Native title restoration did not verify");
    } else if (name !== original) {
      throw new CliError("binding_conflict", "Another writer changed the native title; its edit was preserved");
    }
  }
}

export async function renameVerifiedTab(herdr: Herdr, caller: ResourceIds, label: string) {
  const read = async () => {
    const tab = (await herdr("tab", "get", caller.tabId!))?.result?.tab;
    if (tab?.tab_id !== caller.tabId || tab?.workspace_id !== caller.workspaceId) throw new CliError("binding_conflict", "Tab ownership changed");
    return tab;
  };
  const changed = (await read()).label !== label;
  if (changed) await herdr("tab", "rename", caller.tabId!, label);
  if ((await read()).label !== label) throw new CliError("verification_failed", "Herdr tab title did not match after naming");
  return { caller, label, changed, proof: "native-title-challenge" };
}
