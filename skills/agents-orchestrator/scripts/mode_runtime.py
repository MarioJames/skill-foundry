"""Persistent orchestration mode state machines compiled onto the existing task tree."""

import json

import execution_config
import mode_models
import state_store


TERMINAL_TASKS = {"done", "failed", "blocked", "cancelled"}
SEVERITY_RANK = {"low": 0, "medium": 1, "high": 2, "critical": 3}


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def _decoded(row, key):
    return json.loads(row.get(key) or "{}")


def _owner_constraints(context):
    return _decoded(context["task"], "constraints_json")


def _task_constraints(context, *, read_only, notes, profile_hint=None):
    parent = _owner_constraints(context)
    value = {
        "write_scope": [] if read_only else list(parent.get("write_scope") or []),
        "read_only": bool(read_only or parent.get("read_only")),
        "notes": list(parent.get("notes") or []) + list(notes),
    }
    if profile_hint is not None:
        value["profile_hint"] = profile_hint
    return value


def _output_contract(role):
    contracts = {
        "swarm": (
            "Complete the assigned task and finish with mode_result "
            '{"status":"done|partial","evidence":[...]} as well as normal finish fields.'
        ),
        "developer": (
            "Develop the requested round and finish with mode_result "
            '{"summary":"...","state":{...},"evidence":[...]} as well as normal finish fields.'
        ),
        "validator": (
            "Run deterministic validation without modifying files. Finish with mode_result "
            '{"stage":"validation|revalidation","status":"passed|failed|blocked",'
            '"artifact_version":"...","commands":[...],"evidence":[...]}.'
        ),
        "reviewer": (
            "Independently review the supplied bounded evidence. Finish with mode_result containing "
            '"findings":[{"title","description","claim","severity","location","rule","evidence",'
            '"impact","confidence"}]. For develop_review_improve also include '
            '"verdict":"pass|changes_requested|blocked". The normal finish review object uses '
            '"source":"self".'
        ),
        "verifier_reproduce": (
            "Reproduce the assigned candidate independently. Finish with mode_result containing "
            '"candidate_fingerprint", "verdict":"confirmed|rejected|unresolved", non-empty '
            '"evidence", and optional "discovered_findings".'
        ),
        "verifier_falsify": (
            "Try to falsify the assigned candidate independently. Report the candidate truth, not "
            "whether the falsification attempt itself ran: finish with mode_result containing "
            '"candidate_fingerprint", "verdict":"confirmed|rejected|unresolved", non-empty '
            '"evidence", and optional "discovered_findings".'
        ),
        "improver": (
            "Improve the prior result using the review findings. Finish with mode_result "
            '{"changed":true|false,"addressed_fingerprints":[...],"evidence":[...]}.'
        ),
        "fixer": (
            "Fix only the assigned confirmed finding. Finish with mode_result "
            '{"fixed_fingerprints":[...],"evidence":[...]} including the assigned fingerprint.'
        ),
    }
    return contracts[role]


def _round(con, mode):
    return con.execute(
        "SELECT * FROM mode_rounds WHERE mode_id=? AND round_no=?",
        (mode["mode_id"], mode["current_round"]),
    ).fetchone()


def _new_round(con, mode_id, round_no, phase):
    timestamp = state_store.now()
    cursor = con.execute(
        """INSERT INTO mode_rounds(
             mode_id, round_no, phase, status, started_at
           ) VALUES (?, ?, ?, 'active', ?)""",
        (mode_id, round_no, phase, timestamp),
    )
    return cursor.lastrowid


def _set_phase(con, mode, phase, *, round_no=None):
    timestamp = state_store.now()
    target_round = int(round_no or mode["current_round"])
    con.execute(
        "UPDATE modes SET phase=?, current_round=?, updated_at=? WHERE mode_id=?",
        (phase, target_round, timestamp, mode["mode_id"]),
    )
    con.execute(
        "UPDATE mode_rounds SET phase=? WHERE mode_id=? AND round_no=?",
        (phase, mode["mode_id"], target_round),
    )
    mode["phase"] = phase
    mode["current_round"] = target_round
    mode["updated_at"] = timestamp


def _close_mode(con, mode, status, reason, *, outcome=None):
    timestamp = state_store.now()
    state = _decoded(mode, "state_json")
    state["terminal_reason"] = reason
    state["terminal_outcome"] = outcome or status
    con.execute(
        """UPDATE modes SET status=?, state_json=?, updated_at=?, completed_at=?
           WHERE mode_id=?""",
        (status, _json(state), timestamp, timestamp, mode["mode_id"]),
    )
    con.execute(
        """UPDATE mode_rounds SET status=?, completed_at=COALESCE(completed_at, ?)
           WHERE mode_id=? AND status='active'""",
        ("completed" if status == "completed" else ("cancelled" if status == "cancelled" else "blocked"),
         timestamp, mode["mode_id"]),
    )
    mode["status"] = status
    mode["state_json"] = _json(state)
    response = {
        "accepted": True,
        "mode_id": mode["mode_id"],
        "mode": mode["kind"],
        "status": status,
        "outcome": state["terminal_outcome"],
        "phase": mode["phase"],
        "round": mode["current_round"],
        "reason": reason,
        "schedule_required": False,
        "task_ids": [],
    }
    if mode["kind"] == "multi_session_review":
        consensus = _consensus_summary(con, mode, status)
        response["verdict"] = consensus["verdict"]
        response["findings"] = {
            "confirmed": consensus["confirmed_findings"],
            "rejected": consensus["rejected_findings"],
            "unresolved": consensus["unresolved_findings"],
        }
        response["consensus"] = consensus
    return response


def _mode_task_count(con, mode_id):
    return con.execute(
        "SELECT COUNT(*) AS n FROM mode_tasks WHERE mode_id=?", (mode_id,)
    ).fetchone()["n"]


def _action_batch(context, plans):
    return plans[: max(1, int(context["run"]["max_children_per_action"]))]


