#!/usr/bin/env python3
"""Deterministic test Agent implemented on the official ACP Python SDK."""

import argparse
import asyncio
import json
import os
import pathlib
import subprocess
import sys

SCRIPTS_DIR = pathlib.Path(__file__).resolve().parents[2] / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from backends.acp.dependencies import activate as activate_managed_sdk

activate_managed_sdk()

from acp import PROTOCOL_VERSION, RequestError, run_agent
from acp.schema import (
    AgentCapabilities,
    AgentAuthCapabilities,
    AllowedOutcome,
    CloseSessionResponse,
    AgentMessageChunk,
    Implementation,
    InitializeResponse,
    LoadSessionResponse,
    NewSessionResponse,
    PermissionOption,
    PromptResponse,
    SessionCapabilities,
    SessionCloseCapabilities,
    TextContentBlock,
    ToolCallLocation,
    ToolCallUpdate,
    UserMessageChunk,
)


def runtime_action(action_type, payload):
    skill_dir = os.environ["AGENT_SWARM_SKILL_DIR"]
    command = [
        sys.executable,
        os.path.join(skill_dir, "scripts", "agent_orchestrator.py"),
        "action",
        "--type",
        action_type,
        "--stdin",
    ]
    completed = subprocess.run(
        command,
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        env=os.environ.copy(),
        check=False,
        timeout=10,
    )
    if completed.returncode != 0:
        raise RuntimeError(
            completed.stderr or completed.stdout or "Runtime action failed"
        )
    return json.loads(completed.stdout)


