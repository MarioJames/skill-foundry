from pathlib import Path

from . import db, observe, rounds


def cleanup_round(con, round_id, *, sandbox=None) -> dict:
    row = rounds.get_cleanup_target(con, round_id)
    if not row:
        raise LookupError(f"round not found: {round_id}")

    sandbox = sandbox or row["sandbox_path"]
    if not sandbox:
        raise ValueError("cleanup requires --sandbox or --round")

    session = observe.session_name(row["round_tag"])
    session_killed = observe.kill_session(session)
    nested_sessions = _cleanup_nested_sessions(sandbox)
    plugin_cleanup = None
    if row["asset_type"] in ("plugin", "skill", "agent"):
        plugin_cleanup = observe.cleanup_plugin_install(sandbox)

    result = observe.cleanup(sandbox)
    result.update({"session": session, "session_killed": session_killed})
    if nested_sessions:
        result["nested_sessions"] = nested_sessions
    if plugin_cleanup is not None:
        result["plugin_cleanup"] = plugin_cleanup
    return result


def _cleanup_nested_sessions(sandbox) -> list:
    state_db = Path(sandbox) / ".aut-acceptance" / "state.sqlite3"
    cleaned = []
    for target in db.round_cleanup_targets_from(state_db):
        round_tag = target.get("round_tag")
        if not round_tag:
            continue
        session = observe.session_name(round_tag)
        cleaned.append({
            "session": session,
            "killed": observe.kill_session(session),
        })
    return cleaned