def _compile(con, context, mode, round_id, plans, compile_tasks):
    config = _decoded(mode, "config_json")
    if _mode_task_count(con, mode["mode_id"]) + len(plans) > config["max_tasks"]:
        raise ValueError("mode max_tasks guard exceeded")
    specs = [plan["spec"] for plan in plans]
    created = compile_tasks(specs)
    ids = {item["key"]: item["task_id"] for item in created}
    timestamp = state_store.now()
    for plan in plans:
        task_id = ids[plan["spec"]["key"]]
        con.execute(
            """INSERT INTO mode_tasks(
                 mode_id, round_id, task_id, role, candidate_fingerprint,
                 proposer_task_id, profile_hint_json, result_validated, created_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)""",
            (
                mode["mode_id"],
                round_id,
                task_id,
                plan["role"],
                plan.get("candidate_fingerprint"),
                plan.get("proposer_task_id"),
                _json(plan.get("profile_hint")) if plan.get("profile_hint") is not None else None,
                timestamp,
            ),
        )
    return [ids[plan["spec"]["key"]] for plan in plans]


def _parent_mode(con, context, requested):
    linked = state_store.get_mode_task(context["task"]["task_id"], con)
    implicit = linked["mode_id"] if linked is not None else None
    parent_id = requested if requested is not None else implicit
    if requested is not None and implicit is not None and requested != implicit:
        raise ValueError("nested mode parent must be the mode that owns the current task")
    if parent_id is None:
        return None, 0
    parent = state_store.get_mode(parent_id, con)
    if parent is None or parent["root_id"] != context["run"]["root_id"]:
        raise ValueError("parent mode must belong to the same Run")
    if parent["status"] != "running":
        raise ValueError("parent mode must be running")
    if (
        context["task"]["task_id"] != parent["owner_task_id"]
        and (linked is None or linked["mode_id"] != parent["mode_id"])
    ):
        raise ValueError("current task is not part of the requested parent mode")
    seen = set()
    cursor = parent
    while cursor is not None:
        if cursor["mode_id"] in seen:
            raise ValueError("mode composition cycle detected")
        seen.add(cursor["mode_id"])
        cursor = (
            state_store.get_mode(cursor["parent_mode_id"], con)
            if cursor.get("parent_mode_id") is not None
            else None
        )
    return parent, parent["depth"] + 1


def _swarm_plans(context, tasks):
    plans = []
    for spec in tasks:
        if not isinstance(spec, dict):
            raise ValueError("swarm tasks must be objects")
        item = dict(spec)
        item["output_contract"] = (
            str(item.get("output_contract") or "").strip() + "\n" + _output_contract("swarm")
        ).strip()
        plans.append({"role": "swarm", "spec": item})
    return plans


def _developer_plan(context, mode, round_no, depends_on=None):
    key = "mode-%d-round-%d-develop" % (mode["mode_id"], round_no)
    spec = {
        "key": key,
        "goal": "%s\nDevelop round %d." % (mode["objective"], round_no),
        "intent_hint": "implement",
        "complexity_hint": "high",
        "model_tier_hint": "strong",
        "priority": 80,
        "output_contract": _output_contract("developer"),
        "constraints": _task_constraints(
            context, read_only=False, notes=["Persistent mode %d, round %d developer." % (mode["mode_id"], round_no)]
        ),
    }
    if depends_on is not None:
        spec["depends_on"] = [{"task_id": depends_on, "condition": "success"}]
    return {"role": "developer", "spec": spec}


def _validator_plan(context, mode, round_no, depends_on, *, stage):
    if stage not in {"validation", "revalidation"}:
        raise ValueError("validator stage is invalid")
    return {
        "role": "validator",
        "spec": {
            "key": "mode-%d-round-%d-%s"
            % (mode["mode_id"], round_no, stage),
            "goal": "%s\nRun deterministic %s for round %d."
            % (mode["objective"], stage, round_no),
            "intent_hint": "review",
            "complexity_hint": "high",
            "model_tier_hint": "strong",
            "priority": 85,
            "output_contract": _output_contract("validator"),
            "constraints": _task_constraints(
                context,
                read_only=True,
                notes=[
                    "Persistent mode %d, round %d deterministic %s."
                    % (mode["mode_id"], round_no, stage),
                    "Do not modify the artifact while validating it.",
                ],
            ),
            "depends_on": [{"task_id": depends_on, "condition": "success"}],
        },
    }


def _loop_reviewer_plan(context, mode, round_no, depends_on):
    return {
        "role": "reviewer",
        "spec": {
            "key": "mode-%d-round-%d-review" % (mode["mode_id"], round_no),
            "goal": "%s\nIndependently review development round %d." % (mode["objective"], round_no),
            "intent_hint": "review",
            "complexity_hint": "high",
            "model_tier_hint": "strong",
            "priority": 80,
            "output_contract": _output_contract("reviewer"),
            "constraints": _task_constraints(
                context,
                read_only=True,
                notes=["Persistent mode %d, round %d review." % (mode["mode_id"], round_no)],
            ),
            "depends_on": [{"task_id": depends_on, "condition": "success"}],
        },
    }


def _improver_plan(context, mode, round_no, depends_on, fingerprints):
    dependency_ids = (
        list(depends_on) if isinstance(depends_on, (list, tuple, set)) else [depends_on]
    )
    return {
        "role": "improver",
        "spec": {
            "key": "mode-%d-round-%d-improve" % (mode["mode_id"], round_no),
            "goal": "%s\nImprove round %d for findings: %s"
            % (mode["objective"], round_no, ", ".join(fingerprints)),
            "intent_hint": "fix",
            "complexity_hint": "high",
            "model_tier_hint": "strong",
            "priority": 85,
            "output_contract": _output_contract("improver"),
            "constraints": _task_constraints(
                context,
                read_only=False,
                notes=["Only address the listed round findings: %s" % ", ".join(fingerprints)],
            ),
            "depends_on": [
                {"task_id": task_id, "condition": "success"}
                for task_id in dependency_ids
            ],
        },
    }


def _reviewer_plans(context, mode, config):
    plans = []
    for reviewer in config["reviewers"]:
        identifier = reviewer["id"]
        hint = reviewer["profile_hint"]
        plans.append(
            {
                "role": "reviewer",
                "profile_hint": hint,
                "spec": {
                    "key": "mode-%d-review-%s" % (mode["mode_id"], identifier),
                    "goal": "%s\nPerform an independent proposal review as %s."
                    % (mode["objective"], identifier),
                    "intent_hint": "review",
                    "complexity_hint": "high",
                    "model_tier_hint": "strong",
                    "priority": 80,
                    "output_contract": _output_contract("reviewer"),
                    "constraints": _task_constraints(
                        context,
                        read_only=True,
                        notes=[
                            "Do not coordinate with other reviewers.",
                            "Runtime mode %d independent reviewer %s." % (mode["mode_id"], identifier),
                        ],
                        profile_hint=hint,
                    ),
                },
            }
        )
    return plans


