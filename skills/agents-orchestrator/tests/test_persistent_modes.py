import contextlib
import json
import os
import unittest
from unittest import mock


# Isolated Runtime tests must not inherit the parent orchestration identity.
for _prefix in ("AGENT_SWARM_", "AGENTS_ORCHESTRATOR_"):
    for _suffix in (
        "ROOT_ID",
        "TASK_ID",
        "ATTEMPT_ID",
        "ACTOR_TOKEN",
        "AGENT_ID",
        "EXECUTION_NONCE",
        "HOME",
        "SKILL_DIR",
    ):
        os.environ.pop(_prefix + _suffix, None)


from helpers import isolated_runtime

import action_processor
import agent_orchestrator
import execution_secrets
import mode_models
import mode_runtime
import prompt_builder
import recovery
import scheduler
import state_store


def _envelope(identity, action_type, payload, action_id, *, task_id=None, attempt_id=None, token=None):
    return {
        "schema_version": 1,
        "action_id": action_id,
        "root_id": identity["root_id"],
        "task_id": task_id or identity["task_id"],
        "attempt_id": attempt_id or identity["attempt_id"],
        "actor_token": token or identity["actor_token"],
        "type": action_type,
        "payload": payload,
    }


def _estimate(identity, strategy="split", *, task_id=None, attempt_id=None, token=None, action_id="estimate"):
    return action_processor.process_action(
        _envelope(
            identity,
            "submit_estimate",
            {
                "revision": False,
                "strategy": strategy,
                "resolved_intent": "implement",
                "complexity": "high",
                "concerns": [],
                "unknowns": [],
                "estimated_files": [],
                "reason": "deterministic mode test",
            },
            action_id,
            task_id=task_id,
            attempt_id=attempt_id,
            token=token,
        )
    )


def _mark_done(con, task_id, mode_result):
    task = state_store.get_task(task_id, con)
    attempt = state_store.get_current_attempt(task_id, con)
    timestamp = state_store.now()
    encoded = json.dumps({"mode_result": mode_result}, sort_keys=True)
    if attempt is None:
        cursor = con.execute(
            """INSERT INTO attempts(
                 task_id, attempt_no, state, actor_token_hash, backend_id,
                 agent_type, config_json, result_json, created_at, finished_at
               ) VALUES (?, 1, 'done', 'fixture', 'fixture', 'fixture',
                         '{}', ?, ?, ?)""",
            (task_id, encoded, timestamp, timestamp),
        )
        attempt_id = cursor.lastrowid
    else:
        attempt_id = attempt["attempt_id"]
        con.execute(
            """UPDATE attempts SET state='done', retryable=0, result_json=?,
                 finished_at=? WHERE attempt_id=?""",
            (encoded, timestamp, attempt_id),
        )
        launch = state_store.get_current_launch(attempt_id, con)
        if launch is not None:
            con.execute(
                """UPDATE launches SET status='closed', prompt_state='ended',
                     closed_at=?, last_event_at=? WHERE launch_id=?""",
                (timestamp, timestamp, launch["launch_id"]),
            )
            con.execute(
                """UPDATE effects SET status='completed', completed_at=?
                   WHERE launch_id=? AND status IN ('pending','running')""",
                (timestamp, launch["launch_id"]),
            )
    con.execute(
        "UPDATE tasks SET status='done', finished_at=? WHERE task_id=?",
        (timestamp, task_id),
    )
    con.execute(
        "UPDATE mode_tasks SET result_validated=1 WHERE task_id=?",
        (task_id,),
    )
    return attempt_id


def _validation_result(stage, version, *, status="passed"):
    return {
        "stage": stage,
        "status": status,
        "artifact_version": version,
        "commands": ["python3 -m unittest deterministic"],
        "evidence": ["deterministic %s %s" % (stage, status)],
    }


def _activate(con, task_id):
    attempt = state_store.get_current_attempt(task_id, con)
    con.execute(
        "UPDATE attempts SET state='evaluating' WHERE attempt_id=?",
        (attempt["attempt_id"],),
    )
    con.execute("UPDATE tasks SET status='active' WHERE task_id=?", (task_id,))
    launch = state_store.get_current_launch(attempt["attempt_id"], con)
    if launch is not None:
        con.execute(
            """UPDATE launches SET status='running', prompt_state='in_flight',
                 ready_at=COALESCE(ready_at, ?), last_event_at=?
               WHERE launch_id=?""",
            (state_store.now(), state_store.now(), launch["launch_id"]),
        )
    return state_store.get_current_attempt(task_id, con)


