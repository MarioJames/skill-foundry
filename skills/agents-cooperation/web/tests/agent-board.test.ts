import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { openState, STATE_VERSION } from "../../scripts/lib/state-db.ts";
import { readAgentBoard, readAgentTask } from "../lib/agent-board.ts";
import { HttpError } from "../lib/errors.ts";
import { startServer } from "../server.ts";

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

function fixture(name: string) {
  const root = mkdtempSync(join(tmpdir(), `agent-board-${name}-`));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: join(root, "home"),
    TMPDIR: root,
    AGENTS_COOPERATION_STATE: join(root, "ignored.sqlite"),
    AGENTS_COOPERATION_CONFIG: join(root, "missing-config.json"),
  };
  return { root, env };
}
function failure(path: string, env: Record<string, string | undefined>) {
  try { readAgentBoard(path, env, 1); }
  catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    return error as HttpError;
  }
  throw new Error("read returned a snapshot");
}
function taskFailure(path: string, env: Record<string, string | undefined>, taskId = "missing") {
  try { readAgentTask(taskId, path, env, 1); }
  catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    return error as HttpError;
  }
  throw new Error("read returned a detail");
}
function insertRun(db: Database, row: {
  run_id: string; collab_id: string; owner_id: string; engine: string; label: string; updated_at: number;
  host_session_id?: string | null; status?: string; last_error?: string | null;
  owner_proc?: string | null; lock_proc?: string | null; session_proof?: string | null; cwd?: string;
  owner_pane?: string | null; lock_op?: string | null; session_dir_id?: string | null; stopped_fingerprint?: string | null;
  request_id?: string; session_name?: string;
}) {
  db.query(`INSERT INTO runs(
    run_id,collab_id,request_id,owner_id,engine,host_session_id,owner_proc,owner_pane,cwd,label,session_name,
    session_proof,session_dir_id,stopped_fingerprint,status,lock_proc,lock_op,last_error,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    row.run_id, row.collab_id, row.request_id ?? `req-${row.run_id}`, row.owner_id, row.engine, row.host_session_id ?? null,
    row.owner_proc ?? null, row.owner_pane ?? null, row.cwd ?? "/work", row.label, row.session_name ?? `session-${row.run_id}`,
    row.session_proof ?? null, row.session_dir_id ?? null, row.stopped_fingerprint ?? null, row.status ?? "closed",
    row.lock_proc ?? null, row.lock_op ?? null, row.last_error ?? null, row.updated_at, row.updated_at,
  );
}
function insertLane(db: Database, row: {
  lane_id: string; run_id: string; worker_id: string; engine: string; model: string; name: string; status: string; updated_at: number;
  outcome?: string | null; health?: string; keep_reason?: string | null; last_error?: string | null; last_progress_at?: number;
  op_id?: string; class?: string; workspace_id?: string | null; tab_id?: string | null; pane_id?: string | null;
}) {
  db.query(`INSERT INTO lanes(
    lane_id,run_id,op_id,worker_id,engine,model,class,agent_name,workspace_id,tab_id,pane_id,
    status,outcome,health,keep_reason,last_progress_at,last_error,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    row.lane_id, row.run_id, row.op_id ?? `op-${row.lane_id}`, row.worker_id, row.engine, row.model, row.class ?? "routine", row.name,
    row.workspace_id ?? null, row.tab_id ?? null, row.pane_id ?? null, row.status, row.outcome ?? null, row.health ?? "ok",
    row.keep_reason ?? null, row.last_progress_at ?? row.updated_at, row.last_error ?? null, row.updated_at, row.updated_at,
  );
}

test("groups tasks, owners and workers without exposing private fields", () => {
  const f = fixture("group");
  const state = join(f.root, "state.sqlite");
  const db = openState(state);
  insertRun(db, {
    run_id: "run-live-1", collab_id: "collab-live", owner_id: "grok", engine: "grok", host_session_id: "sess-a",
    label: "live", status: "active", updated_at: 100, last_error: null,
    request_id: "SECRET_REQUEST", session_name: "SECRET_SESSION_NAME", cwd: "/SECRET_ABSOLUTE/cwd",
    owner_proc: "SECRET_OWNER_PROC", owner_pane: "SECRET_OWNER_PANE", lock_proc: "SECRET_LOCK_PROC", lock_op: "SECRET_LOCK_OP",
    session_proof: "SECRET_SESSION_PROOF", session_dir_id: "SECRET_DIR", stopped_fingerprint: "SECRET_FINGERPRINT",
  });
  insertLane(db, {
    lane_id: "lane-1", run_id: "run-live-1", worker_id: "w1", engine: "grok", model: "old-model", name: "child-a",
    status: "open", updated_at: 120, last_progress_at: 1, health: "ok",
    op_id: "SECRET_OP", class: "SECRET_CLASS", workspace_id: "SECRET_WORKSPACE", tab_id: "SECRET_TAB", pane_id: "SECRET_PANE",
  });
  insertRun(db, {
    run_id: "run-live-2", collab_id: "collab-live", owner_id: "grok", engine: "grok", host_session_id: "sess-a",
    label: "", status: "closed", updated_at: 300, last_error: "run-error",
  });
  insertLane(db, {
    lane_id: "lane-2", run_id: "run-live-2", worker_id: "w1", engine: "grok", model: "lane-model", name: "child-b",
    status: "closed", outcome: "failed", health: "stale", keep_reason: "keeping", last_error: "lane-error", updated_at: 500,
  });
  insertRun(db, {
    run_id: "run-other-host", collab_id: "collab-live", owner_id: "grok", engine: "grok", host_session_id: "sess-b",
    label: "other-host", status: "closing", updated_at: 150,
  });
  insertLane(db, {
    lane_id: "lane-other", run_id: "run-other-host", worker_id: "w9", engine: "grok", model: "host-model", name: "other-child",
    status: "unknown", updated_at: 150,
  });
  insertRun(db, {
    run_id: "run-diff-engine", collab_id: "collab-live", owner_id: "grok", engine: "codex", host_session_id: "sess-a",
    label: "diff-engine", status: "closed", updated_at: 90,
  });
  insertRun(db, { run_id: "run-a", collab_id: "collab-live", owner_id: "grok", engine: "grok", label: "nohost-a", updated_at: 80 });
  insertRun(db, { run_id: "run-b", collab_id: "collab-live", owner_id: "grok", engine: "grok", label: "nohost-b", updated_at: 80 });
  insertRun(db, {
    run_id: "run-old", collab_id: "collab-old", owner_id: "claude", engine: "claude", host_session_id: "sess-c",
    label: "old-task", status: "closed", updated_at: 200,
  });
  insertLane(db, {
    lane_id: "lane-old", run_id: "run-old", worker_id: "w1", engine: "claude", model: "claude-model", name: "old-child",
    status: "closed", outcome: "accepted", updated_at: 200,
  });
  insertRun(db, { run_id: "run-aaa", collab_id: "collab-aaa", owner_id: "grok", engine: "grok", host_session_id: "sess-z", label: "aaa", updated_at: 50 });
  insertRun(db, { run_id: "run-zzz", collab_id: "collab-zzz", owner_id: "grok", engine: "grok", host_session_id: "sess-y", label: "zzz", updated_at: 50 });
  db.close();
  const before = readFileSync(state), mode = statSync(state).mode;
  const walPath = state + "-wal", walBefore = existsSync(walPath) ? readFileSync(walPath) : null;
  const snapshot = readAgentBoard(state, f.env, 42);
  expect(readFileSync(state)).toEqual(before);
  expect(statSync(state).mode).toBe(mode);
  if (walBefore) expect(readFileSync(walPath)).toEqual(walBefore);
  expect(snapshot).toMatchObject({ ok: true, status: "ready", refreshed_at: 42 });
  expect(snapshot.tasks.map(task => task.id)).toEqual(["collab-live", "collab-old", "collab-aaa", "collab-zzz"]);
  const live = snapshot.tasks[0];
  expect(live).toMatchObject({ label: "other-host", status: "active", updated_at: 500 });
  expect(live.owners.map(owner => owner.id)).toEqual([
    "grok:grok:sess-a", "grok:grok:sess-b", "grok:codex:sess-a", "run-a", "run-b",
  ]);
  expect(live.owners[0]).toMatchObject({ owner_id: "grok", engine: "grok", status: "active", updated_at: 500, last_error: "run-error" });
  expect(Object.keys(live.owners[0])).not.toContain("model");
  expect(live.owners[0].workers.map(worker => [worker.id, worker.worker_id, worker.name])).toEqual([
    ["lane-2", "w1", "child-b"],
    ["lane-1", "w1", "child-a"],
  ]);
  expect(live.owners[0].workers[0]).toMatchObject({
    engine: "grok", model: "lane-model", status: "closed", outcome: "failed", health: "stale", keep_reason: "keeping", last_error: "lane-error",
  });
  expect(live.owners[0].workers[1]).toMatchObject({ model: "old-model", status: "open", outcome: null, health: "ok", last_progress_at: 1 });
  expect(live.owners[1]).toMatchObject({ owner_id: "grok", engine: "grok", status: "closing", updated_at: 150, last_error: null });
  expect(live.owners[1].workers.map(worker => [worker.name, worker.status, worker.worker_id])).toEqual([["other-child", "unknown", "w9"]]);
  expect(live.owners[2]).toMatchObject({ id: "grok:codex:sess-a", engine: "codex", workers: [] });
  const old = snapshot.tasks[1];
  expect(old.owners.map(owner => owner.id)).toEqual(["claude:claude:sess-c"]);
  expect(old.owners[0].workers.map(worker => [worker.name, worker.worker_id, worker.outcome, worker.model])).toEqual([["old-child", "w1", "accepted", "claude-model"]]);
  expect(JSON.stringify(live)).not.toContain("old-child");
  expect(JSON.stringify(snapshot)).not.toContain("SECRET_");
  expect(snapshot.tasks.map(task => [task.id, task.bucket, task.created_at])).toEqual([
    ["collab-live", "in_progress", 80],
    ["collab-old", "completed", 200],
    ["collab-aaa", "closed", 50],
    ["collab-zzz", "closed", 50],
  ]);
  expect(snapshot.tasks.every(task => !("events" in task))).toBe(true);
  expect(live.owners[0].workers[0].closed_at).toBeNull();
  const oldDetail = readAgentTask("collab-old", state, f.env, 42);
  expect(oldDetail.history_incomplete).toBe(false);
  expect(oldDetail.task.bucket).toBe("completed");
  expect(oldDetail.events.map(event => event.kind).sort()).toEqual(["lane.created", "lane.outcome", "run.created"]);
  expect(oldDetail.events.find(event => event.kind === "run.created")).toMatchObject({ source: "recorded", owner_id: "claude", worker_name: null });
  expect(oldDetail.events.filter(event => event.lane_id === "lane-old").every(event => event.source === "recorded" && event.owner_id === "claude" && event.worker_name === "old-child")).toBe(true);
  expect(oldDetail.events.map(event => Number(event.id))).toEqual([...oldDetail.events.map(event => Number(event.id))].sort((left, right) => left - right));
  expect(oldDetail.events.some(event => event.kind === "run.closed" || event.kind === "lane.closed" || event.owner_id === "")).toBe(false);
  const liveDetail = readAgentTask("collab-live", state, f.env, 42);
  expect(JSON.stringify(liveDetail)).not.toContain("SECRET_");
  expect(liveDetail.events.every(event => event.owner_id !== "" && event.engine !== "")).toBe(true);
  expect(liveDetail.events.some(event => event.lane_id === "lane-1" && event.worker_id === "w1" && event.worker_name === "child-a" && event.model === "old-model")).toBe(true);
});

test("missing file and legal v1 stay empty without creating, migrating or changing bytes", () => {
  const f = fixture("empty");
  const missing = join(f.root, "absent", "state.sqlite");
  expect(readAgentBoard(missing, f.env, 7)).toEqual({ ok: true, status: "missing", refreshed_at: 7, tasks: [] });
  expect(taskFailure(missing, f.env).status).toBe(404);
  expect(existsSync(join(f.root, "absent"))).toBe(false);
  const historical = join(f.root, "v1.sqlite");
  const created = new Database(historical);
  created.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);INSERT INTO meta VALUES('app','agents-cooperation');CREATE TABLE blocks(engine TEXT,model TEXT,reason TEXT,since TEXT,release_at TEXT,by TEXT);PRAGMA user_version=1;");
  created.close();
  const before = readFileSync(historical), mode = statSync(historical).mode;
  expect(readAgentBoard(historical, f.env, 8)).toEqual({ ok: true, status: "ready", refreshed_at: 8, tasks: [] });
  expect(taskFailure(historical, f.env, "any").status).toBe(404);
  expect(readFileSync(historical)).toEqual(before);
  expect(statSync(historical).mode).toBe(mode);
  expect(existsSync(historical + "-wal")).toBe(false);
  expect(existsSync(historical + "-journal")).toBe(false);
  const verify = new Database(historical, { readonly: true, create: false });
  expect((verify.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(1);
  expect(verify.query("SELECT name FROM sqlite_master WHERE name='runs'").get()).toBeNull();
  verify.close();
  expect(readFileSync(historical)).toEqual(before);
});

test("reads committed WAL rows and rejects corrupt, future and foreign databases", () => {
  const f = fixture("wal");
  const live = join(f.root, "live.sqlite");
  const db = openState(live);
  try {
    db.exec("PRAGMA wal_autocheckpoint=0; PRAGMA wal_checkpoint(TRUNCATE)");
    insertRun(db, {
      run_id: "run-wal", collab_id: "collab-wal", owner_id: "grok", engine: "grok", host_session_id: "sess-wal",
      label: "wal-live", status: "active", updated_at: 9,
    });
    const main = readFileSync(live), wal = readFileSync(live + "-wal"), mode = statSync(live).mode;
    expect(wal.byteLength).toBeGreaterThan(0);
    const snapshot = readAgentBoard(live, f.env, 9);
    expect(snapshot).toMatchObject({ ok: true, status: "ready", refreshed_at: 9, tasks: [{ id: "collab-wal", label: "wal-live", status: "active" }] });
    expect(readFileSync(live)).toEqual(main);
    expect(readFileSync(live + "-wal")).toEqual(wal);
    expect(statSync(live).mode).toBe(mode);
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(STATE_VERSION);
  } finally { db.close(); }

  const corrupt = join(f.root, "corrupt.sqlite");
  const garbage = Buffer.from("not a sqlite database");
  writeFileSync(corrupt, garbage);
  const corruptMode = statSync(corrupt).mode;
  const corruptError = failure(corrupt, f.env);
  expect(corruptError.status).toBe(503);
  expect(readFileSync(corrupt)).toEqual(garbage);
  expect(statSync(corrupt).mode).toBe(corruptMode);
  expect(existsSync(corrupt + "-wal")).toBe(false);
  expect(existsSync(corrupt + "-journal")).toBe(false);

  const futurePath = join(f.root, "future.sqlite");
  const future = openState(futurePath);
  future.exec("PRAGMA user_version=999");
  future.close();
  const futureBytes = readFileSync(futurePath), futureMode = statSync(futurePath).mode;
  const futureError = failure(futurePath, f.env);
  expect(futureError.status).toBe(503);
  expect(readFileSync(futurePath)).toEqual(futureBytes);
  expect(statSync(futurePath).mode).toBe(futureMode);

  const foreignPath = join(f.root, "foreign.sqlite");
  const foreign = openState(foreignPath);
  foreign.exec("UPDATE meta SET value='foreign' WHERE key='app'");
  foreign.close();
  const foreignBytes = readFileSync(foreignPath), foreignMode = statSync(foreignPath).mode;
  const foreignError = failure(foreignPath, f.env);
  expect(foreignError.status).toBe(503);
  expect(readFileSync(foreignPath)).toEqual(foreignBytes);
  expect(statSync(foreignPath).mode).toBe(foreignMode);
});

test("closed with an error stays closed, and same-millisecond events from parallel lanes sort numerically", () => {
  const f = fixture("buckets");
  const state = join(f.root, "state.sqlite");
  const db = openState(state);
  const at = 8_000;
  insertRun(db, { run_id: "run-error", collab_id: "collab-error", owner_id: "grok", engine: "grok", host_session_id: "sess", label: "errored", status: "closed", updated_at: at, last_error: "still-broken" });
  insertLane(db, { lane_id: "lane-error", run_id: "run-error", worker_id: "w1", engine: "grok", model: "m", name: "done-child", status: "closed", outcome: "accepted", updated_at: at });
  insertRun(db, { run_id: "run-a", collab_id: "collab-parallel", owner_id: "grok", engine: "grok", host_session_id: "sess-a", label: "parallel", status: "active", updated_at: at });
  insertRun(db, { run_id: "run-b", collab_id: "collab-parallel", owner_id: "claude", engine: "claude", host_session_id: "sess-b", label: "parallel", status: "active", updated_at: at });
  for (let index = 0; index < 6; index += 1) {
    insertLane(db, { lane_id: `lane-a-${index}`, run_id: "run-a", worker_id: `wa-${index}`, engine: "grok", model: "ga", name: `child-a-${index}`, status: "open", updated_at: at });
    insertLane(db, { lane_id: `lane-b-${index}`, run_id: "run-b", worker_id: `wb-${index}`, engine: "claude", model: "cb", name: `child-b-${index}`, status: "opening", updated_at: at });
  }
  db.close();
  const board = readAgentBoard(state, f.env, 3);
  expect(board.tasks.find(task => task.id === "collab-error")).toMatchObject({ bucket: "closed", status: "closed" });
  const detail = readAgentTask("collab-parallel", state, f.env, 3);
  expect(detail.history_incomplete).toBe(false);
  expect(detail.events.length).toBeGreaterThan(10);
  expect(detail.events.every(event => event.at === at)).toBe(true);
  const ids = detail.events.map(event => event.id);
  expect(ids.map(Number)).toEqual([...ids.map(Number)].sort((left, right) => left - right));
  expect(ids).not.toEqual([...ids].sort());
  const lane = detail.events.find(event => event.lane_id === "lane-b-3");
  expect(lane).toMatchObject({ owner_id: "claude", owner_key: "claude:claude:sess-b", worker_id: "wb-3", worker_name: "child-b-3", engine: "claude", model: "cb", source: "recorded" });
  expect(detail.events.find(event => event.lane_id === "lane-a-0")).toMatchObject({ owner_id: "grok", owner_key: "grok:grok:sess-a", worker_name: "child-a-0" });
  expect(detail.events.some(event => event.owner_id === "" || event.engine === "")).toBe(false);
});

test("v2 detail is read-only and only reports known creation and close times", () => {
  const f = fixture("v2");
  const state = join(f.root, "v2.sqlite");
  const db = new Database(state);
  db.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta VALUES('app','agents-cooperation');
    CREATE TABLE blocks(engine TEXT NOT NULL, model TEXT, reason TEXT NOT NULL, since TEXT NOT NULL, release_at TEXT, by TEXT);
    CREATE TABLE runs(run_id TEXT PRIMARY KEY, collab_id TEXT NOT NULL, request_id TEXT NOT NULL, owner_id TEXT NOT NULL,
      engine TEXT NOT NULL, cwd TEXT NOT NULL, label TEXT NOT NULL, session_name TEXT NOT NULL UNIQUE, status TEXT NOT NULL,
      last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, closed_at INTEGER, host_session_id TEXT);
    CREATE TABLE lanes(lane_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, worker_id TEXT NOT NULL, agent_name TEXT NOT NULL,
      engine TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL, outcome TEXT, health TEXT NOT NULL, keep_reason TEXT,
      last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_progress_at INTEGER NOT NULL, closed_at INTEGER);
    PRAGMA user_version=2;`);
  db.query(`INSERT INTO runs(run_id,collab_id,request_id,owner_id,engine,host_session_id,cwd,label,session_name,status,created_at,updated_at,closed_at)
    VALUES('run-v2','collab-v2','req','owner','grok','sess','/secret/path','old','session','closed',10,99,30)`).run();
  db.query(`INSERT INTO lanes(lane_id,run_id,worker_id,agent_name,engine,model,status,outcome,health,last_progress_at,created_at,updated_at,closed_at)
    VALUES('lane-v2','run-v2','worker','old-child','grok','old-model','closed',NULL,'ok',99,11,99,NULL)`).run();
  db.close();
  const before = readFileSync(state), mode = statSync(state).mode;
  const board = readAgentBoard(state, f.env, 4);
  const detail = readAgentTask("collab-v2", state, f.env, 4);
  expect(readFileSync(state)).toEqual(before);
  expect(statSync(state).mode).toBe(mode);
  const verify = new Database(state, { readonly: true, create: false });
  expect((verify.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(2);
  verify.close();
  expect(board.tasks).toEqual([expect.objectContaining({ id: "collab-v2", bucket: "closed", created_at: 10, status: "closed" })]);
  expect("events" in board.tasks[0]).toBe(false);
  expect(detail.history_incomplete).toBe(true);
  expect(detail.events.map(event => [event.kind, event.source, event.at, event.worker_name])).toEqual([
    ["run.created", "milestone", 10, null],
    ["lane.created", "milestone", 11, "old-child"],
    ["run.closed", "milestone", 30, null],
  ]);
  expect(detail.events.some(event => event.kind === "lane.closed" || event.kind === "lane.outcome" || event.kind === "lane.progress" || event.owner_id === "")).toBe(false);
  expect(JSON.stringify(detail)).not.toContain("/secret/path");
  expect(taskFailure(state, f.env, "missing-v2").status).toBe(404);
  expect(readFileSync(state)).toEqual(before);
});

test("GET /api/agents returns the startup snapshot and rejects a foreign host", async () => {
  const f = fixture("http");
  const routed = join(f.root, "routed.sqlite");
  const other = join(f.root, "other.sqlite");
  for (const [path, label] of [[routed, "routed"], [other, "other-path"]] as const) {
    const db = openState(path);
    insertRun(db, {
      run_id: "run-1", collab_id: "collab/任务", owner_id: "grok", engine: "grok", host_session_id: "sess",
      label, status: "active", updated_at: 10,
      cwd: "/SECRET_PATH", session_proof: "SECRET_PROOF", owner_proc: "SECRET_PROC", owner_pane: "SECRET_PANE",
    });
    insertLane(db, {
      lane_id: "lane-1", run_id: "run-1", worker_id: "grok_worker", engine: "grok", model: "grok-4",
      name: `${label}-child`, status: "open", updated_at: 10,
      class: "SECRET_CLASS", pane_id: "SECRET_PANE", workspace_id: "SECRET_WORKSPACE",
    });
    db.close();
  }
  const entrypoint = join(f.root, "index.html");
  writeFileSync(entrypoint, '<!doctype html><link rel="stylesheet" href="./style.css"><script type="module" src="./app.ts"></script><div>测试页面</div>');
  writeFileSync(join(f.root, "app.ts"), 'document.title="本地测试";');
  writeFileSync(join(f.root, "style.css"), "body{color:rgb(10,20,30)}");
  const env = { ...f.env, AGENTS_COOPERATION_STATE: other };
  const server = await startServer({ env, port: 0, entrypoint, state: routed });
  cleanup.push(() => server.stop(true));
  const url = `http://127.0.0.1:${server.port}`;
  const ok = await fetch(url + "/api/agents");
  expect(ok.status).toBe(200);
  expect(ok.headers.get("content-type")).toContain("application/json");
  expect(ok.headers.get("cache-control")).toBe("no-store");
  expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
  const body = await ok.json();
  expect(body).toMatchObject({
    ok: true, status: "ready",
    tasks: [{ id: "collab/任务", bucket: "in_progress", label: "routed", owners: [{ owner_id: "grok", engine: "grok", workers: [{ name: "routed-child", model: "grok-4", worker_id: "grok_worker" }] }] }],
  });
  expect(body.tasks[0].events).toBeUndefined();
  expect(JSON.stringify(body)).not.toContain("SECRET_");
  const overridden = await fetch(url + "/api/agents?state=" + encodeURIComponent(other));
  expect(overridden.status).toBe(200);
  expect((await overridden.json()).tasks[0].label).toBe("routed");
  const denied = await fetch(url + "/api/agents", { headers: { host: "evil.test" } });
  expect(denied.status).toBe(403);
  expect(await denied.text()).not.toContain("routed");
  const taskPath = "/api/agents/" + encodeURIComponent("collab/任务");
  const detail = await fetch(url + taskPath);
  expect(detail.status).toBe(200);
  expect(detail.headers.get("cache-control")).toBe("no-store");
  const task = await detail.json();
  expect(task.task).toMatchObject({ id: "collab/任务", label: "routed", bucket: "in_progress" });
  expect(task.history_incomplete).toBe(false);
  expect(task.events.map((event: { kind: string; worker_name: string | null }) => [event.kind, event.worker_name])).toEqual([
    ["run.created", null],
    ["lane.created", "routed-child"],
  ]);
  expect(JSON.stringify(task)).not.toContain("SECRET_");
  const detailOverride = await fetch(url + taskPath + "?state=" + encodeURIComponent(other));
  expect(detailOverride.status).toBe(200);
  expect((await detailOverride.json()).task.label).toBe("routed");
  const missing = await fetch(url + "/api/agents/" + encodeURIComponent("missing-task"));
  expect(missing.status).toBe(404);
  const bad = await fetch(url + "/api/agents/%ZZ");
  expect(bad.status).toBe(400);
  const detailDenied = await fetch(url + taskPath, { headers: { host: "evil.test" } });
  expect(detailDenied.status).toBe(403);
  expect(await detailDenied.text()).not.toContain("routed");
});
