import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Only the herdr and systemd-run process boundaries are replaced; route-lane.ts runs unchanged.
const fakeHerdr = `#!${process.execPath}
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const file = process.env.HERDR_TEST_STATE;
const s = JSON.parse(readFileSync(file, 'utf8'));
// systemd-run runs concurrently and must not share a read-modify-write file with herdr.
if (existsSync(file + '.started')) s.running = true;
let a = process.argv.slice(2);
s.calls.push(a);
const save = () => writeFileSync(file, JSON.stringify(s));
const reply = result => { save(); console.log(JSON.stringify({result})); };
const fail = text => { save(); console.log(text); process.exit(1); };
let session = null;
if (a[0] === '--session') { session = a[1]; a = a.slice(2); }
if (a[0] === 'session' && a[1] === 'stop') { s.running = false; save(); console.log('stopped'); process.exit(0); }
if (session && !s.running) fail(JSON.stringify({error:{code:'server_not_running',message:'no herdr server is running'}}));
const pane = (workspace, tab, id) => ({workspace_id:workspace,tab_id:tab,pane_id:id,cwd:s.cwd});
if (a[0] === 'workspace' && a[1] === 'list') {
  // Stop the fake external server after a successful availability check, before the next native call.
  if (s.stopAfterAvailabilityCheck) s.running = false;
  reply({workspaces:s.workspaces.map(id => ({workspace_id:id}))});
}
else if (a[0] === 'pane' && a[1] === 'list') reply({panes:[pane(a[3],a[3]+':t1',a[3]+':p1')]});
else if (a[0] === 'tab' && a[1] === 'list') reply({tabs:[{workspace_id:a[3],tab_id:a[3]+':t1'}]});
else if (a[0] === 'pane' && a[1] === 'current') reply({pane:pane("main","main:t1",a[3])});
else if (a[0] === 'workspace' && a[1] === 'create') {
  s.workspaces.push('hidden-new'); reply({workspace:{workspace_id:'hidden-new'},tab:{workspace_id:'hidden-new',tab_id:'hidden-new:t1',label:s.label},root_pane:pane('hidden-new','hidden-new:t1','hidden-new:p1')});
} else if (a[0] === 'tab' && a[1] === 'create') {
  reply({tab:{workspace_id:a[3],tab_id:a[3]+':t2',label:s.label},root_pane:pane(a[3],a[3]+':t2',a[3]+':p2')});
} else if (a[0] === 'tab' && a[1] === 'get') {
  const id = a[2]; reply({tab:{workspace_id:id.split(':')[0],tab_id:id,label:s.label}});
} else if (a[0] === 'pane' && a[1] === 'process-info') reply({process_info:{foreground_processes:[{name:'zsh'}]}});
else if (a[1] === 'run' || a[1] === 'wait-output') reply({type:'ok'});
else fail('unexpected command: '+JSON.stringify(a));
`;

const fakeSystemd = `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const file = process.env.HERDR_TEST_STATE;
const s = JSON.parse(readFileSync(file, 'utf8'));
appendFileSync(file + '.systemd', JSON.stringify(process.argv.slice(2)) + '\\n');
if (!s.systemdFails) writeFileSync(file + '.started', '');
process.exit(s.systemdFails ? 1 : 0);
`;

interface Options {
  running?: boolean;
  workspaces?: string[];
  systemd?: "ok" | "fails" | "missing";
  stopAfterAvailabilityCheck?: boolean;
}

