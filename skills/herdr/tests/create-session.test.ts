import { afterEach, expect, test } from "bun:test";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync,
  statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Replaces only the herdr, systemd-run and systemctl process boundaries. route-lane.ts and the real
// session-launcher.sh run unchanged; the fake server is a real long-lived process listening on the socket.
const fakeHerdr = `#!${process.execPath}
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { join } from 'node:path';
const root = process.env.FAKE_ROOT;
const home = join(process.env.XDG_CONFIG_HOME, 'herdr');
const sessionsDir = join(home, 'sessions');
let a = process.argv.slice(2);
appendFileSync(join(root, 'calls.log'), JSON.stringify(a) + '\\n');
appendFileSync(join(root, 'tags.log'), 'herdr ' + (process.env.HERDR_LANE_OP_TAG ?? '-') + '\\n');
const out = value => console.log(JSON.stringify(value));
const fail = (code, status = 1) => { console.log(JSON.stringify({ error: { code } })); process.exit(status); };
let session = null;
if (a[0] === '--session') { session = a[1]; a = a.slice(2); }
const dir = session ? join(sessionsDir, session) : home;
const registered = () => existsSync(join(root, 'registered.json')) ? JSON.parse(readFileSync(join(root, 'registered.json'), 'utf8')) : [];
const alive = path => new Promise(done => {
  const socket = connect(path);
  socket.on('connect', () => { socket.destroy(); done(true); });
  socket.on('error', () => done(false));
});

if (a[0] === 'server' && a.length === 1) {
  mkdirSync(dir, { recursive: true });
  const foreign = process.env.FAKE_FOREIGN;
  if (foreign === 'restored') writeFileSync(join(dir, 'workspaces.json'), JSON.stringify(['restored-ws']));
  mkdirSync(join(root, 'pids'), { recursive: true });
  const sock = join(dir, 'herdr.sock');
  if (foreign === 'other-server') {
    // Someone else's server already owns the socket; this process only pretends to serve it.
    const other = Bun.spawn([process.execPath, '-e', \`require('node:net').createServer(() => {}).listen(\${JSON.stringify(sock)}); setInterval(() => {}, 1000)\`], { stdio: ['ignore', 'ignore', 'ignore'] });
    writeFileSync(join(root, 'pids', String(other.pid)), 'other');
    while (!(await alive(sock))) await new Promise(done => setTimeout(done, 20));
  } else {
    createServer(() => {}).listen(sock);
  }
  writeFileSync(join(dir, 'herdr-server.log'), 'started\\n');
  writeFileSync(join(root, 'pids', String(process.pid)), session ?? 'default');
  writeFileSync(join(root, 'server-env.log'), process.env.HERDR_LANE_OP_TAG === undefined ? 'absent' : 'present');
  setInterval(() => {}, 1000);
} else if (a[0] === 'session' && a[1] === 'list') {
  if (process.env.FAKE_LIST_FAIL) fail('list_failed');
  // Simulates someone else creating the same session right after the launcher's list check.
  if (process.env.FAKE_LIST_CREATES && process.env.FAKE_LIST_CREATES !== 'done') mkdirSync(join(sessionsDir, process.env.FAKE_LIST_CREATES), { recursive: true });
  const names = new Set(registered());
  if (existsSync(sessionsDir)) for (const name of readdirSync(sessionsDir)) names.add(name);
  const sessions = [{ default: true, name: 'default', running: true, session_dir: home, socket_path: join(home, 'herdr.sock') }];
  for (const name of names) {
    const path = join(sessionsDir, name, 'herdr.sock');
    sessions.push({ default: false, name, running: await alive(path), session_dir: join(sessionsDir, name), socket_path: path });
  }
  out({ sessions });
} else if (a[0] === 'session' && a[1] === 'stop') {
  for (const pid of existsSync(join(root, 'pids')) ? readdirSync(join(root, 'pids')) : []) {
    if (readFileSync(join(root, 'pids', pid), 'utf8') === a[2]) { try { process.kill(Number(pid)); } catch {} }
  }
  console.log('stopped');
} else {
  if (!session || !(await alive(join(dir, 'herdr.sock')))) fail('server_not_running');
  const workspaces = existsSync(join(dir, 'workspaces.json')) ? JSON.parse(readFileSync(join(dir, 'workspaces.json'), 'utf8')) : [];
  const cwd = process.env.FAKE_CWD;
  const pane = (workspace, tab, id) => ({ workspace_id: workspace, tab_id: tab, pane_id: id, cwd });
  const reply = result => out({ result });
  if (a[0] === 'workspace' && a[1] === 'list') reply({ workspaces: workspaces.map(id => ({ workspace_id: id })) });
  else if (a[0] === 'workspace' && a[1] === 'create') {
    writeFileSync(join(dir, 'workspaces.json'), JSON.stringify([...workspaces, 'created-ws']));
    reply({ workspace: { workspace_id: 'created-ws' }, tab: { workspace_id: 'created-ws', tab_id: 'created-ws:t1', label: process.env.FAKE_LABEL }, root_pane: pane('created-ws', 'created-ws:t1', 'created-ws:p1') });
  } else if (a[0] === 'pane' && a[1] === 'list') reply({ panes: [pane(a[3], a[3] + ':t1', a[3] + ':p1')] });
  else if (a[0] === 'tab' && a[1] === 'list') reply({ tabs: [{ workspace_id: a[3], tab_id: a[3] + ':t1' }] });
  else if (a[0] === 'tab' && a[1] === 'create') reply({ tab: { workspace_id: a[3], tab_id: a[3] + ':t2', label: process.env.FAKE_LABEL }, root_pane: pane(a[3], a[3] + ':t2', a[3] + ':p2') });
  else if (a[0] === 'workspace' && a[1] === 'close') fail('unexpected_close');
  else if (a[0] === 'tab' && a[1] === 'get') reply({ tab: { workspace_id: a[2].split(':')[0], tab_id: a[2], label: process.env.FAKE_LABEL } });
  else if (a[0] === 'pane' && a[1] === 'process-info') reply({ process_info: { foreground_processes: [{ name: 'zsh' }] } });
  else if (a[1] === 'run' || a[1] === 'wait-output') reply({ type: 'ok' });
  else fail('unexpected command: ' + JSON.stringify(a));
}
`;

