"""Fenced state transitions for persisted Execution Sessions."""

import json

import state_store


def owned_execution(attempt_id, generation, owner_nonce, con=None):
    return state_store._one(
        """SELECT e.* FROM execution_sessions e
           WHERE e.attempt_id=? AND e.generation=? AND e.owner_nonce=?""",
        (attempt_id, int(generation), owner_nonce),
        con,
    )


def ownership_is_live(attempt_id, generation, owner_nonce):
    with state_store.transaction(immediate=False) as con:
        row = con.execute(
            """SELECT 1 FROM execution_sessions e
               JOIN task_attempts a ON a.attempt_id=e.attempt_id
               JOIN tasks t ON t.task_id=a.task_id
               JOIN runs r ON r.root_id=e.root_id
               WHERE e.attempt_id=? AND e.generation=? AND e.owner_nonce=?
                 AND e.stop_requested_at IS NULL
                 AND e.status IN ('starting','running')
                 AND a.status IN ('assigned','running')
                 AND t.current_attempt_id=a.attempt_id
                 AND t.status IN ('assigned','active')
                 AND r.status='running'""",
            (attempt_id, int(generation), owner_nonce),
        ).fetchone()
        return row is not None


def register_control_endpoint(attempt_id, generation, owner_nonce, endpoint):
    with state_store.transaction() as con:
        cursor = con.execute(
            """UPDATE execution_sessions
               SET control_endpoint=?, last_event_at=?
               WHERE attempt_id=? AND generation=? AND owner_nonce=?
                 AND stop_requested_at IS NULL AND status='starting'""",
            (endpoint, state_store.now(), attempt_id, int(generation), owner_nonce),
        )
        return cursor.rowcount == 1


def register_agent_process(attempt_id, generation, owner_nonce, agent_pid):
    with state_store.transaction() as con:
        cursor = con.execute(
            """UPDATE execution_sessions
               SET agent_pid=?, last_event_at=?
               WHERE attempt_id=? AND generation=? AND owner_nonce=?
                 AND stop_requested_at IS NULL AND status='starting'""",
            (int(agent_pid), state_store.now(), attempt_id, int(generation), owner_nonce),
        )
        if cursor.rowcount == 1:
            record = state_store.get_execution(attempt_id, con)
            state_store.append_event(
                con,
                record["root_id"],
                "AcpWorkerStarted",
                {"worker_pid": record["worker_pid"], "agent_pid": int(agent_pid)},
                attempt_id=attempt_id,
            )
        return cursor.rowcount == 1


def mark_ready(
    attempt_id,
    generation,
    owner_nonce,
    *,
    acp_session_id,
    protocol_version,
    capabilities,
):
    with state_store.transaction() as con:
        timestamp = state_store.now()
        cursor = con.execute(
            """UPDATE execution_sessions
               SET status='running', prompt_state='in_flight', acp_session_id=?,
                   protocol_version=?, capabilities_json=?, ready_at=?,
                   last_worker_heartbeat_at=?, last_event_at=?
               WHERE attempt_id=? AND generation=? AND owner_nonce=?
                 AND stop_requested_at IS NULL AND status='starting'
                 AND EXISTS (
                   SELECT 1 FROM task_attempts a
                   JOIN tasks t ON t.task_id=a.task_id
                   JOIN runs r ON r.root_id=a.root_id
                   WHERE a.attempt_id=execution_sessions.attempt_id
                     AND a.status='assigned' AND t.status='assigned'
                     AND t.current_attempt_id=a.attempt_id AND r.status='running'
                 )""",
            (
                acp_session_id,
                int(protocol_version),
                json.dumps(capabilities or {}, sort_keys=True),
                timestamp,
                timestamp,
                timestamp,
                attempt_id,
                int(generation),
                owner_nonce,
            ),
        )
        if cursor.rowcount == 1:
            record = state_store.get_execution(attempt_id, con)
            state_store.append_event(
                con,
                record["root_id"],
                "AcpWorkerReady",
                {"execution_id": record["execution_id"], "generation": int(generation)},
                attempt_id=attempt_id,
            )
        return cursor.rowcount == 1


