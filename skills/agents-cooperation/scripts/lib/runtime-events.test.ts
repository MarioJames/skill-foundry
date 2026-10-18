import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openState, transaction } from "./state-db.ts";

const cleanup: string[] = [];
afterEach(() => { for (const root of cleanup.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fresh(name: string) {
  const root = mkdtempSync(join(tmpdir(), `runtime-events-${name}-`));
  cleanup.push(root);
  return join(root, "state.sqlite");
}
function events(db: Database) {
  return db.query("SELECT event_id, run_id, lane_id, kind, payload FROM runtime_events ORDER BY at, event_id").all() as { event_id: number; run_id: string; lane_id: string | null; kind: string; payload: string }[];
}
function counts(db: Database) {
  return {
    blocks: (db.query("SELECT COUNT(*) AS count FROM blocks").get() as { count: number }).count,
    runs: (db.query("SELECT COUNT(*) AS count FROM runs").get() as { count: number }).count,
    lanes: (db.query("SELECT COUNT(*) AS count FROM lanes").get() as { count: number }).count,
    events: (db.query("SELECT COUNT(*) AS count FROM runtime_events").get() as { count: number }).count,
    started: (db.query("SELECT value FROM meta WHERE key='runtime_events_started_at'").get() as { value: string }).value,
    version: (db.query("PRAGMA user_version").get() as { user_version: number }).user_version,
  };
}
function seedV2(path: string) {
  const db = new Database(path, { create: true });
  db.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta VALUES('app','agents-cooperation');
    CREATE TABLE blocks(engine TEXT NOT NULL, model TEXT, reason TEXT NOT NULL, since TEXT NOT NULL, release_at TEXT, by TEXT);
    CREATE TABLE runs(run_id TEXT PRIMARY KEY, collab_id TEXT NOT NULL, request_id TEXT NOT NULL, owner_id TEXT NOT NULL,
      engine TEXT NOT NULL, host_session_id TEXT, owner_proc TEXT, owner_pane TEXT, cwd TEXT NOT NULL, label TEXT NOT NULL,
      session_name TEXT NOT NULL UNIQUE, session_phase TEXT NOT NULL DEFAULT 'none', session_proof TEXT, session_dir_id TEXT,
      stopped_fingerprint TEXT, stop_observed_at INTEGER, status TEXT NOT NULL DEFAULT 'active', lock_proc TEXT, lock_op TEXT,
      last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, closed_at INTEGER);
    CREATE TABLE lanes(lane_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id), op_id TEXT NOT NULL,
      worker_id TEXT NOT NULL, engine TEXT NOT NULL, model TEXT NOT NULL, class TEXT NOT NULL, agent_name TEXT NOT NULL,
      workspace_id TEXT, tab_id TEXT, pane_id TEXT, status TEXT NOT NULL, outcome TEXT, health TEXT NOT NULL DEFAULT 'ok',
      keep_reason TEXT, last_progress_at INTEGER NOT NULL, last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, closed_at INTEGER,
      UNIQUE(run_id,op_id), UNIQUE(run_id,agent_name));
    PRAGMA user_version=2;`);
  db.query("INSERT INTO blocks(engine,model,reason,since) VALUES(?,?,?,?)").run("codex", "keep-model", "keep-block", "2026-01-01T00:00:00Z");
  db.query(`INSERT INTO runs(run_id,collab_id,request_id,owner_id,engine,cwd,label,session_name,status,session_proof,lock_proc,created_at,updated_at,closed_at)
    VALUES('run-old','collab-old','req-old','owner-old','codex','/secret/old','keep-label','session-old','closed','SECRET_PROOF','SECRET_LOCK',10,20,20)`).run();
  db.query(`INSERT INTO lanes(lane_id,run_id,op_id,worker_id,engine,model,class,agent_name,status,outcome,health,last_progress_at,pane_id,created_at,updated_at,closed_at)
    VALUES('lane-old','run-old','op-old','worker-old','codex','keep-model','routine','keep-name','closed','accepted','ok',20,'SECRET_PANE',11,20,20)`).run();
  db.close();
}
function insertRun(db: Database, id: string, at: number, status = "active") {
  db.query(`INSERT INTO runs(run_id,collab_id,request_id,owner_id,engine,cwd,label,session_name,status,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id, "collab", `req-${id}`, "owner", "grok", "/work", id, `session-${id}`, status, at, at);
}
function insertLane(db: Database, id: string, runId: string, at: number) {
  db.query(`INSERT INTO lanes(lane_id,run_id,op_id,worker_id,engine,model,class,agent_name,status,last_progress_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, runId, `op-${id}`, "worker", "grok", "model", "routine", id, "opening", at, at, at);
}

test("a new database has the event journal and a v2 database keeps old rows without backfill", () => {
  const created = openState(fresh("new"));
  expect(counts(created).version).toBe(3);
  expect(counts(created).events).toBe(0);
  expect(counts(created).started).toMatch(/^\d+$/);
  created.close();

  const path = fresh("upgrade");
  seedV2(path);
  const first = openState(path);
  const once = counts(first);
  expect(once).toMatchObject({ version: 3, blocks: 1, runs: 1, lanes: 1, events: 0 });
  expect(first.query("SELECT run_id,label,status,closed_at,session_proof FROM runs").get()).toEqual({ run_id: "run-old", label: "keep-label", status: "closed", closed_at: 20, session_proof: "SECRET_PROOF" });
  expect(first.query("SELECT lane_id,outcome,pane_id FROM lanes").get()).toEqual({ lane_id: "lane-old", outcome: "accepted", pane_id: "SECRET_PANE" });
  first.close();
  const second = openState(path);
  expect(counts(second)).toEqual(once);
  second.close();
});

test("status, dispatch, progress, outcome, close and errors are recorded; repeats and private columns are not", () => {
  const db = openState(fresh("record"));
  const at = 5_000;
  insertRun(db, "run-1", at);
  db.query("UPDATE runs SET status='closing', updated_at=? WHERE run_id='run-1'").run(at + 1);
  db.query("UPDATE runs SET last_error='boom', updated_at=? WHERE run_id='run-1'").run(at + 2);
  db.query("UPDATE runs SET status='closed', closed_at=?, updated_at=? WHERE run_id='run-1'").run(at + 3, at + 3);
  insertLane(db, "lane-1", "run-1", at + 4);
  db.query("UPDATE lanes SET status='open', updated_at=? WHERE lane_id='lane-1'").run(at + 5);
  db.query("UPDATE lanes SET last_progress_at=?, updated_at=? WHERE lane_id='lane-1'").run(at + 6, at + 6);
  db.query("UPDATE lanes SET outcome='accepted', updated_at=? WHERE lane_id='lane-1'").run(at + 7);
  db.query("UPDATE lanes SET keep_reason='hold', updated_at=? WHERE lane_id='lane-1'").run(at + 8);
  db.query("UPDATE lanes SET health='stale', updated_at=? WHERE lane_id='lane-1'").run(at + 9);
  db.query("UPDATE lanes SET last_error='lane-boom', updated_at=? WHERE lane_id='lane-1'").run(at + 10);
  db.query("UPDATE lanes SET status='closed', closed_at=?, updated_at=? WHERE lane_id='lane-1'").run(at + 11, at + 11);
  const recorded = events(db).map(event => event.kind);
  expect(recorded).toEqual([
    "run.created", "run.status", "run.error", "run.status",
    "lane.created", "lane.status", "lane.progress", "lane.outcome", "lane.keep_reason", "lane.health", "lane.error", "lane.status",
  ]);
  const before = events(db).length;
  db.query("UPDATE runs SET status='closed', last_error='boom', updated_at=? WHERE run_id='run-1'").run(at + 12);
  db.query("UPDATE runs SET updated_at=? WHERE run_id='run-1'").run(at + 13);
  db.query("UPDATE runs SET lock_proc='SECRET_LOCK', lock_op='SECRET_OP', session_proof='SECRET_PROOF', session_phase='creating', updated_at=? WHERE run_id='run-1'").run(at + 14);
  db.query("UPDATE lanes SET outcome='accepted', health='stale', last_progress_at=?, updated_at=? WHERE lane_id='lane-1'").run(at + 6, at + 15);
  db.query("UPDATE lanes SET pane_id='SECRET_PANE', workspace_id='SECRET_WORKSPACE', updated_at=? WHERE lane_id='lane-1'").run(at + 16);
  expect(events(db)).toHaveLength(before);
  const allowed = new Set(["status", "outcome", "keep_reason", "error", "health", "worker_id", "name", "engine", "model", "class"]);
  const stored = JSON.stringify(events(db).map(event => event.payload));
  expect(stored).not.toContain("SECRET_");
  for (const event of events(db)) {
    for (const key of Object.keys(JSON.parse(event.payload) as Record<string, unknown>)) expect(allowed.has(key)).toBe(true);
  }
  db.close();
});

test("a rolled-back transaction drops the row and its events, and the journal rejects update or delete", () => {
  const db = openState(fresh("atomic"));
  insertRun(db, "run-kept", 1);
  const before = counts(db).events;
  expect(() => transaction(db, () => {
    insertRun(db, "run-lost", 2);
    insertLane(db, "lane-lost", "run-lost", 2);
    throw new Error("abort");
  })).toThrow("abort");
  expect(db.query("SELECT run_id FROM runs").all()).toEqual([{ run_id: "run-kept" }]);
  expect(counts(db).events).toBe(before);
  expect(events(db).some(event => event.run_id === "run-lost")).toBe(false);
  expect(() => db.exec("UPDATE runtime_events SET kind='run.created'")).toThrow();
  expect(() => db.exec("DELETE FROM runtime_events")).toThrow();
  expect(counts(db).events).toBe(before);
  expect(events(db).map(event => event.kind)).toEqual(["run.created"]);
  db.close();
});
