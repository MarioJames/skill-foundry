import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Only the Herdr process boundary is replaced; createResource and rollback run unchanged.
const fakeHerdr = `#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs';
const file = process.env.HERDR_TEST_STATE;
const s = JSON.parse(readFileSync(file, 'utf8'));
const a = process.argv.slice(2); s.calls.push(a);
const save = () => writeFileSync(file, JSON.stringify(s));
const reply = result => { save(); console.log(JSON.stringify({result})); };
const fail = text => { save(); console.error(text); process.exit(1); };
const old = {workspace_id:'old',tab_id:'old:t1',pane_id:'old:p1',cwd:s.cwd};
let pane = s.action === 'create-workspace'
 ? {workspace_id:'new',tab_id:'new:t1',pane_id:'new:p1',cwd:s.cwd}
 : {...old,tab_id:s.action === 'create-tab' ? 'old:t2' : 'old:t1',pane_id:'old:p2'};
if (s.oldResult) pane = old;
if (a[1] === 'list') {
 const singular = a[0]; const plural = singular === 'workspace' ? 'workspaces' : singular+'s';
 reply({[plural]:[old]});
} else if (a[1] === 'create' || a[1] === 'split') {
 s.label = s.action === 'create-tab' && !s.dropLabel ? s.labelWanted : '1';
 reply({workspace:{workspace_id:pane.workspace_id},tab:{workspace_id:pane.workspace_id,tab_id:pane.tab_id},root_pane:pane,pane});
} else if (a[0] === 'tab' && a[1] === 'get') {
 if (s.getFails) fail('tab read failed');
 reply({tab:{workspace_id:s.wrongTabOwner ? 'wrong' : pane.workspace_id,tab_id:pane.tab_id,label:s.label}});
} else if (a[0] === 'tab' && a[1] === 'rename') {
 if (s.renameFails) fail('rename failed');
 if (!s.ignoreRename) s.label = a[3];
 reply({type:'ok'});
} else if (a[1] === 'close') {
 if (s.closeFails) fail('close failed');
 s.closed = [a[0],a[2]]; reply({type:'ok'});
} else if (a[1] === 'process-info') {
 reply({process_info:{foreground_processes:[{name:'zsh'}]}});
} else if (a[1] === 'run' || a[1] === 'wait-output') {
 reply({type:'ok'});
} else fail('unexpected command: '+JSON.stringify(a));
`;

async function run(action: string, changes: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "herdr-label-test-"));
  try {
    const state = join(dir, "state.json");
    const labelWanted = "任务 '名称' $(literal) `literal`";
    writeFileSync(state, JSON.stringify({ action, cwd:dir, labelWanted, calls:[], ...changes }));
    writeFileSync(join(dir, "herdr"), fakeHerdr, { mode:0o755 });
    writeFileSync(join(dir, "run.ts"), `
import {createResource, runCli, emit} from ${JSON.stringify(resolve(import.meta.dir, "../../skills/herdr/scripts/lib/herdr-route.ts"))};
await runCli(async () => emit(await createResource(${JSON.stringify({ action,cwd:dir,label:labelWanted,direction:"right",matchedWorkspaceId:action === "create-tab" ? "old" : null,caller:{workspaceId:"old",tabId:"old:t1",paneId:"old:p1"}})})));
`);
    const child = Bun.spawn([process.execPath, join(dir, "run.ts")], {
      env:{...process.env, PATH:`${dir}:${process.env.PATH}`, HERDR_TEST_STATE:state},stdout:"pipe",stderr:"pipe",
    });
    const [stdout, stderr, status] = await Promise.all([Bun.readableStreamToText(child.stdout),Bun.readableStreamToText(child.stderr),child.exited]);
    return {...JSON.parse(readFileSync(state,"utf8")),status,output:JSON.parse(stdout),stderr};
  } finally { rmSync(dir,{recursive:true,force:true}); }
}

for (const action of ["create-workspace", "create-tab"]) {
  test(`${action}: returns the requested tab label`, async () => {
    const s = await run(action);
    expect(s.status).toBe(0);
    expect(s.label).toBe(s.labelWanted);
    expect(s.calls.some((a: string[]) => a[0] === "tab" && a[1] === "get")).toBe(true);
    const renames = s.calls.filter((a: string[]) => a[1] === "rename");
    expect(renames).toEqual(action === "create-tab" ? [] : [["tab","rename","new:t1",s.labelWanted]]);
    expect(s.closed).toBeUndefined();
  });
  for (const failure of ["renameFails", "ignoreRename", "getFails", "wrongTabOwner"]) {
    test(`${action}: ${failure} rolls back only the new resource`, async () => {
      const s = await run(action, {dropLabel:true,[failure]:true});
      expect(s.status).not.toBe(0);
      expect(s.output.ok).toBe(false);
      expect(s.closed).toEqual(action === "create-tab" ? ["tab","old:t2"] : ["workspace","new"]);
      if (failure === "wrongTabOwner") expect(s.calls.some((a: string[]) => a[1] === "rename")).toBe(false);
    });
  }
}
test("tab creation repairs a label omitted by the CLI", async () => {
  const s = await run("create-tab",{dropLabel:true});
  expect(s.status).toBe(0);
  expect(s.label).toBe(s.labelWanted);
  expect(s.calls.filter((a: string[]) => a[1] === "rename")).toEqual([["tab","rename","old:t2",s.labelWanted]]);
});
test("split preserves its parent tab label", async () => {
  const s = await run("split-pane");
  expect(s.status).toBe(0);
  expect(s.label).toBe("1");
  expect(s.calls.some((a: string[]) => a[1] === "rename")).toBe(false);
});
for (const action of ["create-workspace","create-tab","split-pane"]) {
  test(`${action}: an old resource returned by mistake is neither renamed nor closed`, async () => {
    const s = await run(action,{oldResult:true});
    expect(s.status).not.toBe(0);
    expect(s.closed).toBeUndefined();
    expect(s.calls.some((a: string[]) => a[1] === "rename")).toBe(false);
  });
}
test("a rollback failure identifies the exact leftover cleanup command", async () => {
  const s = await run("create-tab",{dropLabel:true,renameFails:true,closeFails:true});
  expect(s.status).not.toBe(0);
  expect(s.output.error.message).toContain("herdr tab close old:t2");
  expect(s.output.error.message).toContain("rename failed");
});
