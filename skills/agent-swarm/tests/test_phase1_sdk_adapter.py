import ast
import asyncio
import hashlib
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest
import zipfile
from unittest import mock

from helpers import SCRIPTS_DIR


SKILL_DIR = pathlib.Path(__file__).resolve().parents[1]
CLIENT = SKILL_DIR / "scripts" / "backends" / "acp" / "client.py"
MANIFEST = SKILL_DIR / "assets" / "acp-runtime" / "manifest.json"
DEPENDENCIES = SKILL_DIR / "scripts" / "backends" / "acp" / "dependencies.py"


class Phase1SdkDependencyTests(unittest.TestCase):
    def test_bundled_sdk_and_transitive_versions_are_exactly_pinned(self):
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))

        self.assertEqual("0.11.0", manifest["packages"]["agent-client-protocol"])
        self.assertEqual("2.13.4", manifest["packages"]["pydantic"])
        self.assertEqual("2.46.4", manifest["packages"]["pydantic-core"])
        self.assertEqual({"minimum": "3.10", "maximum": "3.14"}, manifest["python"])
        expected = {
            "cp3%s-%s" % (minor, target)
            for minor in ("10", "11", "12", "13", "14")
            for target in (
                "macos-arm64",
                "macos-x86_64",
                "linux-gnu-arm64",
                "linux-gnu-x86_64",
                "linux-musl-arm64",
                "linux-musl-x86_64",
            )
        }
        self.assertEqual(expected, set(manifest["native"]))

    def test_every_bundled_archive_matches_manifest_digest(self):
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
        entries = [manifest["pure"], *manifest["native"].values()]
        for entry in entries:
            with self.subTest(file=entry["file"]):
                path = MANIFEST.parent / entry["file"]
                self.assertEqual(entry["sha256"], hashlib.sha256(path.read_bytes()).hexdigest())

    def test_bundle_contains_official_schema_and_matching_native_abis(self):
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
        with zipfile.ZipFile(MANIFEST.parent / manifest["pure"]["file"]) as archive:
            names = set(archive.namelist())
        self.assertIn("acp/schema.py", names)
        self.assertTrue(any(name.endswith(".dist-info/METADATA") for name in names))
        self.assertFalse(any("_pydantic_core" in name for name in names))

        for key, entry in manifest["native"].items():
            with self.subTest(key=key), zipfile.ZipFile(
                MANIFEST.parent / entry["file"]
            ) as archive:
                extensions = [
                    name
                    for name in archive.namelist()
                    if "/_pydantic_core.cpython-" in name and name.endswith(".so")
                ]
                self.assertEqual(1, len(extensions))
                self.assertIn(key[2:5], extensions[0])

    def test_runtime_bundle_loader_has_no_installer_or_network_surface(self):
        source = DEPENDENCIES.read_text(encoding="utf-8")
        tree = ast.parse(source)
        imported = {
            alias.name.split(".")[0]
            for node in ast.walk(tree)
            if isinstance(node, (ast.Import, ast.ImportFrom))
            for alias in node.names
        }
        self.assertTrue(
            {"subprocess", "urllib", "http", "requests"}.isdisjoint(imported)
        )
        self.assertNotIn("pip install", source)
        self.assertNotIn("uv pip", source)

    def test_clean_python_uses_bundle_without_site_packages_or_install(self):
        with tempfile.TemporaryDirectory() as cache:
            script = """
import json, os, sys
sys.path.insert(0, %r)
os.environ['AGENT_SWARM_ACP_BUNDLE_CACHE'] = %r
from backends.acp.registry import ensure_sdk_available
result = ensure_sdk_available()
import acp
print(json.dumps({'version': result['version'], 'source': result['source'], 'protocol': acp.PROTOCOL_VERSION}))
""" % (str(SCRIPTS_DIR), cache)
            completed = subprocess.run(
                [sys.executable, "-S", "-c", script],
                text=True,
                capture_output=True,
                check=False,
                timeout=30,
            )

        self.assertEqual(0, completed.returncode, completed.stderr)
        self.assertEqual(
            {"version": "0.11.0", "source": "bundled", "protocol": 1},
            json.loads(completed.stdout),
        )

    def test_corrupt_bundle_fails_fast_with_reinstall_instruction(self):
        from backends.acp import dependencies

        with mock.patch.object(dependencies, "_digest", return_value="corrupt"):
            with self.assertRaisesRegex(RuntimeError, "reinstall the agent-swarm skill"):
                dependencies.activate()

    def test_wrong_sdk_version_fails_fast_with_reinstall_instruction(self):
        from backends.acp import registry

        with mock.patch.object(
            registry.importlib.util, "find_spec", return_value=object()
        ), mock.patch.object(
            registry.importlib.metadata, "version", return_value="0.10.0"
        ):
            with self.assertRaisesRegex(
                RuntimeError,
                r"version 0\.10\.0 is unsupported; reinstall the agent-swarm skill",
            ):
                registry.ensure_sdk_available()

    def test_persisted_error_reason_never_contains_agent_exception_text(self):
        from backends.acp.worker import _safe_acp_error

        secret = "actor-token-must-not-persist"
        reason = _safe_acp_error(RuntimeError(secret))

        self.assertEqual("acp_error:RuntimeError", reason)
        self.assertNotIn(secret, reason)

    def test_client_module_contains_no_protocol_implementation(self):
        source = CLIENT.read_text(encoding="utf-8")
        tree = ast.parse(source)
        imported = {
            alias.name.split(".")[0]
            for node in ast.walk(tree)
            if isinstance(node, (ast.Import, ast.ImportFrom))
            for alias in node.names
        }
        self.assertTrue({"queue", "threading", "itertools", "json"}.isdisjoint(imported))
        self.assertNotIn("PendingRequest", source)
        self.assertNotIn("_read_loop", source)
        self.assertNotIn("request_id", source)
        self.assertNotIn("jsonrpc", source.lower())


