import time

import claude_cli
import state_store
import transcripts

AWAIT_ROUND_MIN_BLOCK_SECONDS = 30
AWAIT_ROUND_MAX_BLOCK_SECONDS = 180
AWAIT_ROUND_DEFAULT_BLOCK_SECONDS = 120
AWAIT_ROUND_DECREMENT_SECONDS = 15
HEARTBEAT_IDLE_TIMEOUT_SECONDS = 600
MISSING_CLAUDE_AGENT_IDLE_TIMEOUT_SECONDS = 180
RECOVERY_IDLE_SECONDS = 60
RECOVERY_BUSY_WORKING_IDLE_SECONDS = 180


def refresh_parent_heartbeat(parent_id: str, root_id: str) -> None:
    state_store.touch_running_agent_by_id(parent_id, root_id=root_id)


def active_agent_ids():
    return {visible_agent_id(item) for item in claude_cli.active_agents()}


def active_agent_map():
    return {
        visible_agent_id(item): item
        for item in claude_cli.active_agents()
        if visible_agent_id(item)
    }


def visible_agent_id(item):
    if not isinstance(item, dict):
        return None
    return item.get("id") or item.get("jobId") or item.get("job_id")


def cleanup_visible_job(job_id, eng, active_ids=None) -> bool:
    if not job_id or eng != "claude":
        return False
    ids = active_ids if active_ids is not None else active_agent_ids()
    if job_id not in ids:
        return False
    claude_cli.stop(job_id, eng)
    claude_cli.rm(job_id, eng)
    return True


def reap_terminal_visible_jobs(root_id: str, eng: str):
    reaped = []
    active_ids = active_agent_ids()
    for job in state_store.recorded_jobs(root_id):
        if job.get("status") == "running":
            continue
        job_engine = job.get("engine") or eng
        if cleanup_visible_job(job.get("job_id"), job_engine, active_ids):
            reaped.append(job["job_id"])
    return reaped


def stop_completed_round_jobs(parent_id: str, root_id: str, round_: int, eng: str):
    stopped = []
    active_ids = active_agent_ids()
    for child in state_store.round_children(parent_id, round_):
        if child["status"] == "running":
            continue
        job_id = child.get("job_id")
        if not job_id:
            continue
        child_engine = child.get("engine") or eng
        if child_engine != "claude":
            continue
        if job_id in active_ids:
            claude_cli.stop(job_id, child_engine)
            claude_cli.rm(job_id, child_engine)
            stopped.append(job_id)
    return stopped


def evaluate_round(parent_id, root_id, round_, eng):
    pending = 0
    summary = []
    active_ids = active_agent_ids()
    for child in state_store.round_children(parent_id, round_):
        status = child["status"]
        if status == "running":
            child_engine = child.get("engine") or eng
            state = claude_cli.job_state(child["job_id"], child_engine) if child["job_id"] else None
            missing = fail_missing_claude_child_subtree(
                child,
                root_id,
                child_engine,
                active_ids,
                now_ts=time.time(),
            ) if state is None else []
            if missing:
                status = "failed"
            elif state is not None and claude_cli.is_done(state):
                delegated = resolve_delegated_parent_exit(child, root_id)
                if delegated == "pending":
                    pending += 1
                    fresh = state_store.get_agent(child["agent_id"])
                    summary.append(agent_summary(fresh))
                    continue
                if delegated != "resolved":
                    result = None
                    if isinstance(state.get("output"), dict):
                        result = state["output"].get("result")
                    tail = result or (claude_cli.read_log(child["job_id"], child_engine)[-2000:] if child["job_id"] else "")
                    state_store.fail(child["agent_id"], root_id, f"agent exited without calling finish; tail of log/result: {tail}")
                    cleanup_visible_job(child["job_id"], child_engine, active_ids)
                    status = "failed"
                else:
                    cleanup_visible_job(child["job_id"], child_engine, active_ids)
                    status = state_store.get_agent(child["agent_id"])["status"]
            else:
                pending += 1
                fresh = state_store.get_agent(child["agent_id"])
                summary.append(agent_summary(fresh))
                continue
        else:
            child_engine = child.get("engine") or eng
            cleanup_visible_job(child["job_id"], child_engine, active_ids)
        fresh = state_store.get_agent(child["agent_id"])
        summary.append(agent_summary(fresh))
    return pending == 0, summary


