import json
import unittest
import uuid
from unittest import mock

from helpers import insert_ready_child, isolated_runtime

import action_processor
import agent_orchestrator
import outbox
import recovery
import scheduler
import state_store
from backends.base import (
    AgentBackend,
    BackendPendingError,
    BackendUnknownError,
    ObserveResult,
)


class DeferredBackend(AgentBackend):
    backend_id = "test"

    def __init__(self, error_type):
        self.error_type = error_type

    def spawn(self, request):
        raise self.error_type("deterministic deferred spawn")

    def stop(self, request):
        return {"stopped": True}

    def observe(self, *, job_id=None, session_name=None, cwd=None):
        return ObserveResult("unknown")

    def list_sessions(self, *, cwd=None):
        return []

    def supports_hooks(self):
        return False


class RecordingStopBackend(DeferredBackend):
    def __init__(self):
        super().__init__(BackendPendingError)
        self.stops = []

    def stop(self, request):
        self.stops.append(request)
        return {"stopped": True}


class PresenceBackend(DeferredBackend):
    def __init__(self, presence):
        super().__init__(BackendPendingError)
        self.presence = presence

    def observe(self, *, job_id=None, session_name=None, cwd=None):
        return ObserveResult(self.presence)


def initialize(cwd, **overrides):
    with mock.patch.object(agent_orchestrator.hook_manager, "ensure_project_hooks"):
        return agent_orchestrator.initialize_run("root", str(cwd), **overrides)


def create_child(identity):
    with state_store.transaction() as con:
        run = state_store.get_run(identity["root_id"], con)
        insert_ready_child(con, run)
    return scheduler.schedule(identity["root_id"])[0]


def envelope(identity, action_type, payload):
    return {
        "schema_version": 1,
        "action_id": "action_" + uuid.uuid4().hex,
        "root_id": identity["root_id"],
        "task_id": identity["task_id"],
        "attempt_id": identity["attempt_id"],
        "agent_id": identity["agent_id"],
        "actor_token": identity["actor_token"],
        "type": action_type,
        "payload": payload,
    }


ESTIMATE = {
    "revision": False,
    "strategy": "direct",
    "resolved_intent": "implement",
    "complexity": "low",
    "concerns": [],
    "unknowns": [],
    "estimated_files": [],
    "reason": "test",
}


FINISH = {
    "status": "done",
    "retryable": False,
    "summary": "done",
    "changed_files": [],
    "artifacts": [],
    "validation": None,
    "review": None,
    "integration_check": None,
    "caveats": [],
}


