"""Atomic outbox claims and external process side effects."""

import json

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
    else:
        return backend.stop(
            job_id=request.job_id,
            session_name=request.session_name,
            cwd=request.cwd,
        )


def _supports_hooks(backend):
    value = getattr(backend, "supports_hooks", None)
    return bool(value()) if callable(value) else True


def _validate_effect_execution(payload, execution):
    expected = {
        "backend_id": execution.get("backend_id"),
        "execution_id": execution.get("execution_id"),
        "generation": execution.get("generation"),
    }
    for key, value in expected.items():
        if payload.get(key) != value:
            raise StaleEffect(
                "stale generation/backend effect: %s expected %r, got %r"
                % (key, value, payload.get(key))
            )


def recover_stale_claims(root_id, stale_before):
    with state_store.transaction() as con:
        cursor = con.execute(
            """UPDATE side_effect_outbox
               SET status='pending', claimed_at=NULL
               WHERE root_id=? AND status='running' AND claimed_at < ?""",
            (root_id, stale_before),
        )
        return cursor.rowcount


def _claim(effect_id):
    with state_store.transaction() as con:
        cursor = con.execute(
            """UPDATE side_effect_outbox
               SET status='running', claimed_at=?, attempts=attempts+1
               WHERE id=? AND status='pending'""",
            (state_store.now(), effect_id),
        )
        return cursor.rowcount == 1


def _spawn(effect, payload, adapter=None):
    with state_store.transaction(immediate=False) as con:
        run = state_store.get_run(payload["root_id"], con)
        task = state_store.get_task(payload["task_id"], con)
        attempt = state_store.get_attempt(payload["attempt_id"], con)
        agent = state_store.get_agent(payload["agent_id"], con)
        execution = state_store.get_execution(payload["attempt_id"], con)
        if not all((run, task, attempt, agent, execution)) or task["current_attempt_id"] != attempt["attempt_id"]:
            raise RuntimeError("spawn effect references a stale attempt")
        _validate_effect_execution(payload, execution)
        actor_token = payload.get("actor_token")
        if not actor_token:
            actor_token = execution_secrets.derive_attempt_token(
                run, attempt["attempt_id"], agent["agent_id"]
            )
        else:
            redacted_payload = dict(payload)
            redacted_payload.pop("actor_token", None)
            redacted_payload["legacy_actor_token_redacted"] = True
            con.execute(
                "UPDATE side_effect_outbox SET payload_json=? WHERE id=?",
                (
                    json.dumps(redacted_payload, ensure_ascii=False, sort_keys=True),
                    effect["id"],
                ),
            )
        prompt = prompt_builder.build_prompt(run, task, attempt, agent, con)
        env = {
            "AGENT_SWARM_ROOT_ID": run["root_id"],
            "AGENT_SWARM_TASK_ID": task["task_id"],
            "AGENT_SWARM_ATTEMPT_ID": attempt["attempt_id"],
            "AGENT_SWARM_AGENT_ID": agent["agent_id"],
            "AGENT_SWARM_ACTOR_TOKEN": actor_token,
            "AGENT_SWARM_HOME": str(state_store.runtime_root()),
            "AGENT_SWARM_SKILL_DIR": str(__import__("pathlib").Path(__file__).resolve().parent.parent),
        }
        request = SpawnRequest(
            prompt=prompt,
            cwd=run["cwd"],
            session_name=agent["session_name"],
            model=agent["model_name"],
            env=env,
            backend_config=json.loads(execution["config_json"]),
            metadata={
                "root_id": run["root_id"],
                "task_id": task["task_id"],
                "attempt_id": attempt["attempt_id"],
                "agent_id": agent["agent_id"],
                "execution_id": execution["execution_id"],
            },
        )
    backend = adapter or backends.resolve_spawn_backend(execution)
    if _supports_hooks(backend):
        hook_manager.ensure_project_hooks(request.cwd, root_id=payload["root_id"])
    result = _spawn_call(backend, request)
    # A background launcher may create a worktree during spawn. Refresh again
    # after it returns so that worktree receives the merged local Hook settings
    # without adding a CLI --settings overlay that could shadow user Hooks.
    if _supports_hooks(backend):
        hook_manager.ensure_project_hooks(request.cwd, root_id=payload["root_id"])
    with state_store.transaction() as con:
        run = state_store.get_run(payload["root_id"], con)
        task = state_store.get_task(payload["task_id"], con)
        attempt = state_store.get_attempt(payload["attempt_id"], con)
        agent = state_store.get_agent(payload["agent_id"], con)
        expected = bool(
            run
            and run["status"] == "running"
            and task
            and task["current_attempt_id"] == payload["attempt_id"]
            and task["status"] == "assigned"
            and attempt
            and attempt["status"] == "assigned"
            and agent
            and agent["state"] == "received"
        )
        if not expected:
            stopped_at = state_store.now()
            stop_payload = {
                "root_id": payload["root_id"],
                "task_id": payload["task_id"],
                "attempt_id": payload["attempt_id"],
                "agent_id": payload["agent_id"],
                "job_id": result.get("job_id"),
                "session_name": result.get("session_name") or request.session_name,
                "cwd": request.cwd,
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
                    payload["root_id"],
                    json.dumps(stop_payload, ensure_ascii=False, sort_keys=True),
                    "stop:late:%s" % payload["attempt_id"],
                    stopped_at,
                ),
            )
            con.execute(
                """UPDATE side_effect_outbox
                   SET status='completed', completed_at=?, last_error='spawn compensated after state changed'
                   WHERE id=?""",
                (stopped_at, effect["id"]),
            )
            state_store.append_event(
                con,
                payload["root_id"],
                "AgentSpawnCompensationRequested",
                {"job_id": result.get("job_id")},
                task_id=payload["task_id"],
                attempt_id=payload["attempt_id"],
                agent_id=payload["agent_id"],
            )
            return
        started = state_store.now()
        con.execute(
            "UPDATE task_attempts SET status='running', started_at=? WHERE attempt_id=?",
            (started, payload["attempt_id"]),
        )
        con.execute("UPDATE tasks SET status='active' WHERE task_id=?", (payload["task_id"],))
        con.execute(
            """UPDATE agents
               SET state='evaluating', job_id=?, session_name=?, heartbeat_at=?
               WHERE agent_id=?""",
            (
                result.get("job_id"),
                result.get("session_name") or request.session_name,
                started,
                payload["agent_id"],
            ),
        )
        con.execute(
            """UPDATE execution_sessions
               SET status='running', prompt_state='in_flight', ready_at=?, last_event_at=?
               WHERE attempt_id=?""",
            (started, started, payload["attempt_id"]),
        )
        con.execute(
            "UPDATE side_effect_outbox SET status='completed', completed_at=?, last_error=NULL WHERE id=?",
            (started, effect["id"]),
        )
        state_store.append_event(
            con,
            payload["root_id"],
            "AgentProcessStarted",
            {"job_id": result.get("job_id"), "backend_id": execution["backend_id"]},
            task_id=payload["task_id"], attempt_id=payload["attempt_id"], agent_id=payload["agent_id"],
        )


