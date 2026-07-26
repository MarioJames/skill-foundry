"""Run-level execution configuration and immutable Attempt snapshots."""

import json
import os
import pathlib
import shutil

import compat_env


BACKENDS = {"claude_cli", "acp"}
PERMISSION_POLICIES = {"allow_in_workspace", "allow_all", "deny_all", "prompt"}
DEFAULT_BACKEND = "acp"
DEFAULT_PROFILE = "codex"


# The canonical family must be usable by the existing CLI/state-store modules
# that still read legacy names directly.  This is deliberately one-way at
# import; process boundaries use compat_env.export_both().
compat_env.promote_canonical_environment()


def _value(explicit, environment, suffix, default=None):
    if explicit is not None:
        return explicit
    return compat_env.value(suffix, environment, default)


def _claude_command(environment):
    override = _value(None, environment, "CLAUDE_BIN")
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
            raise ValueError(
                "AGENTS_ORCHESTRATOR_ACP_ARGS must be a JSON array"
            ) from exc
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise ValueError("ACP args must be an array of strings")
    return list(value)


def _profile_names(value):
    if value is None:
        return None
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return None
        try:
            value = json.loads(stripped)
        except ValueError:
            value = [item.strip() for item in stripped.split(",") if item.strip()]
    if isinstance(value, dict):
        value = list(value)
    if not isinstance(value, (list, tuple)) or not all(
        isinstance(item, str) and item.strip() for item in value
    ):
        raise ValueError("profile allowlist must be an array of profile names")
    names = [item.strip() for item in value]
    if len(set(names)) != len(names):
        raise ValueError("profile allowlist contains duplicate profiles")
    if not names:
        raise ValueError("profile allowlist must not be empty")
    return names


def _profile_allowlist(explicit, environment):
    if explicit is not None:
        return _profile_names(explicit)
    raw = None
    selected_suffix = None
    for suffix in (
        "ACP_PROFILE_ALLOWLIST",
        "PROFILE_ALLOWLIST",
        "ACP_PROFILES",
        "PROFILES",
        "ALLOWED_PROFILES",
    ):
        candidate = compat_env.value(suffix, environment)
        if candidate is None:
            continue
        if raw is not None and candidate != raw:
            raise ValueError(
                "conflicting profile allowlist environment: %s and %s"
                % (selected_suffix, suffix)
            )
        raw = candidate
        selected_suffix = suffix
    return _profile_names(raw)


def _default_profile(explicit, environment):
    if explicit is not None:
        return explicit
    primary = compat_env.value("ACP_DEFAULT_PROFILE", environment)
    alias = compat_env.value("DEFAULT_PROFILE", environment)
    if primary is not None and alias is not None and primary != alias:
        raise ValueError(
            "conflicting default profile environment: "
            "ACP_DEFAULT_PROFILE and DEFAULT_PROFILE"
        )
    return primary or alias


def _freeze_acp_profile(
    name,
    *,
    registry,
    environment,
    command=None,
    args=None,
    permission=None,
    install_dependencies=False,
):
    profile = registry.resolve_profile(name, command=command, args=args)
    selected_permission = (
        permission
        or profile.get("default_permission_policy")
        or "allow_in_workspace"
    )
    if selected_permission not in PERMISSION_POLICIES:
        raise ValueError(
            "unsupported ACP permission policy: %s" % selected_permission
        )
    if selected_permission == "prompt":
        raise ValueError("ACP permission policy 'prompt' has no headless UI")
    if install_dependencies and not profile.get("command_override"):
        profile = registry.install_profile(profile, environment=environment)
    profile = registry.freeze_profile(profile, environment=environment)
    return {
        "backend": "acp",
        "agent": name,
        "command": profile["command"],
        "requested_command": profile["requested_command"],
        "resolved_command": profile["resolved_command"],
        "args": list(profile["args"]),
        "model_tiers": dict(profile["model_tiers"]),
        "auth_prerequisites": list(profile["auth_prerequisites"]),
        "default_permission_policy": profile["default_permission_policy"],
        "profile_version": profile["profile_version"],
        "package": profile["package"],
        "install_hint": profile["install_hint"],
        "user_override": profile["user_override"],
        "command_override": profile.get("command_override", False),
        "managed_install": dict(profile.get("managed_install") or {}),
        "sandbox": dict(profile["sandbox"]),
        "permission_policy": selected_permission,
        "prompt_timeout_seconds": None,
        "session_close_on_stop": True,
        "turn_end_reprompt_limit": 1,
    }


