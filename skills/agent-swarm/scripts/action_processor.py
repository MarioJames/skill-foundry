"""Validation, idempotency, and transactional handling for the five v2 actions."""

import json
import time
import uuid

import hook_manager
import notes
import outbox
import recovery
import scheduler
import state_store


ACTION_TYPES = {"submit_estimate", "create_tasks", "write_note", "wait", "finish"}
OWNER_LEASE_SECONDS = 15 * 60
INTENTS = {"implement", "review", "fix", "research", "design", "integrate"}
COMPLEXITIES = {"low", "medium", "high"}
MODEL_TIERS = {"strong", "balanced", "fast"}
TASK_TERMINAL = {"done", "failed", "blocked", "cancelled"}
WATCHDOG_INTERVAL_SECONDS = 30


class ActionError(RuntimeError):
    pass


def _error(message):
    raise ActionError(message)


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def _require_fields(payload, fields, label):
    missing = [field for field in fields if field not in payload]
    if missing:
        _error("%s requires fields: %s" % (label, ", ".join(missing)))


def _capabilities(context):
    state = context["agent"]["state"]
    if state == "evaluating":
        return ["submit_estimate", "write_note"]
    if state == "waiting":
        return ["write_note", "wait"]
    if state != "active":
        return []
    result = ["submit_estimate", "write_note", "finish"]
    estimate_data = json.loads(context["task"].get("estimate_json") or "{}")
    if estimate_data.get("effective_strategy") == "split":
        result[2:2] = ["create_tasks", "wait"]
    return result


def _load_context(con, envelope, allow_cached=True):
    required = ("root_id", "task_id", "attempt_id", "agent_id", "actor_token", "action_id", "type")
    missing = [name for name in required if not envelope.get(name)]
    if missing:
        _error("missing envelope fields: %s" % ", ".join(missing))
    if envelope.get("schema_version") != 1:
        _error("unsupported action schema_version")
    if envelope["type"] not in ACTION_TYPES:
        _error("unsupported action type")

    run = state_store.get_run(envelope["root_id"], con)
    task = state_store.get_task(envelope["task_id"], con)
    attempt = state_store.get_attempt(envelope["attempt_id"], con)
    agent = state_store.get_agent(envelope["agent_id"], con)
    if not all((run, task, attempt, agent)):
        _error("invalid run/task/attempt/agent binding")
    if not (
        task["root_id"] == run["root_id"]
        and attempt["root_id"] == run["root_id"]
        and attempt["task_id"] == task["task_id"]
        and agent["root_id"] == run["root_id"]
        and agent["task_id"] == task["task_id"]
        and agent["attempt_id"] == attempt["attempt_id"]
        and attempt["agent_id"] == agent["agent_id"]
    ):
        _error("invalid run/task/attempt/agent binding")
    if not state_store.token_matches(envelope["actor_token"], agent["actor_token_hash"]):
        _error("invalid actor token")

    cached = con.execute(
        "SELECT agent_id, response_json FROM processed_actions WHERE root_id=? AND action_id=?",
        (run["root_id"], envelope["action_id"]),
    ).fetchone()
    if cached is not None and allow_cached:
        if cached["agent_id"] != agent["agent_id"]:
            _error("action_id was already used by a different agent")
        return None, json.loads(cached["response_json"])

    if run["status"] != "running":
        _error("run is not running")
    if task["current_attempt_id"] != attempt["attempt_id"]:
        _error("attempt is not the task current attempt")
    if agent["state"] == "terminal":
        _error("agent is terminal")
    if task["task_id"] == run["root_task_id"]:
        if not state_store.token_matches(envelope["actor_token"], run["owner_token_hash"]):
            _error("root owner lease token is invalid")
        if run.get("lease_expires_at") and run["lease_expires_at"] < state_store.now():
            _error("root owner lease expired; recover the run")
        con.execute(
            "UPDATE runs SET lease_expires_at=?, updated_at=? WHERE root_id=?",
            (state_store.now() + OWNER_LEASE_SECONDS, state_store.now(), run["root_id"]),
        )
    capabilities = _capabilities({"run": run, "task": task, "attempt": attempt, "agent": agent})
    if envelope["type"] not in capabilities:
        _error("action %s is not an available capability in state %s" % (envelope["type"], agent["state"]))
    con.execute(
        "UPDATE agents SET heartbeat_at=? WHERE agent_id=?",
        (state_store.now(), agent["agent_id"]),
    )
    agent["heartbeat_at"] = state_store.now()
    return {"run": run, "task": task, "attempt": attempt, "agent": agent}, None


