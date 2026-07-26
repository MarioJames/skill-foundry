"""Lease recovery, Launch reconciliation, stop, doctor, and metrics."""

import json
import os
import pathlib
import secrets

import backends
import execution_config
import execution_secrets
import hook_manager
import hook_runtime
import scheduler
import state_store
from backends.base import ObserveResult


OWNER_LEASE_SECONDS = 15 * 60
HEARTBEAT_STALE_SECONDS = 5 * 60
EFFECT_CLAIM_STALE_SECONDS = 60
LIVE_ATTEMPT_STATES = {"assigned", "evaluating", "active", "waiting", "stopping"}
TERMINAL_ATTEMPT_STATES = {"done", "failed", "cancelled"}


def heartbeat(root_id, task_id, attempt_id, actor_token):
    return hook_runtime.heartbeat(root_id, task_id, attempt_id, actor_token)


def observe_session_end(root_id, task_id, attempt_id, actor_token):
    return hook_runtime.observe_session_end(root_id, task_id, attempt_id, actor_token)


def _verify_owner(run, actor_token):
    if run is None:
        raise ValueError("run not found")
    if not state_store.token_matches(actor_token, run.get("owner_token_hash")):
        raise ValueError("invalid root owner token")


def _observe(launch, adapter=None):
    backend = adapter or backends.resolve_execution_backend(launch)
    result = backend.observe(
        job_id=launch.get("backend_ref"),
        session_name=launch.get("session_name"),
        cwd=(state_store.get_run(launch["root_id"]) or {}).get("cwd"),
    )
    if isinstance(result, ObserveResult):
        return result
    if isinstance(result, dict):
        return ObserveResult(
            result.get("presence") or "unknown",
            session=result.get("session"),
            error=result.get("error"),
        )
    raise RuntimeError("backend observe returned an invalid result")


def _close_launch(con, launch, reason):
    timestamp = state_store.now()
    con.execute(
        """UPDATE launches SET status='closed',
             prompt_state=CASE WHEN prompt_state='ended' THEN prompt_state ELSE 'cancelled' END,
             exit_reason=COALESCE(exit_reason, ?), closed_at=COALESCE(closed_at, ?),
             last_event_at=? WHERE launch_id=?""",
        (reason, timestamp, timestamp, launch["launch_id"]),
    )
    con.execute(
        """UPDATE acp_sessions SET status='closed', closed_at=COALESCE(closed_at, ?)
           WHERE launch_id=? AND status='active'""",
        (timestamp, launch["launch_id"]),
    )


def _fail_live_attempt(con, run, task, attempt, launch, reason):
    current = state_store.get_current_attempt(task["task_id"], con)
    if (
        current is None
        or current["attempt_id"] != attempt["attempt_id"]
        or attempt["state"] not in LIVE_ATTEMPT_STATES
    ):
        return False
    timestamp = state_store.now()
    retryable = attempt["attempt_no"] < run["max_attempts_per_task"]
    result = {
        "status": "failed",
        "retryable": retryable,
        "summary": reason,
        "caveats": [],
    }
    con.execute(
        """UPDATE attempts SET state='failed', retryable=?, result_json=?, last_error=?,
             finished_at=? WHERE attempt_id=?""",
        (
            1 if retryable else 0,
            json.dumps(result, ensure_ascii=False, sort_keys=True),
            reason,
            timestamp,
            attempt["attempt_id"],
        ),
    )
    _close_launch(con, launch, reason)
    if retryable:
        con.execute(
            "UPDATE tasks SET status='ready', finished_at=NULL WHERE task_id=?",
            (task["task_id"],),
        )
        event_type = "TaskRetryScheduled"
    else:
        con.execute(
            "UPDATE tasks SET status='failed', finished_at=? WHERE task_id=?",
            (timestamp, task["task_id"]),
        )
        event_type = "TaskFailed"
    state_store.append_event(
        con,
        run["root_id"],
        event_type,
        {"reason": reason, "previous_attempt": attempt["attempt_id"]},
        task_id=task["task_id"],
        attempt_id=attempt["attempt_id"],
    )
    return True


