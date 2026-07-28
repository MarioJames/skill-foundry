import { Database, type Statement } from "bun:sqlite";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";

import * as runtimeEnv from "./runtime_env.ts";
import { canonicalJson, isRecord, RuntimeError, type RuntimeRecord, ValueError } from "./runtime_types.ts";

export const RUNTIME_HOME_ENV = runtimeEnv.name("HOME");
export const RUNTIME_HOME_DIRECTORY = runtimeEnv.RUNTIME_HOME_DIRECTORY;
export const SCHEMA_VERSION = 4;
export const BUSY_TIMEOUT_MS = 5_000;
const RUNTIME_ASSET_MANIFEST = ".runtime-assets.json";
const RUNTIME_ASSET_LOCK = ".runtime-assets.lock";

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  root_id TEXT PRIMARY KEY,
  goal TEXT NOT NULL,
  cwd TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK (
    status IN ('running', 'stopping', 'done', 'failed', 'cancelled')
  ),
  root_task_id INTEGER REFERENCES tasks(task_id),
  max_concurrent_agents INTEGER NOT NULL DEFAULT 8,
  max_total_tasks INTEGER NOT NULL DEFAULT 100,
  max_attempts_per_task INTEGER NOT NULL DEFAULT 2,
  max_delegation_depth INTEGER NOT NULL DEFAULT 5,
  max_replans_per_task INTEGER NOT NULL DEFAULT 2,
  max_children_per_action INTEGER NOT NULL DEFAULT 12,
  require_final_review INTEGER NOT NULL DEFAULT 1,
  model_tiers_json TEXT NOT NULL,
  execution_config_json TEXT NOT NULL,
  token_seed_ref TEXT,
  token_seed_hash TEXT,
  owner_token_hash TEXT,
  lease_epoch INTEGER NOT NULL DEFAULT 0,
  lease_expires_at REAL,
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL,
  finished_at REAL
);

CREATE TABLE IF NOT EXISTS tasks (
  task_id INTEGER PRIMARY KEY,
  root_id TEXT NOT NULL REFERENCES runs(root_id) ON DELETE CASCADE,
  parent_task_id INTEGER REFERENCES tasks(task_id),
  created_by_session_pk INTEGER REFERENCES acp_sessions(session_pk),
  goal TEXT NOT NULL,
  intent_hint TEXT NOT NULL,
  resolved_intent TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'ready', 'assigned', 'active', 'stopping',
               'done', 'failed', 'blocked', 'cancelled')
  ),
  priority INTEGER NOT NULL DEFAULT 50,
  complexity_hint TEXT NOT NULL DEFAULT 'medium',
  model_tier_hint TEXT,
  output_contract TEXT,
  constraints_json TEXT NOT NULL DEFAULT '{}',
  estimate_json TEXT,
  delegation_depth INTEGER NOT NULL DEFAULT 0,
  replan_count INTEGER NOT NULL DEFAULT 0,
  created_at REAL NOT NULL,
  finished_at REAL
);

CREATE INDEX IF NOT EXISTS idx_tasks_root_status
ON tasks(root_id, status, priority DESC, created_at);

CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id INTEGER NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  depends_on_task_id INTEGER NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  condition TEXT NOT NULL DEFAULT 'success' CHECK (condition IN ('success', 'terminal')),
  PRIMARY KEY (task_id, depends_on_task_id)
);

