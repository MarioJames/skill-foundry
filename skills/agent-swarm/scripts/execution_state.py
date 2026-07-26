"""Fenced lifecycle transitions for append-only Launch records."""

import json

import state_store


LIVE_ATTEMPT_STATES = {"assigned", "evaluating", "active", "waiting", "stopping"}


def owned_launch(launch_id, owner_nonce, con=None):
    return state_store._one(
        "SELECT * FROM launches WHERE launch_id=? AND owner_nonce=?",
        (int(launch_id), owner_nonce),
        con,
    )


def ownership_is_live(launch_id, owner_nonce):
    with state_store.transaction(immediate=False) as con:
        row = con.execute(
            """SELECT 1
               FROM launches l
               JOIN attempts a ON a.attempt_id=l.attempt_id
               JOIN tasks t ON t.task_id=a.task_id
               JOIN runs r ON r.root_id=t.root_id
               WHERE l.launch_id=? AND l.owner_nonce=?
                 AND l.stop_requested_at IS NULL
                 AND l.status IN ('starting','running')
                 AND a.state IN ('assigned','evaluating','active','waiting')
                 AND NOT EXISTS (
                   SELECT 1 FROM attempts newer
                   WHERE newer.task_id=a.task_id AND newer.attempt_no>a.attempt_no
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM launches newer_launch
                   WHERE newer_launch.attempt_id=l.attempt_id
                     AND newer_launch.launch_no>l.launch_no
                 )
                 AND t.status IN ('assigned','active')
                 AND r.status='running'""",
            (int(launch_id), owner_nonce),
        ).fetchone()
        return row is not None


def register_control_endpoint(launch_id, owner_nonce, endpoint):
    with state_store.transaction() as con:
        cursor = con.execute(
            """UPDATE launches
               SET control_endpoint=?, last_event_at=?
               WHERE launch_id=? AND owner_nonce=?
                 AND stop_requested_at IS NULL AND status='starting'""",
            (endpoint, state_store.now(), int(launch_id), owner_nonce),
        )
        return cursor.rowcount == 1


def register_agent_process(launch_id, owner_nonce, agent_pid):
    with state_store.transaction() as con:
        cursor = con.execute(
            """UPDATE launches
               SET agent_pid=?, last_event_at=?
               WHERE launch_id=? AND owner_nonce=?
                 AND stop_requested_at IS NULL AND status='starting'""",
            (int(agent_pid), state_store.now(), int(launch_id), owner_nonce),
        )
        if cursor.rowcount == 1:
            record = state_store.get_launch(launch_id, con)
            state_store.append_event(
                con,
                record["root_id"],
                "AcpWorkerStarted",
                {"worker_pid": record["worker_pid"], "agent_pid": int(agent_pid)},
                task_id=record["task_id"],
                attempt_id=record["attempt_id"],
            )
        return cursor.rowcount == 1


def mark_ready(
    launch_id,
    owner_nonce,
    *,
    external_session_id,
    protocol_version,
    capabilities,
    profile_config,
    cwd,
    mode=None,
    model=None,
):
    """Bind the real ACP Session and make the Attempt actionable atomically."""
    with state_store.transaction() as con:
        launch = state_store.get_launch(launch_id, con)
        if launch is None:
            return False
        live = con.execute(
            """SELECT 1
               FROM launches l
               JOIN attempts a ON a.attempt_id=l.attempt_id
               JOIN tasks t ON t.task_id=a.task_id
               JOIN runs r ON r.root_id=t.root_id
               WHERE l.launch_id=? AND l.owner_nonce=?
                 AND l.stop_requested_at IS NULL AND l.status='starting'
                 AND a.state='assigned' AND t.status='assigned' AND r.status='running'
                 AND NOT EXISTS (
                   SELECT 1 FROM attempts newer
                   WHERE newer.task_id=a.task_id AND newer.attempt_no>a.attempt_no
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM launches newer_launch
                   WHERE newer_launch.attempt_id=l.attempt_id
                     AND newer_launch.launch_no>l.launch_no
                 )""",
            (int(launch_id), owner_nonce),
        ).fetchone()
        if live is None:
            return False
        timestamp = state_store.now()
        profile_id = state_store.ensure_agent_profile(con, profile_config)
        con.execute(
            """INSERT INTO acp_sessions(
                 launch_id, profile_id, external_session_id, cwd, protocol_version,
                 capabilities_json, mode, model, status, created_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)""",
            (
                int(launch_id),
                profile_id,
                external_session_id,
                cwd,
                int(protocol_version),
                json.dumps(capabilities or {}, ensure_ascii=False, sort_keys=True),
                mode,
                model,
                timestamp,
            ),
        )
        con.execute(
            """UPDATE launches
               SET status='running', prompt_state='in_flight', ready_at=?,
                   last_worker_heartbeat_at=?, last_event_at=?
               WHERE launch_id=? AND owner_nonce=?""",
            (timestamp, timestamp, timestamp, int(launch_id), owner_nonce),
        )
        con.execute(
            """UPDATE attempts
               SET state='evaluating', started_at=COALESCE(started_at, ?), heartbeat_at=?
               WHERE attempt_id=? AND state='assigned'""",
            (timestamp, timestamp, launch["attempt_id"]),
        )
        con.execute(
            "UPDATE tasks SET status='active' WHERE task_id=? AND status='assigned'",
            (launch["task_id"],),
        )
        session = state_store.get_session_for_launch(launch_id, con)
        state_store.append_event(
            con,
            launch["root_id"],
            "AcpWorkerReady",
            {
                "launch_id": int(launch_id),
                "agent_type": session["agent_type"],
                "external_session_id": external_session_id,
            },
            task_id=launch["task_id"],
            attempt_id=launch["attempt_id"],
            session_pk=session["session_pk"],
        )
        return True


