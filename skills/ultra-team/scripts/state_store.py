import contextlib
import fcntl
import os
import pathlib
import sqlite3
import time

RUNTIME_HOME_ENV = "ULTRA_TEAM_HOME"
FIX_BUDGET_ENV = "COORD_AGENT_FIX_BUDGET"
SCHEMA_VERSION = "1"
BUSY_TIMEOUT_MS = 5000

LEGAL_TRANSITIONS = {
    "running": {"done", "failed"},
    "done": set(),
    "failed": set(),
}

RUN_LEGAL_TRANSITIONS = {
    "running": {"done", "failed"},
    "done": set(),
    "failed": set(),
}


def now() -> float:
    return time.time()


def fix_budget_default() -> int:
    raw = os.environ.get(FIX_BUDGET_ENV, "").strip()
    return int(raw) if raw.isdigit() else 2


def runtime_root() -> pathlib.Path:
    override = os.environ.get(RUNTIME_HOME_ENV, "").strip()
    if override:
        return pathlib.Path(override).expanduser().resolve()
    return (pathlib.Path.home() / ".ultra-team").resolve()


def db_path() -> pathlib.Path:
    return runtime_root() / "state.sqlite3"


def _same_or_descendant_path(path: str, base: str) -> bool:
    if not path or not base:
        return False
    target = os.path.realpath(path)
    root = os.path.realpath(base)
    try:
        return target == root or os.path.commonpath([target, root]) == root
    except ValueError:
        return False


def connect() -> sqlite3.Connection:
    path = db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path)
    con.row_factory = sqlite3.Row
    con.execute(f"PRAGMA busy_timeout={BUSY_TIMEOUT_MS}")
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA foreign_keys=ON")
    return con


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS runs (
  root_id TEXT PRIMARY KEY,
  task TEXT,
  cwd TEXT NOT NULL,
  branch TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  fix_budget INTEGER NOT NULL DEFAULT 2,
  created_at REAL,
  finished_at REAL
);

