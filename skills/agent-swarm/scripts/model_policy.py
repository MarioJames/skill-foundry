"""Model tier selection from parent-provided task metadata."""


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


def resolve_model(run, tier):
    import json

    mapping = json.loads(run.get("model_tiers_json") or "{}")
    return mapping.get(tier, tier)
