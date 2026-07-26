"""Owner lease, heartbeat, stale-attempt recovery, and stop cascade."""

import json
import secrets
import uuid

import claude_adapter
import hook_runtime
import hook_manager
import outbox
import scheduler
import state_store


OWNER_LEASE_SECONDS = 15 * 60
CHILD_HEARTBEAT_TIMEOUT_SECONDS = 5 * 60
OUTBOX_CLAIM_TIMEOUT_SECONDS = 120


class _DefaultAdapter:
    observe_session = staticmethod(claude_adapter.observe_session)
    session_alive = staticmethod(claude_adapter.session_alive)
    spawn = staticmethod(claude_adapter.spawn)
    stop = staticmethod(claude_adapter.stop)
    list_sessions = staticmethod(claude_adapter.list_sessions)


def _verify_owner(run, token):
    if not state_store.token_matches(token, run.get("owner_token_hash")):
        raise RuntimeError("invalid owner token")


def heartbeat(root_id, task_id, attempt_id, agent_id, actor_token):
    return hook_runtime.heartbeat(root_id, task_id, attempt_id, agent_id, actor_token)


def observe_session_end(root_id, task_id, attempt_id, agent_id, actor_token):
    return hook_runtime.observe_session_end(root_id, task_id, attempt_id, agent_id, actor_token)


def _reconcile_started_sessions(root_id, adapter):
    if not hasattr(adapter, "list_sessions"):
        return 0
    run = state_store.get_run(root_id)
    try:
        sessions = adapter.list_sessions(cwd=run["cwd"])
    except Exception:
        return 0
    terminal = {"done", "completed", "exited", "failed", "stopped", "error", "cancelled"}
    by_name = {}
    for session in sessions:
        if not isinstance(session, dict):
            continue
        name = session.get("name") or session.get("session_name")
        status = session.get("state") or session.get("status")
        if name and status not in terminal:
            by_name[name] = session
    reconciled = 0
    with state_store.transaction() as con:
        rows = state_store.fetchall(
            """SELECT a.*, ta.status AS attempt_status, t.current_attempt_id
               FROM agents a
               JOIN task_attempts ta ON ta.attempt_id=a.attempt_id
               JOIN tasks t ON t.task_id=a.task_id
               WHERE a.root_id=? AND a.state='received' AND ta.status='assigned'""",
            (root_id,),
            con,
        )
        for agent in rows:
            session = by_name.get(agent.get("session_name"))
            if session is None or agent["current_attempt_id"] != agent["attempt_id"]:
                continue
            timestamp = state_store.now()
            job_id = session.get("job_id") or session.get("id")
            con.execute(
                "UPDATE task_attempts SET status='running', started_at=COALESCE(started_at, ?) WHERE attempt_id=?",
                (timestamp, agent["attempt_id"]),
            )
            con.execute("UPDATE tasks SET status='active' WHERE task_id=?", (agent["task_id"],))
            con.execute(
                "UPDATE agents SET state='evaluating', job_id=?, heartbeat_at=? WHERE agent_id=?",
                (job_id, timestamp, agent["agent_id"]),
            )
            con.execute(
                """UPDATE side_effect_outbox
                   SET status='completed', completed_at=?, last_error=NULL
                   WHERE idempotency_key=? AND status IN ('pending','running')""",
                (timestamp, "spawn:%s" % agent["attempt_id"]),
            )
            state_store.append_event(
                con, root_id, "AgentProcessStarted", {"job_id": job_id, "reconciled": True},
                task_id=agent["task_id"], attempt_id=agent["attempt_id"], agent_id=agent["agent_id"],
            )
            reconciled += 1
    return reconciled


