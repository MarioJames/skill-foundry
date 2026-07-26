import json
import os
import pathlib
import sys
import unittest
from unittest import mock

from helpers import isolated_runtime

import agent_orchestrator
import execution_config
import recovery
import scheduler
import state_store
from backends.acp import registry
from helpers import insert_ready_child


class Phase1RegistryTests(unittest.TestCase):
    def test_builtin_profiles_pin_adapter_versions_and_commands(self):
        claude = registry.resolve_profile("claude")
        codex = registry.resolve_profile("codex")
        gemini = registry.resolve_profile("gemini")

        self.assertEqual("claude-agent-acp", claude["command"])
        self.assertEqual("0.62.0", claude["profile_version"])
        self.assertEqual(
            "bun add -g @agentclientprotocol/claude-agent-acp@0.62.0",
            claude["install_hint"],
        )
        self.assertEqual("codex-acp", codex["command"])
        self.assertEqual("1.1.7", codex["profile_version"])
        self.assertEqual("@agentclientprotocol/codex-acp", codex["package"])
        self.assertEqual(
            "bun add -g @agentclientprotocol/codex-acp@1.1.7",
            codex["install_hint"],
        )
        self.assertEqual([], codex["args"])
        self.assertEqual(
            {
                "strong": "gpt-5.6-sol",
                "balanced": "gpt-5.6-terra",
                "fast": "gpt-5.6-luna",
            },
            codex["model_tiers"],
        )
        self.assertEqual(["--acp"], gemini["args"])

    def test_claude_and_codex_default_to_full_access_without_overriding_explicit_policy(self):
        claude = execution_config.resolve_run_execution(
            backend="acp", acp_agent="claude", environment={"PATH": ""}
        )
        codex = execution_config.resolve_run_execution(
            backend="acp", acp_agent="codex", environment={"PATH": ""}
        )
        gemini = execution_config.resolve_run_execution(
            backend="acp", acp_agent="gemini", environment={"PATH": ""}
        )
        custom = execution_config.resolve_run_execution(
            backend="acp",
            acp_agent="custom",
            acp_command=sys.executable,
            environment={"PATH": ""},
        )
        opted_down = execution_config.resolve_run_execution(
            backend="acp",
            acp_agent="codex",
            acp_permission_policy="allow_in_workspace",
            environment={"PATH": ""},
        )

        self.assertEqual("allow_all", claude["acp"]["permission_policy"])
        self.assertEqual("allow_all", codex["acp"]["permission_policy"])
        self.assertEqual("allow_in_workspace", gemini["acp"]["permission_policy"])
        self.assertEqual("allow_in_workspace", custom["acp"]["permission_policy"])
        self.assertEqual(
            "allow_in_workspace", opted_down["acp"]["permission_policy"]
        )

    def test_custom_requires_command_and_explicit_override_is_frozen(self):
        with self.assertRaisesRegex(ValueError, "custom.*command"):
            registry.resolve_profile("custom")

        profile = registry.resolve_profile(
            "custom", command="/opt/tools/my-acp", args=["serve"]
        )
        self.assertEqual("/opt/tools/my-acp", profile["command"])
        self.assertEqual(["serve"], profile["args"])
        self.assertTrue(profile["user_override"])

        with self.assertRaisesRegex(ValueError, "absolute path"):
            execution_config.resolve_run_execution(
                backend="acp",
                acp_agent="custom",
                acp_command="relative-agent",
                environment={"PATH": "/usr/bin"},
            )

    def test_missing_builtin_executable_has_exact_install_hint_without_installing(self):
        profile = registry.resolve_profile("codex")
        with mock.patch("backends.acp.registry.shutil.which", return_value=None):
            with self.assertRaisesRegex(
                RuntimeError,
                "bun add -g @agentclientprotocol/codex-acp@1.1.7",
            ):
                registry.ensure_available(profile)

    def test_execution_config_resolves_registry_once(self):
        with isolated_runtime() as (_, cwd):
            first = cwd / "first"
            second = cwd / "second"
            first.mkdir()
            second.mkdir()
            for directory in (first, second):
                executable = directory / "codex-acp"
                executable.write_text("#!/bin/sh\nexit 0\n")
                executable.chmod(0o700)
            resolved = execution_config.resolve_run_execution(
                backend="acp", acp_agent="codex", environment={"PATH": str(first)}
            )
            snapshot = execution_config.snapshot_attempt(
                {"execution_json": __import__("json").dumps(resolved)}
            )

        self.assertEqual(str((first / "codex-acp").resolve()), snapshot["command"])
        self.assertEqual("codex-acp", snapshot["requested_command"])
        self.assertNotEqual(str((second / "codex-acp").resolve()), snapshot["command"])
        self.assertEqual("1.1.7", snapshot["profile_version"])
        self.assertEqual("@agentclientprotocol/codex-acp", snapshot["package"])
        self.assertEqual([], snapshot["args"])

    def test_builtin_profiles_declare_sandbox_and_missing_behavior(self):
        for name in ("claude", "codex", "gemini"):
            sandbox = registry.resolve_profile(name)["sandbox"]
            self.assertIn("mechanism", sandbox)
            self.assertEqual("fail_closed", sandbox["missing_behavior"])

    def test_builtin_acp_profile_supplies_backend_specific_default_models(self):
        with isolated_runtime() as (_, cwd):
            with mock.patch("backends.acp.registry.shutil.which", return_value=sys.executable):
                identity = agent_orchestrator.initialize_run(
                    "root", str(cwd), backend="acp", acp_agent="codex"
                )
            with state_store.transaction() as con:
                run = state_store.get_run(identity["root_id"], con)
                insert_ready_child(con, run)
            child = scheduler.schedule(identity["root_id"])[0]
            snapshot = __import__("json").loads(
                state_store.get_execution(child["attempt_id"])["config_json"]
            )

        self.assertEqual("gpt-5.6-terra", snapshot["model"])

    def test_doctor_reports_execution_fencing_and_process_facts(self):
        with isolated_runtime() as (_, cwd):
            identity = agent_orchestrator.initialize_run(
                "root",
                str(cwd),
                backend="acp",
                acp_agent="custom",
                acp_command=__import__("sys").executable,
                acp_args=["fake-agent.py"],
            )
            with state_store.transaction() as con:
                run = state_store.get_run(identity["root_id"], con)
                insert_ready_child(con, run)
            child = scheduler.schedule(identity["root_id"])[0]

            report = recovery.doctor(identity["root_id"])

        self.assertEqual("acp", report["backend_preflight"]["backend"])
        self.assertEqual("custom", report["backend_preflight"]["agent"])
        self.assertTrue(report["backend_preflight"]["available"])
        self.assertEqual(
            "Agent-specific authentication",
            report["backend_preflight"]["auth_prerequisites"][0],
        )
        self.assertEqual(1, len(report["executions"]))
        execution = report["executions"][0]
        self.assertEqual(child["attempt_id"], execution["attempt_id"])
        self.assertEqual(1, execution["generation"])
        self.assertEqual("starting", execution["status"])
        self.assertFalse(execution["worker_alive"])
        self.assertFalse(execution["agent_alive"])
        self.assertFalse(execution["control_endpoint_exists"])
        self.assertEqual("skipped", report["hooks"]["status"])
        self.assertEqual("agent-specific", report["backend_preflight"]["sandbox"]["mechanism"])

    def test_doctor_rejects_stale_endpoint_without_fenced_handshake(self):
        with isolated_runtime() as (_, cwd):
            identity = agent_orchestrator.initialize_run(
                "root",
                str(cwd),
                backend="acp",
                acp_agent="custom",
                acp_command=sys.executable,
            )
            with state_store.transaction() as con:
                run = state_store.get_run(identity["root_id"], con)
                insert_ready_child(con, run)
            child = scheduler.schedule(identity["root_id"])[0]
            endpoint = cwd / "stale.sock"
            endpoint.write_text("not a socket")
            with state_store.transaction() as con:
                con.execute(
                    """UPDATE execution_sessions
                       SET owner_nonce='owned', worker_pid=?, agent_pid=?, control_endpoint=?
                       WHERE attempt_id=?""",
                    (os.getpid(), os.getpid(), str(endpoint), child["attempt_id"]),
                )

            with mock.patch(
                "backends.acp.processes.process_has_nonce", return_value=True
            ), mock.patch(
                "backends.acp.worker_protocol.control_request",
                side_effect=RuntimeError("stale endpoint"),
            ):
                report = recovery.doctor(identity["root_id"])

        self.assertFalse(report["healthy"])
        self.assertEqual([child["attempt_id"]], report["execution_conflicts"])
        diagnostic = report["executions"][0]
        self.assertFalse(diagnostic["control_handshake"]["ok"])
        self.assertEqual("stale endpoint", diagnostic["control_handshake"]["error"])
        self.assertTrue(diagnostic["worker_identity_matches"])
        self.assertTrue(diagnostic["agent_identity_matches"])
        self.assertIn("recent_rpc_error", diagnostic)
        self.assertIn("capabilities", diagnostic)

    def test_doctor_does_not_apply_acp_process_contract_to_live_claude_execution(self):
        class ClaudeView:
            def list_sessions(self, cwd=None):
                return [{"name": session_name, "job_id": "job-live", "status": "running"}]

        with isolated_runtime() as (_, cwd), mock.patch.object(
            agent_orchestrator.hook_manager, "ensure_project_hooks"
        ):
            identity = agent_orchestrator.initialize_run("root", str(cwd))
            with state_store.transaction() as con:
                run = state_store.get_run(identity["root_id"], con)
                insert_ready_child(con, run)
            child = scheduler.schedule(identity["root_id"])[0]
            agent = state_store.get_agent(child["agent_id"])
            session_name = agent["session_name"]
            with state_store.transaction() as con:
                con.execute(
                    "UPDATE agents SET state='evaluating', job_id='job-live', heartbeat_at=? WHERE agent_id=?",
                    (state_store.now(), child["agent_id"]),
                )
                con.execute(
                    "UPDATE execution_sessions SET status='running', ready_at=? WHERE attempt_id=?",
                    (state_store.now(), child["attempt_id"]),
                )
                con.execute(
                    "UPDATE side_effect_outbox SET status='completed' WHERE root_id=?",
                    (identity["root_id"],),
                )

            report = recovery.doctor(identity["root_id"], adapter=ClaudeView())

        self.assertEqual([], report["execution_conflicts"])
        self.assertTrue(report["healthy"], report)
        diagnostic = report["executions"][0]
        self.assertEqual("claude_cli", diagnostic["backend_id"])
        self.assertEqual("not_applicable", diagnostic["control_handshake"]["status"])

    def test_doctor_accepts_acp_starting_handshake_before_agent_popen(self):
        with isolated_runtime() as (_, cwd):
            identity = agent_orchestrator.initialize_run(
                "root",
                str(cwd),
                backend="acp",
                acp_agent="custom",
                acp_command=sys.executable,
            )
            with state_store.transaction() as con:
                run = state_store.get_run(identity["root_id"], con)
                insert_ready_child(con, run)
            child = scheduler.schedule(identity["root_id"])[0]
            endpoint = cwd / "starting.sock"
            endpoint.write_text("placeholder")
            with state_store.transaction() as con:
                execution = state_store.get_execution(child["attempt_id"], con)
                con.execute(
                    """UPDATE execution_sessions
                       SET owner_nonce='owned', worker_pid=?, agent_pid=NULL, control_endpoint=?
                       WHERE attempt_id=?""",
                    (os.getpid(), str(endpoint), child["attempt_id"]),
                )

            with mock.patch(
                "backends.acp.processes.process_has_nonce", return_value=True
            ), mock.patch(
                "backends.acp.worker_protocol.control_request",
                return_value={
                    "ok": True,
                    "execution_id": execution["execution_id"],
                    "generation": execution["generation"],
                    "worker_pid": os.getpid(),
                    "agent_pid": None,
                    "status": "starting",
                    "prompt_state": "pending",
                },
            ):
                report = recovery.doctor(identity["root_id"])

        self.assertEqual([], report["execution_conflicts"])
        self.assertTrue(report["executions"][0]["control_handshake"]["ok"])


if __name__ == "__main__":
    unittest.main()