class Phase1SdkCallbackAdapterTests(unittest.TestCase):
    def test_official_callback_preserves_allow_workspace_and_deny_policy_choices(self):
        from acp.schema import (
            AllowedOutcome,
            PermissionOption,
            ToolCallLocation,
            ToolCallUpdate,
        )
        from backends.acp.client import AgentSwarmClient
        from backends.acp.permissions import decide_permission

        options = [
            PermissionOption(option_id="allow", name="Allow", kind="allow_once"),
            PermissionOption(option_id="deny", name="Deny", kind="reject_once"),
        ]

        async def choose(policy, path):
            client = AgentSwarmClient(
                permission_handler=lambda request: decide_permission(
                    request, policy=policy, cwd="/tmp/workspace"
                )
            )
            return await client.request_permission(
                session_id="session-1",
                tool_call=ToolCallUpdate(
                    tool_call_id="call-1",
                    title="write",
                    kind="edit",
                    locations=[ToolCallLocation(path=path)],
                ),
                options=options,
            )

        cases = (
            ("allow_all", "/tmp/outside.txt", "allow"),
            ("allow_in_workspace", "/tmp/workspace/inside.txt", "allow"),
            ("allow_in_workspace", "/tmp/outside.txt", "deny"),
            ("deny_all", "/tmp/workspace/inside.txt", "deny"),
        )
        for policy, path, expected in cases:
            with self.subTest(policy=policy, path=path):
                response = asyncio.run(choose(policy, path))
                self.assertIsInstance(response.outcome, AllowedOutcome)
                self.assertEqual(expected, response.outcome.option_id)

    def test_typed_permission_and_session_update_callbacks(self):
        from acp.schema import (
            AgentMessageChunk,
            AllowedOutcome,
            PermissionOption,
            TextContentBlock,
            ToolCallUpdate,
        )
        from backends.acp.client import AgentSwarmClient
        from backends.acp.permissions import PermissionDecision

        permission_calls = []
        updates = []

        def decide(request):
            permission_calls.append(request)
            return PermissionDecision(selected_option_id="allow", allowed=True)

        client = AgentSwarmClient(
            permission_handler=decide,
            session_update_handler=lambda session_id, update: updates.append(
                (session_id, update)
            ),
        )
        response = asyncio.run(
            client.request_permission(
                session_id="session-1",
                tool_call=ToolCallUpdate(
                    tool_call_id="call-1",
                    title="write",
                    kind="edit",
                ),
                options=[
                    PermissionOption(
                        option_id="allow", name="Allow", kind="allow_once"
                    ),
                    PermissionOption(
                        option_id="deny", name="Deny", kind="reject_once"
                    ),
                ],
            )
        )
        self.assertIsInstance(response.outcome, AllowedOutcome)
        self.assertEqual("allow", response.outcome.option_id)
        self.assertEqual("session-1", permission_calls[0].session_id)

        update = AgentMessageChunk(
            session_update="agent_message_chunk",
            content=TextContentBlock(type="text", text="hello"),
        )
        asyncio.run(client.session_update("session-1", update))
        self.assertEqual([("session-1", update)], updates)

    def test_cancelled_business_decision_becomes_typed_outcome(self):
        from acp.schema import DeniedOutcome, PermissionOption, ToolCallUpdate
        from backends.acp.client import AgentSwarmClient
        from backends.acp.permissions import PermissionDecision

        client = AgentSwarmClient(
            permission_handler=lambda request: PermissionDecision(
                selected_option_id=None, allowed=False
            )
        )
        response = asyncio.run(
            client.request_permission(
                session_id="session-1",
                tool_call=ToolCallUpdate(tool_call_id="call-1"),
                options=[
                    PermissionOption(
                        option_id="deny", name="Deny", kind="reject_once"
                    )
                ],
            )
        )
        self.assertIsInstance(response.outcome, DeniedOutcome)

    def test_unsupported_callbacks_and_extensions_fail_closed(self):
        from acp import RequestError
        from backends.acp.client import AgentSwarmClient

        client = AgentSwarmClient(permission_handler=lambda request: None)
        calls = [
            client.write_text_file("s", "/tmp/a", "x"),
            client.read_text_file("s", "/tmp/a"),
            client.create_terminal("s", "echo"),
            client.create_elicitation("message", mock.Mock()),
            client.ext_method("unknown", {}),
            client.ext_notification("unknown", {}),
        ]
        for call in calls:
            with self.subTest(call=call):
                with self.assertRaises(RequestError) as caught:
                    asyncio.run(call)
                self.assertEqual(-32601, caught.exception.code)


if __name__ == "__main__":
    unittest.main()