// Like the real one in scope mode: registers the unit, then runs the command in place.
const fakeSystemdRun = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_ROOT/systemd-run.log"
echo "systemd-run \${HERDR_LANE_OP_TAG:--}" >> "$FAKE_ROOT/tags.log"
unit=
for arg in "$@"; do case $arg in --unit=*) unit=\${arg#--unit=} ;; esac; done
if [ -e "$FAKE_ROOT/units/$unit.scope" ]; then
  echo "Failed to start transient scope unit: Unit $unit.scope was already loaded or has a fragment file." >&2
  exit 1
fi
mkdir -p "$FAKE_ROOT/units" && : > "$FAKE_ROOT/units/$unit.scope"
shift_to_command() { while [ "$1" != "--" ]; do shift; done; shift; exec "$@"; }
echo "Running as unit: $unit.scope; invocation ID: 00000000000000000000000000000000" >&2
shift_to_command "$@"
`;

const fakeSystemctl = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_ROOT/systemctl.log"
echo "systemctl \${HERDR_LANE_OP_TAG:--}" >> "$FAKE_ROOT/tags.log"
echo "InvocationID=0123456789abcdef0123456789abcdef"
echo "ControlGroup=$(sed 's/^0:://' /proc/self/cgroup)"
`;

// `ls -A` is the launcher's last step before forking the server: this shim lets a test write into the
// session directory exactly between the atomic mkdir and the fork.
const fakeLs = `#!/bin/sh
echo "ls \${HERDR_LANE_OP_TAG:--}" >> "$FAKE_ROOT/tags.log"
if [ -n "$FAKE_INJECT" ]; then echo '{}' > "$2/$FAKE_INJECT"; fi
exec /bin/ls "$@"
`;

const roots: string[] = [];

function scenario() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-create-test-")));
  roots.push(root);
  const bin = join(root, "bin");
  const home = join(root, "home");
  mkdirSync(bin);
  mkdirSync(home);
  for (const [name, body] of [["herdr", fakeHerdr], ["systemd-run", fakeSystemdRun], ["systemctl", fakeSystemctl], ["ls", fakeLs]]) {
    writeFileSync(join(bin, name!), body!);
    chmodSync(join(bin, name!), 0o755);
  }
  const cwd = join(root, "project");
  mkdirSync(cwd);
  const sessions = join(home, ".config", "herdr", "sessions");
  const read = (file: string) => existsSync(join(root, file))
    ? readFileSync(join(root, file), "utf8").trim().split("\n").filter(Boolean) : [];
  return {
    root, cwd, sessions,
    calls: () => read("calls.log").map((line) => JSON.parse(line) as string[]),
    systemd: () => read("systemd-run.log"),
    tags: () => read("tags.log"),
    serverEnv: () => read("server-env.log")[0],
    servers: () => existsSync(join(root, "pids")) ? readdirSync(join(root, "pids")).map(Number) : [],
    async route(args: string[], extraEnv: Record<string, string> = {}) {
      const child = Bun.spawn(
        [process.execPath, resolve(import.meta.dir, "../scripts/route-lane.ts"), ...args.map((arg) => arg === "$CWD" ? cwd : arg)],
        {
          env: {
            ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home, XDG_CONFIG_HOME: join(home, ".config"),
            FAKE_ROOT: root, FAKE_CWD: cwd, FAKE_LABEL: "probe", ...extraEnv,
          },
          stdout: "pipe", stderr: "pipe", stdin: "ignore",
        },
      );
      const [stdout, status] = await Promise.all([Bun.readableStreamToText(child.stdout), child.exited]);
      return { status, output: JSON.parse(stdout) };
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    for (const pid of existsSync(join(root, "pids")) ? readdirSync(join(root, "pids")) : []) {
      try { process.kill(Number(pid)); } catch {}
    }
    // Anything still running out of this scenario (fake servers, stalled launchers) goes with it.
    for (const pid of readdirSync("/proc").filter((entry) => /^\d+$/.test(entry))) {
      try {
        if (readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(root)) process.kill(Number(pid));
      } catch {}
    }
    if (existsSync(join(root, "startup.pid"))) {
      try { process.kill(Number(readFileSync(join(root, "startup.pid"), "utf8"))); } catch {}
    }
    rmSync(root, { recursive: true, force: true });
  }
});

