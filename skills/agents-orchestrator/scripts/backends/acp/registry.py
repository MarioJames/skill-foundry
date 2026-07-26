"""Pinned ACP Agent registry and first-use dependency preflight."""

import importlib.util
import os
import shutil

from backends.acp import dependencies


SDK_DISTRIBUTION = dependencies.SDK_DISTRIBUTION
SDK_VERSION = dependencies.SDK_VERSION
SDK_REQUIREMENT = dependencies.SDK_REQUIREMENT
DEFAULT_INSTALL_PROFILES = ("codex", "claude")


def ensure_sdk_available(*, environment=None):
    """Install on first use, activate, and verify the official ACP SDK."""
    managed = dependencies.activate(environment=environment)
    if importlib.util.find_spec("acp") is None:
        raise RuntimeError(
            "managed ACP Python SDK is unavailable; retry dependency installation"
        )
    version = managed["packages"].get(SDK_DISTRIBUTION)
    if version != SDK_VERSION:
        raise RuntimeError(
            "managed ACP Python SDK version %s is unsupported; clear the dependency "
            "cache and retry"
            % version
        )
    return {
        "distribution": SDK_DISTRIBUTION,
        "version": version,
        "requirement": SDK_REQUIREMENT,
        "source": managed["source"],
        "installed": managed["installed"],
        "installer": managed["installer"],
        "runtime_key": managed["runtime_key"],
        "target": managed["target"],
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
            "command_override": True,
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
    profile["command_override"] = command is not None
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
    frozen["requested_command"] = profile.get("requested_command") or command
    frozen["resolved_command"] = resolved
    frozen["managed_install"] = dict(profile.get("managed_install") or {})
    return frozen


def install_profile(profile, *, environment=None):
    """Install a pinned built-in profile into the private dependency home."""
    return dependencies.install_agent(profile, environment=environment)


def install_default_profiles(*, environment=None):
    """Install the default Codex and Claude ACP Agents once per dependency home."""
    return {
        name: install_profile(resolve_profile(name), environment=environment)
        for name in DEFAULT_INSTALL_PROFILES
    }


def ensure_available(profile, *, environment=None):
    command = profile.get("resolved_command", profile.get("command"))
    environment = os.environ if environment is None else environment
    executable = (
        command
        if command and os.path.isabs(command)
        else shutil.which(command, path=environment.get("PATH")) if command else None
    )
    if executable and os.access(executable, os.X_OK):
        return executable
    if profile.get("managed_install") and not profile.get("command_override"):
        restored = dependencies.install_agent(
            profile,
            environment=environment,
            dependency_home=profile["managed_install"].get("dependency_home"),
        )
        executable = restored.get("command")
        frozen = profile.get("resolved_command")
        if frozen and os.path.abspath(executable) != os.path.abspath(frozen):
            raise RuntimeError("managed ACP Agent reinstall changed its frozen executable")
        if executable and os.access(executable, os.X_OK):
            return executable
    if not command:
        requested = profile.get("requested_command") or profile.get("command") or "<unset>"
        hint = profile.get("install_hint")
        message = "ACP Agent executable is unavailable or not executable: %s" % requested
        if hint and not profile.get("user_override"):
            message += "; install the pinned profile with `%s`" % hint
        raise RuntimeError(message)
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
        report["sdk"] = dependencies.sdk_status(environment=environment)
        report["sdk"]["requirement"] = SDK_REQUIREMENT
    except RuntimeError as exc:
        report["sdk"] = {"requirement": SDK_REQUIREMENT, "available": False, "error": str(exc)}
    try:
        command = profile.get("resolved_command", profile.get("command"))
        environment = os.environ if environment is None else environment
        executable = (
            command
            if command and os.path.isabs(command)
            else shutil.which(command, path=environment.get("PATH")) if command else None
        )
        if not executable or not os.access(executable, os.X_OK):
            raise RuntimeError("ACP Agent executable is unavailable: %s" % (command or "<unset>"))
        report["executable"] = executable
        report["available"] = bool(report["sdk"].get("available"))
    except RuntimeError as exc:
        report["error"] = str(exc)
    return report