def _spawn_failed(effect, payload, error):
    with state_store.transaction() as con:
        con.execute(
            "UPDATE side_effect_outbox SET status='failed', last_error=? WHERE id=?",
            (str(error), effect["id"]),
        )
        run = state_store.get_run(payload.get("root_id"), con)
        task = state_store.get_task(payload.get("task_id"), con)
        attempt = state_store.get_attempt(payload.get("attempt_id"), con)
        agent = state_store.get_agent(payload.get("agent_id"), con)
        if (
            not all((run, task, attempt, agent))
            or run["status"] != "running"
            or task["current_attempt_id"] != attempt["attempt_id"]
            or task["status"] != "assigned"
            or attempt["status"] != "assigned"
            or agent["state"] != "received"
        ):
            return
        finished = state_store.now()
        result = {"status": "failed", "retryable": True, "summary": str(error), "caveats": []}
        con.execute(
            "UPDATE task_attempts SET status='failed', retryable=1, result_json=?, finished_at=? WHERE attempt_id=?",
            (json.dumps(result, ensure_ascii=False), finished, attempt["attempt_id"]),
        )
        con.execute(
            "UPDATE agents SET state='terminal', last_error=?, finished_at=? WHERE agent_id=?",
            (str(error), finished, agent["agent_id"]),
        )
        if attempt["attempt_no"] < run["max_attempts_per_task"]:
            con.execute("UPDATE tasks SET status='ready' WHERE task_id=?", (task["task_id"],))
            state_store.append_event(
                con, run["root_id"], "TaskRetryScheduled", {"reason": "spawn_failed"},
                task_id=task["task_id"], attempt_id=attempt["attempt_id"], agent_id=agent["agent_id"],
            )
        else:
            con.execute(
                "UPDATE tasks SET status='failed', finished_at=? WHERE task_id=?", (finished, task["task_id"])
            )
        state_store.append_event(
            con, run["root_id"], "AgentSpawnFailed", {"error": str(error)},
            task_id=task["task_id"], attempt_id=attempt["attempt_id"], agent_id=agent["agent_id"],
        )
        scheduler.schedule_with_connection(con, run["root_id"])