const lane = ["--type", "coding-agent", "--cwd", "$CWD", "--label", "probe"];

test("--create-session option conflicts are rejected before anything starts", async () => {
  const s = scenario();
  const cases: [string[], string][] = [
    [["--create-session", "cs1", "--session", "cs1", "--op-tag", "t"], "conflicting_options"],
    [["--create-session", "default", "--op-tag", "t"], "invalid_session"],
    [["--create-session", "bad name", "--op-tag", "t"], "invalid_session"],
    [["--create-session", "cs1", "--op-tag", "t", "--caller-pane", "main:p1"], "conflicting_options"],
    [["--create-session", "cs1", "--op-tag", "t", "--scope", "same-task"], "invalid_scope"],
    [["--create-session", "cs1", "--op-tag", "t", "--dry-run"], "conflicting_options"],
    [["--create-session", "cs1"], "missing_argument"],
    [["--create-session", "cs1", "--op-tag", "has space"], "invalid_op_tag"],
    [["--create-session", "cs1", "--op-tag", "-x"], "invalid_op_tag"],
  ];
  for (const [extra, code] of cases) {
    const result = await s.route([...lane, ...extra]);
    expect([result.status, result.output.error.code]).toEqual([2, code]);
  }
  const stop = await s.route(["--session", "cs1", "--stop-if-empty", "--create-session", "cs2", "--op-tag", "t"]);
  expect(stop.status).toBe(2);
  expect(s.calls()).toEqual([]);
  expect(s.systemd()).toEqual([]);
});

