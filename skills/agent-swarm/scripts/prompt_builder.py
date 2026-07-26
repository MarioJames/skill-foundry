"""Build the deliberately small child-session prompt."""

import json

import notes


def _format_notes(items):
    if not items:
        return "(none)"
    return "\n".join("- [%s] %s" % (item["category"], item["content"]) for item in items)


def _recovery_context(task, attempt, con):
    if con is None or attempt.get("attempt_no", 1) <= 1:
        return ""
    previous = con.execute(
        """SELECT attempt_no, status, result_json FROM task_attempts
           WHERE task_id=? AND attempt_no < ? ORDER BY attempt_no DESC LIMIT 3""",
        (task["task_id"], attempt["attempt_no"]),
    ).fetchall()
    child_rows = con.execute(
        """SELECT child.task_id, child.status, attempt.result_json
           FROM tasks child
           LEFT JOIN task_attempts attempt ON attempt.attempt_id=child.current_attempt_id
           WHERE child.parent_task_id=? ORDER BY child.created_at LIMIT 12""",
        (task["task_id"],),
    ).fetchall()
    facts = []
    for row in previous:
        result = json.loads(row["result_json"]) if row["result_json"] else {}
        facts.append({
            "attempt_no": row["attempt_no"],
            "status": row["status"],
            "summary": result.get("summary"),
            "caveats": result.get("caveats", []),
        })
    children = []
    for row in child_rows:
        result = json.loads(row["result_json"]) if row["result_json"] else {}
        children.append({
            "task_id": row["task_id"], "status": row["status"], "summary": result.get("summary")
        })
    payload = {"previous_attempts": facts, "child_results": children}
    return "\n[RECOVERY CONTEXT]\n%s\n" % json.dumps(payload, ensure_ascii=False, sort_keys=True)


def build_prompt(run, task, attempt, agent, con=None):
    constraints = json.loads(task.get("constraints_json") or "{}")
    execution = json.loads(run.get("execution_json") or "{}")
    if execution.get("backend") == "acp":
        skill_guidance = (
            "The complete required Runtime protocol is included below. Use"
        )
        action_guidance = """
For every Runtime Action, use exactly this single-line form (encode apostrophes
inside JSON strings as \\u0027 so the JSON remains one single-quoted shell literal):
`printf '%s' '<JSON object>' | python3 "$AGENT_SWARM_SKILL_DIR/scripts/agent_orchestrator.py" action --type <ACTION_TYPE> --stdin`
To inspect an Action schema, use exactly:
`python3 "$AGENT_SWARM_SKILL_DIR/scripts/agent_orchestrator.py" action-schema <ACTION_TYPE>`
""".strip()
    else:
        skill_guidance = (
            'Before substantial work, read\n"$AGENT_SWARM_SKILL_DIR/SKILL.md" and use'
        )
        action_guidance = ""
    selected = notes.select_notes(run["root_id"], task["task_id"], con=con)
    remaining_depth = max(0, run["max_delegation_depth"] - task["delegation_depth"])
    if con is not None:
        used_tasks = con.execute(
            "SELECT COUNT(*) AS n FROM tasks WHERE root_id = ?", (run["root_id"],)
        ).fetchone()["n"]
    else:
        import state_store

        used_tasks = len(state_store.list_tasks(run["root_id"]))
    remaining_tasks = max(0, run["max_total_tasks"] - used_tasks)
    write_scope = constraints.get("write_scope") or []
    constraint_notes = constraints.get("notes") or []
    recovery_context = _recovery_context(task, attempt, con)
    return """[ORCHESTRATION IDENTITY]
root_id: {root_id}
task_id: {task_id}
attempt_id: {attempt_id}
agent_id: {agent_id}

[TASK]
{goal}

[INTENT]
{intent}

[OUTPUT CONTRACT]
{output_contract}

[CONSTRAINTS]
write_scope: {write_scope}
read_only: {read_only}
notes: {constraint_notes}

[RELEVANT NOTES]
{notes}
{recovery_context}

[RUNTIME]
remaining delegation depth: {remaining_depth}
remaining task budget: {remaining_tasks}
available actions: submit_estimate, write_note

[RUNTIME ENTRYPOINT]
This child session already has the exported AGENT_SWARM_* identity. {skill_guidance}
`python3 "$AGENT_SWARM_SKILL_DIR/scripts/agent_orchestrator.py"` for every Runtime action.
Do not initialize another Run: submit `submit_estimate` through that entrypoint, then
submit `finish` through the same entrypoint after validation.
{action_guidance}

[WORKSPACE BOOTSTRAP]
Before substantial work in the current directory, run:
`python3 "$AGENT_SWARM_SKILL_DIR/scripts/agent_orchestrator.py" bootstrap-cwd`
If you create or enter another Git worktree later, run it again there before doing work. This is
mandatory for every Backend; hook-capable Backends also refresh local hook settings.

[PROTOCOL]
1. Before substantial work, submit an estimate: direct or split.
2. If scope changes materially, revise the estimate before changing strategy.
3. Split only into independent tasks with clear output contracts.
4. Delegate only with create_tasks; never launch an Agent process directly.
5. Use wait when child results are required.
6. Record only reusable decisions or pitfalls.
7. Finish with changed files, validation, integration summary, and caveats.
8. Use action-schema for exact JSON shapes.
""".format(
        root_id=run["root_id"],
        task_id=task["task_id"],
        attempt_id=attempt["attempt_id"],
        agent_id=agent["agent_id"],
        goal=task["goal"],
        intent=task.get("resolved_intent") or task["intent_hint"],
        output_contract=task.get("output_contract") or "Report the completed result.",
        write_scope=json.dumps(write_scope, ensure_ascii=False),
        read_only=str(bool(constraints.get("read_only"))).lower(),
        constraint_notes=json.dumps(constraint_notes, ensure_ascii=False),
        notes=_format_notes(selected),
        recovery_context=recovery_context,
        skill_guidance=skill_guidance,
        action_guidance=action_guidance,
        remaining_depth=remaining_depth,
        remaining_tasks=remaining_tasks,
    )
