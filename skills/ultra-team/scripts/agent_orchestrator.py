import argparse
import json
import subprocess
import sys
import uuid

import claude_cli
import recovery
import state_store
from cleanup_jobs import is_coord_orphan_for_run, stop_output, stop_recorded_and_orphan_jobs
from orchestration_guards import (
    ensure_parent_can_await,
    ensure_parent_can_dispatch,
    ensure_run_can_dispatch,
    ensure_run_is_running,
    normalize_agents,
    normalize_parent_id,
    validate_finish_preconditions,
)
from prompts import build_child_prompt, prompt_prefix_for_kind
from rounds import (
    await_round_blocking,
    await_round_command,
    cleanup_visible_job,
    effective_await_round_max_block,
    evaluate_round,
    next_listen_window_seconds,
    reap_terminal_visible_jobs,
    refresh_parent_heartbeat,
    recovery_candidates,
)
from runtime_assets import (
    cleanup_project_hooks_for_cwd,
    cleanup_project_hooks_for_root,
    ensure_project_hooks,
    install_runtime_assets,
    skill_dir,
)


import re

KIND_SHORT = {"implement": "impl", "review": "rev", "fix": "fix"}
_SLUG_RE = re.compile(r"[^a-z0-9]+")
_SLUG_MAX = 20


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:8]}"


def intent_slug(intent: str) -> str:
    slug = _SLUG_RE.sub("-", (intent or "task").lower()).strip("-")
    return (slug or "task")[:_SLUG_MAX].rstrip("-")


def build_session_name(root_id, parent_id, agent_id, kind, intent):
    root4 = root_id[-4:]
    self4 = agent_id[-4:]
    kind3 = KIND_SHORT.get(kind, kind)
    slug = intent_slug(intent)
    if parent_id == root_id:
        return f"ut-{root4}-{kind3}-{self4}-{slug}"
    chain = parent_chain(parent_id, root_id)
    return f"ut-{root4}-{kind3}-{chain}-{self4}-{slug}"


def parent_chain(parent_id, root_id):
    parts = []
    current = parent_id
    visited = set()
    while current and current != root_id and current not in visited:
        visited.add(current)
        parts.append(current[-4:])
        agent = state_store.get_agent(current)
        if not agent:
            break
        current = agent.get("parent_id")
    parts.reverse()
    return ".".join(parts)


def cmd_init(args) -> int:
    ensure_cwd_can_init(args.cwd, allow_terminal=args.allow_terminal_cwd)
    install_runtime_assets()
    ensure_project_hooks(args.cwd)
    root_id = new_id("root")
    state_store.create_run(root_id, args.task, args.cwd, current_branch(args.cwd))
    print(json.dumps({"root_id": root_id}, ensure_ascii=False))
    return 0


def ensure_cwd_can_init(cwd: str, allow_terminal: bool = False) -> None:
    terminal_statuses = {"done", "failed"}
    allowed_statuses = terminal_statuses if allow_terminal else {"done"}
    conflicts = [run for run in state_store.runs_for_cwd(cwd) if run.get("status") not in allowed_statuses]
    if conflicts:
        roots = ", ".join(f"{run['root_id']}:{run['status']}" for run in conflicts)
        allowed_hint = "terminal" if allow_terminal else "done"
        raise SystemExit(
            f"cwd {cwd} already has non-done orchestrator run(s): {roots}; "
            f"do not re-init in the same cwd unless existing runs are {allowed_hint}. "
            "Stop/record this run and restart in a fresh cwd if an active run remains."
        )


def current_branch(cwd: str):
    out = subprocess.run(
        ["git", "-C", cwd, "branch", "--show-current"],
        capture_output=True,
        text=True,
        check=False,
    )
    branch = out.stdout.strip()
    if out.returncode == 0 and branch:
        return branch
    out = subprocess.run(
        ["git", "-C", cwd, "rev-parse", "--short", "HEAD"],
        capture_output=True,
        text=True,
        check=False,
    )
    rev = out.stdout.strip()
    if out.returncode == 0 and rev:
        return f"detached:{rev}"
    return None


