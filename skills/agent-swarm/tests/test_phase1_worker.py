import json
import os
import pathlib
import signal
import subprocess
import sys
import threading
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
from backends.base import SpawnRequest


FAKE_AGENT = pathlib.Path(__file__).resolve().parent / "fixtures" / "fake_acp_agent.py"
ORCHESTRATOR = SCRIPTS_DIR / "agent_orchestrator.py"
ACP_WORKER = SCRIPTS_DIR / "backends" / "acp" / "worker.py"
STUBBORN_GROUP = pathlib.Path(__file__).resolve().parent / "fixtures" / "stubborn_process_group.py"


def wait_for(predicate, timeout=8):
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
                self.assertTrue(
                    terminate_process_group(process.pid, grace=0.2, trusted=True)
                )
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
            cleaned = processes.terminate_process_group(
                4242, grace=0, expected_nonce="execution-owner"
            )

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
            self.assertFalse(process_has_nonce(process.pid, "another-execution"))
        finally:
            terminate_process_group(process.pid, grace=0.5, trusted=True)
            if process.poll() is None:
                process.wait(timeout=3)

    def _create_child(self, cwd, scenario, counter_file=None, extra_args=None):
        args = [str(FAKE_AGENT), "--scenario", scenario]
        if counter_file:
            args.extend(["--counter-file", str(counter_file)])
        args.extend(extra_args or [])
        identity = agent_orchestrator.initialize_run(
            "root",
            str(cwd),
            backend="acp",
            acp_agent="custom",
            acp_command=sys.executable,
            acp_args=args,
            acp_permission_policy="allow_in_workspace",
        )
        with state_store.transaction() as con:
            run = state_store.get_run(identity["root_id"], con)
            insert_ready_child(con, run)
        child = scheduler.schedule(identity["root_id"])[0]
        return identity, child

    def _stop_if_needed(self, identity):
        run = state_store.get_run(identity["root_id"])
        if run and run["status"] not in {"done", "cancelled"}:
            try:
                recovery.stop_run(identity["root_id"], identity["actor_token"])
            except Exception:
                pass

    def test_fake_acp_child_finishes_via_real_runtime_actions_and_cleans_up(self):
        with isolated_runtime() as (runtime_home, cwd):
            identity, child = self._create_child(cwd, "finish")
            try:
                run = state_store.get_run(identity["root_id"])
                token = execution_secrets.derive_attempt_token(
                    run, child["attempt_id"], child["agent_id"]
                ).encode()
                drained = outbox.drain(identity["root_id"])
                self.assertEqual(1, drained["completed"])
                wait_for(lambda: state_store.get_task(child["task_id"])["status"] == "done")
                execution = wait_for(
                    lambda: (
                        record
                        if (record := state_store.get_execution(child["attempt_id"]))["status"] == "closed"
                        else None
                    )
                )
                wait_for(lambda: not pid_alive(execution["worker_pid"]))
                wait_for(lambda: not pid_alive(execution["agent_pid"]))
                self.assertFalse(pathlib.Path(execution["control_endpoint"]).exists())
                attempt = state_store.get_attempt(child["attempt_id"])
                self.assertEqual("done", attempt["status"])
                persisted = b"".join(
                    path.read_bytes()
                    for path in runtime_home.rglob("*")
                    if path.is_file()
                )
                self.assertNotIn(token, persisted)
            finally:
                self._stop_if_needed(identity)

    def test_fake_acp_split_closes_parent_and_leaf_executions(self):
        with isolated_runtime() as (_, cwd):
            identity, child = self._create_child(cwd, "split")
            try:
                drained = outbox.drain(identity["root_id"])
                self.assertEqual(1, drained["completed"])
                wait_for(
                    lambda: state_store.get_task(child["task_id"])["status"] == "done",
                    timeout=20,
                )
                descendants = [
                    task
                    for task in state_store.list_tasks(identity["root_id"])
                    if task["task_id"] != identity["task_id"]
                ]
                self.assertEqual(3, len(descendants))
                self.assertTrue(all(task["status"] == "done" for task in descendants))
                executions = wait_for(
                    lambda: (
                        rows
                        if (rows := state_store.list_executions(identity["root_id"]))
                        and all(item["status"] == "closed" for item in rows)
                        else None
                    )
                )
                wait_for(lambda: all(not pid_alive(item["worker_pid"]) for item in executions))
                wait_for(lambda: all(not pid_alive(item["agent_pid"]) for item in executions))
                self.assertTrue(
                    all(not pathlib.Path(item["control_endpoint"]).exists() for item in executions)
                )
            finally:
                self._stop_if_needed(identity)

    def test_unfinished_turn_is_reconciled_once_into_one_retry(self):
        with isolated_runtime() as (_, cwd):
            identity, child = self._create_child(cwd, "basic")
            try:
                outbox.drain(identity["root_id"])
                wait_for(
                    lambda: state_store.get_execution(child["attempt_id"])["status"]
                    == "closed"
                )
                first = recovery.reap_children(
                    identity["root_id"], identity["actor_token"]
                )
                second = recovery.reap_children(
                    identity["root_id"], identity["actor_token"]
                )
                attempts = [
                    attempt
                    for attempt in state_store.list_attempts(identity["root_id"])
                    if attempt["task_id"] == child["task_id"]
                ]
                self.assertEqual(
                    1, first["execution_outcomes"]["reconciled_failures"]
                )
                self.assertEqual(
                    0, second["execution_outcomes"]["reconciled_failures"]
                )
                self.assertEqual(2, len(attempts))
            finally:
                self._stop_if_needed(identity)

    def test_independent_runtime_cli_stop_cleans_worker_agent_and_socket(self):
        with isolated_runtime() as (runtime_home, cwd):
            identity, child = self._create_child(cwd, "hold")
            try:
                outbox.drain(identity["root_id"])
                running = wait_for(
                    lambda: (
                        record
                        if (record := state_store.get_execution(child["attempt_id"]))["status"] == "running"
                        else None
                    )
                )
                env = os.environ.copy()
                env["AGENT_SWARM_HOME"] = str(runtime_home)
                completed = subprocess.run(
                    [
                        sys.executable,
                        str(ORCHESTRATOR),
                        "stop",
                        "--root-id",
                        identity["root_id"],
                        "--actor-token",
                        identity["actor_token"],
                    ],
                    text=True,
                    capture_output=True,
                    env=env,
                    check=False,
                    timeout=15,
                )
                self.assertEqual(0, completed.returncode, completed.stderr)
                result = json.loads(completed.stdout)
                self.assertTrue(result["terminal"], result)
                closed = state_store.get_execution(child["attempt_id"])
                self.assertEqual("closed", closed["status"])
                self.assertFalse(pid_alive(running["worker_pid"]))
                self.assertFalse(pid_alive(running["agent_pid"]))
                self.assertFalse(pathlib.Path(running["control_endpoint"]).exists())
            finally:
                self._stop_if_needed(identity)

    def test_ready_ack_loss_reuses_worker_without_second_agent_process(self):
        from backends.acp.adapter import AcpBackend

        with isolated_runtime() as (_, cwd):
            counter = cwd / "starts.txt"
            identity, child = self._create_child(cwd, "hold", counter)
            try:
                run = state_store.get_run(identity["root_id"])
                task = state_store.get_task(child["task_id"])
                attempt = state_store.get_attempt(child["attempt_id"])
                agent = state_store.get_agent(child["agent_id"])
                execution = state_store.get_execution(child["attempt_id"])
                token = execution_secrets.derive_attempt_token(run, attempt["attempt_id"], agent["agent_id"])
                request = SpawnRequest(
                    prompt="bootstrap",
                    cwd=run["cwd"],
                    session_name=agent["session_name"],
                    model=agent["model_name"],
                    env={"AGENT_SWARM_ACTOR_TOKEN": token},
                    backend_config=json.loads(execution["config_json"]),
                    metadata={
                        "root_id": run["root_id"],
                        "task_id": task["task_id"],
                        "attempt_id": attempt["attempt_id"],
                        "agent_id": agent["agent_id"],
                        "execution_id": execution["execution_id"],
                    },
                )
                backend = AcpBackend(json.loads(execution["config_json"]), execution_record=execution)
                first = backend.spawn(request)
                second_drain = outbox.drain(identity["root_id"])
                self.assertEqual(execution["execution_id"], first.job_id)
                self.assertEqual(1, second_drain["completed"])
                self.assertEqual("1", counter.read_text())
            finally:
                self._stop_if_needed(identity)

    def test_worker_crash_with_live_orphan_agent_is_unknown_and_not_respawned(self):
        from backends.acp.adapter import AcpBackend

        with isolated_runtime() as (_, cwd):
            counter = cwd / "starts.txt"
            identity, child = self._create_child(cwd, "hold", counter)
            try:
                outbox.drain(identity["root_id"])
                execution = wait_for(
                    lambda: (
                        record
                        if (record := state_store.get_execution(child["attempt_id"]))["status"] == "running"
                        else None
                    )
                )
                os.kill(int(execution["worker_pid"]), signal.SIGKILL)
                wait_for(lambda: not pid_alive(execution["worker_pid"]))
                self.assertTrue(pid_alive(execution["agent_pid"]))
                backend = AcpBackend(json.loads(execution["config_json"]), execution_record=execution)
                observation = backend.observe(job_id=execution["execution_id"])
                self.assertEqual("unknown", observation.presence)
                self.assertEqual("1", counter.read_text())
            finally:
                self._stop_if_needed(identity)

    def test_absent_generation_advances_once_and_delayed_old_worker_is_fenced(self):
        with isolated_runtime() as (runtime_home, cwd):
            counter = cwd / "starts.txt"
            identity, child = self._create_child(cwd, "hold", counter)
            try:
                original = state_store.get_execution(child["attempt_id"])
                config = json.loads(original["config_json"])
                config["worker_launch_timeout_seconds"] = 0.1
                with state_store.transaction() as con:
                    con.execute(
                        """UPDATE execution_sessions
                           SET owner_nonce='dead-owner', worker_pid=99999999, config_json=?
                           WHERE attempt_id=?""",
                        (json.dumps(config, sort_keys=True), child["attempt_id"]),
                    )

                first = outbox.drain(identity["root_id"], max_effects=1)
                advanced = state_store.get_execution(child["attempt_id"])
                self.assertEqual(1, first["deferred"])
                self.assertEqual(2, advanced["generation"])
                self.assertIsNone(advanced["owner_nonce"])
                self.assertEqual("acp:%s:2" % child["attempt_id"], advanced["execution_id"])

                second = wait_for(
                    lambda: (
                        summary
                        if (summary := outbox.drain(identity["root_id"], max_effects=1))[
                            "completed"
                        ]
                        else None
                    )
                )
                self.assertEqual(1, second["completed"])
                wait_for(
                    lambda: state_store.get_execution(child["attempt_id"])["status"] == "running"
                )
                self.assertEqual(2, state_store.get_execution(child["attempt_id"])["generation"])
                self.assertEqual("1", counter.read_text())

                env = os.environ.copy()
                env["AGENT_SWARM_HOME"] = str(runtime_home)
                delayed = subprocess.run(
                    [
                        sys.executable,
                        str(ACP_WORKER),
                        "--attempt-id",
                        child["attempt_id"],
                        "--generation",
                        "1",
                        "--candidate-nonce",
                        "delayed-old-worker",
                    ],
                    env=env,
                    text=True,
                    capture_output=True,
                    timeout=5,
                    check=False,
                )
                self.assertEqual(3, delayed.returncode)
                self.assertEqual("1", counter.read_text())
            finally:
                self._stop_if_needed(identity)

    def test_live_starting_orphan_blocks_generation_until_cleanup_is_confirmed(self):
        with isolated_runtime() as (_, cwd):
            counter = cwd / "starts.txt"
            identity, child = self._create_child(cwd, "hold", counter)
            orphan = subprocess.Popen(
                [sys.executable, str(FAKE_AGENT), "--scenario", "hold"],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
            try:
                execution = state_store.get_execution(child["attempt_id"])
                config = json.loads(execution["config_json"])
                config["worker_launch_timeout_seconds"] = 0.1
                with state_store.transaction() as con:
                    con.execute(
                        """UPDATE execution_sessions
                           SET owner_nonce='lost-worker', worker_pid=99999999,
                               agent_pid=?, config_json=? WHERE attempt_id=?""",
                        (orphan.pid, json.dumps(config, sort_keys=True), child["attempt_id"]),
                    )

                blocked = outbox.drain(identity["root_id"], max_effects=1)
                self.assertEqual(1, blocked["deferred"])
                self.assertEqual(1, state_store.get_execution(child["attempt_id"])["generation"])
                self.assertTrue(pid_alive(orphan.pid))

                os.killpg(orphan.pid, signal.SIGTERM)
                orphan.wait(timeout=5)
                advanced = outbox.drain(identity["root_id"], max_effects=1)
                self.assertEqual(1, advanced["deferred"])
                self.assertEqual(2, state_store.get_execution(child["attempt_id"])["generation"])

                wait_for(
                    lambda: (
                        summary
                        if (summary := outbox.drain(identity["root_id"], max_effects=1))[
                            "completed"
                        ]
                        else None
                    )
                )
                self.assertEqual("1", counter.read_text())
            finally:
                if orphan.poll() is None:
                    os.killpg(orphan.pid, signal.SIGTERM)
                    orphan.wait(timeout=5)
                self._stop_if_needed(identity)

    def test_stop_fences_starting_execution_during_initialize_and_session_new(self):
        for delay_arg, required_event in (
            ("--initialize-delay", None),
            ("--session-delay", "AcpInitialized"),
        ):
            with self.subTest(delay_arg=delay_arg), isolated_runtime() as (_, cwd):
                identity, child = self._create_child(
                    cwd, "hold", extra_args=[delay_arg, "2"]
                )
                drain_errors = []

                def drain_spawn():
                    try:
                        outbox.drain(identity["root_id"], max_effects=1)
                    except Exception as exc:  # pragma: no cover - diagnostic only
                        drain_errors.append(exc)

                thread = threading.Thread(target=drain_spawn)
                thread.start()
                try:
                    starting = wait_for(
                        lambda: (
                            record
                            if (record := state_store.get_execution(child["attempt_id"]))[
                                "agent_pid"
                            ]
                            else None
                        )
                    )
                    if required_event:
                        wait_for(
                            lambda: any(
                                event["type"] == required_event
                                for event in state_store.list_events(identity["root_id"], 100)
                            )
                        )
                    result = recovery.stop_run(
                        identity["root_id"], identity["actor_token"]
                    )
                    thread.join(timeout=10)
                    self.assertFalse(thread.is_alive())
                    self.assertFalse(drain_errors)
                    self.assertTrue(result["terminal"], result)
                    closed = state_store.get_execution(child["attempt_id"])
                    self.assertEqual("closed", closed["status"])
                    self.assertIsNone(closed["ready_at"])
                    wait_for(lambda: not pid_alive(starting["worker_pid"]))
                    wait_for(lambda: not pid_alive(starting["agent_pid"]))
                    self.assertFalse(pathlib.Path(starting["control_endpoint"]).exists())
                finally:
                    if thread.is_alive():
                        thread.join(timeout=10)
                    self._stop_if_needed(identity)


if __name__ == "__main__":
    unittest.main()