def _record_response(con, context, envelope, response):
    con.execute(
        """INSERT INTO processed_actions(
             root_id, action_id, agent_id, response_json, processed_at
           ) VALUES (?, ?, ?, ?, ?)""",
        (
            context["run"]["root_id"],
            envelope["action_id"],
            context["agent"]["agent_id"],
            _json(response),
            state_store.now(),
        ),
    )


def _estimate(con, context, payload, action_id):
    task = context["task"]
    agent = context["agent"]
    run = context["run"]
    _require_fields(
        payload,
        (
            "revision",
            "strategy",
            "resolved_intent",
            "complexity",
            "concerns",
            "unknowns",
            "estimated_files",
            "reason",
        ),
        "submit_estimate",
    )
    if not isinstance(payload["revision"], bool):
        _error("estimate revision must be boolean")
    revision = payload["revision"]
    strategy = payload.get("strategy")
    if strategy not in {"direct", "split"}:
        _error("estimate strategy must be direct or split")
    if payload.get("complexity") not in COMPLEXITIES:
        _error("estimate complexity must be low, medium, or high")
    if not isinstance(payload["concerns"], list) or not isinstance(payload["unknowns"], list):
        _error("estimate concerns and unknowns must be arrays")
    if not isinstance(payload["estimated_files"], list) or not all(
        isinstance(path, str) for path in payload["estimated_files"]
    ):
        _error("estimate estimated_files must be an array of paths")
    if not isinstance(payload.get("reason"), str) or not payload["reason"].strip():
        _error("estimate reason is required")

    if agent["state"] == "evaluating":
        if revision:
            _error("first estimate cannot be a revision")
        supplied_intent = payload.get("resolved_intent")
        if supplied_intent not in INTENTS:
            _error("resolved_intent is required and must be supported")
        if task.get("resolved_intent") and supplied_intent != task["resolved_intent"]:
            _error("resolved_intent cannot change across attempts for the same task")
        resolved_intent = task.get("resolved_intent") or supplied_intent
    else:
        if not revision:
            _error("active agent must mark estimate revision=true")
        resolved_intent = task.get("resolved_intent")
        supplied = payload["resolved_intent"]
        if supplied != resolved_intent:
            _error("resolved_intent cannot change after the first estimate")
        if task["replan_count"] >= run["max_replans_per_task"]:
            _error("max_replans_per_task exhausted")
        con.execute(
            "UPDATE tasks SET replan_count=replan_count+1 WHERE task_id=?", (task["task_id"],)
        )
        task["replan_count"] += 1

    effective = strategy
    forced_reason = None
    task_count = con.execute(
        "SELECT COUNT(*) AS n FROM tasks WHERE root_id=?", (run["root_id"],)
    ).fetchone()["n"]
    if strategy == "split" and task["delegation_depth"] >= run["max_delegation_depth"]:
        effective = "forced_direct"
        forced_reason = "delegation_depth_limit"
    elif strategy == "split" and task_count >= run["max_total_tasks"]:
        effective = "forced_direct"
        forced_reason = "task_budget_exhausted"
    elif strategy == "split" and run["max_concurrent_agents"] <= 1:
        effective = "forced_direct"
        forced_reason = "concurrency_limit"

    stored = dict(payload)
    stored["resolved_intent"] = resolved_intent
    stored["effective_strategy"] = "direct" if effective == "forced_direct" else effective
    con.execute(
        """UPDATE tasks
           SET resolved_intent=?, estimate_json=?
           WHERE task_id=?""",
        (resolved_intent, _json(stored), task["task_id"]),
    )
    con.execute("UPDATE agents SET state='active' WHERE agent_id=?", (agent["agent_id"],))
    task["resolved_intent"] = resolved_intent
    task["estimate_json"] = _json(stored)
    agent["state"] = "active"
    state_store.append_event(
        con,
        run["root_id"],
        "EstimateSubmitted",
        {"strategy": effective, "revision": revision, "complexity": payload["complexity"]},
        task_id=task["task_id"],
        attempt_id=context["attempt"]["attempt_id"],
        agent_id=agent["agent_id"],
        action_id=action_id,
    )
    capabilities = _capabilities(context)
    response = {
        "accepted": True,
        "state": "active",
        "strategy": effective,
        "capabilities": capabilities,
        "budget": {
            "remaining_tasks": max(0, run["max_total_tasks"] - task_count),
            "max_attempts_for_current_task": run["max_attempts_per_task"],
            "remaining_delegation_depth": max(
                0, run["max_delegation_depth"] - task["delegation_depth"]
            ),
        },
        "next_action": (
            "implement_critical_scope_and_report_caveats"
            if effective == "forced_direct"
            else ("create_tasks_or_execute" if effective == "split" else "execute_task")
        ),
    }
    if forced_reason:
        response["reason"] = forced_reason
    return response


