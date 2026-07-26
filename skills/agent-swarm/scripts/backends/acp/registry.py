"""Pinned ACP Agent profiles and explicit executable preflight."""

import os
import shutil


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
    """Resolve the executable exactly once; Workers never repeat PATH lookup."""
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
        resolved = os.path.realpath(command)
    else:
        candidate = shutil.which(command, path=environment.get("PATH"))
        resolved = os.path.realpath(candidate) if candidate else None
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
        report["executable"] = ensure_available(profile, environment=environment)
        report["available"] = True
    except RuntimeError as exc:
        report["error"] = str(exc)
    return report
