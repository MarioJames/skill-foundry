import json
import pathlib
import unittest

from helpers import insert_ready_child, isolated_runtime

import agent_orchestrator
import execution_secrets
import prompt_builder
import recovery
import scheduler
import state_store


class Phase1SecretTests(unittest.TestCase):
    def _create_child(self, cwd):
        identity = agent_orchestrator.initialize_run("root", str(cwd), backend="claude_cli")
        with state_store.transaction() as con:
            run = state_store.get_run(identity["root_id"], con)
            insert_ready_child(con, run)
        return identity, scheduler.schedule(identity["root_id"])[0]

    def test_run_seed_is_mode_0600_and_attempt_token_is_deterministic(self):
        with isolated_runtime() as (_, cwd):
            identity, child = self._create_child(cwd)
            run = state_store.get_run(identity["root_id"])
            first = execution_secrets.derive_attempt_token(run, child["attempt_id"])
            second = execution_secrets.derive_attempt_token(run, child["attempt_id"])
            self.assertEqual(first, second)
            self.assertNotEqual(
                first, execution_secrets.derive_attempt_token(run, identity["attempt_id"])
            )
            path = execution_secrets.resolve_seed_path(run["token_seed_ref"])
            self.assertEqual(0o600, path.stat().st_mode & 0o777)
            self.assertTrue(state_store.token_matches(first, state_store.get_attempt(child["attempt_id"])["actor_token_hash"]))

    def test_plaintext_child_token_is_absent_from_database_effect_and_prompt(self):
        with isolated_runtime() as (runtime_home, cwd):
            identity, child = self._create_child(cwd)
            run = state_store.get_run(identity["root_id"])
            token = execution_secrets.derive_attempt_token(run, child["attempt_id"])
            attempt = state_store.get_attempt(child["attempt_id"])
            task = state_store.get_task(child["task_id"])
            prompt = prompt_builder.build_prompt(run, task, attempt)
            self.assertNotIn(token, prompt)
            self.assertNotIn(token, json.dumps(state_store.list_effects(identity["root_id"])))
            database = state_store.db_path().read_bytes()
            self.assertNotIn(token.encode(), database)

    def test_seed_cleanup_waits_for_terminal_run_and_closed_launches(self):
        with isolated_runtime() as (_, cwd):
            identity, child = self._create_child(cwd)
            run = state_store.get_run(identity["root_id"])
            path = execution_secrets.resolve_seed_path(run["token_seed_ref"])
            with state_store.transaction() as con:
                con.execute("UPDATE runs SET status='cancelled' WHERE root_id=?", (identity["root_id"],))
                con.execute("UPDATE effects SET status='completed' WHERE root_id=?", (identity["root_id"],))
            self.assertFalse(execution_secrets.cleanup_run_seed_if_safe(identity["root_id"]))
            self.assertTrue(path.exists())
            with state_store.transaction() as con:
                con.execute(
                    "UPDATE launches SET status='closed', closed_at=? WHERE launch_id=?",
                    (state_store.now(), child["launch_id"]),
                )
            self.assertTrue(execution_secrets.cleanup_run_seed_if_safe(identity["root_id"]))
            self.assertFalse(path.exists())

    def test_terminal_stop_removes_run_seed(self):
        with isolated_runtime() as (_, cwd):
            identity = agent_orchestrator.initialize_run("root", str(cwd), backend="claude_cli")
            run = state_store.get_run(identity["root_id"])
            path = execution_secrets.resolve_seed_path(run["token_seed_ref"])
            result = recovery.stop_run(identity["root_id"], identity["actor_token"])
            self.assertEqual("cancelled", result["status"])
            self.assertFalse(path.exists())


if __name__ == "__main__":
    unittest.main()
