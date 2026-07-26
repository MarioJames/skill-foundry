"""SQLite facts for the clean-break Agent Swarm Runtime schema."""

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
RUNTIME_HOME_DIRECTORY = ".agent-swarm"
SCHEMA_VERSION = 1
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
"""


def now():
    return time.time()


def runtime_root():
    override = os.environ.get(RUNTIME_HOME_ENV, "").strip()
    if override:
        return pathlib.Path(override).expanduser().resolve()
    return (pathlib.Path.home() / RUNTIME_HOME_DIRECTORY).resolve()


def db_path():
    return runtime_root() / "runtime.sqlite3"


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


def connect():
    path = db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(path), isolation_level=None)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA busy_timeout = %d" % BUSY_TIMEOUT_MS)
    con.execute("PRAGMA journal_mode = WAL")
    con.execute("PRAGMA foreign_keys = ON")
    return con


def initialize_schema():
    ensure_runtime_assets()
    con = connect()
    try:
        con.executescript(SCHEMA_SQL)
        con.execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)",
            (SCHEMA_VERSION, now()),
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
    return _one(
        """SELECT a.*, t.root_id
           FROM attempts a JOIN tasks t ON t.task_id=a.task_id
           WHERE a.attempt_id=?""",
        (attempt_id,),
        con,
    )


def get_current_attempt(task_id, con=None):
    return _one(
        """SELECT a.*, t.root_id
           FROM attempts a JOIN tasks t ON t.task_id=a.task_id
           WHERE a.task_id=? ORDER BY a.attempt_no DESC LIMIT 1""",
        (task_id,),
        con,
    )


def get_effect(effect_id, con=None):
    return _one("SELECT * FROM effects WHERE id = ?", (effect_id,), con)


def get_launch(launch_id, con=None):
    return _one(
        """SELECT l.*, a.task_id, a.backend_id, a.agent_type, a.config_json, t.root_id
           FROM launches l
           JOIN attempts a ON a.attempt_id=l.attempt_id
           JOIN tasks t ON t.task_id=a.task_id
           WHERE l.launch_id=?""",
        (launch_id,),
        con,
    )


def get_current_launch(attempt_id, con=None):
    return _one(
        """SELECT l.*, a.task_id, a.backend_id, a.agent_type, a.config_json, t.root_id
           FROM launches l
           JOIN attempts a ON a.attempt_id=l.attempt_id
           JOIN tasks t ON t.task_id=a.task_id
           WHERE l.attempt_id=? ORDER BY l.launch_no DESC LIMIT 1""",
        (attempt_id,),
        con,
    )


def get_session(session_pk, con=None):
    return _one(
        """SELECT s.*, p.agent_type, p.package_name, p.adapter_version,
                  p.command, p.state_namespace, p.config_json AS profile_config_json,
                  l.attempt_id, a.task_id, t.root_id
           FROM acp_sessions s
           JOIN agent_profiles p ON p.profile_id=s.profile_id
           JOIN launches l ON l.launch_id=s.launch_id
           JOIN attempts a ON a.attempt_id=l.attempt_id
           JOIN tasks t ON t.task_id=a.task_id
           WHERE s.session_pk=?""",
        (session_pk,),
        con,
    )


def get_session_for_launch(launch_id, con=None):
    return _one(
        """SELECT s.*, p.agent_type, p.package_name, p.adapter_version,
                  p.command, p.state_namespace, p.config_json AS profile_config_json
           FROM acp_sessions s JOIN agent_profiles p ON p.profile_id=s.profile_id
           WHERE s.launch_id=?""",
        (launch_id,),
        con,
    )


def find_session(agent_type, external_session_id, root_id=None, con=None):
    root_filter = " AND t.root_id=?" if root_id is not None else ""
    params = [agent_type, external_session_id]
    if root_id is not None:
        params.append(root_id)
    return fetchall(
        """SELECT s.*, p.agent_type, p.package_name, p.adapter_version,
                  p.command, p.state_namespace, p.config_json AS profile_config_json,
                  l.attempt_id, a.task_id, t.root_id
           FROM acp_sessions s
           JOIN agent_profiles p ON p.profile_id=s.profile_id
           JOIN launches l ON l.launch_id=s.launch_id
           JOIN attempts a ON a.attempt_id=l.attempt_id
           JOIN tasks t ON t.task_id=a.task_id
           WHERE p.agent_type=? AND s.external_session_id=?""" + root_filter,
        tuple(params),
        con,
    )


def list_tasks(root_id, con=None):
    return fetchall(
        "SELECT * FROM tasks WHERE root_id = ? ORDER BY created_at, task_id", (root_id,), con
    )


def list_attempts(root_id, con=None):
    return fetchall(
        """SELECT a.*, t.root_id FROM attempts a
           JOIN tasks t ON t.task_id=a.task_id
           WHERE t.root_id=? ORDER BY a.task_id, a.attempt_no""",
        (root_id,),
        con,
    )


def list_launches(root_id, con=None):
    return fetchall(
        """SELECT l.*, a.task_id, a.backend_id, a.agent_type, a.config_json, t.root_id
           FROM launches l
           JOIN attempts a ON a.attempt_id=l.attempt_id
           JOIN tasks t ON t.task_id=a.task_id
           WHERE t.root_id=? ORDER BY l.created_at, l.launch_id""",
        (root_id,),
        con,
    )


def list_sessions(root_id, con=None):
    return fetchall(
        """SELECT s.*, p.agent_type, p.package_name, p.adapter_version,
                  p.command, p.state_namespace, l.attempt_id, a.task_id, t.root_id
           FROM acp_sessions s
           JOIN agent_profiles p ON p.profile_id=s.profile_id
           JOIN launches l ON l.launch_id=s.launch_id
           JOIN attempts a ON a.attempt_id=l.attempt_id
           JOIN tasks t ON t.task_id=a.task_id
           WHERE t.root_id=? ORDER BY s.created_at, s.session_pk""",
        (root_id,),
        con,
    )


def list_notes(root_id, include_inactive=False, con=None):
    active = "" if include_inactive else " AND active = 1"
    return fetchall(
        "SELECT * FROM run_notes WHERE root_id = ?" + active + " ORDER BY created_at, note_id",
        (root_id,),
        con,
    )


def list_effects(root_id, con=None):
    return fetchall(
        "SELECT * FROM effects WHERE root_id = ? ORDER BY id", (root_id,), con
    )


def ensure_agent_profile(con, config, *, state_namespace="default"):
    agent_type = config.get("agent") or "custom"
    package_name = config.get("package") or ""
    adapter_version = str(config.get("profile_version") or "")
    command = config.get("command") or config.get("resolved_command") or ""
    encoded = json.dumps(config, ensure_ascii=False, sort_keys=True)
    con.execute(
        """INSERT OR IGNORE INTO agent_profiles(
             agent_type, package_name, adapter_version, command,
             state_namespace, config_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (
            agent_type,
            package_name,
            adapter_version,
            command,
            state_namespace,
            encoded,
            now(),
        ),
    )
    row = con.execute(
        """SELECT profile_id FROM agent_profiles
           WHERE agent_type=? AND package_name=? AND adapter_version=?
             AND command=? AND state_namespace=?""",
        (agent_type, package_name, adapter_version, command, state_namespace),
    ).fetchone()
    return row["profile_id"]


def claim_launch_ownership(launch_id, owner_nonce, worker_pid):
    """Atomically fence ACP Worker ownership before it can Popen an Agent."""
    if not owner_nonce:
        raise ValueError("owner_nonce is required")
    with transaction() as con:
        timestamp = now()
        cursor = con.execute(
            """UPDATE launches
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
                 )""",
            (
                owner_nonce,
                int(worker_pid),
                timestamp,
                timestamp,
                int(launch_id),
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
    session_pk=None,
    action_id=None,
):
    con.execute(
        """INSERT INTO events(
             root_id, task_id, attempt_id, session_pk, action_id, type, payload_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            root_id,
            task_id,
            attempt_id,
            session_pk,
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
