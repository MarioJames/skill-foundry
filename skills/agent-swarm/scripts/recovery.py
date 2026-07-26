"""Owner lease, heartbeat, stale-attempt recovery, and stop cascade."""

import json
import os
import pathlib
import secrets
import uuid

import backends
import execution_config
import execution_secrets
import hook_runtime
import hook_manager
import outbox
import scheduler
import state_store


OWNER_LEASE_SECONDS = 15 * 60
CHILD_HEARTBEAT_TIMEOUT_SECONDS = 5 * 60
OUTBOX_CLAIM_TIMEOUT_SECONDS = 120


def _run_backend(run):
    config = execution_config.snapshot_attempt(run)
    return backends.resolve_execution_backend(
        {"backend_id": config["backend"], "config_json": json.dumps(config, sort_keys=True)}
    )


def _agent_backend(agent, adapter=None):
    if adapter is not None:
        return adapter
    execution = state_store.get_execution(agent["attempt_id"])
    if execution is None:
        raise RuntimeError("agent has no persisted execution record")
    return backends.resolve_execution_backend(execution)


def _list_sessions(adapter, cwd):
    try:
        return adapter.list_sessions(cwd=cwd)
    except TypeError:
        return adapter.list_sessions(cwd)


def _verify_owner(run, token):
    if not state_store.token_matches(token, run.get("owner_token_hash")):
        raise RuntimeError("invalid owner token")


def heartbeat(root_id, task_id, attempt_id, agent_id, actor_token):
    return hook_runtime.heartbeat(root_id, task_id, attempt_id, agent_id, actor_token)


def observe_session_end(root_id, task_id, attempt_id, agent_id, actor_token):
    return hook_runtime.observe_session_end(root_id, task_id, attempt_id, agent_id, actor_token)


def _reconcile_started_sessions(root_id, adapter=None):
    run = state_store.get_run(root_id)
    terminal = {"done", "completed", "exited", "failed", "stopped", "error", "cancelled"}
    with state_store.transaction(immediate=False) as con:
        rows = state_store.fetchall(
            """SELECT a.*, ta.status AS attempt_status, t.current_attempt_id,
                      e.backend_id AS execution_backend_id, e.config_json AS execution_config_json
               FROM agents a
               JOIN task_attempts ta ON ta.attempt_id=a.attempt_id
               JOIN tasks t ON t.task_id=a.task_id
               JOIN execution_sessions e ON e.attempt_id=a.attempt_id
               WHERE a.root_id=? AND a.state='received' AND ta.status='assigned'""",
            (root_id,),
            con,
        )

    session_views = {}
    backend_views = {}
    for agent in rows:
        key = ("override", id(adapter)) if adapter is not None else (
            agent["execution_backend_id"],
            agent["execution_config_json"],
        )
        if key not in backend_views:
            try:
                backend = adapter or backends.resolve_execution_backend(
                    {
                        "backend_id": agent["execution_backend_id"],
                        "config_json": agent["execution_config_json"],
                    }
                )
                sessions = _list_sessions(backend, run["cwd"])
            except Exception:
                sessions = []
            active = {}
            for session in sessions:
                if not isinstance(session, dict):
                    continue
                name = session.get("name") or session.get("session_name")
                status = session.get("state") or session.get("status")
                if name and status not in terminal:
                    active[name] = session
            backend_views[key] = active
        session = backend_views[key].get(agent.get("session_name"))
        if session is not None:
            session_views[agent["agent_id"]] = session

    reconciled = 0
    with state_store.transaction() as con:
        for snapshot in rows:
            session = session_views.get(snapshot["agent_id"])
            agent = state_store.get_agent(snapshot["agent_id"], con)
            task = state_store.get_task(snapshot["task_id"], con)
            attempt = state_store.get_attempt(snapshot["attempt_id"], con)
            if (
                session is None
                or agent is None
                or task is None
                or attempt is None
                or agent["state"] != "received"
                or attempt["status"] != "assigned"
                or task["current_attempt_id"] != attempt["attempt_id"]
            ):
                continue
            timestamp = state_store.now()
            job_id = session.get("job_id") or session.get("id")
            con.execute(
                "UPDATE task_attempts SET status='running', started_at=COALESCE(started_at, ?) WHERE attempt_id=?",
                (timestamp, attempt["attempt_id"]),
            )
            con.execute("UPDATE tasks SET status='active' WHERE task_id=?", (agent["task_id"],))
            con.execute(
                "UPDATE agents SET state='evaluating', job_id=?, heartbeat_at=? WHERE agent_id=?",
                (job_id, timestamp, agent["agent_id"]),
            )
            con.execute(
                """UPDATE execution_sessions
                   SET status='running', prompt_state='in_flight', ready_at=COALESCE(ready_at, ?),
                       last_event_at=? WHERE attempt_id=?""",
                (timestamp, timestamp, agent["attempt_id"]),
            )
            con.execute(
                """UPDATE side_effect_outbox
                   SET status='completed', completed_at=?, last_error=NULL
                   WHERE idempotency_key=? AND status IN ('pending','running')""",
                (timestamp, "spawn:%s" % attempt["attempt_id"]),
            )
            state_store.append_event(
                con, root_id, "AgentProcessStarted", {"job_id": job_id, "reconciled": True},
                task_id=agent["task_id"], attempt_id=agent["attempt_id"], agent_id=agent["agent_id"],
            )
            reconciled += 1
    return reconciled


