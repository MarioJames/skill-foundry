import state_store


def normalize_parent_id(parent_id: str, root_id: str) -> str:
    return root_id if parent_id == "root" else parent_id


def ensure_parent_can_dispatch(parent_id: str, kind: str, round_: int) -> None:
    parent = state_store.get_agent(parent_id)
    if parent and parent.get("status") != "running":
        raise SystemExit(f"parent {parent_id} is {parent['status']} and cannot dispatch")
    if parent and parent.get("kind") in {"review", "fix"}:
        raise SystemExit(f"{parent['kind']} nodes are leaves and cannot dispatch")
    children = state_store.direct_children(parent_id)
    failed = [child["agent_id"] for child in children if child["status"] == "failed"]
    if failed and kind == "implement" and not failed_children_have_recovery_gate(children):
        raise SystemExit(
            f"parent {parent_id} has failed direct children {failed}; "
            "dispatch --kind review to classify the failure, then retry or dispatch fix leaves if needed"
        )
    older_running = [
        child["agent_id"]
        for child in children
        if child["status"] == "running" and child["round"] < round_
    ]
    if older_running:
        raise SystemExit(
            f"parent {parent_id} has running direct children from earlier rounds {older_running}; "
            "await the earlier round before dispatching a later round"
        )


def failed_children_have_recovery_gate(children) -> bool:
    last_failed_index = max(
        (index for index, child in enumerate(children) if child["status"] == "failed"),
        default=None,
    )
    if last_failed_index is None:
        return True

    after_failure = children[last_failed_index + 1:]
    done_review_indices = [
        index
        for index, child in enumerate(after_failure)
        if child["kind"] == "review" and child["status"] == "done"
    ]
    if not done_review_indices:
        return False
    latest = after_failure[-1]
    return latest["kind"] == "review" and latest["status"] == "done"


def ensure_run_can_dispatch(root_id: str) -> None:
    ensure_run_is_running(root_id, "dispatch")


def ensure_run_is_running(root_id: str, action: str) -> None:
    run = state_store.get_run(root_id)
    if not run:
        raise SystemExit(f"run {root_id} does not exist and cannot {action}")
    if run.get("status") != "running":
        raise SystemExit(f"run {root_id} is {run['status']} and cannot {action}")


def normalize_agents(agent_args, task_count: int):
    if not agent_args:
        return [None] * task_count
    if len(agent_args) == 1:
        return agent_args * task_count
    if len(agent_args) != task_count:
        raise SystemExit("--agent must be provided once for all tasks, or once per --task")
    return agent_args


def ensure_parent_can_await(parent_id: str) -> None:
    parent = state_store.get_agent(parent_id)
    if not parent:
        raise SystemExit(f"parent {parent_id} does not exist and cannot await-round")
    if parent.get("status") != "running":
        raise SystemExit(f"parent {parent_id} is {parent['status']} and cannot await-round")


def validate_finish_preconditions(agent_id: str, root_id: str) -> None:
    children = state_store.direct_children(agent_id)
    if not children:
        return
    running = [child["agent_id"] for child in children if child["status"] == "running"]
    if running:
        raise SystemExit(
            f"agent {agent_id} still has running direct children {running}; "
            "call await-round before finish"
        )
    failed = [child["agent_id"] for child in children if child["status"] == "failed"]
    if failed and not failed_children_have_recovery_gate(children):
        raise SystemExit(
            f"agent {agent_id} has failed direct children {failed}; "
            "dispatch --kind review to classify the failure, then retry or dispatch fix leaves if needed"
        )
    latest = children[-1]
    if latest["kind"] != "review" or latest["status"] != "done":
        raise SystemExit(
            f"agent {agent_id} has direct children but the latest child is "
            f"{latest['kind']}:{latest['status']}; dispatch --kind review and await it before finish. "
            "If review reports issues, fan out --kind fix leaves and re-review after fixes."
        )