def start_mode(con, context, payload, action_id, compile_tasks):
    data = mode_models.validate_start_payload(payload)
    execution = _decoded(context["run"], "execution_config_json")
    if data["kind"] == "multi_session_review" and execution.get("backend") != "acp":
        raise ValueError("multi_session_review is ACP-only")
    if (
        data["kind"] == "multi_session_review"
        and len(data["config"]["reviewers"]) > context["run"]["max_children_per_action"]
    ):
        raise ValueError(
            "reviewer count exceeds the Run max_children_per_action guard"
        )
    if data["kind"] == "multi_session_review":
        for reviewer in data["config"]["reviewers"]:
            hint = reviewer["profile_hint"]
            if hint is not None:
                execution_config.select_profile(execution, profile_hint=hint)
    parent, depth = _parent_mode(con, context, data["parent_mode_id"])
    if depth > data["config"]["max_mode_depth"]:
        raise ValueError("mode composition depth guard exceeded")
    if parent is not None:
        parent_limit = _decoded(parent, "config_json").get("max_mode_depth", 4)
        if depth > parent_limit:
            raise ValueError("parent mode composition depth guard exceeded")
    timestamp = state_store.now()
    state = {
        "evidence_bundle": data["evidence_bundle"],
        "no_progress_count": 0,
        "candidate_expansions": 0,
        "candidate_overflow": [],
    }
    phase = {
        "swarm": "swarm",
        "develop_review_improve": data["config"].get("phases", ["develop"])[0],
        "multi_session_review": "review",
    }[data["kind"]]
    cursor = con.execute(
        """INSERT INTO modes(
             root_id, owner_task_id, parent_mode_id, kind, status, phase,
             current_round, depth, objective, config_json, state_json,
             deadline_at, started_at, updated_at
           ) VALUES (?, ?, ?, ?, 'running', ?, 1, ?, ?, ?, ?, ?, ?, ?)""",
        (
            context["run"]["root_id"],
            context["task"]["task_id"],
            parent["mode_id"] if parent is not None else None,
            data["kind"],
            phase,
            depth,
            data["objective"],
            _json(data["config"]),
            _json(state),
            timestamp + data["config"]["max_seconds"],
            timestamp,
            timestamp,
        ),
    )
    mode_id = cursor.lastrowid
    mode = state_store.get_mode(mode_id, con)
    round_id = _new_round(con, mode_id, 1, phase)
    if data["kind"] == "swarm":
        plans = _swarm_plans(context, data["tasks"])
    elif data["kind"] == "develop_review_improve":
        plans = [_developer_plan(context, mode, 1)]
    else:
        plans = _reviewer_plans(context, mode, data["config"])
    task_ids = _compile(con, context, mode, round_id, plans, compile_tasks)
    fingerprint = _snapshot_fingerprint(con, mode_id)
    con.execute(
        "UPDATE modes SET state_fingerprint=? WHERE mode_id=?",
        (fingerprint, mode_id),
    )
    state_store.append_event(
        con,
        context["run"]["root_id"],
        "ModeStarted",
        {"mode_id": mode_id, "kind": data["kind"], "task_ids": task_ids, "parent_mode_id": data["parent_mode_id"]},
        task_id=context["task"]["task_id"],
        attempt_id=context["attempt"]["attempt_id"],
        action_id=action_id,
    )
    return {
        "accepted": True,
        "mode_id": mode_id,
        "mode": data["kind"],
        "status": "running",
        "phase": phase,
        "round": 1,
        "task_ids": task_ids,
        "schedule_required": True,
    }


def _mode_rows(con, mode_id, role=None, round_id=None):
    conditions = ["mt.mode_id=?"]
    params = [mode_id]
    if role is not None:
        roles = [role] if isinstance(role, str) else list(role)
        conditions.append("mt.role IN (%s)" % ",".join("?" for _ in roles))
        params.extend(roles)
    if round_id is not None:
        conditions.append("mt.round_id=?")
        params.append(round_id)
    return state_store.fetchall(
        """SELECT mt.*, t.status, a.result_json
           FROM mode_tasks mt
           JOIN tasks t ON t.task_id=mt.task_id
           LEFT JOIN attempts a ON a.attempt_id=(
             SELECT current.attempt_id FROM attempts current
             WHERE current.task_id=t.task_id ORDER BY current.attempt_no DESC LIMIT 1
           )
           WHERE %s ORDER BY mt.mode_task_id""" % " AND ".join(conditions),
        tuple(params),
        con,
    )


def _mode_result(row):
    result = json.loads(row["result_json"]) if row.get("result_json") else {}
    return result.get("mode_result") or {}


def _consensus_summary(con, mode, lifecycle_status):
    finding_rows = state_store.fetchall(
        "SELECT * FROM mode_findings WHERE mode_id=? ORDER BY fingerprint",
        (mode["mode_id"],),
        con,
    )
    findings = {"confirmed": [], "rejected": [], "unresolved": []}
    quorum = []
    for row in finding_rows:
        canonical = json.loads(row["canonical_json"])
        # Persisted columns are authoritative after duplicate merging and
        # adjudication. A later duplicate may escalate severity without
        # replacing the first canonical payload.
        canonical["fingerprint"] = row["fingerprint"]
        canonical["severity"] = row["severity"]
        canonical["status"] = row["status"]
        canonical["adjudication"] = (
            json.loads(row["adjudication_json"])
            if row.get("adjudication_json")
            else None
        )
        if row["status"] in findings:
            findings[row["status"]].append(canonical)
        verifications = state_store.fetchall(
            """SELECT task_id, verifier_kind, verdict, evidence_hash
               FROM mode_verifications WHERE finding_id=?
               ORDER BY verifier_kind, task_id""",
            (row["finding_id"],),
            con,
        )
        quorum.append(
            {
                "fingerprint": row["fingerprint"],
                "status": row["status"],
                "required": {
                    "independent_verifiers": 2,
                    "kinds": ["reproduce", "falsify"],
                },
                "observed": verifications,
                "met": (
                    len({item["task_id"] for item in verifications}) >= 2
                    and {item["verifier_kind"] for item in verifications}
                    == {"reproduce", "falsify"}
                ),
            }
        )
    provenance = state_store.fetchall(
        """SELECT f.fingerprint, p.task_id, p.source_kind, p.evidence_hash
           FROM mode_finding_provenance p
           JOIN mode_findings f ON f.finding_id=p.finding_id
           WHERE f.mode_id=? ORDER BY f.fingerprint, p.provenance_id""",
        (mode["mode_id"],),
        con,
    )
    # A review that did not complete cannot be a passing consensus, even when
    # it produced no findings before cancellation or failure.
    if lifecycle_status != "completed":
        verdict = "blocked"
    elif findings["confirmed"] or findings["unresolved"]:
        verdict = "changes_requested"
    else:
        verdict = "pass"
    state = _decoded(mode, "state_json")
    revision_input = {
        "confirmed_fingerprints": [
            item["fingerprint"] for item in findings["confirmed"]
        ],
        "unresolved_fingerprints": [
            item["fingerprint"] for item in findings["unresolved"]
        ],
    }
    return {
        "verdict": verdict,
        "reviewed_artifact": state.get("evidence_bundle"),
        "confirmed_findings": findings["confirmed"],
        "rejected_findings": findings["rejected"],
        "unresolved_findings": findings["unresolved"],
        "provenance": provenance,
        "quorum": quorum,
        "revision_input": revision_input,
    }