def _legacy_claude_profile(environment):
    return {
        "backend": "claude_cli",
        "agent": "claude",
        "command": _claude_command(environment),
        "args": [],
        "model_tiers": {
            "strong": "opus",
            "balanced": "sonnet",
            "fast": "haiku",
        },
        "permission_policy": "bypassPermissions",
    }


def resolve_run_execution(
    *,
    backend=None,
    acp_agent=None,
    acp_command=None,
    acp_args=None,
    acp_permission_policy=None,
    profile_allowlist=None,
    allowed_profiles=None,
    profiles=None,
    default_profile=None,
    environment=None,
    install_dependencies=False,
):
    """Resolve init CLI > environment > defaults exactly once for a Run."""
    environment = os.environ if environment is None else environment
    compat_env.validate_identity(environment)
    backend = _value(backend, environment, "BACKEND", DEFAULT_BACKEND)
    if backend not in BACKENDS:
        raise ValueError("backend must be claude_cli or acp")
    declared_arguments = [
        value
        for value in (profile_allowlist, allowed_profiles, profiles)
        if value is not None
    ]
    if len(declared_arguments) > 1:
        raise ValueError(
            "provide only one of profile_allowlist, allowed_profiles, or profiles"
        )
    declared_profiles = _profile_allowlist(
        declared_arguments[0] if declared_arguments else None,
        environment,
    )
    explicit_default = _default_profile(default_profile, environment)
    agent = _value(acp_agent, environment, "ACP_AGENT")
    command = _value(acp_command, environment, "ACP_COMMAND")
    raw_args = (
        acp_args
        if acp_args is not None
        else _value(None, environment, "ACP_ARGS")
    )
    args = _args(raw_args)
    permission = _value(
        acp_permission_policy,
        environment,
        "ACP_PERMISSION_POLICY",
    )
    if command is not None and (not isinstance(command, str) or not command):
        raise ValueError("ACP command must be a non-empty string")

    if backend == "claude_cli":
        # Persisted/explicit legacy backend selection remains authoritative.
        # Historical callers sometimes leave ACP environment defaults present;
        # they must not reinterpret an explicitly selected Claude CLI Run.
        profile = _legacy_claude_profile(environment)
        return {
            "backend": "claude_cli",
            "default_profile": "claude_cli",
            "profile_allowlist": ["claude_cli"],
            "profiles": {"claude_cli": profile},
            "claude_cli": {"command": profile["command"]},
            "acp": {},
            "routing": {
                "strategy": "round_robin",
                "by_intent": {},
                "by_model_tier": {},
            },
        }

    if agent is not None and (not isinstance(agent, str) or not agent):
        raise ValueError("ACP agent must be a non-empty string")
    if explicit_default is not None and (
        not isinstance(explicit_default, str) or not explicit_default.strip()
    ):
        raise ValueError("default profile must be a non-empty string")
    selected_default = (
        explicit_default.strip()
        if isinstance(explicit_default, str)
        else agent
    )
    if declared_profiles is None:
        selected_default = selected_default or DEFAULT_PROFILE
        declared_profiles = [selected_default]
    else:
        selected_default = selected_default or (
            DEFAULT_PROFILE if DEFAULT_PROFILE in declared_profiles else declared_profiles[0]
        )
    if agent is not None and selected_default != agent:
        raise ValueError("ACP agent conflicts with the default profile")
    if selected_default not in declared_profiles:
        raise ValueError("default profile must be present in the profile allowlist")
    if "custom" in declared_profiles and (
        len(declared_profiles) != 1 or selected_default != "custom"
    ):
        raise ValueError("custom ACP profile must be the sole allowlisted profile")
    if (command is not None or raw_args is not None) and selected_default not in declared_profiles:
        raise ValueError("ACP executable override must target an allowlisted profile")

    from backends.acp import registry

    if install_dependencies:
        registry.ensure_sdk_available(environment=environment)
        registry.install_default_profiles(environment=environment)
    profiles = {}
    for name in declared_profiles:
        profiles[name] = _freeze_acp_profile(
            name,
            registry=registry,
            environment=environment,
            command=command if name == selected_default else None,
            args=(args if raw_args is not None else None)
            if name == selected_default
            else None,
            permission=permission,
            install_dependencies=install_dependencies,
        )
    default_record = profiles[selected_default]
    return {
        "backend": "acp",
        "default_profile": selected_default,
        "profile_allowlist": list(declared_profiles),
        "profiles": profiles,
        "claude_cli": {"command": _claude_command(environment)},
        # Keep the historical singular view for persisted callers and doctor.
        "acp": dict(default_record),
        "routing": {
            "strategy": "round_robin",
            "by_intent": {},
            "by_model_tier": {},
        },
    }


