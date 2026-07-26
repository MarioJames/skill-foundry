import contextlib
import json
import os
import pathlib
import sqlite3
import subprocess
import sys
import unittest

from helpers import SCRIPTS_DIR, isolated_runtime

import agent_orchestrator
import state_store


class Phase0SchemaTests(unittest.TestCase):
    def test_clean_break_schema_has_task_attempt_launch_session_layers(self):
        with isolated_runtime():
            state_store.initialize_schema()
            with contextlib.closing(state_store.connect()) as con:
                tables = {
                    row["name"]
                    for row in con.execute(
                        "SELECT name FROM sqlite_master WHERE type='table'"
                    ).fetchall()
                }
                self.assertTrue(
                    {
                        "runs",
                        "tasks",
                        "task_dependencies",
                        "attempts",
                        "launches",
                        "agent_profiles",
                        "acp_sessions",
                        "effects",
                    }.issubset(tables)
                )
                self.assertTrue(
                    {"agents", "task_attempts", "execution_sessions", "side_effect_outbox"}.isdisjoint(tables)
                )
                self.assertEqual(
                    1,
                    con.execute("SELECT version FROM schema_migrations").fetchone()["version"],
                )

    def test_default_init_uses_only_root_id_as_generated_structural_id(self):
        with isolated_runtime() as (_, cwd):
            identity = agent_orchestrator.initialize_run("schema", str(cwd))
            self.assertTrue(identity["root_id"].startswith("root_"))
            self.assertIsInstance(identity["task_id"], int)
            self.assertIsInstance(identity["attempt_id"], int)
            run = state_store.get_run(identity["root_id"])
            self.assertEqual(identity["task_id"], run["root_task_id"])
            self.assertEqual("claude_cli", json.loads(run["execution_config_json"])["backend"])
            self.assertEqual([], state_store.list_launches(identity["root_id"]))

    def test_tree_is_reconstructable_from_parent_task_and_attempt_history(self):
        with isolated_runtime() as (_, cwd):
            identity = agent_orchestrator.initialize_run("tree", str(cwd))
            with state_store.transaction() as con:
                cursor = con.execute(
                    """INSERT INTO tasks(
                         root_id, parent_task_id, goal, intent_hint, status, priority,
                         complexity_hint, output_contract, constraints_json,
                         delegation_depth, replan_count, created_at
                       ) VALUES (?, ?, 'child', 'implement', 'ready', 50, 'medium',
                                 'report', '{}', 1, 0, ?)""",
                    (identity["root_id"], identity["task_id"], state_store.now()),
                )
                child_id = cursor.lastrowid
            self.assertEqual(identity["task_id"], state_store.get_task(child_id)["parent_task_id"])
            self.assertEqual([identity["task_id"], child_id], [item["task_id"] for item in state_store.list_tasks(identity["root_id"])])

    def test_owner_token_is_safe_as_a_separate_cli_argument(self):
        with isolated_runtime() as (_, cwd):
            identity = agent_orchestrator.initialize_run("safe token", str(cwd))
            completed = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPTS_DIR / "agent_orchestrator.py"),
                    "inspect",
                    "--run",
                    identity["root_id"],
                    "--actor-token",
                    identity["actor_token"],
                ],
                cwd=cwd,
                text=True,
                capture_output=True,
                check=False,
                env=os.environ.copy(),
            )
            self.assertEqual(0, completed.returncode, completed.stderr)
            payload = json.loads(completed.stdout)
            self.assertEqual(identity["root_id"], payload["run"]["root_id"])

    def test_old_runtime_database_name_is_not_migrated_or_copied(self):
        with isolated_runtime() as (runtime_home, _):
            runtime_home.mkdir(parents=True)
            old = runtime_home / "runtime-v2.sqlite3"
            with contextlib.closing(sqlite3.connect(old)) as con:
                with con:
                    con.execute("CREATE TABLE agents(agent_id TEXT PRIMARY KEY)")
            state_store.initialize_schema()
            self.assertEqual((runtime_home / "runtime.sqlite3").resolve(), state_store.db_path())
            self.assertTrue(old.exists())
            with contextlib.closing(state_store.connect()) as con:
                names = {
                    row["name"]
                    for row in con.execute("SELECT name FROM sqlite_master WHERE type='table'")
                }
            self.assertNotIn("agents", names)


if __name__ == "__main__":
    unittest.main()