async function route(args: string[], options: Options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "herdr-session-test-"));
  try {
    const cwd = realpathSync(dir);
    const state = join(dir, "state.json");
    const bin = join(dir, "bin");
    Bun.spawnSync(["mkdir", bin]);
    writeFileSync(state, JSON.stringify({
      cwd, label: "probe", calls: [], systemd: [],
      running: options.running ?? false,
      workspaces: options.workspaces ?? [],
      systemdFails: options.systemd === "fails",
      stopAfterAvailabilityCheck: options.stopAfterAvailabilityCheck ?? false,
    }));
    writeFileSync(join(bin, "herdr"), fakeHerdr, { mode: 0o755 });
    chmodSync(join(bin, "herdr"), 0o755);
    let path = bin;
    if (options.systemd !== "missing") {
      writeFileSync(join(bin, "systemd-run"), fakeSystemd);
      chmodSync(join(bin, "systemd-run"), 0o755);
      path = `${bin}:${process.env.PATH}`;
    } else {
      symlinkSync(Bun.which("git")!, join(bin, "git"));
    }
    const child = Bun.spawn(
      [process.execPath, resolve(import.meta.dir, "../scripts/route-lane.ts"), ...args.map((arg) => arg === "$CWD" ? cwd : arg)],
      { env: { ...process.env, PATH: path, HERDR_TEST_STATE: state }, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, status] = await Promise.all([Bun.readableStreamToText(child.stdout), child.exited]);
    const final = JSON.parse(readFileSync(state, "utf8"));
    const systemd = existsSync(`${state}.systemd`)
      ? readFileSync(`${state}.systemd`, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
    return { ...final, systemd, status, output: JSON.parse(stdout), cwd };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const lane = ["--type", "coding-agent", "--cwd", "$CWD", "--label", "probe"];

test("--session conflicts are rejected before touching Herdr", async () => {
  for (const [extra, code] of [
    [["--session", "hidden", "--caller-pane", "main:p1"], "conflicting_options"],
    [["--session", "hidden", "--scope", "same-task"], "invalid_scope"],
    [["--session", "default"], "invalid_session"],
  ] as const) {
    const s = await route([...lane, ...extra]);
    expect(s.status).toBe(2);
    expect(s.output.error.code).toBe(code);
    expect(s.calls).toEqual([]);
    expect(s.systemd).toEqual([]);
  }
  for (const name of ["", "bad name", "a/b", "-x"]) {
    const s = await route([...lane, "--session", name]);
    expect(s.status).toBe(2);
    expect(s.output.error.code).toBe("invalid_session");
  }
});

test("--stop-if-empty needs --session and excludes lane options", async () => {
  const alone = await route(["--stop-if-empty"]);
  expect([alone.status, alone.output.error.code]).toEqual([2, "missing_argument"]);
  for (const extra of [["--type", "oneshot"], ["--cwd", "$CWD"], ["--label", "x"]]) {
    const s = await route(["--session", "hidden", "--stop-if-empty", ...extra], { running: true });
    expect([s.status, s.output.error.code]).toEqual([2, "conflicting_options"]);
    expect(s.calls).toEqual([]);
  }
});

test("--require-running requires --session and rejects incompatible modes before touching Herdr", async () => {
  for (const [args, code] of [
    [[...lane, "--require-running"], "missing_argument"],
    [[...lane, "--create-session", "hidden", "--op-tag", "t", "--require-running"], "conflicting_options"],
    [["--session", "hidden", "--stop-if-empty", "--require-running"], "conflicting_options"],
  ] as const) {
    const s = await route([...args]);
    expect([s.status, s.output.error.code]).toEqual([2, code]);
    expect(s.calls).toEqual([]);
    expect(s.systemd).toEqual([]);
  }
});

test("--require-running refuses an unavailable session, including dry-run, without starting or creating anything", async () => {
  for (const extra of [[], ["--dry-run"]]) {
    const s = await route([...lane, "--session", "hidden", "--require-running", ...extra]);
    expect([s.status, s.output.error.code]).toEqual([1, "session_not_running"]);
    expect(s.systemd).toEqual([]);
    expect(s.calls.some((call: string[]) => call.includes("create") || call.includes("server"))).toBe(false);
    expect(s.workspaces).toEqual([]);
  }
});

test("--require-running reuses a running session without starting it", async () => {
  const s = await route([...lane, "--session", "hidden", "--require-running"], { running: true, workspaces: ["w1"] });
  expect(s.status).toBe(0);
  expect(s.output.session).toEqual({ name: "hidden", created: false, running_before: true, started: false, unit: null });
  expect(s.output.action).toBe("create-tab");
  expect(s.output.result.workspace_id).toBe("w1");
  expect(s.systemd).toEqual([]);
  for (const call of s.calls) expect(call.slice(0, 2)).toEqual(["--session", "hidden"]);
});

test("--require-running propagates a native server exit after the availability check without restarting", async () => {
  const s = await route([...lane, "--session", "hidden", "--require-running"], {
    running: true, stopAfterAvailabilityCheck: true,
  });
  expect([s.status, s.output.error.code]).toEqual([1, "herdr_failed"]);
  expect(s.output.error.message).toContain("server_not_running");
  expect(s.systemd).toEqual([]);
  expect(s.calls.some((call: string[]) => call.includes("create") || call.includes("server"))).toBe(false);
  expect(s.workspaces).toEqual([]);
});

test("dry-run on a stopped session reports state and starts nothing", async () => {
  const s = await route([...lane, "--session", "hidden", "--dry-run"]);
  expect(s.status).toBe(0);
  expect(s.systemd).toEqual([]);
  expect(s.calls).toEqual([["--session", "hidden", "workspace", "list"]]);
  expect(s.output.session).toEqual({ name: "hidden", created: false, running_before: false, started: false, unit: null });
  expect(s.output.action).toBe("create-workspace");
  expect(s.output.caller).toBeNull();
  expect(s.output.lane.scope).toBe("independent");
  expect(s.output.lane.cleanup_command).toBeNull();
});

test("a stopped session is started under a memory-capped systemd scope and used for the lane", async () => {
  const s = await route([...lane, "--session", "hidden"]);
  expect(s.status).toBe(0);
  expect(s.systemd).toEqual([[
    "--user", "--scope", "--collect", "--unit=herdr-session-hidden",
    "-p", "MemoryHigh=8G", "-p", "MemoryMax=10G",
    "--", "env", "-u", "AGENTS_COOPERATION_OP_TAG", "herdr", "--session", "hidden", "server",
  ]]);
  expect(s.output.session).toEqual({
    name: "hidden", created: false, running_before: false, started: true, unit: "herdr-session-hidden.scope",
  });
  expect(s.output.action).toBe("create-workspace");
  expect(s.output.caller).toBeNull();
  expect(s.output.lane.cleanup_command).toEqual(["herdr", "--session", "hidden", "workspace", "close", "hidden-new"]);
  // Every Herdr call, including probe, creation and readiness checks, is injected with the session.
  expect(s.calls.length).toBeGreaterThan(3);
  for (const call of s.calls) expect(call.slice(0, 2)).toEqual(["--session", "hidden"]);
});

test("a running session with a matching workspace gets a new tab and no systemd call", async () => {
  const s = await route([...lane, "--session", "hidden"], { running: true, workspaces: ["w1"] });
  expect(s.status).toBe(0);
  expect(s.systemd).toEqual([]);
  expect(s.output.session).toEqual({ name: "hidden", created: false, running_before: true, started: false, unit: null });
  expect(s.output.action).toBe("create-tab");
  expect(s.output.result.workspace_id).toBe("w1");
  expect(s.output.lane.cleanup_command).toEqual(["herdr", "--session", "hidden", "tab", "close", "w1:t2"]);
  for (const call of s.calls) expect(call.slice(0, 2)).toEqual(["--session", "hidden"]);
});

test("session start failures are reported without bare-server fallback", async () => {
  const failed = await route([...lane, "--session", "hidden"], { systemd: "fails" });
  expect([failed.status, failed.output.error.code]).toEqual([1, "session_start_failed"]);
  expect(failed.calls.every((call: string[]) => call[2] === "workspace")).toBe(true);

  const missing = await route([...lane, "--session", "hidden"], { systemd: "missing" });
  expect(missing.status).not.toBe(0);
  expect(missing.output.error.code).toBe("missing_dependency");
  expect(missing.output.error.message).toContain("systemd-run");
});

test("an invalid cwd does not start a session", async () => {
  const s = await route(["--type", "coding-agent", "--cwd", "/nonexistent-dir-xyz", "--session", "hidden"]);
  expect([s.status, s.output.error.code]).toEqual([2, "invalid_cwd"]);
  expect(s.systemd).toEqual([]);
});

test("--stop-if-empty stops only an empty running session", async () => {
  const empty = await route(["--session", "hidden", "--stop-if-empty"], { running: true });
  expect(empty.output).toEqual({ ok: true, session: { name: "hidden", stopped: true, remaining_workspaces: 0 } });
  expect(empty.calls.at(-1)).toEqual(["session", "stop", "hidden"]);

  const busy = await route(["--session", "hidden", "--stop-if-empty"], { running: true, workspaces: ["w1", "w2"] });
  expect(busy.output).toEqual({ ok: true, session: { name: "hidden", stopped: false, remaining_workspaces: 2 } });
  expect(busy.calls.some((call: string[]) => call[0] === "session")).toBe(false);

  const gone = await route(["--session", "hidden", "--stop-if-empty"]);
  expect(gone.status).toBe(0);
  expect(gone.output).toEqual({ ok: true, session: { name: "hidden", stopped: false, remaining_workspaces: 0 } });
  expect(gone.calls.some((call: string[]) => call[0] === "session")).toBe(false);
});

test("without --session nothing is injected and session is null", async () => {
  const s = await route([...lane, "--caller-pane", "main:p1", "--dry-run"], { running: true, workspaces: ["w1"] });
  expect(s.status).toBe(0);
  expect(s.output.session).toBeNull();
  expect(s.output.caller.pane_id).toBe("main:p1");
  expect(s.calls.length).toBeGreaterThan(0);
  for (const call of s.calls) expect(call).not.toContain("--session");
});
