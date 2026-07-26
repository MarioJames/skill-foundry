"""Pure validation and canonicalization helpers for persistent orchestration modes."""

import hashlib
import json
import re


MODE_KINDS = {"swarm", "develop_review_improve", "multi_session_review"}
MODE_ALIASES = {
    "develop-review-improve": "develop_review_improve",
    "multi-session-review": "multi_session_review",
}
MODE_TERMINAL = {"completed", "blocked", "failed", "cancelled"}
FINDING_SEVERITIES = {"low", "medium", "high", "critical"}
VERIFICATION_VERDICTS = {"confirmed", "rejected", "unresolved"}
MAX_EVIDENCE_BYTES = 12_000
RESERVED_EVIDENCE_PREVIEW_BYTES = 1_024
LOOP_PHASES = [
    "develop",
    "validate",
    "review",
    "verify",
    "improve",
    "revalidate",
    "re_review",
]
LOOP_EXIT_CONDITIONS = {
    "passed": "clean_review",
    "validation_failure": "blocked",
    "high_severity_unresolved": "blocked",
    "max_rounds": "budget_exhausted",
    "no_progress": "no_progress",
}
COMMON_CONFIG_FIELDS = {
    "max_rounds",
    "max_tasks",
    "max_candidates",
    "max_expansions",
    "max_seconds",
    "max_mode_depth",
    "max_no_progress",
    "create_fix_tasks",
}


START_MODE_SCHEMA = {
    "title": "start_mode",
    "type": "object",
    "required": ["mode", "objective"],
    "properties": {
        "mode": {"enum": sorted(MODE_KINDS | set(MODE_ALIASES))},
        "objective": {"type": "string"},
        "parent_mode_id": {"type": ["integer", "null"]},
        "tasks": {"type": "array"},
        "config": {
            "type": "object",
            "properties": {
                "reviewers": {
                    "type": "array",
                    "minItems": 3,
                    "items": {
                        "type": "object",
                        "required": ["id"],
                        "properties": {
                            "id": {"type": "string", "minLength": 1},
                            "profile_hint": {
                                "type": ["string", "null"],
                                "minLength": 1,
                            },
                        },
                    },
                },
                "phases": {
                    "type": "array",
                    "items": {"enum": LOOP_PHASES},
                },
                "exit_conditions": {"type": "object"},
            },
        },
        "evidence": {},
    },
}


ADVANCE_MODE_SCHEMA = {
    "title": "advance_mode",
    "type": "object",
    "required": ["mode_id"],
    "properties": {
        "mode_id": {"type": "integer"},
        "operation": {"enum": ["advance", "cancel"]},
        "reason": {"type": "string"},
    },
}


def canonical_json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(value):
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def _text(value):
    return re.sub(r"\s+", " ", str(value or "").strip()).casefold()


def _utf8_prefix(encoded, limit):
    return encoded[:limit].decode("utf-8", errors="ignore")


def _sectioned_content(value, limit, reserved_keys):
    """Bound an object while guaranteeing previews for its reserved sections."""
    encoded_sections = {
        key: canonical_json(value[key]).encode("utf-8") for key in sorted(value)
    }
    sections = {
        key: {
            "sha256": hashlib.sha256(encoded).hexdigest(),
            "bytes": len(encoded),
            "truncated": True,
            "content": "",
        }
        for key, encoded in encoded_sections.items()
    }
    envelope = {
        "format": "sectioned-canonical-json-v1",
        "sections": sections,
    }

    def render():
        return canonical_json(envelope).encode("utf-8")

    if len(render()) > limit:
        raise ValueError("evidence limit is too small for reserved section metadata")

    def grow(key, maximum):
        encoded = encoded_sections[key]
        current = len(sections[key]["content"].encode("utf-8"))
        low = current
        high = min(maximum, len(encoded))
        best = current
        while low <= high:
            requested = (low + high) // 2
            preview = _utf8_prefix(encoded, requested)
            sections[key]["content"] = preview
            sections[key]["truncated"] = len(preview.encode("utf-8")) < len(encoded)
            if len(render()) <= limit:
                best = requested
                low = requested + 1
            else:
                high = requested - 1
        preview = _utf8_prefix(encoded, best)
        sections[key]["content"] = preview
        sections[key]["truncated"] = len(preview.encode("utf-8")) < len(encoded)

    present_reserved = [key for key in reserved_keys if key in encoded_sections]
    for key in present_reserved:
        grow(key, RESERVED_EVIDENCE_PREVIEW_BYTES)
    for key in sorted(set(encoded_sections) - set(present_reserved)):
        grow(key, len(encoded_sections[key]))
    for key in present_reserved:
        grow(key, len(encoded_sections[key]))
    return render().decode("utf-8")


