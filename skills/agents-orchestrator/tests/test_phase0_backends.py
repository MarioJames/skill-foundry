import json
import pathlib
import unittest
from unittest import mock

from helpers import insert_ready_child, isolated_runtime

import agent_orchestrator
import backends
import outbox
import recovery
import scheduler
import state_store
from backends.base import AgentBackend, ObserveResult, SpawnResult
from backends.claude_cli import ClaudeCliBackend


class RecordingBackend(AgentBackend):
    backend_id = "test"

    def __init__(self, *, presence="present", error=None):
        self.requests = []
        self.presence = presence
        self.error = error

    def spawn(self, request):
        self.requests.append(request)
        if self.error:
            raise self.error
        return SpawnResult("job-1", request.session_name)

    def stop(self, request):
        return {"stopped": True}

    def observe(self, **kwargs):
        # Proves callers do not hold a write transaction across observation.
        with state_store.transaction() as con:
            con.execute("SELECT 1")
        return ObserveResult(self.presence)

    def list_sessions(self, **kwargs):
        return []

    def supports_hooks(self):
        return False


class Phase0BackendContractTests(unittest.TestCase):
    def _child(self, cwd):
        identity = agent_orchestrator.initialize_run("root", str(cwd), backend="claude_cli")
        with state_store.transaction() as con:
            run = state_store.get_run(identity["root_id"], con)
            insert_ready_child(con, run)
        return identity, scheduler.schedule(identity["root_id"])[0]

    def test_control_plane_does_not_import_legacy_claude_adapter(self):
        source = (pathlib.Path(outbox.__file__).read_text() + pathlib.Path(recovery.__file__).read_text())
        self.assertNotIn("claude_adapter", source)

    def test_claude_backend_implements_execution_backend_contract(self):
        self.assertIsInstance(ClaudeCliBackend(), AgentBackend)

    def test_resolve_backend_uses_persisted_attempt_backend(self):
        self.assertIsInstance(
            backends.resolve_execution_backend(
                {"backend_id": "claude_cli", "config_json": '{"command":"claude"}'}
            ),
            ClaudeCliBackend,
        )

    def test_outbox_spawn_uses_launch_and_has_no_agent_id(self):
        with isolated_runtime() as (_, cwd):
            identity, child = self._child(cwd)
            backend = RecordingBackend()
            result = outbox.drain(identity["root_id"], adapter=backend, max_effects=1)
            self.assertEqual(1, result["completed"])
            self.assertEqual(1, len(backend.requests))
            request = backend.requests[0]
            self.assertEqual(str(child["launch_id"]), request.metadata["launch_id"])
            self.assertNotIn("agent_id", request.metadata)
            self.assertNotIn("AGENT_SWARM_AGENT_ID", request.env)
            self.assertEqual("evaluating", state_store.get_attempt(child["attempt_id"])["state"])
            self.assertEqual("running", state_store.get_launch(child["launch_id"])["status"])

    def test_backend_type_error_is_not_retried_with_a_second_signature(self):
        with isolated_runtime() as (_, cwd):
            identity, _ = self._child(cwd)
            backend = RecordingBackend(error=TypeError("business type error"))
            result = outbox.drain(identity["root_id"], adapter=backend, max_effects=1)
            self.assertEqual(1, result["failed"])
            self.assertEqual(1, len(backend.requests))

    def test_stale_spawn_effect_cannot_act_on_new_launch(self):
        with isolated_runtime() as (_, cwd):
            identity, child = self._child(cwd)
            with state_store.transaction() as con:
                old = state_store.get_launch(child["launch_id"], con)
                con.execute(
                    "UPDATE launches SET status='closed', closed_at=? WHERE launch_id=?",
                    (state_store.now(), old["launch_id"]),
                )
                cursor = con.execute(
                    """INSERT INTO launches(
                         attempt_id, launch_no, session_name, status, prompt_state,
                         created_at, last_event_at
                       ) VALUES (?, 2, ?, 'starting', 'pending', ?, ?)""",
                    (
                        child["attempt_id"],
                        old["session_name"],
                        state_store.now(),
                        state_store.now(),
                    ),
                )
                new_launch_id = cursor.lastrowid
            backend = RecordingBackend()
            result = outbox.drain(identity["root_id"], adapter=backend, max_effects=1)
            self.assertEqual(1, result["stale"])
            self.assertEqual([], backend.requests)
            self.assertEqual(new_launch_id, state_store.get_current_launch(child["attempt_id"])["launch_id"])

    def test_recovery_observation_occurs_without_write_transaction(self):
        with isolated_runtime() as (_, cwd):
            identity, child = self._child(cwd)
            backend = RecordingBackend(presence="present")
            outbox.drain(identity["root_id"], adapter=backend)
            report = recovery.reap_children(identity["root_id"], identity["actor_token"], adapter=backend)
            self.assertEqual("present", report["reconciled"][0]["outcome"])


if __name__ == "__main__":
    unittest.main()
