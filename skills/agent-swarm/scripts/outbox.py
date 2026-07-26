"""Atomic outbox claims and external process side effects."""

import json

import claude_adapter
import hook_manager
import prompt_builder
import scheduler
import state_store


class _DefaultAdapter:
    spawn = staticmethod(claude_adapter.spawn)
    stop = staticmethod(claude_adapter.stop)
    session_alive = staticmethod(claude_adapter.session_alive)


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


def _spawn(effect, payload, adapter):
    with state_store.transaction(immediate=False) as con:
        run = state_store.get_run(payload["root_id"], con)
        task = state_store.get_task(payload["task_id"], con)
        attempt = state_store.get_attempt(payload["attempt_id"], con)
        agent = state_store.get_agent(payload["agent_id"], con)
        if not all((run, task, attempt, agent)) or task["current_attempt_id"] != attempt["attempt_id"]:
            raise RuntimeError("spawn effect references a stale attempt")
        prompt = prompt_builder.build_prompt(run, task, attempt, agent, con)
        env = {
            "AGENT_SWARM_ROOT_ID": run["root_id"],
            "AGENT_SWARM_TASK_ID": task["task_id"],
            "AGENT_SWARM_ATTEMPT_ID": attempt["attempt_id"],
            "AGENT_SWARM_AGENT_ID": agent["agent_id"],
            "AGENT_SWARM_ACTOR_TOKEN": payload["actor_token"],
            "AGENT_SWARM_HOME": str(state_store.runtime_root()),
            "AGENT_SWARM_SKILL_DIR": str(__import__("pathlib").Path(__file__).resolve().parent.parent),
        }
        call = {
            "prompt": prompt,
            "cwd": run["cwd"],
            "session_name": agent["session_name"],
            "model": agent["model_name"],
            "env": env,
        }
    hook_manager.ensure_project_hooks(call["cwd"], root_id=payload["root_id"])
    result = adapter.spawn(**call)
    # A background launcher may create a worktree during spawn. Refresh again
    # after it returns so that worktree receives the merged local Hook settings
    # without adding a CLI --settings overlay that could shadow user Hooks.
    hook_manager.ensure_project_hooks(call["cwd"], root_id=payload["root_id"])
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
                "session_name": result.get("session_name") or call["session_name"],
                "cwd": call["cwd"],
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
                result.get("session_name") or call["session_name"],
                started,
                payload["agent_id"],
            ),
        )
        con.execute(
            "UPDATE side_effect_outbox SET status='completed', completed_at=?, last_error=NULL WHERE id=?",
            (started, effect["id"]),
        )
        state_store.append_event(
            con, payload["root_id"], "AgentProcessStarted", {"job_id": result.get("job_id")},
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


def _stop(effect, payload, adapter):
    adapter.stop(
        job_id=payload.get("job_id"),
        session_name=payload.get("session_name"),
        cwd=payload.get("cwd"),
    )
    with state_store.transaction() as con:
        con.execute(
            "UPDATE side_effect_outbox SET status='completed', completed_at=?, last_error=NULL WHERE id=?",
            (state_store.now(), effect["id"]),
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
    adapter = adapter or _DefaultAdapter()
    run = state_store.get_run(root_id)
    automatic_limit = (
        run["max_total_tasks"] * run["max_attempts_per_task"] + 100 if run else 1000
    )
    limit = automatic_limit if max_effects is None else max(0, int(max_effects))
    summary = {"claimed": 0, "completed": 0, "failed": 0}
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