def _reconcile_one(root_id, attempt, launch, adapter=None):
    task = state_store.get_task(attempt["task_id"])
    run = state_store.get_run(root_id)
    if not task or not run:
        return {"attempt_id": attempt["attempt_id"], "outcome": "missing_facts"}

    # A Worker can close after a prompt ended without a finish Action. That is
    # deterministic even though the process is already gone.
    if launch["status"] in {"closed", "turn_ended", "error"}:
        if attempt["state"] in LIVE_ATTEMPT_STATES:
            reason = launch.get("exit_reason") or "launch_ended_without_finish"
            with state_store.transaction() as con:
                changed = _fail_live_attempt(con, run, task, attempt, launch, reason)
                if changed:
                    scheduler.schedule_with_connection(con, root_id)
            return {"attempt_id": attempt["attempt_id"], "outcome": "retryable_failure"}
        return {"attempt_id": attempt["attempt_id"], "outcome": "terminal"}

    observation = _observe(launch, adapter)
    if observation.presence == "present":
        return {
            "attempt_id": attempt["attempt_id"],
            "launch_id": launch["launch_id"],
            "outcome": "present",
            "heartbeat_at": attempt.get("heartbeat_at"),
        }
    if observation.presence == "unknown":
        return {
            "attempt_id": attempt["attempt_id"],
            "launch_id": launch["launch_id"],
            "outcome": "unknown",
            "error": observation.error,
        }
    with state_store.transaction() as con:
        if attempt["state"] in TERMINAL_ATTEMPT_STATES:
            _close_launch(con, launch, "backend_absent")
            outcome = "closed_terminal_launch"
        elif launch["status"] == "starting" and launch.get("ready_at") is None:
            # The ACP adapter owns append-only startup retry. Keep the current
            # spawn Effect pending so it can perform its launch-grace fence.
            outcome = "starting_absent"
        else:
            changed = _fail_live_attempt(
                con, run, task, attempt, launch, "backend_session_absent"
            )
            if changed:
                scheduler.schedule_with_connection(con, root_id)
            outcome = "retryable_failure" if changed else "stale"
    return {
        "attempt_id": attempt["attempt_id"],
        "launch_id": launch["launch_id"],
        "outcome": outcome,
    }


def reap_children(root_id, actor_token, adapter=None):
    run = state_store.get_run(root_id)
    _verify_owner(run, actor_token)
    if run["status"] != "running":
        raise ValueError("run is not running")
    import outbox

    reclaimed = outbox.recover_stale_claims(
        root_id, state_store.now() - EFFECT_CLAIM_STALE_SECONDS
    )
    outcomes = []
    stalled = []
    for task in state_store.list_tasks(root_id):
        if task["task_id"] == run["root_task_id"]:
            continue
        attempt = state_store.get_current_attempt(task["task_id"])
        if attempt is None:
            continue
        launch = state_store.get_current_launch(attempt["attempt_id"])
        if launch is None:
            continue
        result = _reconcile_one(root_id, attempt, launch, adapter)
        outcomes.append(result)
        heartbeat_at = attempt.get("heartbeat_at") or attempt.get("started_at") or attempt["created_at"]
        if (
            result["outcome"] == "present"
            and attempt["state"] in LIVE_ATTEMPT_STATES
            and heartbeat_at < state_store.now() - HEARTBEAT_STALE_SECONDS
        ):
            stalled.append(
                {
                    "task_id": task["task_id"],
                    "attempt_id": attempt["attempt_id"],
                    "launch_id": launch["launch_id"],
                    "heartbeat_at": heartbeat_at,
                    "message": "Backend is present but the Attempt heartbeat is stale.",
                }
            )
    with state_store.transaction() as con:
        scheduled = scheduler.schedule_with_connection(con, root_id)
    return {
        "ok": True,
        "reclaimed_effect_claims": reclaimed,
        "reconciled": outcomes,
        "stalled_attempts": stalled,
        "scheduled": scheduled,
    }


def recover_run(root_id, actor_token, adapter=None):
    report = reap_children(root_id, actor_token, adapter)
    import outbox

    report["side_effects"] = outbox.drain(root_id, adapter=adapter)
    return report


