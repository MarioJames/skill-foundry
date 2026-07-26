import json
import os
import pathlib
import sys
import tempfile
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

    def test_freeze_profile_preserves_symlinked_executable_entrypoint(self):
        from backends.acp import registry

        with tempfile.TemporaryDirectory() as temporary:
            directory = pathlib.Path(temporary)
            target = directory / "python-real"
            target.write_text("#!/bin/sh\nexit 0\n")
            target.chmod(0o700)
            entrypoint = directory / "python-venv"
            entrypoint.symlink_to(target)

            frozen = registry.freeze_profile(
                registry.resolve_profile(
                    "custom", command=str(entrypoint), args=[]
                )
            )

            self.assertEqual(str(entrypoint), frozen["resolved_command"])
            self.assertEqual(str(entrypoint), registry.ensure_available(frozen))

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
                {"execution_config_json": __import__("json").dumps(resolved)}
            )

        self.assertEqual(str(first / "codex-acp"), snapshot["command"])
        self.assertEqual("codex-acp", snapshot["requested_command"])
        self.assertNotEqual(str(second / "codex-acp"), snapshot["command"])
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
                state_store.get_attempt(child["attempt_id"])["config_json"]
            )

        self.assertEqual("gpt-5.6-terra", snapshot["model"])

    def test_doctor_reports_attempt_launch_and_effect_facts(self):
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

        self.assertEqual("running", report["run_status"])
        self.assertEqual(child["launch_id"], report["open_launches"][0]["launch_id"])
        self.assertEqual("spawn_agent", report["pending_effects"][0]["effect_type"])

    def test_registry_preflight_reports_bundled_sdk_without_installing(self):
        profile = registry.freeze_profile(
            registry.resolve_profile("custom", command=sys.executable)
        )
        report = registry.preflight(profile)
        self.assertTrue(report["available"])
        self.assertEqual("bundled", report["sdk"]["source"])
        self.assertEqual("0.11.0", report["sdk"]["version"])


if __name__ == "__main__":
    unittest.main()