test("create-session starts one memory-capped scope and returns a verifiable proof", async () => {
  const s = scenario();
  const created = await s.route([...lane, "--create-session", "cs-one", "--op-tag", "op-123"]);
  expect(created.output).toMatchObject({ ok: true });
  expect(created.status).toBe(0);

  const launcher = resolve(import.meta.dir, "../scripts/session-launcher.sh");
  expect(s.systemd()).toEqual([
    `--user --scope --collect --unit=herdr-session-cs-one -p MemoryHigh=8G -p MemoryMax=10G -- sh ${launcher} --op-tag op-123 cs-one`,
  ]);

  const [serverPid] = s.servers();
  expect(s.servers()).toHaveLength(1);
  const { session } = created.output;
  const dirStat = statSync(join(s.sessions, "cs-one"), { bigint: true });
  expect(session.name).toBe("cs-one");
  expect(session.created).toBe(true);
  expect(session.dir_id).toEqual({ dev: Number(dirStat.dev), ino: Number(dirStat.ino) });
  expect(Object.keys(session.proof).sort()).toEqual(["boot_id", "invocation_id", "server_pid", "server_starttime", "unit"]);
  expect(session.proof.unit).toBe("herdr-session-cs-one.scope");
  expect(session.proof.invocation_id).toBe("0123456789abcdef0123456789abcdef");
  expect(session.proof.server_pid).toBe(serverPid);
  const stat = readFileSync(`/proc/${serverPid}/stat`, "utf8");
  expect(session.proof.server_starttime).toBe(Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]));
  expect(session.proof.boot_id).toBe(readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim());

  expect(created.output.action).toBe("create-workspace");
  expect(created.output.result.workspace_id).toBe("created-ws");
  expect(created.output.result.pane_id).toBe("created-ws:p1");
  // Every Herdr call after creation is routed to the new session; the default session is never touched.
  for (const call of s.calls().filter((call) => call[0] !== "session" && call[0] !== "server")) {
    expect(call.slice(0, 2)).toEqual(["--session", "cs-one"]);
  }
});

test("the op tag stays visible in the launcher argv while it runs", async () => {
  const s = scenario();
  // A launcher that never reaches the fork keeps its argv observable; use herdr list hanging as the stall.
  const stall = join(s.root, "bin", "herdr");
  writeFileSync(stall, `#!/bin/sh\nexec sleep 30\n`);
  chmodSync(stall, 0o755);
  const child = Bun.spawn(
    [process.execPath, resolve(import.meta.dir, "../scripts/route-lane.ts"), ...lane.map((a) => a === "$CWD" ? s.cwd : a),
      "--create-session", "cs-tag", "--op-tag", "op-visible-9"],
    {
      env: { ...process.env, PATH: `${join(s.root, "bin")}:${process.env.PATH}`, HOME: join(s.root, "home"), XDG_CONFIG_HOME: join(s.root, "home", ".config"), FAKE_ROOT: s.root },
      stdout: "pipe", stderr: "pipe", stdin: "ignore",
    },
  );
  const cmdline = (pid: number) => { try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0"); } catch { return []; } };
  const holders = () => readdirSync("/proc").filter((p) => /^\d+$/.test(p))
    .filter((p) => cmdline(Number(p)).includes("op-visible-9"));
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && holders().length < 2) await Bun.sleep(50);
  const pids = holders();
  const argvs = pids.map((p) => cmdline(Number(p)));
  child.kill();
  for (const pid of pids) { try { process.kill(Number(pid)); } catch {} }
  expect(argvs.some((argv) => argv.some((arg) => arg.endsWith("route-lane.ts")))).toBe(true);
  expect(argvs.some((argv) => argv.some((arg) => arg.endsWith("session-launcher.sh")) && argv.includes("--op-tag"))).toBe(true);
});

test("an existing scope unit means session_exists and nothing is started", async () => {
  const s = scenario();
  mkdirSync(join(s.root, "units"));
  writeFileSync(join(s.root, "units", "herdr-session-cs-taken.scope"), "");
  const r = await s.route([...lane, "--create-session", "cs-taken", "--op-tag", "t"]);
  expect([r.status, r.output.ok, r.output.error.code]).toEqual([1, false, "session_exists"]);
  expect(s.servers()).toEqual([]);
  expect(s.calls()).toEqual([]);
});

test("a session name already registered in herdr (running or stopped) means session_exists", async () => {
  const s = scenario();
  writeFileSync(join(s.root, "registered.json"), JSON.stringify(["cs-listed"]));
  const r = await s.route([...lane, "--create-session", "cs-listed", "--op-tag", "t"]);
  expect([r.status, r.output.error.code]).toEqual([1, "session_exists"]);
  expect(s.servers()).toEqual([]);
  expect(s.calls().some((call) => call.includes("server"))).toBe(false);
});