def kill_stalled_attempt(root_id, actor_token, attempt_id):
    run = state_store.get_run(root_id)
    _verify_owner(run, actor_token)
    attempt_id = int(attempt_id)
    with state_store.transaction() as con:
        attempt = state_store.get_attempt(attempt_id, con)
        if attempt is None or attempt["root_id"] != root_id:
            raise ValueError("attempt not found in run")
        task = state_store.get_task(attempt["task_id"], con)
        current = state_store.get_current_attempt(task["task_id"], con)
        launch = state_store.get_current_launch(attempt_id, con)
        if current is None or current["attempt_id"] != attempt_id:
            raise ValueError("attempt is stale")
        if attempt["state"] not in LIVE_ATTEMPT_STATES or launch is None:
            raise ValueError("attempt has no live Launch")
        timestamp = state_store.now()
        con.execute(
            """UPDATE attempts SET state='failed', retryable=1,
                 last_error='operator_requested_stop', finished_at=? WHERE attempt_id=?""",
            (timestamp, attempt_id),
        )
        con.execute("UPDATE tasks SET status='stopping' WHERE task_id=?", (task["task_id"],))
        con.execute(
            """UPDATE launches SET status='stopping', stop_requested_at=COALESCE(stop_requested_at, ?),
                 last_event_at=? WHERE launch_id=? AND status != 'closed'""",
            (timestamp, timestamp, launch["launch_id"]),
        )
        payload = {
            "root_id": root_id,
            "task_id": task["task_id"],
            "attempt_id": attempt_id,
            "launch_id": launch["launch_id"],
            "retry_task_id": task["task_id"],
            "reason": "operator_requested_stop",
        }
        con.execute(
            """INSERT OR IGNORE INTO effects(
                 root_id, attempt_id, launch_id, effect_type, payload_json,
                 idempotency_key, status, attempts, created_at
               ) VALUES (?, ?, ?, 'stop_agent', ?, ?, 'pending', 0, ?)""",
            (
                root_id,
                attempt_id,
                launch["launch_id"],
                json.dumps(payload, ensure_ascii=False, sort_keys=True),
                "stop:%s" % launch["launch_id"],
                timestamp,
            ),
        )
        con.execute(
            """UPDATE effects SET status='pending', claimed_at=NULL, last_error=NULL
               WHERE idempotency_key=? AND status='failed'""",
            ("stop:%s" % launch["launch_id"],),
        )
        state_store.append_event(
            con,
            root_id,
            "AttemptStopRequested",
            {"launch_id": launch["launch_id"]},
            task_id=task["task_id"],
            attempt_id=attempt_id,
        )
    return {"requested": True, "attempt_id": attempt_id, "launch_id": launch["launch_id"]}


def _ensure_seed(run, con):
    try:
        execution_secrets.derive_attempt_token(run, -1)
        return
    except RuntimeError:
        reference = run.get("token_seed_ref")
        if reference:
            with __import__("contextlib").suppress(FileNotFoundError):
                execution_secrets.resolve_seed_path(reference).unlink()
        reference, digest = execution_secrets.create_run_seed(run["root_id"])
        con.execute(
            "UPDATE runs SET token_seed_ref=?, token_seed_hash=? WHERE root_id=?",
            (reference, digest, run["root_id"]),
        )


