#!/usr/bin/env python3
"""Probe a real ACP Agent through the official SDK without Runtime identity."""

import argparse
import asyncio
import json
import pathlib
import sys


SCRIPTS_DIR = pathlib.Path(__file__).resolve().parents[1] / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from backends.acp.client import AgentSwarmClient, connect_agent
from backends.acp.dependencies import activate as activate_bundled_sdk
from backends.acp.permissions import PermissionDecision
from backends.acp.processes import process_group_alive, terminate_process_group


def _dump(value):
    if value is None:
        return None
    return value.model_dump(mode="json", by_alias=True, exclude_none=True)


async def probe(args):
    activate_bundled_sdk()
    from acp import PROTOCOL_VERSION, RequestError, text_block
    from acp.schema import ClientCapabilities, Implementation

    updates = []
    process = None
    connection = None
    report = {"ok": False}

    def session_update(session_id, update):
        updates.append(
            {
                "sessionId": session_id,
                "type": getattr(update, "session_update", type(update).__name__),
            }
        )

    try:
        process = await asyncio.create_subprocess_exec(
            args.command,
            *args.command_arg,
            cwd=args.cwd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
        )
        if process.stdin is None or process.stdout is None:
            raise RuntimeError("ACP Agent did not expose stdio streams")
        connection = connect_agent(
            AgentSwarmClient(
                permission_handler=lambda request: PermissionDecision(None, False),
                session_update_handler=session_update,
            ),
            process.stdin,
            process.stdout,
        )
        initialized = await asyncio.wait_for(
            connection.initialize(
                protocol_version=PROTOCOL_VERSION,
                client_capabilities=ClientCapabilities(),
                client_info=Implementation(
                    name="agent-swarm-handshake", version="1"
                ),
            ),
            timeout=30,
        )
        report["initialized"] = {
            "protocolVersion": initialized.protocol_version,
            "agentInfo": _dump(initialized.agent_info),
            "agentCapabilities": _dump(initialized.agent_capabilities),
            "authMethods": [
                {key: getattr(method, key, None) for key in ("id", "name", "type")}
                for method in initialized.auth_methods or []
            ],
        }
        session = await asyncio.wait_for(
            connection.new_session(cwd=args.cwd, mcp_servers=[]), timeout=30
        )
        report["sessionId"] = session.session_id
        report["configOptions"] = [_dump(option) for option in session.config_options or []]
        prompt = await asyncio.wait_for(
            connection.prompt(
                session_id=session.session_id,
                prompt=[text_block("Reply with hello. Do not use tools.")],
            ),
            timeout=90,
        )
        report["prompt"] = _dump(prompt)
        report["ok"] = True
    except RequestError as exc:
        report["error"] = {
            "code": exc.code,
            "type": type(exc).__name__,
        }
    except Exception as exc:
        report["error"] = {"type": type(exc).__name__}
    finally:
        report["updates"] = updates
        if connection is not None:
            try:
                await asyncio.wait_for(connection.close(), timeout=3)
            except Exception:
                report["connection_close"] = False
        if process is not None:
            cleaned = terminate_process_group(process.pid, grace=3, trusted=True)
            try:
                await asyncio.wait_for(process.wait(), timeout=3)
            except asyncio.TimeoutError:
                cleaned = False
            report["cleanup"] = {
                "process_group_absent": bool(
                    cleaned and not process_group_alive(process.pid)
                )
            }
            if process.stdin is not None:
                process.stdin.close()
            if process.stderr is not None:
                stderr = await process.stderr.read()
                report["stderr_bytes"] = len(stderr)
        else:
            report["cleanup"] = {"process_group_absent": True}
    if not report["cleanup"]["process_group_absent"]:
        report["ok"] = False
    return report


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--command", required=True)
    parser.add_argument("--command-arg", action="append", default=[])
    parser.add_argument("--cwd", required=True)
    args = parser.parse_args(argv)
    report = asyncio.run(probe(args))
    print(json.dumps(report, ensure_ascii=False, sort_keys=True))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