def _static_prefix(pattern):
    value = pattern.replace("\\", "/").strip()
    if not value or value.startswith("/") or value == ".." or value.startswith("../") or "/../" in value:
        _error("write_scope paths must be relative and cannot traverse parents")
    wildcard = len(value)
    for marker in ("*", "?", "["):
        position = value.find(marker)
        if position >= 0:
            wildcard = min(wildcard, position)
    return value[:wildcard].rstrip("/"), wildcard < len(value)


def _scope_contains(parent_pattern, child_pattern):
    import pathlib

    parent = parent_pattern.replace("\\", "/").strip()
    child = child_pattern.replace("\\", "/").strip()
    _static_prefix(parent)
    _static_prefix(child)
    markers = ("*", "?", "[")
    parent_has_glob = any(marker in parent for marker in markers)
    child_has_glob = any(marker in child for marker in markers)
    if not parent_has_glob:
        return child == parent
    if parent in {"**", "**/*"}:
        return True
    if parent.endswith("/**") and not any(marker in parent[:-3] for marker in markers):
        prefix = parent[:-3].rstrip("/")
        child_prefix = _static_prefix(child)[0]
        return child_prefix == prefix or child_prefix.startswith(prefix + "/")
    if child_has_glob:
        return child == parent
    return pathlib.PurePosixPath(child).match(parent)


def _validate_constraints(parent, child):
    if not isinstance(child, dict):
        _error("task constraints must be an object")
    write_scope = child.get("write_scope", [])
    if not isinstance(write_scope, list) or not all(isinstance(path, str) for path in write_scope):
        _error("constraints.write_scope must be an array of paths")
    if not isinstance(child.get("read_only", False), bool):
        _error("constraints.read_only must be boolean")
    if not isinstance(child.get("notes", []), list):
        _error("constraints.notes must be an array")
    for child_pattern in write_scope:
        _static_prefix(child_pattern)
    parent_scope = parent.get("write_scope") or []
    if parent_scope and write_scope:
        for child_pattern in write_scope:
            if not any(_scope_contains(parent_pattern, child_pattern) for parent_pattern in parent_scope):
                _error("child write_scope exceeds parent write_scope")


def _detect_cycle(keys, dependency_keys):
    visiting = set()
    visited = set()

    def visit(key):
        if key in visiting:
            _error("task dependency graph contains a cycle")
        if key in visited:
            return
        visiting.add(key)
        for dependency in dependency_keys.get(key, []):
            if dependency in keys:
                visit(dependency)
        visiting.remove(key)
        visited.add(key)

    for key in keys:
        visit(key)


