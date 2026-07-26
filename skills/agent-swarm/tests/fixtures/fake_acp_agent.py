#!/usr/bin/env python3
"""Deterministic newline-delimited JSON-RPC ACP v1 test agent."""

import argparse
import json
import os
import pathlib
import subprocess
import sys
import time


def send(message):
    sys.stdout.write(json.dumps(message, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def response(request_id, result=None, error=None):
    message = {"jsonrpc": "2.0", "id": request_id}
    if error is not None:
        message["error"] = error
    else:
        message["result"] = result or {}
    send(message)


def runtime_action(action_type, payload):
    skill_dir = os.environ["AGENT_SWARM_SKILL_DIR"]
    command = [
        sys.executable,
        os.path.join(skill_dir, "scripts", "agent_orchestrator.py"),
        "action",
        "--type",
        action_type,
        "--stdin",
    ]
    completed = subprocess.run(
        command,
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        env=os.environ.copy(),
        check=False,
        timeout=10,
    )
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr or completed.stdout or "Runtime action failed")
    return json.loads(completed.stdout)


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--scenario", default="basic")
    parser.add_argument("--counter-file")
    parser.add_argument("--initialize-delay", type=float, default=0)
    parser.add_argument("--session-delay", type=float, default=0)
    args = parser.parse_args(argv)
    if args.counter_file:
        path = pathlib.Path(args.counter_file)
        count = int(path.read_text()) if path.exists() else 0
        path.write_text(str(count + 1))

    pending_prompt_id = None
    for raw in sys.stdin:
        try:
            message = json.loads(raw)
        except ValueError:
            continue
        method = message.get("method")
        request_id = message.get("id")
        if method == "initialize":
            time.sleep(args.initialize_delay)
            response(
                request_id,
                {
                    "protocolVersion": 1,
                    "agentCapabilities": {"loadSession": False},
                    "agentInfo": {"name": "fake-acp", "version": "1.0.0"},
                },
            )
        elif method == "session/new":
            time.sleep(args.session_delay)
            response(request_id, {"sessionId": "fake-session"})
        elif method == "session/prompt":
            prompt_text = "\n".join(
                block.get("text", "")
                for block in (message.get("params", {}).get("prompt") or [])
                if isinstance(block, dict)
            )
            if args.scenario == "hold":
                continue
            if args.scenario == "split":
                is_parent = "\nchild goal\n" in prompt_text
                runtime_action(
                    "submit_estimate",
                    {
                        "revision": False,
                        "strategy": "split" if is_parent else "direct",
                        "resolved_intent": "implement",
                        "complexity": "medium" if is_parent else "low",
                        "concerns": [],
                        "unknowns": [],
                        "estimated_files": [],
                        "reason": "deterministic fake split",
                    },
                )
                integration = None
                if is_parent:
                    created = runtime_action(
                        "create_tasks",
                        {
                            "tasks": [
                                {
                                    "key": "leaf-a",
                                    "goal": "leaf-a",
                                    "intent_hint": "implement",
                                    "output_contract": "finish leaf a",
                                },
                                {
                                    "key": "leaf-b",
                                    "goal": "leaf-b",
                                    "intent_hint": "implement",
                                    "output_contract": "finish leaf b",
                                },
                            ]
                        },
                    )
                    task_ids = [item["task_id"] for item in created["tasks"]]
                    waited = runtime_action(
                        "wait",
                        {
                            "task_ids": task_ids,
                            "condition": "all_done",
                            "listen_seconds": 15,
                        },
                    )
                    if not waited.get("complete"):
                        raise RuntimeError("fake split children did not finish")
                    integration = {"status": "passed", "summary": "fake leaves integrated"}
                runtime_action(
                    "finish",
                    {
                        "status": "done",
                        "retryable": False,
                        "summary": "fake split task finished",
                        "changed_files": [],
                        "artifacts": [],
                        "validation": None,
                        "review": None,
                        "integration_check": integration,
                        "caveats": [],
                    },
                )
                response(request_id, {"stopReason": "end_turn"})
                continue
            if args.scenario == "finish":
                time.sleep(0.25)
                runtime_action(
                    "submit_estimate",
                    {
                        "revision": False,
                        "strategy": "direct",
                        "resolved_intent": "implement",
                        "complexity": "low",
                        "concerns": [],
                        "unknowns": [],
                        "estimated_files": [],
                        "reason": "deterministic fake task",
                    },
                )
                runtime_action(
                    "finish",
                    {
                        "status": "done",
                        "retryable": False,
                        "summary": "fake ACP child finished",
                        "changed_files": [],
                        "artifacts": [],
                        "validation": None,
                        "review": None,
                        "integration_check": None,
                        "caveats": [],
                    },
                )
                response(request_id, {"stopReason": "end_turn"})
                continue
            if args.scenario == "permission":
                pending_prompt_id = request_id
                send(
                    {
                        "jsonrpc": "2.0",
                        "id": 9001,
                        "method": "session/request_permission",
                        "params": {
                            "sessionId": "fake-session",
                            "toolCall": {
                                "title": "write",
                                "locations": [{"path": os.path.join(os.getcwd(), "inside.txt")}],
                            },
                            "options": [
                                {"optionId": "allow-once", "kind": "allow_once"},
                                {"optionId": "deny-once", "kind": "reject_once"},
                            ],
                        },
                    }
                )
                # The client response is consumed by the main loop before the
                # prompt result is emitted.
                continue
            response(request_id, {"stopReason": "end_turn"})
        elif request_id == 9001 and args.scenario == "permission":
            response(
                pending_prompt_id,
                {"stopReason": "end_turn", "permissionResponse": message.get("result")},
            )
            pending_prompt_id = None
        elif method == "session/cancel":
            if request_id is not None:
                response(request_id, {})
        elif method == "session/close":
            response(request_id, {})
        elif request_id is not None:
            response(request_id, error={"code": -32601, "message": "method not found"})
    if args.scenario == "hold":
        # Keep the fake Agent alive after its Worker disappears so recovery
        # tests can exercise the real orphan-process path deterministically.
        while True:
            time.sleep(1)


if __name__ == "__main__":
    main()
