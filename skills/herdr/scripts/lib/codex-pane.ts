import { ancestorPids, ownsPane } from "./caller-identity";
import { randomUUID } from "node:crypto";
import { CliError, type ResourceIds } from "./herdr-route";

type Request = (method: string, params: any) => Promise<any>;
type Herdr = (...args: string[]) => Promise<any>;

type Proof = "process-ancestry" | "native-title-challenge";
type Verify = () => Promise<void>;
const identityKeys = ["pane_id", "tab_id", "workspace_id", "terminal_id"] as const;
const samePane = (first: any, second: any) => identityKeys.every(key =>
  typeof first?.[key] === "string" && first[key].length > 0 && first[key] === second?.[key]);
const resourceIds = (pane: any): ResourceIds => ({ paneId: pane.pane_id, tabId: pane.tab_id, workspaceId: pane.workspace_id });

/** Prefer OS ancestry; a shared daemon can instead prove a live client subscription. */
export async function withVerifiedCodexPane<T>(
  request: Request, threadId: string, herdr: Herdr,
  work: (caller: ResourceIds, proof: Proof, verify: Verify) => Promise<T>,
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
  // --current is only a candidate. Neither its focus nor inherited metadata
  // establishes identity; require a foreground OS ancestor of this invocation.
  let candidate: any;
  let processProven = false;
  const processOwns = async () => ownsPane(candidate.pane_id,
    (await herdr("pane", "process-info", "--pane", candidate.pane_id))?.result?.process_info, ancestorPids());
  try {
    candidate = (await herdr("pane", "current", "--current"))?.result?.pane;
    processProven = candidate?.agent === "codex" && samePane(candidate, candidate) && await processOwns();
  } catch {
    // Initial read-only discovery may be unavailable under a shared host.
    // No proof or write exists yet; the fresh challenge remains independent.
  }
  if (processProven) {
    const verify = async () => {
      const current = (await herdr("pane", "current", "--pane", candidate.pane_id))?.result?.pane;
      if (current?.agent !== "codex" || !samePane(candidate, current) || !await processOwns() || (await readThread()).name !== original) {
        throw new CliError("binding_conflict", "Process or pane ownership changed; no alternate target may be selected");
      }
    };
    await verify();
    // No catch/fallback after proof: failures may include an uncertain write.
    return await work(resourceIds(candidate), "process-ancestry", verify);
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
    const verify = async () => {
      const current = (await herdr("pane", "current", "--pane", pane.pane_id))?.result?.pane;
      if (!matches(current) || !samePane(pane, current) || !samePane(pane, await list()) || (await readThread()).name !== marker) {
        throw new CliError("binding_conflict", "Live pane no longer proves ownership of this thread");
      }
    };
    await verify();
    return await work(resourceIds(pane), "native-title-challenge", verify);
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

export async function renameVerifiedTab(herdr: Herdr, caller: ResourceIds, label: string, proof: Proof, verify: Verify) {
  const read = async () => {
    const tab = (await herdr("tab", "get", caller.tabId!))?.result?.tab;
    if (tab?.tab_id !== caller.tabId || tab?.workspace_id !== caller.workspaceId) throw new CliError("binding_conflict", "Tab ownership changed");
    return tab;
  };
  const changed = (await read()).label !== label;
  await verify();
  if (changed) await herdr("tab", "rename", caller.tabId!, label);
  if ((await read()).label !== label) throw new CliError("verification_failed", "Herdr tab title did not match after naming");
  return { caller, label, changed, proof };
}