def _snapshot_fingerprint(con, mode_id):
    mode = state_store.get_mode(mode_id, con)
    tasks = _mode_rows(con, mode_id)
    findings = state_store.fetchall(
        """SELECT fingerprint, severity, status, adjudication_json
           FROM mode_findings WHERE mode_id=? ORDER BY fingerprint""",
        (mode_id,),
        con,
    )
    return mode_models.digest(
        {
            "phase": mode["phase"],
            "round": mode["current_round"],
            "tasks": [
                {
                    "task_id": row["task_id"],
                    "role": row["role"],
                    "status": row["status"],
                    "result": mode_models.digest(_mode_result(row)) if row.get("result_json") else None,
                }
                for row in tasks
            ],
            "findings": findings,
        }
    )


def _track_progress(con, mode):
    fingerprint = _snapshot_fingerprint(con, mode["mode_id"])
    state = _decoded(mode, "state_json")
    if fingerprint == mode.get("state_fingerprint"):
        state["no_progress_count"] = int(state.get("no_progress_count", 0)) + 1
    else:
        state["no_progress_count"] = 0
    con.execute(
        "UPDATE modes SET state_json=?, state_fingerprint=?, updated_at=? WHERE mode_id=?",
        (_json(state), fingerprint, state_store.now(), mode["mode_id"]),
    )
    mode["state_json"] = _json(state)
    mode["state_fingerprint"] = fingerprint
    return state["no_progress_count"]


def _record_finding(con, mode, task_id, finding, source_kind, *, allow_new=True):
    normalized = mode_models.validate_finding(finding)
    fingerprint = normalized["fingerprint"]
    existing = con.execute(
        "SELECT * FROM mode_findings WHERE mode_id=? AND fingerprint=?",
        (mode["mode_id"], fingerprint),
    ).fetchone()
    if existing is None:
        if not allow_new:
            return None, False
        timestamp = state_store.now()
        cursor = con.execute(
            """INSERT INTO mode_findings(
                 mode_id, fingerprint, rule_name, title, description, location,
                 severity, status, canonical_json, first_seen_round,
                 discovered_by_task_id, created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, 'candidate', ?, ?, ?, ?, ?)""",
            (
                mode["mode_id"],
                fingerprint,
                normalized["rule"],
                normalized["title"],
                normalized["description"],
                normalized["location"],
                normalized["severity"],
                _json(normalized),
                mode["current_round"],
                task_id,
                timestamp,
                timestamp,
            ),
        )
        finding_id = cursor.lastrowid
        created = True
    else:
        finding_id = existing["finding_id"]
        created = False
        if SEVERITY_RANK[normalized["severity"]] > SEVERITY_RANK[existing["severity"]]:
            con.execute(
                "UPDATE mode_findings SET severity=?, updated_at=? WHERE finding_id=?",
                (normalized["severity"], state_store.now(), finding_id),
            )
    evidence_hash = mode_models.digest(normalized["evidence"])
    con.execute(
        """INSERT OR IGNORE INTO mode_finding_provenance(
             finding_id, task_id, source_kind, raw_finding_json,
             evidence_hash, created_at
           ) VALUES (?, ?, ?, ?, ?, ?)""",
        (finding_id, task_id, source_kind, _json(normalized), evidence_hash, state_store.now()),
    )
    return fingerprint, created


def _record_review_findings(con, mode, rows):
    config = _decoded(mode, "config_json")
    overflow = []
    for row in rows:
        for finding in _mode_result(row).get("findings", []):
            count = con.execute(
                "SELECT COUNT(*) AS n FROM mode_findings WHERE mode_id=?",
                (mode["mode_id"],),
            ).fetchone()["n"]
            fingerprint, _ = _record_finding(
                con,
                mode,
                row["task_id"],
                finding,
                "reviewer",
                allow_new=count < config["max_candidates"],
            )
            if fingerprint is None:
                normalized = mode_models.validate_finding(finding)
                overflow.append(
                    {
                        "fingerprint": normalized["fingerprint"],
                        "severity": normalized["severity"],
                        "task_id": row["task_id"],
                        "evidence_hash": mode_models.digest(normalized["evidence"]),
                    }
                )
    if overflow:
        state = _decoded(mode, "state_json")
        state["candidate_overflow"] = (state.get("candidate_overflow") or []) + overflow
        con.execute(
            "UPDATE modes SET state_json=? WHERE mode_id=?",
            (_json(state), mode["mode_id"]),
        )
        mode["state_json"] = _json(state)
    return overflow