def _observe_session(adapter, agent, cwd):
    observer = getattr(adapter, "observe", None) or getattr(adapter, "observe_session", None)
    try:
        if observer is not None:
            observation = observer(
                job_id=agent.get("job_id"), session_name=agent.get("session_name"), cwd=cwd
            )
        else:
            alive = adapter.session_alive(
                job_id=agent.get("job_id"), session_name=agent.get("session_name"), cwd=cwd
            )
            observation = {"presence": "present" if alive else "absent"}
    except Exception as exc:
        return {"presence": "unknown", "error": str(exc)}
    if hasattr(observation, "presence"):
        observation = {
            "presence": observation.presence,
            "session": observation.session,
            "error": observation.error,
        }
    if not isinstance(observation, dict):
        return {"presence": "unknown", "error": "invalid session observation"}
    presence = observation.get("presence")
    if presence not in {"present", "absent", "unknown"}:
        return {"presence": "unknown", "error": "invalid session presence"}
    return observation


def _is_current_stale_child(run, task, attempt, agent, stale_before):
    return bool(
        task
        and attempt
        and agent
        and task["task_id"] != run["root_task_id"]
        and task["current_attempt_id"] == attempt["attempt_id"]
        and attempt["status"] == "running"
        and attempt["agent_id"] == agent["agent_id"]
        and agent["state"] != "terminal"
        and (agent.get("heartbeat_at") or 0) < stale_before
    )


def _stalled_agent_diagnostic(agent, observation):
    diagnostic = {
        "task_id": agent["task_id"],
        "attempt_id": agent["attempt_id"],
        "agent_id": agent["agent_id"],
        "job_id": agent.get("job_id"),
        "session_name": agent.get("session_name"),
        "heartbeat_at": agent.get("heartbeat_at"),
        "heartbeat_age_seconds": max(0, state_store.now() - (agent.get("heartbeat_at") or 0)),
    }
    if observation.get("session") is not None:
        diagnostic["session"] = observation["session"]
    return diagnostic


def _queue_stop_for_retry(con, run, task, attempt, agent, reason):
    execution = state_store.get_execution(attempt["attempt_id"], con)
    if execution is None:
        raise RuntimeError("retry stop requires an execution record")
    payload = {
        "root_id": run["root_id"],
        "task_id": task["task_id"],
        "attempt_id": attempt["attempt_id"],
        "agent_id": agent["agent_id"],
        "job_id": agent.get("job_id"),
        "session_name": agent.get("session_name"),
        "cwd": run["cwd"],
        "retry_task_id": task["task_id"],
        "backend_id": execution["backend_id"],
        "execution_id": execution["execution_id"],
        "generation": execution["generation"],
        "config_json": execution["config_json"],
    }
    con.execute(
        """INSERT OR IGNORE INTO side_effect_outbox(
             root_id, effect_type, payload_json, idempotency_key, status, attempts, created_at
           ) VALUES (?, 'stop_agent', ?, ?, 'pending', 0, ?)""",
        (
            run["root_id"],
            json.dumps(payload, ensure_ascii=False, sort_keys=True),
            "stop:%s" % attempt["attempt_id"],
            state_store.now(),
        ),
    )
    state_store.append_event(
        con,
        run["root_id"],
        "AgentKillRequested",
        {"reason": reason},
        task_id=task["task_id"],
        attempt_id=attempt["attempt_id"],
        agent_id=agent["agent_id"],
    )


def _retire_attempt(con, run, task, attempt, agent, reason, *, stop_before_retry=False):
    finished = state_store.now()
    con.execute(
        "UPDATE task_attempts SET status='failed', retryable=1, finished_at=? WHERE attempt_id=?",
        (finished, attempt["attempt_id"]),
    )
    con.execute(
        "UPDATE agents SET state='terminal', last_error=?, finished_at=? WHERE agent_id=?",
        (reason, finished, agent["agent_id"]),
    )
    if stop_before_retry:
        con.execute(
            "UPDATE tasks SET status='stopping', finished_at=NULL WHERE task_id=?",
            (task["task_id"],),
        )
        _queue_stop_for_retry(con, run, task, attempt, agent, reason)
        return "kill_requested"
    if attempt["attempt_no"] < run["max_attempts_per_task"]:
        con.execute("UPDATE tasks SET status='ready' WHERE task_id=?", (task["task_id"],))
        event_type = "TaskRetryScheduled"
    else:
        con.execute(
            "UPDATE tasks SET status='failed', finished_at=? WHERE task_id=?",
            (finished, task["task_id"]),
        )
        event_type = "TaskFailed"
    state_store.append_event(
        con,
        run["root_id"],
        event_type,
        {"reason": reason},
        task_id=task["task_id"],
        attempt_id=attempt["attempt_id"],
        agent_id=agent["agent_id"],
    )
    return event_type


def _execution_is_deterministic_failure(execution):
    if execution["status"] in {"turn_ended", "error"}:
        return True
    if execution["status"] != "closed":
        return False
    reason = execution.get("exit_reason") or ""
    return reason.startswith(
        (
            "without_finish:",
            "acp_error:",
            "prompt_timeout",
            "agent_process_exit",
        )
    )


