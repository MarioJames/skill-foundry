import { Database } from "bun:sqlite";
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { CliError } from "./cli";
import type { State } from "./dispatch-state";
import type { Attempt } from "./scheduling";

export const defaultDatabase = () => join(homedir(), ".config", "agent-dispatch", "state.sqlite");
const blank = (): State => ({ version: 1, batch_id: null, assessments: {}, decisions: [], classification_runs: [], attempts: [] });

export class SQLiteStateStore {
  readonly path: string;
  readonly scope: string;
  readonly results: string;
  private db: Database;

  constructor(scope: string, path = defaultDatabase()) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/u.test(scope)) throw new CliError("invalid_scope", "--scope must be a safe identifier", 2);
    this.scope = scope;
    this.path = resolve(path);
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!existsSync(this.path)) { const fd = openSync(this.path, "wx", 0o600); closeSync(fd); }
    const info = lstatSync(this.path);
    if (!info.isFile() || info.isSymbolicLink()) throw new CliError("invalid_database", "Database path must be a regular file, not a symlink");
    chmodSync(this.path, 0o600);
    this.results = join(dir, "results", scope);
    mkdirSync(this.results, { recursive: true, mode: 0o700 });
    this.db = new Database(this.path, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000");
    this.db.exec("CREATE TABLE IF NOT EXISTS scopes (id TEXT PRIMARY KEY, state_json TEXT NOT NULL, updated_at TEXT NOT NULL)");
  }

  read(): State {
    const row = this.db.query("SELECT state_json FROM scopes WHERE id = ?").get(this.scope) as { state_json: string } | null;
    if (!row) return blank();
    let value: any;
    try { value = JSON.parse(row.state_json); } catch { throw new CliError("invalid_state", "SQLite scope state is unreadable"); }
    if (value?.version !== 1 || !Array.isArray(value?.decisions) || !Array.isArray(value?.attempts) || !value?.assessments)
      throw new CliError("invalid_state", "SQLite scope state has an invalid schema");
    return value as State;
  }

  async transaction<T>(work: (state: State, save: () => void) => Promise<T>): Promise<T> {
    // Keep the existing scope-wide intent lock across awaited external effects. SQLite
    // transactions themselves stay short, so different scopes can make progress.
    const lock = `${this.path}.${this.scope}.lock`;
    let fd: number;
    try { fd = openSync(lock, "wx", 0o600); }
    catch { throw new CliError("scope_locked", `Scope ${this.scope} is locked; inspect the recorded process before recovery`); }
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, created_at: new Date().toISOString(), token: randomUUID() }));
      fsyncSync(fd);
      const state = this.read();
      const save = () => {
        const serialized = JSON.stringify(state);
        if (Buffer.byteLength(serialized) > 16_000_000) throw new CliError("state_budget", "Scope state exceeds 16 MB; previous durable state retained");
        this.db.transaction(() => {
          this.db.query("INSERT INTO scopes(id, state_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET state_json=excluded.state_json, updated_at=excluded.updated_at")
            .run(this.scope, serialized, new Date().toISOString());
        })();
      };
      return await work(state, save);
    } finally {
      closeSync(fd!);
      unlinkSync(lock);
    }
  }

  close() { this.db.close(); }
  otherActiveAttempts(): Attempt[] {
    const rows = this.db.query("SELECT state_json FROM scopes WHERE id <> ?").all(this.scope) as { state_json: string }[];
    return rows.flatMap((row) => {
      let value: State;
      try { value = JSON.parse(row.state_json); }
      catch { throw new CliError("invalid_state", "Another scope state is unreadable; admission stopped"); }
      if (!Array.isArray(value.attempts)) throw new CliError("invalid_state", "Another scope has invalid attempts; admission stopped");
      return value.attempts.filter((a) => a.slot === "held" || a.writes_held);
    });
  }
  async admission<T>(work: () => Promise<T>): Promise<T> {
    const lock = `${this.path}.admission.lock`;
    let fd: number;
    try { fd = openSync(lock, "wx", 0o600); }
    catch { throw new CliError("admission_locked", "Global admission is locked; inspect the recorded process before recovery"); }
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }));
      fsyncSync(fd);
      return await work();
    } finally { closeSync(fd!); unlinkSync(lock); }
  }
  lockInfo(): unknown {
    const file = `${this.path}.${this.scope}.lock`;
    if (!existsSync(file)) return null;
    try { return JSON.parse(readFileSync(file, "utf8")); } catch { return { unreadable: true }; }
  }
}
