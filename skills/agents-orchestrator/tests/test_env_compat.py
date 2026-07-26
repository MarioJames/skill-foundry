import os
import pathlib
import tempfile
import unittest
from unittest import mock

from helpers import SCRIPTS_DIR  # noqa: F401

import compat_env
import execution_config
import state_store


IDENTITY = {
    "ROOT_ID": "root_test",
    "TASK_ID": "7",
    "ATTEMPT_ID": "9",
    "ACTOR_TOKEN": "token",
}


def family(prefix, values=IDENTITY):
    return {prefix + suffix: value for suffix, value in values.items()}


class EnvironmentCompatibilityTests(unittest.TestCase):
    def test_canonical_only_legacy_only_and_equal_dual_identity(self):
        canonical = family(compat_env.CANONICAL_PREFIX)
        legacy = family(compat_env.LEGACY_PREFIX)

        self.assertEqual(IDENTITY, compat_env.validate_identity(canonical))
        self.assertEqual(IDENTITY, compat_env.validate_identity(legacy))
        self.assertEqual(
            IDENTITY,
            compat_env.validate_identity({**canonical, **legacy}),
        )

    def test_conflicting_or_partial_identity_fails_closed(self):
        conflict = {
            **family(compat_env.CANONICAL_PREFIX),
            **family(compat_env.LEGACY_PREFIX),
        }
        conflict["AGENT_SWARM_TASK_ID"] = "different"
        with self.assertRaisesRegex(ValueError, "conflicting orchestration"):
            compat_env.validate_identity(conflict)

        with self.assertRaisesRegex(ValueError, "partial orchestration identity"):
            compat_env.validate_identity(
                {"AGENTS_ORCHESTRATOR_ROOT_ID": "root_test"}
            )

    def test_canonical_configuration_is_primary_with_legacy_fallback(self):
        canonical = execution_config.resolve_run_execution(
            environment={
                "PATH": "",
                "AGENTS_ORCHESTRATOR_BACKEND": "acp",
                "AGENTS_ORCHESTRATOR_ACP_AGENT": "codex",
            }
        )
        legacy = execution_config.resolve_run_execution(
            environment={
                "PATH": "",
                "AGENT_SWARM_BACKEND": "acp",
                "AGENT_SWARM_ACP_AGENT": "codex",
            }
        )
        self.assertEqual("codex", canonical["default_profile"])
        self.assertEqual("codex", legacy["default_profile"])

        with self.assertRaisesRegex(ValueError, "conflicting orchestration"):
            execution_config.resolve_run_execution(
                environment={
                    "PATH": "",
                    "AGENTS_ORCHESTRATOR_BACKEND": "acp",
                    "AGENT_SWARM_BACKEND": "claude_cli",
                }
            )

    def test_runtime_home_and_sqlite_helper_preserve_existing_layout(self):
        with tempfile.TemporaryDirectory() as temporary:
            expected = pathlib.Path(temporary).resolve()
            canonical = {"AGENTS_ORCHESTRATOR_HOME": temporary}
            legacy = {"AGENT_SWARM_HOME": temporary}
            self.assertEqual(expected, compat_env.runtime_home(canonical))
            self.assertEqual(expected, compat_env.runtime_home(legacy))
            self.assertEqual(
                expected / "runtime.sqlite3",
                compat_env.runtime_sqlite_path(canonical),
            )

    def test_state_store_uses_canonical_home_with_strict_legacy_compatibility(self):
        with tempfile.TemporaryDirectory() as temporary:
            canonical_home = str(pathlib.Path(temporary) / "canonical")
            legacy_home = str(pathlib.Path(temporary) / "legacy")
            with mock.patch.dict(
                os.environ,
                {"AGENTS_ORCHESTRATOR_HOME": canonical_home},
                clear=True,
            ):
                self.assertEqual(
                    pathlib.Path(canonical_home).resolve(),
                    state_store.runtime_root(),
                )
            with mock.patch.dict(
                os.environ,
                {"AGENT_SWARM_HOME": legacy_home},
                clear=True,
            ):
                self.assertEqual(
                    pathlib.Path(legacy_home).resolve(),
                    state_store.runtime_root(),
                )
            with mock.patch.dict(
                os.environ,
                {
                    "AGENTS_ORCHESTRATOR_HOME": canonical_home,
                    "AGENT_SWARM_HOME": canonical_home,
                },
                clear=True,
            ):
                self.assertEqual(
                    pathlib.Path(canonical_home).resolve(),
                    state_store.runtime_root(),
                )
            with mock.patch.dict(
                os.environ,
                {
                    "AGENTS_ORCHESTRATOR_HOME": canonical_home,
                    "AGENT_SWARM_HOME": legacy_home,
                },
                clear=True,
            ):
                with self.assertRaisesRegex(ValueError, "conflicting orchestration"):
                    state_store.runtime_root()

    def test_process_boundary_scrubs_parent_identity_and_exports_both_families(self):
        parent_values = {
            "ROOT_ID": "parent",
            "TASK_ID": "1",
            "ATTEMPT_ID": "2",
            "ACTOR_TOKEN": "parent-token",
        }
        parent = {
            **family(compat_env.CANONICAL_PREFIX, parent_values),
            **family(compat_env.LEGACY_PREFIX, parent_values),
            "AGENTS_ORCHESTRATOR_AGENT_ID": "stale-agent",
            "AGENT_SWARM_EXECUTION_NONCE": "stale-nonce",
        }
        child = {
            **IDENTITY,
            "HOME": "/tmp/runtime-home",
            "SKILL_DIR": "/tmp/skill",
        }
        with mock.patch.dict(os.environ, parent, clear=False):
            with compat_env.process_boundary(child):
                for suffix, expected in child.items():
                    self.assertEqual(
                        expected,
                        os.environ["AGENTS_ORCHESTRATOR_" + suffix],
                    )
                    self.assertEqual(
                        expected,
                        os.environ["AGENT_SWARM_" + suffix],
                    )
                self.assertNotIn("AGENTS_ORCHESTRATOR_AGENT_ID", os.environ)
                self.assertNotIn("AGENT_SWARM_EXECUTION_NONCE", os.environ)


if __name__ == "__main__":
    unittest.main()
