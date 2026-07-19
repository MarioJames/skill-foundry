import hashlib
import json
from pathlib import Path

from . import db

_ACCEPTANCE_COLS = {
    "goal", "strategy", "acceptance_prompt", "acceptance_criteria",
    "task_prompts", "issues", "fixture_path", "status",
    "ladder", "budget_max_rounds",
}

_HASH_EXCLUDED_PARTS = {".git", "node_modules", "__pycache__"}
_LADDER_RUNGS = (
    "smoke", "representative", "complex",
    "failure-recovery", "negative-boundary",
)


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


def _shape_warning(type, source_path):
    src = Path(source_path)
    if not src.exists():
        return f"source path does not exist yet: {src}"
    if type == "skill" and src.is_dir() and not (src / "SKILL.md").exists():
        return "declared type=skill but source has no SKILL.md"
    if type == "plugin" and src.is_dir() and not (src / "plugin.json").exists():
        return "declared type=plugin but source has no plugin.json"
    if type == "agent":
        if src.is_file() and src.suffix != ".md":
            return "declared type=agent but source is not a .md file"
        if src.is_dir() and not (src / "agents").exists() \
                and not any(src.glob("*.md")):
            return "declared type=agent but source has no agents/ dir or *.md"
    return None


def register_asset(con, name, type, source_path) -> dict:
    source = _stable_path(source_path)
    existing = get_asset_by_name(con, name)
    if existing:
        if existing["type"] == type and existing["source_path"] == source:
            return {
                "id": existing["id"],
                "created": False,
                "warning": _shape_warning(type, source),
            }
        raise ValueError(
            f"asset {name!r} already registered as type={existing['type']} "
            f"source={existing['source_path']}; use a new name or matching "
            "type/source"
        )
    return {
        "id": add_asset(con, name, type, source_path),
        "created": True,
        "warning": _shape_warning(type, source),
    }


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


