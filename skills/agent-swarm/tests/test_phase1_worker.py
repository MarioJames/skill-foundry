import os
import pathlib
import signal
import subprocess
import sys
import time
import unittest
from unittest import mock

from helpers import SCRIPTS_DIR, insert_ready_child, isolated_runtime

import agent_orchestrator
import execution_secrets
import outbox
import recovery
import scheduler
import state_store
from backends.acp.adapter import AcpBackend


FAKE_AGENT = pathlib.Path(__file__).resolve().parent / "fixtures" / "fake_acp_agent.py"
STUBBORN_GROUP = pathlib.Path(__file__).resolve().parent / "fixtures" / "stubborn_process_group.py"


def wait_for(predicate, timeout=10):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.05)
    raise AssertionError("condition not met within %.1fs" % timeout)


def pid_alive(pid):
    if not pid:
        return False
    try:
        os.kill(int(pid), 0)
        return True
    except ProcessLookupError:
        return False


class Phase1WorkerTests(unittest.TestCase):
    def test_process_group_cleanup_kills_descendant_after_leader_exits(self):
        from backends.acp.processes import process_group_alive, terminate_process_group

        with isolated_runtime() as (_, cwd):
            child_file = cwd / "stubborn-child.pid"
            child_pid = None
            process = subprocess.Popen(
                [sys.executable, str(STUBBORN_GROUP), "--pid-file", str(child_file)],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
                env={**os.environ, "AGENT_SWARM_EXECUTION_NONCE": "owned-test-group"},
            )
            try:
                child_pid = int(wait_for(lambda: child_file.read_text() if child_file.exists() else None))
                self.assertTrue(process_group_alive(process.pid))
                self.assertTrue(terminate_process_group(process.pid, grace=0.2, trusted=True))
                process.wait(timeout=3)
                self.assertFalse(process_group_alive(process.pid))
                wait_for(lambda: not pid_alive(child_pid), timeout=3)
            finally:
                if process_group_alive(process.pid):
                    terminate_process_group(process.pid, grace=0.5, trusted=True)
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=3)
                if child_pid and pid_alive(child_pid):
                    try:
                        os.kill(child_pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass

    def test_unverified_reused_pid_is_never_signalled(self):
        from backends.acp import processes

        with mock.patch.object(processes, "process_group_alive", return_value=True), mock.patch.object(
            processes, "process_group_leader_alive", return_value=True
        ), mock.patch.object(processes, "process_has_nonce", return_value=False), mock.patch.object(
            processes.os, "killpg"
        ) as killpg:
            cleaned = processes.terminate_process_group(4242, grace=0, expected_nonce="owner")
        self.assertFalse(cleaned)
        killpg.assert_not_called()

    def test_process_nonce_fingerprint_round_trip(self):
        from backends.acp.processes import process_has_nonce, terminate_process_group

        process = subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(30)"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
            env={**os.environ, "AGENT_SWARM_EXECUTION_NONCE": "nonce-round-trip"},
        )
        try:
            self.assertTrue(process_has_nonce(process.pid, "nonce-round-trip"))
            self.assertFalse(process_has_nonce(process.pid, "another"))
        finally:
            terminate_process_group(process.pid, grace=0.5, trusted=True)
            if process.poll() is None:
                process.kill()
            process.wait(timeout=3)

    def _create_child(self, cwd, scenario, *, max_attempts=2):
        identity = agent_orchestrator.initialize_run(
            "root",
            str(cwd),
            max_attempts_per_task=max_attempts,
            backend="acp",
            acp_agent="custom",
            acp_command=sys.executable,
            acp_args=[str(FAKE_AGENT), "--scenario", scenario],
            acp_permission_policy="allow_in_workspace",
        )
        with state_store.transaction() as con:
            run = state_store.get_run(identity["root_id"], con)
            insert_ready_child(con, run)
        return identity, scheduler.schedule(identity["root_id"])[0]

    def _stop(self, identity):
        run = state_store.get_run(identity["root_id"])
        if run and run["status"] not in {"done", "cancelled"}:
            with mock.patch.object(recovery, "HEARTBEAT_STALE_SECONDS", 0):
                try:
                    recovery.stop_run(identity["root_id"], identity["actor_token"])
                except Exception:
                    pass

    def test_fake_acp_child_finishes_and_persists_real_session_id(self):
        with isolated_runtime() as (runtime_home, cwd):
            identity, child = self._create_child(cwd, "finish")
            try:
                run = state_store.get_run(identity["root_id"])
                token = execution_secrets.derive_attempt_token(run, child["attempt_id"]).encode()
                self.assertEqual(1, outbox.drain(identity["root_id"])["completed"])
                wait_for(lambda: state_store.get_task(child["task_id"])["status"] == "done")
                launch = wait_for(
                    lambda: (
                        item if (item := state_store.get_launch(child["launch_id"]))["status"] == "closed" else None
                    )
                )
                session = state_store.get_session_for_launch(child["launch_id"])
                self.assertTrue(session["external_session_id"].startswith("fake-session-"))
                self.assertEqual("closed", session["status"])
                self.assertEqual("done", state_store.get_attempt(child["attempt_id"])["state"])
                persisted = b"".join(path.read_bytes() for path in runtime_home.rglob("*") if path.is_file())
                self.assertNotIn(token, persisted)
                self.assertFalse(pathlib.Path(launch["control_endpoint"]).exists())
            finally:
                self._stop(identity)

    def test_fake_acp_split_reconstructs_tree_and_closes_all_launches(self):
        with isolated_runtime() as (_, cwd):
            identity, child = self._create_child(cwd, "split")
            try:
                outbox.drain(identity["root_id"])
                wait_for(
                    lambda: (
                        len(state_store.list_tasks(identity["root_id"])) == 4
                        and all(
                            item["status"] == "done"
                            for item in state_store.list_tasks(identity["root_id"])
                            if item["task_id"] != identity["task_id"]
                        )
                    ),
                    timeout=20,
                )
                launches = wait_for(
                    lambda: (
                        rows
                        if (rows := state_store.list_launches(identity["root_id"]))
                        and len(rows) == 3
                        and all(item["status"] == "closed" for item in rows)
                        else None
                    ),
                    timeout=10,
                )
                tasks = state_store.list_tasks(identity["root_id"])
                self.assertEqual(
                    2,
                    len([item for item in tasks if item["parent_task_id"] == child["task_id"]]),
                )
                self.assertEqual(3, len(state_store.list_sessions(identity["root_id"])))
            finally:
                self._stop(identity)

    def test_unfinished_turn_reconciles_once_into_retry(self):
        with isolated_runtime() as (_, cwd):
            identity, child = self._create_child(cwd, "basic")
            try:
                outbox.drain(identity["root_id"])
                wait_for(lambda: state_store.get_launch(child["launch_id"])["status"] == "closed")
                recovery.reap_children(identity["root_id"], identity["actor_token"])
                recovery.reap_children(identity["root_id"], identity["actor_token"])
                attempts = [a for a in state_store.list_attempts(identity["root_id"]) if a["task_id"] == child["task_id"]]
                self.assertEqual(2, len(attempts))
                self.assertEqual("failed", attempts[0]["state"])
                self.assertEqual("assigned", attempts[1]["state"])
            finally:
                self._stop(identity)

    def test_agent_process_crash_is_retryable_and_leaves_no_process(self):
        with isolated_runtime() as (_, cwd):
            identity, child = self._create_child(cwd, "crash")
            try:
                outbox.drain(identity["root_id"])
                launch = wait_for(lambda: state_store.get_launch(child["launch_id"]) if state_store.get_launch(child["launch_id"])["status"] == "closed" else None)
                recovery.reap_children(identity["root_id"], identity["actor_token"])
                self.assertEqual("failed", state_store.get_attempt(child["attempt_id"])["state"])
                self.assertFalse(pid_alive(launch["worker_pid"]))
                self.assertFalse(pid_alive(launch["agent_pid"]))
            finally:
                self._stop(identity)

    def test_runtime_stop_cleans_worker_agent_and_socket(self):
        with isolated_runtime() as (_, cwd):
            identity, child = self._create_child(cwd, "hold")
            outbox.drain(identity["root_id"])
            running = state_store.get_launch(child["launch_id"])
            result = recovery.stop_run(identity["root_id"], identity["actor_token"])
            self.assertEqual("cancelled", result["status"])
            launch = state_store.get_launch(child["launch_id"])
            self.assertEqual("closed", launch["status"])
            self.assertFalse(pid_alive(running["worker_pid"]))
            self.assertFalse(pid_alive(running["agent_pid"]))
            self.assertFalse(pathlib.Path(running["control_endpoint"]).exists())

    def test_absent_launch_retry_is_append_only(self):
        with isolated_runtime() as (_, cwd):
            identity, child = self._create_child(cwd, "hold")
            launch = state_store.get_launch(child["launch_id"])
            backend = AcpBackend(
                {"worker_launch_timeout_seconds": 0.01}, execution_record=launch
            )
            with mock.patch.object(backend, "_launch_worker"):
                result = outbox.drain(identity["root_id"], adapter=backend, max_effects=1)
            self.assertEqual(1, result["deferred"])
            old = state_store.get_launch(child["launch_id"])
            new = state_store.get_current_launch(child["attempt_id"])
            self.assertEqual("closed", old["status"])
            self.assertNotEqual(old["launch_id"], new["launch_id"])
            self.assertEqual(2, new["launch_no"])
            self.assertEqual(2, len(state_store.list_effects(identity["root_id"])))


if __name__ == "__main__":
    unittest.main()
