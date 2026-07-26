"""Pinned ACP Agent and bundled official SDK preflight."""

import importlib.metadata
import importlib.util
import os
import shutil

from backends.acp.dependencies import activate as activate_bundled_sdk


SDK_DISTRIBUTION = "agent-client-protocol"
SDK_VERSION = "0.11.0"
SDK_REQUIREMENT = "%s==%s" % (SDK_DISTRIBUTION, SDK_VERSION)


def ensure_sdk_available():
    """Activate and verify the offline official SDK shipped with the skill."""
    bundled = activate_bundled_sdk()
    if importlib.util.find_spec("acp") is None:
        raise RuntimeError(
            "bundled ACP Python SDK is unavailable; reinstall the agent-swarm skill"
        )
    try:
        version = importlib.metadata.version(SDK_DISTRIBUTION)
    except importlib.metadata.PackageNotFoundError as exc:
        raise RuntimeError(
            "bundled ACP Python SDK metadata is unavailable; reinstall the agent-swarm skill"
        ) from exc
    if version != SDK_VERSION:
        raise RuntimeError(
            "bundled ACP Python SDK version %s is unsupported; reinstall the agent-swarm skill"
            % version
        )
    return {
        "distribution": SDK_DISTRIBUTION,
        "version": version,
        "requirement": SDK_REQUIREMENT,
        "source": bundled["source"],
        "bundle_key": bundled["key"],
    }


PROFILES = {
    "claude": {
        "command": "claude-agent-acp",
        "args": [],
        "model_tiers": {"strong": "opus", "balanced": "sonnet", "fast": "haiku"},
        "auth_prerequisites": ["Existing Claude login or ANTHROPIC_API_KEY"],
        "default_permission_policy": "allow_all",
        "profile_version": "0.62.0",
        "package": "@agentclientprotocol/claude-agent-acp",
        "install_hint": (
            "bun add -g @agentclientprotocol/claude-agent-acp@0.62.0"
        ),
        "sandbox": {
            "mechanism": "agent-mode",
            "workspace_write_mode": "default",
            "outside_workspace": "agent-defined",
            "missing_behavior": "fail_closed",
        },
    },
    "codex": {
        "command": "codex-acp",
        # The official App Server adapter bundles a compatible Codex runtime and
        # does not accept the legacy Rust adapter's `-c model=...` arguments.
        # Model selection happens through ACP session config. The pinned adapter
        # advertises the matching Sol/Terra/Luna tiers; an account that does not
        # offer the selected tier fails closed in configure_session.
        "args": [],
        "model_tiers": {
            "strong": "gpt-5.6-sol",
            "balanced": "gpt-5.6-terra",
            "fast": "gpt-5.6-luna",
        },
        "auth_prerequisites": [
            "Existing ChatGPT login, CODEX_API_KEY, or OPENAI_API_KEY"
        ],
        "default_permission_policy": "allow_all",
        "profile_version": "1.1.7",
        "package": "@agentclientprotocol/codex-acp",
        "install_hint": "bun add -g @agentclientprotocol/codex-acp@1.1.7",
        "sandbox": {
            "mechanism": "agent-mode",
            "workspace_write_mode": "auto",
            "outside_workspace": "agent-defined",
            "missing_behavior": "fail_closed",
        },
    },
    "gemini": {
        "command": "gemini",
        "args": ["--acp"],
        "model_tiers": {"strong": "default", "balanced": "default", "fast": "default"},
        "auth_prerequisites": ["Existing Gemini login or GEMINI_API_KEY"],
        "default_permission_policy": "allow_in_workspace",
        "profile_version": "0.41.0",
        "package": "@google/gemini-cli",
        "install_hint": "bun add -g @google/gemini-cli@0.41.0",
        "sandbox": {
            "mechanism": "agent-mode",
            "workspace_write_mode": "default",
            "outside_workspace": "agent-defined",
            "missing_behavior": "fail_closed",
        },
    },
}


