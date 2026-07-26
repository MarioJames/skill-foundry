"""Model tier selection from parent-provided task metadata."""

import json


TIERS = {"strong", "balanced", "fast"}


def select_model_tier(task):
    explicit = task.get("model_tier_hint")
    if explicit in TIERS:
        return explicit
    intent = task.get("intent_hint")
    complexity = task.get("complexity_hint") or "medium"
    if intent == "design" or complexity == "high":
        return "strong"
    if intent in {"review", "integrate"} or complexity == "medium":
        return "balanced"
    return "fast"


def profile_hint(task):
    """Read only the declarative profile name carried by a child Task.

    The current task schema has no profile column, so the compatibility path
    stores the hint inside ``constraints_json``.  A direct field is accepted
    for integration callers and future schema versions.  Executables, args,
    models, and permissions are never read from the child Task.
    """
    direct = task.get("profile_hint")
    try:
        constraints = json.loads(task.get("constraints_json") or "{}")
    except (TypeError, ValueError) as exc:
        raise ValueError("task constraints_json is invalid") from exc
    nested = constraints.get("profile_hint") if isinstance(constraints, dict) else None
    if direct is not None and nested is not None and direct != nested:
        raise ValueError("conflicting child profile_hint values")
    hint = direct if direct is not None else nested
    if hint is not None and (not isinstance(hint, str) or not hint):
        raise ValueError("child profile_hint must be a non-empty string")
    return hint


def profile_allowlist(run):
    try:
        execution = json.loads(run.get("execution_config_json") or "{}")
    except (TypeError, ValueError) as exc:
        raise ValueError("run execution_config_json is invalid") from exc
    allowlist = execution.get("profile_allowlist")
    profiles = execution.get("profiles")
    if isinstance(allowlist, list) and allowlist and isinstance(profiles, dict):
        if not all(
            isinstance(name, str) and name in profiles
            for name in allowlist
        ):
            raise ValueError("run profile allowlist is invalid")
        return list(allowlist)
    if execution.get("backend") == "acp":
        return [(execution.get("acp") or {}).get("agent") or "claude"]
    return ["claude_cli"]


def select_profile(run, task, *, routing_index=0):
    allowlist = profile_allowlist(run)
    hint = profile_hint(task)
    if hint is not None:
        if hint not in allowlist:
            raise ValueError(
                "child profile_hint is not present in the Run profile allowlist"
            )
        return hint
    if len(allowlist) == 1:
        return allowlist[0]
    execution = json.loads(run.get("execution_config_json") or "{}")
    default = execution.get("default_profile")
    if default not in allowlist:
        raise ValueError("run default profile is not allowlisted")
    start = allowlist.index(default)
    return allowlist[(start + int(routing_index)) % len(allowlist)]


def resolve_model(run, tier, *, profile_name=None):
    if profile_name is not None:
        try:
            execution = json.loads(run.get("execution_config_json") or "{}")
        except (TypeError, ValueError) as exc:
            raise ValueError("run execution_config_json is invalid") from exc
        profile = (execution.get("profiles") or {}).get(profile_name)
        if isinstance(profile, dict):
            return dict(profile.get("model_tiers") or {}).get(tier, tier)

    mapping = json.loads(run.get("model_tiers_json") or "{}")
    return mapping.get(tier, tier)