def _close_terminal_claude_executions(root_id, adapter=None):
    """Close logical Claude executions only after backend observation proves absence."""
    with state_store.transaction(immediate=False) as con:
        run = state_store.get_run(root_id, con)
        rows = state_store.fetchall(
            """SELECT e.*, a.agent_id, a.job_id, a.session_name AS agent_session_name
               FROM execution_sessions e
               JOIN task_attempts ta ON ta.attempt_id=e.attempt_id
               JOIN agents a ON a.attempt_id=e.attempt_id
               WHERE e.root_id=? AND e.backend_id='claude_cli' AND e.status != 'closed'
                 AND ta.status NOT IN ('assigned','running')
               ORDER BY e.created_at, e.attempt_id""",
            (root_id,),
            con,
        )
    absent = []
    errors = []
    for row in rows:
        agent = {
            "attempt_id": row["attempt_id"],
            "agent_id": row["agent_id"],
            "job_id": row.get("job_id"),
            "session_name": row.get("agent_session_name") or row.get("session_name"),
        }
        try:
            backend = adapter or backends.resolve_execution_backend(row)
            observation = _observe_session(backend, agent, run["cwd"])
        except Exception as exc:
            observation = {"presence": "unknown", "error": str(exc)}
        if observation["presence"] == "absent":
            absent.append(row)
        elif observation["presence"] == "unknown":
            errors.append(
                {
                    "attempt_id": row["attempt_id"],
                    "error": observation.get("error") or "session observation is unavailable",
                }
            )
    closed = 0
    if absent:
        with state_store.transaction() as con:
            for snapshot in absent:
                timestamp = state_store.now()
                cursor = con.execute(
                    """UPDATE execution_sessions
                       SET status='closed', prompt_state='ended',
                           exit_reason=COALESCE(exit_reason, 'attempt_terminal'),
                           closed_at=?, last_event_at=?
                       WHERE attempt_id=? AND generation=? AND backend_id='claude_cli'
                         AND status != 'closed'
                         AND EXISTS (
                           SELECT 1 FROM task_attempts ta
                           WHERE ta.attempt_id=execution_sessions.attempt_id
                             AND ta.status NOT IN ('assigned','running')
                         )""",
                    (
                        timestamp,
                        timestamp,
                        snapshot["attempt_id"],
                        snapshot["generation"],
                    ),
                )
                if cursor.rowcount != 1:
                    continue
                state_store.append_event(
                    con,
                    root_id,
                    "ExecutionClosed",
                    {"reason": "attempt_terminal", "backend_id": "claude_cli"},
                    attempt_id=snapshot["attempt_id"],
                )
                closed += 1
    return {"closed": closed, "observation_errors": errors}


def reconcile_execution_outcomes(root_id, schedule_retry=True):
    """Reduce deterministic Worker outcomes exactly once per execution generation."""
    reconciled_failures = 0
    reconciled_terminal = 0
    with state_store.transaction() as con:
        run = state_store.get_run(root_id, con)
        if run is None:
            raise RuntimeError("run not found")
        rows = state_store.fetchall(
            """SELECT * FROM execution_sessions
               WHERE root_id=? AND reconciled_at IS NULL
               ORDER BY created_at, attempt_id""",
            (root_id,),
            con,
        )
        for execution in rows:
            attempt = state_store.get_attempt(execution["attempt_id"], con)
            if attempt is None:
                continue
            task = state_store.get_task(attempt["task_id"], con)
            agent = state_store.get_agent(attempt["agent_id"], con)
            if task is None or agent is None:
                continue
            timestamp = state_store.now()
            terminal_attempt = attempt["status"] not in {"assigned", "running"}
            deterministic_failure = _execution_is_deterministic_failure(execution)
            if terminal_attempt:
                if execution["status"] != "closed":
                    continue
                con.execute(
                    """UPDATE execution_sessions SET reconciled_at=?, last_event_at=?
                       WHERE attempt_id=? AND generation=? AND reconciled_at IS NULL""",
                    (timestamp, timestamp, execution["attempt_id"], execution["generation"]),
                )
                state_store.append_event(
                    con,
                    root_id,
                    "ExecutionOutcomeReconciled",
                    {"outcome": "attempt_terminal", "generation": execution["generation"]},
                    task_id=task["task_id"],
                    attempt_id=attempt["attempt_id"],
                    agent_id=agent["agent_id"],
                )
                reconciled_terminal += 1
                continue
            if not deterministic_failure:
                continue
            if task["current_attempt_id"] != attempt["attempt_id"]:
                continue
            _retire_attempt(
                con,
                run,
                task,
                attempt,
                agent,
                execution.get("exit_reason") or execution["status"],
            )
            con.execute(
                """UPDATE execution_sessions SET reconciled_at=?, last_event_at=?
                   WHERE attempt_id=? AND generation=? AND reconciled_at IS NULL""",
                (timestamp, timestamp, execution["attempt_id"], execution["generation"]),
            )
            state_store.append_event(
                con,
                root_id,
                "ExecutionOutcomeReconciled",
                {"outcome": "retryable_failure", "generation": execution["generation"]},
                task_id=task["task_id"],
                attempt_id=attempt["attempt_id"],
                agent_id=agent["agent_id"],
            )
            reconciled_failures += 1
        if schedule_retry and run["status"] == "running" and reconciled_failures:
            scheduler.schedule_with_connection(con, root_id)
    return {
        "root_id": root_id,
        "reconciled_failures": reconciled_failures,
        "reconciled_terminal": reconciled_terminal,
    }