test("an existing session directory means session_exists and is left untouched", async () => {
  const s = scenario();
  mkdirSync(join(s.sessions, "cs-dir"), { recursive: true });
  writeFileSync(join(s.sessions, "cs-dir", "keep.json"), "{}");
  const r = await s.route([...lane, "--create-session", "cs-dir", "--op-tag", "t"]);
  expect([r.status, r.output.error.code]).toEqual([1, "session_exists"]);
  expect(s.servers()).toEqual([]);
  expect(readdirSync(join(s.sessions, "cs-dir"))).toEqual(["keep.json"]);
});

test("a stopped session with the same name still counts as existing", async () => {
  const s = scenario();
  const first = await s.route([...lane, "--create-session", "cs-again", "--op-tag", "t1"]);
  expect(first.status).toBe(0);
  for (const pid of s.servers()) process.kill(pid);
  rmSync(join(s.root, "units"), { recursive: true });
  const second = await s.route([...lane, "--create-session", "cs-again", "--op-tag", "t2"]);
  expect([second.status, second.output.error.code]).toEqual([1, "session_exists"]);
});

test("a directory written to between the atomic mkdir and the fork is session_foreign and no server starts", async () => {
  const s = scenario();
  const r = await s.route([...lane, "--create-session", "cs-old", "--op-tag", "t"], { FAKE_INJECT: "foreign-data.json" });
  expect([r.status, r.output.ok, r.output.error.code]).toEqual([1, false, "session_foreign"]);
  expect(s.servers()).toEqual([]);
  expect(s.calls().some((call) => call.includes("server"))).toBe(false);
  expect(s.calls().some((call) => call[0] === "session" && call[1] !== "list")).toBe(false);
  expect(readdirSync(join(s.sessions, "cs-old"))).toEqual(["foreign-data.json"]);
});

test("losing the mkdir race to a concurrent creator is session_exists and nothing is started", async () => {
  const s = scenario();
  const r = await s.route([...lane, "--create-session", "cs-race", "--op-tag", "t"], { FAKE_LIST_CREATES: "cs-race" });
  expect([r.status, r.output.error.code]).toEqual([1, "session_exists"]);
  expect(s.servers()).toEqual([]);
  expect(readdirSync(join(s.sessions, "cs-race"))).toEqual([]);
});

test("the op tag reaches every child process through the environment but not the long-lived server", async () => {
  const s = scenario();
  const created = await s.route([...lane, "--create-session", "cs-env", "--op-tag", "op-env-7"]);
  expect(created.output).toMatchObject({ ok: true });
  const seen = new Set(s.tags().map((line) => line.split(" ")[0]));
  expect([...seen].sort()).toEqual(["herdr", "ls", "systemctl", "systemd-run"]);
  for (const line of s.tags().filter((line) => !line.startsWith("herdr"))) expect(line.endsWith(" op-env-7")).toBe(true);
  // The fake server is a real process: its own environ must not carry the tag.
  expect(s.serverEnv()).toBe("absent");
  const [serverPid] = s.servers();
  expect(readFileSync(`/proc/${serverPid}/environ`, "utf8").split("\0").some((entry) => entry.startsWith("HERDR_LANE_OP_TAG="))).toBe(false);
  // Every non-server herdr call (list, workspace, tab, pane) carried it.
  const herdrLines = s.tags().filter((line) => line.startsWith("herdr"));
  expect(herdrLines.filter((line) => line.endsWith(" op-env-7")).length).toBeGreaterThan(3);
  expect(herdrLines.filter((line) => line.endsWith(" -"))).toHaveLength(1); // only the server itself
});

test("a socket answered by a different process than the one we started means session_foreign", async () => {
  const s = scenario();
  const r = await s.route([...lane, "--create-session", "cs-other", "--op-tag", "t"], { FAKE_FOREIGN: "other-server" });
  expect([r.status, r.output.error.code]).toEqual([1, "session_foreign"]);
  expect(s.calls().some((call) => call.includes("create"))).toBe(false);
  expect(s.calls().some((call) => call[0] === "session" && call[1] === "stop")).toBe(false);
});

test("a restored workspace in a just-created session means session_foreign", async () => {
  const s = scenario();
  const r = await s.route([...lane, "--create-session", "cs-restored", "--op-tag", "t"], { FAKE_FOREIGN: "restored" });
  expect([r.status, r.output.error.code]).toEqual([1, "session_foreign"]);
  expect(s.calls().some((call) => call.includes("create"))).toBe(false);
});