def cmd_dispatch(args) -> int:
    agent_ids = []
    tasks = dispatch_tasks(args)
    intents = recovery.normalize_intents(tasks, args.intent)
    agents = normalize_agents(args.agent, len(tasks))
    parent_id = normalize_parent_id(args.parent_id, args.root_id)
    ensure_run_can_dispatch(args.root_id)
    ensure_parent_can_dispatch(parent_id, args.kind, args.round)
    run = state_store.get_run(args.root_id)
    run_cwd = run.get("cwd") if run else None
    install_runtime_assets()
    ensure_project_hooks(run_cwd)
    for task, intent, agent in zip(tasks, intents, agents):
        refresh_parent_heartbeat(parent_id, args.root_id)
        agent_id = new_id("child")
        prompt = build_child_prompt(agent_id, parent_id, args.root_id, args.round, args.kind, task, skill_dir())
        session_name = build_session_name(args.root_id, parent_id, agent_id, args.kind, intent)
        state_store.add_agent(agent_id, args.root_id, parent_id, args.round, args.kind, prompt, intent=intent)

        def record_started_job(engine_name, job_id, agent_id=agent_id):
            refresh_parent_heartbeat(parent_id, args.root_id)
            state_store.set_job(agent_id, args.root_id, job_id, None, engine_name)

        try:
            info = claude_cli.dispatch_with_fallback(
                prompt,
                name=session_name,
                agent=agent,
                model=args.model,
                cwd=run_cwd,
                on_job_started=record_started_job,
            )
        except claude_cli.AllEnginesDispatchFailed as exc:
            reason = json.dumps({"reason": "dispatch_failed", "failures": exc.failures}, ensure_ascii=False)
            failure = record_failed_dispatch_node(agent_id, args.root_id, exc.failures, reason)
            if failure and cleanup_visible_job(failure.get("job_id"), failure.get("engine") or claude_cli.engine()):
                pass
            print(json.dumps({
                "agent_ids": agent_ids,
                "failed": True,
                "reason": reason,
                "failed_agent_id": agent_id,
                "stopped_jobs": [],
            }, ensure_ascii=False))
            return 0
        refresh_parent_heartbeat(parent_id, args.root_id)
        state_store.set_job(agent_id, args.root_id, info["job_id"], info["session_id"], info["engine"])
        agent_ids.append(agent_id)
    print(json.dumps({"agent_ids": agent_ids}, ensure_ascii=False))
    return 0


def dispatch_tasks(args):
    tasks = list(args.task or [])
    if args.task_stdin:
        tasks.append(sys.stdin.read())
    if not tasks:
        raise SystemExit("dispatch requires at least one --task or --task-stdin")
    return tasks


def record_failed_dispatch_node(agent_id, root_id, failures, reason):
    failure = first_failure_with_job(failures)
    if failure:
        state_store.set_job(
            agent_id,
            root_id,
            failure.get("job_id"),
            failure.get("session_id"),
            failure.get("engine"),
        )
    state_store.fail(agent_id, root_id, reason)
    return failure


def first_failure_with_job(failures):
    for failure in failures or []:
        if failure.get("job_id"):
            return failure
    return None


def cmd_await_round(args) -> int:
    eng = claude_cli.engine()
    ensure_run_is_running(args.root_id, "await-round")
    ensure_parent_can_await(args.parent_id)
    result = await_round_blocking(
        args.parent_id,
        args.root_id,
        args.round,
        eng,
        args.poll,
        args.max_block,
    )
    print(json.dumps(result, ensure_ascii=False))
    return 0