class PersistentModeTests(unittest.TestCase):
    def _init(self, cwd, *, acp=False, max_concurrent_agents=20):
        options = {
            "require_final_review": False,
            "max_concurrent_agents": max_concurrent_agents,
            "backend": "claude_cli",
        }
        if acp:
            options.update(
                {
                    "backend": "acp",
                    "acp_agent": "custom",
                    "acp_command": "/bin/true",
                    "acp_args": [],
                }
            )
        identity = agent_orchestrator.initialize_run("mode root", str(cwd), **options)
        _estimate(identity)
        return identity

    def _start_review(self, identity, *, config=None, evidence=None, action_id="start-review"):
        payload = {
            "mode": "multi-session-review",
            "objective": "Review the candidate implementation.",
            "config": config or {},
        }
        if evidence is not None:
            payload["evidence"] = evidence
        return action_processor.process_action(
            _envelope(identity, "start_mode", payload, action_id)
        )

    def test_bounded_bundle_reserves_oversized_evidence_sections(self):
        evidence = {
            "base": {"content": "BASE_OVERSIZED_SENTINEL" + ("x" * 20_000)},
            "candidate": {"title": "CANDIDATE_SENTINEL"},
            "dependencies": [{"result": "DEPENDENCY_SENTINEL"}],
            "provenance": [{"evidence": "PROVENANCE_SENTINEL"}],
        }
        bundle = mode_models.bounded_bundle(
            evidence,
            reserved_keys=("candidate", "dependencies", "provenance"),
        )

        self.assertEqual(
            bundle,
            mode_models.bounded_bundle(
                evidence,
                reserved_keys=("candidate", "dependencies", "provenance"),
            ),
        )
        encoded = mode_models.canonical_json(evidence).encode("utf-8")
        self.assertEqual(len(encoded), bundle["bytes"])
        self.assertEqual(mode_models.digest(evidence), bundle["sha256"])
        self.assertTrue(bundle["truncated"])
        self.assertLessEqual(
            len(bundle["content"].encode("utf-8")),
            mode_models.MAX_EVIDENCE_BYTES,
        )
        sections = json.loads(bundle["content"])["sections"]
        self.assertIn("BASE_OVERSIZED_SENTINEL", sections["base"]["content"])
        self.assertIn("CANDIDATE_SENTINEL", sections["candidate"]["content"])
        self.assertIn("DEPENDENCY_SENTINEL", sections["dependencies"]["content"])
        self.assertIn("PROVENANCE_SENTINEL", sections["provenance"]["content"])

    def test_schema_v3_actions_and_inspection_are_real_persistent_facts(self):
        with isolated_runtime() as (_, cwd):
            identity = self._init(cwd)
            with contextlib.closing(state_store.connect()) as con:
                self.assertEqual(
                    [1, 2, 3],
                    [
                        row["version"]
                        for row in con.execute(
                            "SELECT version FROM schema_migrations ORDER BY version"
                        )
                    ],
                )
                tables = {
                    row["name"]
                    for row in con.execute(
                        "SELECT name FROM sqlite_master WHERE type='table'"
                    )
                }
                mode_tasks_sql = con.execute(
                    "SELECT sql FROM sqlite_master WHERE type='table' AND name='mode_tasks'"
                ).fetchone()["sql"]
            self.assertTrue(
                {
                    "modes",
                    "mode_rounds",
                    "mode_tasks",
                    "mode_findings",
                    "mode_finding_provenance",
                    "mode_verifications",
                }.issubset(tables)
            )
            self.assertIn("start_mode", agent_orchestrator.ACTION_SCHEMAS)
            self.assertIn("advance_mode", agent_orchestrator.ACTION_SCHEMAS)
            self.assertIn("'validator'", mode_tasks_sql)
            self.assertIn(
                "mode_result",
                agent_orchestrator.ACTION_SCHEMAS["finish"]["properties"],
            )
            self.assertEqual([], state_store.inspect_modes(identity["root_id"]))

    def test_cancelled_review_cannot_report_passing_consensus(self):
        with isolated_runtime() as (_, cwd):
            identity = self._init(cwd, acp=True)
            started = self._start_review(
                identity,
                config={"create_fix_tasks": False},
                action_id="start-cancelled-review",
            )
            cancelled = action_processor.process_action(
                _envelope(
                    identity,
                    "advance_mode",
                    {
                        "mode_id": started["mode_id"],
                        "operation": "cancel",
                        "reason": "deterministic cancellation",
                    },
                    "cancel-review",
                )
            )
            self.assertEqual("cancelled", cancelled["status"])
            self.assertEqual("cancelled", cancelled["outcome"])
            self.assertEqual("blocked", cancelled["verdict"])
            self.assertEqual("blocked", cancelled["consensus"]["verdict"])

    def test_consensus_reports_escalated_duplicate_severity(self):
        with isolated_runtime() as (_, cwd):
            identity = self._init(cwd, acp=True)
            started = self._start_review(
                identity,
                config={"create_fix_tasks": False},
                action_id="start-severity-review",
            )
            finding = {
                "rule": "severity",
                "title": "Duplicate severity",
                "description": "The same finding was reported twice.",
                "claim": "Duplicate reports must retain the highest severity.",
                "location": "mode_runtime.py:1",
                "severity": "low",
                "evidence": ["first report"],
                "impact": "Consensus consumers otherwise receive stale risk data.",
                "confidence": 0.9,
            }
            with state_store.transaction() as con:
                mode = state_store.get_mode(started["mode_id"], con)
                fingerprint, _ = mode_runtime._record_finding(
                    con,
                    mode,
                    started["task_ids"][0],
                    finding,
                    "reviewer",
                )
                escalated = dict(finding)
                escalated["severity"] = "high"
                escalated["evidence"] = ["independent escalation"]
                duplicate_fingerprint, _ = mode_runtime._record_finding(
                    con,
                    mode,
                    started["task_ids"][1],
                    escalated,
                    "reviewer",
                )
                self.assertEqual(fingerprint, duplicate_fingerprint)
                con.execute(
                    "UPDATE mode_findings SET status='unresolved' WHERE mode_id=?",
                    (started["mode_id"],),
                )
                persisted = con.execute(
                    "SELECT severity FROM mode_findings WHERE mode_id=?",
                    (started["mode_id"],),
                ).fetchone()
                consensus = mode_runtime._consensus_summary(
                    con, mode, "completed"
                )
            self.assertEqual("high", persisted["severity"])
            self.assertEqual(
                "high", consensus["unresolved_findings"][0]["severity"]
            )
            self.assertEqual("changes_requested", consensus["verdict"])

    def test_existing_v1_database_is_migrated_in_place(self):
        with isolated_runtime():
            with contextlib.closing(state_store.connect()) as con:
                con.executescript(state_store.SCHEMA_SQL)
                con.execute(
                    "INSERT INTO schema_migrations(version, applied_at) VALUES (1, ?)",
                    (state_store.now(),),
                )
            state_store.initialize_schema()
            with contextlib.closing(state_store.connect()) as con:
                self.assertEqual(
                    [1, 2, 3],
                    [
                        row["version"]
                        for row in con.execute(
                            "SELECT version FROM schema_migrations ORDER BY version"
                        )
                    ],
                )
                self.assertIsNotNone(
                    con.execute(
                        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='modes'"
                    ).fetchone()
                )

    def test_mode_profile_hints_are_allowlisted_non_empty_names(self):
        with isolated_runtime() as (_, cwd):
            identity = self._init(cwd, acp=True)
            with self.assertRaisesRegex(
                action_processor.ActionError, "non-empty profile name"
            ):
                self._start_review(
                    identity,
                    config={
                        "reviewers": [
                            {"id": "one", "profile_hint": {"name": "custom"}},
                            {"id": "two", "profile_hint": "custom"},
                            {"id": "three", "profile_hint": "custom"},
                        ]
                    },
                    action_id="object-profile-hint",
                )
            with self.assertRaisesRegex(
                action_processor.ActionError, "Run profile allowlist"
            ):
                self._start_review(
                    identity,
                    config={
                        "reviewers": [
                            {"id": "one", "profile_hint": "codex"},
                            {"id": "two", "profile_hint": "custom"},
                            {"id": "three", "profile_hint": "custom"},
                        ]
                    },
                    action_id="unallowlisted-profile-hint",
                )
            started = self._start_review(
                identity,
                config={
                    "reviewers": [
                        {"id": "one", "profile_hint": "custom"},
                        {"id": "two", "profile_hint": "custom"},
                        {"id": "three", "profile_hint": "custom"},
                    ]
                },
                action_id="allowlisted-profile-hint",
            )
            rows = state_store.fetchall(
                "SELECT * FROM mode_tasks WHERE mode_id=? ORDER BY task_id",
                (started["mode_id"],),
            )
            self.assertEqual(3, len(rows))
            for row in rows:
                self.assertEqual("custom", json.loads(row["profile_hint_json"]))
                constraints = json.loads(
                    state_store.get_task(row["task_id"])["constraints_json"]
                )
                self.assertEqual("custom", constraints["profile_hint"])
                self.assertIsInstance(constraints["profile_hint"], str)

    def test_swarm_reuses_task_tree_compilation_and_schedules_once(self):
        with isolated_runtime() as (_, cwd):
            identity = self._init(cwd)
            payload = {
                "mode": "swarm",
                "objective": "Compile an existing task tree.",
                "tasks": [
                    {
                        "key": "producer",
                        "goal": "Produce evidence.",
                        "intent_hint": "implement",
                        "output_contract": "Produce evidence.",
                    },
                    {
                        "key": "consumer",
                        "goal": "Consume evidence.",
                        "intent_hint": "integrate",
                        "output_contract": "Consume evidence.",
                        "depends_on": [
                            {"task_key": "producer", "condition": "success"}
                        ],
                    },
                ],
            }
            with mock.patch.object(
                scheduler, "schedule_with_connection", return_value=[]
            ) as schedule:
                started = action_processor.process_action(
                    _envelope(identity, "start_mode", payload, "start-swarm")
                )
            self.assertEqual(1, schedule.call_count)
            producer, consumer = started["task_ids"]
            dependency = state_store.fetchall(
                "SELECT * FROM task_dependencies WHERE task_id=?", (consumer,)
            )
            self.assertEqual(producer, dependency[0]["depends_on_task_id"])
            with state_store.transaction() as con:
                _mark_done(
                    con,
                    producer,
                    {"status": "done", "evidence": ["producer complete"]},
                )
                _mark_done(
                    con,
                    consumer,
                    {"status": "done", "evidence": ["consumer complete"]},
                )
            advanced = action_processor.process_action(
                _envelope(
                    identity,
                    "advance_mode",
                    {"mode_id": started["mode_id"]},
                    "advance-swarm",
                )
            )
            self.assertEqual("completed", advanced["status"])
            inspected = state_store.inspect_modes(
                identity["root_id"], started["mode_id"]
            )[0]
            self.assertEqual("completed", inspected["status"])
            self.assertEqual(2, len(inspected["tasks"]))

    def test_finish_validates_and_runtime_fingerprints_mode_result(self):
        with isolated_runtime() as (_, cwd):
            identity = self._init(cwd, max_concurrent_agents=2)
            started = action_processor.process_action(
                _envelope(
                    identity,
                    "start_mode",
                    {
                        "mode": "swarm",
                        "objective": "One task.",
                        "tasks": [
                            {
                                "key": "leaf",
                                "goal": "Finish mode leaf.",
                                "intent_hint": "implement",
                                "output_contract": "Finish leaf.",
                            }
                        ],
                    },
                    "start-finish-validation",
                )
            )
            task_id = started["task_ids"][0]
            with state_store.transaction() as con:
                attempt = _activate(con, task_id)
            run = state_store.get_run(identity["root_id"])
            token = execution_secrets.derive_attempt_token(run, attempt["attempt_id"])
            _estimate(
                identity,
                strategy="direct",
                task_id=task_id,
                attempt_id=attempt["attempt_id"],
                token=token,
                action_id="leaf-estimate",
            )
            base = {
                "status": "done",
                "summary": "leaf done",
                "changed_files": [],
                "caveats": [],
            }
            with self.assertRaisesRegex(
                action_processor.ActionError, "mode_result"
            ):
                action_processor.process_action(
                    _envelope(
                        identity,
                        "finish",
                        base,
                        "leaf-finish-missing",
                        task_id=task_id,
                        attempt_id=attempt["attempt_id"],
                        token=token,
                    )
                )
            valid = dict(base)
            valid["mode_result"] = {
                "status": "done",
                "evidence": ["validated"],
            }
            action_processor.process_action(
                _envelope(
                    identity,
                    "finish",
                    valid,
                    "leaf-finish-valid",
                    task_id=task_id,
                    attempt_id=attempt["attempt_id"],
                    token=token,
                )
            )
            result = json.loads(
                state_store.get_current_attempt(task_id)["result_json"]
            )["mode_result"]
            self.assertTrue(result["runtime_result_fingerprint"])
            self.assertEqual(
                1, state_store.get_mode_task(task_id)["result_validated"]
            )

    def test_review_source_self_is_executable_and_read_only_finish_is_enforced(self):
        with isolated_runtime() as (_, cwd):
            identity = agent_orchestrator.initialize_run(
                "self review",
                str(cwd),
                require_final_review=False,
                backend="claude_cli",
            )
            action_processor.process_action(
                _envelope(
                    identity,
                    "submit_estimate",
                    {
                        "revision": False,
                        "strategy": "direct",
                        "resolved_intent": "review",
                        "complexity": "medium",
                        "concerns": [],
                        "unknowns": [],
                        "estimated_files": [],
                        "reason": "exercise self review finish",
                    },
                    "self-review-estimate",
                )
            )
            finished = action_processor.process_action(
                _envelope(
                    identity,
                    "finish",
                    {
                        "status": "done",
                        "summary": "review passed",
                        "changed_files": [],
                        "caveats": [],
                        "review": {
                            "status": "pass",
                            "source": "self",
                            "findings": [],
                        },
                    },
                    "self-review-finish",
                )
            )
            self.assertTrue(finished["accepted"])

        with isolated_runtime() as (_, cwd):
            identity = self._init(cwd, acp=True)
            started = self._start_review(
                identity, config={"create_fix_tasks": False}
            )
            reviewer_task_id = started["task_ids"][0]
            constraints = json.loads(
                state_store.get_task(reviewer_task_id)["constraints_json"]
            )
            self.assertTrue(constraints["read_only"])
            with state_store.transaction() as con:
                attempt = _activate(con, reviewer_task_id)
            token = execution_secrets.derive_attempt_token(
                state_store.get_run(identity["root_id"]), attempt["attempt_id"]
            )
            action_processor.process_action(
                _envelope(
                    identity,
                    "submit_estimate",
                    {
                        "revision": False,
                        "strategy": "direct",
                        "resolved_intent": "review",
                        "complexity": "medium",
                        "concerns": [],
                        "unknowns": [],
                        "estimated_files": [],
                        "reason": "exercise read-only finish gate",
                    },
                    "read-only-review-estimate",
                    task_id=reviewer_task_id,
                    attempt_id=attempt["attempt_id"],
                    token=token,
                )
            )
            with self.assertRaisesRegex(
                action_processor.ActionError,
                "cannot finish done with changed_files",
            ):
                action_processor.process_action(
                    _envelope(
                        identity,
                        "finish",
                        {
                            "status": "done",
                            "summary": "invalid mutation",
                            "changed_files": ["src/modified.py"],
                            "caveats": [],
                            "validation": {"status": "passed"},
                            "review": {
                                "status": "pass",
                                "source": "self",
                                "findings": [],
                            },
                            "mode_result": {"findings": []},
                        },
                        "read-only-review-finish",
                        task_id=reviewer_task_id,
                        attempt_id=attempt["attempt_id"],
                        token=token,
                    )
                )
            self.assertEqual(
                "active", state_store.get_task(reviewer_task_id)["status"]
            )

    def test_loop_contract_requires_validation_and_preserves_standard_finding_fields(self):
        config = mode_models.normalize_config(
            "develop_review_improve",
            {
                "phases": list(mode_models.LOOP_PHASES),
                "exit_conditions": dict(mode_models.LOOP_EXIT_CONDITIONS),
            },
        )
        self.assertEqual(mode_models.LOOP_PHASES, config["phases"])
        self.assertEqual(
            mode_models.LOOP_EXIT_CONDITIONS, config["exit_conditions"]
        )
        with self.assertRaisesRegex(ValueError, "canonical v1 phase order"):
            mode_models.normalize_config(
                "develop_review_improve", {"phases": ["develop", "review"]}
            )
        with self.assertRaisesRegex(ValueError, "unsupported"):
            mode_models.normalize_config(
                "develop_review_improve", {"decorative_phase": "ignored"}
            )
        validator = mode_models.validate_mode_result(
            {"role": "validator", "phase": "validate"},
            {"kind": "develop_review_improve"},
            _validation_result("validation", "artifact-v1"),
        )
        self.assertEqual("passed", validator["status"])
        finding = {
            "rule": "contract",
            "title": "Standard finding",
            "description": "The contract is violated.",
            "claim": "The validator drops required data.",
            "location": "mode.py:1",
            "severity": "high",
            "evidence": ["reproduction"],
            "impact": "Downstream consensus loses material evidence.",
            "confidence": 0.93,
        }
        normalized = mode_models.validate_finding(
            finding, require_standard=True
        )
        self.assertEqual(
            {
                "claim": finding["claim"],
                "impact": finding["impact"],
                "confidence": finding["confidence"],
            },
            {
                "claim": normalized["claim"],
                "impact": normalized["impact"],
                "confidence": normalized["confidence"],
            },
        )
        incomplete = dict(finding)
        incomplete.pop("claim")
        with self.assertRaisesRegex(ValueError, "claim is required"):
            mode_models.validate_mode_result(
                {"role": "reviewer"},
                {"kind": "multi_session_review"},
                {"findings": [incomplete]},
            )

    def test_develop_review_improve_guards_no_progress_round_time_and_repeat(self):
        with isolated_runtime() as (_, cwd):
            identity = self._init(cwd)
            started = action_processor.process_action(
                _envelope(
                    identity,
                    "start_mode",
                    {
                        "mode": "develop-review-improve",
                        "objective": "Bounded loop.",
                        "config": {"max_rounds": 1, "max_no_progress": 1},
                    },
                    "start-loop",
                )
            )
            with state_store.transaction() as con:
                _mark_done(
                    con,
                    started["task_ids"][0],
                    {
                        "summary": "developed",
                        "state": {"version": 1},
                        "evidence": ["deterministic validation passed"],
                    },
                )
            validation = action_processor.process_action(
                _envelope(
                    identity,
                    "advance_mode",
                    {"mode_id": started["mode_id"]},
                    "loop-validation",
                )
            )
            self.assertEqual("validate", validation["phase"])
            with state_store.transaction() as con:
                _mark_done(
                    con,
                    validation["task_ids"][0],
                    _validation_result("validation", "v1"),
                )
            review = action_processor.process_action(
                _envelope(
                    identity,
                    "advance_mode",
                    {"mode_id": started["mode_id"]},
                    "loop-review",
                )
            )
            finding = {
                "title": "Loop defect",
                "description": "Needs improvement.",
                "severity": "medium",
                "location": "loop.py:1",
                "rule": "loop",
                "evidence": ["reproduced"],
            }
            with state_store.transaction() as con:
                _mark_done(
                    con,
                    review["task_ids"][0],
                    {"verdict": "changes_requested", "findings": [finding]},
                )
            verify = action_processor.process_action(
                _envelope(
                    identity,
                    "advance_mode",
                    {"mode_id": started["mode_id"]},
                    "loop-verify",
                )
            )
            self.assertEqual("verify", verify["phase"])
            self.assertEqual(2, len(verify["task_ids"]))
            with state_store.transaction() as con:
                for row in state_store.fetchall(
                    "SELECT * FROM mode_tasks WHERE task_id IN (?, ?)",
                    tuple(verify["task_ids"]),
                    con,
                ):
                    _mark_done(
                        con,
                        row["task_id"],
                        {
                            "candidate_fingerprint": row["candidate_fingerprint"],
                            "verdict": "confirmed",
                            "evidence": ["independent confirmation"],
                            "discovered_findings": [],
                        },
                    )
            improve = action_processor.process_action(
                _envelope(
                    identity,
                    "advance_mode",
                    {"mode_id": started["mode_id"]},
                    "loop-improve",
                )
            )
            with state_store.transaction() as con:
                _mark_done(
                    con,
                    improve["task_ids"][0],
                    {
                        "changed": True,
                        "addressed_fingerprints": [],
                        "evidence": ["changed"],
                    },
                )
            revalidation = action_processor.process_action(
                _envelope(
                    identity,
                    "advance_mode",
                    {"mode_id": started["mode_id"]},
                    "loop-revalidation",
                )
            )
            self.assertEqual("revalidate", revalidation["phase"])
            with state_store.transaction() as con:
                _mark_done(
                    con,
                    revalidation["task_ids"][0],
                    _validation_result("revalidation", "v2"),
                )
            guarded = action_processor.process_action(
                _envelope(
                    identity,
                    "advance_mode",
                    {"mode_id": started["mode_id"]},
                    "loop-max-round",
                )
            )
            self.assertEqual("blocked", guarded["status"])
            self.assertEqual("budget_exhausted", guarded["outcome"])
            self.assertIn("max_rounds", guarded["reason"])

            repeated = action_processor.process_action(
                _envelope(
                    identity,
                    "start_mode",
                    {
                        "mode": "develop_review_improve",
                        "objective": "Repeated state.",
                        "config": {"max_no_progress": 1},
                    },
                    "start-repeat",
                )
            )
            first_repeat = action_processor.process_action(
                _envelope(
                    identity,
                    "advance_mode",
                    {"mode_id": repeated["mode_id"]},
                    "repeat-once",
                )
            )
            self.assertEqual("running", first_repeat["status"])
            no_progress = action_processor.process_action(
                _envelope(
                    identity,
                    "advance_mode",
                    {"mode_id": repeated["mode_id"]},
                    "repeat-twice",
                )
            )
            self.assertEqual("blocked", no_progress["status"])
            self.assertIn("repeated-state", no_progress["reason"])

            timed = action_processor.process_action(
                _envelope(
                    identity,
                    "start_mode",
                    {"mode": "swarm", "objective": "Timed.", "tasks": [
                        {
                            "key": "timed",
                            "goal": "Wait.",
                            "intent_hint": "implement",
                            "output_contract": "Wait.",
                        }
                    ]},
                    "start-time",
                )
            )
            with state_store.transaction() as con:
                con.execute(
                    "UPDATE modes SET deadline_at=? WHERE mode_id=?",
                    (state_store.now() - 1, timed["mode_id"]),
                )
            timed_out = action_processor.process_action(
                _envelope(
                    identity,
                    "advance_mode",
                    {"mode_id": timed["mode_id"]},
                    "advance-time",
                )
            )
            self.assertIn("max_seconds", timed_out["reason"])

    def test_loop_verifies_before_improve_then_re_reviews_and_ignores_false_positive(self):
        with isolated_runtime() as (_, cwd):
            identity = self._init(cwd)
            started = action_processor.process_action(
                _envelope(
                    identity,
                    "start_mode",
                    {
                        "mode": "develop_review_improve",
                        "objective": "Fix one real defect and re-review.",
                        "config": {"max_rounds": 2},
                    },
                    "loop-success-start",
                )
            )
            with state_store.transaction() as con:
                _mark_done(
                    con,
                    started["task_ids"][0],
                    {
                        "summary": "implemented version one",
                        "state": {"version": 1},
                        "evidence": ["tests exposed the defect"],
                    },
                )
            validation = action_processor.process_action(
                _envelope(
                    identity,
                    "advance_mode",
                    {"mode_id": started["mode_id"]},
                    "loop-success-validation",
                )
            )
            with state_store.transaction() as con:
                _mark_done(
                    con,
                    validation["task_ids"][0],
                    _validation_result("validation", "v1"),
                )
            review = action_processor.process_action(
                _envelope(
                    identity,
                    "advance_mode",
                    {"mode_id": started["mode_id"]},
                    "loop-success-review",
                )
            )
            finding = {
                "title": "Real defect",
                "description": "The deterministic check fails.",
                "severity": "medium",
                "location": "feature.py:1",
                "rule": "deterministic-check",
                "evidence": ["reproduction command failed"],
            }
            with state_store.transaction() as con:
                _mark_done(
                    con,
                    review["task_ids"][0],
                    {"verdict": "changes_requested", "findings": [finding]},
                )
            verify = action_processor.process_action(
                _envelope(
                    identity,
                    "advance_mode",
                    {"mode_id": started["mode_id"]},
                    "loop-success-verify",
                )
            )
            self.assertEqual("verify", verify["phase"])
            self.assertEqual([], state_store.fetchall(
                "SELECT * FROM mode_tasks WHERE mode_id=? AND role='improver'",
                (started["mode_id"],),
            ))
            with state_store.transaction() as con:
                verifier_rows = state_store.fetchall(
                    "SELECT * FROM mode_tasks WHERE task_id IN (?, ?)",
                    tuple(verify["task_ids"]),
                    con,
                )
                fingerprint = verifier_rows[0]["candidate_fingerprint"]
                for row in verifier_rows:
                    _mark_done(
                        con,
                        row["task_id"],
                        {
                            "candidate_fingerprint": fingerprint,
                            "verdict": "confirmed",
                            "evidence": ["independent reproduction"],
                            "discovered_findings": [],
                        },
                    )
            improve = action_processor.process_action(
                _envelope(
                    identity,
                    "advance_mode",
                    {"mode_id": started["mode_id"]},
                    "loop-success-improve",
                )
            )
            self.assertEqual("improve", improve["phase"])
            with state_store.transaction() as con:
                _mark_done(
                    con,
                    improve["task_ids"][0],
                    {
                        "changed": True,
                        "addressed_fingerprints": [fingerprint],
                        "evidence": ["deterministic check now passes"],
                    },
                )
            revalidation = action_processor.process_action(
                _envelope(
                    identity,
                    "advance_mode",
                    {"mode_id": started["mode_id"]},
                    "loop-success-revalidation",
                )
            )
            self.assertEqual("revalidate", revalidation["phase"])
            with state_store.transaction() as con:
                _mark_done(
                    con,
                    revalidation["task_ids"][0],
                    _validation_result("revalidation", "v2"),
                )
            second_review = action_processor.process_action(
                _envelope(
                    identity,
                    "advance_mode",
                    {"mode_id": started["mode_id"]},
                    "loop-success-second-review",
                )
            )
            self.assertEqual(2, second_review["round"])
            self.assertEqual("re_review", second_review["phase"])
            with state_store.transaction() as con:
                _mark_done(
                    con,
                    second_review["task_ids"][0],
                    {"verdict": "pass", "findings": []},
                )
            passed = action_processor.process_action(
                _envelope(
                    identity,
                    "advance_mode",
                    {"mode_id": started["mode_id"]},
                    "loop-success-pass",
                )
            )
            self.assertEqual("completed", passed["status"])
            self.assertIn("review passed", passed["reason"])

            rejected = action_processor.process_action(
                _envelope(
                    identity,
                    "start_mode",
                    {
                        "mode": "develop_review_improve",
                        "objective": "Reject a false positive.",
                    },
                    "loop-rejected-start",
                )
            )
            with state_store.transaction() as con:
                _mark_done(
                    con,
                    rejected["task_ids"][0],
                    {
                        "summary": "unchanged valid implementation",
                        "evidence": ["baseline tests pass"],
                    },
                )
            rejected_validation = action_processor.process_action(
                _envelope(
                    identity,
                    "advance_mode",
                    {"mode_id": rejected["mode_id"]},
                    "loop-rejected-validation",
                )
            )
            with state_store.transaction() as con:
                _mark_done(
                    con,
                    rejected_validation["task_ids"][0],
                    _validation_result("validation", "unchanged"),
                )
            rejected_review = action_processor.process_action(
                _envelope(
                    identity,
                    "advance_mode",
                    {"mode_id": rejected["mode_id"]},
                    "loop-rejected-review",
                )
            )
            with state_store.transaction() as con:
                _mark_done(
                    con,
                    rejected_review["task_ids"][0],
                    {"verdict": "changes_requested", "findings": [finding]},
                )
            rejected_verify = action_processor.process_action(
                _envelope(
                    identity,
                    "advance_mode",
                    {"mode_id": rejected["mode_id"]},
                    "loop-rejected-verify",
                )
            )
            with state_store.transaction() as con:
                for row in state_store.fetchall(
                    "SELECT * FROM mode_tasks WHERE task_id IN (?, ?)",
                    tuple(rejected_verify["task_ids"]),
                    con,
                ):
                    _mark_done(
                        con,
                        row["task_id"],
                        {
                            "candidate_fingerprint": row["candidate_fingerprint"],
                            "verdict": "rejected",
                            "evidence": ["counterexample disproves the claim"],
                            "discovered_findings": [],
                        },
                    )
            no_fix = action_processor.process_action(
                _envelope(
                    identity,
                    "advance_mode",
                    {"mode_id": rejected["mode_id"]},
                    "loop-rejected-complete",
                )
            )
            self.assertEqual("completed", no_fix["status"])
            self.assertIn("not confirmed", no_fix["reason"])
            self.assertEqual([], state_store.fetchall(
                "SELECT * FROM mode_tasks WHERE mode_id=? AND role='improver'",
                (rejected["mode_id"],),
            ))

    def test_multi_session_review_dedupes_provenance_expands_and_fixes_only_confirmed(self):
        with isolated_runtime() as (_, cwd):
            identity = self._init(cwd, acp=True)
            started = self._start_review(
                identity,
                config={
                    "create_fix_tasks": True,
                    "max_expansions": 1,
                    "max_candidates": 5,
                },
            )
            reviewer_rows = state_store.fetchall(
                """SELECT * FROM mode_tasks
                   WHERE mode_id=? AND role='reviewer' ORDER BY task_id""",
                (started["mode_id"],),
            )
            self.assertGreaterEqual(len(reviewer_rows), 3)
            confirmed = {
                "title": "Confirmed bug",
                "description": "A deterministic confirmed defect.",
                "severity": "medium",
                "location": "a.py:1",
                "rule": "A",
                "evidence": ["review evidence"],
            }
            rejected = {
                "title": "Rejected bug",
                "description": "A deterministic false positive.",
                "severity": "low",
                "location": "b.py:1",
                "rule": "B",
                "evidence": ["review evidence"],
            }
            with state_store.transaction() as con:
                for row in reviewer_rows:
                    _mark_done(
                        con,
                        row["task_id"],
                        {"findings": [confirmed, rejected]},
                    )
            with mock.patch.object(
                scheduler, "schedule_with_connection", return_value=[]
            ) as schedule:
                verify = action_processor.process_action(
                    _envelope(
                        identity,
                        "advance_mode",
                        {"mode_id": started["mode_id"]},
                        "review-to-verify",
                    )
                )
            self.assertEqual(1, schedule.call_count)
            inspected = state_store.inspect_modes(
                identity["root_id"], started["mode_id"]
            )[0]
            self.assertEqual(6, len(inspected["provenance"]))
            by_candidate = {}
            for row in inspected["tasks"]:
                if row["role"].startswith("verifier_"):
                    by_candidate.setdefault(row["candidate_fingerprint"], []).append(row)
            self.assertEqual(2, len(by_candidate))
            for rows in by_candidate.values():
                self.assertEqual(
                    {"verifier_reproduce", "verifier_falsify"},
                    {row["role"] for row in rows},
                )
                self.assertEqual(2, len({row["task_id"] for row in rows}))
                self.assertTrue(
                    all(row["task_id"] != row["proposer_task_id"] for row in rows)
                )
            confirmed_fp = next(
                row["fingerprint"]
                for row in inspected["findings"]
                if row["title"] == "Confirmed bug"
            )
            rejected_fp = next(
                row["fingerprint"]
                for row in inspected["findings"]
                if row["title"] == "Rejected bug"
            )
            discovered = {
                "title": "Verifier discovery",
                "description": "A bounded expansion candidate.",
                "severity": "low",
                "location": "c.py:1",
                "rule": "C",
                "evidence": ["verifier evidence"],
            }
            with state_store.transaction() as con:
                for index, row in enumerate(
                    state_store.fetchall(
                        """SELECT * FROM mode_tasks WHERE mode_id=?
                           AND role IN ('verifier_reproduce','verifier_falsify')
                           ORDER BY task_id""",
                        (started["mode_id"],),
                        con,
                    )
                ):
                    verdict = (
                        "confirmed"
                        if row["candidate_fingerprint"] == confirmed_fp
                        else "rejected"
                    )
                    _mark_done(
                        con,
                        row["task_id"],
                        {
                            "candidate_fingerprint": row["candidate_fingerprint"],
                            "verdict": verdict,
                            "evidence": ["verifier verdict"],
                            "discovered_findings": [discovered] if index == 0 else [],
                        },
                    )
            expanded = action_processor.process_action(
                _envelope(
                    identity,
                    "advance_mode",
                    {"mode_id": started["mode_id"]},
                    "verify-expand",
                )
            )
            self.assertEqual("verify", expanded["phase"])
            self.assertEqual(2, len(expanded["task_ids"]))
            expanded_rows = state_store.fetchall(
                """SELECT * FROM mode_tasks WHERE task_id IN (?, ?) ORDER BY task_id""",
                tuple(expanded["task_ids"]),
            )
            discovered_fp = expanded_rows[0]["candidate_fingerprint"]
            with state_store.transaction() as con:
                for row in expanded_rows:
                    _mark_done(
                        con,
                        row["task_id"],
                        {
                            "candidate_fingerprint": discovered_fp,
                            "verdict": "rejected",
                            "evidence": ["discovery rejected"],
                            "discovered_findings": [],
                        },
                    )
            fix = action_processor.process_action(
                _envelope(
                    identity,
                    "advance_mode",
                    {"mode_id": started["mode_id"]},
                    "verify-to-fix",
                )
            )
            self.assertEqual("fix", fix["phase"])
            self.assertEqual(1, len(fix["task_ids"]))
            fixer = state_store.get_mode_task(fix["task_ids"][0])
            self.assertEqual(confirmed_fp, fixer["candidate_fingerprint"])
            findings = {
                row["fingerprint"]: row["status"]
                for row in state_store.inspect_modes(
                    identity["root_id"], started["mode_id"]
                )[0]["findings"]
            }
            self.assertEqual("confirmed", findings[confirmed_fp])
            self.assertEqual("rejected", findings[rejected_fp])
            self.assertEqual("rejected", findings[discovered_fp])

    def test_review_is_acp_only_and_high_unresolved_or_task_guard_blocks(self):
        with isolated_runtime() as (_, cwd):
            identity = self._init(cwd)
            with self.assertRaisesRegex(
                action_processor.ActionError, "ACP-only"
            ):
                self._start_review(identity)

        with isolated_runtime() as (_, cwd):
            identity = self._init(cwd, acp=True)
            started = self._start_review(
                identity,
                config={"max_tasks": 3, "create_fix_tasks": False},
            )
            finding = {
                "title": "Guarded",
                "description": "Needs verifiers but task budget is exhausted.",
                "severity": "high",
                "location": "guard.py:1",
                "rule": "guard",
                "evidence": ["proof"],
            }
            with state_store.transaction() as con:
                for row in state_store.fetchall(
                    "SELECT * FROM mode_tasks WHERE mode_id=?",
                    (started["mode_id"],),
                    con,
                ):
                    _mark_done(con, row["task_id"], {"findings": [finding]})
            blocked = action_processor.process_action(
                _envelope(
                    identity,
                    "advance_mode",
                    {"mode_id": started["mode_id"]},
                    "task-guard",
                )
            )
            self.assertEqual("blocked", blocked["status"])
            self.assertIn("max_tasks", blocked["reason"])

        with isolated_runtime() as (_, cwd):
            identity = self._init(cwd, acp=True)
            started = self._start_review(
                identity,
                config={"max_candidates": 1, "create_fix_tasks": False},
            )
            findings = [
                {
                    "title": "Within budget",
                    "description": "The first deterministic candidate.",
                    "severity": "low",
                    "location": "budget.py:1",
                    "rule": "budget-a",
                    "evidence": ["proof"],
                },
                {
                    "title": "Beyond budget",
                    "description": "The second deterministic candidate.",
                    "severity": "low",
                    "location": "budget.py:2",
                    "rule": "budget-b",
                    "evidence": ["proof"],
                },
            ]
            with state_store.transaction() as con:
                for row in state_store.fetchall(
                    "SELECT * FROM mode_tasks WHERE mode_id=?",
                    (started["mode_id"],),
                    con,
                ):
                    _mark_done(con, row["task_id"], {"findings": findings})
            action_processor.process_action(
                _envelope(
                    identity,
                    "advance_mode",
                    {"mode_id": started["mode_id"]},
                    "candidate-verifiers",
                )
            )
            with state_store.transaction() as con:
                for row in state_store.fetchall(
                    """SELECT * FROM mode_tasks WHERE mode_id=?
                       AND role IN ('verifier_reproduce','verifier_falsify')""",
                    (started["mode_id"],),
                    con,
                ):
                    _mark_done(
                        con,
                        row["task_id"],
                        {
                            "candidate_fingerprint": row["candidate_fingerprint"],
                            "verdict": "rejected",
                            "evidence": ["false positive"],
                            "discovered_findings": [],
                        },
                    )
            blocked = action_processor.process_action(
                _envelope(
                    identity,
                    "advance_mode",
                    {"mode_id": started["mode_id"]},
                    "candidate-guard",
                )
            )
            self.assertEqual("blocked", blocked["status"])
            self.assertIn("candidate", blocked["reason"])

        with isolated_runtime() as (_, cwd):
            identity = self._init(cwd, acp=True)
            started = self._start_review(
                identity, config={"create_fix_tasks": False}
            )
            finding = {
                "title": "High unresolved",
                "description": "Verifier evidence conflicts.",
                "severity": "high",
                "location": "high.py:1",
                "rule": "high",
                "evidence": ["proof"],
            }
            with state_store.transaction() as con:
                for row in state_store.fetchall(
                    "SELECT * FROM mode_tasks WHERE mode_id=?",
                    (started["mode_id"],),
                    con,
                ):
                    _mark_done(con, row["task_id"], {"findings": [finding]})
            action_processor.process_action(
                _envelope(
                    identity,
                    "advance_mode",
                    {"mode_id": started["mode_id"]},
                    "high-verifiers",
                )
            )
            with state_store.transaction() as con:
                rows = state_store.fetchall(
                    """SELECT * FROM mode_tasks WHERE mode_id=?
                       AND role IN ('verifier_reproduce','verifier_falsify')
                       ORDER BY role""",
                    (started["mode_id"],),
                    con,
                )
                for index, row in enumerate(rows):
                    _mark_done(
                        con,
                        row["task_id"],
                        {
                            "candidate_fingerprint": row["candidate_fingerprint"],
                            "verdict": "confirmed" if index == 0 else "rejected",
                            "evidence": ["conflicting evidence"],
                            "discovered_findings": [],
                        },
                    )
            blocked = action_processor.process_action(
                _envelope(
                    identity,
                    "advance_mode",
                    {"mode_id": started["mode_id"]},
                    "high-adjudicate",
                )
            )
            self.assertEqual("blocked", blocked["status"])
            self.assertIn("high-severity", blocked["reason"])

    def test_prompt_contains_bounded_hashed_dependency_evidence(self):
        with isolated_runtime() as (_, cwd):
            identity = self._init(cwd, acp=True)
            started = self._start_review(
                identity,
                config={"create_fix_tasks": False},
                evidence={"blob": "BASE_OVERSIZED_SENTINEL" + ("x" * 20_000)},
            )
            finding = {
                "title": "CANDIDATE_SENTINEL",
                "description": "Verifier prompt evidence.",
                "severity": "medium",
                "location": "prompt.py:1",
                "rule": "prompt",
                "evidence": ["PROVENANCE_SENTINEL"],
            }
            with state_store.transaction() as con:
                for row in state_store.fetchall(
                    "SELECT * FROM mode_tasks WHERE mode_id=?",
                    (started["mode_id"],),
                    con,
                ):
                    _mark_done(
                        con,
                        row["task_id"],
                        {
                            "dependency_probe": "DEPENDENCY_SENTINEL",
                            "findings": [finding],
                        },
                    )
            verify = action_processor.process_action(
                _envelope(
                    identity,
                    "advance_mode",
                    {"mode_id": started["mode_id"]},
                    "prompt-verifier",
                )
            )
            task = state_store.get_task(verify["task_ids"][0])
            attempt = state_store.get_current_attempt(task["task_id"])
            with contextlib.closing(state_store.connect()) as con:
                prompt = prompt_builder.build_prompt(
                    state_store.get_run(identity["root_id"]),
                    task,
                    attempt,
                    con,
                )
                first_context = mode_runtime.prompt_context(con, task["task_id"])
                second_context = mode_runtime.prompt_context(con, task["task_id"])
            self.assertIn("[MODE CONTEXT]", prompt)
            self.assertIn("dependency_evidence_bundle", prompt)
            self.assertIn('"sha256"', prompt)
            self.assertIn('"truncated": true', prompt)
            self.assertLess(len(prompt), 30_000)
            self.assertEqual(first_context, second_context)

            context = json.loads(first_context.split("[MODE CONTEXT]\n", 1)[1])
            bundle = context["assignment"]["dependency_evidence_bundle"]
            bounded = json.loads(bundle["content"])
            self.assertEqual("sectioned-canonical-json-v1", bounded["format"])
            self.assertLessEqual(
                len(bundle["content"].encode("utf-8")),
                mode_models.MAX_EVIDENCE_BYTES,
            )
            self.assertEqual(64, len(bundle["sha256"]))
            self.assertTrue(bundle["truncated"])
            sections = bounded["sections"]
            self.assertIn("CANDIDATE_SENTINEL", sections["candidate"]["content"])
            self.assertIn("DEPENDENCY_SENTINEL", sections["dependencies"]["content"])
            self.assertIn("PROVENANCE_SENTINEL", sections["provenance"]["content"])
            self.assertIn("BASE_OVERSIZED_SENTINEL", sections["base"]["content"])

    def test_swarm_loop_review_recovers_and_confirmed_plan_finding_is_re_reviewed(self):
        with isolated_runtime() as (_, cwd):
            identity = self._init(cwd, acp=True, max_concurrent_agents=20)
            swarm = action_processor.process_action(
                _envelope(
                    identity,
                    "start_mode",
                    {
                        "mode": "swarm",
                        "objective": "Deliver a reviewed plan revision.",
                        "tasks": [
                            {
                                "key": "pipeline",
                                "goal": "Run the revision pipeline.",
                                "intent_hint": "integrate",
                                "output_contract": "Complete the nested loop and reviews.",
                            }
                        ],
                    },
                    "composition-swarm",
                )
            )
            pipeline_task_id = swarm["task_ids"][0]
            with state_store.transaction() as con:
                pipeline_attempt = _activate(con, pipeline_task_id)
            run = state_store.get_run(identity["root_id"])
            pipeline_token = execution_secrets.derive_attempt_token(
                run, pipeline_attempt["attempt_id"]
            )
            _estimate(
                identity,
                task_id=pipeline_task_id,
                attempt_id=pipeline_attempt["attempt_id"],
                token=pipeline_token,
                action_id="composition-pipeline-estimate",
            )
            loop = action_processor.process_action(
                _envelope(
                    identity,
                    "start_mode",
                    {
                        "mode": "develop_review_improve",
                        "objective": "Revise the plan only for confirmed findings.",
                        "config": {"max_rounds": 2},
                        "evidence": {"artifact": "plan-v1"},
                    },
                    "composition-loop",
                    task_id=pipeline_task_id,
                    attempt_id=pipeline_attempt["attempt_id"],
                    token=pipeline_token,
                )
            )
            with state_store.transaction() as con:
                _mark_done(
                    con,
                    loop["task_ids"][0],
                    {
                        "summary": "prepared plan v1",
                        "state": {"artifact": "plan-v1"},
                        "evidence": ["plan hash v1"],
                    },
                )
            loop_validation = action_processor.process_action(
                _envelope(
                    identity,
                    "advance_mode",
                    {"mode_id": loop["mode_id"]},
                    "composition-loop-validation",
                    task_id=pipeline_task_id,
                    attempt_id=pipeline_attempt["attempt_id"],
                    token=pipeline_token,
                )
            )
            with state_store.transaction() as con:
                _mark_done(
                    con,
                    loop_validation["task_ids"][0],
                    _validation_result("validation", "plan-v1"),
                )
            loop_review = action_processor.process_action(
                _envelope(
                    identity,
                    "advance_mode",
                    {"mode_id": loop["mode_id"]},
                    "composition-loop-review",
                    task_id=pipeline_task_id,
                    attempt_id=pipeline_attempt["attempt_id"],
                    token=pipeline_token,
                )
            )
            reviewer_task_id = loop_review["task_ids"][0]
            with state_store.transaction() as con:
                reviewer_attempt = _activate(con, reviewer_task_id)
            reviewer_token = execution_secrets.derive_attempt_token(
                run, reviewer_attempt["attempt_id"]
            )
            _estimate(
                identity,
                task_id=reviewer_task_id,
                attempt_id=reviewer_attempt["attempt_id"],
                token=reviewer_token,
                action_id="composition-reviewer-estimate",
            )
            first_review = action_processor.process_action(
                _envelope(
                    identity,
                    "start_mode",
                    {
                        "mode": "multi_session_review",
                        "objective": "Review plan v1.",
                        "config": {"create_fix_tasks": False},
                        "evidence": {"artifact": "plan-v1"},
                    },
                    "composition-first-consensus",
                    task_id=reviewer_task_id,
                    attempt_id=reviewer_attempt["attempt_id"],
                    token=reviewer_token,
                )
            )
            recovered = recovery.recover_root(identity["root_id"], force_takeover=True)
            _estimate(recovered, action_id="composition-recovered-estimate")
            self.assertEqual(
                "review", state_store.get_mode(first_review["mode_id"])["phase"]
            )
            plan_finding = {
                "title": "Missing rollback threshold",
                "description": "The plan cannot make a deterministic rollback decision.",
                "severity": "high",
                "location": "plan:rollback",
                "rule": "rollback-threshold",
                "evidence": ["plan v1 has no numeric threshold"],
            }
            with state_store.transaction() as con:
                for task_id in first_review["task_ids"]:
                    _mark_done(con, task_id, {"findings": [plan_finding]})
            first_verify = action_processor.process_action(
                _envelope(
                    identity,
                    "advance_mode",
                    {"mode_id": first_review["mode_id"]},
                    "composition-first-verify",
                    task_id=reviewer_task_id,
                    attempt_id=reviewer_attempt["attempt_id"],
                    token=reviewer_token,
                )
            )
            with state_store.transaction() as con:
                for row in state_store.fetchall(
                    "SELECT * FROM mode_tasks WHERE task_id IN (?, ?)",
                    tuple(first_verify["task_ids"]),
                    con,
                ):
                    _mark_done(
                        con,
                        row["task_id"],
                        {
                            "candidate_fingerprint": row["candidate_fingerprint"],
                            "verdict": "confirmed",
                            "evidence": ["threshold omission reproduced"],
                            "discovered_findings": [],
                        },
                    )
            first_consensus = action_processor.process_action(
                _envelope(
                    identity,
                    "advance_mode",
                    {"mode_id": first_review["mode_id"]},
                    "composition-first-consensus-done",
                    task_id=reviewer_task_id,
                    attempt_id=reviewer_attempt["attempt_id"],
                    token=reviewer_token,
                )
            )
            self.assertEqual("completed", first_consensus["status"])
            self.assertEqual("changes_requested", first_consensus["verdict"])
            self.assertEqual(
                "confirmed",
                first_consensus["findings"]["confirmed"][0]["status"],
            )
            confirmed = state_store.fetchall(
                "SELECT fingerprint FROM mode_findings WHERE mode_id=? AND status='confirmed'",
                (first_review["mode_id"],),
            )
            self.assertEqual(1, len(confirmed))
            with state_store.transaction() as con:
                _mark_done(
                    con,
                    reviewer_task_id,
                    {"verdict": "changes_requested", "findings": [plan_finding]},
                )
            loop_verify = action_processor.process_action(
                _envelope(
                    identity,
                    "advance_mode",
                    {"mode_id": loop["mode_id"]},
                    "composition-loop-verify",
                    task_id=pipeline_task_id,
                    attempt_id=pipeline_attempt["attempt_id"],
                    token=pipeline_token,
                )
            )
            with state_store.transaction() as con:
                loop_verifiers = state_store.fetchall(
                    "SELECT * FROM mode_tasks WHERE task_id IN (?, ?)",
                    tuple(loop_verify["task_ids"]),
                    con,
                )
                loop_fingerprint = loop_verifiers[0]["candidate_fingerprint"]
                for row in loop_verifiers:
                    _mark_done(
                        con,
                        row["task_id"],
                        {
                            "candidate_fingerprint": loop_fingerprint,
                            "verdict": "confirmed",
                            "evidence": ["consensus evidence retained"],
                            "discovered_findings": [],
                        },
                    )
            improve = action_processor.process_action(
                _envelope(
                    identity,
                    "advance_mode",
                    {"mode_id": loop["mode_id"]},
                    "composition-loop-improve",
                    task_id=pipeline_task_id,
                    attempt_id=pipeline_attempt["attempt_id"],
                    token=pipeline_token,
                )
            )
            with state_store.transaction() as con:
                _mark_done(
                    con,
                    improve["task_ids"][0],
                    {
                        "changed": True,
                        "addressed_fingerprints": [loop_fingerprint],
                        "evidence": ["plan v2 adds a numeric rollback threshold"],
                    },
                )
            revalidation = action_processor.process_action(
                _envelope(
                    identity,
                    "advance_mode",
                    {"mode_id": loop["mode_id"]},
                    "composition-loop-revalidation",
                    task_id=pipeline_task_id,
                    attempt_id=pipeline_attempt["attempt_id"],
                    token=pipeline_token,
                )
            )
            with state_store.transaction() as con:
                _mark_done(
                    con,
                    revalidation["task_ids"][0],
                    _validation_result("revalidation", "plan-v2"),
                )
            second_loop_review = action_processor.process_action(
                _envelope(
                    identity,
                    "advance_mode",
                    {"mode_id": loop["mode_id"]},
                    "composition-loop-second-review",
                    task_id=pipeline_task_id,
                    attempt_id=pipeline_attempt["attempt_id"],
                    token=pipeline_token,
                )
            )
            second_reviewer_task_id = second_loop_review["task_ids"][0]
            with state_store.transaction() as con:
                second_reviewer_attempt = _activate(con, second_reviewer_task_id)
            second_reviewer_token = execution_secrets.derive_attempt_token(
                run, second_reviewer_attempt["attempt_id"]
            )
            _estimate(
                identity,
                task_id=second_reviewer_task_id,
                attempt_id=second_reviewer_attempt["attempt_id"],
                token=second_reviewer_token,
                action_id="composition-second-reviewer-estimate",
            )
            second_review = action_processor.process_action(
                _envelope(
                    identity,
                    "start_mode",
                    {
                        "mode": "multi_session_review",
                        "objective": "Re-review plan v2.",
                        "config": {"create_fix_tasks": False},
                        "evidence": {"artifact": "plan-v2"},
                    },
                    "composition-second-consensus",
                    task_id=second_reviewer_task_id,
                    attempt_id=second_reviewer_attempt["attempt_id"],
                    token=second_reviewer_token,
                )
            )
            with state_store.transaction() as con:
                for task_id in second_review["task_ids"]:
                    _mark_done(con, task_id, {"findings": []})
            second_consensus = action_processor.process_action(
                _envelope(
                    identity,
                    "advance_mode",
                    {"mode_id": second_review["mode_id"]},
                    "composition-second-consensus-done",
                    task_id=second_reviewer_task_id,
                    attempt_id=second_reviewer_attempt["attempt_id"],
                    token=second_reviewer_token,
                )
            )
            self.assertEqual("completed", second_consensus["status"])
            with state_store.transaction() as con:
                _mark_done(
                    con,
                    second_reviewer_task_id,
                    {"verdict": "pass", "findings": []},
                )
            loop_done = action_processor.process_action(
                _envelope(
                    identity,
                    "advance_mode",
                    {"mode_id": loop["mode_id"]},
                    "composition-loop-done",
                    task_id=pipeline_task_id,
                    attempt_id=pipeline_attempt["attempt_id"],
                    token=pipeline_token,
                )
            )
            self.assertEqual("completed", loop_done["status"])
            with state_store.transaction() as con:
                _mark_done(
                    con,
                    pipeline_task_id,
                    {"status": "done", "evidence": ["nested loop completed"]},
                )
            swarm_done = action_processor.process_action(
                _envelope(
                    recovered,
                    "advance_mode",
                    {"mode_id": swarm["mode_id"]},
                    "composition-swarm-done",
                )
            )
            self.assertEqual("completed", swarm_done["status"])
            self.assertEqual(swarm["mode_id"], state_store.get_mode(loop["mode_id"])["parent_mode_id"])
            self.assertEqual(loop["mode_id"], state_store.get_mode(first_review["mode_id"])["parent_mode_id"])
            self.assertEqual(loop["mode_id"], state_store.get_mode(second_review["mode_id"])["parent_mode_id"])

    def test_nested_composition_cycle_depth_recovery_and_cancellation(self):
        with isolated_runtime() as (_, cwd):
            identity = self._init(cwd, max_concurrent_agents=4)
            parent = action_processor.process_action(
                _envelope(
                    identity,
                    "start_mode",
                    {
                        "mode": "swarm",
                        "objective": "Parent mode.",
                        "tasks": [
                            {
                                "key": "owner",
                                "goal": "Own a nested mode.",
                                "intent_hint": "implement",
                                "output_contract": "Complete nested mode.",
                            }
                        ],
                    },
                    "parent-mode",
                )
            )
            child_task_id = parent["task_ids"][0]
            with state_store.transaction() as con:
                child_attempt = _activate(con, child_task_id)
            run = state_store.get_run(identity["root_id"])
            child_token = execution_secrets.derive_attempt_token(
                run, child_attempt["attempt_id"]
            )
            _estimate(
                identity,
                task_id=child_task_id,
                attempt_id=child_attempt["attempt_id"],
                token=child_token,
                action_id="nested-owner-estimate",
            )
            nested = action_processor.process_action(
                _envelope(
                    identity,
                    "start_mode",
                    {
                        "mode": "swarm",
                        "objective": "Nested mode.",
                        "config": {"max_mode_depth": 1},
                        "tasks": [
                            {
                                "key": "nested-leaf",
                                "goal": "Nested leaf.",
                                "intent_hint": "implement",
                                "output_contract": "Finish nested leaf.",
                            }
                        ],
                    },
                    "nested-mode",
                    task_id=child_task_id,
                    attempt_id=child_attempt["attempt_id"],
                    token=child_token,
                )
            )
            nested_row = state_store.get_mode(nested["mode_id"])
            self.assertEqual(parent["mode_id"], nested_row["parent_mode_id"])
            self.assertEqual(1, nested_row["depth"])
            nested_leaf_id = nested["task_ids"][0]
            with state_store.transaction() as con:
                nested_leaf_attempt = _activate(con, nested_leaf_id)
            nested_leaf_token = execution_secrets.derive_attempt_token(
                run, nested_leaf_attempt["attempt_id"]
            )
            _estimate(
                identity,
                task_id=nested_leaf_id,
                attempt_id=nested_leaf_attempt["attempt_id"],
                token=nested_leaf_token,
                action_id="nested-leaf-estimate",
            )
            with self.assertRaisesRegex(
                action_processor.ActionError, "depth guard"
            ):
                action_processor.process_action(
                    _envelope(
                        identity,
                        "start_mode",
                        {
                            "mode": "swarm",
                            "objective": "Too deep.",
                            "config": {"max_mode_depth": 1},
                            "tasks": [
                                {
                                    "key": "too-deep",
                                    "goal": "Never compile.",
                                    "intent_hint": "implement",
                                    "output_contract": "Never compile.",
                                }
                            ],
                        },
                        "depth-mode",
                        task_id=nested_leaf_id,
                        attempt_id=nested_leaf_attempt["attempt_id"],
                        token=nested_leaf_token,
                    )
                )

            with state_store.transaction() as con:
                con.execute(
                    "UPDATE modes SET parent_mode_id=mode_id WHERE mode_id=?",
                    (parent["mode_id"],),
                )
            with self.assertRaisesRegex(
                action_processor.ActionError, "cycle"
            ):
                action_processor.process_action(
                    _envelope(
                        identity,
                        "start_mode",
                        {
                            "mode": "swarm",
                            "objective": "Cycle rejected.",
                            "tasks": [
                                {
                                    "key": "never",
                                    "goal": "Never.",
                                    "intent_hint": "implement",
                                    "output_contract": "Never.",
                                }
                            ],
                        },
                        "cycle-mode",
                        task_id=child_task_id,
                        attempt_id=child_attempt["attempt_id"],
                        token=child_token,
                    )
                )
            with state_store.transaction() as con:
                con.execute(
                    "UPDATE modes SET parent_mode_id=NULL WHERE mode_id=?",
                    (parent["mode_id"],),
                )

            recovered = recovery.recover_root(
                identity["root_id"], force_takeover=True
            )
            _estimate(recovered, action_id="recovered-estimate")
            event = state_store.list_events(identity["root_id"])[-2:]
            self.assertTrue(
                any(
                    parent["mode_id"]
                    in json.loads(row["payload_json"]).get("continuing_mode_ids", [])
                    for row in event
                    if row["type"] == "RootRecovered"
                )
            )
            cancelled = action_processor.process_action(
                _envelope(
                    recovered,
                    "advance_mode",
                    {
                        "mode_id": parent["mode_id"],
                        "operation": "cancel",
                        "reason": "deterministic cancellation",
                    },
                    "cancel-parent",
                )
            )
            self.assertEqual("cancelled", cancelled["status"])
            self.assertEqual(
                "cancelled", state_store.get_mode(nested["mode_id"])["status"]
            )
            self.assertTrue(
                all(
                    state_store.get_task(task_id)["status"] == "cancelled"
                    for task_id in parent["task_ids"] + nested["task_ids"]
                )
            )


if __name__ == "__main__":
    unittest.main()