def _create_tasks(con, context, payload, action_id):
    specs = payload.get("tasks")
    if not isinstance(specs, list) or not specs:
        _error("create_tasks requires a non-empty tasks array")
    run = context["run"]
    parent = context["task"]
    if len(specs) > min(12, run["max_children_per_action"]):
        _error("max_children_per_action exceeded")
    existing_count = con.execute(
        "SELECT COUNT(*) AS n FROM tasks WHERE root_id=?", (run["root_id"],)
    ).fetchone()["n"]
    if existing_count + len(specs) > run["max_total_tasks"]:
        _error("max_total_tasks exceeded")
    if parent["delegation_depth"] >= run["max_delegation_depth"]:
        _error("delegation_depth_limit")
    prior_children = con.execute(
        "SELECT COUNT(*) AS n FROM tasks WHERE parent_task_id=?", (parent["task_id"],)
    ).fetchone()["n"]
    if prior_children:
        if parent["replan_count"] >= run["max_replans_per_task"]:
            _error("max_replans_per_task exhausted")
        con.execute(
            "UPDATE tasks SET replan_count=replan_count+1 WHERE task_id=?", (parent["task_id"],)
        )

    keys = [spec.get("key") if isinstance(spec, dict) else None for spec in specs]
    if any(not isinstance(key, str) or not key.strip() for key in keys) or len(set(keys)) != len(keys):
        _error("task keys must be non-empty and unique within the action")
    parent_constraints = json.loads(parent.get("constraints_json") or "{}")
    ids = {key: "task_%s" % uuid.uuid4().hex[:12] for key in keys}
    dependency_keys = {}
    normalized = []
    for spec in specs:
        goal = spec.get("goal")
        if not isinstance(goal, str) or not goal.strip():
            _error("child task goal is required")
        output_contract = spec.get("output_contract")
        if not isinstance(output_contract, str) or not output_contract.strip():
            _error("child task output_contract is required")
        intent = spec.get("intent_hint")
        if intent not in INTENTS:
            _error("invalid child intent_hint")
        complexity = spec.get("complexity_hint", "medium")
        if complexity not in COMPLEXITIES:
            _error("invalid child complexity_hint")
        tier = spec.get("model_tier_hint")
        if tier is not None and tier not in MODEL_TIERS:
            _error("invalid child model_tier_hint")
        priority = spec.get("priority", 50)
        if isinstance(priority, bool) or not isinstance(priority, int) or not 0 <= priority <= 100:
            _error("child priority must be an integer in 0..100")
        constraints = spec.get("constraints")
        if constraints is None:
            constraints = {"write_scope": [], "read_only": False, "notes": []}
        _validate_constraints(parent_constraints, constraints)
        dependencies = spec.get("depends_on", [])
        if not isinstance(dependencies, list):
            _error("depends_on must be an array")
        resolved_dependencies = []
        new_refs = []
        seen_dependency_ids = set()
        for dependency in dependencies:
            if not isinstance(dependency, dict):
                _error("dependency must be an object")
            task_key = dependency.get("task_key")
            task_id_reference = dependency.get("task_id")
            if bool(task_key) == bool(task_id_reference):
                _error("dependency must provide exactly one of task_key or task_id")
            condition = dependency.get("condition", "success")
            if condition not in {"success", "terminal"}:
                _error("dependency condition must be success or terminal")
            if task_key:
                if not isinstance(task_key, str) or task_key not in ids:
                    _error("dependency task_key must reference this action")
                dependency_id = ids[task_key]
                new_refs.append(task_key)
            else:
                if not isinstance(task_id_reference, str) or not task_id_reference:
                    _error("dependency task_id must be a non-empty string")
                dependency_id = task_id_reference
                existing = state_store.get_task(dependency_id, con) if dependency_id else None
                if existing is None or existing["root_id"] != run["root_id"]:
                    _error("dependency must reference this action or an existing task in the run")
            if dependency_id == ids[spec["key"]]:
                _error("task cannot depend on itself")
            if dependency_id in seen_dependency_ids:
                _error("duplicate dependency for child task")
            seen_dependency_ids.add(dependency_id)
            resolved_dependencies.append((dependency_id, condition))
        dependency_keys[spec["key"]] = new_refs
        normalized.append((spec, constraints, resolved_dependencies))
    _detect_cycle(set(keys), dependency_keys)

    created_at = state_store.now()
    response_tasks = []
    for index, (spec, constraints, dependencies) in enumerate(normalized):
        task_id = ids[spec["key"]]
        task_created_at = created_at + index * 0.000001
        con.execute(
            """INSERT INTO tasks(
                 task_id, root_id, parent_task_id, goal, intent_hint, status, priority,
                 complexity_hint, model_tier_hint, output_contract, constraints_json,
                 delegation_depth, replan_count, created_at
               ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, 0, ?)""",
            (
                task_id,
                run["root_id"],
                parent["task_id"],
                spec["goal"].strip(),
                spec["intent_hint"],
                spec.get("priority", 50),
                spec.get("complexity_hint", "medium"),
                spec.get("model_tier_hint"),
                spec["output_contract"].strip(),
                _json(constraints),
                parent["delegation_depth"] + 1,
                task_created_at,
            ),
        )
        state_store.append_event(
            con,
            run["root_id"],
            "TaskCreated",
            {"key": spec["key"], "intent_hint": spec["intent_hint"]},
            task_id=task_id,
            agent_id=context["agent"]["agent_id"],
            action_id=action_id,
        )
        response_tasks.append({"key": spec["key"], "task_id": task_id})
    for spec, constraints, dependencies in normalized:
        del constraints
        task_id = ids[spec["key"]]
        for dependency_id, condition in dependencies:
            con.execute(
                "INSERT INTO task_dependencies(task_id, depends_on_task_id, condition) VALUES (?, ?, ?)",
                (task_id, dependency_id, condition),
            )
    scheduler.schedule_with_connection(con, run["root_id"])
    state_store.append_event(
        con,
        run["root_id"],
        "ChildTasksCreated",
        {"task_ids": [item["task_id"] for item in response_tasks]},
        task_id=parent["task_id"],
        attempt_id=context["attempt"]["attempt_id"],
        agent_id=context["agent"]["agent_id"],
        action_id=action_id,
    )
    return {"accepted": True, "tasks": response_tasks}


