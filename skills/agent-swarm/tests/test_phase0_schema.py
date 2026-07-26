import json
import os
import re
import unittest
from unittest import mock

from helpers import isolated_runtime

import agent_orchestrator
import state_store


class Phase0SchemaTests(unittest.TestCase):
    def test_schema_adds_execution_snapshot_and_session_fencing_columns(self):
        with isolated_runtime():
            state_store.initialize_schema()
            con = state_store.connect()
            try:
                run_columns = {
                    row["name"] for row in con.execute("PRAGMA table_info(runs)").fetchall()
                }
                agent_columns = {
                    row["name"] for row in con.execute("PRAGMA table_info(agents)").fetchall()
                }
                execution_columns = {
                    row["name"]
                    for row in con.execute("PRAGMA table_info(execution_sessions)").fetchall()
                }
            finally:
                con.close()

            self.assertIn("execution_json", run_columns)
            self.assertTrue({"backend_id", "agent_key"}.issubset(agent_columns))
            self.assertTrue(
                {
                    "attempt_id",
                    "backend_id",
                    "generation",
                    "owner_nonce",
                    "execution_id",
                    "config_json",
                    "status",
                    "stop_requested_at",
                    "reconciled_at",
                }.issubset(execution_columns)
            )

    def test_default_init_persists_claude_cli_execution_config(self):
        with isolated_runtime() as (_, cwd), mock.patch.object(
            agent_orchestrator.hook_manager, "ensure_project_hooks"
        ):
            identity = agent_orchestrator.initialize_run("goal", str(cwd))
            run = state_store.get_run(identity["root_id"])
            execution = json.loads(run["execution_json"])
            self.assertEqual("claude_cli", execution["backend"])

    def test_owner_token_is_safe_as_a_separate_cli_argument(self):
        with isolated_runtime() as (_, cwd), mock.patch.object(
            agent_orchestrator.hook_manager, "ensure_project_hooks"
        ), mock.patch.object(
            agent_orchestrator.secrets, "token_urlsafe", return_value="-leading"
        ):
            identity = agent_orchestrator.initialize_run("goal", str(cwd))

        self.assertEqual("as_-leading", identity["actor_token"])

    def test_explicit_init_config_wins_over_environment_and_is_persisted(self):
        with isolated_runtime() as (_, cwd), mock.patch.dict(
            os.environ,
            {
                "AGENT_SWARM_BACKEND": "claude_cli",
                "AGENT_SWARM_ACP_AGENT": "claude",
            },
        ), mock.patch.object(agent_orchestrator.hook_manager, "ensure_project_hooks"):
            identity = agent_orchestrator.initialize_run(
                "goal",
                str(cwd),
                backend="acp",
                acp_agent="codex",
                acp_command="codex-acp",
                acp_args=["--stdio"],
                acp_permission_policy="deny_all",
            )
            run = state_store.get_run(identity["root_id"])
            execution = json.loads(run["execution_json"])

            self.assertEqual("acp", execution["backend"])
            self.assertEqual("codex", execution["acp"]["agent"])
            self.assertEqual("codex-acp", execution["acp"]["command"])
            self.assertEqual(["--stdio"], execution["acp"]["args"])
            self.assertEqual("deny_all", execution["acp"]["permission_policy"])

    def test_existing_v2_database_is_additively_backfilled_as_claude_cli(self):
        with isolated_runtime():
            legacy_sql = state_store.SCHEMA_SQL
            legacy_sql = legacy_sql.replace("  execution_json TEXT NOT NULL DEFAULT '{}',\n", "")
            legacy_sql = legacy_sql.replace("  backend_id TEXT,\n", "")
            legacy_sql = legacy_sql.replace("  agent_key TEXT,\n", "")
            legacy_sql = re.sub(
                r"CREATE TABLE IF NOT EXISTS execution_sessions \(.*?"
                r"CREATE INDEX IF NOT EXISTS idx_execution_sessions_root_status\n"
                r"ON execution_sessions\(root_id, status\);\n",
                "",
                legacy_sql,
                flags=re.S,
            )
            path = state_store.db_path()
            path.parent.mkdir(parents=True, exist_ok=True)
            con = state_store.sqlite3.connect(str(path), isolation_level=None)
            try:
                con.executescript(legacy_sql)
                now = state_store.now()
                con.execute(
                    """INSERT INTO runs(
                         root_id, task, cwd, model_tiers_json, created_at, updated_at
                       ) VALUES ('root_old', 'goal', '/tmp/old', '{}', ?, ?)""",
                    (now, now),
                )
                con.execute(
                    """INSERT INTO tasks(
                         task_id, root_id, goal, intent_hint, status, constraints_json, created_at
                       ) VALUES ('task_old', 'root_old', 'goal', 'implement', 'active', '{}', ?)""",
                    (now,),
                )
                con.execute(
                    """INSERT INTO side_effect_outbox(
                         root_id, effect_type, payload_json, idempotency_key,
                         status, attempts, created_at
                       ) VALUES (
                         'root_old', 'stop_agent',
                         '{"root_id":"root_old","attempt_id":null,"job_id":"orphan-job"}',
                         'stop:orphan:root_old:orphan-job', 'pending', 0, ?
                       )""",
                    (now,),
                )
                con.execute(
                    """INSERT INTO task_attempts(
                         attempt_id, root_id, task_id, attempt_no, agent_id, status
                       ) VALUES ('attempt_old', 'root_old', 'task_old', 1, 'agent_old', 'running')"""
                )
                con.execute(
                    """INSERT INTO agents(
                         agent_id, root_id, task_id, attempt_id, state, actor_token_hash,
                         session_name, job_id, model_name, created_at
                       ) VALUES (
                         'agent_old', 'root_old', 'task_old', 'attempt_old', 'evaluating',
                         'hash', 'agent-swarm-old', 'job-old', 'sonnet', ?
                       )""",
                    (now,),
                )
            finally:
                con.close()

            state_store.initialize_schema()
            run = state_store.get_run("root_old")
            agent = state_store.get_agent("agent_old")
            execution = state_store.get_execution("attempt_old")

            self.assertEqual("claude_cli", json.loads(run["execution_json"])["backend"])
            self.assertEqual("claude_cli", agent["backend_id"])
            self.assertEqual("claude", agent["agent_key"])
            self.assertEqual("claude_cli", execution["backend_id"])
            self.assertEqual("job-old", agent["job_id"])
            legacy_effect = state_store.list_outbox("root_old")[0]
            migrated_payload = json.loads(legacy_effect["payload_json"])
            self.assertEqual("claude_cli", migrated_payload["backend_id"])
            self.assertEqual(1, migrated_payload["generation"])
            self.assertTrue(migrated_payload["execution_id"].startswith("legacy-orphan:"))
            self.assertEqual(
                "claude_cli", json.loads(migrated_payload["config_json"])["backend"]
            )


if __name__ == "__main__":
    unittest.main()
