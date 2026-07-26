import pathlib
import sys
import time
import unittest

from helpers import insert_ready_child, isolated_runtime

import agent_orchestrator
import outbox
import scheduler
import session_history
import state_store


FAKE_AGENT = pathlib.Path(__file__).resolve().parent / "fixtures" / "fake_acp_agent.py"


def wait_for(predicate, timeout=10):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.05)
    raise AssertionError("history fixture timed out")


class Phase1HistoryTests(unittest.TestCase):
    def _recorded_session(self, cwd):
        identity = agent_orchestrator.initialize_run(
            "root",
            str(cwd),
            max_attempts_per_task=1,
            backend="acp",
            acp_agent="custom",
            acp_command=sys.executable,
            acp_args=[str(FAKE_AGENT), "--scenario", "history"],
            acp_permission_policy="allow_in_workspace",
        )
        with state_store.transaction() as con:
            run = state_store.get_run(identity["root_id"], con)
            insert_ready_child(con, run)
        child = scheduler.schedule(identity["root_id"])[0]
        outbox.drain(identity["root_id"])
        session = wait_for(lambda: state_store.get_session_for_launch(child["launch_id"]))
        wait_for(lambda: state_store.get_launch(child["launch_id"])["status"] == "closed")
        return identity, child, session

    def test_session_id_and_agent_type_load_transient_history(self):
        with isolated_runtime() as (_, cwd):
            identity, child, session = self._recorded_session(cwd)
            result = session_history.load_history(
                "custom", session["external_session_id"]
            )
            self.assertTrue(result["available"], result)
            self.assertEqual(identity["root_id"], result["root_id"])
            self.assertEqual(child["attempt_id"], result["attempt_id"])
            encoded = str(result["history"])
            self.assertIn("remembered user message", encoded)
            self.assertIn("remembered agent response", encoded)

    def test_missing_session_returns_normal_structured_message(self):
        with isolated_runtime():
            result = session_history.load_history("codex", "does-not-exist")
            self.assertFalse(result["available"])
            self.assertEqual("not_recorded", result["reason"])
            self.assertIn("没有找到", result["message"])

    def test_agent_reported_lost_session_is_not_a_runtime_failure(self):
        with isolated_runtime() as (_, cwd):
            _, child, _ = self._recorded_session(cwd)
            with state_store.transaction() as con:
                con.execute(
                    "UPDATE acp_sessions SET external_session_id='missing-session' WHERE launch_id=?",
                    (child["launch_id"],),
                )
            result = session_history.load_history("custom", "missing-session")
            self.assertFalse(result["available"])
            self.assertEqual("session_missing", result["reason"])
            self.assertIn("已丢失", result["message"])

    def test_database_contains_no_dialogue_or_message_table(self):
        with isolated_runtime():
            state_store.initialize_schema()
            tables = {
                row["name"]
                for row in state_store.fetchall(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                )
            }
            self.assertTrue({"messages", "dialogues", "conversation_events"}.isdisjoint(tables))


if __name__ == "__main__":
    unittest.main()