def bounded_bundle(value, limit=MAX_EVIDENCE_BYTES, *, reserved_keys=()):
    """Return bounded content plus a stable hash of the unabridged canonical payload.

    Oversized objects with reserved keys use a deterministic sectioned envelope so one
    large section cannot hide every reserved section from the resulting evidence.
    """
    encoded = canonical_json(value).encode("utf-8")
    if len(encoded) > limit and reserved_keys and isinstance(value, dict):
        content = _sectioned_content(value, limit, reserved_keys)
    else:
        content = _utf8_prefix(encoded, limit)
    return {
        "sha256": hashlib.sha256(encoded).hexdigest(),
        "bytes": len(encoded),
        "truncated": len(encoded) > limit,
        "content": content,
    }


def finding_fingerprint(finding):
    """Generate a stable Runtime-owned fingerprint, excluding mutable severity/evidence."""
    identity = {
        "rule": _text(finding.get("rule")),
        "title": _text(finding.get("title")),
        "description": _text(finding.get("description")),
        "location": _text(finding.get("location")),
    }
    return "finding_" + digest(identity)[:24]


def validate_finding(value, label="finding", *, require_standard=False):
    if not isinstance(value, dict):
        raise ValueError("%s must be an object" % label)
    title = value.get("title")
    description = value.get("description")
    severity = value.get("severity")
    evidence = value.get("evidence")
    claim = value.get("claim")
    impact = value.get("impact")
    confidence = value.get("confidence")
    if not isinstance(title, str) or not title.strip():
        raise ValueError("%s.title is required" % label)
    if not isinstance(description, str) or not description.strip():
        raise ValueError("%s.description is required" % label)
    if severity not in FINDING_SEVERITIES:
        raise ValueError("%s.severity must be low, medium, high, or critical" % label)
    if not isinstance(evidence, list) or not evidence or not all(
        isinstance(item, (str, dict)) for item in evidence
    ):
        raise ValueError("%s.evidence must be a non-empty array" % label)
    if require_standard:
        if not isinstance(claim, str) or not claim.strip():
            raise ValueError("%s.claim is required" % label)
        if not isinstance(impact, str) or not impact.strip():
            raise ValueError("%s.impact is required" % label)
        if (
            isinstance(confidence, bool)
            or not isinstance(confidence, (int, float))
            or not 0 <= confidence <= 1
        ):
            raise ValueError("%s.confidence must be a number in 0..1" % label)
    elif confidence is not None and (
        isinstance(confidence, bool)
        or not isinstance(confidence, (int, float))
        or not 0 <= confidence <= 1
    ):
        raise ValueError("%s.confidence must be a number in 0..1" % label)
    normalized = {
        "rule": str(value.get("rule") or "").strip(),
        "title": title.strip(),
        "description": description.strip(),
        "location": str(value.get("location") or "").strip(),
        "severity": severity,
        "evidence": evidence,
        # Legacy persisted mode results may predate the standard consensus
        # fields. Preserve them without blocking recovery, while new finish
        # payloads use require_standard=True and must supply all three.
        "claim": claim.strip() if isinstance(claim, str) and claim.strip() else title.strip(),
        "impact": (
            impact.strip()
            if isinstance(impact, str) and impact.strip()
            else description.strip()
        ),
        "confidence": float(confidence) if confidence is not None else None,
    }
    normalized["fingerprint"] = finding_fingerprint(normalized)
    return normalized


def _integer(config, name, default, minimum, maximum):
    value = config.get(name, default)
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise ValueError("%s must be an integer in %d..%d" % (name, minimum, maximum))
    return value


