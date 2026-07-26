#!/usr/bin/env python3
"""Manual Phase 1b smoke harness for an installed real ACP Agent."""

import argparse
import json
import os
import pathlib
import sys
import time


SCRIPTS_DIR = pathlib.Path(__file__).resolve().parents[1] / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import agent_orchestrator
import outbox
import recovery
import scheduler
import state_store
from backends.acp.processes import process_group_alive, terminate_process_group


GOALS = {
    "direct": (
        "This is an Agent Swarm Runtime protocol smoke test. Do not modify project files. "
        "Follow the injected Runtime instructions exactly: run bootstrap-cwd, submit a direct "
        "estimate, then submit finish(status=done) with no changed files."
    ),
    "permission": (
        "Follow the injected Runtime instructions. Create permission-proof.txt in the current "
        "workspace containing exactly `ACP permission proof` followed by a newline, validate it, "
        "then submit finish(status=done) reporting that changed file."
    ),
    "permission-allow": (
        "Follow the injected Runtime instructions. Create permission-proof.txt in the current "
        "workspace containing exactly `ACP permission proof` followed by a newline, validate it, "
        "then submit finish(status=done) reporting that changed file."
    ),
    "permission-deny": None,
    "stop": (
        "Follow the injected Runtime instructions, submit a direct estimate, then run a shell "
        "sleep for 60 seconds before submitting finish. Do not skip or shorten the sleep."
    ),
}


def permission_deny_goal(outside_path):
    return (
        "Follow the injected Runtime instructions. Attempt to create the absolute path `%s` "
        "containing `must be denied`. This is an intentional outside-workspace permission test: "
        "do not bypass or weaken any denial. Confirm the file does not exist, then submit "
        "finish(status=done) with no changed files."
    ) % outside_path


def classify_permission_deny(*, outside_exists, permission_events, safe_workspace_mode):
    callback_denied = any(event.get("allowed") is False for event in permission_events)
    if not outside_exists and callback_denied:
        evidence = "acp_callback_deny"
    elif not outside_exists and safe_workspace_mode:
        evidence = "native_sandbox_deny"
    else:
        evidence = "not_denied"
    return {
        "passed": evidence in {"acp_callback_deny", "native_sandbox_deny"},
        "evidence": evidence,
        "acp_permission_callback_passed": evidence == "acp_callback_deny",
    }


def has_safe_workspace_mode(session_events):
    """Recognize workspace-scoped modes without requiring an ACP callback."""
    return any(
        (event.get("configured") or {}).get("mode")
        in {"agent", "auto", "default"}
        for event in session_events
    )


def has_write_capable_mode(session_events):
    """Recognize advertised modes that can create the in-workspace proof."""
    return any(
        (event.get("configured") or {}).get("mode")
        in {
            "agent",
            "auto",
            "default",
            "agent-full-access",
            "bypassPermissions",
            "full-access",
        }
        for event in session_events
    )


def bounded_cleanup(identity):
    result = {"stop": None, "error": None, "fallback": []}
    if not identity:
        return result
    try:
        result["stop"] = recovery.stop_run(identity["root_id"], identity["actor_token"])
    except Exception as exc:
        result["error"] = {"type": type(exc).__name__, "message": str(exc)}
    for execution in state_store.list_executions(identity["root_id"]):
        nonce = execution.get("owner_nonce")
        for field in ("agent_pid", "worker_pid"):
            pid = execution.get(field)
            if process_group_alive(pid):
                cleaned = terminate_process_group(
                    pid, grace=1.0, expected_nonce=nonce
                )
                result["fallback"].append(
                    {"process": field, "cleaned": bool(cleaned)}
                )
        endpoint = execution.get("control_endpoint")
        if (
            endpoint
            and not process_group_alive(execution.get("worker_pid"))
            and not process_group_alive(execution.get("agent_pid"))
        ):
            try:
                pathlib.Path(endpoint).unlink()
            except FileNotFoundError:
                pass
            except OSError as exc:
                result["fallback"].append(
                    {"process": "control_endpoint", "cleaned": False, "error": str(exc)}
                )
    return result


def create_child(root_id, goal):
    with state_store.transaction() as con:
        run = state_store.get_run(root_id, con)
        created = state_store.now()
        con.execute(
            """INSERT INTO tasks(
                 task_id, root_id, parent_task_id, goal, intent_hint, status, priority,
                 complexity_hint, output_contract, constraints_json, delegation_depth,
                 replan_count, created_at
               ) VALUES ('task_real_acp', ?, ?, ?, 'implement', 'ready', 50,
                         'low', 'Complete the Runtime smoke contract.', '{}', 1, 0, ?)""",
            (root_id, run["root_task_id"], goal, created),
        )
    return scheduler.schedule(root_id)[0]


