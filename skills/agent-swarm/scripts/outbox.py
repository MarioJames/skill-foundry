"""Atomic Effect claims and external process side effects."""

import json
import pathlib

import backends
import execution_secrets
import hook_manager
import prompt_builder
import scheduler
import state_store
from backends.base import (
    AgentBackend,
    BackendPendingError,
    BackendUnknownError,
    SpawnRequest,
    SpawnResult,
    StopRequest,
)


class StaleEffect(RuntimeError):
    pass


def _spawn_call(backend, request):
    if isinstance(backend, AgentBackend):
        result = backend.spawn(request)
    else:
        result = backend.spawn(
            prompt=request.prompt,
            cwd=request.cwd,
            session_name=request.session_name,
            model=request.model,
            env=request.env,
        )
    if isinstance(result, SpawnResult):
        return {
            "job_id": result.job_id,
            "session_name": result.session_name,
            **result.extras,
        }
    if not isinstance(result, dict):
        raise RuntimeError("backend spawn returned an invalid result")
    return result


def _stop_call(backend, request):
    if isinstance(backend, AgentBackend):
        return backend.stop(request)
    return backend.stop(
        job_id=request.job_id,
        session_name=request.session_name,
        cwd=request.cwd,
    )


def _supports_hooks(backend):
    value = getattr(backend, "supports_hooks", None)
    return bool(value()) if callable(value) else True


def recover_stale_claims(root_id, stale_before):
    with state_store.transaction() as con:
        cursor = con.execute(
            """UPDATE effects SET status='pending', claimed_at=NULL
               WHERE root_id=? AND status='running' AND claimed_at < ?""",
            (root_id, stale_before),
        )
        return cursor.rowcount


def _claim(effect_id):
    with state_store.transaction() as con:
        cursor = con.execute(
            """UPDATE effects
               SET status='running', claimed_at=?, attempts=attempts+1
               WHERE id=? AND status='pending'""",
            (state_store.now(), effect_id),
        )
        return cursor.rowcount == 1


def _binding(con, payload):
    run = state_store.get_run(payload.get("root_id"), con)
    task = state_store.get_task(payload.get("task_id"), con)
    attempt = state_store.get_attempt(payload.get("attempt_id"), con)
    launch = state_store.get_launch(payload.get("launch_id"), con)
    if not all((run, task, attempt, launch)):
        raise StaleEffect("effect references missing runtime facts")
    current_attempt = state_store.get_current_attempt(task["task_id"], con)
    current_launch = state_store.get_current_launch(attempt["attempt_id"], con)
    if not (
        task["root_id"] == run["root_id"]
        and attempt["root_id"] == run["root_id"]
        and attempt["task_id"] == task["task_id"]
        and launch["root_id"] == run["root_id"]
        and launch["attempt_id"] == attempt["attempt_id"]
        and current_attempt
        and current_attempt["attempt_id"] == attempt["attempt_id"]
        and current_launch
        and current_launch["launch_id"] == launch["launch_id"]
    ):
        raise StaleEffect("effect is fenced by a newer Attempt or Launch")
    return run, task, attempt, launch


def _enqueue_stop(con, run, task, attempt, launch, reason):
    payload = {
        "root_id": run["root_id"],
        "task_id": task["task_id"],
        "attempt_id": attempt["attempt_id"],
        "launch_id": launch["launch_id"],
        "reason": reason,
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
            state_store.now(),
        ),
    )


