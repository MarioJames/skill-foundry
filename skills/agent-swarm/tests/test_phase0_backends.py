import inspect
import json
import pathlib
import unittest
from unittest import mock

from helpers import SCRIPTS_DIR, isolated_runtime

import state_store
import agent_orchestrator
import outbox
import recovery
import scheduler
from helpers import insert_ready_child


class Phase0BackendContractTests(unittest.TestCase):
    def test_control_plane_does_not_import_legacy_claude_adapter(self):
        for name in ("outbox.py", "recovery.py"):
            source = (SCRIPTS_DIR / name).read_text()
            self.assertNotIn("import claude_adapter", source, name)

    def test_claude_backend_implements_execution_backend_contract(self):
        from backends.base import AgentBackend, SpawnRequest, StopRequest
        from backends.claude_cli import ClaudeCliBackend

        backend = ClaudeCliBackend()
        self.assertIsInstance(backend, AgentBackend)
        self.assertEqual("claude_cli", backend.backend_id)
        self.assertTrue(backend.supports_hooks())
        self.assertEqual("prompt", SpawnRequest.__dataclass_fields__["prompt"].name)
        self.assertEqual("job_id", StopRequest.__dataclass_fields__["job_id"].name)

    def test_resolve_execution_backend_uses_persisted_backend_id_only(self):
        from backends import resolve_execution_backend
        from backends.claude_cli import ClaudeCliBackend

        record = {"backend_id": "claude_cli", "config_json": json.dumps({"backend": "claude_cli"})}
        backend = resolve_execution_backend(record)
        self.assertIsInstance(backend, ClaudeCliBackend)

        with self.assertRaisesRegex(ValueError, "unsupported execution backend"):
            resolve_execution_backend({"backend_id": "missing", "config_json": "{}"})

    def test_legacy_claude_adapter_is_only_a_thin_compatibility_wrapper(self):
        source = (SCRIPTS_DIR / "claude_adapter.py").read_text()
        self.assertLessEqual(len(source.splitlines()), 40)
        self.assertIn("backends.claude_cli", source)

    def test_default_claude_outbox_spawn_preserves_background_cli_shape(self):
        from backends import claude_cli

        completed = mock.Mock(returncode=0, stdout="backgrounded · job-123\n", stderr="")
        with isolated_runtime() as (_, cwd), mock.patch.object(
            agent_orchestrator.hook_manager, "ensure_project_hooks"
        ), mock.patch.object(outbox.hook_manager, "ensure_project_hooks"), mock.patch.object(
            claude_cli.subprocess, "run", return_value=completed
        ) as run_cli:
            identity = agent_orchestrator.initialize_run("root", str(cwd))
            with state_store.transaction() as con:
                run = state_store.get_run(identity["root_id"], con)
                insert_ready_child(con, run)
            created = scheduler.schedule(identity["root_id"])[0]

            result = outbox.drain(identity["root_id"])

            self.assertEqual(1, result["completed"])
            command = run_cli.call_args.args[0]
            self.assertIn("--bg", command)
            self.assertIn("--permission-mode", command)
            agent = state_store.get_agent(created["agent_id"])
            self.assertEqual("job-123", agent["job_id"])
            self.assertEqual("evaluating", agent["state"])

    def test_acp_run_init_skips_claude_project_hooks(self):
        with isolated_runtime() as (_, cwd), mock.patch.object(
            agent_orchestrator.hook_manager, "ensure_project_hooks"
        ) as ensure_hooks:
            agent_orchestrator.initialize_run("root", str(cwd), backend="acp", acp_agent="codex")
            ensure_hooks.assert_not_called()

    def test_backend_type_error_is_not_retried_with_a_second_signature(self):
        from backends.base import AgentBackend

        class BrokenBackend(AgentBackend):
            backend_id = "claude_cli"

            def __init__(self):
                self.spawn_calls = 0

            def spawn(self, request=None, **kwargs):
                self.spawn_calls += 1
                raise TypeError("backend failed after side effect")

            def stop(self, request):
                return {"stopped": True}

            def observe(self, **kwargs):
                raise AssertionError("not used")

            def list_sessions(self, **kwargs):
                return []

            def supports_hooks(self):
                return True

        backend = BrokenBackend()
        with isolated_runtime() as (_, cwd), mock.patch.object(
            agent_orchestrator.hook_manager, "ensure_project_hooks"
        ), mock.patch.object(outbox.hook_manager, "ensure_project_hooks"):
            identity = agent_orchestrator.initialize_run("root", str(cwd))
            with state_store.transaction() as con:
                run = state_store.get_run(identity["root_id"], con)
                insert_ready_child(con, run)
            scheduler.schedule(identity["root_id"])

            result = outbox.drain(identity["root_id"], adapter=backend, max_effects=1)

            self.assertEqual(1, result["failed"])
            self.assertEqual(1, backend.spawn_calls)

    def test_stale_spawn_effect_cannot_act_on_new_generation(self):
        class RecordingBackend:
            def __init__(self):
                self.spawn_calls = 0

            def spawn(self, **kwargs):
                self.spawn_calls += 1
                return {"job_id": "should-not-run", "session_name": kwargs["session_name"]}

        backend = RecordingBackend()
        with isolated_runtime() as (_, cwd), mock.patch.object(
            agent_orchestrator.hook_manager, "ensure_project_hooks"
        ):
            identity = agent_orchestrator.initialize_run("root", str(cwd))
            with state_store.transaction() as con:
                run = state_store.get_run(identity["root_id"], con)
                insert_ready_child(con, run)
            created = scheduler.schedule(identity["root_id"])[0]
            with state_store.transaction() as con:
                con.execute(
                    """UPDATE execution_sessions
                       SET generation=2, execution_id=?, owner_nonce=NULL
                       WHERE attempt_id=?""",
                    ("claude_cli:%s:2" % created["attempt_id"], created["attempt_id"]),
                )
            # Ordinary later Runtime commands rerun additive migration; that must
            # not rewrite an already-bound effect to the current generation.
            state_store.initialize_schema()

            result = outbox.drain(identity["root_id"], adapter=backend, max_effects=1)

            self.assertEqual(0, backend.spawn_calls)
            self.assertEqual(1, result["stale"])
            effect = state_store.list_outbox(identity["root_id"])[0]
            self.assertEqual("completed", effect["status"])
            self.assertIn("stale generation", effect["last_error"])

    def test_recovery_does_not_hold_write_transaction_while_listing_sessions(self):
        class WritingObserver:
            def __init__(self, root_id):
                self.root_id = root_id

            def list_sessions(self, cwd=None):
                with state_store.transaction() as con:
                    con.execute(
                        "UPDATE runs SET updated_at=? WHERE root_id=?",
                        (state_store.now(), self.root_id),
                    )
                return []

        with isolated_runtime() as (_, cwd), mock.patch.object(
            agent_orchestrator.hook_manager, "ensure_project_hooks"
        ), mock.patch.object(state_store, "BUSY_TIMEOUT_MS", 20):
            identity = agent_orchestrator.initialize_run("root", str(cwd))
            with state_store.transaction() as con:
                run = state_store.get_run(identity["root_id"], con)
                insert_ready_child(con, run)
            scheduler.schedule(identity["root_id"])

            reconciled = recovery._reconcile_started_sessions(
                identity["root_id"], WritingObserver(identity["root_id"])
            )

            self.assertEqual(0, reconciled)


if __name__ == "__main__":
    unittest.main()