def recover_root(root_id, force_takeover=False):
    run = state_store.get_run(root_id)
    if run is None:
        raise ValueError("run not found")
    if run["status"] in {"done", "cancelled"}:
        raise ValueError("terminal run cannot be recovered")
    timestamp = state_store.now()
    if (
        run.get("lease_expires_at")
        and run["lease_expires_at"] > timestamp
        and not force_takeover
    ):
        raise ValueError("root owner lease is still active; use --force-takeover")
    token = "as_" + secrets.token_urlsafe(32)
    with state_store.transaction() as con:
        run = state_store.get_run(root_id, con)
        task = state_store.get_task(run["root_task_id"], con)
        previous = state_store.get_current_attempt(task["task_id"], con)
        if previous and previous["state"] in LIVE_ATTEMPT_STATES:
            con.execute(
                "UPDATE attempts SET state='cancelled', finished_at=? WHERE attempt_id=?",
                (timestamp, previous["attempt_id"]),
            )
        attempt_no = (previous["attempt_no"] if previous else 0) + 1
        config = execution_config.snapshot_attempt(
            run, model=json.loads(run["model_tiers_json"])["strong"]
        )
        cursor = con.execute(
            """INSERT INTO attempts(
                 task_id, attempt_no, state, actor_token_hash, backend_id, agent_type,
                 model_tier, model_name, config_json, heartbeat_at, created_at, started_at
               ) VALUES (?, ?, 'evaluating', ?, ?, ?, 'strong', ?, ?, ?, ?, ?)""",
            (
                task["task_id"],
                attempt_no,
                state_store.hash_token(token),
                config["backend"],
                config["agent"],
                config.get("model"),
                json.dumps(config, ensure_ascii=False, sort_keys=True),
                timestamp,
                timestamp,
                timestamp,
            ),
        )
        attempt_id = cursor.lastrowid
        _ensure_seed(run, con)
        con.execute(
            """UPDATE runs SET status='running', owner_token_hash=?, lease_epoch=lease_epoch+1,
                 lease_expires_at=?, finished_at=NULL, updated_at=? WHERE root_id=?""",
            (
                state_store.hash_token(token),
                timestamp + OWNER_LEASE_SECONDS,
                timestamp,
                root_id,
            ),
        )
        con.execute(
            "UPDATE tasks SET status='active', finished_at=NULL WHERE task_id=?",
            (task["task_id"],),
        )
        state_store.append_event(
            con,
            root_id,
            "RootRecovered",
            {
                "previous_attempt_id": previous["attempt_id"] if previous else None,
                "continuing_mode_ids": [
                    row["mode_id"]
                    for row in state_store.fetchall(
                        "SELECT mode_id FROM modes WHERE root_id=? AND status='running' ORDER BY mode_id",
                        (root_id,),
                        con,
                    )
                ],
            },
            task_id=task["task_id"],
            attempt_id=attempt_id,
        )
        lease_epoch = run["lease_epoch"] + 1
    return {
        "root_id": root_id,
        "task_id": task["task_id"],
        "attempt_id": attempt_id,
        "actor_token": token,
        "lease_epoch": lease_epoch,
        "lease_expires_at": timestamp + OWNER_LEASE_SECONDS,
    }