def _observe_session(adapter, agent, cwd):
    observer = getattr(adapter, "observe_session", None)
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
    payload = {
        "root_id": run["root_id"],
        "task_id": task["task_id"],
        "attempt_id": attempt["attempt_id"],
        "agent_id": agent["agent_id"],
        "job_id": agent.get("job_id"),
        "session_name": agent.get("session_name"),
        "cwd": run["cwd"],
        "retry_task_id": task["task_id"],
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


def recover_run(root_id, owner_token, stale_before=None, adapter=None):
    adapter = adapter or _DefaultAdapter()
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
        observation = _observe_session(adapter, agent, run["cwd"])
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
    adapter = adapter or _DefaultAdapter()
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

    observation = _observe_session(adapter, agent, run["cwd"])
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
        token = secrets.token_urlsafe(32)
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
                 heartbeat_at, created_at
               ) VALUES (?, ?, ?, ?, 'evaluating', ?, ?, ?)""",
            (agent_id, root_id, task["task_id"], attempt_id, state_store.hash_token(token), created, created),
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
    try:
        hook_manager.ensure_project_hooks(run["cwd"], root_id=root_id)
    except Exception as exc:
        result["warnings"] = ["hook refresh failed: %s" % exc]
    return result


def stop_run(root_id, actor_token, adapter=None):
    adapter = adapter or _DefaultAdapter()
    with state_store.transaction(immediate=False) as con:
        initial_run = state_store.get_run(root_id, con)
        if initial_run is None:
            raise RuntimeError("run not found")
        _verify_owner(initial_run, actor_token)
        if initial_run["status"] in {"done", "cancelled"}:
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
        con.execute("UPDATE runs SET status='stopping', updated_at=? WHERE root_id=?", (state_store.now(), root_id))
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
        live_agents = state_store.fetchall(
            "SELECT * FROM agents WHERE root_id=? AND state != 'terminal'", (root_id,), con
        )
        for agent in live_agents:
            if agent.get("job_id") or agent.get("session_name"):
                payload = {
                    "root_id": root_id,
                    "task_id": agent["task_id"],
                    "attempt_id": agent["attempt_id"],
                    "agent_id": agent["agent_id"],
                    "job_id": agent.get("job_id"),
                    "session_name": agent.get("session_name"),
                    "cwd": run["cwd"],
                }
                con.execute(
                    """INSERT OR IGNORE INTO side_effect_outbox(
                         root_id, effect_type, payload_json, idempotency_key, status, attempts, created_at
                       ) VALUES (?, 'stop_agent', ?, ?, 'pending', 0, ?)""",
                    (
                        root_id,
                        json.dumps(payload, ensure_ascii=False, sort_keys=True),
                        "stop:%s" % agent["attempt_id"],
                        state_store.now(),
                    ),
                )
        for session in orphan_sessions:
            job_id = session.get("job_id") or session.get("id")
            session_name = session.get("name") or session.get("session_name")
            payload = {
                "root_id": root_id,
                "task_id": None,
                "attempt_id": None,
                "agent_id": None,
                "job_id": job_id,
                "session_name": session_name,
                "cwd": run["cwd"],
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
        cleanup_complete = (
            pending == 0
            and failed == 0
            and running_spawns == 0
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
        "session_observation_errors": observation_errors,
    }
    if result["terminal"]:
        hook_manager.cleanup_project_hooks(run["cwd"], root_id=root_id)
    return result


def _orphan_sessions(root_id, adapter, errors=None):
    run = state_store.get_run(root_id)
    if run is None or not hasattr(adapter, "list_sessions"):
        if errors is not None:
            errors.append("session listing is unavailable")
        return []
    try:
        sessions = adapter.list_sessions(cwd=run["cwd"])
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
    adapter = adapter or _DefaultAdapter()
    stale_before = state_store.now() - 120 if stale_before is None else stale_before
    run = state_store.get_run(root_id)
    if run is None:
        raise RuntimeError("run not found")
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
    return {
        "run": run,
        "stale_agents": stale,
        "open_effects": effects,
        "orphan_sessions": orphans,
        "session_observation_errors": observation_errors,
        "healthy": not stale and not effects and not orphans and not observation_errors,
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