def load_run_execution(run):
    raw = run.get("execution_config_json") if run else None
    if not raw:
        # Runs from before execution_config_json existed were Claude CLI Runs.
        # Recovery must not reinterpret them using the new Codex default.
        return resolve_run_execution(
            backend="claude_cli",
            environment={"PATH": os.environ.get("PATH", "")},
        )
    try:
        value = json.loads(raw)
    except (TypeError, ValueError) as exc:
        raise ValueError("run execution_config_json is invalid") from exc
    if not isinstance(value, dict) or value.get("backend") not in BACKENDS:
        raise ValueError("run execution_config_json has an unsupported backend")
    return value


def _allowed_profiles(execution):
    profiles = execution.get("profiles")
    allowlist = execution.get("profile_allowlist")
    if isinstance(profiles, dict) and isinstance(allowlist, list) and allowlist:
        if not all(
            isinstance(name, str) and name in profiles
            for name in allowlist
        ):
            raise ValueError("run profile allowlist is invalid")
        default = execution.get("default_profile")
        if default not in allowlist:
            raise ValueError("run default profile is not allowlisted")
        return list(allowlist), profiles, default

    # Compatibility representation for already-persisted Runs.
    if execution["backend"] == "claude_cli":
        profile = _legacy_claude_profile(
            {"PATH": os.environ.get("PATH", "")}
        )
        profile["command"] = (
            execution.get("claude_cli", {}).get("command") or "claude"
        )
        return ["claude_cli"], {"claude_cli": profile}, "claude_cli"
    acp = dict(execution.get("acp") or {})
    name = acp.get("agent") or "claude"
    acp["backend"] = "acp"
    acp["agent"] = name
    return [name], {name: acp}, name


def select_profile(execution, *, profile_hint=None, routing_index=0):
    allowlist, profiles, default = _allowed_profiles(execution)
    if profile_hint is not None:
        if not isinstance(profile_hint, str) or not profile_hint:
            raise ValueError("child profile_hint must be a non-empty string")
        if profile_hint not in allowlist:
            raise ValueError(
                "child profile_hint is not present in the Run profile allowlist"
            )
        return profile_hint, profiles[profile_hint]
    if len(allowlist) == 1:
        return default, profiles[default]
    try:
        index = int(routing_index)
    except (TypeError, ValueError) as exc:
        raise ValueError("profile routing index must be an integer") from exc
    start = allowlist.index(default)
    name = allowlist[(start + index) % len(allowlist)]
    return name, profiles[name]


def snapshot_attempt(
    run,
    *,
    model=None,
    model_tier=None,
    profile_hint=None,
    routing_index=0,
):
    """Flatten the persisted Run config into an immutable Attempt record."""
    execution = load_run_execution(run)
    profile_name, profile = select_profile(
        execution,
        profile_hint=profile_hint,
        routing_index=routing_index,
    )
    backend = profile.get("backend") or execution["backend"]
    if model_tier is not None:
        model = dict(profile.get("model_tiers") or {}).get(model_tier, model_tier)
    if backend == "claude_cli":
        return {
            "backend": backend,
            "agent": "claude",
            "profile": profile_name,
            "command": profile.get("command") or "claude",
            "args": [],
            "model": model,
            "permission_policy": "bypassPermissions",
        }
    return {
        "backend": backend,
        "agent": profile.get("agent") or profile_name,
        "profile": profile_name,
        "command": profile.get("resolved_command"),
        "requested_command": profile.get("requested_command") or profile.get("command"),
        "args": list(profile.get("args") or []),
        "model": model,
        "permission_policy": profile.get("permission_policy") or "allow_in_workspace",
        "prompt_timeout_seconds": profile.get("prompt_timeout_seconds"),
        "session_close_on_stop": profile.get("session_close_on_stop", True),
        "turn_end_reprompt_limit": profile.get("turn_end_reprompt_limit", 1),
        "profile_version": profile.get("profile_version"),
        "package": profile.get("package"),
        "install_hint": profile.get("install_hint"),
        "auth_prerequisites": list(profile.get("auth_prerequisites") or []),
        "user_override": bool(profile.get("user_override")),
        "command_override": bool(profile.get("command_override")),
        "managed_install": dict(profile.get("managed_install") or {}),
        "sandbox": dict(profile.get("sandbox") or {}),
    }


def supports_hooks(execution):
    return execution.get("backend") == "claude_cli"