def cancel_mode_with_connection(con, run, mode, reason):
    """Cancel one mode subtree without bypassing persisted Launch/Effect fences."""
    timestamp = state_store.now()
    mode_ids = [
        row["mode_id"]
        for row in state_store.fetchall(
            """WITH RECURSIVE descendants(mode_id) AS (
                 SELECT mode_id FROM modes WHERE mode_id=?
                 UNION ALL
                 SELECT child.mode_id FROM modes child
                 JOIN descendants parent ON child.parent_mode_id=parent.mode_id
               )
               SELECT mode_id FROM descendants""",
            (mode["mode_id"],),
            con,
        )
    ]
    if not mode_ids:
        return {"cancelled_task_ids": [], "stopping_launch_ids": []}
    marks = ",".join("?" for _ in mode_ids)
    tasks = state_store.fetchall(
        """SELECT DISTINCT t.* FROM tasks t
           JOIN mode_tasks mt ON mt.task_id=t.task_id
           WHERE mt.mode_id IN (%s)""" % marks,
        tuple(mode_ids),
        con,
    )
    cancelled_task_ids = []
    stopping_launch_ids = []
    for task in tasks:
        if task["status"] in {"done", "failed", "blocked", "cancelled"}:
            continue
        attempt = state_store.get_current_attempt(task["task_id"], con)
        launch = (
            state_store.get_current_launch(attempt["attempt_id"], con)
            if attempt is not None
            else None
        )
        if attempt is not None and attempt["state"] in LIVE_ATTEMPT_STATES:
            con.execute(
                """UPDATE attempts SET state='cancelled', retryable=0,
                     last_error=?, finished_at=COALESCE(finished_at, ?)
                   WHERE attempt_id=?""",
                (reason, timestamp, attempt["attempt_id"]),
            )
        con.execute(
            """UPDATE tasks SET status='cancelled', finished_at=COALESCE(finished_at, ?)
               WHERE task_id=?""",
            (timestamp, task["task_id"]),
        )
        cancelled_task_ids.append(task["task_id"])
        if launch is None or launch["status"] == "closed":
            continue
        if launch["status"] == "starting" and launch.get("ready_at") is None:
            con.execute(
                """UPDATE launches SET status='closed', prompt_state='cancelled',
                     exit_reason=?, closed_at=?, last_event_at=? WHERE launch_id=?""",
                (reason, timestamp, timestamp, launch["launch_id"]),
            )
            con.execute(
                """UPDATE effects SET status='completed', completed_at=?, last_error=?
                   WHERE launch_id=? AND effect_type='spawn_agent'
                     AND status IN ('pending','running')""",
                (timestamp, "mode cancelled before spawn", launch["launch_id"]),
            )
            continue
        con.execute(
            """UPDATE launches SET status='stopping',
                 stop_requested_at=COALESCE(stop_requested_at, ?), last_event_at=?
               WHERE launch_id=?""",
            (timestamp, timestamp, launch["launch_id"]),
        )
        payload = {
            "root_id": run["root_id"],
            "task_id": task["task_id"],
            "attempt_id": attempt["attempt_id"],
            "launch_id": launch["launch_id"],
            "reason": "mode_cancelled",
        }
        con.execute(
            """INSERT OR IGNORE INTO effects(
                 root_id, attempt_id, launch_id, effect_type, payload_json,
                 idempotency_key, status, attempts, created_at
               ) VALUES (?, ?, ?, 'stop_agent', ?, ?, 'pending', 0, ?)""",
            (
                run["root_id"],
                attempt["attempt_id"],
                launch["launch_id"],
                json.dumps(payload, ensure_ascii=False, sort_keys=True),
                "stop:%s" % launch["launch_id"],
                timestamp,
            ),
        )
        stopping_launch_ids.append(launch["launch_id"])
    con.execute(
        """UPDATE modes SET status='cancelled', updated_at=?,
             completed_at=COALESCE(completed_at, ?)
           WHERE mode_id IN (%s) AND status='running'""" % marks,
        (timestamp, timestamp, *mode_ids),
    )
    con.execute(
        """UPDATE mode_rounds SET status='cancelled',
             completed_at=COALESCE(completed_at, ?)
           WHERE mode_id IN (%s) AND status='active'""" % marks,
        (timestamp, *mode_ids),
    )
    state_store.append_event(
        con,
        run["root_id"],
        "ModeCancellationRequested",
        {
            "mode_id": mode["mode_id"],
            "mode_ids": mode_ids,
            "task_ids": cancelled_task_ids,
            "launch_ids": stopping_launch_ids,
            "reason": reason,
        },
        task_id=mode["owner_task_id"],
    )
    return {
        "cancelled_task_ids": cancelled_task_ids,
        "stopping_launch_ids": stopping_launch_ids,
    }