def _spawn(effect, payload, adapter=None):
    with state_store.transaction(immediate=False) as con:
        run, task, attempt, launch = _binding(con, payload)
        if run["status"] != "running" or attempt["state"] != "assigned":
            raise StaleEffect("spawn effect no longer targets an assigned Attempt")
        actor_token = execution_secrets.derive_attempt_token(run, attempt["attempt_id"])
        prompt = prompt_builder.build_prompt(run, task, attempt, con)
        env = {
            "AGENT_SWARM_ROOT_ID": run["root_id"],
            "AGENT_SWARM_TASK_ID": str(task["task_id"]),
            "AGENT_SWARM_ATTEMPT_ID": str(attempt["attempt_id"]),
            "AGENT_SWARM_ACTOR_TOKEN": actor_token,
            "AGENT_SWARM_HOME": str(state_store.runtime_root()),
            "AGENT_SWARM_SKILL_DIR": str(pathlib.Path(__file__).resolve().parent.parent),
        }
        request = SpawnRequest(
            prompt=prompt,
            cwd=run["cwd"],
            session_name=launch["session_name"],
            model=attempt.get("model_name"),
            env=env,
            backend_config=json.loads(attempt["config_json"]),
            metadata={
                "root_id": run["root_id"],
                "task_id": str(task["task_id"]),
                "attempt_id": str(attempt["attempt_id"]),
                "launch_id": str(launch["launch_id"]),
            },
        )
    backend = adapter or backends.resolve_spawn_backend(launch)
    if _supports_hooks(backend):
        hook_manager.ensure_project_hooks(request.cwd, root_id=payload["root_id"])
    result = _spawn_call(backend, request)
    if _supports_hooks(backend):
        hook_manager.ensure_project_hooks(request.cwd, root_id=payload["root_id"])

    with state_store.transaction() as con:
        run = state_store.get_run(payload["root_id"], con)
        task = state_store.get_task(payload["task_id"], con)
        attempt = state_store.get_attempt(payload["attempt_id"], con)
        launch = state_store.get_launch(payload["launch_id"], con)
        current_attempt = state_store.get_current_attempt(payload["task_id"], con) if task else None
        current_launch = state_store.get_current_launch(payload["attempt_id"], con) if attempt else None
        expected = bool(
            run
            and run["status"] == "running"
            and task
            and attempt
            and launch
            and current_attempt
            and current_attempt["attempt_id"] == attempt["attempt_id"]
            and current_launch
            and current_launch["launch_id"] == launch["launch_id"]
            and attempt["state"] in {"assigned", "evaluating", "active", "waiting"}
            and launch["status"] in {"starting", "running"}
        )
        timestamp = state_store.now()
        if not expected:
            completed_before_ack = bool(
                launch
                and launch.get("ready_at") is not None
                and launch["status"] == "closed"
                and attempt
                and attempt["state"] in {"done", "failed", "cancelled"}
            )
            if all((run, task, attempt, launch)) and not completed_before_ack:
                _enqueue_stop(con, run, task, attempt, launch, "spawn_compensation")
            con.execute(
                """UPDATE effects SET status='completed', completed_at=?,
                     last_error=? WHERE id=?""",
                (
                    timestamp,
                    (
                        "spawn acknowledged after Attempt completed"
                        if completed_before_ack
                        else "spawn compensated after state changed"
                    ),
                    effect["id"],
                ),
            )
            return
        con.execute(
            """UPDATE launches
               SET backend_ref=COALESCE(backend_ref, ?),
                   status=CASE WHEN status='starting' THEN 'running' ELSE status END,
                   prompt_state=CASE WHEN prompt_state='pending' THEN 'in_flight' ELSE prompt_state END,
                   ready_at=COALESCE(ready_at, ?), last_event_at=?
               WHERE launch_id=?""",
            (result.get("job_id"), timestamp, timestamp, launch["launch_id"]),
        )
        con.execute(
            """UPDATE attempts
               SET state=CASE WHEN state='assigned' THEN 'evaluating' ELSE state END,
                   started_at=COALESCE(started_at, ?), heartbeat_at=?
               WHERE attempt_id=?""",
            (timestamp, timestamp, attempt["attempt_id"]),
        )
        con.execute(
            "UPDATE tasks SET status='active' WHERE task_id=? AND status='assigned'",
            (task["task_id"],),
        )
        con.execute(
            "UPDATE effects SET status='completed', completed_at=?, last_error=NULL WHERE id=?",
            (timestamp, effect["id"]),
        )
        state_store.append_event(
            con,
            run["root_id"],
            "AgentProcessStarted",
            {
                "launch_id": launch["launch_id"],
                "backend_ref": result.get("job_id"),
                "backend_id": launch["backend_id"],
            },
            task_id=task["task_id"],
            attempt_id=attempt["attempt_id"],
        )


def _spawn_failed(effect, payload, error):
    with state_store.transaction() as con:
        con.execute(
            "UPDATE effects SET status='failed', last_error=? WHERE id=?",
            (str(error), effect["id"]),
        )
        run = state_store.get_run(payload.get("root_id"), con)
        task = state_store.get_task(payload.get("task_id"), con)
        attempt = state_store.get_attempt(payload.get("attempt_id"), con)
        launch = state_store.get_launch(payload.get("launch_id"), con)
        current = state_store.get_current_attempt(task["task_id"], con) if task else None
        if not all((run, task, attempt, launch, current)) or current["attempt_id"] != attempt["attempt_id"]:
            return
        if attempt["state"] not in {"assigned", "evaluating"}:
            return
        finished = state_store.now()
        result = {
            "status": "failed",
            "retryable": True,
            "summary": str(error),
            "caveats": [],
        }
        con.execute(
            """UPDATE attempts SET state='failed', retryable=1, result_json=?,
                 last_error=?, finished_at=? WHERE attempt_id=?""",
            (json.dumps(result, ensure_ascii=False), str(error), finished, attempt["attempt_id"]),
        )
        con.execute(
            """UPDATE launches SET status='closed', prompt_state='cancelled',
                 exit_reason=?, closed_at=?, last_event_at=? WHERE launch_id=?""",
            (str(error), finished, finished, launch["launch_id"]),
        )
        if attempt["attempt_no"] < run["max_attempts_per_task"]:
            con.execute("UPDATE tasks SET status='ready' WHERE task_id=?", (task["task_id"],))
            state_store.append_event(
                con,
                run["root_id"],
                "TaskRetryScheduled",
                {"reason": "spawn_failed"},
                task_id=task["task_id"],
                attempt_id=attempt["attempt_id"],
            )
        else:
            con.execute(
                "UPDATE tasks SET status='failed', finished_at=? WHERE task_id=?",
                (finished, task["task_id"]),
            )
        state_store.append_event(
            con,
            run["root_id"],
            "AgentSpawnFailed",
            {"launch_id": launch["launch_id"], "error": str(error)},
            task_id=task["task_id"],
            attempt_id=attempt["attempt_id"],
        )
        scheduler.schedule_with_connection(con, run["root_id"])


