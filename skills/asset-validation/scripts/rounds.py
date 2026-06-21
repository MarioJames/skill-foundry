from . import db


def _append(con, table, col, row_id, text):
    cur = con.execute(f"SELECT {col} FROM {table} WHERE id=?", (row_id,)).fetchone()
    existing = (cur[0] if cur and cur[0] else "")
    joined = (existing + ("\n" if existing else "") + text)
    con.execute(f"UPDATE {table} SET {col}=? WHERE id=?", (joined, row_id))
    con.commit()


def start_round(con, acceptance_id, *, mode, n, sandbox_path=None) -> str:
    rid = db.new_id("round")
    con.execute(
        "INSERT INTO round (id, acceptance_id, round_tag, mode, verdict, "
        "sandbox_path, started_at) VALUES (?,?,?,?, 'running', ?, ?)",
        (rid, acceptance_id, db.round_tag(n), mode, sandbox_path, db.now()),
    )
    con.execute(
        "UPDATE acceptance SET status='active', updated_at=? WHERE id=?",
        (db.now(), acceptance_id),
    )
    con.commit()
    return rid


def get_round_target(con, round_id):
    return con.execute(
        "SELECT id, acceptance_id, round_tag, sandbox_path FROM round WHERE id=?",
        (round_id,),
    ).fetchone()


def get_launch_target(con, round_id):
    return con.execute(
        "SELECT r.id, r.round_tag, r.sandbox_path, "
        "asset.name AS asset_name, asset.type AS asset_type, "
        "asset.source_path AS asset_source "
        "FROM round r "
        "JOIN acceptance a ON a.id=r.acceptance_id "
        "JOIN asset ON asset.id=a.asset_id "
        "WHERE r.id=?",
        (round_id,),
    ).fetchone()


def get_cleanup_target(con, round_id):
    return con.execute(
        "SELECT r.id, r.acceptance_id, r.round_tag, r.sandbox_path, "
        "asset.name AS asset_name, asset.type AS asset_type, "
        "asset.source_path AS asset_source "
        "FROM round r "
        "JOIN acceptance a ON a.id=r.acceptance_id "
        "JOIN asset ON asset.id=a.asset_id "
        "WHERE r.id=?",
        (round_id,),
    ).fetchone()


def set_sandbox_path(con, round_id, sandbox_path) -> None:
    con.execute("UPDATE round SET sandbox_path=? WHERE id=?", (str(sandbox_path), round_id))
    con.commit()


def list_rounds(con, *, acceptance_id=None, verdict=None):
    sql = "SELECT * FROM round"
    where, args = [], []
    if acceptance_id:
        where.append("acceptance_id=?")
        args.append(acceptance_id)
    if verdict:
        where.append("verdict=?")
        args.append(verdict)
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY started_at"
    return con.execute(sql, args).fetchall()


def record(con, round_id, *, transcript=None, report_append=None) -> None:
    if transcript is not None:
        con.execute("UPDATE round SET transcript=? WHERE id=?", (transcript, round_id))
        con.commit()
    if report_append:
        _append(con, "round", "report", round_id, report_append)


def add_finding(con, round_id, *, severity, status, summary) -> None:
    line = f"- [{severity}/{status}] {summary}"
    _append(con, "round", "report", round_id, line)
    acc_id = con.execute(
        "SELECT acceptance_id FROM round WHERE id=?", (round_id,)
    ).fetchone()[0]
    _append(con, "acceptance", "issues", acc_id, line)


def finalize(con, round_id, *, verdict, next_round_reco=None, report_append=None) -> None:
    if report_append:
        _append(con, "round", "report", round_id, report_append)
    con.execute(
        "UPDATE round SET verdict=?, next_round_reco=?, ended_at=? WHERE id=?",
        (verdict, next_round_reco, db.now(), round_id),
    )
    con.commit()


def open_issues(con, acceptance_id) -> str:
    row = con.execute(
        "SELECT issues FROM acceptance WHERE id=?", (acceptance_id,)
    ).fetchone()
    return row[0] if row and row[0] else ""