def cmd_recover_idle_agent(args) -> int:
    ensure_run_is_running(args.root_id, "recover-idle-agent")
    agent = state_store.get_agent(args.agent_id)
    if not agent or agent.get("root_id") != args.root_id:
        raise SystemExit(f"agent {args.agent_id} does not exist in run {args.root_id}")
    if agent.get("status") != "running":
        raise SystemExit(f"agent {args.agent_id} is {agent.get('status')}, not running")

    parent_id = agent.get("parent_id")
    round_ = agent.get("round")
    matches = [
        candidate
        for candidate in recovery_candidates(
            parent_id,
            args.root_id,
            round_,
            idle_threshold=args.idle_threshold,
        )
        if candidate["agent_id"] == args.agent_id
    ]
    if not matches and not args.force:
        raise SystemExit(f"agent {args.agent_id} is not a recoverable idle candidate")

    candidate = matches[0] if matches else forced_recovery_candidate(agent, args)
    run = state_store.get_run(args.root_id) or {}
    cwd = run.get("cwd") or candidate.get("cwd")
    if not cwd:
        raise SystemExit(f"run {args.root_id} has no cwd; cannot recover {args.agent_id}")

    recovery_kwargs = {}
    if candidate.get("interrupt_first"):
        recovery_kwargs["interrupt_first"] = True
    recovery = claude_cli.attach_agent_and_send(candidate["job_id"], cwd, args.input, **recovery_kwargs)
    next_command = await_round_command(args.root_id, parent_id, round_, args.next_max_block)
    print(json.dumps({
        "recovered": True,
        "agent_id": args.agent_id,
        "job_id": candidate["job_id"],
        "session_id": candidate["session_id"],
        "reason": candidate["reason"],
        "recovery": {
            "method": "claude_attach",
            "tmux_session": recovery.get("tmux_session"),
            "cwd": recovery.get("cwd"),
            "input": recovery.get("input"),
            "interrupt_first": recovery.get("interrupt_first", False),
        },
        "next_command": next_command,
        "next_commands": [{
            "action": "continue_await_round",
            "command": next_command,
        }],
    }, ensure_ascii=False))
    return 0


def cmd_finish(args) -> int:
    ensure_run_is_running(args.root_id, "finish")
    validate_finish_preconditions(args.agent_id, args.root_id)
    state_store.finish(args.agent_id, args.root_id, args.result, args.caveats)
    if args.agent_id == args.root_id:
        state_store.set_run_status(args.root_id, "done")
        cleanup_project_hooks_for_root(args.root_id)
    print(json.dumps({"finished": args.agent_id}, ensure_ascii=False))
    return 0


def forced_recovery_candidate(agent, args):
    active = claude_cli.active_agents()
    by_id = {item.get("id"): item for item in active if item.get("id")}
    job_id = agent.get("job_id")
    item = by_id.get(job_id)
    if not item:
        raise SystemExit(f"agent {args.agent_id} job {job_id} is not visible in claude agents")
    status = item.get("status")
    if status not in ("idle", "busy") or item.get("state") != "working":
        raise SystemExit(
            f"agent {args.agent_id} job {job_id} is {item.get('status')}/{item.get('state')}, not recoverable"
        )
    return {
        "agent_id": agent["agent_id"],
        "job_id": job_id,
        "session_id": agent.get("session_id"),
        "idle_for": None,
        "agent_view_status": status,
        "agent_view_state": item.get("state"),
        "reason": f"forced_agent_{status}_working",
        **({"interrupt_first": True} if status == "busy" else {}),
    }


def cmd_status(args) -> int:
    reap_terminal_visible_jobs(args.root_id, claude_cli.engine())
    print(json.dumps(state_store.get_tree(args.root_id), ensure_ascii=False, indent=None if args.json else 2))
    return 0


def cmd_list_runs(args) -> int:
    print(json.dumps({"runs": state_store.list_runs()}, ensure_ascii=False))
    return 0


def cmd_recover_root(args) -> int:
    branch = current_branch(args.cwd)
    discovery = recovery.discover_recovery_run(args.cwd, current_branch=branch, root_id=args.root_id)
    if not discovery.get("recoverable"):
        print(json.dumps(discovery, ensure_ascii=False))
        return 0
    root_id = discovery["run"]["root_id"]
    prompt = recovery.build_recovery_prompt(root_id, skill_dir())
    output = {
        **discovery,
        "root_id": root_id,
        "prompt": prompt,
    }
    if args.write_prompt:
        with open(args.write_prompt, "w", encoding="utf-8") as fh:
            fh.write(prompt)
        output["prompt_path"] = args.write_prompt
    print(json.dumps(output, ensure_ascii=False))
    return 0


def cmd_install_runtime(args) -> int:
    print(json.dumps(install_runtime_assets(), ensure_ascii=False))
    return 0