def _write_note(con, context, payload, action_id):
    try:
        note_id = notes.write_note(con, context, payload)
    except ValueError as exc:
        _error(str(exc))
    state_store.append_event(
        con,
        context["run"]["root_id"],
        "NoteWritten",
        {"note_id": note_id, "category": payload.get("category")},
        task_id=context["task"]["task_id"],
        attempt_id=context["attempt"]["attempt_id"],
        agent_id=context["agent"]["agent_id"],
        action_id=action_id,
    )
    return {"accepted": True, "note_id": note_id}


def _validate_done_payload(con, context, payload):
    summary = payload.get("summary")
    changed_files = payload.get("changed_files")
    caveats = payload.get("caveats")
    if not isinstance(summary, str) or not summary.strip():
        _error("finish summary is required")
    if not isinstance(changed_files, list) or not all(isinstance(path, str) for path in changed_files):
        _error("finish changed_files must be an array")
    for path in changed_files:
        _static_prefix(path)
    if not isinstance(caveats, list):
        _error("finish caveats must be an array")
    validation = payload.get("validation")
    if changed_files:
        if not isinstance(validation, dict) or validation.get("status") not in {"passed", "skipped"}:
            _error("changed files require validation with passed or skipped status")
        if validation.get("status") == "skipped" and not str(validation.get("reason") or "").strip():
            _error("skipped validation requires a reason")

    children = state_store.fetchall(
        "SELECT * FROM tasks WHERE parent_task_id=? ORDER BY created_at",
        (context["task"]["task_id"],),
        con,
    )
    unfinished = [child for child in children if child["status"] != "cancelled" and child["status"] != "done"]
    if unfinished:
        _error("all non-cancelled direct child tasks must be done before finish")
    if children:
        integration = payload.get("integration_check")
        if not isinstance(integration, dict) or not integration.get("status") or not str(integration.get("summary") or "").strip():
            _error("tasks with children require integration_check.status and integration_check.summary")

    review = payload.get("review")
    if context["task"].get("resolved_intent") == "review":
        if not isinstance(review, dict) or review.get("status") not in {"pass", "changes_requested", "blocked"}:
            _error("review task requires structured review.status")
        if not isinstance(review.get("findings"), list):
            _error("review task requires review.findings array")

    root_task = context["task"]["task_id"] == context["run"]["root_task_id"]
    if root_task and context["run"]["require_final_review"]:
        changed_anywhere = bool(changed_files)
        for row in state_store.fetchall(
            "SELECT result_json FROM task_attempts WHERE root_id=? AND result_json IS NOT NULL",
            (context["run"]["root_id"],),
            con,
        ):
            result = json.loads(row["result_json"])
            if result.get("changed_files"):
                changed_anywhere = True
                break
        if changed_anywhere:
            if not isinstance(review, dict) or review.get("status") not in {"pass", "changes_requested", "blocked"}:
                _error("root final review is required because the run changed files")
            if not isinstance(review.get("findings"), list):
                _error("root final review findings must be an array")

    if isinstance(review, dict):
        source = review.get("source")
        if isinstance(source, str) and source.startswith("task_"):
            source_task = state_store.get_task(source, con)
            if (
                source_task is None
                or source_task["root_id"] != context["run"]["root_id"]
                or source_task["status"] != "done"
                or source_task.get("resolved_intent") != "review"
            ):
                _error("review source task must be a done review task in this run")
    return children


def _path_in_scope(path, patterns):
    if not patterns:
        return True
    normalized = path.replace("\\", "/")
    return any(_scope_contains(pattern, normalized) for pattern in patterns)