test("an unverifiable existence check fails closed as session_start_failed", async () => {
  const s = scenario();
  const r = await s.route([...lane, "--create-session", "cs-nolist", "--op-tag", "t"], { FAKE_LIST_FAIL: "1" });
  expect([r.status, r.output.error.code]).toEqual([1, "session_start_failed"]);
  expect(s.servers()).toEqual([]);
});

test("later lanes require the existing session to stay running, report created:false and carry no proof", async () => {
  const s = scenario();
  const first = await s.route([...lane, "--create-session", "cs-two", "--op-tag", "t1"]);
  expect(first.output).toMatchObject({ ok: true });
  const before = s.systemd().length;
  const second = await s.route([...lane, "--session", "cs-two", "--require-running", "--op-tag", "t2"]);
  expect(second.output).toMatchObject({ ok: true });
  expect(second.output.session).toEqual({ name: "cs-two", created: false, running_before: true, started: false, unit: null });
  expect(second.output.session.proof).toBeUndefined();
  expect(second.output.action).toBe("create-tab");
  expect(s.systemd()).toHaveLength(before);
});

test("--require-running leaves absent and stopped session resources untouched", async () => {
  const s = scenario();
  const absent = await s.route([...lane, "--session", "cs-absent", "--require-running"]);
  expect([absent.status, absent.output.error.code]).toEqual([1, "session_not_running"]);
  expect(existsSync(join(s.sessions, "cs-absent"))).toBe(false);
  expect(s.systemd()).toEqual([]);
  expect(s.servers()).toEqual([]);

  const first = await s.route([...lane, "--create-session", "cs-stopped", "--op-tag", "t1"]);
  expect(first.status).toBe(0);
  for (const pid of s.servers()) process.kill(pid);
  const dir = join(s.sessions, "cs-stopped");
  const contents = readdirSync(dir).sort();
  const workspaces = readFileSync(join(dir, "workspaces.json"), "utf8");
  const beforeCalls = s.calls().length;
  const beforeSystemd = s.systemd().length;
  const beforeServers = s.servers();
  const stopped = await s.route([...lane, "--session", "cs-stopped", "--require-running", "--op-tag", "t2"]);
  expect([stopped.status, stopped.output.error.code]).toEqual([1, "session_not_running"]);
  expect(s.systemd()).toHaveLength(beforeSystemd);
  expect(s.servers()).toEqual(beforeServers);
  expect(s.calls().slice(beforeCalls).some((call) => call.includes("create") || call.includes("server"))).toBe(false);
  expect(readdirSync(dir).sort()).toEqual(contents);
  expect(readFileSync(join(dir, "workspaces.json"), "utf8")).toBe(workspaces);
});

test("on-demand --session start keeps the op tag in systemd-run's start-up and drops it only at the server exec", async () => {
  const s = scenario();
  // systemd-run's start-up leaves a long-lived native process behind, like a slow external call would.
  const runner = join(s.root, "bin", "systemd-run");
  writeFileSync(runner, readFileSync(runner, "utf8").replace(
    "shift_to_command",
    'sleep 30 </dev/null >/dev/null 2>&1 & echo $! > "$FAKE_ROOT/startup.pid"\nshift_to_command',
  ));
  // No server is running for this name yet, so the fake herdr answers server_not_running.
  const r = await s.route([...lane, "--session", "cs-lazy", "--op-tag", "op-lazy-3"]);
  expect(r.output).toMatchObject({ ok: true });
  expect(r.output.session).toMatchObject({ name: "cs-lazy", created: false, started: true });

  const environ = (pid: number) => readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
  const startup = Number(readFileSync(join(s.root, "startup.pid"), "utf8"));
  expect(environ(startup)).toContain("HERDR_LANE_OP_TAG=op-lazy-3");

  expect(s.systemd()[0]).toContain("-- env -u HERDR_LANE_OP_TAG herdr --session cs-lazy server");
  const [serverPid] = s.servers();
  expect(environ(serverPid).some((entry) => entry.startsWith("HERDR_LANE_OP_TAG="))).toBe(false);
});