def cmd_stop(args) -> int:
    eng = claude_cli.engine()
    run = state_store.get_run(args.root_id)
    if not run:
        raise SystemExit(f"run {args.root_id} does not exist and cannot stop")
    stopped = stop_recorded_and_orphan_jobs(args.root_id, eng, "stopped by user (stop --root-id)")
    if run.get("status") != "running":
        print(json.dumps(stop_output(args.root_id, stopped, already_terminal=True, status=run.get("status")), ensure_ascii=False))
        return 0
    failed_running = state_store.fail_all_running(args.root_id, "stopped by user (stop --root-id)")
    state_store.set_run_status(args.root_id, "failed")
    print(json.dumps(stop_output(args.root_id, stopped), ensure_ascii=False))
    return 0


def cmd_cleanup_hooks(args) -> int:
    if args.root_id:
        cleanup_project_hooks_for_root(args.root_id)
    if args.cwd:
        cleanup_project_hooks_for_cwd(args.cwd)
    print(json.dumps({"cleanup_hooks": True}, ensure_ascii=False))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="agent_orchestrator.py")
    sub = parser.add_subparsers(dest="command", required=True)

    p_init = sub.add_parser("init")
    p_init.add_argument("--task", required=True)
    p_init.add_argument("--cwd", required=True)
    p_init.add_argument(
        "--allow-terminal-cwd",
        action="store_true",
        help="allow init in a cwd that only has terminal done/failed runs; still rejects active runs",
    )

    p_dispatch = sub.add_parser("dispatch")
    p_dispatch.add_argument("--root-id", required=True)
    p_dispatch.add_argument("--parent-id", required=True)
    p_dispatch.add_argument("--round", type=int, required=True)
    p_dispatch.add_argument("--kind", choices=["implement", "review", "fix"], default="implement")
    p_dispatch.add_argument("--agent", action="append", default=None)
    p_dispatch.add_argument("--model", choices=["opus", "sonnet", "haiku"], default=None)
    p_dispatch.add_argument("--intent", action="append", default=None)
    p_dispatch.add_argument("--task", action="append", default=None)
    p_dispatch.add_argument("--task-stdin", action="store_true")

    p_await = sub.add_parser("await-round")
    p_await.add_argument("--root-id", required=True)
    p_await.add_argument("--parent-id", required=True)
    p_await.add_argument("--round", type=int, required=True)
    p_await.add_argument("--poll", type=float, default=5)
    p_await.add_argument("--max-block", type=float, default=None)

    p_recover = sub.add_parser("recover-idle-agent")
    p_recover.add_argument("--root-id", required=True)
    p_recover.add_argument("--agent-id", required=True)
    p_recover.add_argument("--input", default="continue")
    p_recover.add_argument("--idle-threshold", type=float, default=60)
    p_recover.add_argument("--next-max-block", type=float, default=105)
    p_recover.add_argument(
        "--force",
        action="store_true",
        help="recover a manually confirmed idle/working or busy/working job even without a transcript recovery signal",
    )

    p_finish = sub.add_parser("finish")
    p_finish.add_argument("--agent-id", required=True)
    p_finish.add_argument("--root-id", required=True)
    p_finish.add_argument("--result", required=True)
    p_finish.add_argument("--caveats", default=None)

    p_status = sub.add_parser("status")
    p_status.add_argument("--root-id", required=True)
    p_status.add_argument("--json", action="store_true")

    p_recover_root = sub.add_parser("recover-root")
    p_recover_root.add_argument("--cwd", required=True)
    p_recover_root.add_argument("--root-id")
    p_recover_root.add_argument("--write-prompt")

    sub.add_parser("list-runs")
    sub.add_parser("install-runtime")

    p_stop = sub.add_parser("stop")
    p_stop.add_argument("--root-id", required=True)

    p_cleanup = sub.add_parser("cleanup-hooks")
    p_cleanup.add_argument("--root-id")
    p_cleanup.add_argument("--cwd")

    return parser


HANDLERS = {
    "init": cmd_init,
    "dispatch": cmd_dispatch,
    "await-round": cmd_await_round,
    "recover-idle-agent": cmd_recover_idle_agent,
    "finish": cmd_finish,
    "status": cmd_status,
    "recover-root": cmd_recover_root,
    "list-runs": cmd_list_runs,
    "install-runtime": cmd_install_runtime,
    "stop": cmd_stop,
    "cleanup-hooks": cmd_cleanup_hooks,
}


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    return HANDLERS[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