def recover_run(root_id, owner_token, stale_before=None, adapter=None):
    stale_before = (
        state_store.now() - CHILD_HEARTBEAT_TIMEOUT_SECONDS
        if stale_before is None
        else stale_before
    )
    with state_store.transaction() as con:
        run = state_store.get_run(root_id, con)
        if run is None:
            raise RuntimeError("run not found")
        _verify_owner(run, owner_token)
        if run["status"] != "running":
            raise RuntimeError("recover_run requires a running run; recover the root session instead")
        con.execute(
            "UPDATE runs SET lease_expires_at=?, updated_at=? WHERE root_id=?",
            (state_store.now() + OWNER_LEASE_SECONDS, state_store.now(), root_id),
        )

    reconciled = _reconcile_started_sessions(root_id, adapter)
    terminal_cleanup = _close_terminal_claude_executions(root_id, adapter)
    outcomes = reconcile_execution_outcomes(root_id)
    with state_store.transaction(immediate=False) as con:
        run = state_store.get_run(root_id, con)
        candidates = state_store.fetchall(
            """SELECT a.*, ta.attempt_no, ta.status AS attempt_status
               FROM agents a JOIN task_attempts ta ON ta.attempt_id=a.attempt_id
               WHERE a.root_id=? AND a.task_id != ?
                 AND ta.status='running' AND a.state != 'terminal'
                 AND COALESCE(a.heartbeat_at, 0) < ?""",
            (root_id, run["root_task_id"], stale_before),
            con,
        )

    stale = []
    stalled_agents = []
    session_observation_errors = []
    for agent in candidates:
        try:
            backend = _agent_backend(agent, adapter=adapter)
        except Exception as exc:
            observation = {"presence": "unknown", "error": str(exc)}
        else:
            observation = _observe_session(backend, agent, run["cwd"])
        if observation["presence"] == "absent":
            stale.append(agent)
        elif observation["presence"] == "present":
            stalled_agents.append(_stalled_agent_diagnostic(agent, observation))
        else:
            session_observation_errors.append(
                observation.get("error") or "Claude session observation is unavailable"
            )

    with state_store.transaction() as con:
        run = state_store.get_run(root_id, con)
        recovered_stale = 0
        for agent in stale:
            task = state_store.get_task(agent["task_id"], con)
            attempt = state_store.get_attempt(agent["attempt_id"], con)
            current_agent = state_store.get_agent(agent["agent_id"], con)
            if not _is_current_stale_child(run, task, attempt, current_agent, stale_before):
                continue
            _retire_attempt(con, run, task, attempt, current_agent, "stale_attempt")
            recovered_stale += 1
        scheduler.schedule_with_connection(con, root_id)
        state_store.append_event(
            con,
            root_id,
            "RecoveryPerformed",
            {
                "stale_attempts": recovered_stale,
                "sessions_reconciled": reconciled,
                "stalled_agents": len(stalled_agents),
            },
        )
    reclaimed = outbox.recover_stale_claims(
        root_id, state_store.now() - OUTBOX_CLAIM_TIMEOUT_SECONDS
    )
    orphans = _orphan_sessions(root_id, adapter, errors=session_observation_errors)
    return {
        "root_id": root_id,
        "stale_attempts": recovered_stale,
        "sessions_reconciled": reconciled,
        "execution_outcomes": outcomes,
        "terminal_execution_cleanup": terminal_cleanup,
        "stalled_agents": stalled_agents,
        "outbox_reclaimed": reclaimed,
        "orphan_sessions": orphans,
        "session_observation_errors": session_observation_errors,
    }


def reap_children(root_id, owner_token, adapter=None):
    """Reclaim only dead child attempts without changing the foreground Root."""
    return recover_run(root_id, owner_token, adapter=adapter)


def kill_stalled_attempt(root_id, owner_token, attempt_id, adapter=None):
    """Let the current Root stop one live-but-heartbeat-stalled child before retrying it."""
    stale_before = state_store.now() - CHILD_HEARTBEAT_TIMEOUT_SECONDS
    with state_store.transaction(immediate=False) as con:
        run = state_store.get_run(root_id, con)
        if run is None:
            raise RuntimeError("run not found")
        _verify_owner(run, owner_token)
        if run["status"] != "running":
            raise RuntimeError("kill_stalled_attempt requires a running run")
        attempt = state_store.get_attempt(attempt_id, con)
        task = state_store.get_task(attempt["task_id"], con) if attempt else None
        agent = state_store.get_agent(attempt["agent_id"], con) if attempt else None
        if not _is_current_stale_child(run, task, attempt, agent, stale_before):
            return {"kill_requested": False, "reason": "attempt is not a current stale child"}

    observation = _observe_session(_agent_backend(agent, adapter=adapter), agent, run["cwd"])
    if observation["presence"] != "present":
        return {
            "kill_requested": False,
            "reason": "session is %s" % observation["presence"],
            "session_observation": observation,
        }

    with state_store.transaction() as con:
        run = state_store.get_run(root_id, con)
        if run is None:
            raise RuntimeError("run not found")
        _verify_owner(run, owner_token)
        task = state_store.get_task(agent["task_id"], con)
        attempt = state_store.get_attempt(attempt_id, con)
        current_agent = state_store.get_agent(agent["agent_id"], con)
        if not _is_current_stale_child(run, task, attempt, current_agent, stale_before):
            return {"kill_requested": False, "reason": "attempt changed during diagnosis"}
        _retire_attempt(
            con,
            run,
            task,
            attempt,
            current_agent,
            "parent_kill_after_stalled_heartbeat",
            stop_before_retry=True,
        )
    return {"kill_requested": True, "attempt_id": attempt_id}


