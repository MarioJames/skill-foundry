import asyncio
import json
import pathlib
import os
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from helpers import SCRIPTS_DIR


FAKE_AGENT = pathlib.Path(__file__).resolve().parent / "fixtures" / "fake_acp_agent.py"


class Phase1PermissionTests(unittest.TestCase):
    def test_allow_in_workspace_selects_offered_allow_only_for_proven_locations(self):
        from backends.acp.permissions import decide_permission

        workspace = "/tmp/workspace"
        options = [
            {"optionId": "allow", "kind": "allow_once"},
            {"optionId": "deny", "kind": "reject_once"},
        ]
        inside = decide_permission(
            {"toolCall": {"locations": [{"path": "/tmp/workspace/src/a.py"}]}, "options": options},
            policy="allow_in_workspace",
            cwd=workspace,
        )
        outside = decide_permission(
            {"toolCall": {"locations": [{"path": "/tmp/outside/a.py"}]}, "options": options},
            policy="allow_in_workspace",
            cwd=workspace,
        )
        unknown = decide_permission(
            {"toolCall": {"title": "opaque"}, "options": options},
            policy="allow_in_workspace",
            cwd=workspace,
        )

        self.assertEqual("allow", inside.selected_option_id)
        self.assertEqual("deny", outside.selected_option_id)
        self.assertEqual("deny", unknown.selected_option_id)

    def test_allow_in_workspace_allows_only_exact_runtime_cli_commands_without_locations(self):
        from backends.acp.permissions import decide_permission

        workspace = "/tmp/workspace"
        entrypoint = "/opt/agent-swarm/scripts/agent_orchestrator.py"
        options = [
            {"optionId": "persistent", "kind": "allow_always"},
            {"optionId": "approved", "kind": "allow_once"},
            {"optionId": "abort", "kind": "reject_once"},
        ]

        def request(script):
            return {
                "toolCall": {
                    "kind": "execute",
                    "rawInput": {
                        "command": ["/bin/zsh", "-lc", script],
                        "cwd": workspace,
                    },
                },
                "options": options,
            }

        bootstrap = decide_permission(
            request(
                'python3 "$AGENT_SWARM_SKILL_DIR/scripts/agent_orchestrator.py" '
                "bootstrap-cwd"
            ),
            policy="allow_in_workspace",
            cwd=workspace,
            runtime_entrypoint=entrypoint,
        )
        action = decide_permission(
            request(
                "printf '%s' "
                "'{\"revision\":false,\"strategy\":\"direct\"}' | "
                'python3 "$AGENT_SWARM_SKILL_DIR/scripts/agent_orchestrator.py" '
                "action --type submit_estimate --stdin"
            ),
            policy="allow_in_workspace",
            cwd=workspace,
            runtime_entrypoint=entrypoint,
        )
        schema = decide_permission(
            request(
                'python3 "$AGENT_SWARM_SKILL_DIR/scripts/agent_orchestrator.py" '
                "action-schema finish"
            ),
            policy="allow_in_workspace",
            cwd=workspace,
            runtime_entrypoint=entrypoint,
        )

        self.assertEqual("approved", bootstrap.selected_option_id)
        self.assertEqual("approved", action.selected_option_id)
        self.assertEqual("approved", schema.selected_option_id)

        no_once = request(
            'python3 "$AGENT_SWARM_SKILL_DIR/scripts/agent_orchestrator.py" '
            "bootstrap-cwd"
        )
        no_once["options"] = [
            {"optionId": "persistent", "kind": "allow_always"},
            {"optionId": "abort", "kind": "reject_once"},
        ]
        denied = decide_permission(
            no_once,
            policy="allow_in_workspace",
            cwd=workspace,
            runtime_entrypoint=entrypoint,
        )
        self.assertEqual("abort", denied.selected_option_id)

    def test_allow_in_workspace_accepts_canonical_runtime_cli_entrypoint(self):
        from backends.acp.permissions import decide_permission

        decision = decide_permission(
            {
                "toolCall": {
                    "kind": "execute",
                    "rawInput": {
                        "cwd": "/tmp/workspace",
                        "command": [
                            "/bin/sh",
                            "-c",
                            (
                                'python3 "$AGENTS_ORCHESTRATOR_SKILL_DIR/'
                                'scripts/agent_orchestrator.py" bootstrap-cwd'
                            ),
                        ],
                    },
                },
                "options": [
                    {"optionId": "once", "kind": "allow_once"},
                    {"optionId": "deny", "kind": "deny_once"},
                ],
            },
            policy="allow_in_workspace",
            cwd="/tmp/workspace",
            runtime_entrypoint=(
                "/opt/agents-orchestrator/scripts/agent_orchestrator.py"
            ),
        )

        self.assertTrue(decision.allowed)
        self.assertEqual("once", decision.selected_option_id)

    def test_runtime_cli_schema_allowlist_matches_real_cli_contract(self):
        completed = subprocess.run(
            [
                sys.executable,
                str(SCRIPTS_DIR / "agent_orchestrator.py"),
                "action-schema",
                "finish",
            ],
            text=True,
            capture_output=True,
            check=False,
        )

        self.assertEqual(0, completed.returncode, completed.stderr)
        self.assertEqual("finish", json.loads(completed.stdout)["title"])

    def test_runtime_cli_exception_rejects_shell_injection_wrong_cwd_and_unknown_commands(self):
        from backends.acp.permissions import decide_permission

        workspace = "/tmp/workspace"
        entrypoint = "/opt/agent-swarm/scripts/agent_orchestrator.py"
        options = [
            {"optionId": "approved", "kind": "allow_once"},
            {"optionId": "abort", "kind": "reject_once"},
        ]

        def decide(script, request_cwd=workspace, locations=None, shell="/bin/zsh"):
            tool_call = {
                "kind": "execute",
                "rawInput": {
                    "command": [shell, "-lc", script],
                    "cwd": request_cwd,
                },
            }
            if locations is not None:
                tool_call["locations"] = locations
            return decide_permission(
                {
                    "toolCall": tool_call,
                    "options": options,
                },
                policy="allow_in_workspace",
                cwd=workspace,
                runtime_entrypoint=entrypoint,
            ).selected_option_id

        runtime = 'python3 "$AGENT_SWARM_SKILL_DIR/scripts/agent_orchestrator.py"'
        rejected = [
            decide(runtime + " bootstrap-cwd; touch /tmp/escaped"),
            decide(runtime + " action-schema\nid"),
            decide("touch safe.txt | " + runtime + " bootstrap-cwd"),
            decide(
                "printf '%s' "
                "\"{\\\"revision\\\":false,\\\"note\\\":\\\"$(touch /tmp/escaped)\\\"}\" | "
                + runtime
                + " action --type submit_estimate --stdin"
            ),
            decide("python3 /tmp/agent_orchestrator.py bootstrap-cwd"),
            decide(runtime + " doctor"),
            decide(runtime + " bootstrap-cwd", "/tmp/outside"),
            decide(runtime + " bootstrap-cwd", shell="/tmp/zsh"),
            decide(
                runtime + " bootstrap-cwd",
                locations=[{"path": "/tmp/outside/runtime-v2.sqlite3"}],
            ),
        ]

        self.assertEqual(["abort"] * len(rejected), rejected)

    def test_allow_all_and_deny_all_still_choose_only_offered_options(self):
        from backends.acp.permissions import decide_permission

        options = [
            {"optionId": "yes", "kind": "allow_once"},
            {"optionId": "no", "kind": "reject_once"},
        ]
        self.assertEqual(
            "yes",
            decide_permission(
                {"options": options}, policy="allow_all", cwd="/tmp"
            ).selected_option_id,
        )
        self.assertEqual(
            "no",
            decide_permission(
                {"options": options}, policy="deny_all", cwd="/tmp"
            ).selected_option_id,
        )

    def test_permission_audit_classifies_opaque_selected_option_id(self):
        from backends.acp.permissions import selected_option_allows

        params = {
            "options": [
                {"optionId": "choice-1", "kind": "allow_once"},
                {"optionId": "choice-2", "kind": "reject_once"},
            ]
        }
        self.assertTrue(selected_option_allows(params, "choice-1"))
        self.assertFalse(selected_option_allows(params, "choice-2"))

    def test_session_config_selects_only_advertised_model_and_safe_mode(self):
        from backends.acp.session_config import configure_session

        class Client:
            def __init__(self):
                self.calls = []

            async def set_config_option(self, session_id, config_id, value):
                self.calls.append((session_id, config_id, value))
                return {"configOptions": []}

        options = [
            {
                "id": "mode",
                "category": "mode",
                "currentValue": "bypassPermissions",
                "options": [
                    {"value": "default", "name": "Manual"},
                    {"value": "bypassPermissions", "name": "Bypass"},
                ],
            },
            {
                "id": "model",
                "category": "model",
                "currentValue": "default",
                "options": [
                    {"value": "default", "name": "Default"},
                    {"value": "sonnet", "name": "Sonnet"},
                ],
            },
        ]
        client = Client()
        configured = asyncio.run(
            configure_session(
                client,
                "session-1",
                options,
                model="sonnet",
                permission_policy="allow_in_workspace",
            )
        )
        self.assertEqual(
            [("session-1", "model", "sonnet"), ("session-1", "mode", "default")],
            client.calls,
        )
        self.assertEqual("sonnet", configured["model"])
        self.assertEqual("default", configured["mode"])

    def test_session_config_rejects_unadvertised_explicit_model(self):
        from backends.acp.session_config import configure_session

        with self.assertRaisesRegex(RuntimeError, "not offered"):
            asyncio.run(
                configure_session(
                    mock.Mock(),
                    "session-1",
                    [
                        {
                            "id": "model",
                            "category": "model",
                            "currentValue": "gpt-safe",
                            "options": [{"value": "gpt-safe", "name": "Safe"}],
                        }
                    ],
                    model="gpt-unknown",
                    permission_policy="deny_all",
                )
            )

    def test_session_config_rejects_advertised_bypass_only_mode_for_workspace_policy(self):
        from backends.acp.session_config import configure_session

        with self.assertRaisesRegex(RuntimeError, "safe mode"):
            asyncio.run(
                configure_session(
                    mock.Mock(),
                    "session-1",
                    [
                        {
                            "id": "mode",
                            "category": "mode",
                            "currentValue": "bypassPermissions",
                            "options": [
                                {"value": "bypassPermissions", "name": "Bypass"}
                            ],
                        }
                    ],
                    model="default",
                    permission_policy="allow_in_workspace",
                )
            )

    def test_session_config_supports_official_codex_acp_modes(self):
        from backends.acp.session_config import configure_session

        class Client:
            def __init__(self):
                self.calls = []

            async def set_config_option(self, session_id, config_id, value):
                self.calls.append((session_id, config_id, value))
                return {"configOptions": []}

        options = [
            {
                "id": "mode",
                "category": "mode",
                "currentValue": "agent-full-access",
                "options": [
                    {"value": "read-only", "name": "Read-only"},
                    {"value": "agent", "name": "Agent"},
                    {"value": "agent-full-access", "name": "Agent (full access)"},
                ],
            },
            {
                "id": "model",
                "category": "model",
                "currentValue": "gpt-current",
                "options": [{"value": "gpt-current", "name": "Current"}],
            },
        ]

        workspace_client = Client()
        workspace = asyncio.run(
            configure_session(
                workspace_client,
                "session-workspace",
                options,
                model="default",
                permission_policy="allow_in_workspace",
            )
        )
        self.assertEqual(
            [("session-workspace", "mode", "agent")], workspace_client.calls
        )
        self.assertEqual("gpt-current", workspace["model"])
        self.assertEqual("agent", workspace["mode"])

        full_access_client = Client()
        full_access = asyncio.run(
            configure_session(
                full_access_client,
                "session-full-access",
                options,
                model="default",
                permission_policy="allow_all",
            )
        )
        self.assertEqual([], full_access_client.calls)
        self.assertEqual("agent-full-access", full_access["mode"])

    def test_session_config_selects_claude_bypass_permissions_for_allow_all(self):
        from backends.acp.session_config import configure_session

        class Client:
            def __init__(self):
                self.calls = []

            async def set_config_option(self, session_id, config_id, value):
                self.calls.append((session_id, config_id, value))
                return {"configOptions": []}

        options = [
            {
                "id": "mode",
                "category": "mode",
                "currentValue": "default",
                "options": [
                    {"value": "default", "name": "Default"},
                    {"value": "bypassPermissions", "name": "Bypass permissions"},
                ],
            }
        ]
        client = Client()

        configured = asyncio.run(
            configure_session(
                client,
                "session-claude",
                options,
                model="default",
                permission_policy="allow_all",
            )
        )

        self.assertEqual(
            [("session-claude", "mode", "bypassPermissions")], client.calls
        )
        self.assertEqual("bypassPermissions", configured["mode"])


