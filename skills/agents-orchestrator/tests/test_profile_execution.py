import json
import os
import pathlib
import tempfile
import unittest
from unittest import mock

from helpers import insert_ready_child, isolated_runtime

import agent_orchestrator
import execution_config
import model_policy
import scheduler
import state_store
from backends.acp import registry


def executable(directory, name):
    path = pathlib.Path(directory) / name
    path.write_text("#!/bin/sh\nexit 0\n")
    path.chmod(0o700)
    return path


class ProfileExecutionTests(unittest.TestCase):
    def test_codex_acp_is_the_default_and_freezes_pinned_profile(self):
        execution = execution_config.resolve_run_execution(
            environment={"PATH": ""}
        )
        attempt = execution_config.snapshot_attempt(
            {"execution_config_json": json.dumps(execution)},
            model_tier="strong",
        )

        self.assertEqual("acp", execution["backend"])
        self.assertEqual("codex", execution["default_profile"])
        self.assertEqual(["codex"], execution["profile_allowlist"])
        self.assertEqual("codex", attempt["agent"])
        self.assertEqual("gpt-5.6-sol", attempt["model"])
        self.assertEqual("1.1.7", attempt["profile_version"])
        self.assertEqual("allow_all", attempt["permission_policy"])

        explicit_claude = execution_config.resolve_run_execution(
            acp_agent="claude",
            environment={"PATH": ""},
        )
        self.assertEqual("claude", explicit_claude["default_profile"])
        self.assertEqual(["claude"], explicit_claude["profile_allowlist"])

    def test_first_acp_init_prepares_sdk_codex_and_claude_dependencies(self):
        with mock.patch.object(
            registry, "ensure_sdk_available", return_value={"version": "0.11.0"}
        ) as sdk, mock.patch.object(
            registry, "install_default_profiles", return_value={}
        ) as defaults, mock.patch.object(
            registry, "install_profile", side_effect=lambda profile, environment=None: profile
        ):
            execution = execution_config.resolve_run_execution(
                environment={"PATH": "", "HOME": "/tmp/test-home"},
                install_dependencies=True,
            )

        sdk.assert_called_once()
        defaults.assert_called_once()
        self.assertEqual("codex", execution["default_profile"])
        self.assertEqual(["codex"], execution["profile_allowlist"])

    def test_entry_mode_aliases_normalize_to_runtime_mode_kinds(self):
        cases = {
            "swarm": "swarm",
            "loop": "develop_review_improve",
            "develop-review-improve": "develop_review_improve",
            "develop_review_improve": "develop_review_improve",
            "review": "multi_session_review",
            "multi-session-review": "multi_session_review",
            "multi_session_review": "multi_session_review",
        }
        for entry_mode, expected in cases.items():
            with self.subTest(entry_mode=entry_mode):
                self.assertEqual(
                    expected,
                    agent_orchestrator._entry_mode(entry_mode, environment={}),
                )

        with self.assertRaisesRegex(ValueError, "swarm, loop, or review"):
            agent_orchestrator._entry_mode("unknown", environment={})

    def test_canonical_cli_exposes_frozen_profiles_entry_mode_and_hint_schema(self):
        parsed = agent_orchestrator.build_parser().parse_args(
            [
                "init",
                "--task",
                "profiled",
                "--cwd",
                "/tmp",
                "--profile-allowlist-json",
                '["claude","codex"]',
                "--default-profile",
                "codex",
                "--entry-mode",
                "loop",
            ]
        )
        self.assertEqual('["claude","codex"]', parsed.profile_allowlist_json)
        self.assertEqual("codex", parsed.default_profile)
        self.assertEqual("loop", parsed.entry_mode)
        constraints = agent_orchestrator.ACTION_SCHEMAS["create_tasks"]["properties"][
            "tasks"
        ]["items"]["properties"]["constraints"]["properties"]
        self.assertEqual(
            {"type": "string", "minLength": 1}, constraints["profile_hint"]
        )

        with isolated_runtime() as (_, cwd):
            binaries = cwd / "bin"
            binaries.mkdir()
            executable(binaries, "codex-acp")
            executable(binaries, "claude-agent-acp")
            with mock.patch.dict(
                os.environ,
                {"PATH": str(binaries)},
                clear=False,
            ):
                identity = agent_orchestrator.initialize_run(
                    "profiled",
                    str(cwd),
                    profile_allowlist=["claude", "codex"],
                    default_profile="codex",
                    entry_mode="loop",
                )
            execution = json.loads(
                state_store.get_run(identity["root_id"])["execution_config_json"]
            )
            self.assertEqual("develop_review_improve", identity["entry_mode"])
            self.assertEqual("develop_review_improve", execution["entry_mode"])
            self.assertEqual(["claude", "codex"], execution["profile_allowlist"])

    def test_missing_default_executable_keeps_exact_pinned_failure_hint(self):
        execution = execution_config.resolve_run_execution(
            environment={"PATH": ""}
        )
        with self.assertRaisesRegex(
            RuntimeError,
            "bun add -g @agentclientprotocol/codex-acp@1.1.7",
        ):
            registry.ensure_available(
                execution["profiles"]["codex"],
                environment={"PATH": ""},
            )

    def test_allowlisted_profiles_are_frozen_and_hint_cannot_inject_command(self):
        with tempfile.TemporaryDirectory() as temporary:
            codex = executable(temporary, "codex-acp")
            claude = executable(temporary, "claude-agent-acp")
            execution = execution_config.resolve_run_execution(
                profile_allowlist=["claude", "codex"],
                default_profile="codex",
                environment={"PATH": temporary},
            )
            run = {"execution_config_json": json.dumps(execution)}

            hinted = execution_config.snapshot_attempt(
                run,
                profile_hint="claude",
                model_tier="balanced",
            )
            routed = execution_config.snapshot_attempt(
                run,
                routing_index=0,
                model_tier="fast",
            )
            task = {
                "constraints_json": json.dumps(
                    {
                        "profile_hint": "claude",
                        "command": "/tmp/injected-agent",
                        "args": ["--injected"],
                    }
                )
            }
            selected = model_policy.select_profile(run, task)
            frozen = execution_config.snapshot_attempt(
                run,
                profile_hint=selected,
                model_tier="fast",
            )

        self.assertEqual(str(claude), hinted["command"])
        self.assertEqual("sonnet", hinted["model"])
        self.assertEqual(str(codex), routed["command"])
        self.assertEqual("gpt-5.6-luna", routed["model"])
        self.assertEqual(str(claude), frozen["command"])
        self.assertEqual([], frozen["args"])
        self.assertNotEqual("/tmp/injected-agent", frozen["command"])

        with self.assertRaisesRegex(ValueError, "profile allowlist"):
            execution_config.snapshot_attempt(
                run,
                profile_hint="gemini",
                model_tier="fast",
            )

    def test_scheduler_round_robins_frozen_allowlisted_profiles(self):
        with isolated_runtime() as (_, cwd):
            identity = agent_orchestrator.initialize_run("root", str(cwd))
            binaries = cwd / "bin"
            binaries.mkdir()
            executable(binaries, "codex-acp")
            executable(binaries, "claude-agent-acp")
            execution = execution_config.resolve_run_execution(
                profile_allowlist=["claude", "codex"],
                default_profile="codex",
                environment={"PATH": str(binaries)},
            )
            with state_store.transaction() as con:
                con.execute(
                    "UPDATE runs SET execution_config_json=? WHERE root_id=?",
                    (json.dumps(execution, sort_keys=True), identity["root_id"]),
                )
                run = state_store.get_run(identity["root_id"], con)
                insert_ready_child(con, run)
                insert_ready_child(con, run)

            children = scheduler.schedule(identity["root_id"])
            attempts = [
                state_store.get_attempt(child["attempt_id"])
                for child in children
            ]
            configs = [json.loads(attempt["config_json"]) for attempt in attempts]
            launches = [
                state_store.get_launch(child["launch_id"])
                for child in children
            ]

        self.assertEqual(["codex", "claude"], [item["agent"] for item in configs])
        self.assertEqual(
            ["gpt-5.6-terra", "sonnet"],
            [item["model"] for item in configs],
        )
        self.assertTrue(
            all(
                launch["session_name"].startswith("agents-orchestrator-")
                for launch in launches
            )
        )

    def test_missing_execution_config_recovers_as_explicit_legacy_backend(self):
        attempt = execution_config.snapshot_attempt({}, model="sonnet")
        self.assertEqual("claude_cli", attempt["backend"])
        self.assertEqual("claude", attempt["agent"])
        self.assertEqual("sonnet", attempt["model"])

        persisted = execution_config.snapshot_attempt(
            {
                "execution_config_json": json.dumps(
                    {
                        "backend": "claude_cli",
                        "claude_cli": {"command": "/frozen/legacy-claude"},
                    }
                )
            },
            model="opus",
        )
        self.assertEqual("claude_cli", persisted["backend"])
        self.assertEqual("/frozen/legacy-claude", persisted["command"])
        self.assertEqual("opus", persisted["model"])


if __name__ == "__main__":
    unittest.main()