class FakeAgent:
    def __init__(self, args):
        self.args = args
        self.client = None
        self.cancelled = asyncio.Event()

    def on_connect(self, connection):
        self.client = connection

    async def initialize(
        self,
        protocol_version,
        client_capabilities=None,
        client_info=None,
        **kwargs,
    ):
        await asyncio.sleep(self.args.initialize_delay)
        return InitializeResponse(
            protocol_version=PROTOCOL_VERSION,
            agent_capabilities=AgentCapabilities(
                load_session=self.args.scenario == "history",
                auth=AgentAuthCapabilities(),
                session_capabilities=SessionCapabilities(
                    close=SessionCloseCapabilities()
                ),
            ),
            agent_info=Implementation(
                name="fake-acp", title="Fake ACP", version="1.0.0"
            ),
        )

    async def new_session(
        self, cwd, additional_directories=None, mcp_servers=None, **kwargs
    ):
        await asyncio.sleep(self.args.session_delay)
        return NewSessionResponse(
            session_id="fake-session-%s-%s"
            % (os.environ.get("AGENT_SWARM_ATTEMPT_ID", "standalone"), os.getpid())
        )

    async def prompt(self, session_id, prompt, **kwargs):
        prompt_text = "\n".join(
            block.text for block in prompt if isinstance(block, TextContentBlock)
        )
        if self.args.prompt_file:
            pathlib.Path(self.args.prompt_file).write_text(
                prompt_text, encoding="utf-8"
            )
        if self.args.scenario == "hold":
            await self.cancelled.wait()
            return PromptResponse(stop_reason="cancelled")
        if self.args.scenario == "crash":
            os._exit(23)
        if self.args.scenario == "split":
            await asyncio.to_thread(self._finish_split, prompt_text)
            return PromptResponse(stop_reason="end_turn")
        if self.args.scenario == "finish":
            await asyncio.sleep(0.25)
            await asyncio.to_thread(self._finish_direct)
            return PromptResponse(stop_reason="end_turn")
        if self.args.scenario == "permission":
            if self.client is None:
                raise RuntimeError("fake Agent has no connected Client")
            response = await self.client.request_permission(
                session_id=session_id,
                tool_call=ToolCallUpdate(
                    tool_call_id="fake-call",
                    title="write",
                    kind="edit",
                    locations=[
                        ToolCallLocation(path=os.path.join(os.getcwd(), "inside.txt"))
                    ],
                ),
                options=[
                    PermissionOption(
                        option_id="allow-once",
                        name="Allow once",
                        kind="allow_once",
                    ),
                    PermissionOption(
                        option_id="deny-once",
                        name="Deny once",
                        kind="reject_once",
                    ),
                ],
            )
            if not isinstance(response.outcome, AllowedOutcome):
                raise RuntimeError("permission was denied")
            return PromptResponse(stop_reason="end_turn")
        return PromptResponse(stop_reason="end_turn")

    async def load_session(
        self, cwd, session_id, mcp_servers=None, additional_directories=None, **kwargs
    ):
        if self.args.scenario != "history":
            raise RequestError.method_not_found("session/load")
        if session_id == "missing-session":
            raise RequestError.resource_not_found(session_id)
        if self.client is None:
            raise RuntimeError("fake Agent has no connected Client")
        await self.client.session_update(
            session_id=session_id,
            update=UserMessageChunk.model_validate(
                {
                    "sessionUpdate": "user_message_chunk",
                    "content": {"type": "text", "text": "remembered user message"},
                    "messageId": "history-user",
                }
            ),
        )
        await self.client.session_update(
            session_id=session_id,
            update=AgentMessageChunk.model_validate(
                {
                    "sessionUpdate": "agent_message_chunk",
                    "content": {"type": "text", "text": "remembered agent response"},
                    "messageId": "history-agent",
                }
            ),
        )
        return LoadSessionResponse()

    async def cancel(self, session_id, **kwargs):
        self.cancelled.set()

    async def close_session(self, session_id, **kwargs):
        return CloseSessionResponse()

    async def ext_method(self, method, params):
        raise RequestError.method_not_found("_" + method)

    async def ext_notification(self, method, params):
        raise RequestError.method_not_found("_" + method)

    def _submit_estimate(self, strategy, complexity, reason):
        return runtime_action(
            "submit_estimate",
            {
                "revision": False,
                "strategy": strategy,
                "resolved_intent": "implement",
                "complexity": complexity,
                "concerns": [],
                "unknowns": [],
                "estimated_files": [],
                "reason": reason,
            },
        )

    def _finish(self, summary, integration=None):
        return runtime_action(
            "finish",
            {
                "status": "done",
                "retryable": False,
                "summary": summary,
                "changed_files": [],
                "artifacts": [],
                "validation": None,
                "review": None,
                "integration_check": integration,
                "caveats": [],
            },
        )

    def _finish_direct(self):
        self._submit_estimate("direct", "low", "deterministic fake task")
        self._finish("fake ACP child finished")

    def _finish_split(self, prompt_text):
        is_parent = "\nchild goal\n" in prompt_text
        self._submit_estimate(
            "split" if is_parent else "direct",
            "medium" if is_parent else "low",
            "deterministic fake split",
        )
        integration = None
        if is_parent:
            created = runtime_action(
                "create_tasks",
                {
                    "tasks": [
                        {
                            "key": "leaf-a",
                            "goal": "leaf-a",
                            "intent_hint": "implement",
                            "output_contract": "finish leaf a",
                        },
                        {
                            "key": "leaf-b",
                            "goal": "leaf-b",
                            "intent_hint": "implement",
                            "output_contract": "finish leaf b",
                        },
                    ]
                },
            )
            task_ids = [item["task_id"] for item in created["tasks"]]
            waited = runtime_action(
                "wait",
                {
                    "task_ids": task_ids,
                    "condition": "all_done",
                    "listen_seconds": 15,
                },
            )
            if not waited.get("complete"):
                raise RuntimeError("fake split children did not finish")
            integration = {
                "status": "passed",
                "summary": "fake leaves integrated",
            }
        self._finish("fake split task finished", integration)


async def async_main(args):
    if args.counter_file:
        path = pathlib.Path(args.counter_file)
        count = int(path.read_text()) if path.exists() else 0
        path.write_text(str(count + 1))
    await run_agent(FakeAgent(args), use_unstable_protocol=True)
    if args.scenario == "hold":
        while True:
            await asyncio.sleep(1)


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--scenario", default="basic")
    parser.add_argument("--counter-file")
    parser.add_argument("--prompt-file")
    parser.add_argument("--initialize-delay", type=float, default=0)
    parser.add_argument("--session-delay", type=float, default=0)
    args = parser.parse_args(argv)
    asyncio.run(async_main(args))


if __name__ == "__main__":
    main()