def normalize_config(kind, supplied):
    if supplied is None:
        supplied = {}
    if not isinstance(supplied, dict):
        raise ValueError("start_mode config must be an object")
    allowed = set(COMMON_CONFIG_FIELDS)
    if kind == "multi_session_review":
        allowed.add("reviewers")
    if kind == "develop_review_improve":
        allowed.update({"phases", "exit_conditions"})
    unknown = sorted(set(supplied) - allowed)
    if unknown:
        raise ValueError(
            "unsupported %s config fields: %s" % (kind, ", ".join(unknown))
        )
    config = {
        key: value for key, value in supplied.items() if key in COMMON_CONFIG_FIELDS
    }
    config["max_rounds"] = _integer(config, "max_rounds", 3, 1, 20)
    config["max_tasks"] = _integer(config, "max_tasks", 50, 1, 500)
    config["max_candidates"] = _integer(config, "max_candidates", 50, 1, 200)
    config["max_expansions"] = _integer(config, "max_expansions", 10, 0, 100)
    config["max_seconds"] = _integer(config, "max_seconds", 3600, 1, 86_400)
    config["max_mode_depth"] = _integer(config, "max_mode_depth", 4, 0, 8)
    config["max_no_progress"] = _integer(config, "max_no_progress", 2, 1, 5)
    config["create_fix_tasks"] = config.get("create_fix_tasks", True)
    if not isinstance(config["create_fix_tasks"], bool):
        raise ValueError("create_fix_tasks must be boolean")
    if kind == "develop_review_improve":
        phases = supplied.get("phases", LOOP_PHASES)
        if phases != LOOP_PHASES:
            raise ValueError(
                "develop_review_improve phases must declare the canonical v1 phase order: %s"
                % ", ".join(LOOP_PHASES)
            )
        exit_conditions = supplied.get("exit_conditions", LOOP_EXIT_CONDITIONS)
        if exit_conditions != LOOP_EXIT_CONDITIONS:
            raise ValueError(
                "develop_review_improve exit_conditions must declare the canonical v1 contract"
            )
        config["phases"] = list(phases)
        config["exit_conditions"] = dict(exit_conditions)
    if kind == "multi_session_review":
        reviewers = supplied.get("reviewers")
        if reviewers is None:
            reviewers = [
                {"id": "reviewer-%d" % index, "profile_hint": None}
                for index in range(1, 4)
            ]
        if not isinstance(reviewers, list) or len(reviewers) < 3:
            raise ValueError("multi_session_review requires at least 3 reviewers")
        normalized = []
        identifiers = set()
        for reviewer in reviewers:
            if not isinstance(reviewer, dict):
                raise ValueError("reviewers must be objects")
            identifier = reviewer.get("id")
            if not isinstance(identifier, str) or not identifier.strip():
                raise ValueError("reviewer.id is required")
            identifier = identifier.strip()
            if identifier in identifiers:
                raise ValueError("reviewer ids must be independent and unique")
            identifiers.add(identifier)
            profile_hint = reviewer.get("profile_hint")
            if profile_hint is not None and (
                not isinstance(profile_hint, str) or not profile_hint.strip()
            ):
                raise ValueError("reviewer.profile_hint must be a non-empty profile name")
            normalized.append(
                {
                    "id": identifier,
                    "profile_hint": profile_hint.strip() if profile_hint else None,
                }
            )
        config["reviewers"] = normalized
    return config


def validate_start_payload(payload):
    if not isinstance(payload, dict):
        raise ValueError("start_mode payload must be an object")
    kind = MODE_ALIASES.get(payload.get("mode"), payload.get("mode"))
    objective = payload.get("objective")
    if kind not in MODE_KINDS:
        raise ValueError("start_mode mode is unsupported")
    if not isinstance(objective, str) or not objective.strip():
        raise ValueError("start_mode objective is required")
    parent_mode_id = payload.get("parent_mode_id")
    if parent_mode_id is not None and (
        isinstance(parent_mode_id, bool) or not isinstance(parent_mode_id, int)
    ):
        raise ValueError("parent_mode_id must be an integer or null")
    if kind == "swarm":
        tasks = payload.get("tasks")
        if not isinstance(tasks, list) or not tasks:
            raise ValueError("swarm mode requires a non-empty tasks array")
    return {
        "kind": kind,
        "objective": objective.strip(),
        "parent_mode_id": parent_mode_id,
        "tasks": payload.get("tasks"),
        "config": normalize_config(kind, payload.get("config")),
        "evidence_bundle": bounded_bundle(payload.get("evidence", {})),
    }