def _finish(con, context, payload, action_id):
    status = payload.get("status")
    if status not in {"done", "failed"}:
        _error("finish status must be done or failed")
    if not isinstance(payload.get("summary"), str) or not payload["summary"].strip():
        _error("finish summary is required")
    if "caveats" not in payload or not isinstance(payload.get("caveats"), list):
        _error("finish caveats must be an array")
    if "retryable" in payload and not isinstance(payload["retryable"], bool):
        _error("finish retryable must be boolean")
    if "changed_files" in payload and (
        not isinstance(payload["changed_files"], list)
        or not all(isinstance(path, str) for path in payload["changed_files"])
    ):
        _error("finish changed_files must be an array")
    if "artifacts" in payload and not isinstance(payload["artifacts"], list):
        _error("finish artifacts must be an array")
    for field in ("validation", "review", "integration_check"):
        if field in payload and payload[field] is not None and not isinstance(payload[field], dict):
            _error("finish %s must be an object or null" % field)
    if status == "failed" and not isinstance(payload.get("retryable"), bool):
        _error("failed finish requires boolean retryable")
    run = context["run"]
    task = context["task"]
    attempt = context["attempt"]
    agent = context["agent"]
    finished = state_store.now()
    warnings = []

    if status == "done":
        _validate_done_payload(con, context, payload)
        changed_files = payload.get("changed_files", [])
        constraints = json.loads(task.get("constraints_json") or "{}")
        scope = constraints.get("write_scope") or []
        outside = [path for path in changed_files if not _path_in_scope(path, scope)]
        if outside:
            warnings.append("reported changed_files outside write_scope: %s" % ", ".join(outside))
        if task.get("resolved_intent") == "review" and changed_files:
            warnings.append("review task reported changed_files")
        for warning in warnings:
            state_store.append_event(
                con, run["root_id"], "ScopeWarning", {"warning": warning},
                task_id=task["task_id"], attempt_id=attempt["attempt_id"],
                agent_id=agent["agent_id"], action_id=action_id,
            )
        con.execute(
            "UPDATE task_attempts SET status='done', retryable=0, result_json=?, finished_at=? WHERE attempt_id=?",
            (_json(payload), finished, attempt["attempt_id"]),
        )
        con.execute(
            "UPDATE agents SET state='terminal', finished_at=? WHERE agent_id=?",
            (finished, agent["agent_id"]),
        )
        con.execute(
            "UPDATE tasks SET status='done', finished_at=? WHERE task_id=?",
            (finished, task["task_id"]),
        )
        state_store.append_event(
            con, run["root_id"], "AttemptFinished", {"status": "done"},
            task_id=task["task_id"], attempt_id=attempt["attempt_id"],
            agent_id=agent["agent_id"], action_id=action_id,
        )
        state_store.append_event(
            con, run["root_id"], "TaskFinished", {"summary": payload["summary"]},
            task_id=task["task_id"], attempt_id=attempt["attempt_id"],
            agent_id=agent["agent_id"], action_id=action_id,
        )
        retry_scheduled = False
        if task["task_id"] == run["root_task_id"]:
            remaining = con.execute(
                """SELECT COUNT(*) AS n FROM tasks
                   WHERE root_id=? AND status NOT IN ('done', 'cancelled')""",
                (run["root_id"],),
            ).fetchone()["n"]
            live = con.execute(
                "SELECT COUNT(*) AS n FROM task_attempts WHERE root_id=? AND status IN ('assigned','running')",
                (run["root_id"],),
            ).fetchone()["n"]
            effects = con.execute(
                """SELECT COUNT(*) AS n FROM side_effect_outbox
                   WHERE root_id=? AND effect_type IN ('spawn_agent','stop_agent')
                     AND status IN ('pending','running')""",
                (run["root_id"],),
            ).fetchone()["n"]
            if remaining or live or effects:
                _error("root closeout requires all tasks done and no live attempts or pending effects")
            con.execute(
                "UPDATE runs SET status='done', finished_at=?, updated_at=? WHERE root_id=?",
                (finished, finished, run["root_id"]),
            )
            state_store.append_event(con, run["root_id"], "RunFinished", action_id=action_id)
            run_status = "done"
        else:
            scheduler.schedule_with_connection(con, run["root_id"])
            run_status = "running"
    else:
        retryable = payload.get("retryable") is True
        con.execute(
            "UPDATE task_attempts SET status='failed', retryable=?, result_json=?, finished_at=? WHERE attempt_id=?",
            (1 if retryable else 0, _json(payload), finished, attempt["attempt_id"]),
        )
        con.execute(
            "UPDATE agents SET state='terminal', finished_at=? WHERE agent_id=?",
            (finished, agent["agent_id"]),
        )
        if task["task_id"] == run["root_task_id"]:
            con.execute(
                "UPDATE tasks SET status='failed', finished_at=? WHERE task_id=?", (finished, task["task_id"])
            )
            con.execute(
                "UPDATE runs SET status='failed', finished_at=?, updated_at=? WHERE root_id=?",
                (finished, finished, run["root_id"]),
            )
            state_store.append_event(con, run["root_id"], "RunFailed", {"summary": payload["summary"]})
            retry_scheduled = False
            run_status = "failed"
        elif retryable and attempt["attempt_no"] < run["max_attempts_per_task"]:
            con.execute(
                "UPDATE tasks SET status='ready', finished_at=NULL WHERE task_id=?", (task["task_id"],)
            )
            state_store.append_event(
                con, run["root_id"], "TaskRetryScheduled", {"previous_attempt": attempt["attempt_id"]},
                task_id=task["task_id"], attempt_id=attempt["attempt_id"], agent_id=agent["agent_id"],
            )
            scheduler.schedule_with_connection(con, run["root_id"])
            retry_scheduled = True
            run_status = "running"
        else:
            con.execute(
                "UPDATE tasks SET status='failed', finished_at=? WHERE task_id=?", (finished, task["task_id"])
            )
            state_store.append_event(
                con, run["root_id"], "TaskFailed", {"summary": payload["summary"]},
                task_id=task["task_id"], attempt_id=attempt["attempt_id"], agent_id=agent["agent_id"],
            )
            scheduler.schedule_with_connection(con, run["root_id"])
            retry_scheduled = False
            run_status = "running"
        state_store.append_event(
            con, run["root_id"], "AttemptFinished", {"status": "failed", "retryable": retryable},
            task_id=task["task_id"], attempt_id=attempt["attempt_id"],
            agent_id=agent["agent_id"], action_id=action_id,
        )

    return {
        "accepted": True,
        "status": status,
        "task_id": task["task_id"],
        "attempt_id": attempt["attempt_id"],
        "retry_scheduled": retry_scheduled,
        "run_status": run_status,
        "warnings": warnings,
    }