def _verifier_plans(con, context, mode):
    findings = state_store.fetchall(
        """SELECT f.* FROM mode_findings f
           WHERE f.mode_id=? AND f.status='candidate'
           ORDER BY f.fingerprint""",
        (mode["mode_id"],),
        con,
    )
    plans = []
    for finding in findings:
        provenance = con.execute(
            """SELECT task_id FROM mode_finding_provenance
               WHERE finding_id=? ORDER BY provenance_id LIMIT 1""",
            (finding["finding_id"],),
        ).fetchone()
        proposer = provenance["task_id"]
        for role, suffix in (("verifier_reproduce", "reproduce"), ("verifier_falsify", "falsify")):
            existing = con.execute(
                """SELECT 1 FROM mode_tasks
                   WHERE mode_id=? AND candidate_fingerprint=? AND role=?""",
                (mode["mode_id"], finding["fingerprint"], role),
            ).fetchone()
            if existing is not None:
                continue
            plans.append(
                {
                    "role": role,
                    "candidate_fingerprint": finding["fingerprint"],
                    "proposer_task_id": proposer,
                    "spec": {
                        "key": "mode-%d-%s-%s" % (mode["mode_id"], finding["fingerprint"], suffix),
                        "goal": "%s\n%s candidate %s independently."
                        % (mode["objective"], suffix.capitalize(), finding["fingerprint"]),
                        "intent_hint": "review",
                        "complexity_hint": "high",
                        "model_tier_hint": "strong",
                        "priority": 90,
                        "output_contract": _output_contract(role),
                        "constraints": _task_constraints(
                            context,
                            read_only=True,
                            notes=[
                                "Assigned candidate: %s" % finding["fingerprint"],
                                "Independent %s verifier; do not trust or coordinate with proposer task %d."
                                % (suffix, proposer),
                            ],
                        ),
                        "depends_on": [{"task_id": proposer, "condition": "success"}],
                    },
                }
            )
    return plans