def _findings(result):
    values = result.get("findings", [])
    if not isinstance(values, list):
        raise ValueError("mode_result.findings must be an array")
    return [
        validate_finding(
            value,
            "mode_result.findings[%d]" % index,
            require_standard=True,
        )
        for index, value in enumerate(values)
    ]


def _evidence(result, role):
    evidence = result.get("evidence")
    if not isinstance(evidence, list) or not evidence:
        raise ValueError("%s mode_result.evidence must be a non-empty array" % role)
    return evidence


def validate_mode_result(link, mode, result):
    if not isinstance(result, dict):
        raise ValueError("done mode task requires mode_result object")
    role = link["role"]
    kind = mode["kind"]
    normalized = dict(result)
    if role == "swarm":
        if result.get("status") not in {"done", "partial"}:
            raise ValueError("swarm mode_result.status must be done or partial")
        _evidence(result, role)
    elif role == "developer":
        if not isinstance(result.get("summary"), str) or not result["summary"].strip():
            raise ValueError("developer mode_result.summary is required")
        _evidence(result, role)
    elif role == "validator":
        expected_stage = (
            "revalidation" if link.get("phase") == "revalidate" else "validation"
        )
        if result.get("stage") != expected_stage:
            raise ValueError(
                "validator mode_result.stage must be %s" % expected_stage
            )
        if result.get("status") not in {"passed", "failed", "blocked"}:
            raise ValueError(
                "validator mode_result.status must be passed, failed, or blocked"
            )
        commands = result.get("commands")
        if not isinstance(commands, list) or not commands or not all(
            isinstance(item, str) and item.strip() for item in commands
        ):
            raise ValueError(
                "validator mode_result.commands must be a non-empty string array"
            )
        artifact_version = result.get("artifact_version")
        if not isinstance(artifact_version, str) or not artifact_version.strip():
            raise ValueError("validator mode_result.artifact_version is required")
        _evidence(result, role)
    elif role == "reviewer":
        normalized["findings"] = _findings(result)
        if kind == "develop_review_improve":
            if result.get("verdict") not in {"pass", "changes_requested", "blocked"}:
                raise ValueError("loop reviewer mode_result.verdict is invalid")
            if result["verdict"] == "changes_requested" and not normalized["findings"]:
                raise ValueError("changes_requested requires at least one finding")
    elif role in {"verifier_reproduce", "verifier_falsify"}:
        expected = link.get("candidate_fingerprint")
        if result.get("candidate_fingerprint") != expected:
            raise ValueError("verifier candidate_fingerprint does not match assigned candidate")
        if result.get("verdict") not in VERIFICATION_VERDICTS:
            raise ValueError("verifier mode_result.verdict is invalid")
        evidence = result.get("evidence")
        if not isinstance(evidence, list) or not evidence:
            raise ValueError("verifier mode_result.evidence must be a non-empty array")
        discovered = result.get("discovered_findings", [])
        if not isinstance(discovered, list):
            raise ValueError("verifier discovered_findings must be an array")
        normalized["discovered_findings"] = [
            validate_finding(
                value,
                "mode_result.discovered_findings[%d]" % index,
                require_standard=True,
            )
            for index, value in enumerate(discovered)
        ]
    elif role == "improver":
        if not isinstance(result.get("changed"), bool):
            raise ValueError("improver mode_result.changed must be boolean")
        if not isinstance(result.get("addressed_fingerprints", []), list):
            raise ValueError("improver addressed_fingerprints must be an array")
        _evidence(result, role)
    elif role == "fixer":
        fixed = result.get("fixed_fingerprints")
        if not isinstance(fixed, list) or link.get("candidate_fingerprint") not in fixed:
            raise ValueError("fixer must report its assigned confirmed fingerprint")
        if not isinstance(result.get("evidence"), list) or not result["evidence"]:
            raise ValueError("fixer mode_result.evidence must be a non-empty array")
    else:
        raise ValueError("unsupported mode task role: %s" % role)
    normalized.pop("runtime_result_fingerprint", None)
    normalized["runtime_result_fingerprint"] = digest(normalized)
    return normalized