CREATE TABLE IF NOT EXISTS attempts (
  attempt_id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  attempt_no INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'assigned' CHECK (
    state IN ('assigned', 'evaluating', 'active', 'waiting', 'stopping',
              'done', 'failed', 'cancelled')
  ),
  actor_token_hash TEXT NOT NULL,
  backend_id TEXT NOT NULL,
  agent_type TEXT NOT NULL,
  model_tier TEXT,
  model_name TEXT,
  config_json TEXT NOT NULL,
  heartbeat_at REAL,
  last_error TEXT,
  retryable INTEGER,
  result_json TEXT,
  created_at REAL NOT NULL,
  started_at REAL,
  finished_at REAL,
  UNIQUE(task_id, attempt_no)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_attempts_one_live
ON attempts(task_id)
WHERE state IN ('assigned', 'evaluating', 'active', 'waiting', 'stopping');

CREATE INDEX IF NOT EXISTS idx_attempts_task_state
ON attempts(task_id, state, attempt_no DESC);

CREATE TABLE IF NOT EXISTS agent_profiles (
  profile_id INTEGER PRIMARY KEY,
  agent_type TEXT NOT NULL,
  package_name TEXT NOT NULL DEFAULT '',
  adapter_version TEXT NOT NULL DEFAULT '',
  command TEXT NOT NULL,
  state_namespace TEXT NOT NULL DEFAULT 'default',
  config_json TEXT NOT NULL,
  created_at REAL NOT NULL,
  UNIQUE(agent_type, package_name, adapter_version, command, state_namespace)
);

CREATE TABLE IF NOT EXISTS launches (
  launch_id INTEGER PRIMARY KEY,
  attempt_id INTEGER NOT NULL REFERENCES attempts(attempt_id) ON DELETE CASCADE,
  launch_no INTEGER NOT NULL,
  owner_nonce TEXT,
  session_name TEXT NOT NULL,
  backend_ref TEXT,
  worker_pid INTEGER,
  agent_pid INTEGER,
  control_endpoint TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('starting', 'running', 'stopping', 'turn_ended', 'error', 'closed')
  ),
  prompt_state TEXT NOT NULL DEFAULT 'pending' CHECK (
    prompt_state IN ('pending', 'in_flight', 'ended', 'cancelled')
  ),
  last_worker_heartbeat_at REAL,
  last_event_at REAL,
  exit_reason TEXT,
  created_at REAL NOT NULL,
  ready_at REAL,
  stop_requested_at REAL,
  reconciled_at REAL,
  closed_at REAL,
  UNIQUE(attempt_id, launch_no)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_launches_one_live
ON launches(attempt_id)
WHERE status IN ('starting', 'running', 'stopping', 'turn_ended', 'error');

CREATE INDEX IF NOT EXISTS idx_launches_attempt_status
ON launches(attempt_id, status, launch_no DESC);

CREATE TABLE IF NOT EXISTS acp_sessions (
  session_pk INTEGER PRIMARY KEY,
  launch_id INTEGER NOT NULL UNIQUE REFERENCES launches(launch_id) ON DELETE CASCADE,
  profile_id INTEGER NOT NULL REFERENCES agent_profiles(profile_id),
  external_session_id TEXT NOT NULL,
  cwd TEXT NOT NULL,
  protocol_version INTEGER NOT NULL,
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  mode TEXT,
  model TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed', 'lost')),
  created_at REAL NOT NULL,
  closed_at REAL,
  UNIQUE(profile_id, external_session_id)
);

CREATE INDEX IF NOT EXISTS idx_acp_sessions_external
ON acp_sessions(external_session_id);

CREATE TABLE IF NOT EXISTS run_notes (
  note_id INTEGER PRIMARY KEY AUTOINCREMENT,
  root_id TEXT NOT NULL REFERENCES runs(root_id) ON DELETE CASCADE,
  task_id INTEGER REFERENCES tasks(task_id),
  created_by_attempt_id INTEGER NOT NULL REFERENCES attempts(attempt_id),
  category TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'task',
  content TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  supersedes_id INTEGER REFERENCES run_notes(note_id),
  active INTEGER NOT NULL DEFAULT 1,
  created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS effects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  root_id TEXT NOT NULL REFERENCES runs(root_id) ON DELETE CASCADE,
  attempt_id INTEGER REFERENCES attempts(attempt_id),
  launch_id INTEGER REFERENCES launches(launch_id),
  effect_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  claimed_at REAL,
  last_error TEXT,
  created_at REAL NOT NULL,
  completed_at REAL
);

CREATE INDEX IF NOT EXISTS idx_effects_root_status
ON effects(root_id, status, id);

CREATE TABLE IF NOT EXISTS processed_actions (
  root_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  attempt_id INTEGER NOT NULL REFERENCES attempts(attempt_id),
  source_session_pk INTEGER REFERENCES acp_sessions(session_pk),
  response_json TEXT NOT NULL,
  processed_at REAL NOT NULL,
  PRIMARY KEY (root_id, action_id)
);

CREATE TABLE IF NOT EXISTS events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  root_id TEXT NOT NULL,
  task_id INTEGER,
  attempt_id INTEGER,
  session_pk INTEGER,
  action_id TEXT,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_root
ON events(root_id, event_id);
`;

export const MIGRATION_2_SQL = `
CREATE TABLE IF NOT EXISTS modes (
  mode_id INTEGER PRIMARY KEY AUTOINCREMENT,
  root_id TEXT NOT NULL REFERENCES runs(root_id) ON DELETE CASCADE,
  owner_task_id INTEGER NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  parent_mode_id INTEGER REFERENCES modes(mode_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (
    kind IN ('swarm', 'develop_review_improve', 'multi_session_review')
  ),
  status TEXT NOT NULL DEFAULT 'running' CHECK (
    status IN ('running', 'completed', 'blocked', 'failed', 'cancelled')
  ),
  phase TEXT NOT NULL,
  current_round INTEGER NOT NULL DEFAULT 1,
  depth INTEGER NOT NULL DEFAULT 0,
  objective TEXT NOT NULL,
  config_json TEXT NOT NULL,
  state_json TEXT NOT NULL DEFAULT '{}',
  state_fingerprint TEXT,
  deadline_at REAL NOT NULL,
  started_at REAL NOT NULL,
  updated_at REAL NOT NULL,
  completed_at REAL
);

CREATE INDEX IF NOT EXISTS idx_modes_root_status
ON modes(root_id, status, mode_id);

CREATE INDEX IF NOT EXISTS idx_modes_owner
ON modes(owner_task_id, status, mode_id);

CREATE TABLE IF NOT EXISTS mode_rounds (
  round_id INTEGER PRIMARY KEY AUTOINCREMENT,
  mode_id INTEGER NOT NULL REFERENCES modes(mode_id) ON DELETE CASCADE,
  round_no INTEGER NOT NULL,
  phase TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'completed', 'blocked', 'cancelled')
  ),
  state_fingerprint TEXT,
  started_at REAL NOT NULL,
  completed_at REAL,
  UNIQUE(mode_id, round_no)
);

