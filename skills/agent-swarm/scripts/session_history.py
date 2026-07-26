"""Transient ACP ``session/load`` history retrieval; no dialogue is persisted."""

import asyncio
import contextlib
import json

import state_store
from backends.acp.client import AgentSwarmClient, connect_agent
from backends.acp.permissions import PermissionDecision
from backends.acp.processes import process_group_alive, terminate_process_group
from backends.acp.registry import ensure_available, ensure_sdk_available


def find_records(agent_type, external_session_id, *, root_id=None):
    state_store.initialize_schema()
    return state_store.find_session(agent_type, external_session_id, root_id=root_id)


def _dump(value):
    if value is None:
        return None
    if isinstance(value, dict):
        return value
    method = getattr(value, "model_dump", None)
    if callable(method):
        return method(mode="json", by_alias=True, exclude_none=True)
    return {"type": type(value).__name__, "value": str(value)}


def _unavailable(record, reason, message):
    return {
        "available": False,
        "reason": reason,
        "message": message,
        "agent_type": record.get("agent_type") if record else None,
        "session_id": record.get("external_session_id") if record else None,
        "root_id": record.get("root_id") if record else None,
    }


async def _load(record):
    ensure_sdk_available()
    config = json.loads(record.get("profile_config_json") or "{}")
    command = ensure_available(config)
    process = None
    connection = None
    updates = []

    def session_update(session_id, update):
        updates.append(
            {
                "session_id": session_id,
                "update": _dump(update),
            }
        )

    try:
        process = await asyncio.create_subprocess_exec(
            command,
            *list(config.get("args") or []),
            cwd=record["cwd"],
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
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

        from acp import PROTOCOL_VERSION, RequestError
        from acp.schema import ClientCapabilities, Implementation

        initialized = await asyncio.wait_for(
            connection.initialize(
                protocol_version=PROTOCOL_VERSION,
                client_capabilities=ClientCapabilities(),
                client_info=Implementation(
                    name="agent-swarm-history",
                    title="Agent Swarm History Viewer",
                    version="1",
                ),
            ),
            timeout=30,
        )
        capabilities = initialized.agent_capabilities
        if not capabilities or capabilities.load_session is not True:
            return _unavailable(
                record,
                "load_unsupported",
                "该 ACP Agent 不支持 session/load，无法恢复对话历史。",
            )
        try:
            loaded = await asyncio.wait_for(
                connection.load_session(
                    cwd=record["cwd"],
                    session_id=record["external_session_id"],
                    mcp_servers=[],
                ),
                timeout=60,
            )
        except RequestError as exc:
            return {
                **_unavailable(
                    record,
                    "session_missing",
                    "ACP 会话不可用或已丢失，无法恢复对话历史。",
                ),
                "error_code": exc.code,
            }
        return {
            "available": True,
            "agent_type": record["agent_type"],
            "session_id": record["external_session_id"],
            "root_id": record["root_id"],
            "task_id": record["task_id"],
            "attempt_id": record["attempt_id"],
            "launch_id": record["launch_id"],
            "load_response": _dump(loaded),
            "history": updates,
        }
    except (OSError, RuntimeError, asyncio.TimeoutError) as exc:
        return {
            **_unavailable(
                record,
                "agent_unavailable",
                "无法启动对应的 ACP Agent 或加载会话，历史暂不可用。",
            ),
            "error_type": type(exc).__name__,
        }
    finally:
        if connection is not None:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(connection.close(), timeout=3)
        if process is not None:
            terminate_process_group(process.pid, grace=2, trusted=True)
            if process.stdin is not None:
                process.stdin.close()
                with contextlib.suppress(Exception):
                    await process.stdin.wait_closed()
            try:
                await asyncio.wait_for(process.wait(), timeout=3)
            except asyncio.TimeoutError:
                with contextlib.suppress(ProcessLookupError):
                    process.kill()
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(process.wait(), timeout=3)


def load_history(agent_type, external_session_id, *, root_id=None):
    records = find_records(agent_type, external_session_id, root_id=root_id)
    if not records:
        return _unavailable(
            {
                "agent_type": agent_type,
                "external_session_id": external_session_id,
                "root_id": root_id,
            },
            "not_recorded",
            "没有找到匹配的 ACP 会话记录。",
        )
    if len(records) != 1:
        return {
            "available": False,
            "reason": "ambiguous",
            "message": "匹配到多个 ACP profile，请同时指定 root_id。",
            "agent_type": agent_type,
            "session_id": external_session_id,
            "matches": [
                {
                    "root_id": item["root_id"],
                    "profile_id": item["profile_id"],
                    "state_namespace": item["state_namespace"],
                }
                for item in records
            ],
        }
    return asyncio.run(_load(records[0]))
