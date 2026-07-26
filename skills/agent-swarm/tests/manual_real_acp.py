#!/usr/bin/env python3
"""Manual Phase 1b smoke harness for an installed real ACP Agent."""

import argparse
import contextlib
import json
import os
import pathlib
import sys
import time


SCRIPTS_DIR = pathlib.Path(__file__).resolve().parents[1] / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import agent_orchestrator
import execution_secrets
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
    "agent-crash": (
        "Follow the injected Runtime instructions, submit a direct estimate, then run a shell "
        "sleep for 60 seconds before submitting finish. This adapter process will be terminated "
        "externally to verify retryable failure reconciliation."
    ),
    "orchestration": (
        "Follow the injected Runtime instructions. Submit a split estimate, create exactly two "
        "independent child Tasks named leaf-a and leaf-b, wait for both to finish, verify their "
        "results, then submit finish(status=done) with a passed integration_check. Do not modify "
        "project files. Each leaf must submit its own direct estimate and legal Runtime finish."
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
    for launch in state_store.list_launches(identity["root_id"]):
        nonce = launch.get("owner_nonce")
        for field in ("agent_pid", "worker_pid"):
            pid = launch.get(field)
            if process_group_alive(pid):
                cleaned = terminate_process_group(
                    pid, grace=1.0, expected_nonce=nonce
                )
                result["fallback"].append(
                    {"process": field, "cleaned": bool(cleaned)}
                )
        endpoint = launch.get("control_endpoint")
        if (
            endpoint
            and not process_group_alive(launch.get("worker_pid"))
            and not process_group_alive(launch.get("agent_pid"))
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
        cursor = con.execute(
            """INSERT INTO tasks(
                 root_id, parent_task_id, goal, intent_hint, status, priority,
                 complexity_hint, output_contract, constraints_json, delegation_depth,
                 replan_count, created_at
               ) VALUES (?, ?, ?, 'implement', 'ready', 50,
                         'low', 'Complete the Runtime smoke contract.', '{}', 1, 0, ?)""",
            (root_id, run["root_task_id"], goal, created),
        )
    return scheduler.schedule(root_id)[0]


def execution_clean(launch):
    if not launch:
        return False
    endpoint = launch.get("control_endpoint")
    return bool(
        launch["status"] == "closed"
        and not process_group_alive(launch.get("worker_pid"))
        and not process_group_alive(launch.get("agent_pid"))
        and not (endpoint and pathlib.Path(endpoint).exists())
    )


def wait_until(predicate, timeout, interval=0.25):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(interval)
    raise RuntimeError("timed out waiting for real ACP condition")


def token_residue(runtime_home, plaintext_tokens):
    encoded = [token.encode() for token in plaintext_tokens if token]
    residue = []
    for path in runtime_home.rglob("*"):
        if not path.is_file():
            continue
        with contextlib.suppress(OSError):
            data = path.read_bytes()
            if any(token in data for token in encoded):
                residue.append(str(path.relative_to(runtime_home)))
    return sorted(residue)


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
    adapter_terminated = False
    plaintext_tokens = []
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
            acp_command=os.path.abspath(args.command),
            acp_args=args.command_arg,
            acp_permission_policy=args.permission_policy,
        )
        goal = (
            permission_deny_goal(outside)
            if args.mode == "permission-deny"
            else GOALS[args.mode]
        )
        child = create_child(identity["root_id"], goal)
        run = state_store.get_run(identity["root_id"])
        attempt = state_store.get_attempt(child["attempt_id"])
        plaintext_tokens = [
            identity["actor_token"],
            execution_secrets.derive_attempt_token(run, child["attempt_id"]),
        ]
        drain_result = outbox.drain(identity["root_id"], max_effects=1)
        if args.mode == "agent-crash":
            running = wait_until(
                lambda: (
                    record
                    if (record := state_store.get_launch(child["launch_id"]))[
                        "status"
                    ]
                    == "running"
                    else None
                ),
                args.timeout,
            )
            adapter_terminated = terminate_process_group(
                running["agent_pid"],
                grace=2.0,
                expected_nonce=running.get("owner_nonce"),
            )
            if not adapter_terminated:
                raise RuntimeError("failed to terminate real ACP adapter process group")
            wait_until(
                lambda: state_store.get_launch(child["launch_id"])["status"]
                == "closed",
                args.timeout,
            )
            wait_until(
                lambda: (
                    {"reconciled": True}
                    if (
                        recovery.reap_children(
                            identity["root_id"], identity["actor_token"]
                        )
                        and state_store.get_attempt(child["attempt_id"])["state"]
                        == "failed"
                    )
                    else None
                ),
                args.timeout,
            )
        elif args.mode != "stop":
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

    execution = state_store.get_launch(child["launch_id"]) if child else None
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
    executions = state_store.list_launches(identity["root_id"]) if identity else []
    tasks = state_store.list_tasks(identity["root_id"]) if identity else []
    attempts = state_store.list_attempts(identity["root_id"]) if identity else []
    all_executions_clean = bool(executions) and all(
        execution_clean(item) for item in executions
    )
    residue = token_residue(runtime_home, plaintext_tokens)
    retryable_failure = bool(
        child and state_store.get_attempt(child["attempt_id"])["state"] == "failed"
    )
    descendant_tasks = [
        item for item in tasks if child and item["task_id"] != child["task_id"]
        and item.get("parent_task_id") == child["task_id"]
    ]
    mode_outcome = (
        bool(
            adapter_terminated
            and retryable_failure
            and task
            and task["status"] == "failed"
            and execution
            and (execution.get("exit_reason") or "").startswith("acp_error:")
        )
        if args.mode == "agent-crash"
        else (
            bool(
                task
                and task["status"] == "done"
                and len(descendant_tasks) == 2
                and all(item["status"] == "done" for item in descendant_tasks)
            )
            if args.mode == "orchestration"
            else (
                task and task["status"] == "done"
                if args.mode != "stop"
                else identity
                and state_store.get_run(identity["root_id"])["status"] == "cancelled"
            )
        )
    )
    expected = (
        failure is None
        and cleanup.get("error") is None
        and stop_result.get("status") == "cancelled"
        and all_executions_clean
        and mode_outcome
        and not residue
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
        "attempt_status": state_store.get_attempt(child["attempt_id"])["state"] if child else None,
        "execution": {
            key: execution.get(key) if execution else None
            for key in (
                "status",
                "prompt_state",
                "launch_no",
                "exit_reason",
                "ready_at",
                "closed_at",
            )
        },
        "permission_events": permission_events,
        "permission_evidence": permission_evidence,
        "session_events": session_events,
        "proof_exists": proof.exists(),
        "outside_proof_exists": outside.exists(),
        "adapter_terminated": adapter_terminated,
        "retryable_failure": retryable_failure,
        "launch_count": len(executions),
        "all_executions_clean": all_executions_clean,
        "launch_summaries": [
            {
                "attempt_id": item["attempt_id"],
                "status": item["status"],
                "exit_reason": item.get("exit_reason"),
                "launch_id": item["launch_id"],
            }
            for item in executions
        ],
        "attempt_summaries": [
            {
                "attempt_id": item["attempt_id"],
                "task_id": item["task_id"],
                "state": item["state"],
                "retryable": bool(item.get("retryable")),
            }
            for item in attempts
        ],
        "task_summaries": [
            {
                "task_id": item["task_id"],
                "parent_task_id": item.get("parent_task_id"),
                "status": item["status"],
            }
            for item in tasks
        ],
        "descendant_task_statuses": [item["status"] for item in descendant_tasks],
        "token_residue_files": residue,
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