def stop_run(root_id, actor_token, adapter=None):
    run = state_store.get_run(root_id)
    _verify_owner(run, actor_token)
    with state_store.transaction() as con:
        timestamp = state_store.now()
        con.execute(
            "UPDATE runs SET status='stopping', updated_at=? WHERE root_id=?",
            (timestamp, root_id),
        )
        for launch in state_store.list_launches(root_id, con):
            if launch["status"] == "closed":
                continue
            con.execute(
                """UPDATE launches SET status='stopping',
                     stop_requested_at=COALESCE(stop_requested_at, ?), last_event_at=?
                   WHERE launch_id=?""",
                (timestamp, timestamp, launch["launch_id"]),
            )
            payload = {
                "root_id": root_id,
                "task_id": launch["task_id"],
                "attempt_id": launch["attempt_id"],
                "launch_id": launch["launch_id"],
                "reason": "run_stopped",
            }
            con.execute(
                """INSERT OR IGNORE INTO effects(
                     root_id, attempt_id, launch_id, effect_type, payload_json,
                     idempotency_key, status, attempts, created_at
                   ) VALUES (?, ?, ?, 'stop_agent', ?, ?, 'pending', 0, ?)""",
                (
                    root_id,
                    launch["attempt_id"],
                    launch["launch_id"],
                    json.dumps(payload, ensure_ascii=False, sort_keys=True),
                    "stop:%s" % launch["launch_id"],
                    timestamp,
                ),
            )
            con.execute(
                """UPDATE effects SET status='pending', claimed_at=NULL, last_error=NULL
                   WHERE idempotency_key=? AND status='failed'""",
                ("stop:%s" % launch["launch_id"],),
            )
        con.execute(
            """UPDATE attempts SET state='cancelled', finished_at=COALESCE(finished_at, ?)
               WHERE attempt_id IN (
                 SELECT a.attempt_id FROM attempts a JOIN tasks t ON t.task_id=a.task_id
                 WHERE t.root_id=?
               ) AND state IN ('assigned','evaluating','active','waiting','stopping')""",
            (timestamp, root_id),
        )
        con.execute(
            """UPDATE tasks SET status='cancelled', finished_at=COALESCE(finished_at, ?)
               WHERE root_id=? AND status NOT IN ('done','failed','blocked','cancelled')""",
            (timestamp, root_id),
        )
        con.execute(
            """UPDATE modes SET status='cancelled', updated_at=?,
                 completed_at=COALESCE(completed_at, ?)
               WHERE root_id=? AND status='running'""",
            (timestamp, timestamp, root_id),
        )
        con.execute(
            """UPDATE mode_rounds SET status='cancelled',
                 completed_at=COALESCE(completed_at, ?)
               WHERE mode_id IN (SELECT mode_id FROM modes WHERE root_id=?)
                 AND status='active'""",
            (timestamp, root_id),
        )
    import outbox

    side_effects = outbox.drain(root_id, adapter=adapter)
    open_launches = [item for item in state_store.list_launches(root_id) if item["status"] != "closed"]
    status = "stopping" if open_launches else "cancelled"
    if not open_launches:
        with state_store.transaction() as con:
            timestamp = state_store.now()
            con.execute(
                "UPDATE runs SET status='cancelled', finished_at=?, updated_at=? WHERE root_id=?",
                (timestamp, timestamp, root_id),
            )
        hook_manager.cleanup_project_hooks(run["cwd"], root_id=root_id)
        execution_secrets.cleanup_run_seed_if_safe(root_id)
    return {
        "root_id": root_id,
        "status": status,
        "open_launches": [item["launch_id"] for item in open_launches],
        "side_effects": side_effects,
    }


def doctor(root_id):
    run = state_store.get_run(root_id)
    if run is None:
        raise ValueError("run not found")
    now = state_store.now()
    attempts = state_store.list_attempts(root_id)
    launches = state_store.list_launches(root_id)
    effects = state_store.list_effects(root_id)
    stale_attempts = [
        {
            "attempt_id": item["attempt_id"],
            "task_id": item["task_id"],
            "state": item["state"],
            "heartbeat_at": item.get("heartbeat_at"),
        }
        for item in attempts
        if item["state"] in LIVE_ATTEMPT_STATES
        and (item.get("heartbeat_at") or item["created_at"]) < now - HEARTBEAT_STALE_SECONDS
    ]
    return {
        "root_id": root_id,
        "run_status": run["status"],
        "stale_attempts": stale_attempts,
        "open_launches": [item for item in launches if item["status"] != "closed"],
        "pending_effects": [item for item in effects if item["status"] in {"pending", "running"}],
    }


def metrics(root_id):
    run = state_store.get_run(root_id)
    if run is None:
        raise ValueError("run not found")
    tasks = state_store.list_tasks(root_id)
    attempts = state_store.list_attempts(root_id)
    launches = state_store.list_launches(root_id)
    sessions = state_store.list_sessions(root_id)

    def counts(items, key):
        result = {}
        for item in items:
            result[item[key]] = result.get(item[key], 0) + 1
        return result

    return {
        "root_id": root_id,
        "run_status": run["status"],
        "tasks": {"total": len(tasks), "by_status": counts(tasks, "status")},
        "attempts": {"total": len(attempts), "by_state": counts(attempts, "state")},
        "launches": {"total": len(launches), "by_status": counts(launches, "status")},
        "acp_sessions": {"total": len(sessions), "by_status": counts(sessions, "status")},
    }