CREATE TABLE IF NOT EXISTS mode_tasks (
  mode_task_id INTEGER PRIMARY KEY AUTOINCREMENT,
  mode_id INTEGER NOT NULL REFERENCES modes(mode_id) ON DELETE CASCADE,
  round_id INTEGER REFERENCES mode_rounds(round_id) ON DELETE SET NULL,
  task_id INTEGER NOT NULL UNIQUE REFERENCES tasks(task_id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (
    role IN ('swarm', 'developer', 'reviewer', 'verifier_reproduce',
             'verifier_falsify', 'improver', 'fixer')
  ),
  candidate_fingerprint TEXT,
  proposer_task_id INTEGER REFERENCES tasks(task_id),
  profile_hint_json TEXT,
  result_validated INTEGER NOT NULL DEFAULT 0,
  created_at REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mode_tasks_mode_role
ON mode_tasks(mode_id, role, task_id);

CREATE TABLE IF NOT EXISTS mode_findings (
  finding_id INTEGER PRIMARY KEY AUTOINCREMENT,
  mode_id INTEGER NOT NULL REFERENCES modes(mode_id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  rule_name TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  severity TEXT NOT NULL CHECK (
    severity IN ('low', 'medium', 'high', 'critical')
  ),
  status TEXT NOT NULL DEFAULT 'candidate' CHECK (
    status IN ('candidate', 'confirmed', 'rejected', 'unresolved')
  ),
  canonical_json TEXT NOT NULL,
  first_seen_round INTEGER NOT NULL,
  discovered_by_task_id INTEGER REFERENCES tasks(task_id),
  adjudication_json TEXT,
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL,
  UNIQUE(mode_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_mode_findings_mode_status
ON mode_findings(mode_id, status, severity, fingerprint);

CREATE TABLE IF NOT EXISTS mode_finding_provenance (
  provenance_id INTEGER PRIMARY KEY AUTOINCREMENT,
  finding_id INTEGER NOT NULL REFERENCES mode_findings(finding_id) ON DELETE CASCADE,
  task_id INTEGER NOT NULL REFERENCES tasks(task_id),
  source_kind TEXT NOT NULL CHECK (
    source_kind IN ('reviewer', 'verifier_discovery')
  ),
  raw_finding_json TEXT NOT NULL,
  evidence_hash TEXT NOT NULL,
  created_at REAL NOT NULL,
  UNIQUE(finding_id, task_id, evidence_hash)
);

CREATE TABLE IF NOT EXISTS mode_verifications (
  verification_id INTEGER PRIMARY KEY AUTOINCREMENT,
  finding_id INTEGER NOT NULL REFERENCES mode_findings(finding_id) ON DELETE CASCADE,
  task_id INTEGER NOT NULL UNIQUE REFERENCES tasks(task_id) ON DELETE CASCADE,
  verifier_kind TEXT NOT NULL CHECK (
    verifier_kind IN ('reproduce', 'falsify')
  ),
  verdict TEXT NOT NULL CHECK (
    verdict IN ('confirmed', 'rejected', 'unresolved')
  ),
  evidence_json TEXT NOT NULL,
  evidence_hash TEXT NOT NULL,
  submitted_at REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mode_verifications_finding
ON mode_verifications(finding_id, verifier_kind, verdict);
`;

export const MIGRATION_3_SQL = `
ALTER TABLE mode_tasks RENAME TO mode_tasks_v2;
DROP INDEX IF EXISTS idx_mode_tasks_mode_role;

CREATE TABLE mode_tasks (
  mode_task_id INTEGER PRIMARY KEY AUTOINCREMENT,
  mode_id INTEGER NOT NULL REFERENCES modes(mode_id) ON DELETE CASCADE,
  round_id INTEGER REFERENCES mode_rounds(round_id) ON DELETE SET NULL,
  task_id INTEGER NOT NULL UNIQUE REFERENCES tasks(task_id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (
    role IN ('swarm', 'developer', 'validator', 'reviewer',
             'verifier_reproduce', 'verifier_falsify', 'improver', 'fixer')
  ),
  candidate_fingerprint TEXT,
  proposer_task_id INTEGER REFERENCES tasks(task_id),
  profile_hint_json TEXT,
  result_validated INTEGER NOT NULL DEFAULT 0,
  created_at REAL NOT NULL
);

INSERT INTO mode_tasks(
  mode_task_id, mode_id, round_id, task_id, role, candidate_fingerprint,
  proposer_task_id, profile_hint_json, result_validated, created_at
)
SELECT
  mode_task_id, mode_id, round_id, task_id, role, candidate_fingerprint,
  proposer_task_id, profile_hint_json, result_validated, created_at
FROM mode_tasks_v2;

DROP TABLE mode_tasks_v2;

CREATE INDEX idx_mode_tasks_mode_role
ON mode_tasks(mode_id, role, task_id);
`;

export const MIGRATION_4_SQL = `
ALTER TABLE modes ADD COLUMN recipe TEXT;
UPDATE modes SET recipe=kind WHERE recipe IS NULL;
`;

type Binding = string | number | bigint | boolean | Uint8Array | null;

export class Cursor {
  readonly #statement: Statement<RuntimeRecord, Binding[]>;
  readonly #parameters: Binding[];
  readonly #query: boolean;
  readonly #result: { changes: number; lastInsertRowid: number | bigint } | null;

  constructor(database: Database, sql: string, parameters: readonly unknown[]) {
    this.#parameters = parameters.map(normalizeBinding);
    this.#statement = database.query<RuntimeRecord, Binding[]>(sql);
    this.#query = /^\s*(?:SELECT|WITH|PRAGMA|EXPLAIN)\b/iu.test(sql);
    this.#result = this.#query ? null : this.#statement.run(...this.#parameters);
  }

  fetchone(): RuntimeRecord | null {
    return (this.#statement.get(...this.#parameters) as RuntimeRecord | null) ?? null;
  }

  fetchall(): RuntimeRecord[] {
    return this.#statement.all(...this.#parameters) as RuntimeRecord[];
  }

  get rowcount(): number {
    return this.#result?.changes ?? -1;
  }

  get lastrowid(): number {
    const value = this.#result?.lastInsertRowid;
    if (value === undefined) throw new RuntimeError("statement has no last inserted row id");
    const rendered = Number(value);
    if (!Number.isSafeInteger(rendered)) throw new RuntimeError("last inserted row id exceeds the safe integer range");
    return rendered;
  }
}

function normalizeBinding(value: unknown): Binding {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean" ||
    value instanceof Uint8Array
  ) return value;
  throw new ValueError("SQLite parameter has an unsupported type");
}

export class Connection {
  readonly database: Database;

  constructor(path: string) {
    this.database = new Database(path, { create: true, strict: true });
  }

  execute(sql: string, parameters: readonly unknown[] = []): Cursor {
    return new Cursor(this.database, sql, parameters);
  }

  executescript(sql: string): void {
    this.database.exec(sql);
  }

  commit(): void {
    this.database.exec("COMMIT");
  }

  rollback(): void {
    this.database.exec("ROLLBACK");
  }

  close(): void {
    this.database.close(false);
  }
}

export function now(): number {
  return Date.now() / 1_000;
}

export function runtimeRoot(): string {
  return runtimeEnv.runtimeRoot();
}

export function dbPath(): string {
  return runtimeEnv.dbPath();
}

function assetDigest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function runtimeAssetSourceRoot(): string {
  return resolve(import.meta.dir, "..");
}

function runtimeAssetManifest(sourceRoot: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of ["runtime_env.ts", "hook_manager.ts", "hook_runtime.ts", "runtime_types.ts", "state_store.ts"]) {
    const path = join(sourceRoot, "scripts", name);
    if (existsSync(path)) result[`scripts/${name}`] = assetDigest(path);
  }
  const hooks = join(sourceRoot, "hooks");
  if (existsSync(hooks)) {
    for (const entry of readdirSync(hooks, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const path = join(hooks, entry.name);
      result[`hooks/${entry.name}`] = assetDigest(path);
    }
  }
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)));
}

function readRuntimeAssetManifest(path: string): Record<string, string> {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(value) || !isRecord(value.files)) return {};
    const entries = Object.entries(value.files);
    if (!entries.every((entry): entry is [string, string] => typeof entry[1] === "string")) return {};
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

function safeRuntimeRelativePath(path: string): string | null {
  if (isAbsolute(path) || path.split(/[\\/]/u).includes("..")) return null;
  return path;
}

function runtimeAssetsMatch(targetRoot: string, assets: Record<string, string>): boolean {
  const recorded = readRuntimeAssetManifest(join(targetRoot, RUNTIME_ASSET_MANIFEST));
  if (canonicalJson(recorded) !== canonicalJson(assets)) return false;
  return Object.entries(assets).every(([path, digest]) => {
    const safe = safeRuntimeRelativePath(path);
    const target = safe === null ? null : join(targetRoot, safe);
    return target !== null && existsSync(target) && statSync(target).isFile() && assetDigest(target) === digest;
  });
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function withRuntimeAssetLock<T>(targetRoot: string, callback: () => T): T {
  const path = join(targetRoot, RUNTIME_ASSET_LOCK);
  const started = Date.now();
  while (true) {
    try {
      mkdirSync(path, { mode: 0o700 });
      writeFileSync(join(path, "owner"), `${process.pid}\n`, { mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let stale = false;
      try {
        const pid = Number(readFileSync(join(path, "owner"), "utf8").trim());
        stale = !Number.isSafeInteger(pid) || !processAlive(pid) || Date.now() - statSync(path).mtimeMs > 600_000;
      } catch {
        stale = true;
      }
      if (stale) {
        try {
          const replacement = `${path}.stale-${randomUUID()}`;
          renameSync(path, replacement);
          rmSync(replacement, { recursive: true, force: true });
          continue;
        } catch {
          // Another process recovered the stale lock.
        }
      }
      if (Date.now() - started > 30_000) throw new RuntimeError("timed out installing Runtime hook assets");
      Bun.sleepSync(50);
    }
  }
  try {
    return callback();
  } finally {
    try {
      const owner = Number(readFileSync(join(path, "owner"), "utf8").trim());
      if (owner === process.pid) rmSync(path, { recursive: true, force: true });
    } catch {
      // Never remove a lock whose ownership cannot be proved.
    }
  }
}

function copyRuntimeAsset(source: string, target: string): void {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(target), `.${randomUUID()}.tmp`);
  try {
    copyFileSync(source, temporary);
    chmodSync(temporary, source.endsWith(".sh") ? 0o700 : 0o600);
    renameSync(temporary, target);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function ensureRuntimeAssets(): string {
  const sourceRoot = runtimeAssetSourceRoot();
  const targetRoot = runtimeRoot();
  if (resolve(sourceRoot) === resolve(targetRoot)) return targetRoot;
  const assets = runtimeAssetManifest(sourceRoot);
  mkdirSync(targetRoot, { recursive: true, mode: 0o700 });
  chmodSync(targetRoot, 0o700);
  withRuntimeAssetLock(targetRoot, () => {
    if (runtimeAssetsMatch(targetRoot, assets)) return;
    const previous = readRuntimeAssetManifest(join(targetRoot, RUNTIME_ASSET_MANIFEST));
    for (const path of Object.keys(assets)) {
      const safe = safeRuntimeRelativePath(path);
      if (safe !== null) copyRuntimeAsset(join(sourceRoot, safe), join(targetRoot, safe));
    }
    for (const path of Object.keys(previous)) {
      const safe = safeRuntimeRelativePath(path);
      if (safe === null || path in assets) continue;
      const stale = join(targetRoot, safe);
      if (existsSync(stale) && statSync(stale).isFile()) unlinkSync(stale);
    }
    const temporary = join(targetRoot, `.${RUNTIME_ASSET_MANIFEST}.${randomUUID()}.tmp`);
    writeFileSync(temporary, `${JSON.stringify({ files: assets }, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, join(targetRoot, RUNTIME_ASSET_MANIFEST));
  });
  return targetRoot;
}

export function connect(): Connection {
  const path = dbPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const connection = new Connection(path);
  connection.database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  connection.database.exec("PRAGMA journal_mode = WAL");
  connection.database.exec("PRAGMA foreign_keys = ON");
  return connection;
}

export function initializeSchema(): void {
  ensureRuntimeAssets();
  const connection = connect();
  try {
    connection.database.exec("BEGIN IMMEDIATE");
    connection.executescript(SCHEMA_SQL);
    connection.execute(
      "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, ?)",
      [now()],
    );
    const applied = new Set(
      connection.execute("SELECT version FROM schema_migrations").fetchall().map((row) => Number(row.version)),
    );
    if (!applied.has(2)) {
      connection.executescript(MIGRATION_2_SQL);
      connection.execute("INSERT INTO schema_migrations(version, applied_at) VALUES (2, ?)", [now()]);
    }
    if (!applied.has(3)) {
      connection.executescript(MIGRATION_3_SQL);
      connection.execute("INSERT INTO schema_migrations(version, applied_at) VALUES (3, ?)", [now()]);
    }
    if (!applied.has(4)) {
      connection.executescript(MIGRATION_4_SQL);
      connection.execute("INSERT INTO schema_migrations(version, applied_at) VALUES (4, ?)", [now()]);
    }
    connection.commit();
  } catch (error) {
    try {
      connection.rollback();
    } catch {
      // Preserve the original migration error.
    }
    throw error;
  } finally {
    connection.close();
  }
}

export function transaction<T>(callback: (connection: Connection) => T, immediate = true): T {
  initializeSchema();
  const connection = connect();
  try {
    connection.database.exec(immediate ? "BEGIN IMMEDIATE" : "BEGIN");
    const result = callback(connection);
    connection.commit();
    return result;
  } catch (error) {
    try {
      connection.rollback();
    } catch {
      // Preserve the original transaction error.
    }
    throw error;
  } finally {
    connection.close();
  }
}

function one(sql: string, parameters: readonly unknown[] = [], connection?: Connection): RuntimeRecord | null {
  if (connection) return connection.execute(sql, parameters).fetchone();
  const owned = connect();
  try {
    return owned.execute(sql, parameters).fetchone();
  } finally {
    owned.close();
  }
}

export function fetchall(
  sql: string,
  parameters: readonly unknown[] = [],
  connection?: Connection,
): RuntimeRecord[] {
  if (connection) return connection.execute(sql, parameters).fetchall();
  const owned = connect();
  try {
    return owned.execute(sql, parameters).fetchall();
  } finally {
    owned.close();
  }
}

export function execute(sql: string, parameters: readonly unknown[] = []): number {
  return transaction((connection) => connection.execute(sql, parameters).rowcount);
}

export function getRun(rootId: string, connection?: Connection): RuntimeRecord | null {
  return one("SELECT * FROM runs WHERE root_id = ?", [rootId], connection);
}

export function getTask(taskId: number, connection?: Connection): RuntimeRecord | null {
  return one("SELECT * FROM tasks WHERE task_id = ?", [taskId], connection);
}

export function getMode(modeId: number, connection?: Connection): RuntimeRecord | null {
  return one("SELECT * FROM modes WHERE mode_id = ?", [modeId], connection);
}

export function getModeTask(taskId: number, connection?: Connection): RuntimeRecord | null {
  return one(
    `SELECT mt.*, m.root_id, m.kind, m.status AS mode_status, m.phase,
            m.current_round, m.owner_task_id
       FROM mode_tasks mt JOIN modes m ON m.mode_id=mt.mode_id
      WHERE mt.task_id=?`,
    [taskId],
    connection,
  );
}

export function getAttempt(attemptId: number, connection?: Connection): RuntimeRecord | null {
  return one(
    `SELECT a.*, t.root_id
       FROM attempts a JOIN tasks t ON t.task_id=a.task_id
      WHERE a.attempt_id=?`,
    [attemptId],
    connection,
  );
}

export function getCurrentAttempt(taskId: number, connection?: Connection): RuntimeRecord | null {
  return one(
    `SELECT a.*, t.root_id
       FROM attempts a JOIN tasks t ON t.task_id=a.task_id
      WHERE a.task_id=? ORDER BY a.attempt_no DESC LIMIT 1`,
    [taskId],
    connection,
  );
}

export function getEffect(effectId: number, connection?: Connection): RuntimeRecord | null {
  return one("SELECT * FROM effects WHERE id = ?", [effectId], connection);
}

export function getLaunch(launchId: number, connection?: Connection): RuntimeRecord | null {
  return one(
    `SELECT l.*, a.task_id, a.backend_id, a.agent_type, a.config_json, t.root_id
       FROM launches l
       JOIN attempts a ON a.attempt_id=l.attempt_id
       JOIN tasks t ON t.task_id=a.task_id
      WHERE l.launch_id=?`,
    [launchId],
    connection,
  );
}

export function getCurrentLaunch(attemptId: number, connection?: Connection): RuntimeRecord | null {
  return one(
    `SELECT l.*, a.task_id, a.backend_id, a.agent_type, a.config_json, t.root_id
       FROM launches l
       JOIN attempts a ON a.attempt_id=l.attempt_id
       JOIN tasks t ON t.task_id=a.task_id
      WHERE l.attempt_id=? ORDER BY l.launch_no DESC LIMIT 1`,
    [attemptId],
    connection,
  );
}

export function getSession(sessionPk: number, connection?: Connection): RuntimeRecord | null {
  return one(
    `SELECT s.*, p.agent_type, p.package_name, p.adapter_version,
            p.command, p.state_namespace, p.config_json AS profile_config_json,
            l.attempt_id, a.task_id, t.root_id
       FROM acp_sessions s
       JOIN agent_profiles p ON p.profile_id=s.profile_id
       JOIN launches l ON l.launch_id=s.launch_id
       JOIN attempts a ON a.attempt_id=l.attempt_id
       JOIN tasks t ON t.task_id=a.task_id
      WHERE s.session_pk=?`,
    [sessionPk],
    connection,
  );
}

export function getSessionForLaunch(launchId: number, connection?: Connection): RuntimeRecord | null {
  return one(
    `SELECT s.*, p.agent_type, p.package_name, p.adapter_version,
            p.command, p.state_namespace, p.config_json AS profile_config_json
       FROM acp_sessions s JOIN agent_profiles p ON p.profile_id=s.profile_id
      WHERE s.launch_id=?`,
    [launchId],
    connection,
  );
}

export function findSession(
  agentType: string,
  externalSessionId: string,
  rootId?: string,
  connection?: Connection,
): RuntimeRecord[] {
  const rootFilter = rootId === undefined ? "" : " AND t.root_id=?";
  const parameters: unknown[] = [agentType, externalSessionId];
  if (rootId !== undefined) parameters.push(rootId);
  return fetchall(
    `SELECT s.*, p.agent_type, p.package_name, p.adapter_version,
            p.command, p.state_namespace, p.config_json AS profile_config_json,
            l.attempt_id, a.task_id, t.root_id
       FROM acp_sessions s
       JOIN agent_profiles p ON p.profile_id=s.profile_id
       JOIN launches l ON l.launch_id=s.launch_id
       JOIN attempts a ON a.attempt_id=l.attempt_id
       JOIN tasks t ON t.task_id=a.task_id
      WHERE p.agent_type=? AND s.external_session_id=?${rootFilter}`,
    parameters,
    connection,
  );
}

export function listTasks(rootId: string, connection?: Connection): RuntimeRecord[] {
  return fetchall("SELECT * FROM tasks WHERE root_id = ? ORDER BY created_at, task_id", [rootId], connection);
}

export function listAttempts(rootId: string, connection?: Connection): RuntimeRecord[] {
  return fetchall(
    `SELECT a.*, t.root_id FROM attempts a
       JOIN tasks t ON t.task_id=a.task_id
      WHERE t.root_id=? ORDER BY a.task_id, a.attempt_no`,
    [rootId],
    connection,
  );
}

export function listLaunches(rootId: string, connection?: Connection): RuntimeRecord[] {
  return fetchall(
    `SELECT l.*, a.task_id, a.backend_id, a.agent_type, a.config_json, t.root_id
       FROM launches l
       JOIN attempts a ON a.attempt_id=l.attempt_id
       JOIN tasks t ON t.task_id=a.task_id
      WHERE t.root_id=? ORDER BY l.created_at, l.launch_id`,
    [rootId],
    connection,
  );
}

export function listSessions(rootId: string, connection?: Connection): RuntimeRecord[] {
  return fetchall(
    `SELECT s.*, p.agent_type, p.package_name, p.adapter_version,
            p.command, p.state_namespace, l.attempt_id, a.task_id, t.root_id
       FROM acp_sessions s
       JOIN agent_profiles p ON p.profile_id=s.profile_id
       JOIN launches l ON l.launch_id=s.launch_id
       JOIN attempts a ON a.attempt_id=l.attempt_id
       JOIN tasks t ON t.task_id=a.task_id
      WHERE t.root_id=? ORDER BY s.created_at, s.session_pk`,
    [rootId],
    connection,
  );
}

export function listNotes(rootId: string, includeInactive = false, connection?: Connection): RuntimeRecord[] {
  const active = includeInactive ? "" : " AND active = 1";
  return fetchall(
    `SELECT * FROM run_notes WHERE root_id = ?${active} ORDER BY created_at, note_id`,
    [rootId],
    connection,
  );
}

export function listEffects(rootId: string, connection?: Connection): RuntimeRecord[] {
  return fetchall("SELECT * FROM effects WHERE root_id = ? ORDER BY id", [rootId], connection);
}

function parseObjectColumn(raw: unknown, label: string): Record<string, unknown> {
  if (typeof raw !== "string") throw new ValueError(`${label} must be JSON text`);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ValueError(`${label} is invalid JSON`);
  }
  if (!isRecord(value)) throw new ValueError(`${label} must contain a JSON object`);
  return value;
}

export function inspectModes(rootId: string, modeId?: number, connection?: Connection): RuntimeRecord[] {
  const parameters: unknown[] = [rootId];
  const predicate = modeId === undefined ? "" : " AND mode_id=?";
  if (modeId !== undefined) parameters.push(modeId);
  return fetchall(`SELECT * FROM modes WHERE root_id=?${predicate} ORDER BY mode_id`, parameters, connection).map(
    (mode) => {
      const item = { ...mode };
      item.config = parseObjectColumn(item.config_json, "mode config_json");
      item.state = parseObjectColumn(item.state_json, "mode state_json");
      delete item.config_json;
      delete item.state_json;
      item.rounds = fetchall("SELECT * FROM mode_rounds WHERE mode_id=? ORDER BY round_no", [mode.mode_id], connection);
      item.tasks = fetchall(
        `SELECT mt.*, t.status, t.goal, t.resolved_intent
           FROM mode_tasks mt JOIN tasks t ON t.task_id=mt.task_id
          WHERE mt.mode_id=? ORDER BY mt.mode_task_id`,
        [mode.mode_id],
        connection,
      );
      item.findings = fetchall("SELECT * FROM mode_findings WHERE mode_id=? ORDER BY finding_id", [mode.mode_id], connection);
      const findingIds = (item.findings as RuntimeRecord[]).map((row) => row.finding_id);
      if (findingIds.length > 0) {
        const marks = findingIds.map(() => "?").join(",");
        item.provenance = fetchall(
          `SELECT * FROM mode_finding_provenance WHERE finding_id IN (${marks}) ORDER BY provenance_id`,
          findingIds,
          connection,
        );
        item.verifications = fetchall(
          `SELECT * FROM mode_verifications WHERE finding_id IN (${marks}) ORDER BY verification_id`,
          findingIds,
          connection,
        );
      } else {
        item.provenance = [];
        item.verifications = [];
      }
      return item;
    },
  );
}

export function ensureAgentProfile(
  connection: Connection,
  config: RuntimeRecord,
  stateNamespace = "default",
): number {
  const agentType = config.agent || "custom";
  const packageName = config.package || "";
  const adapterVersion = String(config.profile_version || "");
  const command = config.command || config.resolved_command || "";
  const encoded = canonicalJson(config);
  connection.execute(
    `INSERT OR IGNORE INTO agent_profiles(
       agent_type, package_name, adapter_version, command,
       state_namespace, config_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [agentType, packageName, adapterVersion, command, stateNamespace, encoded, now()],
  );
  const row = connection.execute(
    `SELECT profile_id FROM agent_profiles
      WHERE agent_type=? AND package_name=? AND adapter_version=?
        AND command=? AND state_namespace=?`,
    [agentType, packageName, adapterVersion, command, stateNamespace],
  ).fetchone();
  if (row === null) throw new RuntimeError("failed to persist ACP Agent profile");
  return Number(row.profile_id);
}

export function claimLaunchOwnership(launchId: number, ownerNonce: string, workerPid: number): boolean {
  if (!ownerNonce) throw new ValueError("owner_nonce is required");
  return transaction((connection) => {
    const timestamp = now();
    const cursor = connection.execute(
      `UPDATE launches
          SET owner_nonce=?, worker_pid=?, last_worker_heartbeat_at=?, last_event_at=?
        WHERE launch_id=? AND owner_nonce IS NULL
          AND stop_requested_at IS NULL AND status='starting'
          AND EXISTS (
            SELECT 1
              FROM attempts a
              JOIN tasks t ON t.task_id=a.task_id
              JOIN runs r ON r.root_id=t.root_id
             WHERE a.attempt_id=launches.attempt_id
               AND a.state IN ('assigned','evaluating','active','waiting','stopping')
               AND NOT EXISTS (
                 SELECT 1 FROM attempts newer
                  WHERE newer.task_id=a.task_id AND newer.attempt_no>a.attempt_no
               )
               AND t.status IN ('assigned','active','stopping')
               AND r.status='running'
          )`,
      [ownerNonce, workerPid, timestamp, timestamp, launchId],
    );
    return cursor.rowcount === 1;
  });
}

export function listEvents(rootId: string, limit = 100, connection?: Connection): RuntimeRecord[] {
  return fetchall(
    "SELECT * FROM events WHERE root_id = ? ORDER BY event_id DESC LIMIT ?",
    [rootId, Math.trunc(limit)],
    connection,
  ).reverse();
}

export function appendEvent(
  connection: Connection,
  rootId: string,
  eventType: string,
  payload: unknown = {},
  taskId: number | null = null,
  attemptId: number | null = null,
  sessionPk: number | null = null,
  actionId: string | null = null,
): void {
  connection.execute(
    `INSERT INTO events(
       root_id, task_id, attempt_id, session_pk, action_id, type, payload_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [rootId, taskId, attemptId, sessionPk, actionId, eventType, canonicalJson(payload ?? {}), now()],
  );
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function tokenMatches(token: unknown, expectedHash: unknown): boolean {
  if (typeof token !== "string" || !token || typeof expectedHash !== "string" || !expectedHash) return false;
  const actual = Buffer.from(hashToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