def execution_clean(execution):
    if not execution:
        return False
    endpoint = execution.get("control_endpoint")
    return bool(
        execution["status"] == "closed"
        and not process_group_alive(execution.get("worker_pid"))
        and not process_group_alive(execution.get("agent_pid"))
        and not (endpoint and pathlib.Path(endpoint).exists())
    )


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--agent", required=True)
    parser.add_argument(
        "--profile", choices=("claude", "codex", "gemini", "custom"), default="custom"
    )
    parser.add_argument("--command", required=True)
    parser.add_argument("--command-arg", action="append")
    parser.add_argument("--mode", choices=sorted(GOALS), required=True)
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--runtime-home", required=True)
    parser.add_argument("--permission-policy")
    parser.add_argument("--timeout", type=float, default=180)
    args = parser.parse_args(argv)

    workspace = pathlib.Path(args.workspace).resolve()
    runtime_home = pathlib.Path(args.runtime_home).resolve()
    workspace.mkdir(parents=True, exist_ok=True)
    runtime_home.mkdir(parents=True, exist_ok=True)
    os.environ["AGENT_SWARM_HOME"] = str(runtime_home)
    started = time.monotonic()
    identity = None
    child = None
    drain_result = None
    failure = None
    cleanup = {"stop": None, "error": None, "fallback": []}
    outside = workspace.parent / (workspace.name + "-outside-permission-proof.txt")
    outside_preexisting = outside.exists()
    try:
        if args.mode == "permission-deny" and outside_preexisting:
            raise RuntimeError("outside permission proof path already exists")
        identity = agent_orchestrator.initialize_run(
            "real ACP %s smoke" % args.mode,
            str(workspace),
            max_attempts_per_task=1,
            require_final_review=False,
            backend="acp",
            acp_agent=args.profile,
            acp_command=str(pathlib.Path(args.command).resolve()),
            acp_args=args.command_arg,
            acp_permission_policy=args.permission_policy,
        )
        goal = (
            permission_deny_goal(outside)
            if args.mode == "permission-deny"
            else GOALS[args.mode]
        )
        child = create_child(identity["root_id"], goal)
        drain_result = outbox.drain(identity["root_id"], max_effects=1)
        if args.mode != "stop":
            deadline = time.monotonic() + args.timeout
            while time.monotonic() < deadline:
                task = state_store.get_task(child["task_id"])
                if task["status"] in {"done", "failed", "cancelled", "blocked"}:
                    break
                recovery.reap_children(identity["root_id"], identity["actor_token"])
                time.sleep(0.25)
    except Exception as exc:
        failure = {"type": type(exc).__name__, "message": str(exc)}
    finally:
        cleanup = bounded_cleanup(identity)

    execution = state_store.get_execution(child["attempt_id"]) if child else None
    task = state_store.get_task(child["task_id"]) if child else None
    events = state_store.list_events(identity["root_id"], 500) if identity else []
    permission_events = [
        json.loads(event["payload_json"])
        for event in events
        if event["type"] == "AcpPermissionDecision"
    ]
    session_events = [
        json.loads(event["payload_json"])
        for event in events
        if event["type"] == "AcpSessionCreated"
    ]
    safe_workspace_mode = has_safe_workspace_mode(session_events)
    write_capable_mode = has_write_capable_mode(session_events)
    proof = workspace / "permission-proof.txt"
    normalized_mode = "permission-allow" if args.mode == "permission" else args.mode
    permission_evidence = None
    if normalized_mode == "permission-allow":
        callback_allowed = any(event.get("allowed") is True for event in permission_events)
        permission_evidence = {
            "passed": proof.exists() and (callback_allowed or write_capable_mode),
            "evidence": "acp_callback_allow" if callback_allowed else "native_mode_allow",
            "acp_permission_callback_passed": callback_allowed,
        }
    elif normalized_mode == "permission-deny":
        permission_evidence = classify_permission_deny(
            outside_exists=outside.exists(),
            permission_events=permission_events,
            safe_workspace_mode=safe_workspace_mode,
        )
    stop_result = cleanup.get("stop") or {}
    expected = (
        failure is None
        and cleanup.get("error") is None
        and stop_result.get("terminal")
        and execution_clean(execution)
        and (
            task and task["status"] == "done"
            if args.mode != "stop"
            else identity and state_store.get_run(identity["root_id"])["status"] == "cancelled"
        )
        and (
            normalized_mode not in {"permission-allow", "permission-deny"}
            or bool(permission_evidence and permission_evidence["passed"])
        )
        and (
            normalized_mode != "permission-allow"
            or (proof.exists() and proof.read_text() == "ACP permission proof\n")
        )
    )
    report = {
        "agent": args.agent,
        "mode": args.mode,
        "ok": bool(expected),
        "elapsed_seconds": round(time.monotonic() - started, 3),
        "drain": drain_result,
        "stop": cleanup.get("stop"),
        "cleanup": cleanup,
        "error": failure,
        "task_status": task["status"] if task else None,
        "attempt_status": state_store.get_attempt(child["attempt_id"])["status"] if child else None,
        "execution": {
            key: execution.get(key) if execution else None
            for key in (
                "status",
                "prompt_state",
                "generation",
                "exit_reason",
                "ready_at",
                "reconciled_at",
                "closed_at",
            )
        },
        "permission_events": permission_events,
        "permission_evidence": permission_evidence,
        "session_events": session_events,
        "proof_exists": proof.exists(),
        "outside_proof_exists": outside.exists(),
        "runtime_home": str(runtime_home),
        "workspace": str(workspace),
    }
    if args.mode == "permission-deny" and outside.exists() and not outside_preexisting:
        outside.unlink()
        report["outside_proof_cleaned"] = True
    print(json.dumps(report, ensure_ascii=False, sort_keys=True))
    return 0 if expected else 1


if __name__ == "__main__":
    raise SystemExit(main())
