"""Headless ACP permission policies; approval automation is not an OS sandbox."""

import json
import os
import re
import shlex


_ACTION_TYPE = re.compile(r"^[a-z][a-z0-9_]*$")
_ENV_RUNTIME_ENTRYPOINT = "$AGENT_SWARM_SKILL_DIR/scripts/agent_orchestrator.py"
_TRUSTED_SHELLS = frozenset(
    os.path.realpath(path)
    for path in (
        "/bin/bash",
        "/bin/sh",
        "/bin/zsh",
        "/usr/bin/bash",
        "/usr/bin/sh",
        "/usr/bin/zsh",
    )
    if os.path.exists(path)
)


def _kind(option):
    return str(option.get("kind") or option.get("name") or "").lower()


def _option(options, allow, *, once_only=False):
    for option in options:
        if not isinstance(option, dict) or not option.get("optionId"):
            continue
        kind = _kind(option)
        is_deny = any(token in kind for token in ("deny", "reject", "cancel"))
        is_allow = "allow" in kind or "approve" in kind
        if allow and once_only and "once" not in kind:
            continue
        if (allow and is_allow and not is_deny) or (not allow and is_deny):
            return option["optionId"]
    return None


def selected_option_allows(params, option_id):
    """Classify a decision by the offered option, never by opaque optionId text."""
    options = params.get("options") if isinstance(params, dict) else None
    for option in options if isinstance(options, list) else []:
        if not isinstance(option, dict) or option.get("optionId") != option_id:
            continue
        kind = _kind(option)
        denied = any(token in kind for token in ("deny", "reject", "cancel"))
        return not denied and any(token in kind for token in ("allow", "approve"))
    return False


def _locations(params):
    tool_call = params.get("toolCall") if isinstance(params, dict) else None
    candidates = []
    for owner in (params, tool_call):
        if not isinstance(owner, dict):
            continue
        value = owner.get("locations")
        if isinstance(value, list):
            candidates.extend(value)
    paths = []
    for location in candidates:
        path = location.get("path") if isinstance(location, dict) else location
        if not isinstance(path, str) or not os.path.isabs(path):
            return None
        paths.append(os.path.realpath(path))
    return paths or None


def _locations_declared(params):
    tool_call = params.get("toolCall") if isinstance(params, dict) else None
    for owner in (params, tool_call):
        if not isinstance(owner, dict) or "locations" not in owner:
            continue
        if owner.get("locations") not in (None, []):
            return True
    return False


def _inside(path, roots):
    for root in roots:
        try:
            if os.path.commonpath([path, root]) == root:
                return True
        except ValueError:
            continue
    return False


def _runtime_entrypoint_matches(value, runtime_entrypoint):
    if value == _ENV_RUNTIME_ENTRYPOINT:
        return True
    if not runtime_entrypoint or not os.path.isabs(value):
        return False
    return os.path.realpath(value) == os.path.realpath(runtime_entrypoint)


def _shell_tokens(script):
    if (
        not isinstance(script, str)
        or not script
        or "`" in script
        or "\n" in script
        or "\r" in script
    ):
        return None
    try:
        lexer = shlex.shlex(script, posix=True, punctuation_chars="|&;()<>")
        lexer.whitespace_split = True
        lexer.commenters = ""
        return list(lexer)
    except ValueError:
        return None


def _runtime_cli_request(params, *, cwd, runtime_entrypoint):
    """Recognize one narrowly-scoped Runtime CLI invocation from Codex ACP.

    Codex requests approval because the authenticated Runtime CLI must update
    its state outside the child workspace. Only the documented bootstrap,
    schema lookup, and JSON-to-Action forms are eligible. Shell chaining,
    redirection, alternate producers, and unrelated Runtime subcommands fail
    closed.
    """
    if not runtime_entrypoint:
        return False
    tool_call = params.get("toolCall") if isinstance(params, dict) else None
    if not isinstance(tool_call, dict) or tool_call.get("kind") != "execute":
        return False
    raw_input = tool_call.get("rawInput")
    if not isinstance(raw_input, dict):
        return False
    request_cwd = raw_input.get("cwd")
    if not isinstance(request_cwd, str) or not os.path.isabs(request_cwd):
        return False
    workspace = os.path.realpath(cwd)
    if not _inside(os.path.realpath(request_cwd), [workspace]):
        return False
    command = raw_input.get("command")
    if (
        not isinstance(command, list)
        or len(command) != 3
        or not all(isinstance(item, str) for item in command)
        or not os.path.isabs(command[0])
        or os.path.realpath(command[0]) not in _TRUSTED_SHELLS
        or command[1] not in {"-c", "-lc"}
    ):
        return False
    tokens = _shell_tokens(command[2])
    if not tokens:
        return False

    def is_runtime_command(parts):
        return (
            len(parts) >= 3
            and parts[0] == "python3"
            and _runtime_entrypoint_matches(parts[1], runtime_entrypoint)
        )

    if is_runtime_command(tokens):
        if tokens[2:] == ["bootstrap-cwd"]:
            return True
        return bool(
            len(tokens) == 4
            and tokens[2] == "action-schema"
            and _ACTION_TYPE.fullmatch(tokens[3])
        )

    prefix = "printf '%s' '"
    separator = "' | "
    if not command[2].startswith(prefix):
        return False
    remainder = command[2][len(prefix) :]
    if remainder.count(separator) != 1:
        return False
    encoded_payload, consumer_script = remainder.split(separator)
    if "'" in encoded_payload:
        return False
    consumer = _shell_tokens(consumer_script)
    if not consumer:
        return False
    try:
        payload = json.loads(encoded_payload)
    except (TypeError, ValueError):
        return False
    return bool(
        isinstance(payload, dict)
        and is_runtime_command(consumer)
        and len(consumer) == 6
        and consumer[2:4] == ["action", "--type"]
        and _ACTION_TYPE.fullmatch(consumer[4])
        and consumer[5:] == ["--stdin"]
    )


def decide_permission(
    params,
    *,
    policy,
    cwd,
    additional_directories=None,
    runtime_entrypoint=None,
):
    options = params.get("options") if isinstance(params, dict) else None
    options = options if isinstance(options, list) else []
    runtime_exception = False
    if policy == "prompt":
        raise RuntimeError("ACP permission policy 'prompt' has no headless UI")
    if policy == "allow_all":
        allow = True
    elif policy == "deny_all":
        allow = False
    elif policy == "allow_in_workspace":
        locations = _locations(params)
        roots = [os.path.realpath(cwd)]
        roots.extend(os.path.realpath(path) for path in (additional_directories or []))
        if locations:
            allow = all(_inside(path, roots) for path in locations)
        elif _locations_declared(params):
            allow = False
        else:
            runtime_exception = _runtime_cli_request(
                params,
                cwd=cwd,
                runtime_entrypoint=runtime_entrypoint,
            )
            allow = runtime_exception
    else:
        raise RuntimeError("unknown ACP permission policy: %s" % policy)
    option_id = _option(options, allow, once_only=runtime_exception)
    if option_id is None and allow:
        option_id = _option(options, False)
    if option_id is None:
        return {"outcome": {"outcome": "cancelled"}}
    return {"outcome": {"outcome": "selected", "optionId": option_id}}