CREATE TABLE IF NOT EXISTS agents (
  agent_id TEXT PRIMARY KEY,
  job_id TEXT,
  session_id TEXT,
  engine TEXT,
  root_id TEXT NOT NULL REFERENCES runs(root_id) ON DELETE CASCADE,
  parent_id TEXT,
  round INTEGER NOT NULL DEFAULT 0,
  role TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'implement',
  status TEXT NOT NULL DEFAULT 'running',
  intent TEXT,
  prompt TEXT,
  result TEXT,
  caveats TEXT,
  fix_attempt INTEGER NOT NULL DEFAULT 0,
  pid INTEGER,
  spawned_at REAL,
  last_reported_at REAL,
  transcript_path TEXT,
  transcript_latest_at REAL,
  finished_at REAL
);
CREATE INDEX IF NOT EXISTS idx_agents_parent_round ON agents(parent_id, round, status);
CREATE INDEX IF NOT EXISTS idx_agents_root ON agents(root_id, status);
"""


def schema_version(con: sqlite3.Connection):
    table = con.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").fetchone()
    if table is None:
        return None
    row = con.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
    return row["value"] if row else None


def ensure_schema(con: sqlite3.Connection) -> None:
    version = schema_version(con)
    if version is not None and version != SCHEMA_VERSION:
        raise RuntimeError(f"unsupported state schema {version}; expected {SCHEMA_VERSION}; rebuild required")
    con.executescript(SCHEMA_SQL)
    con.execute("INSERT OR IGNORE INTO meta(key, value) VALUES('schema_version', ?)", (SCHEMA_VERSION,))
    con.commit()


def rebuild_schema(con: sqlite3.Connection) -> None:
    con.execute("PRAGMA foreign_keys=OFF")
    rows = con.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchall()
    for row in rows:
        con.execute(f'DROP TABLE IF EXISTS "{row["name"]}"')
    con.commit()
    con.execute("PRAGMA foreign_keys=ON")
    con.executescript(SCHEMA_SQL)
    con.execute("INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', ?)", (SCHEMA_VERSION,))
    con.commit()


@contextlib.contextmanager
def locked_run(root_id: str):
    lock_dir = runtime_root() / "locks"
    lock_dir.mkdir(parents=True, exist_ok=True)
    lock_file = lock_dir / f"{root_id}.lock"
    with open(lock_file, "a+", encoding="utf-8") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def create_run(root_id: str, task: str, cwd: str, branch=None) -> None:
    ts = now()
    with locked_run(root_id):
        con = connect()
        ensure_schema(con)
        con.execute(
            "INSERT INTO runs(root_id, task, cwd, branch, status, fix_budget, created_at) "
            "VALUES(?,?,?,?, 'running', ?, ?)",
            (root_id, task, cwd, branch, fix_budget_default(), ts),
        )
        con.execute(
            "INSERT INTO agents(agent_id, root_id, parent_id, round, role, kind, status, spawned_at, last_reported_at) "
            "VALUES(?, ?, NULL, 0, 'root', 'implement', 'running', ?, ?)",
            (root_id, root_id, ts, ts),
        )
        con.commit()
        con.close()


def add_agent(agent_id: str, root_id: str, parent_id: str, round_: int, kind: str, prompt: str, intent=None) -> None:
    ts = now()
    with locked_run(root_id):
        con = connect()
        ensure_schema(con)
        con.execute(
            "INSERT INTO agents(agent_id, root_id, parent_id, round, role, kind, status, intent, prompt, spawned_at, last_reported_at) "
            "VALUES(?, ?, ?, ?, 'child', ?, 'running', ?, ?, ?, ?)",
            (agent_id, root_id, parent_id, round_, kind, intent, prompt, ts, ts),
        )
        con.commit()
        con.close()


def set_job(agent_id: str, root_id: str, job_id: str, session_id, engine=None) -> None:
    with locked_run(root_id):
        con = connect()
        ensure_schema(con)
        con.execute(
            "UPDATE agents SET job_id=?, session_id=?, engine=COALESCE(?, engine) WHERE agent_id=?",
            (job_id, session_id, engine, agent_id),
        )
        con.commit()
        con.close()


def update_transcript_activity(
    agent_id: str,
    root_id: str,
    transcript_path: str,
    latest_at: float,
    observed_at=None,
):
    if not agent_id or not root_id or not transcript_path:
        return None
    with locked_run(root_id):
        con = connect()
        ensure_schema(con)
        row = con.execute(
            "SELECT transcript_latest_at FROM agents WHERE agent_id=? AND root_id=? AND status='running'",
            (agent_id, root_id),
        ).fetchone()
        if row is None:
            con.close()
            return None
        previous = row["transcript_latest_at"]
        changed = latest_at is not None and (previous is None or float(latest_at) > float(previous))
        if changed:
            activity_at = max(float(previous or 0), float(latest_at or 0))
            con.execute(
                "UPDATE agents SET transcript_path=?, transcript_latest_at=?, last_reported_at=MAX(COALESCE(last_reported_at, 0), ?) "
                "WHERE agent_id=? AND root_id=? AND status='running'",
                (transcript_path, activity_at, activity_at, agent_id, root_id),
            )
            con.commit()
        con.close()
        return {
            "agent_id": agent_id,
            "root_id": root_id,
            "transcript_path": transcript_path,
            "latest_at": max(float(previous or 0), float(latest_at or 0)) if changed else latest_at,
            "previous_latest_at": previous,
            "changed": changed,
        }


def touch_agent_activity(agent_id: str, root_id: str, ts=None) -> None:
    with locked_run(root_id):
        con = connect()
        ensure_schema(con)
        con.execute(
            "UPDATE agents SET last_reported_at=? WHERE agent_id=? AND root_id=?",
            (now() if ts is None else ts, agent_id, root_id),
        )
        con.commit()
        con.close()


def touch_running_agent_by_id(agent_id: str, root_id=None, ts=None):
    if not agent_id:
        return []
    timestamp = now() if ts is None else ts
    lock_id = root_id or "hook-activity"
    with locked_run(lock_id):
        con = connect()
        ensure_schema(con)
        predicates = ["a.agent_id=?", "a.status='running'", "r.status='running'"]
        params = [agent_id]
        if root_id:
            predicates.append("a.root_id=?")
            params.append(root_id)
        rows = con.execute(
            f"SELECT a.agent_id, a.root_id FROM agents a JOIN runs r ON a.root_id=r.root_id "
            f"WHERE {' AND '.join(predicates)}",
            params,
        ).fetchall()
        touched = []
        for row in rows:
            con.execute(
                "UPDATE agents SET last_reported_at=? WHERE agent_id=? AND root_id=? AND status='running'",
                (timestamp, row["agent_id"], row["root_id"]),
            )
            touched.append({"agent_id": row["agent_id"], "root_id": row["root_id"]})
        con.commit()
        con.close()
        return touched


def touch_running_agents_for_hook(cwd: str, agent_id=None, root_id=None, job_id=None, branch=None, ts=None, session_id=None):
    timestamp = now() if ts is None else ts
    target = os.path.realpath(cwd) if cwd else None
    fallback_root_id = root_id
    fallback_branch = branch

    with locked_run(fallback_root_id or "hook-activity"):
        con = connect()
        ensure_schema(con)
        if not (job_id or session_id or target):
            con.close()
            return []

        def select_rows(extra_predicate=None, value=None, *, root_only=False, use_fallback_filters=True):
            params = []
            predicates = ["a.status='running'", "r.status='running'"]
            if use_fallback_filters and fallback_root_id:
                predicates.append("a.root_id=?")
                params.append(fallback_root_id)
            if root_only:
                predicates.append("a.agent_id=a.root_id")
            if extra_predicate:
                predicates.append(extra_predicate)
                params.append(value)
            elif target:
                predicates.append("r.cwd IS NOT NULL")
            rows_ = con.execute(
                f"SELECT a.agent_id, a.root_id, r.cwd, r.branch FROM agents a JOIN runs r ON a.root_id=r.root_id "
                f"WHERE {' AND '.join(predicates)}",
                params,
            ).fetchall()
            if target:
                rows_ = [row for row in rows_ if _same_or_descendant_path(target, row["cwd"])]
            if use_fallback_filters and fallback_branch is not None:
                rows_ = [row for row in rows_ if (row["branch"] or "") == fallback_branch]
            return rows_

        if session_id:
            rows = select_rows("a.session_id=?", session_id, use_fallback_filters=False)
        elif job_id:
            rows = select_rows("a.job_id=?", job_id, use_fallback_filters=False)
        else:
            # Cwd/branch is not a precise child identity. Use it only to keep
            # the foreground root alive; child liveness must come from exact
            # agent_id/session_id/job_id evidence.
            rows = select_rows(root_only=True)

        if not rows and target and (session_id or job_id):
            rows = select_rows(root_only=True)

        touched = []
        for row in rows:
            con.execute(
                "UPDATE agents SET last_reported_at=? WHERE agent_id=? AND root_id=? AND status='running'",
                (timestamp, row["agent_id"], row["root_id"]),
            )
            touched.append({"agent_id": row["agent_id"], "root_id": row["root_id"]})
        con.commit()
        con.close()
        if touched:
            return touched

    return []


def get_run(root_id: str):
    con = connect()
    ensure_schema(con)
    row = con.execute("SELECT * FROM runs WHERE root_id=?", (root_id,)).fetchone()
    con.close()
    return dict(row) if row else None


def get_agent(agent_id: str):
    con = connect()
    ensure_schema(con)
    row = con.execute("SELECT * FROM agents WHERE agent_id=?", (agent_id,)).fetchone()
    con.close()
    return dict(row) if row else None


def agents_by_session_id(session_id: str, cwd=None, root_id=None):
    if not session_id:
        return []
    target = os.path.realpath(cwd) if cwd else None
    con = connect()
    ensure_schema(con)
    predicates = ["a.session_id=?"]
    params = [session_id]
    if root_id:
        predicates.append("a.root_id=?")
        params.append(root_id)
    rows = con.execute(
        f"SELECT a.*, r.cwd AS run_cwd, r.status AS run_status FROM agents a "
        f"JOIN runs r ON a.root_id=r.root_id WHERE {' AND '.join(predicates)}",
        params,
    ).fetchall()
    con.close()
    result = [dict(r) for r in rows]
    if target:
        result = [
            row for row in result
            if row.get("run_cwd") and _same_or_descendant_path(target, row["run_cwd"])
        ]
    return result


def transition(agent_id: str, root_id: str, new_status: str, result=None, caveats=None) -> None:
    with locked_run(root_id):
        con = connect()
        ensure_schema(con)
        row = con.execute("SELECT status FROM agents WHERE agent_id=?", (agent_id,)).fetchone()
        if row is None:
            con.close()
            raise KeyError(f"unknown agent: {agent_id}")
        current = row["status"]
        if new_status not in LEGAL_TRANSITIONS.get(current, set()):
            con.close()
            raise ValueError(f"illegal transition {current} -> {new_status} for {agent_id}")
        con.execute(
            "UPDATE agents SET status=?, result=COALESCE(?, result), caveats=COALESCE(?, caveats), "
            "finished_at=? WHERE agent_id=?",
            (new_status, result, caveats, now(), agent_id),
        )
        con.commit()
        con.close()


def finish(agent_id: str, root_id: str, result, caveats=None) -> None:
    transition(agent_id, root_id, "done", result, caveats)


def fail(agent_id: str, root_id: str, reason) -> None:
    transition(agent_id, root_id, "failed", reason, None)


def fail_if_running(agent_id: str, root_id: str, reason) -> bool:
    with locked_run(root_id):
        con = connect()
        ensure_schema(con)
        cur = con.execute(
            "UPDATE agents SET status='failed', result=COALESCE(?, result), finished_at=? "
            "WHERE agent_id=? AND status='running'",
            (reason, now(), agent_id),
        )
        changed = cur.rowcount > 0
        con.commit()
        con.close()
        return changed


def fail_all_running(root_id: str, reason: str) -> int:
    with locked_run(root_id):
        con = connect()
        ensure_schema(con)
        cur = con.execute(
            "UPDATE agents SET status='failed', result=COALESCE(?, result), finished_at=? "
            "WHERE root_id=? AND status='running'",
            (reason, now(), root_id),
        )
        changed = cur.rowcount
        con.commit()
        con.close()
        return changed


def bump_fix_attempt(agent_id: str, root_id: str) -> None:
    with locked_run(root_id):
        con = connect()
        ensure_schema(con)
        con.execute("UPDATE agents SET fix_attempt = fix_attempt + 1 WHERE agent_id=?", (agent_id,))
        con.commit()
        con.close()


def set_run_status(root_id: str, status: str) -> None:
    with locked_run(root_id):
        con = connect()
        ensure_schema(con)
        row = con.execute("SELECT status FROM runs WHERE root_id=?", (root_id,)).fetchone()
        if row is None:
            con.close()
            raise KeyError(f"unknown run: {root_id}")
        current = row["status"]
        if status != current and status not in RUN_LEGAL_TRANSITIONS.get(current, set()):
            con.close()
            raise ValueError(f"illegal run transition {current} -> {status} for {root_id}")
        con.execute("UPDATE runs SET status=?, finished_at=? WHERE root_id=?", (status, now(), root_id))
        con.commit()
        con.close()


def round_children(parent_id: str, round_: int):
    con = connect()
    ensure_schema(con)
    rows = con.execute(
        "SELECT * FROM agents WHERE parent_id=? AND round=? ORDER BY spawned_at", (parent_id, round_)
    ).fetchall()
    con.close()
    return [dict(r) for r in rows]


def direct_children(parent_id: str):
    con = connect()
    ensure_schema(con)
    rows = con.execute(
        "SELECT * FROM agents WHERE parent_id=? ORDER BY spawned_at", (parent_id,)
    ).fetchall()
    con.close()
    return [dict(r) for r in rows]


def subtree_agents(agent_id: str):
    con = connect()
    ensure_schema(con)
    rows = con.execute(
        """
        WITH RECURSIVE subtree AS (
          SELECT * FROM agents WHERE agent_id=?
          UNION ALL
          SELECT a.* FROM agents a JOIN subtree s ON a.parent_id=s.agent_id
        )
        SELECT * FROM subtree ORDER BY spawned_at
        """,
        (agent_id,),
    ).fetchall()
    con.close()
    return [dict(r) for r in rows]


def list_runs():
    con = connect()
    ensure_schema(con)
    rows = con.execute("SELECT * FROM runs ORDER BY created_at DESC").fetchall()
    con.close()
    return [dict(r) for r in rows]


def runs_for_cwd(cwd: str):
    target = os.path.realpath(cwd)
    return [
        run for run in list_runs()
        if run.get("cwd") and os.path.realpath(run["cwd"]) == target
    ]


def get_tree(root_id: str):
    con = connect()
    ensure_schema(con)
    run = con.execute("SELECT * FROM runs WHERE root_id=?", (root_id,)).fetchone()
    agents = con.execute("SELECT * FROM agents WHERE root_id=? ORDER BY round, spawned_at", (root_id,)).fetchall()
    con.close()
    return {"run": dict(run) if run else None, "agents": [dict(a) for a in agents]}


def running_jobs(root_id: str):
    con = connect()
    ensure_schema(con)
    rows = con.execute(
        "SELECT agent_id, job_id, engine FROM agents WHERE root_id=? AND status='running' AND job_id IS NOT NULL",
        (root_id,),
    ).fetchall()
    con.close()
    return [dict(r) for r in rows]


def recorded_jobs(root_id: str):
    con = connect()
    ensure_schema(con)
    rows = con.execute(
        "SELECT agent_id, job_id, engine, status FROM agents WHERE root_id=? AND job_id IS NOT NULL ORDER BY spawned_at",
        (root_id,),
    ).fetchall()
    con.close()
    return [dict(r) for r in rows]
