import json
import os
import unittest
from unittest import mock

from helpers import insert_ready_child, isolated_runtime

import agent_orchestrator
import scheduler
import state_store


class Phase0ExecutionConfigTests(unittest.TestCase):
    def _create_run(self, cwd, **kwargs):
        with mock.patch.object(agent_orchestrator.hook_manager, "ensure_project_hooks"):
            return agent_orchestrator.initialize_run("root goal", str(cwd), **kwargs)

    def test_headless_acp_prompt_permission_policy_is_rejected_at_init(self):
        with isolated_runtime() as (_, cwd):
            with self.assertRaisesRegex(ValueError, "no headless UI"):
                self._create_run(
                    cwd,
                    backend="acp",
                    acp_agent="custom",
                    acp_command=__import__("sys").executable,
                    acp_permission_policy="prompt",
                )

    def test_attempt_creation_freezes_persisted_run_config(self):
        with isolated_runtime() as (_, cwd), mock.patch.dict(
            os.environ,
            {"AGENT_SWARM_BACKEND": "acp", "AGENT_SWARM_ACP_AGENT": "codex"},
        ):
            identity = self._create_run(cwd)
            with state_store.transaction() as con:
                run = state_store.get_run(identity["root_id"], con)
                insert_ready_child(con, run)

            with mock.patch.dict(
                os.environ,
                {"AGENT_SWARM_BACKEND": "claude_cli", "AGENT_SWARM_ACP_AGENT": "claude"},
            ):
                created = scheduler.schedule(identity["root_id"])

            self.assertEqual(1, len(created))
            execution = state_store.get_execution(created[0]["attempt_id"])
            snapshot = json.loads(execution["config_json"])
            self.assertEqual("acp", execution["backend_id"])
            self.assertEqual("codex", execution["agent_key"])
            self.assertEqual("acp", snapshot["backend"])
            self.assertEqual("codex", snapshot["agent"])
            self.assertEqual(1, execution["generation"])
            self.assertIsNone(execution["owner_nonce"])

    def test_attempt_snapshot_does_not_change_after_environment_mutation(self):
        with isolated_runtime() as (_, cwd), mock.patch.dict(
            os.environ,
            {
                "AGENT_SWARM_BACKEND": "acp",
                "AGENT_SWARM_ACP_AGENT": "codex",
                "AGENT_SWARM_ACP_PERMISSION_POLICY": "deny_all",
            },
        ):
            identity = self._create_run(cwd)
            with state_store.transaction() as con:
                run = state_store.get_run(identity["root_id"], con)
                insert_ready_child(con, run)
            created = scheduler.schedule(identity["root_id"])
            before = state_store.get_execution(created[0]["attempt_id"])["config_json"]

            with mock.patch.dict(
                os.environ,
                {
                    "AGENT_SWARM_BACKEND": "claude_cli",
                    "AGENT_SWARM_ACP_AGENT": "claude",
                    "AGENT_SWARM_ACP_PERMISSION_POLICY": "allow_all",
                },
            ):
                after = state_store.get_execution(created[0]["attempt_id"])["config_json"]

            self.assertEqual(before, after)

    def test_generation_ownership_cas_allows_exactly_one_worker(self):
        with isolated_runtime() as (_, cwd), mock.patch.dict(
            os.environ, {"AGENT_SWARM_BACKEND": "acp", "AGENT_SWARM_ACP_AGENT": "codex"}
        ):
            identity = self._create_run(cwd)
            with state_store.transaction() as con:
                run = state_store.get_run(identity["root_id"], con)
                insert_ready_child(con, run)
            attempt_id = scheduler.schedule(identity["root_id"])[0]["attempt_id"]

            won = state_store.claim_execution_ownership(attempt_id, 1, "nonce-a", 111)
            lost = state_store.claim_execution_ownership(attempt_id, 1, "nonce-b", 222)

            self.assertTrue(won)
            self.assertFalse(lost)
            execution = state_store.get_execution(attempt_id)
            self.assertEqual("nonce-a", execution["owner_nonce"])
            self.assertEqual(111, execution["worker_pid"])

    def test_stop_fence_rejects_unowned_worker_claim(self):
        with isolated_runtime() as (_, cwd), mock.patch.dict(
            os.environ, {"AGENT_SWARM_BACKEND": "acp", "AGENT_SWARM_ACP_AGENT": "codex"}
        ):
            identity = self._create_run(cwd)
            with state_store.transaction() as con:
                run = state_store.get_run(identity["root_id"], con)
                insert_ready_child(con, run)
            attempt_id = scheduler.schedule(identity["root_id"])[0]["attempt_id"]
            with state_store.transaction() as con:
                con.execute(
                    "UPDATE execution_sessions SET stop_requested_at=? WHERE attempt_id=?",
                    (state_store.now(), attempt_id),
                )

            self.assertFalse(
                state_store.claim_execution_ownership(attempt_id, 1, "late", 333)
            )


if __name__ == "__main__":
    unittest.main()
