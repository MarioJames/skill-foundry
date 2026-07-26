import json
import os
import sys
import unittest
from unittest import mock

from helpers import insert_ready_child, isolated_runtime

import agent_orchestrator
import scheduler
import state_store


class Phase0ExecutionConfigTests(unittest.TestCase):
    def test_headless_acp_prompt_permission_policy_is_rejected_at_init(self):
        with isolated_runtime() as (_, cwd):
            with self.assertRaisesRegex(ValueError, "headless UI"):
                agent_orchestrator.initialize_run(
                    "root",
                    str(cwd),
                    backend="acp",
                    acp_agent="custom",
                    acp_command=sys.executable,
                    acp_permission_policy="prompt",
                )

    def _child(self, cwd, **kwargs):
        identity = agent_orchestrator.initialize_run("root", str(cwd), **kwargs)
        with state_store.transaction() as con:
            run = state_store.get_run(identity["root_id"], con)
            insert_ready_child(con, run)
        return identity, scheduler.schedule(identity["root_id"])[0]

    def test_attempt_creation_freezes_persisted_run_config(self):
        with isolated_runtime() as (_, cwd):
            identity, child = self._child(cwd, backend="claude_cli")
            attempt = state_store.get_attempt(child["attempt_id"])
            launch = state_store.get_launch(child["launch_id"])
            config = json.loads(attempt["config_json"])
            self.assertEqual("claude_cli", attempt["backend_id"])
            self.assertEqual("claude", attempt["agent_type"])
            self.assertEqual(config, json.loads(launch["config_json"]))
            self.assertEqual(1, launch["launch_no"])

    def test_attempt_snapshot_does_not_change_after_environment_mutation(self):
        with isolated_runtime() as (_, cwd):
            with mock.patch.dict(os.environ, {"AGENT_SWARM_CLAUDE_BIN": "/first/claude"}):
                identity, child = self._child(cwd, backend="claude_cli")
            before = state_store.get_attempt(child["attempt_id"])["config_json"]
            with mock.patch.dict(os.environ, {"AGENT_SWARM_CLAUDE_BIN": "/second/claude"}):
                after = state_store.get_attempt(child["attempt_id"])["config_json"]
            self.assertEqual(before, after)
            self.assertEqual("/first/claude", json.loads(after)["command"])

    def test_launch_ownership_cas_allows_exactly_one_worker(self):
        with isolated_runtime() as (_, cwd):
            _, child = self._child(cwd, backend="claude_cli")
            self.assertTrue(state_store.claim_launch_ownership(child["launch_id"], "one", 1234))
            self.assertFalse(state_store.claim_launch_ownership(child["launch_id"], "two", 5678))
            launch = state_store.get_launch(child["launch_id"])
            self.assertEqual("one", launch["owner_nonce"])
            self.assertEqual(1234, launch["worker_pid"])

    def test_stop_fence_rejects_unowned_or_stopped_launch(self):
        with isolated_runtime() as (_, cwd):
            _, child = self._child(cwd, backend="claude_cli")
            with state_store.transaction() as con:
                con.execute(
                    "UPDATE launches SET stop_requested_at=? WHERE launch_id=?",
                    (state_store.now(), child["launch_id"]),
                )
            self.assertFalse(
                state_store.claim_launch_ownership(child["launch_id"], "late", 9999)
            )


if __name__ == "__main__":
    unittest.main()
