import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { openState } from "../../scripts/lib/state-db.ts";
import { readAgentBoard } from "../lib/agent-board.ts";
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
});

test("missing file and legal v1 stay empty without creating, migrating or changing bytes", () => {
  const f = fixture("empty");
  const missing = join(f.root, "absent", "state.sqlite");
  expect(readAgentBoard(missing, f.env, 7)).toEqual({ ok: true, status: "missing", refreshed_at: 7, tasks: [] });
  expect(existsSync(join(f.root, "absent"))).toBe(false);
  const historical = join(f.root, "v1.sqlite");
  const created = new Database(historical);
  created.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);INSERT INTO meta VALUES('app','agents-cooperation');CREATE TABLE blocks(engine TEXT,model TEXT,reason TEXT,since TEXT,release_at TEXT,by TEXT);PRAGMA user_version=1;");
  created.close();
  const before = readFileSync(historical), mode = statSync(historical).mode;
  expect(readAgentBoard(historical, f.env, 8)).toEqual({ ok: true, status: "ready", refreshed_at: 8, tasks: [] });
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
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(2);
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

test("GET /api/agents returns the startup snapshot and rejects a foreign host", async () => {
  const f = fixture("http");
  const routed = join(f.root, "routed.sqlite");
  const other = join(f.root, "other.sqlite");
  for (const [path, label] of [[routed, "routed"], [other, "other-path"]] as const) {
    const db = openState(path);
    insertRun(db, {
      run_id: "run-1", collab_id: "collab-routed", owner_id: "grok", engine: "grok", host_session_id: "sess",
      label, status: "active", updated_at: 10,
    });
    insertLane(db, {
      lane_id: "lane-1", run_id: "run-1", worker_id: "grok_worker", engine: "grok", model: "grok-4",
      name: `${label}-child`, status: "open", updated_at: 10,
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
    tasks: [{ id: "collab-routed", label: "routed", owners: [{ owner_id: "grok", engine: "grok", workers: [{ name: "routed-child", model: "grok-4", worker_id: "grok_worker" }] }] }],
  });
  const overridden = await fetch(url + "/api/agents?state=" + encodeURIComponent(other));
  expect(overridden.status).toBe(200);
  expect((await overridden.json()).tasks[0].label).toBe("routed");
  const denied = await fetch(url + "/api/agents", { headers: { host: "evil.test" } });
  expect(denied.status).toBe(403);
  expect(await denied.text()).not.toContain("routed");
});
