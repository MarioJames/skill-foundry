import base64
import hashlib
import hmac
import json
import os
import stat
import unittest
from unittest import mock

from helpers import insert_ready_child, isolated_runtime

import agent_orchestrator
import recovery
import scheduler
import state_store


class Phase1SecretTests(unittest.TestCase):
    def _create_child(self, cwd):
        with mock.patch.object(agent_orchestrator.hook_manager, "ensure_project_hooks"):
            identity = agent_orchestrator.initialize_run("root", str(cwd))
        with state_store.transaction() as con:
            run = state_store.get_run(identity["root_id"], con)
            insert_ready_child(con, run)
        child = scheduler.schedule(identity["root_id"])[0]
        return identity, child

    def test_run_seed_is_mode_0600_and_attempt_token_is_deterministic(self):
        import execution_secrets

        with isolated_runtime() as (_, cwd):
            identity, child = self._create_child(cwd)
            run = state_store.get_run(identity["root_id"])
            seed_path = execution_secrets.resolve_seed_path(run["child_token_seed_ref"])
            mode = stat.S_IMODE(seed_path.stat().st_mode)
            first = execution_secrets.derive_attempt_token(run, child["attempt_id"], child["agent_id"])
            second = execution_secrets.derive_attempt_token(run, child["attempt_id"], child["agent_id"])
            message = "%s|%s|%s" % (
                run["root_id"],
                child["attempt_id"],
                child["agent_id"],
            )
            legacy = base64.urlsafe_b64encode(
                hmac.new(seed_path.read_bytes(), message.encode("utf-8"), hashlib.sha256).digest()
            ).decode("ascii").rstrip("=")

            self.assertEqual(0o600, mode)
            self.assertEqual(first, second)
            self.assertEqual(legacy, first)
            self.assertTrue(state_store.token_matches(first, state_store.get_agent(child["agent_id"])["actor_token_hash"]))
            self.assertNotEqual(identity["actor_token"], first)

    def test_new_child_plaintext_token_is_absent_from_sqlite_outbox_and_prompt(self):
        import execution_secrets
        import prompt_builder

        with isolated_runtime() as (_, cwd):
            identity, child = self._create_child(cwd)
            run = state_store.get_run(identity["root_id"])
            token = execution_secrets.derive_attempt_token(run, child["attempt_id"], child["agent_id"])
            effect = state_store.list_outbox(identity["root_id"])[0]
            payload = json.loads(effect["payload_json"])
            task = state_store.get_task(child["task_id"])
            attempt = state_store.get_attempt(child["attempt_id"])
            agent = state_store.get_agent(child["agent_id"])
            prompt = prompt_builder.build_prompt(run, task, attempt, agent)

            self.assertNotIn("actor_token", payload)
            self.assertNotIn(token, effect["payload_json"])
            self.assertNotIn(token, prompt)
            self.assertNotIn(token.encode(), state_store.db_path().read_bytes())
            self.assertNotIn(token, json.dumps(state_store.list_executions(identity["root_id"])))

    def test_seed_cleanup_waits_for_terminal_run_and_closed_executions(self):
        import execution_secrets

        with isolated_runtime() as (_, cwd):
            identity, child = self._create_child(cwd)
            run = state_store.get_run(identity["root_id"])
            seed_path = execution_secrets.resolve_seed_path(run["child_token_seed_ref"])

            self.assertFalse(execution_secrets.cleanup_run_seed_if_safe(identity["root_id"]))
            self.assertTrue(seed_path.exists())
            with state_store.transaction() as con:
                con.execute("UPDATE runs SET status='cancelled' WHERE root_id=?", (identity["root_id"],))
                con.execute(
                    "UPDATE side_effect_outbox SET status='completed' WHERE root_id=?",
                    (identity["root_id"],),
                )
                con.execute(
                    "UPDATE execution_sessions SET status='closed', closed_at=? WHERE root_id=?",
                    (state_store.now(), identity["root_id"]),
                )

            self.assertTrue(execution_secrets.cleanup_run_seed_if_safe(identity["root_id"]))
            self.assertFalse(seed_path.exists())

    def test_terminal_stop_removes_run_seed(self):
        with isolated_runtime() as (_, cwd):
            with mock.patch.object(agent_orchestrator.hook_manager, "ensure_project_hooks"):
                identity = agent_orchestrator.initialize_run("root", str(cwd))
            run = state_store.get_run(identity["root_id"])
            seed_path = __import__("execution_secrets").resolve_seed_path(
                run["child_token_seed_ref"]
            )

            result = recovery.stop_run(identity["root_id"], identity["actor_token"])

            self.assertTrue(result["terminal"])
            self.assertFalse(seed_path.exists())


if __name__ == "__main__":
    unittest.main()
