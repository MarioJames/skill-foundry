"""Execution Backend resolution from persisted Attempt facts."""

import json

from .claude_cli import ClaudeCliBackend


def _config(record):
    raw = record.get("config_json") if record else None
    try:
        value = json.loads(raw or "{}")
    except (TypeError, ValueError) as exc:
        raise ValueError("execution config_json is invalid") from exc
    return value if isinstance(value, dict) else {}


def resolve_execution_backend(execution_record):
    if not execution_record:
        raise ValueError("execution record is required")
    backend_id = execution_record.get("backend_id")
    if backend_id == "claude_cli":
        return ClaudeCliBackend(_config(execution_record))
    if backend_id == "acp":
        try:
            from .acp.adapter import AcpBackend
        except ImportError as exc:
            raise ValueError("ACP execution backend is not installed") from exc
        return AcpBackend(_config(execution_record), execution_record=execution_record)
    raise ValueError("unsupported execution backend: %s" % backend_id)


def resolve_spawn_backend(execution_record):
    return resolve_execution_backend(execution_record)
