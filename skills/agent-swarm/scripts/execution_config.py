"""Run-level execution configuration and immutable Attempt snapshots."""

import json
import os
import pathlib
import shutil


BACKENDS = {"claude_cli", "acp"}
PERMISSION_POLICIES = {"allow_in_workspace", "allow_all", "deny_all", "prompt"}


def _value(explicit, environment, name, default=None):
    if explicit is not None:
        return explicit
    value = environment.get(name)
    if isinstance(value, str):
        value = value.strip()
    return value if value not in {None, ""} else default


def _claude_command(environment):
    override = _value(None, environment, "AGENT_SWARM_CLAUDE_BIN")
    if override:
        return override
    for entry in environment.get("PATH", "").split(os.pathsep):
        if not entry:
            continue
        candidate = pathlib.Path(entry) / "claude"
        if candidate.is_file() and os.access(str(candidate), os.X_OK) and ".superconductor" not in candidate.parts:
            return str(candidate)
    return shutil.which("claude", path=environment.get("PATH")) or "claude"


def _args(value):
    if value is None:
        return []
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError as exc:
            raise ValueError("AGENT_SWARM_ACP_ARGS must be a JSON array") from exc
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise ValueError("ACP args must be an array of strings")
    return list(value)


def resolve_run_execution(
    *,
    backend=None,
    acp_agent=None,
    acp_command=None,
    acp_args=None,
    acp_permission_policy=None,
    environment=None,
):
    """Resolve init CLI > environment > defaults exactly once for a Run."""
    environment = os.environ if environment is None else environment
    backend = _value(backend, environment, "AGENT_SWARM_BACKEND", "claude_cli")
    if backend not in BACKENDS:
        raise ValueError("backend must be claude_cli or acp")
    agent = _value(acp_agent, environment, "AGENT_SWARM_ACP_AGENT", "claude")
    command = _value(acp_command, environment, "AGENT_SWARM_ACP_COMMAND")
    raw_args = (
        acp_args
        if acp_args is not None
        else _value(None, environment, "AGENT_SWARM_ACP_ARGS")
    )
    args = _args(raw_args)
    permission = _value(
        acp_permission_policy,
        environment,
        "AGENT_SWARM_ACP_PERMISSION_POLICY",
    )
    if not isinstance(agent, str) or not agent:
        raise ValueError("ACP agent must be a non-empty string")
    if command is not None and (not isinstance(command, str) or not command):
        raise ValueError("ACP command must be a non-empty string")
    from backends.acp import registry

    profile = registry.resolve_profile(
        agent,
        command=command,
        args=args if raw_args is not None else None,
    )
    permission = permission or profile.get("default_permission_policy") or "allow_in_workspace"
    if permission not in PERMISSION_POLICIES:
        raise ValueError("unsupported ACP permission policy: %s" % permission)
    if backend == "acp" and permission == "prompt":
        raise ValueError("ACP permission policy 'prompt' has no headless UI")
    if backend == "acp":
        registry.ensure_sdk_available()
    profile = registry.freeze_profile(profile, environment=environment)
    return {
        "backend": backend,
        "claude_cli": {"command": _claude_command(environment)},
        "acp": {
            "agent": agent,
            "command": profile["command"],
            "requested_command": profile["requested_command"],
            "resolved_command": profile["resolved_command"],
            "args": profile["args"],
            "model_tiers": dict(profile["model_tiers"]),
            "auth_prerequisites": list(profile["auth_prerequisites"]),
            "default_permission_policy": profile["default_permission_policy"],
            "profile_version": profile["profile_version"],
            "package": profile["package"],
            "install_hint": profile["install_hint"],
            "user_override": profile["user_override"],
            "sandbox": dict(profile["sandbox"]),
            "permission_policy": permission,
            "prompt_timeout_seconds": None,
            "session_close_on_stop": True,
            "turn_end_reprompt_limit": 1,
        },
        "routing": {"by_intent": {}, "by_model_tier": {}},
    }


def load_run_execution(run):
    raw = run.get("execution_config_json") if run else None
    if not raw:
        return resolve_run_execution(environment={"PATH": os.environ.get("PATH", "")})
    try:
        value = json.loads(raw)
    except (TypeError, ValueError) as exc:
        raise ValueError("run execution_config_json is invalid") from exc
    if not isinstance(value, dict) or value.get("backend") not in BACKENDS:
        raise ValueError("run execution_config_json has an unsupported backend")
    return value


def snapshot_attempt(run, *, model=None):
    """Flatten the persisted Run config into an immutable Attempt record."""
    execution = load_run_execution(run)
    backend = execution["backend"]
    if backend == "claude_cli":
        return {
            "backend": backend,
            "agent": "claude",
            "command": execution.get("claude_cli", {}).get("command") or "claude",
            "args": [],
            "model": model,
            "permission_policy": "bypassPermissions",
        }
    acp = execution.get("acp") or {}
    return {
        "backend": backend,
        "agent": acp.get("agent") or "claude",
        "command": acp.get("resolved_command"),
        "requested_command": acp.get("requested_command") or acp.get("command"),
        "args": list(acp.get("args") or []),
        "model": model,
        "permission_policy": acp.get("permission_policy") or "allow_in_workspace",
        "prompt_timeout_seconds": acp.get("prompt_timeout_seconds"),
        "session_close_on_stop": acp.get("session_close_on_stop", True),
        "turn_end_reprompt_limit": acp.get("turn_end_reprompt_limit", 1),
        "profile_version": acp.get("profile_version"),
        "package": acp.get("package"),
        "install_hint": acp.get("install_hint"),
        "auth_prerequisites": list(acp.get("auth_prerequisites") or []),
        "user_override": bool(acp.get("user_override")),
        "sandbox": dict(acp.get("sandbox") or {}),
    }


def supports_hooks(execution):
    return execution.get("backend") == "claude_cli"