def get_acceptance_target(con, acceptance_id):
    return con.execute(
        "SELECT a.*, asset.name AS asset_name, asset.type AS asset_type, "
        "asset.source_path AS asset_source "
        "FROM acceptance a "
        "JOIN asset ON asset.id=a.asset_id "
        "WHERE a.id=?",
        (acceptance_id,),
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


def validate_task_prompts(value) -> dict:
    hint = 'task-prompts must be a non-empty flat JSON object like {"t1": "body"}'
    if not isinstance(value, dict) or not value:
        raise ValueError(hint)
    for key, body in value.items():
        if not isinstance(key, str) or not key.strip():
            raise ValueError(f"{hint}; keys must be non-empty strings")
        if not isinstance(body, str) or not body.strip():
            raise ValueError(
                f"{hint}; task-prompts[{key!r}] must be a non-empty string body"
            )
    return value


def _dump_task_prompts(value):
    if value is None:
        return None
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError as exc:
            raise ValueError(f"task-prompts is not valid JSON: {exc}") from exc
    return json.dumps(validate_task_prompts(value), ensure_ascii=False)


def validate_ladder(ladder, task_prompts) -> dict:
    if not isinstance(ladder, dict) or not ladder:
        raise ValueError(
            "ladder must be a non-empty JSON object mapping rung names to "
            "task-key lists"
        )
    unknown = set(ladder) - set(_LADDER_RUNGS)
    if unknown:
        raise ValueError(
            f"unknown rung(s) {sorted(unknown)}; valid rungs: "
            f"{list(_LADDER_RUNGS)}"
        )
    for rung, keys in ladder.items():
        if not isinstance(keys, list) or not keys:
            raise ValueError(f"ladder rung {rung!r} must be a non-empty list")
        for key in keys:
            if not isinstance(key, str) or key not in task_prompts:
                raise ValueError(
                    f"ladder rung {rung!r} references task {key!r} "
                    "not in task_prompts"
                )
    return {rung: list(keys) for rung, keys in ladder.items()}


def _dump_ladder(value, task_prompts):
    if value is None:
        return None
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError as exc:
            raise ValueError(f"ladder is not valid JSON: {exc}") from exc
    return json.dumps(validate_ladder(value, task_prompts), ensure_ascii=False)


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
    if "ladder" in cols and cols["ladder"] is not None:
        tp_raw = cols.get("task_prompts")
        if tp_raw is None:
            row = con.execute(
                "SELECT task_prompts FROM acceptance WHERE id=?",
                (acceptance_id,),
            ).fetchone()
            tp_raw = row["task_prompts"] if row else None
        task_prompts = json.loads(tp_raw) if tp_raw else {}
        cols["ladder"] = _dump_ladder(cols["ladder"], task_prompts)
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


def get_ladder(con, acceptance_id) -> dict:
    row = con.execute(
        "SELECT ladder FROM acceptance WHERE id=?", (acceptance_id,)
    ).fetchone()
    if not row or not row["ladder"]:
        return {}
    return json.loads(row["ladder"])


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


def source_hash(source_path):
    """Content hash of the asset source; None when the path is missing."""
    src = Path(source_path)
    if not src.exists():
        return None
    digest = hashlib.sha256()
    if src.is_file():
        files = [src]
    else:
        files = sorted(
            p for p in src.rglob("*")
            if p.is_file() and not _HASH_EXCLUDED_PARTS.intersection(p.parts)
        )
    for path in files:
        rel = path.name if src.is_file() else str(path.relative_to(src))
        digest.update(rel.encode("utf-8"))
        digest.update(b"\0")
        try:
            digest.update(path.read_bytes())
        except OSError:
            digest.update(b"<unreadable>")
        digest.update(b"\0")
    return digest.hexdigest()


def can_finalize_pass(con, round_id):
    row = con.execute(
        "SELECT r.id, r.acceptance_id, r.verdict, asset.source_path "
        "FROM round r "
        "JOIN acceptance a ON a.id=r.acceptance_id "
        "JOIN asset ON asset.id=a.asset_id "
        "WHERE r.id=?",
        (round_id,),
    ).fetchone()
    if not row:
        return False, "round not found"
    ladder = get_ladder(con, row["acceptance_id"])
    if not ladder:
        return True, None
    current = source_hash(row["source_path"])
    rounds = con.execute(
        "SELECT id, verdict, asset_hash, task_keys FROM round "
        "WHERE acceptance_id=? ORDER BY started_at",
        (row["acceptance_id"],),
    ).fetchall()
    covered = set()
    stale_pass_seen = False
    for r in rounds:
        prospective = r["id"] == round_id and row["verdict"] == "running"
        is_pass = r["verdict"] == "PASS" or prospective
        if not is_pass:
            continue
        if r["asset_hash"] and current and r["asset_hash"] == current:
            covered.update(json.loads(r["task_keys"]) if r["task_keys"] else [])
        else:
            stale_pass_seen = True
    for rung, keys in ladder.items():
        missing = sorted(k for k in keys if k not in covered)
        if missing:
            suffix = " (stale PASS rounds do not count)" if stale_pass_seen else ""
            return False, (
                f"ladder rung {rung!r} lacks a non-stale PASS round covering "
                f"task(s) {missing}{suffix}; record coverage via "
                "`feed-task --round` or `profile run-task`, or use "
                "--allow-partial <reason> to override"
            )
    return True, None


def history(con, asset_name) -> dict:
    asset = get_asset(con, asset_name)
    if not asset:
        return {"asset": None, "acceptances": []}
    current = source_hash(asset["source_path"])
    out = {"asset": dict(asset), "current_asset_hash": current, "acceptances": []}
    for acc in list_acceptances(con, asset_id=asset["id"]):
        rounds = con.execute(
            "SELECT * FROM round WHERE acceptance_id=? ORDER BY started_at",
            (acc["id"],),
        ).fetchall()
        entry = dict(acc)
        entry["rounds"] = [
            {**dict(r), "stale": (
                (r["asset_hash"] != current)
                if r["asset_hash"] and current else None
            )}
            for r in rounds
        ]
        out["acceptances"].append(entry)
    return out