def heartbeat(attempt_id, generation, owner_nonce):
    with state_store.transaction() as con:
        timestamp = state_store.now()
        cursor = con.execute(
            """UPDATE execution_sessions
               SET last_worker_heartbeat_at=?, last_event_at=?
               WHERE attempt_id=? AND generation=? AND owner_nonce=?
                 AND status IN ('starting','running','stopping')""",
            (timestamp, timestamp, attempt_id, int(generation), owner_nonce),
        )
        return cursor.rowcount == 1


def record_turn_end(attempt_id, generation, owner_nonce, reason, *, error=False):
    with state_store.transaction() as con:
        timestamp = state_store.now()
        status = "error" if error else "turn_ended"
        cursor = con.execute(
            """UPDATE execution_sessions
               SET status=?, prompt_state='ended', exit_reason=?, last_event_at=?
               WHERE attempt_id=? AND generation=? AND owner_nonce=?
                 AND status IN ('starting','running')""",
            (status, reason, timestamp, attempt_id, int(generation), owner_nonce),
        )
        if cursor.rowcount == 1:
            record = state_store.get_execution(attempt_id, con)
            state_store.append_event(
                con,
                record["root_id"],
                "AgentExitedWithoutFinish",
                {"reason": reason},
                attempt_id=attempt_id,
            )
        return cursor.rowcount == 1


def mark_closed(attempt_id, generation, owner_nonce, reason):
    with state_store.transaction() as con:
        timestamp = state_store.now()
        cursor = con.execute(
            """UPDATE execution_sessions
               SET status='closed', prompt_state=CASE
                     WHEN prompt_state='ended' THEN prompt_state ELSE 'cancelled' END,
                   exit_reason=COALESCE(exit_reason, ?), closed_at=?, last_event_at=?
               WHERE attempt_id=? AND generation=? AND owner_nonce=?""",
            (reason, timestamp, timestamp, attempt_id, int(generation), owner_nonce),
        )
        if cursor.rowcount == 1:
            record = state_store.get_execution(attempt_id, con)
            state_store.append_event(
                con,
                record["root_id"],
                "ExecutionClosed",
                {"reason": record["exit_reason"] or reason},
                attempt_id=attempt_id,
            )
        return cursor.rowcount == 1


def mark_cleanup_failed(attempt_id, generation, owner_nonce, reason):
    with state_store.transaction() as con:
        timestamp = state_store.now()
        cursor = con.execute(
            """UPDATE execution_sessions
               SET status='error', prompt_state='cancelled', exit_reason=?, last_event_at=?
               WHERE attempt_id=? AND generation=? AND owner_nonce=? AND status != 'closed'""",
            (reason, timestamp, attempt_id, int(generation), owner_nonce),
        )
        if cursor.rowcount == 1:
            record = state_store.get_execution(attempt_id, con)
            state_store.append_event(
                con,
                record["root_id"],
                "ExecutionCleanupFailed",
                {"reason": reason},
                attempt_id=attempt_id,
            )
        return cursor.rowcount == 1


def request_stop(attempt_id, generation=None):
    with state_store.transaction() as con:
        timestamp = state_store.now()
        sql = """UPDATE execution_sessions
                 SET stop_requested_at=COALESCE(stop_requested_at, ?),
                     status=CASE WHEN status IN ('starting','running') THEN 'stopping' ELSE status END,
                     last_event_at=?
                 WHERE attempt_id=? AND status != 'closed'"""
        params = [timestamp, timestamp, attempt_id]
        if generation is not None:
            sql += " AND generation=?"
            params.append(int(generation))
        cursor = con.execute(sql, params)
        return cursor.rowcount == 1
