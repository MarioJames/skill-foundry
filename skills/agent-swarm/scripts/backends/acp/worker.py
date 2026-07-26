#!/usr/bin/env python3
"""Detached supervisor owning one ACP Agent process and one ACP Session."""

import argparse
import asyncio
import contextlib
import json
import os
import pathlib
import sys
import threading
import time


SCRIPTS_DIR = pathlib.Path(__file__).resolve().parents[2]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import execution_secrets
import execution_state
import prompt_builder
import state_store
from backends.acp.client import AgentSwarmClient, connect_agent
from backends.acp.permissions import decide_permission
from backends.acp.processes import terminate_process_group
from backends.acp.registry import ensure_available, ensure_sdk_available
from backends.acp.session_config import configure_session
from backends.acp.worker_protocol import ControlServer, endpoint_path


IDENTITY_ENV = {
    "AGENT_SWARM_ROOT_ID",
    "AGENT_SWARM_TASK_ID",
    "AGENT_SWARM_ATTEMPT_ID",
    "AGENT_SWARM_ACTOR_TOKEN",
    "AGENT_SWARM_HOME",
    "AGENT_SWARM_SKILL_DIR",
}


def _safe_acp_error(exc):
    """Persist only structural error facts; Agent text may contain secrets."""
    code = getattr(exc, "code", None)
    reason = "acp_error:%s" % type(exc).__name__
    return "%s:code=%s" % (reason, code) if isinstance(code, int) else reason