class Phase1ReconciliationTests(unittest.TestCase):
    def test_reap_closes_terminal_claude_execution_only_after_session_is_absent(self):
        with isolated_runtime() as (_, cwd):
            identity = initialize(cwd)
            child = create_child(identity)
            with state_store.transaction() as con:
                finished = state_store.now()
                con.execute(
                    "UPDATE task_attempts SET status='done', finished_at=? WHERE attempt_id=?",
                    (finished, child["attempt_id"]),
                )
                con.execute(
                    "UPDATE tasks SET status='done', finished_at=? WHERE task_id=?",
                    (finished, child["task_id"]),
                )
                con.execute(
                    "UPDATE agents SET state='terminal', finished_at=? WHERE agent_id=?",
                    (finished, child["agent_id"]),
                )
                con.execute(
                    "UPDATE execution_sessions SET status='running', ready_at=? WHERE attempt_id=?",
                    (finished, child["attempt_id"]),
                )

            present = recovery.reap_children(
                identity["root_id"], identity["actor_token"],
                adapter=PresenceBackend("present"),
            )
            self.assertEqual(
                "running", state_store.get_execution(child["attempt_id"])["status"]
            )
            self.assertEqual(0, present["execution_outcomes"]["reconciled_terminal"])

            absent = recovery.reap_children(
                identity["root_id"], identity["actor_token"],
                adapter=PresenceBackend("absent"),
            )

            execution = state_store.get_execution(child["attempt_id"])
            self.assertEqual("closed", execution["status"])
            self.assertEqual("attempt_terminal", execution["exit_reason"])
            self.assertIsNotNone(execution["closed_at"])
            self.assertEqual(1, absent["execution_outcomes"]["reconciled_terminal"])

    def test_pending_and_unknown_spawn_do_not_fail_attempt_or_consume_retry(self):
        for error_type in (BackendPendingError, BackendUnknownError):
            with self.subTest(error_type=error_type.__name__), isolated_runtime() as (_, cwd):
                identity = initialize(cwd)
                child = create_child(identity)

                summary = outbox.drain(
                    identity["root_id"], adapter=DeferredBackend(error_type), max_effects=1
                )

                effect = state_store.list_outbox(identity["root_id"])[0]
                self.assertEqual("pending", effect["status"])
                self.assertEqual("assigned", state_store.get_attempt(child["attempt_id"])["status"])
                self.assertEqual(1, len(state_store.list_attempts(identity["root_id"])) - 1)
                self.assertEqual(1, summary["deferred"])
                self.assertEqual(0, summary["failed"])

    def test_turn_end_reconciliation_is_idempotent_and_schedules_one_retry(self):
        with isolated_runtime() as (_, cwd):
            identity = initialize(cwd, max_attempts_per_task=2)
            child = create_child(identity)
            with state_store.transaction() as con:
                con.execute(
                    """UPDATE execution_sessions
                       SET status='closed', prompt_state='ended',
                           exit_reason='without_finish:end_turn', closed_at=?
                       WHERE attempt_id=?""",
                    (state_store.now(), child["attempt_id"]),
                )

            first = recovery.reconcile_execution_outcomes(identity["root_id"])
            second = recovery.reconcile_execution_outcomes(identity["root_id"])

            attempts = [
                item
                for item in state_store.list_attempts(identity["root_id"])
                if item["task_id"] == child["task_id"]
            ]
            self.assertEqual(1, first["reconciled_failures"])
            self.assertEqual(0, second["reconciled_failures"])
            self.assertEqual(2, len(attempts))
            self.assertEqual("failed", state_store.get_attempt(child["attempt_id"])["status"])
            self.assertIsNotNone(state_store.get_execution(child["attempt_id"])["reconciled_at"])

    def test_legitimate_terminal_attempt_is_only_marked_reconciled(self):
        with isolated_runtime() as (_, cwd):
            identity = initialize(cwd)
            child = create_child(identity)
            with state_store.transaction() as con:
                finished = state_store.now()
                con.execute(
                    "UPDATE task_attempts SET status='done', finished_at=? WHERE attempt_id=?",
                    (finished, child["attempt_id"]),
                )
                con.execute(
                    "UPDATE tasks SET status='done', finished_at=? WHERE task_id=?",
                    (finished, child["task_id"]),
                )
                con.execute(
                    "UPDATE agents SET state='terminal', finished_at=? WHERE agent_id=?",
                    (finished, child["agent_id"]),
                )
                con.execute(
                    """UPDATE execution_sessions
                       SET status='closed', exit_reason='attempt_terminal', closed_at=?
                       WHERE attempt_id=?""",
                    (finished, child["attempt_id"]),
                )

            result = recovery.reconcile_execution_outcomes(identity["root_id"])

            self.assertEqual(1, result["reconciled_terminal"])
            self.assertEqual("done", state_store.get_attempt(child["attempt_id"])["status"])
            self.assertEqual(1, len([
                item for item in state_store.list_attempts(identity["root_id"])
                if item["task_id"] == child["task_id"]
            ]))

    def test_root_finish_rejects_nonterminal_execution_record(self):
        with isolated_runtime() as (_, cwd):
            identity = initialize(cwd, require_final_review=False)
            action_processor.process_action(envelope(identity, "submit_estimate", ESTIMATE))
            run = state_store.get_run(identity["root_id"])
            with state_store.transaction() as con:
                con.execute(
                    """INSERT INTO execution_sessions(
                         attempt_id, root_id, backend_id, generation, session_name,
                         execution_id, config_json, status, prompt_state, created_at, last_event_at
                       ) VALUES (?, ?, 'acp', 1, 'root-test', ?, '{}', 'running',
                                 'in_flight', ?, ?)""",
                    (
                        identity["attempt_id"],
                        identity["root_id"],
                        "acp:%s:1" % identity["attempt_id"],
                        state_store.now(),
                        state_store.now(),
                    ),
                )

            with self.assertRaisesRegex(
                action_processor.ActionError, "non-terminal execution"
            ):
                action_processor.process_action(envelope(identity, "finish", FINISH))

            self.assertEqual("running", state_store.get_run(run["root_id"])["status"])

    def test_stop_fences_and_cleans_every_nonterminal_execution(self):
        with isolated_runtime() as (_, cwd):
            identity = initialize(cwd)
            child = create_child(identity)
            with state_store.transaction() as con:
                con.execute(
                    "UPDATE agents SET state='terminal' WHERE agent_id=?",
                    (child["agent_id"],),
                )
            backend = RecordingStopBackend()

            result = recovery.stop_run(
                identity["root_id"], identity["actor_token"], adapter=backend
            )

            execution = state_store.get_execution(child["attempt_id"])
            self.assertTrue(result["terminal"], result)
            self.assertEqual(1, len(backend.stops))
            self.assertIsNotNone(execution["stop_requested_at"])
            self.assertEqual("closed", execution["status"])

    def test_stop_reconciles_deterministic_failure_without_creating_retry(self):
        with isolated_runtime() as (_, cwd):
            identity = initialize(cwd, max_attempts_per_task=3)
            child = create_child(identity)
            with state_store.transaction() as con:
                con.execute(
                    """UPDATE execution_sessions
                       SET status='closed', prompt_state='ended',
                           exit_reason='without_finish:end_turn', closed_at=?
                       WHERE attempt_id=?""",
                    (state_store.now(), child["attempt_id"]),
                )

            result = recovery.stop_run(identity["root_id"], identity["actor_token"])

            attempts = [
                item for item in state_store.list_attempts(identity["root_id"])
                if item["task_id"] == child["task_id"]
            ]
            self.assertTrue(result["terminal"], result)
            self.assertEqual(1, result["execution_outcomes"]["reconciled_failures"])
            self.assertEqual(1, len(attempts))
            self.assertIsNotNone(
                state_store.get_execution(child["attempt_id"])["reconciled_at"]
            )

    def test_recovery_does_not_treat_unready_starting_execution_as_session(self):
        with isolated_runtime() as (_, cwd):
            identity = initialize(
                cwd,
                backend="acp",
                acp_agent="custom",
                acp_command=__import__("sys").executable,
                acp_args=["fake-agent.py"],
            )
            child = create_child(identity)

            report = recovery.recover_run(
                identity["root_id"], identity["actor_token"]
            )

            self.assertEqual(0, report["sessions_reconciled"])
            self.assertEqual("assigned", state_store.get_attempt(child["attempt_id"])["status"])


if __name__ == "__main__":
    unittest.main()