def _stop(effect, payload, adapter=None):
    launch = state_store.get_launch(payload.get("launch_id"))
    if launch is None:
        raise StaleEffect("stop effect launch no longer exists")
    backend = adapter or backends.resolve_execution_backend(launch)
    _stop_call(
        backend,
        StopRequest(
            job_id=launch.get("backend_ref"),
            session_name=launch.get("session_name"),
            cwd=(state_store.get_run(launch["root_id"]) or {}).get("cwd"),
            reason=payload.get("reason"),
        ),
    )
    with state_store.transaction() as con:
        timestamp = state_store.now()
        con.execute(
            """UPDATE launches SET status='closed', prompt_state='cancelled',
                 closed_at=COALESCE(closed_at, ?), last_event_at=? WHERE launch_id=?""",
            (timestamp, timestamp, launch["launch_id"]),
        )
        con.execute(
            """UPDATE acp_sessions SET status='closed', closed_at=COALESCE(closed_at, ?)
               WHERE launch_id=? AND status='active'""",
            (timestamp, launch["launch_id"]),
        )
        con.execute(
            "UPDATE effects SET status='completed', completed_at=?, last_error=NULL WHERE id=?",
            (timestamp, effect["id"]),
        )
        retry_scheduled = False
        retry_task_id = payload.get("retry_task_id")
        if retry_task_id:
            task = state_store.get_task(retry_task_id, con)
            attempt = state_store.get_attempt(launch["attempt_id"], con)
            current = state_store.get_current_attempt(retry_task_id, con) if task else None
            if (
                task
                and attempt
                and current
                and current["attempt_id"] == attempt["attempt_id"]
                and task["status"] == "stopping"
                and attempt["state"] == "failed"
            ):
                con.execute("UPDATE tasks SET status='ready' WHERE task_id=?", (retry_task_id,))
                scheduler.schedule_with_connection(con, payload["root_id"])
                retry_scheduled = True
        state_store.append_event(
            con,
            payload["root_id"],
            "AgentStopped",
            {"launch_id": launch["launch_id"], "retry_scheduled": retry_scheduled},
            task_id=launch["task_id"],
            attempt_id=launch["attempt_id"],
        )


def drain(root_id, adapter=None, max_effects=None):
    run = state_store.get_run(root_id)
    automatic_limit = run["max_total_tasks"] * run["max_attempts_per_task"] + 100 if run else 1000
    limit = automatic_limit if max_effects is None else max(0, int(max_effects))
    summary = {"claimed": 0, "completed": 0, "failed": 0, "stale": 0, "deferred": 0}
    processed = 0
    while processed < limit:
        rows = state_store.fetchall(
            "SELECT * FROM effects WHERE root_id=? AND status='pending' ORDER BY id LIMIT 1",
            (root_id,),
        )
        if not rows:
            break
        effect = rows[0]
        if not _claim(effect["id"]):
            continue
        processed += 1
        summary["claimed"] += 1
        payload = json.loads(effect["payload_json"])
        try:
            if effect["effect_type"] == "spawn_agent":
                _spawn(effect, payload, adapter)
            elif effect["effect_type"] == "stop_agent":
                _stop(effect, payload, adapter)
            else:
                raise RuntimeError("unsupported effect: %s" % effect["effect_type"])
            summary["completed"] += 1
        except StaleEffect as exc:
            with state_store.transaction() as con:
                con.execute(
                    "UPDATE effects SET status='completed', completed_at=?, last_error=? WHERE id=?",
                    (state_store.now(), str(exc), effect["id"]),
                )
            summary["stale"] += 1
        except (BackendPendingError, BackendUnknownError) as exc:
            with state_store.transaction() as con:
                con.execute(
                    "UPDATE effects SET status='pending', claimed_at=NULL, last_error=? WHERE id=?",
                    (str(exc), effect["id"]),
                )
            summary["deferred"] += 1
            break
        except Exception as exc:
            if effect["effect_type"] == "spawn_agent":
                _spawn_failed(effect, payload, exc)
            else:
                with state_store.transaction() as con:
                    con.execute(
                        "UPDATE effects SET status='failed', last_error=? WHERE id=?",
                        (str(exc), effect["id"]),
                    )
            summary["failed"] += 1
    return summary
