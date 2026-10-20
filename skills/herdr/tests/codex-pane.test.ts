import { expect, test } from "bun:test";
import { withVerifiedCodexPane, renameVerifiedTab } from "../scripts/lib/codex-pane";

const threadId = "current-thread";
const label = "1010｜FIX｜会话绑定";
function fixture(options: { noEcho?: boolean; duplicate?: boolean; moved?: boolean; renameFails?: boolean; concurrentEdit?: boolean; candidate?: "missing" | "incomplete" | "shell" | "error"; sameLabel?: boolean; replacedIdentity?: string; processOwned?: boolean; processLost?: boolean; movedBeforeWrite?: boolean; challengeAckFails?: boolean } = {}) {
  let nativeName = label;
  let tabName = options.sameLabel ? label : "old";
  let challengeName = "";
  let paneReads = 0;
  let processReads = 0;
  const writes: string[][] = [];
  const right = { agent: "codex", pane_id: "right:p1", tab_id: "right:t1", workspace_id: "right", terminal_id: "right-term" };
  const echoed = () => ({ ...right, terminal_title_stripped: `${nativeName} | project` });
  const request = async (method: string, params: any) => {
    expect(params.threadId).toBe(threadId);
    if (method === "thread/read") return { thread: { id: threadId, name: nativeName } };
    if (method === "thread/name/set") {
      nativeName = params.name;
      if (nativeName.startsWith("herdr-bind-")) {
        challengeName = nativeName;
        if (options.challengeAckFails) throw new Error("lost challenge acknowledgement");
      }
      return {};
    }
    throw new Error(method);
  };
  const herdr = async (...args: string[]) => {
    if (args.join(" ") === "agent list") {
      const decoy = { ...right, pane_id: "wrong:p1", tab_id: "wrong:t1", focused: true, agent_session: { value: threadId }, terminal_title_stripped: `${label} | project` };
      const panes = options.noEcho ? [decoy] : [decoy, echoed()];
      if (options.duplicate && challengeName) panes.push({ ...echoed(), pane_id: "duplicate:p1" });
      return { result: { agents: panes } };
    }
    if (args[0] === "pane" && args[1] === "process-info") {
      processReads++;
      return { result: { process_info: { pane_id: right.pane_id, foreground_processes: [{ pid: options.processOwned && !(options.processLost && processReads > 2) ? process.ppid : 1 }] } } };
    }
    if (args[0] === "pane") {
      paneReads++;
      if (args.includes("--current")) {
        if (options.candidate === "error") throw new Error("no current candidate");
        if (options.candidate === "missing") return { result: {} };
        if (options.candidate === "incomplete") return { result: { pane: { ...echoed(), terminal_id: null } } };
        if (options.candidate === "shell") return { result: { pane: { ...echoed(), agent: "shell" } } };
      }
      if (options.concurrentEdit) nativeName = "user-edited-title";
      return { result: { pane: { ...echoed(), ...(options.replacedIdentity && paneReads > 2 ? { [options.replacedIdentity]: "foreign-id" } : {}), terminal_id: (options.moved || (options.movedBeforeWrite && paneReads > 2)) ? "replaced-term" : right.terminal_id } } };
    }
    if (args[1] === "get") return { result: { tab: { tab_id: right.tab_id, workspace_id: right.workspace_id, label: tabName } } };
    if (args[1] === "rename") {
      writes.push(args);
      if (options.renameFails) throw new Error("rename rejected");
      tabName = args[3]!;
      return {};
    }
    throw new Error(args.join(" "));
  };
  return { request, herdr, writes, nativeName: () => nativeName, challengeName: () => challengeName, run: () => withVerifiedCodexPane(request, threadId, herdr, (caller, proof, verify) => renameVerifiedTab(herdr, caller, label, proof, verify), async () => {}) };
}

test("fresh client echo selects its pane despite focused decoy and poisoned session metadata", async () => {
  const f = fixture();
  const result = await f.run();
  expect(result.caller.paneId).toBe("right:p1");
  expect(result.proof).toBe("native-title-challenge");
  expect(f.writes).toEqual([["tab", "rename", "right:t1", label]]);
  expect(f.nativeName()).toBe(label);
  expect(f.challengeName()).toMatch(/^herdr-bind-[0-9a-f-]{36}$/);
});

for (const options of [{ noEcho: true }, { duplicate: true }, { moved: true }, { challengeAckFails: true }]) {
  test(`failed binding never renames any tab and restores native title: ${JSON.stringify(options)}`, async () => {
    const f = fixture(options);
    await expect(f.run()).rejects.toThrow();
    expect(f.writes).toHaveLength(0);
    expect(f.nativeName()).toBe(label);
  });
}

test("failed tab rename still restores native title without retry", async () => {
  const f = fixture({ renameFails: true });
  await expect(f.run()).rejects.toThrow("rename rejected");
  expect(f.writes).toHaveLength(1);
  expect(f.nativeName()).toBe(label);
});

test("a concurrent native title edit is preserved and stops the tab write", async () => {
  const f = fixture({ concurrentEdit: true });
  await expect(f.run()).rejects.toThrow();
  expect(f.nativeName()).toBe("user-edited-title");
  expect(f.writes).toHaveLength(0);
});


test("OS process ownership names its tab without a native title echo or marker", async () => {
  const f = fixture({ processOwned: true, noEcho: true });
  const result = await f.run();
  expect(result.proof).toBe("process-ancestry");
  expect(result.caller.paneId).toBe("right:p1");
  expect(f.writes).toEqual([["tab", "rename", "right:t1", label]]);
  expect(f.challengeName()).toBe("");
});

for (const options of [{ processLost: true }, { movedBeforeWrite: true }, { concurrentEdit: true }, { renameFails: true }]) {
  test(`process proof conflicts or uncertain writes never fall back: ${JSON.stringify(options)}`, async () => {
    const f = fixture({ processOwned: true, noEcho: true, ...options });
    await expect(f.run()).rejects.toThrow();
    expect(f.challengeName()).toBe("");
    expect(f.writes).toHaveLength(options.renameFails ? 1 : 0);
  });
}

for (const key of ["pane_id", "tab_id", "workspace_id"]) {
  test(`process proof rejects ${key} migration immediately before write`, async () => {
    const f = fixture({ processOwned: true, noEcho: true, replacedIdentity: key });
    await expect(f.run()).rejects.toThrow("ownership changed");
    expect(f.writes).toHaveLength(0);
    expect(f.challengeName()).toBe("");
  });
}

test("an already matching process-owned tab is verified without a write", async () => {
  const f = fixture({ processOwned: true, noEcho: true, sameLabel: true });
  const result = await f.run();
  expect(result.changed).toBe(false);
  expect(result.proof).toBe("process-ancestry");
  expect(f.writes).toHaveLength(0);
  expect(f.challengeName()).toBe("");
});

for (const candidate of ["missing", "incomplete", "shell", "error"] as const) {
  test(`fresh unique echo remains available for a ${candidate} process candidate`, async () => {
    const f = fixture({ candidate, processOwned: true });
    const result = await f.run();
    expect(result.proof).toBe("native-title-challenge");
    expect(f.writes).toEqual([["tab", "rename", "right:t1", label]]);
    expect(f.nativeName()).toBe(label);
    expect(f.challengeName()).toMatch(/^herdr-bind-/);
  });
}
