"""Dependency resolution and attempt creation for ready child tasks."""

import json

import execution_config
import execution_secrets
import model_policy
import state_store


TERMINAL_TASKS = {"done", "failed", "blocked", "cancelled"}
LIVE_ATTEMPT_STATES = {"assigned", "evaluating", "active", "waiting", "stopping"}


def _resolve_dependencies(con, root_id):
    changed = True
    while changed:
        changed = False
        pending = state_store.fetchall(
            "SELECT * FROM tasks WHERE root_id = ? AND status = 'pending' ORDER BY created_at",
            (root_id,),
            con,
        )
        for task in pending:
            dependencies = state_store.fetchall(
                """SELECT d.condition, upstream.status
                   FROM task_dependencies d
                   JOIN tasks upstream ON upstream.task_id = d.depends_on_task_id
                   WHERE d.task_id = ?""",
                (task["task_id"],),
                con,
            )
            blocked = any(
                dep["condition"] == "success" and dep["status"] in {"failed", "blocked", "cancelled"}
                for dep in dependencies
            )
            if blocked:
                con.execute(
                    "UPDATE tasks SET status='blocked', finished_at=? WHERE task_id=?",
                    (state_store.now(), task["task_id"]),
                )
                state_store.append_event(
                    con, root_id, "TaskBlocked", {"reason": "required_dependency_failed"},
                    task_id=task["task_id"],
                )
                changed = True
                continue
            satisfied = all(
                (dep["condition"] == "success" and dep["status"] == "done")
                or (dep["condition"] == "terminal" and dep["status"] in TERMINAL_TASKS)
                for dep in dependencies
            )
            if satisfied:
                con.execute("UPDATE tasks SET status='ready' WHERE task_id=?", (task["task_id"],))
                state_store.append_event(con, root_id, "TaskReady", task_id=task["task_id"])
                changed = True


def _live_attempt_count(con, root_id):
    marks = ",".join("?" for _ in LIVE_ATTEMPT_STATES)
    params = [root_id] + sorted(LIVE_ATTEMPT_STATES)
    return con.execute(
        """SELECT COUNT(*) AS n FROM attempts a
           JOIN tasks t ON t.task_id=a.task_id
           WHERE t.root_id=? AND a.state IN (%s)""" % marks,
        params,
    ).fetchone()["n"]


def _create_attempt(con, run, task):
    last_no = con.execute(
        "SELECT COALESCE(MAX(attempt_no), 0) AS n FROM attempts WHERE task_id=?",
        (task["task_id"],),
    ).fetchone()["n"]
    attempt_no = last_no + 1
    if attempt_no > run["max_attempts_per_task"]:
        con.execute(
            "UPDATE tasks SET status='failed', finished_at=? WHERE task_id=?",
            (state_store.now(), task["task_id"]),
        )
        state_store.append_event(
            con, run["root_id"], "TaskFailed", {"reason": "attempt_budget_exhausted"},
            task_id=task["task_id"],
        )
        return None

    tier = model_policy.select_model_tier(task)
    routed_attempts = con.execute(
        """SELECT COUNT(*) AS n
           FROM attempts routed
           JOIN tasks routed_task ON routed_task.task_id=routed.task_id
           WHERE routed_task.root_id=? AND routed_task.parent_task_id IS NOT NULL""",
        (run["root_id"],),
    ).fetchone()["n"]
    profile_name = model_policy.select_profile(
        run,
        task,
        routing_index=routed_attempts,
    )
    model_name = model_policy.resolve_model(
        run,
        tier,
        profile_name=profile_name,
    )
    execution = execution_config.snapshot_attempt(
        run,
        model=model_name,
        model_tier=tier,
        profile_hint=profile_name,
        routing_index=routed_attempts,
    )
    backend_id = execution["backend"]
    agent_type = execution["agent"]
    created = state_store.now()
    encoded_config = json.dumps(execution, ensure_ascii=False, sort_keys=True)
    cursor = con.execute(
        """INSERT INTO attempts(
             task_id, attempt_no, state, actor_token_hash, backend_id, agent_type,
             model_tier, model_name, config_json, heartbeat_at, created_at
           ) VALUES (?, ?, 'assigned', 'pending', ?, ?, ?, ?, ?, ?, ?)""",
        (
            task["task_id"],
            attempt_no,
            backend_id,
            agent_type,
            tier,
            model_name,
            encoded_config,
            created,
            created,
        ),
    )
    attempt_id = cursor.lastrowid
    actor_token = execution_secrets.derive_attempt_token(run, attempt_id)
    con.execute(
        "UPDATE attempts SET actor_token_hash=? WHERE attempt_id=?",
        (state_store.hash_token(actor_token), attempt_id),
    )
    session_name = "agents-orchestrator-%s-%s-%d" % (
        run["root_id"].replace("root_", "")[:8],
        task["task_id"],
        attempt_no,
    )
    cursor = con.execute(
        """INSERT INTO launches(
             attempt_id, launch_no, session_name, status, prompt_state,
             created_at, last_event_at
           ) VALUES (?, 1, ?, 'starting', 'pending', ?, ?)""",
        (attempt_id, session_name, created, created),
    )
    launch_id = cursor.lastrowid
    con.execute("UPDATE tasks SET status='assigned' WHERE task_id=?", (task["task_id"],))
    payload = {
        "root_id": run["root_id"],
        "task_id": task["task_id"],
        "attempt_id": attempt_id,
        "launch_id": launch_id,
        "backend_id": backend_id,
    }
    con.execute(
        """INSERT OR IGNORE INTO effects(
             root_id, attempt_id, launch_id, effect_type, payload_json,
             idempotency_key, status, attempts, created_at
           ) VALUES (?, ?, ?, 'spawn_agent', ?, ?, 'pending', 0, ?)""",
        (
            run["root_id"],
            attempt_id,
            launch_id,
            json.dumps(payload, ensure_ascii=False, sort_keys=True),
            "spawn:%s" % launch_id,
            created,
        ),
    )
    state_store.append_event(
        con, run["root_id"], "AttemptCreated", {"attempt_no": attempt_no},
        task_id=task["task_id"], attempt_id=attempt_id,
    )
    state_store.append_event(
        con, run["root_id"], "AgentSpawnRequested",
        {"session_name": session_name, "launch_id": launch_id},
        task_id=task["task_id"], attempt_id=attempt_id,
    )
    return payload


def schedule_with_connection(con, root_id):
    run = state_store.get_run(root_id, con)
    if run is None or run["status"] != "running":
        return []
    _resolve_dependencies(con, root_id)
    slots = max(0, run["max_concurrent_agents"] - _live_attempt_count(con, root_id))
    if slots <= 0:
        return []
    ready = state_store.fetchall(
        """SELECT * FROM tasks
           WHERE root_id=? AND status='ready' AND task_id != ?
           ORDER BY priority DESC, created_at ASC, delegation_depth ASC, task_id ASC
           LIMIT ?""",
        (root_id, run["root_task_id"], slots),
        con,
    )
    created = []
    for task in ready:
        result = _create_attempt(con, run, task)
        if result:
            created.append(result)
    return created


def schedule(root_id):
    with state_store.transaction() as con:
        return schedule_with_connection(con, root_id)