def fail_missing_claude_child_subtree(child, root_id: str, eng: str, active_ids, now_ts=None):
    if eng != "claude":
        return []
    if not child.get("job_id"):
        return []

    running = [
        row
        for row in state_store.subtree_agents(child["agent_id"])
        if row["status"] == "running"
    ]
    if not running:
        return []
    if any((row.get("job_id") in active_ids) for row in running if row.get("job_id")):
        return []

    idle_for = direct_child_subtree_idle_seconds(child["agent_id"], now_ts)
    if idle_for < MISSING_CLAUDE_AGENT_IDLE_TIMEOUT_SECONDS:
        return []

    failed = []
    for row in running:
        job_id = row.get("job_id") or "(missing job id)"
        reason = f"Claude job disappeared while agent was running: {job_id}"
        if state_store.fail_if_running(row["agent_id"], root_id, reason):
            failed.append({
                "agent_id": row["agent_id"],
                "job_id": row.get("job_id"),
                "idle_for": idle_for,
            })
    return failed


def agent_summary(agent):
    return {
        "agent_id": agent["agent_id"],
        "status": agent["status"],
        "result": agent["result"],
        "caveats": agent["caveats"],
    }


def resolve_delegated_parent_exit(agent, root_id: str):
    direct = state_store.direct_children(agent["agent_id"])
    if not direct:
        return None

    descendants = [
        row
        for row in state_store.subtree_agents(agent["agent_id"])
        if row["agent_id"] != agent["agent_id"]
    ]
    if any(row["status"] == "running" for row in descendants):
        return "pending"

    failed_direct = [row for row in direct if row["status"] != "done"]
    if failed_direct:
        detail = "; ".join(f"{row['agent_id']}:{row['status']}" for row in failed_direct)
        state_store.fail(
            agent["agent_id"],
            root_id,
            f"delegated parent session ended before finish; unresolved direct children: {detail}",
        )
        return "resolved"

    result = "; ".join(
        f"{row['agent_id']}:{row['status']} {row.get('result') or ''}".strip()
        for row in direct
    )
    caveats = "synthesized after delegated parent session ended before finish; parent result derived from direct child summaries"
    state_store.finish(agent["agent_id"], root_id, result, caveats)
    return "resolved"


def await_round_blocking(parent_id, root_id, round_, eng, poll=5, max_block=None):
    started_at = time.time()
    block_seconds = effective_await_round_max_block(max_block)
    while True:
        refresh_parent_heartbeat(parent_id, root_id)
        transcript_activity = refresh_round_transcript_activity(parent_id, root_id, round_)
        complete, summary = evaluate_round(parent_id, root_id, round_, eng)
        if complete:
            reaped_jobs = stop_completed_round_jobs(parent_id, root_id, round_, eng)
            return {
                "complete": True,
                "round": round_,
                "children": summary,
                "transcript_activity": transcript_activity,
                "running_count": 0,
                "listen_window": block_seconds,
                "next_listen_window": next_listen_window_seconds(block_seconds),
                "reaped_jobs": reaped_jobs,
            }
        now_ts = time.time()
        timeout = stop_idle_direct_children(parent_id, root_id, round_, eng, now_ts=now_ts)
        if timeout["stopped_jobs"] or timeout["timed_out_agents"]:
            complete, summary = evaluate_round(parent_id, root_id, round_, eng)
            reaped_jobs = stop_completed_round_jobs(parent_id, root_id, round_, eng) if complete else []
            return {
                "complete": complete,
                "round": round_,
                "children": summary,
                "still_waiting": not complete,
                "timed_out": True,
                "idle_timeout": HEARTBEAT_IDLE_TIMEOUT_SECONDS,
                "timed_out_agents": timeout["timed_out_agents"],
                "stopped_jobs": timeout["stopped_jobs"],
                "transcript_activity": transcript_activity,
                "running_count": round_running_agent_count(parent_id, round_),
                "listen_window": block_seconds,
                "next_listen_window": next_listen_window_seconds(block_seconds),
                "reaped_jobs": reaped_jobs,
            }
        elapsed_for = now_ts - started_at
        idle_for = round_idle_seconds(parent_id, round_)
        running_count = round_running_agent_count(parent_id, round_)
        next_window = next_listen_window_seconds(block_seconds)
        if elapsed_for >= block_seconds:
            recovery = recovery_candidates(parent_id, root_id, round_, now_ts=now_ts)
            result = {
                "complete": False,
                "round": round_,
                "children": summary,
                "still_waiting": True,
                "listen_window_expired": True,
                "timed_out": False,
                "idle_for": idle_for,
                "elapsed_for": elapsed_for,
                "running_count": running_count,
                "transcript_activity": transcript_activity,
                "listen_window": block_seconds,
                "next_listen_window": next_listen_window_seconds(block_seconds),
                "stopped_jobs": [],
            }
            result.update(next_action_payload(root_id, parent_id, round_, next_window, recovery))
            return result
        time.sleep(poll)


