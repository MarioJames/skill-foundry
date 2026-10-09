import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { SQLiteStateStore } from "../scripts/lib/sqlite-state";
import { buildPublicBatch, contextBlockers, expandPublicPatch, mergePublicContext, validatePublicInput } from "../scripts/lib/public-input";
import { conflicts } from "../scripts/lib/scheduling";

const scratch: string[] = [];
const temp = () => { const p = mkdtempSync(join(tmpdir(), "dispatch-public-test-")); scratch.push(p); return p; };
afterEach(() => { for (const p of scratch.splice(0)) rmSync(p, { recursive: true, force: true }); });
const request = (cwd: string): any => ({ version: 1, cwd, goal: "Review contract while parent edits another area", owner: { id: "parent", adapter: "codex", work: "Editing src while reviewing test evidence", reads: ["src"], writes: ["src"] }, external: [], authorization: { delegate: true, basis: "user authorized review" }, tasks: [{ key: "review", prompt: "Review frozen contract", deliverable: "findings", acceptance: ["cite the contract"], reads: ["contracts"], writes: [], depends_on: [] }] });

test("automatic scope follows the calling Codex thread without relying on Herdr session reporting", () => {
  const root = temp(), bin = join(root, "bin"); mkdirSync(bin);
  const native = "fixture-codex-thread";
  writeFileSync(join(bin, "herdr"), `#!${process.execPath}\nconsole.log(JSON.stringify({result:{pane:{pane_id:'unrelated',tab_id:'focused',agent_session:{value:process.env.TEST_NATIVE_SESSION}}}}));\n`, { mode: 0o700 });
  const cli = resolve(import.meta.dir, "../scripts/agent-dispatch.ts");
  const call = (values: Record<string, string>, explicit: string[] = []) => {
    const r = Bun.spawnSync([process.execPath, cli, "status", "--cached", "--db", join(root, "state.sqlite"), ...explicit], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CODEX_THREAD_ID: "", CODEX_SESSION_ID: "", TEST_NATIVE_SESSION: "", ...values },
      stdout: "pipe", stderr: "pipe",
    });
    return { code: r.exitCode, value: JSON.parse(r.stdout.toString()) };
  };
  const expected = `session-${createHash("sha256").update(native).digest("hex").slice(0, 24)}`;
  expect(call({ TEST_NATIVE_SESSION: native })).toMatchObject({ code: 0, value: { scope: expected } });
  expect(call({ CODEX_THREAD_ID: native })).toMatchObject({ code: 0, value: { scope: expected } });
  expect(call({ CODEX_SESSION_ID: native })).toMatchObject({ code: 0, value: { scope: expected } });
  // The runtime identity belongs to this caller; a focused/unrelated Herdr pane cannot replace it.
  expect(call({ CODEX_THREAD_ID: native, TEST_NATIVE_SESSION: "other-pane-session" })).toMatchObject({ code: 0, value: { scope: expected } });
  expect(call({ CODEX_THREAD_ID: native, CODEX_SESSION_ID: "different-thread" })).toMatchObject({ code: 2, value: { error: { code: "caller_session_mismatch" } } });
  expect(call({})).toMatchObject({ code: 2, value: { error: { code: "missing_scope" } } });
  expect(call({ CODEX_THREAD_ID: native, CODEX_SESSION_ID: "different-thread" }, ["--scope", "chosen"])).toMatchObject({ code: 0, value: { scope: "chosen" } });
});

test("Claude callers and external workers are accepted with their ownership intact", () => {
  const x = request(temp()); x.owner.adapter = "claude";
  x.external = [{ id: "worker", adapter: "claude", reads: ["docs"], writes: [] }];
  const r = validatePublicInput(x);
  expect(r.issues).toEqual([]);
  expect(r.input!.owner.adapter).toBe("claude");
  expect(r.input!.external![0].reads).toEqual(["docs"]);
});

test("public validation reports all bad fields with paths and preserves unknown ownership", () => {
  const root = temp(), input = request(root);
  input.tasks[0].reads = "contracts";
  input.tasks[0].acceptance = [];
  const bad = validatePublicInput(input);
  expect(bad.issues.map((x) => x.path)).toContain("/tasks/0/reads");
  expect(bad.issues.map((x) => x.path)).toContain("/tasks/0/acceptance");
  input.tasks[0].reads = null; input.tasks[0].acceptance = ["cite the contract"]; input.external = null;
  const parsed = validatePublicInput(input);
  expect(parsed.issues).toEqual([]);
  const context = mergePublicContext(undefined, parsed.input!);
  expect(contextBlockers(context).map((x) => x.path)).toEqual(["/external"]);
  const store = new SQLiteStateStore("scope", join(root, "state.sqlite"));
  expect(buildPublicBatch("scope", context, store.read()).tasks[0].resources.status).toBe("unknown");
  store.close();
});

