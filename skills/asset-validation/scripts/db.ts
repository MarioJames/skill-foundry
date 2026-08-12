import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export type Connection = Database;
export type SqlValue = string | number | bigint | boolean | Uint8Array | null;
export type SqlRow = Record<string, unknown>;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS asset (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('skill','plugin','rule','agent')),
  source_path TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS acceptance (
  id                  TEXT PRIMARY KEY,
  asset_id            TEXT NOT NULL REFERENCES asset(id),
  goal                TEXT NOT NULL,
  strategy            TEXT,
  acceptance_prompt   TEXT,
  acceptance_criteria TEXT,
  task_prompts        TEXT,
  issues              TEXT,
  fixture_path        TEXT,
  ladder              TEXT,
  budget_max_rounds   INTEGER,
  status              TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','active','done')),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS round (
  id              TEXT PRIMARY KEY,
  acceptance_id   TEXT NOT NULL REFERENCES acceptance(id),
  round_tag       TEXT NOT NULL,
  mode            TEXT CHECK (mode IN ('stop-loss','collect-first','hybrid')),
  verdict         TEXT NOT NULL DEFAULT 'running'
                    CHECK (verdict IN ('PASS','CONDITIONAL','FAIL','blocked','running')),
  report          TEXT,
  transcript      TEXT,
  next_round_reco TEXT,
  sandbox_path    TEXT,
  asset_hash      TEXT,
  task_keys       TEXT,
  started_at      TEXT NOT NULL,
  ended_at        TEXT
);
CREATE TABLE IF NOT EXISTS finding (
  id          TEXT PRIMARY KEY,
  round_id    TEXT NOT NULL REFERENCES round(id),
  key         TEXT,
  severity    TEXT NOT NULL,
  status      TEXT NOT NULL,
  summary     TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
`;

const ROUND_EXTRA_COLUMNS: Record<string, string> = {
  mode: "TEXT CHECK (mode IN ('stop-loss','collect-first','hybrid'))",
  report: "TEXT",
  transcript: "TEXT",
  next_round_reco: "TEXT",
  sandbox_path: "TEXT",
  asset_hash: "TEXT",
  task_keys: "TEXT",
  ended_at: "TEXT",
};

const ACCEPTANCE_EXTRA_COLUMNS: Record<string, string> = {
  strategy: "TEXT",
  acceptance_prompt: "TEXT",
  acceptance_criteria: "TEXT",
  task_prompts: "TEXT",
  issues: "TEXT",
  fixture_path: "TEXT",
  ladder: "TEXT",
  budget_max_rounds: "INTEGER",
};

export function all<T extends SqlRow>(
  connection: Connection,
  sql: string,
  parameters: SqlValue[] = [],
): T[] {
  return connection.query(sql).all(...parameters) as T[];
}

export function get<T extends SqlRow>(
  connection: Connection,
  sql: string,
  parameters: SqlValue[] = [],
): T | null {
  return (connection.query(sql).get(...parameters) as T | null) ?? null;
}

export function run(
  connection: Connection,
  sql: string,
  parameters: SqlValue[] = [],
): void {
  connection.query(sql).run(...parameters);
}

export function runtimeRoot(): string {
  return process.env.ACCEPTANCE_HOME || join(homedir(), ".acceptance");
}

export function dbPath(): string {
  return join(runtimeRoot(), "state.sqlite3");
}

function ensureColumns(
  connection: Connection,
  table: string,
  columns: Record<string, string>,
): void {
  const existing = new Set(
    all<{ name: string }>(connection, `PRAGMA table_info(${table})`).map((row) => row.name),
  );
  for (const [name, declaration] of Object.entries(columns)) {
    if (!existing.has(name)) {
      connection.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${declaration}`);
    }
  }
}

export function ensureSchema(connection: Connection): void {
  connection.exec(SCHEMA);
  ensureColumns(connection, "round", ROUND_EXTRA_COLUMNS);
  ensureColumns(connection, "acceptance", ACCEPTANCE_EXTRA_COLUMNS);
}

export function connect(): Connection {
  mkdirSync(runtimeRoot(), { recursive: true });
  const connection = new Database(dbPath(), { create: true });
  connection.exec("PRAGMA foreign_keys = ON");
  connection.exec("PRAGMA busy_timeout = 5000");
  ensureSchema(connection);
  return connection;
}

export function roundSandboxPathsFrom(path: string): string[] {
  if (!existsSync(path)) {
    return [];
  }
  const connection = new Database(path, { readonly: true });
  try {
    connection.exec("PRAGMA busy_timeout = 5000");
    return all<{ sandbox_path: string | null }>(
      connection,
      "SELECT sandbox_path FROM round WHERE sandbox_path IS NOT NULL",
    )
      .map((row) => row.sandbox_path)
      .filter((value): value is string => Boolean(value));
  } catch {
    return [];
  } finally {
    connection.close();
  }
}

export interface RoundCleanupTarget extends SqlRow {
  round_tag: string | null;
  sandbox_path: string | null;
}

export function roundCleanupTargetsFrom(path: string): RoundCleanupTarget[] {
  if (!existsSync(path)) {
    return [];
  }
  const connection = new Database(path, { readonly: true });
  try {
    connection.exec("PRAGMA busy_timeout = 5000");
    return all<RoundCleanupTarget>(
      connection,
      "SELECT round_tag, sandbox_path FROM round",
    );
  } catch {
    return [];
  } finally {
    connection.close();
  }
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(5).toString("hex")}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function localTimestamp(date = new Date()): { date: string; time: string } {
  return {
    date: `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`,
    time: `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`,
  };
}

export function now(date = new Date()): string {
  const stamp = localTimestamp(date);
  return `${stamp.date.slice(0, 4)}-${stamp.date.slice(4, 6)}-${stamp.date.slice(6, 8)}`
    + `T${stamp.time.slice(0, 2)}:${stamp.time.slice(2, 4)}:${stamp.time.slice(4, 6)}`;
}

export function roundTag(n: number, date = new Date()): string {
  const stamp = localTimestamp(date);
  return `${n}-${stamp.date}-${stamp.time}-${randomBytes(3).toString("hex")}`;
}