def resolve_profile(agent, *, command=None, args=None):
    if agent == "custom":
        if not command:
            raise ValueError("custom ACP agent requires an explicit command")
        return {
            "agent": agent,
            "command": command,
            "args": list(args or []),
            "model_tiers": {
                "strong": "default",
                "balanced": "default",
                "fast": "default",
            },
            "auth_prerequisites": ["Agent-specific authentication"],
            "default_permission_policy": "allow_in_workspace",
            "profile_version": None,
            "package": None,
            "install_hint": None,
            "user_override": True,
            "sandbox": {
                "mechanism": "agent-specific",
                "workspace_write_mode": None,
                "outside_workspace": "unknown",
                "missing_behavior": "fail_closed",
            },
        }
    if agent not in PROFILES:
        raise ValueError("unsupported ACP agent profile: %s" % agent)
    profile = dict(PROFILES[agent])
    profile["args"] = list(profile["args"])
    profile["model_tiers"] = dict(profile["model_tiers"])
    profile["sandbox"] = dict(profile["sandbox"])
    profile["agent"] = agent
    profile["user_override"] = command is not None or args is not None
    if command is not None:
        profile["command"] = command
    if args is not None:
        profile["args"] = list(args)
    return profile


def freeze_profile(profile, *, environment=None):
    """Resolve PATH exactly once while preserving the selected executable entry."""
    frozen = dict(profile)
    frozen["args"] = list(profile.get("args") or [])
    frozen["model_tiers"] = dict(profile.get("model_tiers") or {})
    frozen["sandbox"] = dict(profile.get("sandbox") or {})
    command = profile.get("command")
    if not command:
        raise ValueError("ACP Agent command is not configured")
    if profile.get("agent") == "custom" and not os.path.isabs(command):
        raise ValueError("custom ACP command must be an absolute path")
    environment = os.environ if environment is None else environment
    if os.path.isabs(command):
        resolved = os.path.abspath(command)
    else:
        candidate = shutil.which(command, path=environment.get("PATH"))
        resolved = os.path.abspath(candidate) if candidate else None
    frozen["requested_command"] = command
    frozen["resolved_command"] = resolved
    return frozen


def ensure_available(profile, *, environment=None):
    command = profile.get("resolved_command", profile.get("command"))
    if not command:
        requested = profile.get("requested_command") or profile.get("command") or "<unset>"
        hint = profile.get("install_hint")
        message = "ACP Agent executable is unavailable or not executable: %s" % requested
        if hint and not profile.get("user_override"):
            message += "; install the pinned profile with `%s`" % hint
        raise RuntimeError(message)
    environment = os.environ if environment is None else environment
    executable = (
        command
        if os.path.isabs(command)
        else shutil.which(command, path=environment.get("PATH"))
    )
    if executable and os.access(executable, os.X_OK):
        return executable
    hint = profile.get("install_hint")
    message = "ACP Agent executable is unavailable or not executable: %s" % command
    if hint and not profile.get("user_override"):
        message += "; install the pinned profile with `%s`" % hint
    raise RuntimeError(message)


def preflight(profile, *, environment=None):
    """Return a non-mutating, non-networked command/profile/auth diagnostic."""
    report = {
        "backend": "acp",
        "agent": profile.get("agent"),
        "command": profile.get("requested_command") or profile.get("command"),
        "resolved_command": profile.get("resolved_command"),
        "args": list(profile.get("args") or []),
        "profile_version": profile.get("profile_version"),
        "package": profile.get("package"),
        "auth_prerequisites": list(profile.get("auth_prerequisites") or []),
        "default_permission_policy": profile.get("default_permission_policy"),
        "sandbox": dict(profile.get("sandbox") or {}),
        "available": False,
    }
    try:
        report["sdk"] = ensure_sdk_available()
    except RuntimeError as exc:
        report["sdk"] = {
            "requirement": SDK_REQUIREMENT,
            "available": False,
            "error": str(exc),
        }
    try:
        report["executable"] = ensure_available(profile, environment=environment)
        report["available"] = report["sdk"].get("version") == SDK_VERSION
    except RuntimeError as exc:
        report["error"] = str(exc)
    return report
