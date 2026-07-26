import json
import unittest

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
    SpawnResult,
)


class StubBackend(AgentBackend):
    backend_id = "stub"

    def __init__(self, presence="present", spawn_error=None):
        self.presence = presence
        self.spawn_error = spawn_error
        self.stops = []

    def spawn(self, request):
        if self.spawn_error:
            raise self.spawn_error
        return SpawnResult("job-%s" % request.metadata["launch_id"], request.session_name)

    def stop(self, request):
        self.stops.append(request)
        return {"stopped": True}

    def observe(self, **kwargs):
        return ObserveResult(self.presence)

    def list_sessions(self, **kwargs):
        return []

    def supports_hooks(self):
        return False


def create_child(identity):
    with state_store.transaction() as con:
        run = state_store.get_run(identity["root_id"], con)
        insert_ready_child(con, run)
    return scheduler.schedule(identity["root_id"])[0]


class Phase1ReconciliationTests(unittest.TestCase):
    def _run(self, cwd, **kwargs):
        return agent_orchestrator.initialize_run(
            "root", str(cwd), backend="claude_cli", require_final_review=False, **kwargs
        )

    def test_terminal_launch_closes_only_after_backend_absence(self):
        with isolated_runtime() as (_, cwd):
            identity = self._run(cwd)
            child = create_child(identity)
            backend = StubBackend("present")
            outbox.drain(identity["root_id"], adapter=backend)
            with state_store.transaction() as con:
                con.execute("UPDATE attempts SET state='done' WHERE attempt_id=?", (child["attempt_id"],))
                con.execute("UPDATE tasks SET status='done' WHERE task_id=?", (child["task_id"],))
            recovery.reap_children(identity["root_id"], identity["actor_token"], adapter=backend)
            self.assertEqual("running", state_store.get_launch(child["launch_id"])["status"])
            backend.presence = "absent"
            recovery.reap_children(identity["root_id"], identity["actor_token"], adapter=backend)
            self.assertEqual("closed", state_store.get_launch(child["launch_id"])["status"])

    def test_pending_and_unknown_spawn_do_not_consume_attempt(self):
        for error in (BackendPendingError("pending"), BackendUnknownError("unknown")):
            with self.subTest(error=type(error).__name__), isolated_runtime() as (_, cwd):
                identity = self._run(cwd)
                child = create_child(identity)
                result = outbox.drain(
                    identity["root_id"], adapter=StubBackend(spawn_error=error)
                )
                self.assertEqual(1, result["deferred"])
                self.assertEqual("assigned", state_store.get_attempt(child["attempt_id"])["state"])
                self.assertEqual(1, len([a for a in state_store.list_attempts(identity["root_id"]) if a["task_id"] == child["task_id"]]))

    def test_turn_end_reconciliation_is_idempotent_and_schedules_one_retry(self):
        with isolated_runtime() as (_, cwd):
            identity = self._run(cwd)
            child = create_child(identity)
            backend = StubBackend("present")
            outbox.drain(identity["root_id"], adapter=backend)
            with state_store.transaction() as con:
                con.execute(
                    """UPDATE launches SET status='closed', prompt_state='ended',
                         exit_reason='without_finish', closed_at=? WHERE launch_id=?""",
                    (state_store.now(), child["launch_id"]),
                )
            recovery.reap_children(identity["root_id"], identity["actor_token"], adapter=backend)
            recovery.reap_children(identity["root_id"], identity["actor_token"], adapter=backend)
            attempts = [
                item for item in state_store.list_attempts(identity["root_id"])
                if item["task_id"] == child["task_id"]
            ]
            self.assertEqual(2, len(attempts))
            self.assertEqual("failed", attempts[0]["state"])
            self.assertEqual("assigned", attempts[1]["state"])

    def test_root_finish_rejects_open_launch(self):
        with isolated_runtime() as (_, cwd):
            identity = self._run(cwd)
            child = create_child(identity)
            backend = StubBackend("present")
            outbox.drain(identity["root_id"], adapter=backend)
            with state_store.transaction() as con:
                con.execute("UPDATE attempts SET state='done' WHERE attempt_id=?", (child["attempt_id"],))
                con.execute("UPDATE tasks SET status='done' WHERE task_id=?", (child["task_id"],))
            estimate = {
                **identity,
                "schema_version": 1,
                "action_id": "estimate-root",
                "type": "submit_estimate",
                "payload": {
                    "revision": False,
                    "strategy": "direct",
                    "resolved_intent": "implement",
                    "complexity": "low",
                    "concerns": [],
                    "unknowns": [],
                    "estimated_files": [],
                    "reason": "finish test",
                },
            }
            action_processor.process_action(estimate)
            finish = {
                **identity,
                "schema_version": 1,
                "action_id": "finish-root",
                "type": "finish",
                "payload": {
                    "status": "done",
                    "summary": "done",
                    "changed_files": [],
                    "caveats": [],
                    "integration_check": {"status": "passed", "summary": "ok"},
                },
            }
            with self.assertRaisesRegex(action_processor.ActionError, "open launches"):
                action_processor.process_action(finish)

    def test_stop_fences_and_closes_every_launch(self):
        with isolated_runtime() as (_, cwd):
            identity = self._run(cwd)
            first = create_child(identity)
            backend = StubBackend("present")
            outbox.drain(identity["root_id"], adapter=backend)
            with state_store.transaction() as con:
                run = state_store.get_run(identity["root_id"], con)
                insert_ready_child(con, run)
            second = scheduler.schedule(identity["root_id"])[0]
            outbox.drain(identity["root_id"], adapter=backend)
            result = recovery.stop_run(
                identity["root_id"], identity["actor_token"], adapter=backend
            )
            self.assertEqual("cancelled", result["status"])
            self.assertEqual(2, len(backend.stops))
            self.assertTrue(all(item["status"] == "closed" for item in state_store.list_launches(identity["root_id"])))

    def test_unready_starting_launch_is_not_treated_as_failed_session(self):
        with isolated_runtime() as (_, cwd):
            identity = self._run(cwd)
            child = create_child(identity)
            report = recovery.reap_children(
                identity["root_id"], identity["actor_token"], adapter=StubBackend("absent")
            )
            self.assertEqual("starting_absent", report["reconciled"][0]["outcome"])
            self.assertEqual("assigned", state_store.get_attempt(child["attempt_id"])["state"])


if __name__ == "__main__":
    unittest.main()