def recover_root(root_id, force_takeover=False):
    with state_store.transaction() as con:
        run = state_store.get_run(root_id, con)
        if run is None:
            raise RuntimeError("run not found")
        if run["status"] not in {"running", "failed"}:
            raise RuntimeError("only running or failed runs can be recovered")
        if run["status"] == "running" and not force_takeover and (run.get("lease_expires_at") or 0) > state_store.now():
            raise RuntimeError("owner lease is still active; use force takeover explicitly")
        task = state_store.get_task(run["root_task_id"], con)
        old_attempt = state_store.get_attempt(task.get("current_attempt_id"), con)
        if old_attempt and old_attempt["status"] in {"assigned", "running"}:
            con.execute(
                "UPDATE task_attempts SET status='cancelled', finished_at=? WHERE attempt_id=?",
                (state_store.now(), old_attempt["attempt_id"]),
            )
            con.execute(
                "UPDATE agents SET state='terminal', finished_at=? WHERE agent_id=?",
                (state_store.now(), old_attempt["agent_id"]),
            )
        attempt_no = con.execute(
            "SELECT COALESCE(MAX(attempt_no), 0) AS n FROM task_attempts WHERE task_id=?",
            (task["task_id"],),
        ).fetchone()["n"] + 1
        if attempt_no > run["max_attempts_per_task"]:
            raise RuntimeError("root task attempt budget is exhausted")
        attempt_id = "attempt_%s" % uuid.uuid4().hex[:12]
        agent_id = "agent_%s" % uuid.uuid4().hex[:12]
        token = "as_" + secrets.token_urlsafe(32)
        created = state_store.now()
        con.execute(
            """INSERT INTO task_attempts(
                 attempt_id, root_id, task_id, attempt_no, agent_id, status, started_at
               ) VALUES (?, ?, ?, ?, ?, 'running', ?)""",
            (attempt_id, root_id, task["task_id"], attempt_no, agent_id, created),
        )
        con.execute(
            """INSERT INTO agents(
                 agent_id, root_id, task_id, attempt_id, state, actor_token_hash,
                 backend_id, agent_key, heartbeat_at, created_at
               ) VALUES (?, ?, ?, ?, 'evaluating', ?, ?, ?, ?, ?)""",
            (
                agent_id,
                root_id,
                task["task_id"],
                attempt_id,
                state_store.hash_token(token),
                execution_config.load_run_execution(run)["backend"],
                (
                    execution_config.load_run_execution(run).get("acp", {}).get("agent")
                    if execution_config.load_run_execution(run)["backend"] == "acp"
                    else "claude"
                ),
                created,
                created,
            ),
        )
        con.execute(
            "UPDATE tasks SET status='active', current_attempt_id=?, finished_at=NULL, estimate_json=NULL WHERE task_id=?",
            (attempt_id, task["task_id"]),
        )
        con.execute(
            """UPDATE runs SET status='running', root_agent_id=?, owner_token_hash=?,
                 lease_epoch=lease_epoch+1, lease_expires_at=?, finished_at=NULL, updated_at=?
               WHERE root_id=?""",
            (agent_id, state_store.hash_token(token), created + OWNER_LEASE_SECONDS, created, root_id),
        )
        state_store.append_event(
            con, root_id, "RecoveryPerformed", {"root_attempt": attempt_id, "force": bool(force_takeover)},
            task_id=task["task_id"], attempt_id=attempt_id, agent_id=agent_id,
        )
        result = {
            "root_id": root_id,
            "task_id": task["task_id"],
            "attempt_id": attempt_id,
            "agent_id": agent_id,
            "actor_token": token,
            "lease_epoch": run["lease_epoch"] + 1,
        }
    if execution_config.supports_hooks(execution_config.load_run_execution(run)):
        try:
            hook_manager.ensure_project_hooks(run["cwd"], root_id=root_id)
        except Exception as exc:
            result["warnings"] = ["hook refresh failed: %s" % exc]
    return result


