import importlib.util
import pathlib
import tempfile
import unittest
from unittest import mock


HARNESS = pathlib.Path(__file__).resolve().parent / "manual_real_acp.py"
SPEC = importlib.util.spec_from_file_location("manual_real_acp", HARNESS)
manual_real_acp = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(manual_real_acp)


class Phase1ManualHarnessTests(unittest.TestCase):
    def test_real_matrix_includes_adapter_crash_and_task_tree_modes(self):
        self.assertIn("agent-crash", manual_real_acp.GOALS)
        self.assertIn("orchestration", manual_real_acp.GOALS)

    def test_token_residue_reports_only_files_containing_plaintext_token(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            (root / "safe.log").write_text("safe")
            (root / "unsafe.log").write_text("prefix-secret-token-suffix")

            residue = manual_real_acp.token_residue(root, ["secret-token"])

        self.assertEqual(["unsafe.log"], residue)

    def test_official_codex_agent_mode_is_safe_workspace_evidence(self):
        self.assertTrue(
            manual_real_acp.has_safe_workspace_mode(
                [{"configured": {"mode": "agent"}}]
            )
        )

    def test_full_access_modes_are_write_capable_evidence(self):
        for mode in ("agent-full-access", "bypassPermissions", "full-access"):
            with self.subTest(mode=mode):
                self.assertTrue(
                    manual_real_acp.has_write_capable_mode(
                        [{"configured": {"mode": mode}}]
                    )
                )

    def test_permission_deny_distinguishes_callback_from_native_sandbox(self):
        callback = manual_real_acp.classify_permission_deny(
            outside_exists=False,
            permission_events=[{"allowed": False}],
            safe_workspace_mode=True,
        )
        native = manual_real_acp.classify_permission_deny(
            outside_exists=False,
            permission_events=[],
            safe_workspace_mode=True,
        )

        self.assertEqual("acp_callback_deny", callback["evidence"])
        self.assertTrue(callback["acp_permission_callback_passed"])
        self.assertEqual("native_sandbox_deny", native["evidence"])
        self.assertFalse(native["acp_permission_callback_passed"])

    def test_bounded_cleanup_attempts_runtime_stop_even_after_failure(self):
        identity = {"root_id": "root_test", "actor_token": "secret"}
        with mock.patch.object(
            manual_real_acp.recovery,
            "stop_run",
            return_value={"status": "cancelled"},
        ) as stop, mock.patch.object(
            manual_real_acp.state_store, "list_launches", return_value=[]
        ):
            result = manual_real_acp.bounded_cleanup(identity)

        self.assertEqual({"status": "cancelled"}, result["stop"])
        self.assertIsNone(result["error"])
        stop.assert_called_once_with("root_test", "secret")


if __name__ == "__main__":
    unittest.main()
