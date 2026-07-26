import ast
import asyncio
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from helpers import SCRIPTS_DIR
from backends.acp import dependencies


SKILL_DIR = pathlib.Path(__file__).resolve().parents[1]
CLIENT = SKILL_DIR / "scripts" / "backends" / "acp" / "client.py"
DEPENDENCIES = SKILL_DIR / "scripts" / "backends" / "acp" / "dependencies.py"


class Phase1SdkDependencyTests(unittest.TestCase):
    def _fake_sdk_install(self, command, **kwargs):
        target = pathlib.Path(command[command.index("--target") + 1])
        (target / "acp").mkdir(parents=True, exist_ok=True)
        (target / "acp" / "__init__.py").write_text("PROTOCOL_VERSION = 1\n")
        for name, version in dependencies.SDK_PACKAGES.items():
            metadata = target / (name.replace("-", "_") + "-%s.dist-info" % version)
            metadata.mkdir()
            (metadata / "METADATA").write_text(
                "Metadata-Version: 2.1\nName: %s\nVersion: %s\n" % (name, version)
            )

    def _fake_agent_install(self, command, **kwargs):
        target = pathlib.Path(command[command.index("--cwd") + 1])
        package, version = command[-1].rsplit("@", 1)
        command_by_package = {
            "@agentclientprotocol/codex-acp": "codex-acp",
            "@agentclientprotocol/claude-agent-acp": "claude-agent-acp",
        }
        package_dir = target / "node_modules" / pathlib.Path(*package.split("/"))
        package_dir.mkdir(parents=True, exist_ok=True)
        (package_dir / "package.json").write_text(
            json.dumps({"name": package, "version": version}) + "\n"
        )
        executable = target / "node_modules" / ".bin" / command_by_package[package]
        executable.parent.mkdir(parents=True, exist_ok=True)
        executable.write_text("#!/bin/sh\nexit 0\n")
        executable.chmod(0o700)

    def test_offline_bundle_and_builder_are_removed(self):
        self.assertFalse((SKILL_DIR / "assets" / "acp-runtime").exists())
        self.assertFalse((SKILL_DIR / "scripts" / "build_acp_runtime_bundle.py").exists())

    def test_sdk_and_transitive_versions_are_exactly_pinned(self):
        self.assertEqual(
            {
                "agent-client-protocol": "0.11.0",
                "annotated-types": "0.8.0",
                "pydantic": "2.13.4",
                "pydantic-core": "2.46.4",
                "typing-extensions": "4.16.0",
                "typing-inspection": "0.4.2",
            },
            dependencies.SDK_PACKAGES,
        )
        self.assertEqual(set(range(10, 15)), dependencies.SUPPORTED_MINORS)

    def test_first_use_installs_once_and_reuses_managed_sdk(self):
        original_path = list(sys.path)
        original_acp_modules = {
            name: module
            for name, module in sys.modules.items()
            if name == "acp" or name.startswith("acp.")
        }
        for name in original_acp_modules:
            sys.modules.pop(name, None)
        try:
            with tempfile.TemporaryDirectory() as temporary, mock.patch.object(
                dependencies, "_run_install", side_effect=self._fake_sdk_install
            ) as installer:
                environment = {"PATH": "", "HOME": temporary}
                first = dependencies.activate(cache_root=temporary, environment=environment)
                second = dependencies.activate(cache_root=temporary, environment=environment)
        finally:
            for name in tuple(sys.modules):
                if name == "acp" or name.startswith("acp."):
                    sys.modules.pop(name, None)
            sys.modules.update(original_acp_modules)
            sys.path[:] = original_path

        self.assertTrue(first["installed"])
        self.assertFalse(second["installed"])
        self.assertEqual("managed", first["source"])
        self.assertEqual(1, installer.call_count)

    def test_invalid_managed_cache_is_reinstalled_atomically(self):
        original_path = list(sys.path)
        original_acp_modules = {
            name: module
            for name, module in sys.modules.items()
            if name == "acp" or name.startswith("acp.")
        }
        for name in original_acp_modules:
            sys.modules.pop(name, None)
        try:
            with tempfile.TemporaryDirectory() as temporary:
                status = dependencies.sdk_status(
                    cache_root=temporary, environment={"PATH": ""}
                )
                target = pathlib.Path(status["target"])
                target.mkdir(parents=True)
                (target / dependencies.MARKER_NAME).write_text("{}\n")
                with mock.patch.object(
                    dependencies, "_run_install", side_effect=self._fake_sdk_install
                ) as installer:
                    result = dependencies.activate(
                        cache_root=temporary, environment={"PATH": ""}
                    )
        finally:
            for name in tuple(sys.modules):
                if name == "acp" or name.startswith("acp."):
                    sys.modules.pop(name, None)
            sys.modules.update(original_acp_modules)
            sys.path[:] = original_path

        self.assertTrue(result["installed"])
        self.assertEqual(1, installer.call_count)

    def test_first_use_installs_codex_and_claude_agents_once_with_bun(self):
        from backends.acp import registry

        with tempfile.TemporaryDirectory() as temporary, mock.patch.object(
            dependencies.shutil,
            "which",
            side_effect=lambda name, path=None: "/tools/bun" if name == "bun" else None,
        ), mock.patch.object(
            dependencies, "_run_install", side_effect=self._fake_agent_install
        ) as installer:
            environment = {"PATH": "/tools", "HOME": temporary}
            codex = dependencies.install_agent(
                registry.resolve_profile("codex"), environment=environment
            )
            claude = dependencies.install_agent(
                registry.resolve_profile("claude"), environment=environment
            )
            reused = dependencies.install_agent(
                registry.resolve_profile("codex"), environment=environment
            )

            managed_root = (
                pathlib.Path(temporary)
                / ".agents-orchestrator"
                / "dependencies"
                / "agents"
            )
            self.assertTrue(
                pathlib.Path(codex["command"]).resolve().is_relative_to(
                    managed_root.resolve()
                )
            )
            self.assertTrue(
                pathlib.Path(claude["command"]).resolve().is_relative_to(
                    managed_root.resolve()
                )
            )
            self.assertEqual(codex["command"], reused["command"])

        self.assertEqual(2, installer.call_count)
        self.assertTrue(
            all(call.args[0][0] == "/tools/bun" for call in installer.call_args_list)
        )
        self.assertEqual(
            "@agentclientprotocol/codex-acp@1.1.7",
            codex["managed_install"]["requirement"],
        )
        self.assertEqual(
            "@agentclientprotocol/claude-agent-acp@0.62.0",
            claude["managed_install"]["requirement"],
        )

    def test_runtime_dependency_loader_has_pinned_installer_surface(self):
        source = DEPENDENCIES.read_text(encoding="utf-8")
        self.assertIn("SDK_REQUIREMENTS", source)
        self.assertIn("subprocess.run", source)
        self.assertIn('shutil.which("uv"', source)
        self.assertIn('shutil.which("bun"', source)
        self.assertNotIn("latest", source)
        self.assertNotIn("shell=True", source)

    def test_clean_python_loads_managed_sdk_without_site_packages(self):
        dependency_home = os.environ["AGENTS_ORCHESTRATOR_DEPENDENCY_HOME"]
        with tempfile.TemporaryDirectory() as home:
            script = """
import json, os, sys
sys.path.insert(0, %r)
os.environ['AGENTS_ORCHESTRATOR_DEPENDENCY_HOME'] = %r
os.environ['AGENT_SWARM_DEPENDENCY_HOME'] = %r
from backends.acp.registry import ensure_sdk_available
result = ensure_sdk_available()
import acp
print(json.dumps({'version': result['version'], 'source': result['source'], 'protocol': acp.PROTOCOL_VERSION}))
""" % (str(SCRIPTS_DIR), dependency_home, dependency_home)
            environment = dict(os.environ)
            environment["HOME"] = home
            completed = subprocess.run(
                [sys.executable, "-S", "-c", script],
                text=True,
                capture_output=True,
                check=False,
                timeout=30,
                env=environment,
            )

        self.assertEqual(0, completed.returncode, completed.stderr)
        self.assertEqual(
            {"version": "0.11.0", "source": "managed", "protocol": 1},
            json.loads(completed.stdout),
        )

    def test_failed_install_leaves_no_partial_target(self):
        with tempfile.TemporaryDirectory() as temporary, mock.patch.object(
            dependencies,
            "_run_install",
            side_effect=RuntimeError("automatic install failed"),
        ):
            with self.assertRaisesRegex(RuntimeError, "automatic install failed"):
                dependencies.activate(cache_root=temporary, environment={"PATH": ""})
            root = pathlib.Path(temporary) / "python"
            self.assertFalse(any(path.name.startswith("acp-sdk-") for path in root.iterdir()))

    def test_wrong_sdk_version_fails_fast_with_cache_instruction(self):
        from backends.acp import registry

        with mock.patch.object(
            registry.dependencies,
            "activate",
            return_value={
                "packages": {"agent-client-protocol": "0.10.0"},
                "source": "managed",
                "installed": False,
                "installer": "uv",
                "runtime_key": "test",
                "target": "/tmp/test",
            },
        ), mock.patch.object(
            registry.importlib.util, "find_spec", return_value=object()
        ):
            with self.assertRaisesRegex(
                RuntimeError,
                r"version 0\.10\.0 is unsupported; clear the dependency cache",
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
