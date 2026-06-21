import os

import claude_cli
import state_store
from rounds import visible_agent_id


def stop_output(root_id: str, stopped, already_terminal=False, status=None):
    return {
        "stopped_jobs": stopped,
        "root_id": root_id,
        "terminal": True,
        "next_action": "record_and_restart_fresh_cwd",
        "message": (
            "HARD STOP: run stopped terminally. Stop the current Claude response now; "
            "do not run any more business commands, do not continue editing this cwd, "
            "do not re-init here, and do not bypass the protocol with Workflow/TaskCreate. "
            "Record evidence, discard this cwd, and restart in a fresh cwd."
        ),
        "already_terminal": already_terminal,
        "status": status or "failed",
    }


def stop_recorded_and_orphan_jobs(root_id: str, eng: str, reason: str):
    stopped = []
    jobs = state_store.recorded_jobs(root_id)
    active_items = claude_cli.active_agents()
    active_ids = {visible_agent_id(item) for item in active_items}
    for job in jobs:
        job_engine = job.get("engine") or eng
        claude_cli.stop(job["job_id"], job_engine)
        append_unique(stopped, job["job_id"])
        if job.get("status") == "running":
            state_store.fail_if_running(job["agent_id"], root_id, reason)
        if job_engine == "claude" and job["job_id"] in active_ids:
            claude_cli.rm(job["job_id"], job_engine)
    recorded_ids = {job["job_id"] for job in jobs}
    run = state_store.get_run(root_id)
    for item in active_items:
        item_id = visible_agent_id(item)
        if not item_id or item_id in recorded_ids:
            continue
        if is_coord_orphan_for_run(item, run):
            claude_cli.stop(item_id, "claude")
            claude_cli.rm(item_id, "claude")
            append_unique(stopped, item_id)
    return stopped


def append_unique(items, value):
    if value not in items:
        items.append(value)


def is_coord_orphan_for_run(item, run) -> bool:
    if not isinstance(item, dict) or not run:
        return False
    name = item.get("name") or ""
    cwd = item.get("cwd") or ""
    run_cwd = run.get("cwd") or ""
    if not cwd or not run_cwd:
        return False
    if os.path.realpath(cwd) != os.path.realpath(run_cwd):
        return False
    if name.startswith("ut-"):
        return True
    if item.get("kind") != "background":
        return False
    started_at = item.get("startedAt")
    created_at = run.get("created_at")
    if started_at is None or created_at is None:
        return False
    try:
        return float(started_at) / 1000 >= float(created_at)
    except (TypeError, ValueError):
        return False
