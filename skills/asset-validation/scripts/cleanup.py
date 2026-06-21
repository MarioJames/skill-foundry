from . import observe, rounds


def cleanup_round(con, round_id, *, sandbox=None) -> dict:
    row = rounds.get_cleanup_target(con, round_id)
    if not row:
        raise LookupError(f"round not found: {round_id}")

    sandbox = sandbox or row["sandbox_path"]
    if not sandbox:
        raise ValueError("cleanup requires --sandbox or --round")

    session = observe.session_name(row["round_tag"])
    session_killed = observe.kill_session(session)
    plugin_cleanup = None
    if row["asset_type"] == "plugin":
        plugin_cleanup = observe.cleanup_plugin_install(sandbox)

    result = observe.cleanup(sandbox)
    result.update({"session": session, "session_killed": session_killed})
    if plugin_cleanup is not None:
        result["plugin_cleanup"] = plugin_cleanup
    return result
