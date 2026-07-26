#!/usr/bin/env python3
"""Probe a real ACP Agent without Runtime identity or sensitive prompts."""

import argparse
import json
import pathlib
import subprocess
import sys


SCRIPTS_DIR = pathlib.Path(__file__).resolve().parents[1] / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from backends.acp.client import AcpClient, AcpError
from backends.acp.processes import process_group_alive, terminate_process_group


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--command", required=True)
    parser.add_argument("--command-arg", action="append", default=[])
    parser.add_argument("--cwd", required=True)
    args = parser.parse_args(argv)
    updates = []

    def event(message):
        if message.get("method") == "session/update":
            update = (message.get("params") or {}).get("update") or {}
            updates.append(update.get("sessionUpdate") or sorted(update))

    process = None
    client = None
    report = {"ok": False}
    try:
        process = subprocess.Popen(
            [args.command] + args.command_arg,
            cwd=args.cwd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True,
        )
        client = AcpClient(process.stdin, process.stdout, event_handler=event)
        client.start()
        initialized = client.initialize(timeout=30)
        report["initialized"] = {
            "protocolVersion": initialized.get("protocolVersion"),
            "agentInfo": initialized.get("agentInfo"),
            "agentCapabilities": initialized.get("agentCapabilities"),
            "authMethods": [
                {key: method.get(key) for key in ("id", "name", "type")}
                for method in (initialized.get("authMethods") or [])
            ],
        }
        session = client.new_session(cwd=args.cwd, timeout=30)
        report["sessionId"] = session.get("sessionId")
        report["configOptions"] = session.get("configOptions") or []
        report["prompt"] = client.prompt(
            session["sessionId"], "Reply with hello. Do not use tools.", timeout=90
        )
        report["ok"] = True
    except AcpError as exc:
        report["error"] = {
            "code": exc.code,
            "message": exc.message,
            "data": exc.data,
        }
    except Exception as exc:
        report["error"] = {"type": type(exc).__name__, "message": str(exc)}
    finally:
        report["updates"] = updates
        if client is not None:
            client.close()
        if process is not None:
            try:
                cleaned = terminate_process_group(process.pid, grace=3, trusted=True)
                report["cleanup"] = {
                    "process_group_absent": bool(cleaned and not process_group_alive(process.pid))
                }
            except Exception as exc:
                report["cleanup"] = {
                    "process_group_absent": False,
                    "error": {"type": type(exc).__name__, "message": str(exc)},
                }
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                report["cleanup"]["process_group_absent"] = False
            stderr = process.stderr.read()
            report["stderr_tail"] = stderr[-2000:]
            for stream in (process.stdin, process.stdout, process.stderr):
                try:
                    stream.close()
                except OSError:
                    pass
        else:
            report["cleanup"] = {"process_group_absent": True}
    if not report["cleanup"]["process_group_absent"]:
        report["ok"] = False
    print(json.dumps(report, ensure_ascii=False, sort_keys=True))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