class Worker:
    def __init__(self, launch_id, candidate_nonce):
        self.launch_id = int(launch_id)
        launch = state_store.get_launch(self.launch_id)
        if launch is None:
            raise RuntimeError("launch record not found")
        self.attempt_id = launch["attempt_id"]
        self.candidate_nonce = candidate_nonce
        self.stop_event = threading.Event()
        self.cleanup_event = threading.Event()
        self.cleanup_succeeded = False
        self.control = None
        self.agent = None
        self.connection = None
        self.session_id = None
        self.capabilities = {}
        self.protocol_version = 1
        self.configured = {}
        self.prompt_pending = False
        self.exit_reason = "worker_exit"
        self._heartbeat_thread = None
        self._log_lock = threading.Lock()
        self._log_file = None
        self._prompt_task = None
        self._prompt_dispatched = None

    def _context(self):
        with state_store.transaction(immediate=False) as con:
            launch = state_store.get_launch(self.launch_id, con)
            attempt = state_store.get_attempt(self.attempt_id, con)
            task = state_store.get_task(attempt["task_id"], con) if attempt else None
            run = state_store.get_run(launch["root_id"], con) if launch else None
            if not all((run, task, attempt, launch)):
                raise RuntimeError("launch identity is incomplete")
            return run, task, attempt, launch

    def _open_log(self, root_id):
        path = (
            state_store.runtime_root()
            / "logs"
            / root_id
            / "acp"
            / ("launch-%d.ndjson" % self.launch_id)
        )
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        descriptor = os.open(
            str(path), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600
        )
        self._log_file = os.fdopen(descriptor, "a", encoding="utf-8")

    def _log(self, event, **fields):
        if self._log_file is None:
            return
        safe = {"event": event, "at": state_store.now(), **fields}
        with self._log_lock:
            self._log_file.write(
                json.dumps(safe, ensure_ascii=False, sort_keys=True) + "\n"
            )
            self._log_file.flush()

    def _stream_event(self, event):
        message = event.message
        method = message.get("method")
        self._log(
            "rpc",
            direction=event.direction.value,
            method=method,
            response=("result" in message or "error" in message),
            error_code=(message.get("error") or {}).get("code"),
        )
        if (
            self._prompt_dispatched is not None
            and event.direction.value == "outgoing"
            and method == "session/prompt"
        ):
            self._prompt_dispatched.set()

    def _session_update(self, session_id, update):
        self._log(
            "session_update",
            session_id=session_id,
            update_type=getattr(update, "session_update", type(update).__name__),
        )

    def _permission(self, request):
        run, _, _, launch = self._context()
        config = json.loads(launch["config_json"])
        decision = decide_permission(
            request,
            policy=config.get("permission_policy") or "allow_in_workspace",
            cwd=run["cwd"],
            runtime_entrypoint=str(SCRIPTS_DIR / "agent_orchestrator.py"),
        )
        with state_store.transaction() as con:
            state_store.append_event(
                con,
                run["root_id"],
                "AcpPermissionDecision",
                {
                    "selected": decision.selected_option_id,
                    "allowed": decision.allowed,
                },
                attempt_id=self.attempt_id,
            )
        return decision

    def _control_request(self, request):
        if (
            int(request.get("launch_id", -1)) != self.launch_id
        ):
            return {"ok": False, "error": "launch fence mismatch"}
        command = request.get("command")
        if command in {"ping", "status"}:
            record = state_store.get_launch(self.launch_id)
            return {
                "ok": True,
                "launch_id": self.launch_id,
                "worker_pid": os.getpid(),
                "agent_pid": self.agent.pid if self.agent else record.get("agent_pid"),
                "prompt_state": record.get("prompt_state"),
                "status": record.get("status"),
            }
        if command == "stop":
            self.stop_event.set()
            self.cleanup_event.wait(timeout=float(request.get("timeout") or 8))
            return {
                "ok": True,
                "stopped": self.cleanup_event.is_set() and self.cleanup_succeeded,
            }
        return {"ok": False, "error": "unsupported control command"}

    def _heartbeat(self):
        while not self.cleanup_event.wait(0.5):
            record = state_store.get_launch(self.launch_id)
            if record is None or record.get("stop_requested_at") is not None:
                self.stop_event.set()
            execution_state.heartbeat(self.launch_id, self.candidate_nonce)

    def _attempt_terminal(self):
        attempt = state_store.get_attempt(self.attempt_id)
        return attempt is None or attempt["state"] not in {
            "assigned", "evaluating", "active", "waiting", "stopping"
        }

    async def _wait_operation(
        self, task, *, timeout_seconds=None, check_attempt=False
    ):
        deadline = (
            time.monotonic() + float(timeout_seconds)
            if timeout_seconds
            else None
        )
        while True:
            if self.stop_event.is_set():
                return None, "stopped"
            if check_attempt and self._attempt_terminal():
                await asyncio.sleep(0.25)
                return None, "attempt_terminal"
            if deadline is not None and time.monotonic() >= deadline:
                return None, "timeout"
            done, _ = await asyncio.wait({task}, timeout=0.1)
            if done:
                return task.result(), None

    def _record_prompt_end(self, root_id, result, reprompt):
        with state_store.transaction() as con:
            state_store.append_event(
                con,
                root_id,
                "PromptTurnEnded",
                {"stop_reason": result.stop_reason, "reprompt": reprompt},
                attempt_id=self.attempt_id,
            )

    async def _run_prompt_turns(self, run, config, bootstrap):
        from acp import text_block

        limit = int(config.get("turn_end_reprompt_limit", 1))
        text = bootstrap
        for reprompt in range(limit + 1):
            self._prompt_dispatched.clear()
            self._prompt_task = asyncio.create_task(
                self.connection.prompt(
                    session_id=self.session_id,
                    prompt=[text_block(text)],
                )
            )
            self.prompt_pending = True
            try:
                await asyncio.wait_for(self._prompt_dispatched.wait(), timeout=5)
            except asyncio.TimeoutError as exc:
                raise RuntimeError("official SDK did not dispatch session/prompt") from exc
            if reprompt == 0:
                if not execution_state.mark_ready(
                    self.launch_id,
                    self.candidate_nonce,
                    external_session_id=self.session_id,
                    protocol_version=self.protocol_version,
                    capabilities=self.capabilities,
                    profile_config=config,
                    cwd=run["cwd"],
                    mode=self.configured.get("mode"),
                    model=self.configured.get("model") or config.get("model"),
                ):
                    self.exit_reason = "ready_fence_rejected"
                    return
            result, interrupted = await self._wait_operation(
                self._prompt_task,
                timeout_seconds=config.get("prompt_timeout_seconds"),
                check_attempt=True,
            )
            self.prompt_pending = False
            if interrupted:
                self.exit_reason = (
                    "prompt_timeout" if interrupted == "timeout" else interrupted
                )
                return
            self._record_prompt_end(run["root_id"], result, reprompt)
            if self._attempt_terminal():
                self.exit_reason = "attempt_terminal"
                return
            if reprompt < limit:
                text = (
                    "The Runtime Attempt is still unfinished. Submit the required Runtime "
                    "finish(status=done|failed) Action now, or report failure through that Action."
                )
                continue
            self.exit_reason = "without_finish:%s" % result.stop_reason
            execution_state.record_turn_end(
                self.launch_id,
                self.candidate_nonce,
                self.exit_reason,
            )

    def run(self):
        claimed = state_store.claim_launch_ownership(
            self.launch_id, self.candidate_nonce, os.getpid()
        )
        if not claimed:
            return 3
        return asyncio.run(self._run_owned())

    async def _run_owned(self):
        run, task, attempt, launch = self._context()
        self._open_log(run["root_id"])
        endpoint = endpoint_path(
            state_store.runtime_root(),
            run["root_id"],
            self.launch_id,
        )
        self.control = ControlServer(endpoint, self._control_request)
        self.control.start()
        if not execution_state.register_control_endpoint(
            self.launch_id,
            self.candidate_nonce,
            str(endpoint),
        ):
            self.exit_reason = "control_endpoint_fence_rejected"
            await self._cleanup()
            return 4
        self._heartbeat_thread = threading.Thread(target=self._heartbeat, daemon=True)
        self._heartbeat_thread.start()
        config = json.loads(launch["config_json"])
        try:
            command = ensure_available(config)
            ensure_sdk_available()
        except RuntimeError as exc:
            self.exit_reason = str(exc)
            execution_state.record_turn_end(
                self.launch_id,
                self.candidate_nonce,
                self.exit_reason,
                error=True,
            )
            await self._cleanup()
            return 5

        token = execution_secrets.derive_attempt_token(run, attempt["attempt_id"])
        child_env = {
            key: value for key, value in os.environ.items() if key not in IDENTITY_ENV
        }
        child_env.update(
            {
                "AGENT_SWARM_ROOT_ID": run["root_id"],
                "AGENT_SWARM_TASK_ID": str(task["task_id"]),
                "AGENT_SWARM_ATTEMPT_ID": str(attempt["attempt_id"]),
                "AGENT_SWARM_ACTOR_TOKEN": token,
                "AGENT_SWARM_HOME": str(state_store.runtime_root()),
                "AGENT_SWARM_SKILL_DIR": str(SCRIPTS_DIR.parent),
            }
        )
        try:
            if self.stop_event.is_set() or not execution_state.ownership_is_live(
                self.launch_id, self.candidate_nonce
            ):
                self.exit_reason = "stopped_before_agent_popen"
                return 0
            self.agent = await asyncio.create_subprocess_exec(
                command,
                *list(config.get("args") or []),
                cwd=run["cwd"],
                env=child_env,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
                start_new_session=True,
            )
            if not execution_state.register_agent_process(
                self.launch_id,
                self.candidate_nonce,
                self.agent.pid,
            ) or not execution_state.ownership_is_live(
                self.launch_id, self.candidate_nonce
            ):
                self.exit_reason = "agent_popen_fence_rejected"
                return 6
            if self.agent.stdin is None or self.agent.stdout is None:
                raise RuntimeError("ACP Agent process did not expose stdio streams")

            callbacks = AgentSwarmClient(
                permission_handler=self._permission,
                session_update_handler=self._session_update,
            )
            self._prompt_dispatched = asyncio.Event()
            self.connection = connect_agent(
                callbacks,
                self.agent.stdin,
                self.agent.stdout,
                stream_observer=self._stream_event,
            )

            from acp import PROTOCOL_VERSION
            from acp.schema import ClientCapabilities, Implementation

            initialize_task = asyncio.create_task(
                self.connection.initialize(
                    protocol_version=PROTOCOL_VERSION,
                    client_capabilities=ClientCapabilities(),
                    client_info=Implementation(
                        name="agent-swarm",
                        title="Agent Swarm Runtime",
                        version="1",
                    ),
                )
            )
            initialized, interrupted = await self._wait_operation(
                initialize_task, timeout_seconds=30
            )
            if interrupted:
                self.exit_reason = (
                    "initialize_timeout"
                    if interrupted == "timeout"
                    else "stopped_during_initialize"
                )
                return 0
            if initialized.protocol_version != PROTOCOL_VERSION:
                raise RuntimeError(
                    "ACP agent did not negotiate protocolVersion=%s"
                    % PROTOCOL_VERSION
                )
            self.capabilities = (
                initialized.agent_capabilities.model_dump(
                    mode="json", by_alias=True, exclude_none=True
                )
                if initialized.agent_capabilities is not None
                else {}
            )
            self.protocol_version = PROTOCOL_VERSION
            auth_methods = [method.id for method in initialized.auth_methods or []]
            with state_store.transaction() as con:
                state_store.append_event(
                    con,
                    run["root_id"],
                    "AcpInitialized",
                    {
                        "protocol_version": PROTOCOL_VERSION,
                        "auth_methods": auth_methods,
                    },
                    attempt_id=self.attempt_id,
                )
            if self.stop_event.is_set() or not execution_state.ownership_is_live(
                self.launch_id, self.candidate_nonce
            ):
                self.exit_reason = "stopped_during_initialize"
                return 0

            session_task = asyncio.create_task(
                self.connection.new_session(cwd=run["cwd"], mcp_servers=[])
            )
            session, interrupted = await self._wait_operation(
                session_task, timeout_seconds=30
            )
            if interrupted:
                self.exit_reason = (
                    "session_new_timeout"
                    if interrupted == "timeout"
                    else "stopped_during_session_new"
                )
                return 0
            self.session_id = session.session_id
            configured = await configure_session(
                self.connection,
                self.session_id,
                session.config_options or [],
                model=config.get("model"),
                permission_policy=config.get("permission_policy")
                or "allow_in_workspace",
            )
            self.configured = dict(configured or {})
            with state_store.transaction() as con:
                state_store.append_event(
                    con,
                    run["root_id"],
                    "AcpSessionCreated",
                    {"session_id": self.session_id, "configured": configured},
                    attempt_id=self.attempt_id,
                )
            if self.stop_event.is_set() or not execution_state.ownership_is_live(
                self.launch_id, self.candidate_nonce
            ):
                self.exit_reason = "stopped_before_prompt"
                return 0
            bootstrap = prompt_builder.build_prompt(run, task, attempt)
            await self._run_prompt_turns(run, config, bootstrap)
            return 0
        except Exception as exc:
            self.exit_reason = _safe_acp_error(exc)
            if not self.stop_event.is_set() and not self._attempt_terminal():
                execution_state.record_turn_end(
                    self.launch_id,
                    self.candidate_nonce,
                    self.exit_reason,
                    error=True,
                )
            return 7
        finally:
            await self._cleanup()

    async def _cleanup(self):
        if self.cleanup_event.is_set():
            return
        self.stop_event.set()
        if self.connection is not None and self.session_id:
            if self.prompt_pending:
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(
                        self.connection.cancel(session_id=self.session_id), timeout=1
                    )
            session_capabilities = self.capabilities.get("sessionCapabilities") or {}
            if "close" in session_capabilities:
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(
                        self.connection.close_session(session_id=self.session_id),
                        timeout=1,
                    )
        if self.connection is not None:
            with contextlib.suppress(Exception):
                await self.connection.close()
        if self._prompt_task is not None and not self._prompt_task.done():
            self._prompt_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._prompt_task

        agent_clean = True
        if self.agent is not None:
            agent_clean = terminate_process_group(
                self.agent.pid, grace=0.5, trusted=True
            )
            with contextlib.suppress(Exception):
                await asyncio.wait_for(self.agent.wait(), timeout=1)
            if self.agent.stdin is not None:
                self.agent.stdin.close()
                with contextlib.suppress(Exception):
                    await self.agent.stdin.wait_closed()
        if self.control is not None:
            self.control.close()
        if agent_clean:
            execution_state.mark_closed(
                self.launch_id,
                self.candidate_nonce,
                self.exit_reason,
            )
            execution_secrets.cleanup_run_seed_if_safe(self._context()[0]["root_id"])
            self.cleanup_succeeded = True
        else:
            self.exit_reason = "process_group_cleanup_failed"
            execution_state.mark_cleanup_failed(
                self.launch_id,
                self.candidate_nonce,
                self.exit_reason,
            )
        self.cleanup_event.set()
        if self._log_file is not None:
            self._log("closed", reason=self.exit_reason)
            self._log_file.close()


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--launch-id", required=True, type=int)
    parser.add_argument("--candidate-nonce", required=True)
    args = parser.parse_args(argv)
    return Worker(args.launch_id, args.candidate_nonce).run()


if __name__ == "__main__":
    raise SystemExit(main())