class Phase1AcpClientTests(unittest.TestCase):
    def test_official_sdk_cancels_pending_prompt_and_closes_session(self):
        from acp import PROTOCOL_VERSION, text_block
        from backends.acp.client import AgentSwarmClient, connect_agent
        from backends.acp.permissions import PermissionDecision

        async def exercise():
            process = await asyncio.create_subprocess_exec(
                sys.executable,
                str(FAKE_AGENT),
                "--scenario",
                "hold",
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            connection = connect_agent(
                AgentSwarmClient(
                    permission_handler=lambda request: PermissionDecision(None, False)
                ),
                process.stdin,
                process.stdout,
            )
            try:
                await connection.initialize(protocol_version=PROTOCOL_VERSION)
                session = await connection.new_session(cwd="/tmp", mcp_servers=[])
                prompt = asyncio.create_task(
                    connection.prompt(
                        session_id=session.session_id,
                        prompt=[text_block("wait")],
                    )
                )
                await asyncio.sleep(0.05)
                await connection.cancel(session_id=session.session_id)
                result = await asyncio.wait_for(prompt, timeout=2)
                closed = await asyncio.wait_for(
                    connection.close_session(session_id=session.session_id), timeout=2
                )
                return result, closed
            finally:
                await connection.close()
                if process.returncode is None:
                    process.terminate()
                await asyncio.wait_for(process.wait(), timeout=2)

        result, closed = asyncio.run(exercise())
        self.assertEqual("cancelled", result.stop_reason)
        self.assertIsNotNone(closed)

    def test_control_endpoint_hashes_long_identity_path_below_unix_limit(self):
        from backends.acp.worker_protocol import endpoint_path

        with tempfile.TemporaryDirectory(
            prefix="agent-swarm-control-path-", dir="/tmp"
        ) as temporary:
            endpoint = endpoint_path(
                pathlib.Path(temporary) / ("runtime-" + "x" * 8),
                "root_" + "r" * 64,
                12,
            )

            self.assertLessEqual(len(os.fsencode(str(endpoint))), 100)
            self.assertEqual(0o700, endpoint.parent.stat().st_mode & 0o777)
            self.assertEqual(".s", endpoint.parent.name)

    def test_control_endpoint_falls_back_for_long_runtime_root(self):
        from backends.acp.worker_protocol import ControlServer, endpoint_path

        endpoint = None
        with tempfile.TemporaryDirectory(
            prefix="agent-swarm-long-runtime-root-", dir="/tmp"
        ) as temporary:
            runtime_root = pathlib.Path(temporary) / ("nested-" + "x" * 90)
            endpoint = endpoint_path(
                runtime_root,
                "root_runtime_fallback",
                1,
            )
            self.assertLessEqual(len(os.fsencode(str(endpoint))), 100)
            self.assertFalse(str(endpoint).startswith(str(runtime_root)))
            self.assertEqual(0o700, endpoint.parent.stat().st_mode & 0o777)

            server = ControlServer(endpoint, lambda request: {"ok": True})
            server.start()
            server.close()
            self.assertFalse(endpoint.exists())

        if endpoint is not None:
            try:
                endpoint.parent.rmdir()
            except OSError:
                pass

    def test_closing_one_fallback_socket_keeps_shared_parent_for_pending_bind(self):
        from backends.acp.worker_protocol import ControlServer, endpoint_path

        server_a = None
        server_b = None
        endpoint_a = None
        endpoint_b = None
        try:
            with tempfile.TemporaryDirectory(
                prefix="agent-swarm-shared-control-parent-", dir="/tmp"
            ) as temporary:
                runtime_prefix = pathlib.Path(temporary) / ("nested-" + "x" * 90)
                endpoint_a = endpoint_path(
                    runtime_prefix / "runtime-a",
                    "root_shared_parent_a",
                    1,
                )
                endpoint_b = endpoint_path(
                    runtime_prefix / "runtime-b",
                    "root_shared_parent_b",
                    1,
                )
                self.assertNotEqual(endpoint_a, endpoint_b)
                self.assertEqual(endpoint_a.parent, endpoint_b.parent)

                server_a = ControlServer(endpoint_a, lambda request: {"ok": True})
                server_a.start()
                server_a.close()

                self.assertTrue(endpoint_b.parent.is_dir())
                server_b = ControlServer(endpoint_b, lambda request: {"ok": True})
                server_b.start()
                server_b.close()
                self.assertFalse(endpoint_b.exists())
        finally:
            for server in (server_b, server_a):
                if server is not None:
                    server.close()
            for endpoint in (endpoint_b, endpoint_a):
                if endpoint is None:
                    continue
                try:
                    endpoint.unlink()
                except FileNotFoundError:
                    pass
            if endpoint_a is not None:
                try:
                    endpoint_a.parent.rmdir()
                except OSError:
                    pass

    def test_official_sdk_initializes_creates_session_prompts_and_closes(self):
        from acp import PROTOCOL_VERSION, text_block
        from acp.schema import ClientCapabilities, Implementation, PromptResponse
        from backends.acp.client import AgentSwarmClient, connect_agent
        from backends.acp.permissions import PermissionDecision

        async def exercise():
            process = await asyncio.create_subprocess_exec(
                sys.executable,
                str(FAKE_AGENT),
                "--scenario",
                "basic",
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            client = AgentSwarmClient(
                permission_handler=lambda request: PermissionDecision(None, False)
            )
            connection = connect_agent(client, process.stdin, process.stdout)
            try:
                initialized = await asyncio.wait_for(
                    connection.initialize(
                        protocol_version=PROTOCOL_VERSION,
                        client_capabilities=ClientCapabilities(),
                        client_info=Implementation(
                            name="agent-swarm-test", version="1"
                        ),
                    ),
                    timeout=2,
                )
                session = await asyncio.wait_for(
                    connection.new_session(cwd="/tmp", mcp_servers=[]), timeout=2
                )
                prompt = await asyncio.wait_for(
                    connection.prompt(
                        session_id=session.session_id,
                        prompt=[text_block("hello")],
                    ),
                    timeout=2,
                )
                closed = await asyncio.wait_for(
                    connection.close_session(session_id=session.session_id), timeout=2
                )
                return initialized, session, prompt, closed
            finally:
                await connection.close()
                if process.returncode is None:
                    process.terminate()
                await asyncio.wait_for(process.wait(), timeout=2)

        initialized, session, prompt, closed = asyncio.run(exercise())
        self.assertEqual(PROTOCOL_VERSION, initialized.protocol_version)
        self.assertTrue(session.session_id.startswith("fake-session-standalone-"))
        self.assertIsInstance(prompt, PromptResponse)
        self.assertEqual("end_turn", prompt.stop_reason)
        self.assertIsNotNone(closed)

    def test_client_handles_permission_callback_while_prompt_is_pending(self):
        from acp import PROTOCOL_VERSION, text_block
        from backends.acp.client import AgentSwarmClient, connect_agent
        from backends.acp.permissions import decide_permission

        decisions = []

        async def exercise():
            process = await asyncio.create_subprocess_exec(
                sys.executable,
                str(FAKE_AGENT),
                "--scenario",
                "permission",
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd="/tmp",
            )

            def permission(request):
                decision = decide_permission(
                    request, policy="allow_in_workspace", cwd="/tmp"
                )
                decisions.append(decision)
                return decision

            connection = connect_agent(
                AgentSwarmClient(permission_handler=permission),
                process.stdin,
                process.stdout,
            )
            try:
                await connection.initialize(protocol_version=PROTOCOL_VERSION)
                session = await connection.new_session(cwd="/tmp", mcp_servers=[])
                return await asyncio.wait_for(
                    connection.prompt(
                        session_id=session.session_id,
                        prompt=[text_block("hello")],
                    ),
                    timeout=2,
                )
            finally:
                await connection.close()
                if process.returncode is None:
                    process.terminate()
                await asyncio.wait_for(process.wait(), timeout=2)

        result = asyncio.run(exercise())
        self.assertEqual("end_turn", result.stop_reason)
        self.assertEqual("allow-once", decisions[0].selected_option_id)


if __name__ == "__main__":
    unittest.main()
