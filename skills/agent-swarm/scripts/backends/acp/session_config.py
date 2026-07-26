"""Apply immutable Attempt settings using only Agent-advertised ACP options."""


MODE_PREFERENCES = {
    "allow_in_workspace": ("agent", "default", "auto"),
    "allow_all": ("agent-full-access", "bypassPermissions", "full-access"),
    "deny_all": ("dontAsk", "read-only", "plan"),
}


def _values(option):
    values = []
    for entry in option.get("options") or []:
        if not isinstance(entry, dict):
            continue
        if isinstance(entry.get("options"), list):
            for nested in entry["options"]:
                if isinstance(nested, dict) and isinstance(nested.get("value"), str):
                    values.append(nested["value"])
        elif isinstance(entry.get("value"), str):
            values.append(entry["value"])
    return values


def _find(options, category):
    for option in options or []:
        if not isinstance(option, dict):
            continue
        if option.get("category") == category or option.get("id") == category:
            return option
    return None


def _set(client, session_id, option, value):
    if option.get("currentValue") != value:
        client.set_config_option(session_id, option["id"], value, timeout=10)
    return value


def configure_session(client, session_id, options, *, model, permission_policy):
    """Set model/mode if advertised; reject unsupported explicit model choices."""
    configured = {}
    model_option = _find(options, "model")
    if model_option is not None:
        offered = _values(model_option)
        if model not in {None, "default"} and model not in offered:
            raise RuntimeError("ACP model is not offered by Agent: %s" % model)
        target = model if model in offered else model_option.get("currentValue")
        if target is not None:
            configured["model"] = _set(client, session_id, model_option, target)
    elif model not in {None, "default"}:
        raise RuntimeError("ACP Agent did not offer model configuration for %s" % model)

    if permission_policy == "prompt":
        raise RuntimeError("ACP permission policy 'prompt' has no headless UI")
    mode_option = _find(options, "mode")
    if mode_option is not None:
        offered = _values(mode_option)
        target = next(
            (value for value in MODE_PREFERENCES[permission_policy] if value in offered),
            None,
        )
        if target is None and permission_policy in {"allow_in_workspace", "deny_all"}:
            raise RuntimeError(
                "ACP Agent did not offer a safe mode for permission policy %s"
                % permission_policy
            )
        if target is not None:
            configured["mode"] = _set(client, session_id, mode_option, target)
    return configured
