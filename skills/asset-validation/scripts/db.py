import os
import secrets
import sqlite3
import time
from pathlib import Path

SCHEMA = """
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
"""

_ROUND_EXTRA_COLUMNS = {
    "mode": "TEXT CHECK (mode IN ('stop-loss','collect-first','hybrid'))",
    "report": "TEXT",
    "transcript": "TEXT",
    "next_round_reco": "TEXT",
    "sandbox_path": "TEXT",
    "asset_hash": "TEXT",
    "task_keys": "TEXT",
    "ended_at": "TEXT",
}

_ACCEPTANCE_EXTRA_COLUMNS = {
    "strategy": "TEXT",
    "acceptance_prompt": "TEXT",
    "acceptance_criteria": "TEXT",
    "task_prompts": "TEXT",
    "issues": "TEXT",
    "fixture_path": "TEXT",
    "ladder": "TEXT",
    "budget_max_rounds": "INTEGER",
}


def runtime_root() -> Path:
    override = os.environ.get("ACCEPTANCE_HOME")
    return Path(override) if override else Path.home() / ".acceptance"


def db_path() -> Path:
    return runtime_root() / "state.sqlite3"


def _ensure_columns(con, table, columns) -> None:
    existing = {row[1] for row in con.execute(f"PRAGMA table_info({table})")}
    for name, decl in columns.items():
        if name not in existing:
            con.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")


def ensure_schema(con: sqlite3.Connection) -> None:
    con.executescript(SCHEMA)
    _ensure_columns(con, "round", _ROUND_EXTRA_COLUMNS)
    _ensure_columns(con, "acceptance", _ACCEPTANCE_EXTRA_COLUMNS)
    con.commit()


def connect() -> sqlite3.Connection:
    runtime_root().mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(db_path())
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    ensure_schema(con)
    return con


def round_sandbox_paths_from(path: Path) -> list:
    if not Path(path).exists():
        return []
    con = sqlite3.connect(path)
    try:
        con.row_factory = sqlite3.Row
        rows = con.execute(
            "SELECT sandbox_path FROM round WHERE sandbox_path IS NOT NULL"
        ).fetchall()
        return [row["sandbox_path"] for row in rows if row["sandbox_path"]]
    except sqlite3.Error:
        return []
    finally:
        con.close()


def round_cleanup_targets_from(path: Path) -> list:
    if not Path(path).exists():
        return []
    con = sqlite3.connect(path)
    try:
        con.row_factory = sqlite3.Row
        rows = con.execute(
            "SELECT round_tag, sandbox_path FROM round"
        ).fetchall()
        return [dict(row) for row in rows]
    except sqlite3.Error:
        return []
    finally:
        con.close()


def new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(5)}"


def now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S")


def round_tag(n: int) -> str:
    return f"{n}-{time.strftime('%Y%m%d-%H%M%S')}-{secrets.token_hex(3)}"