def stop_run(root_id, actor_token, adapter=None):
    with state_store.transaction(immediate=False) as con:
        initial_run = state_store.get_run(root_id, con)
        if initial_run is None:
            raise RuntimeError("run not found")
        _verify_owner(initial_run, actor_token)
        if initial_run["status"] in {"done", "cancelled"}:
            execution_secrets.cleanup_run_seed_if_safe(root_id)
            return {
                "root_id": root_id,
                "terminal": True,
                "status": initial_run["status"],
                "cleanup_complete": True,
            }
    observation_errors = []
    orphan_sessions = _orphan_sessions(root_id, adapter, errors=observation_errors)
    with state_store.transaction() as con:
        run = state_store.get_run(root_id, con)
        if run is None:
            raise RuntimeError("run not found")
        _verify_owner(run, actor_token)
        if run["status"] in {"done", "cancelled"}:
            return {"root_id": root_id, "terminal": True, "status": run["status"], "cleanup_complete": True}
        if run["status"] not in {"running", "stopping", "failed"}:
            raise RuntimeError("run cannot be stopped from status %s" % run["status"])
        stop_fenced_at = state_store.now()
        con.execute(
            "UPDATE runs SET status='stopping', updated_at=? WHERE root_id=?",
            (stop_fenced_at, root_id),
        )
        # Fence every execution before cancelling any spawn effect. This is
        # intentionally independent of Agent state/job_id: a starting Worker
        # may already exist even when the Control Plane has not acknowledged it.
        con.execute(
            """UPDATE execution_sessions
               SET stop_requested_at=COALESCE(stop_requested_at, ?),
                   status=CASE WHEN status IN ('starting','running')
                               THEN 'stopping' ELSE status END,
                   last_event_at=?
               WHERE root_id=? AND status != 'closed'""",
            (stop_fenced_at, stop_fenced_at, root_id),
        )
        con.execute(
            """UPDATE side_effect_outbox
               SET status='pending', claimed_at=NULL, last_error=NULL
               WHERE root_id=? AND effect_type='stop_agent' AND status='failed' AND attempts < 3""",
            (root_id,),
        )
        con.execute(
            """UPDATE side_effect_outbox SET status='failed', last_error='run stopped'
               WHERE root_id=? AND effect_type='spawn_agent' AND status='pending'""",
            (root_id,),
        )
        executions = state_store.fetchall(
            "SELECT * FROM execution_sessions WHERE root_id=? AND status != 'closed'",
            (root_id,),
            con,
        )
        for execution in executions:
            attempt = state_store.get_attempt(execution["attempt_id"], con)
            agent = state_store.get_agent(attempt["agent_id"], con) if attempt else None
            payload = {
                "root_id": root_id,
                "task_id": attempt["task_id"] if attempt else None,
                "attempt_id": execution["attempt_id"],
                "agent_id": agent["agent_id"] if agent else None,
                "job_id": agent.get("job_id") if agent else execution["execution_id"],
                "session_name": (
                    agent.get("session_name") if agent else execution.get("session_name")
                ),
                "cwd": run["cwd"],
                "backend_id": execution["backend_id"],
                "execution_id": execution["execution_id"],
                "generation": execution["generation"],
                "config_json": execution["config_json"],
            }
            con.execute(
                """INSERT OR IGNORE INTO side_effect_outbox(
                     root_id, effect_type, payload_json, idempotency_key, status, attempts, created_at
                   ) VALUES (?, 'stop_agent', ?, ?, 'pending', 0, ?)""",
                (
                    root_id,
                    json.dumps(payload, ensure_ascii=False, sort_keys=True),
                    "stop:%s" % execution["attempt_id"],
                    state_store.now(),
                ),
            )
        for session in orphan_sessions:
            job_id = session.get("job_id") or session.get("id")
            session_name = session.get("name") or session.get("session_name")
            orphan_config = execution_config.snapshot_attempt(run)
            payload = {
                "root_id": root_id,
                "task_id": None,
                "attempt_id": None,
                "agent_id": None,
                "job_id": job_id,
                "session_name": session_name,
                "cwd": run["cwd"],
                "backend_id": orphan_config["backend"],
                "config_json": json.dumps(orphan_config, sort_keys=True),
                "execution_id": "legacy-orphan:%s" % (job_id or session_name),
                "generation": 1,
            }
            identity = job_id or session_name
            con.execute(
                """INSERT OR IGNORE INTO side_effect_outbox(
                     root_id, effect_type, payload_json, idempotency_key, status, attempts, created_at
                   ) VALUES (?, 'stop_agent', ?, ?, 'pending', 0, ?)""",
                (
                    root_id,
                    json.dumps(payload, ensure_ascii=False, sort_keys=True),
                    "stop:orphan:%s:%s" % (root_id, identity),
                    state_store.now(),
                ),
            )
    outcomes = reconcile_execution_outcomes(root_id, schedule_retry=False)
    with state_store.transaction() as con:
        finished = state_store.now()
        con.execute(
            "UPDATE agents SET state='terminal', finished_at=? WHERE root_id=? AND state != 'terminal'",
            (finished, root_id),
        )
        con.execute(
            """UPDATE task_attempts SET status='cancelled', finished_at=?
               WHERE root_id=? AND status IN ('assigned','running')""",
            (finished, root_id),
        )
        con.execute(
            """UPDATE tasks SET status='cancelled', finished_at=?
               WHERE root_id=? AND status IN ('pending','ready','assigned','active','stopping','blocked')""",
            (finished, root_id),
        )
    side_effects = outbox.drain(root_id, adapter=adapter)
    with state_store.transaction() as con:
        pending = con.execute(
            """SELECT COUNT(*) AS n FROM side_effect_outbox
               WHERE root_id=? AND effect_type='stop_agent' AND status IN ('pending','running')""",
            (root_id,),
        ).fetchone()["n"]
        failed = con.execute(
            """SELECT COUNT(*) AS n FROM side_effect_outbox
               WHERE root_id=? AND effect_type='stop_agent' AND status='failed'""",
            (root_id,),
        ).fetchone()["n"]
        running_spawns = con.execute(
            """SELECT COUNT(*) AS n FROM side_effect_outbox
               WHERE root_id=? AND effect_type='spawn_agent' AND status='running'""",
            (root_id,),
        ).fetchone()["n"]
        open_executions = con.execute(
            """SELECT COUNT(*) AS n FROM execution_sessions
               WHERE root_id=? AND status != 'closed'""",
            (root_id,),
        ).fetchone()["n"]
        cleanup_complete = (
            pending == 0
            and failed == 0
            and running_spawns == 0
            and open_executions == 0
            and not observation_errors
        )
        if cleanup_complete:
            con.execute(
                "UPDATE runs SET status='cancelled', finished_at=?, updated_at=? WHERE root_id=?",
                (state_store.now(), state_store.now(), root_id),
            )
        state_store.append_event(
            con, root_id, "AgentStopped", {"cascade": True, "cleanup_complete": cleanup_complete}
        )
    result = {
        "root_id": root_id,
        "terminal": cleanup_complete,
        "status": "cancelled" if cleanup_complete else "stopping",
        "cleanup_complete": cleanup_complete,
        "side_effects": side_effects,
        "execution_outcomes": outcomes,
        "session_observation_errors": observation_errors,
    }
    if result["terminal"] and execution_config.supports_hooks(execution_config.load_run_execution(run)):
        hook_manager.cleanup_project_hooks(run["cwd"], root_id=root_id)
    if result["terminal"]:
        execution_secrets.cleanup_run_seed_if_safe(root_id)
    return result


