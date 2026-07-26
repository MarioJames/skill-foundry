"""SQLite facts for Agent Swarm Runtime v2.

The old Kind/Round runtime used ``state.sqlite3``.  v2 deliberately uses a new
database file so a breaking protocol upgrade cannot reinterpret live legacy
rows.  The legacy database remains available for read-only diagnostics.
"""

import contextlib
import hashlib
import json
import os
import pathlib
import shutil
import tempfile
import time

try:
    import sqlite3
except ModuleNotFoundError as error:
    if error.name not in {"sqlite3", "_sqlite3"}:
        raise
    import pysqlite3 as sqlite3


RUNTIME_HOME_ENV = "AGENT_SWARM_HOME"
MIGRATION_SOURCE_ENV = "AGENT_SWARM_MIGRATE_FROM"
RUNTIME_HOME_DIRECTORY = ".agent-swarm"
LEGACY_RUNTIME_HOME_DIRECTORY = ".ultra-team"
SCHEMA_VERSION = "agent-swarm-runtime-v2"
BUSY_TIMEOUT_MS = 5000
RUNTIME_ASSET_MANIFEST = ".runtime-assets.json"
RUNTIME_HOOK_SCRIPTS = ("hook_runtime.py", "hook_manager.py", "state_store.py")
RUNTIME_HOOK_FILES = (
    "heartbeat.sh",
    "failure_context.sh",
    "finish_gate.sh",
    "clean.sh",
)


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  root_id TEXT PRIMARY KEY,
  task TEXT NOT NULL,
  cwd TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  root_task_id TEXT,
  root_agent_id TEXT,
  max_concurrent_agents INTEGER NOT NULL DEFAULT 8,
  max_total_tasks INTEGER NOT NULL DEFAULT 100,
  max_attempts_per_task INTEGER NOT NULL DEFAULT 2,
  max_delegation_depth INTEGER NOT NULL DEFAULT 5,
  max_replans_per_task INTEGER NOT NULL DEFAULT 2,
  max_children_per_action INTEGER NOT NULL DEFAULT 12,
  require_final_review INTEGER NOT NULL DEFAULT 1,
  model_tiers_json TEXT NOT NULL,
  execution_json TEXT NOT NULL DEFAULT '{}',
  child_token_seed_ref TEXT,
  child_token_seed_hash TEXT,
  owner_token_hash TEXT,
  lease_epoch INTEGER NOT NULL DEFAULT 0,
  lease_expires_at REAL,
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL,
  finished_at REAL
);

CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  root_id TEXT NOT NULL REFERENCES runs(root_id) ON DELETE CASCADE,
  parent_task_id TEXT REFERENCES tasks(task_id),
  goal TEXT NOT NULL,
  intent_hint TEXT NOT NULL,
  resolved_intent TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  priority INTEGER NOT NULL DEFAULT 50,
  complexity_hint TEXT NOT NULL DEFAULT 'medium',
  model_tier_hint TEXT,
  output_contract TEXT,
  constraints_json TEXT NOT NULL DEFAULT '{}',
  estimate_json TEXT,
  current_attempt_id TEXT,
  delegation_depth INTEGER NOT NULL DEFAULT 0,
  replan_count INTEGER NOT NULL DEFAULT 0,
  created_at REAL NOT NULL,
  finished_at REAL
);

CREATE INDEX IF NOT EXISTS idx_tasks_root_status
ON tasks(root_id, status, priority DESC, created_at);

CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  depends_on_task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  condition TEXT NOT NULL DEFAULT 'success',
  PRIMARY KEY (task_id, depends_on_task_id)
);