def _ingest_verifications(con, mode):
    config = _decoded(mode, "config_json")
    state = _decoded(mode, "state_json")
    expansions = int(state.get("candidate_expansions", 0))
    overflow = list(state.get("candidate_overflow") or [])
    rows = _mode_rows(
        con, mode["mode_id"], role={"verifier_reproduce", "verifier_falsify"}
    )
    for row in rows:
        if row["status"] != "done":
            continue
        existing = con.execute(
            "SELECT 1 FROM mode_verifications WHERE task_id=?", (row["task_id"],)
        ).fetchone()
        if existing is not None:
            continue
        result = _mode_result(row)
        finding = con.execute(
            "SELECT * FROM mode_findings WHERE mode_id=? AND fingerprint=?",
            (mode["mode_id"], row["candidate_fingerprint"]),
        ).fetchone()
        if finding is None:
            raise ValueError("verifier references a missing Runtime candidate")
        evidence = result["evidence"]
        con.execute(
            """INSERT INTO mode_verifications(
                 finding_id, task_id, verifier_kind, verdict, evidence_json,
                 evidence_hash, submitted_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                finding["finding_id"],
                row["task_id"],
                "reproduce" if row["role"] == "verifier_reproduce" else "falsify",
                result["verdict"],
                _json(evidence),
                mode_models.digest(evidence),
                state_store.now(),
            ),
        )
        for discovered in result.get("discovered_findings", []):
            normalized = mode_models.validate_finding(discovered)
            existing_candidate = con.execute(
                "SELECT 1 FROM mode_findings WHERE mode_id=? AND fingerprint=?",
                (mode["mode_id"], normalized["fingerprint"]),
            ).fetchone()
            candidate_count = con.execute(
                "SELECT COUNT(*) AS n FROM mode_findings WHERE mode_id=?",
                (mode["mode_id"],),
            ).fetchone()["n"]
            allow_new = (
                existing_candidate is not None
                or (
                    expansions < config["max_expansions"]
                    and candidate_count < config["max_candidates"]
                )
            )
            fingerprint, created = _record_finding(
                con,
                mode,
                row["task_id"],
                normalized,
                "verifier_discovery",
                allow_new=allow_new,
            )
            if created:
                expansions += 1
            elif fingerprint is None:
                overflow.append(
                    {
                        "fingerprint": normalized["fingerprint"],
                        "severity": normalized["severity"],
                        "task_id": row["task_id"],
                        "evidence_hash": mode_models.digest(normalized["evidence"]),
                    }
                )
    state["candidate_expansions"] = expansions
    state["candidate_overflow"] = overflow
    con.execute(
        "UPDATE modes SET state_json=? WHERE mode_id=?",
        (_json(state), mode["mode_id"]),
    )
    mode["state_json"] = _json(state)


def _adjudicate(con, mode):
    findings = state_store.fetchall(
        "SELECT * FROM mode_findings WHERE mode_id=? AND status='candidate' ORDER BY fingerprint",
        (mode["mode_id"],),
        con,
    )
    for finding in findings:
        assigned = state_store.fetchall(
            """SELECT task_id, role, proposer_task_id FROM mode_tasks
               WHERE mode_id=? AND candidate_fingerprint=?
                 AND role IN ('verifier_reproduce','verifier_falsify')
               ORDER BY role""",
            (mode["mode_id"], finding["fingerprint"]),
            con,
        )
        verifications = state_store.fetchall(
            """SELECT v.* FROM mode_verifications v
               WHERE v.finding_id=? ORDER BY verifier_kind""",
            (finding["finding_id"],),
            con,
        )
        roles = {item["role"] for item in assigned}
        independent = (
            len({item["task_id"] for item in assigned}) >= 2
            and roles == {"verifier_reproduce", "verifier_falsify"}
            and all(item["task_id"] != item["proposer_task_id"] for item in assigned)
        )
        if not independent or len(verifications) < 2:
            continue
        verdicts = {item["verdict"] for item in verifications}
        if verdicts == {"confirmed"}:
            status = "confirmed"
        elif verdicts == {"rejected"}:
            status = "rejected"
        else:
            status = "unresolved"
        adjudication = {
            "verdicts": [
                {
                    "task_id": item["task_id"],
                    "kind": item["verifier_kind"],
                    "verdict": item["verdict"],
                    "evidence_hash": item["evidence_hash"],
                }
                for item in verifications
            ],
            "independent": independent,
        }
        con.execute(
            """UPDATE mode_findings SET status=?, adjudication_json=?, updated_at=?
               WHERE finding_id=?""",
            (status, _json(adjudication), state_store.now(), finding["finding_id"]),
        )


def _fixer_plans(con, context, mode):
    findings = state_store.fetchall(
        """SELECT * FROM mode_findings f
           WHERE mode_id=? AND status='confirmed'
             AND NOT EXISTS (
               SELECT 1 FROM mode_tasks mt
               WHERE mt.mode_id=f.mode_id AND mt.role='fixer'
                 AND mt.candidate_fingerprint=f.fingerprint
             )
           ORDER BY fingerprint""",
        (mode["mode_id"],),
        con,
    )
    plans = []
    for finding in findings:
        verifier_ids = [
            row["task_id"]
            for row in state_store.fetchall(
                """SELECT v.task_id FROM mode_verifications v
                   WHERE v.finding_id=? ORDER BY v.task_id""",
                (finding["finding_id"],),
                con,
            )
        ]
        plans.append(
            {
                "role": "fixer",
                "candidate_fingerprint": finding["fingerprint"],
                "spec": {
                    "key": "mode-%d-fix-%s" % (mode["mode_id"], finding["fingerprint"]),
                    "goal": "%s\nFix confirmed finding %s only."
                    % (mode["objective"], finding["fingerprint"]),
                    "intent_hint": "fix",
                    "complexity_hint": "high",
                    "model_tier_hint": "strong",
                    "priority": 95,
                    "output_contract": _output_contract("fixer"),
                    "constraints": _task_constraints(
                        context,
                        read_only=False,
                        notes=[
                            "Runtime-adjudicated confirmed finding: %s" % finding["fingerprint"],
                            "Do not fix rejected or unresolved candidates.",
                        ],
                    ),
                    "depends_on": [
                        {"task_id": task_id, "condition": "success"} for task_id in verifier_ids
                    ],
                },
            }
        )
    return plans


def _response(mode, *, task_ids=None, reason=None, schedule=False):
    value = {
        "accepted": True,
        "mode_id": mode["mode_id"],
        "mode": mode["kind"],
        "status": mode["status"],
        "phase": mode["phase"],
        "round": mode["current_round"],
        "task_ids": task_ids or [],
        "schedule_required": schedule,
    }
    if reason:
        value["reason"] = reason
    return value


def _advance_swarm(con, context, mode):
    rows = _mode_rows(con, mode["mode_id"], role="swarm")
    if any(row["status"] in {"failed", "blocked", "cancelled"} for row in rows):
        return _close_mode(con, mode, "blocked", "swarm task did not complete")
    if rows and all(row["status"] == "done" for row in rows):
        return _close_mode(con, mode, "completed", "all compiled swarm tasks completed")
    return _response(mode, reason="swarm tasks are still running")


def _advance_loop(con, context, mode, compile_tasks):
    round_row = _round(con, mode)
    rows = _mode_rows(con, mode["mode_id"], round_id=round_row["round_id"])
    phase_role = {
        "develop": {"developer"},
        "validate": {"validator"},
        "review": {"reviewer"},
        "re_review": {"reviewer"},
        "verify": {"verifier_reproduce", "verifier_falsify"},
        "improve": {"improver"},
        "revalidate": {"validator"},
    }.get(mode["phase"])
    if phase_role is None:
        return _close_mode(con, mode, "blocked", "loop phase is invalid")
    phase_rows = [row for row in rows if row["role"] in phase_role]
    if not phase_rows:
        return _close_mode(con, mode, "blocked", "loop phase has no compiled task")
    if any(row["status"] in {"failed", "blocked", "cancelled"} for row in phase_rows):
        return _close_mode(con, mode, "blocked", "loop phase task did not complete")
    if not all(row["status"] == "done" for row in phase_rows):
        return _response(mode, reason="loop phase tasks are still running")
    config = _decoded(mode, "config_json")
    exit_conditions = config["exit_conditions"]
    if mode["phase"] == "develop":
        plan = _validator_plan(
            context,
            mode,
            mode["current_round"],
            phase_rows[0]["task_id"],
            stage="validation",
        )
        task_ids = _compile(con, context, mode, round_row["round_id"], [plan], compile_tasks)
        _set_phase(con, mode, "validate")
        return _response(mode, task_ids=task_ids, schedule=True)
    if mode["phase"] in {"validate", "revalidate"}:
        result = _mode_result(phase_rows[0])
        if result.get("status") != "passed":
            return _close_mode(
                con,
                mode,
                "blocked",
                "deterministic %s did not pass" % mode["phase"],
                outcome=exit_conditions["validation_failure"],
            )
        if mode["phase"] == "validate":
            plan = _loop_reviewer_plan(
                context, mode, mode["current_round"], phase_rows[0]["task_id"]
            )
            task_ids = _compile(
                con, context, mode, round_row["round_id"], [plan], compile_tasks
            )
            _set_phase(con, mode, "review")
            return _response(mode, task_ids=task_ids, schedule=True)
        if mode["current_round"] >= config["max_rounds"]:
            return _close_mode(
                con,
                mode,
                "blocked",
                "max_rounds guard reached after required revalidation",
                outcome=exit_conditions["max_rounds"],
            )
        con.execute(
            """UPDATE mode_rounds SET status='completed', completed_at=?
               WHERE round_id=?""",
            (state_store.now(), round_row["round_id"]),
        )
        next_round = mode["current_round"] + 1
        next_phase = "re_review"
        next_round_id = _new_round(
            con, mode["mode_id"], next_round, next_phase
        )
        plan = _loop_reviewer_plan(
            context, mode, next_round, phase_rows[0]["task_id"]
        )
        task_ids = _compile(
            con, context, mode, next_round_id, [plan], compile_tasks
        )
        _set_phase(con, mode, next_phase, round_no=next_round)
        return _response(mode, task_ids=task_ids, schedule=True)
    if mode["phase"] in {"review", "re_review"}:
        result = _mode_result(phase_rows[0])
        _record_review_findings(con, mode, phase_rows)
        if result["verdict"] == "pass" and not result.get("findings"):
            return _close_mode(
                con,
                mode,
                "completed",
                "review passed (exit condition: %s)" % exit_conditions["passed"],
                outcome="passed",
            )
        if result["verdict"] == "blocked":
            return _close_mode(
                con, mode, "blocked", "reviewer blocked the loop", outcome="blocked"
            )
        plans = _verifier_plans(con, context, mode)
        if not plans:
            return _close_mode(con, mode, "blocked", "review findings lack verifier assignments")
        try:
            task_ids = _compile(
                con,
                context,
                mode,
                round_row["round_id"],
                _action_batch(context, plans),
                compile_tasks,
            )
        except ValueError as exc:
            return _close_mode(con, mode, "blocked", str(exc))
        _set_phase(con, mode, "verify")
        return _response(mode, task_ids=task_ids, schedule=True)
    if mode["phase"] == "verify":
        _ingest_verifications(con, mode)
        _adjudicate(con, mode)
        plans = _verifier_plans(con, context, mode)
        if plans:
            try:
                task_ids = _compile(
                    con,
                    context,
                    mode,
                    round_row["round_id"],
                    _action_batch(context, plans),
                    compile_tasks,
                )
            except ValueError as exc:
                return _close_mode(con, mode, "blocked", str(exc))
            return _response(mode, task_ids=task_ids, schedule=True)
        unresolved_high = con.execute(
            """SELECT COUNT(*) AS n FROM mode_findings
               WHERE mode_id=? AND status='unresolved'
                 AND severity IN ('high','critical')""",
            (mode["mode_id"],),
        ).fetchone()["n"]
        if unresolved_high:
            return _close_mode(
                con,
                mode,
                "blocked",
                "high-severity findings remain unresolved",
                outcome=exit_conditions["high_severity_unresolved"],
            )
        overflow = _decoded(mode, "state_json").get("candidate_overflow") or []
        if any(item["severity"] in {"high", "critical"} for item in overflow):
            return _close_mode(con, mode, "blocked", "high-severity candidate budget overflow")
        if overflow:
            return _close_mode(con, mode, "blocked", "candidate budget guard reached")
        confirmed = [
            row["fingerprint"]
            for row in state_store.fetchall(
                """SELECT fingerprint FROM mode_findings
                   WHERE mode_id=? AND status='confirmed' ORDER BY fingerprint""",
                (mode["mode_id"],),
                con,
            )
        ]
        if not confirmed:
            return _close_mode(
                con,
                mode,
                "completed",
                "review findings were not confirmed",
                outcome="passed",
            )
        verifier_ids = [row["task_id"] for row in phase_rows]
        plan = _improver_plan(
            context, mode, mode["current_round"], verifier_ids, confirmed
        )
        task_ids = _compile(con, context, mode, round_row["round_id"], [plan], compile_tasks)
        _set_phase(con, mode, "improve")
        return _response(mode, task_ids=task_ids, schedule=True)
    result = _mode_result(phase_rows[0])
    if not result.get("changed"):
        return _close_mode(
            con,
            mode,
            "blocked",
            "no progress reported by improver",
            outcome=exit_conditions["no_progress"],
        )
    plan = _validator_plan(
        context,
        mode,
        mode["current_round"],
        phase_rows[0]["task_id"],
        stage="revalidation",
    )
    task_ids = _compile(
        con, context, mode, round_row["round_id"], [plan], compile_tasks
    )
    _set_phase(con, mode, "revalidate")
    return _response(mode, task_ids=task_ids, schedule=True)


def _advance_review(con, context, mode, compile_tasks):
    config = _decoded(mode, "config_json")
    round_row = _round(con, mode)
    if mode["phase"] == "review":
        reviewers = _mode_rows(con, mode["mode_id"], role="reviewer")
        if any(row["status"] in {"failed", "blocked", "cancelled"} for row in reviewers):
            return _close_mode(con, mode, "blocked", "independent reviewer did not complete")
        if not reviewers or not all(row["status"] == "done" for row in reviewers):
            return _response(mode, reason="independent reviewers are still running")
        _record_review_findings(con, mode, reviewers)
        plans = _verifier_plans(con, context, mode)
        if not plans:
            overflow = _decoded(mode, "state_json").get("candidate_overflow") or []
            if any(item["severity"] in {"high", "critical"} for item in overflow):
                return _close_mode(con, mode, "blocked", "high-severity candidate budget overflow")
            if overflow:
                return _close_mode(con, mode, "blocked", "candidate budget guard reached")
            return _close_mode(con, mode, "completed", "review produced no candidates")
        try:
            task_ids = _compile(
                con,
                context,
                mode,
                round_row["round_id"],
                _action_batch(context, plans),
                compile_tasks,
            )
        except ValueError as exc:
            return _close_mode(con, mode, "blocked", str(exc))
        _set_phase(con, mode, "verify")
        return _response(mode, task_ids=task_ids, schedule=True)
    if mode["phase"] == "verify":
        verifiers = _mode_rows(
            con, mode["mode_id"], role={"verifier_reproduce", "verifier_falsify"}
        )
        if any(row["status"] in {"failed", "blocked", "cancelled"} for row in verifiers):
            return _close_mode(con, mode, "blocked", "candidate verifier did not complete")
        if not verifiers or not all(row["status"] == "done" for row in verifiers):
            return _response(mode, reason="candidate verifiers are still running")
        _ingest_verifications(con, mode)
        _adjudicate(con, mode)
        plans = _verifier_plans(con, context, mode)
        if plans:
            try:
                task_ids = _compile(
                    con,
                    context,
                    mode,
                    round_row["round_id"],
                    _action_batch(context, plans),
                    compile_tasks,
                )
            except ValueError as exc:
                return _close_mode(con, mode, "blocked", str(exc))
            return _response(mode, task_ids=task_ids, schedule=True)
        unresolved_high = con.execute(
            """SELECT COUNT(*) AS n FROM mode_findings
               WHERE mode_id=? AND status='unresolved'
                 AND severity IN ('high','critical')""",
            (mode["mode_id"],),
        ).fetchone()["n"]
        overflow = _decoded(mode, "state_json").get("candidate_overflow") or []
        if unresolved_high or any(item["severity"] in {"high", "critical"} for item in overflow):
            return _close_mode(con, mode, "blocked", "high-severity findings remain unresolved")
        if overflow:
            return _close_mode(con, mode, "blocked", "candidate expansion budget guard reached")
        if config["create_fix_tasks"]:
            plans = _fixer_plans(con, context, mode)
            if plans:
                try:
                    task_ids = _compile(
                        con,
                        context,
                        mode,
                        round_row["round_id"],
                        _action_batch(context, plans),
                        compile_tasks,
                    )
                except ValueError as exc:
                    return _close_mode(con, mode, "blocked", str(exc))
                _set_phase(con, mode, "fix")
                return _response(mode, task_ids=task_ids, schedule=True)
        return _close_mode(con, mode, "completed", "review candidates adjudicated")
    fixers = _mode_rows(con, mode["mode_id"], role="fixer")
    if any(row["status"] in {"failed", "blocked", "cancelled"} for row in fixers):
        return _close_mode(con, mode, "blocked", "confirmed finding fixer did not complete")
    if not fixers or not all(row["status"] == "done" for row in fixers):
        return _response(mode, reason="confirmed finding fixers are still running")
    remaining = _fixer_plans(con, context, mode)
    if remaining:
        try:
            task_ids = _compile(
                con,
                context,
                mode,
                round_row["round_id"],
                _action_batch(context, remaining),
                compile_tasks,
            )
        except ValueError as exc:
            return _close_mode(con, mode, "blocked", str(exc))
        return _response(mode, task_ids=task_ids, schedule=True)
    return _close_mode(con, mode, "completed", "confirmed findings fixed")


def advance_mode(con, context, payload, action_id, compile_tasks, cancel_mode):
    mode_id = payload.get("mode_id")
    if isinstance(mode_id, bool) or not isinstance(mode_id, int):
        raise ValueError("advance_mode mode_id must be an integer")
    mode = state_store.get_mode(mode_id, con)
    if mode is None or mode["root_id"] != context["run"]["root_id"]:
        raise ValueError("mode must belong to the current Run")
    if mode["owner_task_id"] != context["task"]["task_id"]:
        raise ValueError("only the mode owner Task can advance it")
    operation = payload.get("operation", "advance")
    if operation not in {"advance", "cancel"}:
        raise ValueError("advance_mode operation must be advance or cancel")
    if mode["status"] in mode_models.MODE_TERMINAL:
        return _response(mode, reason="mode is already terminal")
    if operation == "cancel":
        reason = str(payload.get("reason") or "owner requested mode cancellation").strip()
        cancel_mode(con, context["run"], mode, reason)
        response = _close_mode(con, mode, "cancelled", reason, outcome="cancelled")
    elif state_store.now() >= mode["deadline_at"]:
        response = _close_mode(
            con, mode, "blocked", "max_seconds guard reached", outcome="budget_exhausted"
        )
    elif mode["kind"] == "swarm":
        response = _advance_swarm(con, context, mode)
    elif mode["kind"] == "develop_review_improve":
        response = _advance_loop(con, context, mode, compile_tasks)
    else:
        response = _advance_review(con, context, mode, compile_tasks)
    if response["status"] == "running":
        config = _decoded(mode, "config_json")
        repeated = _track_progress(con, mode)
        if repeated >= config["max_no_progress"]:
            response = _close_mode(
                con,
                mode,
                "blocked",
                "repeated-state/no-progress guard reached",
                outcome=(
                    config.get("exit_conditions", {}).get("no_progress")
                    or "no_progress"
                ),
            )
    state_store.append_event(
        con,
        context["run"]["root_id"],
        "ModeAdvanced",
        {
            "mode_id": mode_id,
            "status": response["status"],
            "phase": response["phase"],
            "round": response["round"],
            "task_ids": response["task_ids"],
        },
        task_id=context["task"]["task_id"],
        attempt_id=context["attempt"]["attempt_id"],
        action_id=action_id,
    )
    return response


def validate_task_mode_result(con, context, payload):
    link = state_store.get_mode_task(context["task"]["task_id"], con)
    if link is None:
        if "mode_result" in payload and payload["mode_result"] is not None:
            raise ValueError("mode_result is only valid for a Runtime mode task")
        return None
    mode = state_store.get_mode(link["mode_id"], con)
    if mode is None:
        raise ValueError("mode task references a missing mode")
    normalized = mode_models.validate_mode_result(link, mode, payload.get("mode_result"))
    payload["mode_result"] = normalized
    con.execute(
        "UPDATE mode_tasks SET result_validated=1 WHERE mode_task_id=?",
        (link["mode_task_id"],),
    )
    return normalized


def validate_owner_modes_finished(con, task_id):
    rows = state_store.fetchall(
        """SELECT mode_id, status FROM modes
           WHERE owner_task_id=? AND status NOT IN ('completed','cancelled')""",
        (task_id,),
        con,
    )
    if rows:
        raise ValueError(
            "task cannot finish done while owned modes are non-terminal-success: %s"
            % ", ".join("%d:%s" % (row["mode_id"], row["status"]) for row in rows)
        )


def prompt_context(con, task_id):
    link = state_store.get_mode_task(task_id, con)
    owned = state_store.fetchall(
        """SELECT mode_id, parent_mode_id, kind, status, phase, current_round, depth
           FROM modes WHERE owner_task_id=? ORDER BY mode_id""",
        (task_id,),
        con,
    )
    if link is None and not owned:
        return ""
    payload = {"owned_modes": owned}
    if link is not None:
        mode = state_store.get_mode(link["mode_id"], con)
        state = _decoded(mode, "state_json")
        dependencies = state_store.fetchall(
            """SELECT upstream.task_id, upstream.status, attempt.result_json
               FROM task_dependencies dependency
               JOIN tasks upstream ON upstream.task_id=dependency.depends_on_task_id
               LEFT JOIN attempts attempt ON attempt.attempt_id=(
                 SELECT current.attempt_id FROM attempts current
                 WHERE current.task_id=upstream.task_id
                 ORDER BY current.attempt_no DESC LIMIT 1
               )
               WHERE dependency.task_id=? ORDER BY upstream.task_id""",
            (task_id,),
            con,
        )
        candidate = None
        provenance = []
        if link.get("candidate_fingerprint"):
            candidate = con.execute(
                """SELECT fingerprint, rule_name, title, description, location,
                          severity, status, canonical_json
                   FROM mode_findings WHERE mode_id=? AND fingerprint=?""",
                (link["mode_id"], link["candidate_fingerprint"]),
            ).fetchone()
            if candidate is not None:
                provenance = state_store.fetchall(
                    """SELECT p.task_id, p.source_kind, p.raw_finding_json, p.evidence_hash
                       FROM mode_finding_provenance p
                       JOIN mode_findings f ON f.finding_id=p.finding_id
                       WHERE f.mode_id=? AND f.fingerprint=?
                       ORDER BY p.provenance_id""",
                    (link["mode_id"], link["candidate_fingerprint"]),
                    con,
                )
        evidence = {
            "base": state.get("evidence_bundle"),
            "dependencies": [
                {
                    "task_id": row["task_id"],
                    "status": row["status"],
                    "result": json.loads(row["result_json"]) if row["result_json"] else None,
                }
                for row in dependencies
            ],
            "candidate": dict(candidate) if candidate is not None else None,
            "provenance": provenance,
        }
        payload["assignment"] = {
            "mode_id": mode["mode_id"],
            "kind": mode["kind"],
            "phase": mode["phase"],
            "round": mode["current_round"],
            "role": link["role"],
            "candidate_fingerprint": link.get("candidate_fingerprint"),
            "proposer_task_id": link.get("proposer_task_id"),
            "profile_hint": json.loads(link["profile_hint_json"]) if link.get("profile_hint_json") else None,
            "dependency_evidence_bundle": mode_models.bounded_bundle(
                evidence,
                reserved_keys=("candidate", "dependencies", "provenance"),
            ),
        }
    return "\n[MODE CONTEXT]\n%s\n" % _json(payload)
