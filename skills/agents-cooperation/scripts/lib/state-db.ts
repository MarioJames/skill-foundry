/** Private durable state. No external command runs inside a database transaction. */
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { lintSchema, validate } from "./json-schema.ts";

export interface Block { engine: string; model?: string; reason: string; since: string; release_at?: string; by?: string }
export const STATE_VERSION = 2;
export function statePath(flag?: string, env: Record<string,string|undefined> = process.env) {
  return resolve(flag ?? env.AGENTS_COOPERATION_STATE ?? join(env.HOME ?? homedir(), ".local/state/agents-cooperation/state.sqlite"));
}
export function defaultStatePath(env: Record<string,string|undefined> = process.env) { return statePath(undefined, { HOME: env.HOME }); }
export function transaction<T>(db: Database, action: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try { const value = action(); db.exec("COMMIT"); return value; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}
const diagnostics = new WeakMap<Database,string[]>();
export const stateWarnings = (db: Database) => diagnostics.get(db) ?? [];
const migrations = [
  (db: Database) => db.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta VALUES('app','agents-cooperation');
    CREATE TABLE blocks(engine TEXT NOT NULL, model TEXT, reason TEXT NOT NULL, since TEXT NOT NULL, release_at TEXT, by TEXT);
    CREATE UNIQUE INDEX blocks_engine ON blocks(engine) WHERE model IS NULL;
    CREATE UNIQUE INDEX blocks_model ON blocks(engine,model) WHERE model IS NOT NULL;`),
  (db: Database) => {
    // Verify historical rows before changing the schema.
    for (const row of db.query("SELECT * FROM blocks").all() as any[]) validateLegacy({version:1, blocks:[blockFromRow(row)]});
    db.exec(`CREATE TABLE runs(run_id TEXT PRIMARY KEY, collab_id TEXT NOT NULL, request_id TEXT NOT NULL, owner_id TEXT NOT NULL,
      engine TEXT NOT NULL, host_session_id TEXT, owner_proc TEXT, owner_pane TEXT, cwd TEXT NOT NULL, label TEXT NOT NULL,
      session_name TEXT NOT NULL UNIQUE, session_phase TEXT NOT NULL DEFAULT 'none' CHECK(session_phase IN ('none','creating','created','stopping','stopped','deleting','deleted','unknown')),
      session_proof TEXT, session_dir_id TEXT, stopped_fingerprint TEXT, stop_observed_at INTEGER,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','closing','closed')), lock_proc TEXT, lock_op TEXT, last_error TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, closed_at INTEGER);
      CREATE TABLE lanes(lane_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id), op_id TEXT NOT NULL,
      worker_id TEXT NOT NULL, engine TEXT NOT NULL, model TEXT NOT NULL, class TEXT NOT NULL, agent_name TEXT NOT NULL,
      workspace_id TEXT, tab_id TEXT, pane_id TEXT, status TEXT NOT NULL CHECK(status IN ('opening','open','closing','closed','unknown')),
      outcome TEXT CHECK(outcome IN ('accepted','failed')), health TEXT NOT NULL DEFAULT 'ok' CHECK(health IN ('ok','stale')),
      keep_reason TEXT, last_progress_at INTEGER NOT NULL, last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, closed_at INTEGER,
      UNIQUE(run_id,op_id), UNIQUE(run_id,agent_name));`);
  },
];
export function validateLegacy(value: unknown): asserts value is {version:1;blocks:Block[]} {
  const schema = JSON.parse(readFileSync(join(import.meta.dir, "../../assets/availability.schema.json"), "utf8"));
  lintSchema(schema);
  const issues = validate(schema, value);
  const seen = new Set<string>();
  if (!issues.length) for (const b of (value as any).blocks) {
    const key = JSON.stringify([b.engine,b.model ?? null]);
    if (seen.has(key)) issues.push({path:"$.blocks",message:"duplicate (engine, model) block"});
    seen.add(key);
    if (Number.isNaN(Date.parse(b.since)) || (b.release_at && Number.isNaN(Date.parse(b.release_at)))) issues.push({path:"$.blocks",message:"invalid timestamp"});
  }
  if (issues.length) throw new Error(`invalid availability snapshot: ${issues.map(i=>`${i.path}: ${i.message}`).join('; ')}`);
}
function blockFromRow(row: any): Block { return Object.fromEntries(Object.entries(row).filter(([,v])=>v!==null)) as unknown as Block; }
export function listBlocks(db: Database): Block[] { return (db.query("SELECT * FROM blocks ORDER BY rowid").all() as any[]).map(blockFromRow); }
export function upsertBlock(db: Database, b: Block) {
  const target = b.model === undefined ? "(engine) WHERE model IS NULL" : "(engine,model) WHERE model IS NOT NULL";
  db.query(`INSERT INTO blocks(engine,model,reason,since,release_at,by) VALUES(?,?,?,?,?,?) ON CONFLICT ${target} DO UPDATE SET reason=excluded.reason,since=excluded.since,release_at=excluded.release_at,by=excluded.by`).run(b.engine,b.model??null,b.reason,b.since,b.release_at??null,b.by??null);
}
export function removeBlock(db: Database, engine: string, model?: string) { return db.query("DELETE FROM blocks WHERE engine=? AND model IS ?").run(engine,model??null).changes; }
export function purgeExpired(db: Database, now: number) { return db.query("DELETE FROM blocks WHERE release_at IS NOT NULL AND julianday(release_at)<=julianday(?)").run(new Date(now).toISOString()).changes; }
export interface ImportRecord { snapshot: string; sha256: string; source: string }
/** Filesystem rename is deliberately inside the write lock. A rollback leaves a recoverable snapshot. */
export function migrateAvailability(db: Database, source: string, options: {automatic?:boolean} = {}): { imported: number; warnings: string[] } {
  source = resolve(source);
  const warnings: string[] = [];
  const cleanup: ImportRecord[] = [];
  const imported = transaction(db, () => {
    const raw = db.query("SELECT value FROM meta WHERE key='availability_imports'").get() as any;
    const records: ImportRecord[] = raw ? JSON.parse(raw.value) : [];
    if (!Array.isArray(records) || records.some(r=>typeof r.snapshot!=="string"||typeof r.sha256!=="string"||typeof r.source!=="string")) throw new Error("invalid availability_imports metadata");
    const directory = dirname(source), prefix = source.slice(directory.length+1)+".importing-";
    const snapshots = existsSync(directory) ? readdirSync(directory).filter(n=>n.startsWith(prefix)).map(n=>join(directory,n)) : [];
    const pending = snapshots.filter(p=>!records.some(r=>r.snapshot===p));
    if (pending.length > 1) throw new Error(`multiple unrecorded availability snapshots; preserve and reconcile manually: ${pending.join(', ')}`);
    let snapshot = pending[0];
    // Validate unrecorded recovery before claiming any new source.
    if (snapshot) {
      try { validateLegacy(JSON.parse(readFileSync(snapshot,"utf8"))); }
      catch(error) { throw new Error(`cannot validate availability snapshot ${snapshot}; preserved, reconcile or restore it before retrying: ${(error as Error).message}`); }
    }
    const previous = records.filter(r=>r.source===source);
    cleanup.push(...records.filter(r=>existsSync(r.snapshot)));
    if (!snapshot && existsSync(source)) {
      if (previous.length && options.automatic) { warnings.push(`availability source recreated; preserved without importing: ${source}`); return 0; }
      if (!options.automatic) {
        const sha=createHash('sha256').update(readFileSync(source)).digest('hex');
        if(records.some(r=>r.sha256===sha)) return 0;
      }
      snapshot = `${source}.importing-${Date.now()}-${randomBytes(6).toString('hex')}`;
      renameSync(source,snapshot);
    }
    if (!snapshot) return 0;
    const bytes = readFileSync(snapshot), sha256 = createHash('sha256').update(bytes).digest('hex');
    const value = JSON.parse(bytes.toString()); validateLegacy(value);
    const already = records.some(r=>r.sha256===sha256);
    if (!already) for (const b of value.blocks) upsertBlock(db,b);
    const record = {snapshot,sha256,source}; records.push(record); cleanup.push(record);
    db.query("INSERT INTO meta(key,value) VALUES('availability_imports',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(records));
    if (existsSync(source)) warnings.push(`availability source recreated; preserved without importing: ${source}`);
    return already ? 0 : value.blocks.length;
  });
  transaction(db,()=>{for (const r of cleanup) {
    try {
      if (createHash('sha256').update(readFileSync(r.snapshot)).digest('hex')!==r.sha256) throw new Error(`availability snapshot changed; preserved: ${r.snapshot}`);
      unlinkSync(r.snapshot);
    } catch(error) { if((error as any).code!=='ENOENT') throw error; }
  }});
  return {imported,warnings};
}
export function openState(path: string, options: { migrateFrom?: string } = {}): Database {
  path=resolve(path);
  if (existsSync(path)) {
    const bytes = readFileSync(path);
    if (bytes.length && bytes.subarray(0,16).toString()!=="SQLite format 3\0") throw new Error(`state is not SQLite: ${path}; use --state <sqlite-file> and migrate-availability --from <legacy-json>`);
  }
  mkdirSync(dirname(path),{recursive:true,mode:0o700});
  const db = new Database(path,{create:true});
  try {
    db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
    transaction(db,()=>{
      let version = (db.query("PRAGMA user_version").get() as any).user_version;
      if (version > STATE_VERSION) throw new Error(`future state version ${version}`);
      const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as any[];
      if (version===0 && tables.length) throw new Error("state database belongs to another application");
      if (version>0 && (db.query("SELECT value FROM meta WHERE key='app'").get() as any)?.value!=="agents-cooperation") throw new Error("state database belongs to another application");
      while(version<STATE_VERSION) { migrations[version](db); db.exec(`PRAGMA user_version=${++version}`); }
    });
    chmodSync(path,0o600);
    db.exec("PRAGMA journal_mode=WAL");
    diagnostics.set(db,options.migrateFrom ? migrateAvailability(db,options.migrateFrom,{automatic:true}).warnings : []);
    return db;
  } catch(error) { db.close(); throw error; }
}
export function openConfiguredState(flag?: string, env: Record<string,string|undefined> = process.env) {
  const path = statePath(flag,env);
  return openState(path,{migrateFrom:path===defaultStatePath(env)?join(dirname(path),"availability.json"):undefined});
}