def heartbeat(launch_id, owner_nonce):
    with state_store.transaction() as con:
        timestamp = state_store.now()
        cursor = con.execute(
            """UPDATE launches
               SET last_worker_heartbeat_at=?, last_event_at=?
               WHERE launch_id=? AND owner_nonce=?
                 AND status IN ('starting','running','stopping')""",
            (timestamp, timestamp, int(launch_id), owner_nonce),
        )
        return cursor.rowcount == 1


def record_turn_end(launch_id, owner_nonce, reason, *, error=False):
    with state_store.transaction() as con:
        timestamp = state_store.now()
        status = "error" if error else "turn_ended"
        cursor = con.execute(
            """UPDATE launches
               SET status=?, prompt_state='ended', exit_reason=?, last_event_at=?
               WHERE launch_id=? AND owner_nonce=?
                 AND status IN ('starting','running')""",
            (status, reason, timestamp, int(launch_id), owner_nonce),
        )
        if cursor.rowcount == 1:
            record = state_store.get_launch(launch_id, con)
            session = state_store.get_session_for_launch(launch_id, con)
            state_store.append_event(
                con,
                record["root_id"],
                "AgentExitedWithoutFinish",
                {"reason": reason, "launch_id": int(launch_id)},
                task_id=record["task_id"],
                attempt_id=record["attempt_id"],
                session_pk=session["session_pk"] if session else None,
            )
        return cursor.rowcount == 1


def mark_closed(launch_id, owner_nonce, reason):
    with state_store.transaction() as con:
        timestamp = state_store.now()
        cursor = con.execute(
            """UPDATE launches
               SET status='closed', prompt_state=CASE
                     WHEN prompt_state='ended' THEN prompt_state ELSE 'cancelled' END,
                   exit_reason=COALESCE(exit_reason, ?), closed_at=?, last_event_at=?
               WHERE launch_id=? AND owner_nonce=?""",
            (reason, timestamp, timestamp, int(launch_id), owner_nonce),
        )
        if cursor.rowcount == 1:
            con.execute(
                """UPDATE acp_sessions SET status='closed', closed_at=?
                   WHERE launch_id=? AND status='active'""",
                (timestamp, int(launch_id)),
            )
            record = state_store.get_launch(launch_id, con)
            session = state_store.get_session_for_launch(launch_id, con)
            state_store.append_event(
                con,
                record["root_id"],
                "LaunchClosed",
                {"launch_id": int(launch_id), "reason": record["exit_reason"] or reason},
                task_id=record["task_id"],
                attempt_id=record["attempt_id"],
                session_pk=session["session_pk"] if session else None,
            )
        return cursor.rowcount == 1


def mark_cleanup_failed(launch_id, owner_nonce, reason):
    with state_store.transaction() as con:
        timestamp = state_store.now()
        cursor = con.execute(
            """UPDATE launches
               SET status='error', prompt_state='cancelled', exit_reason=?, last_event_at=?
               WHERE launch_id=? AND owner_nonce=? AND status != 'closed'""",
            (reason, timestamp, int(launch_id), owner_nonce),
        )
        if cursor.rowcount == 1:
            record = state_store.get_launch(launch_id, con)
            state_store.append_event(
                con,
                record["root_id"],
                "LaunchCleanupFailed",
                {"launch_id": int(launch_id), "reason": reason},
                task_id=record["task_id"],
                attempt_id=record["attempt_id"],
            )
        return cursor.rowcount == 1


def request_stop(launch_id):
    with state_store.transaction() as con:
        timestamp = state_store.now()
        cursor = con.execute(
            """UPDATE launches
               SET stop_requested_at=COALESCE(stop_requested_at, ?),
                   status=CASE WHEN status IN ('starting','running') THEN 'stopping' ELSE status END,
                   last_event_at=?
               WHERE launch_id=? AND status != 'closed'""",
            (timestamp, timestamp, int(launch_id)),
        )
        return cursor.rowcount == 1