test("task changes require revision evidence while omitted pending work survives later calls", () => {
  const root = temp(), first = validatePublicInput(request(root)).input!;
  const context = mergePublicContext(undefined, first);
  expect(context.tasks[0].revision).toBe(1);
  expect(mergePublicContext(context, first).tasks[0].revision).toBe(1);
  const later = request(root); later.tasks[0].prompt = "Review updated contract";
  expect(() => mergePublicContext(context, validatePublicInput(later).input!)).toThrow("if_revision=1");
  later.tasks[0].if_revision = 1;
  const revised = mergePublicContext(context, validatePublicInput(later).input!);
  expect(revised.tasks[0].revision).toBe(2);
  later.tasks = [{ key: "second", prompt: "Review tests", deliverable: "findings", acceptance: ["cite tests"], reads: ["tests"], writes: [], depends_on: [] }];
  const appended = mergePublicContext(revised, validatePublicInput(later).input!);
  expect(appended.tasks.map((t) => [t.key, t.revision])).toEqual([["review", 2], ["second", 1]]);
});

test("stored facts allow empty calls and small patches without repeating task definitions", () => {
  const root = temp();
  const context = mergePublicContext(undefined, validatePublicInput(request(root)).input!);
  const unchanged = mergePublicContext(context, validatePublicInput(expandPublicPatch(context, { tasks: [] })).input!);
  expect(unchanged).toEqual(context);
  const small = expandPublicPatch(context, {
    owner: { work: "Reviewing finished implementation" },
    tasks: [
      { key: "review", if_revision: 1, prompt: "Review updated contract" },
      { key: "second", prompt: "Review tests", deliverable: "findings", acceptance: ["cite tests"], reads: ["tests"], writes: [], depends_on: [] },
    ],
  });
  const parsed = validatePublicInput(small);
  expect(parsed.issues).toEqual([]);
  const revised = mergePublicContext(context, parsed.input!);
  expect(revised.owner.work).toBe("Reviewing finished implementation");
  expect(revised.tasks.map((t) => [t.key, t.revision])).toEqual([["review", 2], ["second", 1]]);
  expect(revised.tasks[0].deliverable).toBe("findings");
  expect(revised.tasks[0].prompt).toBe("Review updated contract");
});

test("resource keys retain ancestor overlap across cwd and symlink aliases", () => {
  const root = temp();
  mkdirSync(join(root, "src"));
  symlinkSync(join(root, "src"), join(root, "alias"));
  const store = new SQLiteStateStore("paths", join(root, "state.sqlite"));
  const key = (cwd: string, path: string) => {
    const input = request(cwd);
    input.tasks[0].reads = [];
    input.tasks[0].writes = [path];
    const context = mergePublicContext(undefined, validatePublicInput(input).input!);
    return (buildPublicBatch("paths", context, store.read()).tasks[0].resources as any).writes[0] as string;
  };
  const parent = key(root, "src");
  const nested = key(join(root, "src"), "a.ts");
  const alias = key(root, "alias/a.ts");
  expect(nested).toBe(alias);
  expect(conflicts({ reads: [], writes: [parent] }, { reads: [nested], writes: [] })).toBe(true);
  store.close();
});

test("SQLite persists independent scopes across processes and rejects concurrent mutation", async () => {
  const root = temp(), db = join(root, "state.sqlite"), one = new SQLiteStateStore("one", db);
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  const first = one.transaction(async (state, save) => { state.public_context = { marker: "persisted" }; save(); await held; });
  await Bun.sleep(10);
  const second = new SQLiteStateStore("one", db);
  await expect(second.transaction(async () => {})).rejects.toMatchObject({ code: "scope_locked" });
  release(); await first;
  expect((second.read().public_context as any).marker).toBe("persisted");
  const other = new SQLiteStateStore("two", db);
  expect(other.read().public_context).toBeUndefined();
  await other.transaction(async (state, save) => { state.public_context = { marker: "other" }; save(); });
  expect((one.read().public_context as any).marker).toBe("persisted");
  let releaseAdmission!: () => void;
  const admissionWait = new Promise<void>((r) => { releaseAdmission = r; });
  const admitted = one.admission(async () => { await admissionWait; });
  await Bun.sleep(10);
  await expect(other.admission(async () => {})).rejects.toMatchObject({ code: "admission_locked" });
  releaseAdmission(); await admitted;
  one.close(); second.close(); other.close();
});