def await_round_command(root_id, parent_id, round_, max_block):
    return [
        "await-round",
        "--root-id",
        root_id,
        "--parent-id",
        parent_id,
        "--round",
        str(round_),
        "--max-block",
        format_seconds(max_block),
    ]


def format_seconds(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return str(value)
    if number.is_integer():
        return str(int(number))
    return f"{number:g}"


def next_action_payload(root_id, parent_id, round_, next_window, recovery):
    await_cmd = await_round_command(root_id, parent_id, round_, next_window)
    if recovery:
        candidate = recovery[0]
        return {
            "required_next_action": "recover_idle_agent",
            "recovery_candidates": recovery,
            "next_command_after_recovery": await_cmd,
            "next_commands": [
                {
                    "action": "recover_idle_agent",
                    "command": [
                        "recover-idle-agent",
                        "--root-id",
                        root_id,
                        "--agent-id",
                        candidate["agent_id"],
                        "--next-max-block",
                        format_seconds(next_window),
                    ],
                    "job_id": candidate["job_id"],
                    "session_id": candidate["session_id"],
                    "input": "continue",
                    **({"interrupt_first": True} if candidate.get("interrupt_first") else {}),
                },
            ],
        }
    return {
        "required_next_action": "continue_await_round",
        "next_command": await_cmd,
        "next_commands": [{
            "action": "continue_await_round",
            "command": await_cmd,
        }],
    }


def recovery_candidates(parent_id, root_id, round_, now_ts=None, idle_threshold=RECOVERY_IDLE_SECONDS):
    run = state_store.get_run(root_id) or {}
    cwd = run.get("cwd")
    active = active_agent_map()
    candidates = []
    now_ts = time.time() if now_ts is None else now_ts
    for child in state_store.round_children(parent_id, round_):
        if child["status"] != "running":
            continue
        job_id = child.get("job_id")
        session_id = child.get("session_id")
        item = active.get(job_id)
        if not item or item.get("state") != "working":
            continue
        idle_for = direct_child_subtree_idle_seconds(child["agent_id"], now_ts)
        status = item.get("status")
        required_idle = recovery_idle_threshold_for_agent_status(status, idle_threshold)
        if required_idle is None or idle_for < required_idle:
            continue
        signal = transcripts.recovery_signal(session_id, cwd=cwd) if session_id else None
        if not signal:
            continue
        candidates.append({
            "agent_id": child["agent_id"],
            "job_id": job_id,
            "session_id": session_id,
            "idle_for": idle_for,
            "agent_view_status": item.get("status"),
            "agent_view_state": item.get("state"),
            "reason": signal["reason"],
            "suggested_input": "continue",
            "manual_recovery": f"claude agents --cwd {cwd}, open {job_id}, send: continue",
            **({"interrupt_first": True} if status == "busy" else {}),
        })
    return candidates


def recovery_idle_threshold_for_agent_status(status, idle_threshold):
    if status == "idle":
        return idle_threshold
    if status == "busy":
        return max(idle_threshold, RECOVERY_BUSY_WORKING_IDLE_SECONDS)
    return None


def stop_idle_direct_children(parent_id, root_id, round_, eng, idle_timeout=HEARTBEAT_IDLE_TIMEOUT_SECONDS, now_ts=None):
    stopped_jobs = []
    timed_out_agents = []
    now_ts = time.time() if now_ts is None else now_ts
    active_ids = active_agent_ids()
    for child in state_store.round_children(parent_id, round_):
        if child["status"] != "running":
            continue
        idle_for = direct_child_subtree_idle_seconds(child["agent_id"], now_ts)
        if idle_for < idle_timeout:
            continue
        child_engine = child.get("engine") or eng
        job_id = child.get("job_id")
        if job_id and child_engine == "claude" and job_id in active_ids:
            claude_cli.stop(job_id, child_engine)
            stopped_jobs.append(job_id)
        reason = f"heartbeat timeout after {idle_for:.1f}s without direct child subtree activity"
        state_store.fail(child["agent_id"], root_id, reason)
        timed_out_agents.append({
            "agent_id": child["agent_id"],
            "idle_for": idle_for,
            "job_id": job_id,
        })
    return {"stopped_jobs": stopped_jobs, "timed_out_agents": timed_out_agents}


def direct_child_subtree_idle_seconds(child_agent_id, now_ts=None):
    latest = 0.0
    for agent_row in state_store.subtree_agents(child_agent_id):
        if agent_row["status"] != "running":
            continue
        activity = (
            agent_row.get("transcript_latest_at")
            or agent_row.get("last_reported_at")
            or agent_row.get("spawned_at")
            or 0
        )
        latest = max(latest, float(activity))
    if latest <= 0:
        return 0.0
    current = time.time() if now_ts is None else now_ts
    return current - latest


def refresh_round_transcript_activity(parent_id, root_id, round_):
    run = state_store.get_run(root_id) or {}
    cwd = run.get("cwd")
    activity = []
    for child in state_store.round_children(parent_id, round_):
        for agent_row in state_store.subtree_agents(child["agent_id"]):
            if agent_row["status"] != "running" or not agent_row.get("session_id"):
                continue
            latest = transcripts.latest_activity(agent_row["session_id"], cwd=cwd)
            if not latest:
                continue
            updated = state_store.update_transcript_activity(
                agent_row["agent_id"],
                agent_row["root_id"],
                latest["path"],
                latest["latest_at"],
            )
            if updated:
                activity.append(updated)
    return activity


def round_idle_seconds(parent_id, round_) -> float:
    latest = 0.0
    for child in state_store.round_children(parent_id, round_):
        for agent_row in state_store.subtree_agents(child["agent_id"]):
            if agent_row["status"] != "running":
                continue
            activity = (
                agent_row.get("transcript_latest_at")
                or agent_row.get("last_reported_at")
                or agent_row.get("spawned_at")
                or 0
            )
            latest = max(latest, float(activity))
    if latest <= 0:
        return 0.0
    return time.time() - latest


def round_running_agent_count(parent_id, round_) -> int:
    count = 0
    for child in state_store.round_children(parent_id, round_):
        for agent_row in state_store.subtree_agents(child["agent_id"]):
            if agent_row["status"] == "running":
                count += 1
    return count


def next_listen_window_seconds(current_window: float) -> float:
    if current_window <= 0:
        return AWAIT_ROUND_MIN_BLOCK_SECONDS
    return max(AWAIT_ROUND_MIN_BLOCK_SECONDS, current_window - AWAIT_ROUND_DECREMENT_SECONDS)


def effective_await_round_max_block(requested_max_block) -> float:
    if requested_max_block is None:
        return AWAIT_ROUND_DEFAULT_BLOCK_SECONDS
    if requested_max_block <= 0:
        return requested_max_block
    return max(AWAIT_ROUND_MIN_BLOCK_SECONDS, min(requested_max_block, AWAIT_ROUND_MAX_BLOCK_SECONDS))
