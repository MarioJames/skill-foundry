import json
from pathlib import Path

from . import db

_ACCEPTANCE_COLS = {
    "goal", "strategy", "acceptance_prompt", "acceptance_criteria",
    "task_prompts", "issues", "fixture_path", "status",
}


def _stable_path(path):
    return str(Path(path).expanduser().resolve()) if path else path


def add_asset(con, name, type, source_path) -> str:
    aid = db.new_id("asset")
    con.execute(
        "INSERT INTO asset (id, name, type, source_path, created_at) VALUES (?,?,?,?,?)",
        (aid, name, type, _stable_path(source_path), db.now()),
    )
    con.commit()
    return aid


def get_asset_by_name(con, name):
    return con.execute("SELECT * FROM asset WHERE name=?", (name,)).fetchone()


def get_asset(con, value):
    return con.execute(
        "SELECT * FROM asset WHERE id=? OR name=? "
        "ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END LIMIT 1",
        (value, value, value),
    ).fetchone()


def get_acceptance(con, acceptance_id):
    return con.execute(
        "SELECT * FROM acceptance WHERE id=?", (acceptance_id,)
    ).fetchone()


def list_assets(con, *, type=None, name=None):
    sql = "SELECT * FROM asset"
    where, args = [], []
    if type:
        where.append("type=?")
        args.append(type)
    if name:
        where.append("name=?")
        args.append(name)
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY created_at"
    return con.execute(sql, args).fetchall()


def _dump_task_prompts(value):
    if value is None or isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False)


def new_acceptance(con, asset_id, goal, *, strategy=None, acceptance_prompt=None,
                   acceptance_criteria=None, task_prompts=None, fixture_path=None) -> str:
    cid = db.new_id("acc")
    ts = db.now()
    con.execute(
        "INSERT INTO acceptance (id, asset_id, goal, strategy, acceptance_prompt, "
        "acceptance_criteria, task_prompts, fixture_path, status, created_at, updated_at) "
        "VALUES (?,?,?,?,?,?,?,?, 'draft', ?, ?)",
        (cid, asset_id, goal, strategy, acceptance_prompt, acceptance_criteria,
         _dump_task_prompts(task_prompts), _stable_path(fixture_path), ts, ts),
    )
    con.commit()
    return cid


def update_acceptance(con, acceptance_id, **fields) -> None:
    cols = {k: v for k, v in fields.items() if k in _ACCEPTANCE_COLS}
    if "task_prompts" in cols:
        cols["task_prompts"] = _dump_task_prompts(cols["task_prompts"])
    cols["updated_at"] = db.now()
    assignments = ", ".join(f"{k}=?" for k in cols)
    con.execute(
        f"UPDATE acceptance SET {assignments} WHERE id=?",
        (*cols.values(), acceptance_id),
    )
    con.commit()


def list_acceptances(con, *, asset_id=None, status=None):
    sql = "SELECT * FROM acceptance"
    where, args = [], []
    if asset_id:
        where.append("asset_id=?")
        args.append(asset_id)
    if status:
        where.append("status=?")
        args.append(status)
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY created_at"
    return con.execute(sql, args).fetchall()


def get_task_prompts(con, acceptance_id) -> dict:
    row = con.execute(
        "SELECT task_prompts FROM acceptance WHERE id=?", (acceptance_id,)
    ).fetchone()
    if not row or not row["task_prompts"]:
        return {}
    return json.loads(row["task_prompts"])


def get_acceptance_body(con, acceptance_id, kind):
    cols = {
        "prompt": "acceptance_prompt",
        "criteria": "acceptance_criteria",
    }
    col = cols[kind]
    row = con.execute(
        f"SELECT {col} AS body FROM acceptance WHERE id=?", (acceptance_id,)
    ).fetchone()
    return row["body"] if row else None


def history(con, asset_name) -> dict:
    asset = get_asset(con, asset_name)
    if not asset:
        return {"asset": None, "acceptances": []}
    out = {"asset": dict(asset), "acceptances": []}
    for acc in list_acceptances(con, asset_id=asset["id"]):
        rounds = con.execute(
            "SELECT * FROM round WHERE acceptance_id=? ORDER BY started_at",
            (acc["id"],),
        ).fetchall()
        entry = dict(acc)
        entry["rounds"] = [dict(r) for r in rounds]
        out["acceptances"].append(entry)
    return out