def _orphan_sessions(root_id, adapter, errors=None):
    run = state_store.get_run(root_id)
    if run is None:
        if errors is not None:
            errors.append("session listing is unavailable")
        return []
    try:
        backend = adapter or _run_backend(run)
        sessions = _list_sessions(backend, run["cwd"])
    except Exception as exc:
        if errors is not None:
            errors.append(str(exc))
        return []
    live_recorded = [
        agent for agent in state_store.list_agents(root_id) if agent.get("state") != "terminal"
    ]
    recorded_names = {agent.get("session_name") for agent in live_recorded}
    recorded_jobs = {agent.get("job_id") for agent in live_recorded}
    prefix = "agent-swarm-%s-" % root_id.replace("root_", "")[:8]
    terminal = {"done", "completed", "exited", "failed", "stopped", "error", "cancelled"}
    orphans = []
    for session in sessions:
        if not isinstance(session, dict):
            continue
        name = session.get("name") or session.get("session_name") or ""
        job_id = session.get("job_id") or session.get("id")
        status = session.get("state") or session.get("status")
        if (
            status not in terminal
            and name.startswith(prefix)
            and name not in recorded_names
            and job_id not in recorded_jobs
        ):
            orphans.append(session)
    return orphans


def doctor(root_id, stale_before=None, adapter=None):
    stale_before = state_store.now() - 120 if stale_before is None else stale_before
    run = state_store.get_run(root_id)
    if run is None:
        raise RuntimeError("run not found")
    run_execution = execution_config.load_run_execution(run)
    if run_execution["backend"] == "acp":
        from backends.acp import registry

        backend_preflight = registry.preflight(run_execution.get("acp") or {})
    else:
        command = (run_execution.get("claude_cli") or {}).get("command") or "claude"
        backend_preflight = {
            "backend": "claude_cli",
            "agent": "claude",
            "command": command,
            "available": bool(__import__("shutil").which(command)),
            "auth_prerequisites": ["Existing Claude CLI authentication"],
        }
    if run_execution["backend"] == "acp":
        hooks = {
            "supported": False,
            "installed": False,
            "status": "skipped",
            "reason": "ACP lifecycle is enforced by the detached Worker",
        }
    else:
        hooks_path = pathlib.Path(run["cwd"]) / ".claude" / "settings.local.json"
        hooks = {
            "supported": True,
            "installed": hooks_path.exists(),
            "status": "installed" if hooks_path.exists() else "missing",
            "path": str(hooks_path),
        }
    stale = state_store.fetchall(
        """SELECT agent_id, attempt_id, heartbeat_at FROM agents
           WHERE root_id=? AND state != 'terminal' AND COALESCE(heartbeat_at,0) < ?""",
        (root_id, stale_before),
    )
    effects = state_store.fetchall(
        """SELECT id, effect_type, status, last_error FROM side_effect_outbox
           WHERE root_id=? AND status != 'completed' ORDER BY id""",
        (root_id,),
    )
    observation_errors = []
    orphans = _orphan_sessions(root_id, adapter, errors=observation_errors)
    executions = []
    execution_conflicts = []
    for row in state_store.list_executions(root_id):
        if row["backend_id"] != "acp":
            diagnostic = {
                "attempt_id": row["attempt_id"],
                "backend_id": row["backend_id"],
                "execution_id": row["execution_id"],
                "generation": row["generation"],
                "owner_nonce_set": bool(row.get("owner_nonce")),
                "status": row["status"],
                "prompt_state": row.get("prompt_state"),
                "worker_pid": row.get("worker_pid"),
                "agent_pid": row.get("agent_pid"),
                "worker_alive": None,
                "agent_alive": None,
                "worker_identity_matches": None,
                "agent_identity_matches": None,
                "control_endpoint_exists": False,
                "control_handshake": {"status": "not_applicable"},
                "protocol_version": None,
                "capabilities": {},
                "recent_rpc_error": None,
                "ready_at": row.get("ready_at"),
                "stop_requested_at": row.get("stop_requested_at"),
                "reconciled_at": row.get("reconciled_at"),
                "last_worker_heartbeat_at": row.get("last_worker_heartbeat_at"),
                "exit_reason": row.get("exit_reason"),
            }
            executions.append(diagnostic)
            if row["status"] in {"turn_ended", "error"} and row.get("reconciled_at") is None:
                execution_conflicts.append(row["attempt_id"])
            continue
        from backends.acp import processes, worker_protocol

        worker_alive = processes.pid_alive(row.get("worker_pid"))
        agent_alive = processes.pid_alive(row.get("agent_pid"))
        owner_nonce = row.get("owner_nonce")
        worker_identity_matches = (
            processes.process_has_nonce(row.get("worker_pid"), owner_nonce)
            if worker_alive else None
        )
        agent_identity_matches = (
            processes.process_has_nonce(row.get("agent_pid"), owner_nonce)
            if agent_alive else None
        )
        endpoint_exists = bool(
            row.get("control_endpoint")
            and pathlib.Path(row["control_endpoint"]).exists()
        )
        handshake = {"ok": False, "error": "control endpoint absent"}
        if endpoint_exists:
            try:
                result = worker_protocol.control_request(
                    row["control_endpoint"],
                    "ping",
                    {
                        "execution_id": row["execution_id"],
                        "generation": row["generation"],
                    },
                    timeout=0.5,
                )
                def same_pid(actual, expected):
                    if expected is None:
                        return actual is None
                    try:
                        return int(actual) == int(expected)
                    except (TypeError, ValueError):
                        return False

                matches = (
                    result.get("ok") is True
                    and result.get("execution_id") == row["execution_id"]
                    and int(result.get("generation", -1)) == int(row["generation"])
                    and same_pid(result.get("worker_pid"), row.get("worker_pid"))
                    and same_pid(result.get("agent_pid"), row.get("agent_pid"))
                )
                handshake = (
                    {
                        "ok": True,
                        "worker_pid": result.get("worker_pid"),
                        "agent_pid": result.get("agent_pid"),
                        "status": result.get("status"),
                        "prompt_state": result.get("prompt_state"),
                    }
                    if matches
                    else {"ok": False, "error": "control identity mismatch"}
                )
            except Exception as exc:
                handshake = {"ok": False, "error": str(exc)}
        try:
            capabilities = json.loads(row.get("capabilities_json") or "{}")
        except (TypeError, ValueError):
            capabilities = {"invalid": True}
        recent_rpc_error = None
        log_path = (
            state_store.runtime_root()
            / "logs"
            / root_id
            / "acp"
            / (row["attempt_id"] + ".ndjson")
        )
        if log_path.exists():
            try:
                for line in reversed(log_path.read_text(encoding="utf-8").splitlines()[-200:]):
                    item = json.loads(line)
                    if item.get("event") == "rpc" and item.get("error_code") is not None:
                        recent_rpc_error = {
                            "code": item.get("error_code"),
                            "method": item.get("method"),
                            "at": item.get("at"),
                        }
                        break
            except (OSError, ValueError):
                recent_rpc_error = {"unavailable": True}
        diagnostic = {
            "attempt_id": row["attempt_id"],
            "backend_id": row["backend_id"],
            "execution_id": row["execution_id"],
            "generation": row["generation"],
            "owner_nonce_set": bool(row.get("owner_nonce")),
            "status": row["status"],
            "prompt_state": row.get("prompt_state"),
            "worker_pid": row.get("worker_pid"),
            "agent_pid": row.get("agent_pid"),
            "worker_alive": worker_alive,
            "agent_alive": agent_alive,
            "worker_identity_matches": worker_identity_matches,
            "agent_identity_matches": agent_identity_matches,
            "control_endpoint_exists": endpoint_exists,
            "control_handshake": handshake,
            "protocol_version": row.get("protocol_version"),
            "capabilities": capabilities,
            "recent_rpc_error": recent_rpc_error,
            "ready_at": row.get("ready_at"),
            "stop_requested_at": row.get("stop_requested_at"),
            "reconciled_at": row.get("reconciled_at"),
            "last_worker_heartbeat_at": row.get("last_worker_heartbeat_at"),
            "exit_reason": row.get("exit_reason"),
        }
        executions.append(diagnostic)
        identity_conflict = (
            (worker_alive and worker_identity_matches is not True)
            or (agent_alive and agent_identity_matches is not True)
        )
        control_conflict = (
            (endpoint_exists and not handshake["ok"])
            or (worker_alive and not handshake["ok"])
            or (endpoint_exists and not worker_alive)
        )
        lifecycle_conflict = (
            (not worker_alive and agent_alive)
            or (
                row["status"] in {"running", "stopping"}
                and (not worker_alive or not agent_alive or not handshake["ok"])
            )
            or (
                row["status"] == "closed"
                and (worker_alive or agent_alive or endpoint_exists)
            )
        )
        if identity_conflict or control_conflict or lifecycle_conflict:
            execution_conflicts.append(row["attempt_id"])
        if row["status"] in {"turn_ended", "error"} and row.get("reconciled_at") is None:
            execution_conflicts.append(row["attempt_id"])
    return {
        "run": run,
        "backend_preflight": backend_preflight,
        "hooks": hooks,
        "stale_agents": stale,
        "open_effects": effects,
        "orphan_sessions": orphans,
        "executions": executions,
        "execution_conflicts": sorted(set(execution_conflicts)),
        "session_observation_errors": observation_errors,
        "healthy": (
            not stale
            and not effects
            and not orphans
            and not execution_conflicts
            and not observation_errors
        ),
    }


def metrics(root_id):
    run = state_store.get_run(root_id)
    if run is None:
        raise RuntimeError("run not found")
    tasks = state_store.fetchall(
        "SELECT status, COUNT(*) AS count FROM tasks WHERE root_id=? GROUP BY status", (root_id,)
    )
    attempts = state_store.fetchall(
        "SELECT status, COUNT(*) AS count FROM task_attempts WHERE root_id=? GROUP BY status", (root_id,)
    )
    estimates = state_store.fetchall(
        "SELECT estimate_json FROM tasks WHERE root_id=? AND estimate_json IS NOT NULL", (root_id,)
    )
    split = sum(
        1 for row in estimates if json.loads(row["estimate_json"]).get("effective_strategy") == "split"
    )
    return {
        "root_id": root_id,
        "task_counts": {row["status"]: row["count"] for row in tasks},
        "attempt_counts": {row["status"]: row["count"] for row in attempts},
        "estimate_count": len(estimates),
        "split_count": split,
    }