def _task_summaries(con, root_id, task_ids):
    summaries = []
    for task_id in task_ids:
        task = state_store.get_task(task_id, con)
        attempt = state_store.get_attempt(task.get("current_attempt_id"), con) if task else None
        result = json.loads(attempt["result_json"]) if attempt and attempt.get("result_json") else None
        summaries.append(
            {
                "task_id": task_id,
                "status": task["status"],
                "result": result,
                "reason": (
                    "required_dependency_failed"
                    if task["status"] == "blocked"
                    else (
                        result.get("summary")
                        if isinstance(result, dict) and task["status"] == "failed"
                        else ("run_cancelled" if task["status"] == "cancelled" else None)
                    )
                ),
            }
        )
    return summaries


def _condition_met(condition, summaries):
    statuses = [item["status"] for item in summaries]
    if condition == "all_done":
        return all(status == "done" for status in statuses)
    if condition == "all_terminal":
        return all(status in TASK_TERMINAL for status in statuses)
    if condition == "any_failed":
        return any(status in {"failed", "blocked"} for status in statuses)
    _error("wait condition must be all_done, all_terminal, or any_failed")


def _run_root_watchdog(context, actor_token):
    if context["task"]["task_id"] != context["run"]["root_task_id"]:
        return None
    try:
        report = dict(recovery.reap_children(context["run"]["root_id"], actor_token))
        report["side_effects"] = outbox.drain(context["run"]["root_id"])
        return report
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _wait(envelope, poll_interval):
    payload = envelope.get("payload") or {}
    _require_fields(payload, ("task_ids", "condition", "listen_seconds"), "wait")
    task_ids = payload.get("task_ids")
    condition = payload.get("condition")
    listen_seconds = payload.get("listen_seconds")
    if not isinstance(task_ids, list) or not task_ids or not all(isinstance(item, str) for item in task_ids):
        _error("wait task_ids must be a non-empty array")
    if condition not in {"all_done", "all_terminal", "any_failed"}:
        _error("wait condition must be all_done, all_terminal, or any_failed")
    if (
        isinstance(listen_seconds, bool)
        or not isinstance(listen_seconds, (int, float))
        or listen_seconds < 0
        or listen_seconds > 300
    ):
        _error("listen_seconds must be in 0..300")

    with state_store.transaction() as con:
        context, cached = _load_context(con, envelope)
        if cached is not None:
            return cached
        for task_id in task_ids:
            task = state_store.get_task(task_id, con)
            if task is None or task["root_id"] != context["run"]["root_id"]:
                _error("wait tasks must belong to the current run")
        con.execute("UPDATE agents SET state='waiting' WHERE agent_id=?", (context["agent"]["agent_id"],))
        state_store.append_event(
            con, context["run"]["root_id"], "AgentWaiting", {"task_ids": task_ids, "condition": condition},
            task_id=context["task"]["task_id"], attempt_id=context["attempt"]["attempt_id"],
            agent_id=context["agent"]["agent_id"], action_id=envelope["action_id"],
        )

    watchdog = _run_root_watchdog(context, envelope["actor_token"])
    next_watchdog_at = time.monotonic() + WATCHDOG_INTERVAL_SECONDS
    deadline = time.monotonic() + float(listen_seconds)
    summaries = []
    complete = False
    while True:
        if watchdog is not None and time.monotonic() >= next_watchdog_at:
            watchdog = _run_root_watchdog(context, envelope["actor_token"])
            next_watchdog_at = time.monotonic() + WATCHDOG_INTERVAL_SECONDS
        with state_store.transaction(immediate=False) as con:
            summaries = _task_summaries(con, envelope["root_id"], task_ids)
        complete = _condition_met(condition, summaries)
        if complete or time.monotonic() >= deadline:
            break
        time.sleep(max(0.01, float(poll_interval)))

    with state_store.transaction() as con:
        context, cached = _load_context(con, envelope)
        if cached is not None:
            return cached
        if context["agent"]["state"] != "waiting":
            _error("waiting agent state changed unexpectedly")
        con.execute(
            "UPDATE agents SET state='active', heartbeat_at=? WHERE agent_id=?",
            (state_store.now(), context["agent"]["agent_id"]),
        )
        response = {
            "complete": complete,
            "still_waiting": not complete,
            "tasks": summaries,
        }
        if watchdog is not None:
            response["watchdog"] = watchdog
        state_store.append_event(
            con, context["run"]["root_id"], "AgentResumed", {"complete": complete},
            task_id=context["task"]["task_id"], attempt_id=context["attempt"]["attempt_id"],
            agent_id=context["agent"]["agent_id"], action_id=envelope["action_id"],
        )
        _record_response(con, context, envelope, response)
        return response