CREATE TABLE IF NOT EXISTS task_attempts (
  attempt_id TEXT PRIMARY KEY,
  root_id TEXT NOT NULL REFERENCES runs(root_id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  attempt_no INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'assigned',
  retryable INTEGER,
  result_json TEXT,
  started_at REAL,
  finished_at REAL,
  UNIQUE(task_id, attempt_no)
);

CREATE TABLE IF NOT EXISTS agents (
  agent_id TEXT PRIMARY KEY,
  root_id TEXT NOT NULL REFERENCES runs(root_id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL REFERENCES task_attempts(attempt_id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'received',
  actor_token_hash TEXT NOT NULL,
  session_name TEXT,
  job_id TEXT,
  backend_id TEXT,
  agent_key TEXT,
  model_tier TEXT,
  model_name TEXT,
  heartbeat_at REAL,
  last_error TEXT,
  created_at REAL NOT NULL,
  finished_at REAL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_attempt
ON agents(attempt_id);

CREATE TABLE IF NOT EXISTS execution_sessions (
  attempt_id TEXT PRIMARY KEY REFERENCES task_attempts(attempt_id) ON DELETE CASCADE,
  root_id TEXT NOT NULL REFERENCES runs(root_id) ON DELETE CASCADE,
  backend_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  owner_nonce TEXT,
  session_name TEXT NOT NULL,
  execution_id TEXT NOT NULL UNIQUE,
  config_json TEXT NOT NULL,
  acp_session_id TEXT,
  worker_pid INTEGER,
  agent_pid INTEGER,
  control_endpoint TEXT,
  agent_key TEXT,
  protocol_version INTEGER,
  capabilities_json TEXT,
  status TEXT NOT NULL,
  prompt_state TEXT,
  last_worker_heartbeat_at REAL,
  last_event_at REAL,
  exit_reason TEXT,
  created_at REAL NOT NULL,
  ready_at REAL,
  stop_requested_at REAL,
  reconciled_at REAL,
  closed_at REAL
);

CREATE INDEX IF NOT EXISTS idx_execution_sessions_root_status
ON execution_sessions(root_id, status);

CREATE TABLE IF NOT EXISTS run_notes (
  note_id INTEGER PRIMARY KEY AUTOINCREMENT,
  root_id TEXT NOT NULL REFERENCES runs(root_id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(task_id),
  agent_id TEXT NOT NULL REFERENCES agents(agent_id),
  category TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'task',
  content TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  supersedes_id INTEGER REFERENCES run_notes(note_id),
  active INTEGER NOT NULL DEFAULT 1,
  created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS side_effect_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  root_id TEXT NOT NULL REFERENCES runs(root_id) ON DELETE CASCADE,
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

CREATE TABLE IF NOT EXISTS processed_actions (
  root_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  response_json TEXT NOT NULL,
  processed_at REAL NOT NULL,
  PRIMARY KEY (root_id, action_id)
);

CREATE TABLE IF NOT EXISTS events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  root_id TEXT NOT NULL,
  task_id TEXT,
  attempt_id TEXT,
  agent_id TEXT,
  action_id TEXT,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_root
ON events(root_id, event_id);
"""


def now():
    return time.time()


def runtime_root():
    override = os.environ.get(RUNTIME_HOME_ENV, "").strip()
    if override:
        return pathlib.Path(override).expanduser().resolve()
    return (pathlib.Path.home() / RUNTIME_HOME_DIRECTORY).resolve()


def db_path():
    return runtime_root() / "runtime-v2.sqlite3"


def legacy_db_path():
    return runtime_root() / "state.sqlite3"


def _legacy_runtime_roots():
    """Locations used only to import the previous Agent Swarm v2 runtime."""
    roots = []
    override = os.environ.get(MIGRATION_SOURCE_ENV, "").strip()
    if override:
        roots.append(pathlib.Path(override).expanduser().resolve())
    # A caller who chooses an explicit new home expects an isolated runtime. In
    # that case only an explicitly supplied previous-home source may be imported.
    if not os.environ.get(RUNTIME_HOME_ENV, "").strip():
        roots.append((pathlib.Path.home() / LEGACY_RUNTIME_HOME_DIRECTORY).resolve())
    current = runtime_root()
    return [root for index, root in enumerate(roots) if root != current and root not in roots[:index]]


def _legacy_v2_db_paths():
    target = db_path()
    return [
        root / "runtime-v2.sqlite3"
        for root in _legacy_runtime_roots()
        if root / "runtime-v2.sqlite3" != target
    ]


def _legacy_kind_round_db_paths():
    paths = [legacy_db_path()]
    paths.extend(root / "state.sqlite3" for root in _legacy_runtime_roots())
    return [path for index, path in enumerate(paths) if path not in paths[:index]]


def _is_v2_database(path):
    try:
        con = sqlite3.connect("%s?mode=ro" % path.resolve().as_uri(), uri=True)
        try:
            tables = {
                row[0]
                for row in con.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                ).fetchall()
            }
            return {"runs", "tasks", "task_attempts", "agents"}.issubset(tables)
        finally:
            con.close()
    except sqlite3.Error:
        return False


def _copy_legacy_v2_database(source, target):
    """Copy a prior v2 database without mutating the source or exposing a partial target."""
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=".runtime-v2-migration-", suffix=".sqlite3", dir=str(target.parent)
    )
    os.close(descriptor)
    temporary = pathlib.Path(temporary_name)
    try:
        source_con = sqlite3.connect("%s?mode=ro" % source.resolve().as_uri(), uri=True)
        target_con = sqlite3.connect(str(temporary))
        try:
            source_con.backup(target_con)
        finally:
            target_con.close()
            source_con.close()
        if not target.exists():
            temporary.replace(target)
    finally:
        if temporary.exists():
            temporary.unlink()


@contextlib.contextmanager
def _runtime_lock(runtime_home, name):
    lock_path = runtime_home / name
    with lock_path.open("a+") as lock:
        try:
            import fcntl
        except ImportError:
            yield
            return
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def _runtime_asset_source_root():
    return pathlib.Path(__file__).resolve().parent.parent


def _asset_digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _runtime_asset_manifest(source_root):
    files = [
        source_root / "scripts" / name
        for name in RUNTIME_HOOK_SCRIPTS
    ] + [
        source_root / "hooks" / name
        for name in RUNTIME_HOOK_FILES
    ]
    return {
        source.relative_to(source_root).as_posix(): _asset_digest(source)
        for source in files
        if source.is_file()
    }


def _read_runtime_asset_manifest(path):
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return {}
    files = data.get("files") if isinstance(data, dict) else None
    return files if isinstance(files, dict) else {}


def _safe_runtime_relative_path(relative):
    path = pathlib.PurePosixPath(relative)
    if path.is_absolute() or ".." in path.parts:
        return None
    return path


def _runtime_assets_match(target_root, assets):
    recorded = _read_runtime_asset_manifest(target_root / RUNTIME_ASSET_MANIFEST)
    if recorded != assets:
        return False
    for relative, digest in assets.items():
        safe_path = _safe_runtime_relative_path(relative)
        target = target_root / safe_path if safe_path is not None else None
        if target is None or not target.is_file() or _asset_digest(target) != digest:
            return False
    return True


def _copy_runtime_asset(source, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=".%s-" % target.name, suffix=".tmp", dir=str(target.parent)
    )
    os.close(descriptor)
    temporary = pathlib.Path(temporary_name)
    try:
        shutil.copy2(str(source), str(temporary))
        temporary.replace(target)
    finally:
        if temporary.exists():
            temporary.unlink()


def _write_runtime_asset_manifest(path, assets):
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps({"files": assets}, sort_keys=True, indent=2) + "\n")
    temporary.replace(path)


def ensure_runtime_assets():
    """Install only the minimal Hook runtime beneath the current Agent Swarm home."""
    source_root = _runtime_asset_source_root()
    target_root = runtime_root()
    if source_root == target_root:
        return target_root
    assets = _runtime_asset_manifest(source_root)
    target_root.mkdir(parents=True, exist_ok=True)
    with _runtime_lock(target_root, ".runtime-assets.lock"):
        if _runtime_assets_match(target_root, assets):
            return target_root
        previous_assets = _read_runtime_asset_manifest(target_root / RUNTIME_ASSET_MANIFEST)
        for relative in assets:
            safe_path = _safe_runtime_relative_path(relative)
            if safe_path is not None:
                _copy_runtime_asset(source_root / safe_path, target_root / safe_path)
        for relative in previous_assets:
            safe_path = _safe_runtime_relative_path(relative)
            if safe_path is None or relative in assets:
                continue
            stale = target_root / safe_path
            if stale.is_file():
                stale.unlink()
        _write_runtime_asset_manifest(target_root / RUNTIME_ASSET_MANIFEST, assets)
    return target_root


def _migrate_previous_v2_database(target):
    if target.exists():
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    with _runtime_lock(target.parent, ".runtime-v2-migration.lock"):
        if target.exists():
            return
        for source in _legacy_v2_db_paths():
            if source.exists() and _is_v2_database(source):
                _copy_legacy_v2_database(source, target)
                return


def legacy_active_runs_for_cwd(cwd):
    """Read-only guard against starting v2 beside an unfinished legacy Run."""
    rows = []
    for path in _legacy_kind_round_db_paths():
        if not path.exists():
            continue
        con = None
        try:
            con = sqlite3.connect("%s?mode=ro" % path.resolve().as_uri(), uri=True)
            con.row_factory = sqlite3.Row
            columns = {row["name"] for row in con.execute("PRAGMA table_info(runs)").fetchall()}
            if not {"root_id", "cwd", "status"}.issubset(columns):
                continue
            selected = "root_id, cwd, status"
            if "normalized_cwd" in columns:
                selected += ", normalized_cwd"
            rows.extend(dict(row) for row in con.execute("SELECT %s FROM runs" % selected).fetchall())
        except sqlite3.Error:
            continue
        finally:
            if con is not None:
                con.close()
    expected = os.path.realpath(cwd)
    return [
        row
        for row in rows
        if os.path.realpath(row.get("normalized_cwd") or row.get("cwd") or "") == expected
        and row.get("status") not in {"done", "cancelled"}
    ]


def connect():
    path = db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    _migrate_previous_v2_database(path)
    con = sqlite3.connect(str(path), isolation_level=None)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA busy_timeout = %d" % BUSY_TIMEOUT_MS)
    con.execute("PRAGMA journal_mode = WAL")
    con.execute("PRAGMA foreign_keys = ON")
    return con


def _columns(con, table):
    return {row["name"] for row in con.execute("PRAGMA table_info(%s)" % table).fetchall()}


def _historical_execution_json():
    return json.dumps(
        {
            "backend": "claude_cli",
            "claude_cli": {"command": "claude"},
            "acp": {
                "agent": "claude",
                "command": None,
                "args": [],
                "permission_policy": "allow_in_workspace",
                "prompt_timeout_seconds": None,
                "session_close_on_stop": True,
                "turn_end_reprompt_limit": 1,
            },
            "routing": {"by_intent": {}, "by_model_tier": {}},
        },
        sort_keys=True,
    )


def _migrate_schema(con):
    """Apply additive migrations to copied or existing v2 databases."""
    run_columns = _columns(con, "runs")
    if "execution_json" not in run_columns:
        con.execute("ALTER TABLE runs ADD COLUMN execution_json TEXT NOT NULL DEFAULT '{}'")
    if "child_token_seed_ref" not in run_columns:
        con.execute("ALTER TABLE runs ADD COLUMN child_token_seed_ref TEXT")
    if "child_token_seed_hash" not in run_columns:
        con.execute("ALTER TABLE runs ADD COLUMN child_token_seed_hash TEXT")
    agent_columns = _columns(con, "agents")
    if "backend_id" not in agent_columns:
        con.execute("ALTER TABLE agents ADD COLUMN backend_id TEXT")
    if "agent_key" not in agent_columns:
        con.execute("ALTER TABLE agents ADD COLUMN agent_key TEXT")

    historical = _historical_execution_json()
    con.execute(
        "UPDATE runs SET execution_json=? WHERE execution_json IS NULL OR execution_json='' OR execution_json='{}'",
        (historical,),
    )
    con.execute("UPDATE agents SET backend_id='claude_cli' WHERE backend_id IS NULL OR backend_id=''")
    con.execute("UPDATE agents SET agent_key='claude' WHERE agent_key IS NULL OR agent_key=''")

    rows = con.execute(
        """SELECT a.*, r.cwd FROM agents a JOIN runs r ON r.root_id=a.root_id
           WHERE (a.session_name IS NOT NULL OR a.job_id IS NOT NULL)
             AND NOT EXISTS (
               SELECT 1 FROM execution_sessions e WHERE e.attempt_id=a.attempt_id
             )"""
    ).fetchall()
    created = now()
    for row in rows:
        status = "closed" if row["state"] == "terminal" else (
            "starting" if row["state"] == "received" else "running"
        )
        config = json.dumps(
            {
                "backend": "claude_cli",
                "agent": "claude",
                "command": "claude",
                "args": [],
                "model": row["model_name"],
                "permission_policy": "bypassPermissions",
            },
            sort_keys=True,
        )
        con.execute(
            """INSERT INTO execution_sessions(
                 attempt_id, root_id, backend_id, generation, owner_nonce,
                 session_name, execution_id, config_json, agent_key, status,
                 created_at, ready_at, closed_at
               ) VALUES (?, ?, 'claude_cli', 1, NULL, ?, ?, ?, 'claude', ?, ?, ?, ?)""",
            (
                row["attempt_id"],
                row["root_id"],
                row["session_name"] or "agent-swarm-legacy-%s" % row["attempt_id"],
                "claude_cli:%s:1" % row["attempt_id"],
                config,
                status,
                row["created_at"] or created,
                row["created_at"] if status != "starting" else None,
                row["finished_at"] if status == "closed" else None,
            ),
        )

    open_effects = con.execute(
        """SELECT id, effect_type, payload_json FROM side_effect_outbox
           WHERE effect_type IN ('spawn_agent','stop_agent') AND status != 'completed'"""
    ).fetchall()
    for effect in open_effects:
        try:
            payload = json.loads(effect["payload_json"])
        except (TypeError, ValueError):
            continue
        if not isinstance(payload, dict):
            continue
        if all(
            key in payload
            for key in ("backend_id", "execution_id", "generation", "config_json")
        ):
            continue
        attempt_id = payload.get("attempt_id")
        execution = (
            con.execute(
                "SELECT * FROM execution_sessions WHERE attempt_id=?", (attempt_id,)
            ).fetchone()
            if attempt_id
            else None
        )
        if execution is not None:
            backend_id = execution["backend_id"]
            execution_id = execution["execution_id"]
            generation = execution["generation"]
            config_json = execution["config_json"]
        else:
            backend_id = "claude_cli"
            execution_id = "legacy-orphan:%s" % effect["id"]
            generation = 1
            config_json = json.dumps(
                {
                    "backend": "claude_cli",
                    "agent": "claude",
                    "command": "claude",
                    "args": [],
                    "model": None,
                    "permission_policy": "bypassPermissions",
                },
                sort_keys=True,
            )
        payload.update(
            {
                "backend_id": backend_id,
                "execution_id": execution_id,
                "generation": generation,
                "config_json": config_json,
            }
        )
        con.execute(
            "UPDATE side_effect_outbox SET payload_json=? WHERE id=?",
            (json.dumps(payload, ensure_ascii=False, sort_keys=True), effect["id"]),
        )


def initialize_schema():
    ensure_runtime_assets()
    con = connect()
    try:
        con.executescript(SCHEMA_SQL)
        _migrate_schema(con)
        con.execute(
            "INSERT INTO meta(key, value) VALUES('schema_version', ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (SCHEMA_VERSION,),
        )
    finally:
        con.close()


@contextlib.contextmanager
def transaction(immediate=True):
    initialize_schema()
    con = connect()
    try:
        con.execute("BEGIN IMMEDIATE" if immediate else "BEGIN")
        yield con
        con.commit()
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()


def _dict(row):
    return dict(row) if row is not None else None


def _one(sql, params=(), con=None):
    if con is not None:
        return _dict(con.execute(sql, params).fetchone())
    owned = connect()
    try:
        return _dict(owned.execute(sql, params).fetchone())
    finally:
        owned.close()


def fetchall(sql, params=(), con=None):
    if con is not None:
        return [dict(row) for row in con.execute(sql, params).fetchall()]
    owned = connect()
    try:
        return [dict(row) for row in owned.execute(sql, params).fetchall()]
    finally:
        owned.close()


def execute(sql, params=()):
    with transaction() as con:
        cursor = con.execute(sql, params)
        return cursor.rowcount


def get_run(root_id, con=None):
    return _one("SELECT * FROM runs WHERE root_id = ?", (root_id,), con)


def get_task(task_id, con=None):
    return _one("SELECT * FROM tasks WHERE task_id = ?", (task_id,), con)


def get_attempt(attempt_id, con=None):
    return _one("SELECT * FROM task_attempts WHERE attempt_id = ?", (attempt_id,), con)


def get_agent(agent_id, con=None):
    return _one("SELECT * FROM agents WHERE agent_id = ?", (agent_id,), con)


def get_outbox(effect_id, con=None):
    return _one("SELECT * FROM side_effect_outbox WHERE id = ?", (effect_id,), con)


def get_execution(attempt_id, con=None):
    return _one("SELECT * FROM execution_sessions WHERE attempt_id = ?", (attempt_id,), con)


def list_tasks(root_id, con=None):
    return fetchall(
        "SELECT * FROM tasks WHERE root_id = ? ORDER BY created_at, task_id", (root_id,), con
    )


def list_attempts(root_id, con=None):
    return fetchall(
        "SELECT * FROM task_attempts WHERE root_id = ? ORDER BY task_id, attempt_no", (root_id,), con
    )


def list_agents(root_id, con=None):
    return fetchall(
        "SELECT * FROM agents WHERE root_id = ? ORDER BY created_at, agent_id", (root_id,), con
    )


def list_notes(root_id, include_inactive=False, con=None):
    active = "" if include_inactive else " AND active = 1"
    return fetchall(
        "SELECT * FROM run_notes WHERE root_id = ?" + active + " ORDER BY created_at, note_id",
        (root_id,),
        con,
    )


def list_outbox(root_id, con=None):
    return fetchall(
        "SELECT * FROM side_effect_outbox WHERE root_id = ? ORDER BY id", (root_id,), con
    )


def list_executions(root_id, con=None):
    return fetchall(
        "SELECT * FROM execution_sessions WHERE root_id = ? ORDER BY created_at, attempt_id",
        (root_id,),
        con,
    )


def claim_execution_ownership(attempt_id, generation, owner_nonce, worker_pid):
    """Atomically fence ACP Worker ownership before it can Popen an Agent."""
    if not owner_nonce:
        raise ValueError("owner_nonce is required")
    with transaction() as con:
        timestamp = now()
        cursor = con.execute(
            """UPDATE execution_sessions
               SET owner_nonce=?, worker_pid=?, last_worker_heartbeat_at=?, last_event_at=?
               WHERE attempt_id=? AND generation=? AND owner_nonce IS NULL
                 AND stop_requested_at IS NULL AND status='starting'
                 AND EXISTS (
                   SELECT 1
                   FROM task_attempts a
                   JOIN tasks t ON t.task_id=a.task_id
                   JOIN runs r ON r.root_id=a.root_id
                   WHERE a.attempt_id=execution_sessions.attempt_id
                     AND a.status IN ('assigned','running')
                     AND t.current_attempt_id=a.attempt_id
                     AND t.status IN ('assigned','active','stopping')
                     AND r.status='running'
                 )""",
            (
                owner_nonce,
                int(worker_pid),
                timestamp,
                timestamp,
                attempt_id,
                int(generation),
            ),
        )
        return cursor.rowcount == 1


def list_events(root_id, limit=100, con=None):
    rows = fetchall(
        "SELECT * FROM events WHERE root_id = ? ORDER BY event_id DESC LIMIT ?",
        (root_id, int(limit)),
        con,
    )
    rows.reverse()
    return rows


def append_event(
    con,
    root_id,
    event_type,
    payload=None,
    task_id=None,
    attempt_id=None,
    agent_id=None,
    action_id=None,
):
    con.execute(
        """INSERT INTO events(
             root_id, task_id, attempt_id, agent_id, action_id, type, payload_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            root_id,
            task_id,
            attempt_id,
            agent_id,
            action_id,
            event_type,
            json.dumps(payload or {}, ensure_ascii=False, sort_keys=True),
            now(),
        ),
    )


def hash_token(token):
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def token_matches(token, expected_hash):
    if not token or not expected_hash:
        return False
    import hmac

    return hmac.compare_digest(hash_token(token), expected_hash)
