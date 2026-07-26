"""Dependency resolution and attempt creation for ready child tasks."""

import json
import uuid

import execution_config
import execution_secrets
import model_policy
import state_store


TERMINAL_TASKS = {"done", "failed", "blocked", "cancelled"}
LIVE_AGENT_STATES = {"received", "evaluating", "active", "waiting"}


def new_id(prefix):
    return "%s_%s" % (prefix, uuid.uuid4().hex[:12])


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


def _live_agent_count(con, root_id):
    marks = ",".join("?" for _ in LIVE_AGENT_STATES)
    params = [root_id] + sorted(LIVE_AGENT_STATES)
    return con.execute(
        "SELECT COUNT(*) AS n FROM agents WHERE root_id=? AND state IN (%s)" % marks,
        params,
    ).fetchone()["n"]


def _create_attempt(con, run, task):
    last_no = con.execute(
        "SELECT COALESCE(MAX(attempt_no), 0) AS n FROM task_attempts WHERE task_id=?",
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

    attempt_id = new_id("attempt")
    agent_id = new_id("agent")
    tier = model_policy.select_model_tier(task)
    model_name = model_policy.resolve_model(run, tier)
    execution = execution_config.snapshot_attempt(run, model=model_name)
    backend_id = execution["backend"]
    agent_key = execution["agent"]
    created = state_store.now()
    session_name = "agent-swarm-%s-%s-%d" % (
        run["root_id"].replace("root_", "")[:8],
        task["task_id"].replace("task_", "")[:8],
        attempt_no,
    )
    actor_token = execution_secrets.derive_attempt_token(run, attempt_id, agent_id)
    con.execute(
        """INSERT INTO task_attempts(
             attempt_id, root_id, task_id, attempt_no, agent_id, status
           ) VALUES (?, ?, ?, ?, ?, 'assigned')""",
        (attempt_id, run["root_id"], task["task_id"], attempt_no, agent_id),
    )
    con.execute(
        """INSERT INTO agents(
             agent_id, root_id, task_id, attempt_id, state, actor_token_hash,
             session_name, backend_id, agent_key, model_tier, model_name,
             heartbeat_at, created_at
           ) VALUES (?, ?, ?, ?, 'received', ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            agent_id,
            run["root_id"],
            task["task_id"],
            attempt_id,
            state_store.hash_token(actor_token),
            session_name,
            backend_id,
            agent_key,
            tier,
            model_name,
            created,
            created,
        ),
    )
    generation = 1
    execution_id = "%s:%s:%d" % (backend_id, attempt_id, generation)
    con.execute(
        """INSERT INTO execution_sessions(
             attempt_id, root_id, backend_id, generation, owner_nonce,
             session_name, execution_id, config_json, agent_key, status,
             prompt_state, created_at, last_event_at
           ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, 'starting', 'pending', ?, ?)""",
        (
            attempt_id,
            run["root_id"],
            backend_id,
            generation,
            session_name,
            execution_id,
            json.dumps(execution, ensure_ascii=False, sort_keys=True),
            agent_key,
            created,
            created,
        ),
    )
    con.execute(
        "UPDATE tasks SET status='assigned', current_attempt_id=? WHERE task_id=?",
        (attempt_id, task["task_id"]),
    )
    payload = {
        "root_id": run["root_id"],
        "task_id": task["task_id"],
        "attempt_id": attempt_id,
        "agent_id": agent_id,
        "backend_id": backend_id,
        "execution_id": execution_id,
        "generation": generation,
        "config_json": json.dumps(execution, ensure_ascii=False, sort_keys=True),
    }
    con.execute(
        """INSERT OR IGNORE INTO side_effect_outbox(
             root_id, effect_type, payload_json, idempotency_key, status, attempts, created_at
           ) VALUES (?, 'spawn_agent', ?, ?, 'pending', 0, ?)""",
        (
            run["root_id"],
            json.dumps(payload, ensure_ascii=False, sort_keys=True),
            "spawn:%s" % attempt_id,
            created,
        ),
    )
    state_store.append_event(
        con, run["root_id"], "AttemptCreated", {"attempt_no": attempt_no},
        task_id=task["task_id"], attempt_id=attempt_id, agent_id=agent_id,
    )
    state_store.append_event(
        con, run["root_id"], "AgentSpawnRequested", {"session_name": session_name},
        task_id=task["task_id"], attempt_id=attempt_id, agent_id=agent_id,
    )
    return payload


def schedule_with_connection(con, root_id):
    run = state_store.get_run(root_id, con)
    if run is None or run["status"] != "running":
        return []
    _resolve_dependencies(con, root_id)
    slots = max(0, run["max_concurrent_agents"] - _live_agent_count(con, root_id))
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