def _stop(effect, payload, adapter=None):
    execution = state_store.get_execution(payload.get("attempt_id"))
    if execution is None and payload.get("backend_id"):
        execution = {
            "backend_id": payload["backend_id"],
            "config_json": payload.get("config_json") or "{}",
        }
    if execution is None and adapter is None:
        raise RuntimeError("stop effect has no execution record")
    if payload.get("attempt_id") is not None:
        _validate_effect_execution(payload, execution)
    backend = adapter or backends.resolve_execution_backend(execution)
    _stop_call(
        backend,
        StopRequest(
            job_id=payload.get("job_id"),
            session_name=payload.get("session_name"),
            cwd=payload.get("cwd"),
            reason=payload.get("reason"),
        ),
    )
    with state_store.transaction() as con:
        con.execute(
            "UPDATE side_effect_outbox SET status='completed', completed_at=?, last_error=NULL WHERE id=?",
            (state_store.now(), effect["id"]),
        )
        if execution is not None:
            closed = state_store.now()
            con.execute(
                """UPDATE execution_sessions
                   SET status='closed', prompt_state='cancelled', closed_at=?, last_event_at=?
                   WHERE attempt_id=?""",
                (closed, closed, payload.get("attempt_id")),
            )
        retry_scheduled = False
        retry_task_id = payload.get("retry_task_id")
        if retry_task_id:
            task = state_store.get_task(retry_task_id, con)
            attempt = state_store.get_attempt(payload.get("attempt_id"), con)
            if (
                task
                and attempt
                and task["current_attempt_id"] == attempt["attempt_id"]
                and task["status"] == "stopping"
                and attempt["status"] == "failed"
            ):
                con.execute("UPDATE tasks SET status='ready' WHERE task_id=?", (retry_task_id,))
                scheduler.schedule_with_connection(con, payload["root_id"])
                retry_scheduled = True
        state_store.append_event(
            con,
            payload["root_id"],
            "AgentStopped",
            {"job_id": payload.get("job_id"), "retry_scheduled": retry_scheduled},
            task_id=payload.get("task_id"), attempt_id=payload.get("attempt_id"),
            agent_id=payload.get("agent_id"),
        )


def drain(root_id, adapter=None, max_effects=None):
    run = state_store.get_run(root_id)
    automatic_limit = (
        run["max_total_tasks"] * run["max_attempts_per_task"] + 100 if run else 1000
    )
    limit = automatic_limit if max_effects is None else max(0, int(max_effects))
    summary = {
        "claimed": 0,
        "completed": 0,
        "failed": 0,
        "stale": 0,
        "deferred": 0,
    }
    processed = 0
    while processed < limit:
        rows = state_store.fetchall(
            """SELECT * FROM side_effect_outbox
               WHERE root_id=? AND status='pending' ORDER BY id LIMIT 1""",
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
                raise RuntimeError("unsupported outbox effect: %s" % effect["effect_type"])
            summary["completed"] += 1
        except StaleEffect as exc:
            with state_store.transaction() as con:
                con.execute(
                    """UPDATE side_effect_outbox
                       SET status='completed', completed_at=?, last_error=? WHERE id=?""",
                    (state_store.now(), str(exc), effect["id"]),
                )
            summary["stale"] += 1
        except (BackendPendingError, BackendUnknownError) as exc:
            with state_store.transaction() as con:
                con.execute(
                    """UPDATE side_effect_outbox
                       SET status='pending', claimed_at=NULL, last_error=? WHERE id=?""",
                    (str(exc), effect["id"]),
                )
            summary["deferred"] += 1
            # Retrying the same effect again in this drain call would only
            # burn CPU and the bounded launch grace. A later watchdog/recover
            # tick observes the persisted execution facts first.
            break
        except Exception as exc:
            if effect["effect_type"] == "spawn_agent":
                _spawn_failed(effect, payload, exc)
            else:
                with state_store.transaction() as con:
                    con.execute(
                        "UPDATE side_effect_outbox SET status='failed', last_error=? WHERE id=?",
                        (str(exc), effect["id"]),
                    )
            summary["failed"] += 1
    return summary