def _process_action(envelope, poll_interval=0.1):
    if not isinstance(envelope, dict):
        _error("action envelope must be an object")
    if envelope.get("type") == "wait":
        return _wait(envelope, poll_interval)
    payload = envelope.get("payload")
    if not isinstance(payload, dict):
        _error("action payload must be an object")
    cleanup_cwd = None
    with state_store.transaction() as con:
        context, cached = _load_context(con, envelope)
        if cached is not None:
            response = cached
            if response.get("run_status") == "done":
                run = state_store.get_run(envelope["root_id"], con)
                cleanup_cwd = run["cwd"] if run else None
        else:
            action_type = envelope["type"]
            if action_type == "submit_estimate":
                response = _estimate(con, context, payload, envelope["action_id"])
            elif action_type == "create_tasks":
                response = _create_tasks(con, context, payload, envelope["action_id"])
            elif action_type == "write_note":
                response = _write_note(con, context, payload, envelope["action_id"])
            elif action_type == "finish":
                response = _finish(con, context, payload, envelope["action_id"])
            else:
                _error("unsupported action type")
            _record_response(con, context, envelope, response)
            if action_type == "finish" and response.get("run_status") == "done":
                cleanup_cwd = context["run"]["cwd"]
    if cleanup_cwd:
        try:
            hook_manager.cleanup_project_hooks(cleanup_cwd, root_id=envelope["root_id"])
        except Exception as exc:
            with state_store.transaction() as con:
                state_store.append_event(
                    con,
                    envelope["root_id"],
                    "HookCleanupFailed",
                    {"error": str(exc)},
                    action_id=envelope["action_id"],
                )
    return response


def _audit_rejection(envelope, message):
    """Audit only authenticated rejections; invalid tokens must not create trusted events."""
    try:
        with state_store.transaction() as con:
            run = state_store.get_run(envelope.get("root_id"), con)
            agent = state_store.get_agent(envelope.get("agent_id"), con)
            if (
                run is None
                or agent is None
                or agent["root_id"] != run["root_id"]
                or not state_store.token_matches(envelope.get("actor_token"), agent["actor_token_hash"])
            ):
                return
            state_store.append_event(
                con,
                run["root_id"],
                "ActionRejected",
                {"action_type": envelope.get("type"), "reason": message},
                task_id=envelope.get("task_id"),
                attempt_id=envelope.get("attempt_id"),
                agent_id=envelope.get("agent_id"),
                action_id=envelope.get("action_id"),
            )
    except Exception:
        return


def process_action(envelope, poll_interval=0.1):
    try:
        return _process_action(envelope, poll_interval=poll_interval)
    except ActionError as exc:
        if isinstance(envelope, dict):
            _audit_rejection(envelope, str(exc))
        raise
