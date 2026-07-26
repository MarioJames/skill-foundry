#!/usr/bin/env python3
"""Detached supervisor owning one ACP Agent process and one ACP Session."""

import argparse
import json
import os
import pathlib
import subprocess
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
from backends.acp.client import AcpClient
from backends.acp.permissions import decide_permission, selected_option_allows
from backends.acp.processes import pid_alive, terminate_process_group
from backends.acp.registry import ensure_available
from backends.acp.session_config import configure_session
from backends.acp.worker_protocol import ControlServer, endpoint_path


IDENTITY_ENV = {
    "AGENT_SWARM_ROOT_ID",
    "AGENT_SWARM_TASK_ID",
    "AGENT_SWARM_ATTEMPT_ID",
    "AGENT_SWARM_AGENT_ID",
    "AGENT_SWARM_ACTOR_TOKEN",
    "AGENT_SWARM_HOME",
    "AGENT_SWARM_SKILL_DIR",
}


class Worker:
    def __init__(self, attempt_id, generation, candidate_nonce):
        self.attempt_id = attempt_id
        self.generation = int(generation)
        self.candidate_nonce = candidate_nonce
        self.stop_event = threading.Event()
        self.cleanup_event = threading.Event()
        self.cleanup_succeeded = False
        self.control = None
        self.agent = None
        self.client = None
        self.session_id = None
        self.capabilities = {}
        self.prompt_pending = False
        self.exit_reason = "worker_exit"
        self._heartbeat_thread = None
        self._log_lock = threading.Lock()
        self._log_file = None

    def _context(self):
        with state_store.transaction(immediate=False) as con:
            execution = state_store.get_execution(self.attempt_id, con)
            if execution is None:
                raise RuntimeError("execution record not found")
            attempt = state_store.get_attempt(self.attempt_id, con)
            task = state_store.get_task(attempt["task_id"], con) if attempt else None
            agent = state_store.get_agent(attempt["agent_id"], con) if attempt else None
            run = state_store.get_run(execution["root_id"], con)
            if not all((run, task, attempt, agent)):
                raise RuntimeError("execution identity is incomplete")
            return run, task, attempt, agent, execution

    def _open_log(self, root_id):
        path = state_store.runtime_root() / "logs" / root_id / "acp" / (self.attempt_id + ".ndjson")
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        descriptor = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        self._log_file = os.fdopen(descriptor, "a", encoding="utf-8")

    def _log(self, event, **fields):
        if self._log_file is None:
            return
        safe = {"event": event, "at": state_store.now(), **fields}
        with self._log_lock:
            self._log_file.write(json.dumps(safe, ensure_ascii=False, sort_keys=True) + "\n")
            self._log_file.flush()

    def _rpc_event(self, message):
        self._log(
            "rpc",
            method=message.get("method"),
            id=message.get("id"),
            response=("result" in message or "error" in message),
            error_code=(message.get("error") or {}).get("code"),
        )

    def _permission(self, method, params):
        if method != "session/request_permission":
            raise RuntimeError("unsupported ACP Client method: %s" % method)
        run, _, _, _, execution = self._context()
        config = json.loads(execution["config_json"])
        decision = decide_permission(
            params,
            policy=config.get("permission_policy") or "allow_in_workspace",
            cwd=run["cwd"],
            runtime_entrypoint=str(SCRIPTS_DIR / "agent_orchestrator.py"),
        )
        selected = (decision.get("outcome") or {}).get("optionId")
        with state_store.transaction() as con:
            state_store.append_event(
                con,
                run["root_id"],
                "AcpPermissionDecision",
                {
                    "selected": selected,
                    "allowed": selected_option_allows(params, selected),
                },
                attempt_id=self.attempt_id,
            )
        return decision

    def _control_request(self, request):
        if request.get("execution_id") != self.execution_id or int(request.get("generation", -1)) != self.generation:
            return {"ok": False, "error": "execution fence mismatch"}
        command = request.get("command")
        if command in {"ping", "status"}:
            record = state_store.get_execution(self.attempt_id)
            return {
                "ok": True,
                "execution_id": self.execution_id,
                "generation": self.generation,
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
            record = state_store.get_execution(self.attempt_id)
            if record is None or record.get("stop_requested_at") is not None:
                self.stop_event.set()
            execution_state.heartbeat(self.attempt_id, self.generation, self.candidate_nonce)

    def _attempt_terminal(self):
        attempt = state_store.get_attempt(self.attempt_id)
        return attempt is None or attempt["status"] not in {"assigned", "running"}

    def _wait_prompt(self, pending, timeout_seconds=None):
        deadline = time.monotonic() + timeout_seconds if timeout_seconds else None
        while True:
            if self.stop_event.is_set():
                return None, "stopped"
            if self._attempt_terminal():
                time.sleep(0.25)
                return None, "attempt_terminal"
            if deadline is not None and time.monotonic() >= deadline:
                return None, "prompt_timeout"
            try:
                return pending.wait(timeout=0.1), None
            except TimeoutError:
                continue

    def _record_prompt_end(self, root_id, result, reprompt):
        with state_store.transaction() as con:
            state_store.append_event(
                con,
                root_id,
                "PromptTurnEnded",
                {"stop_reason": result.get("stopReason"), "reprompt": reprompt},
                attempt_id=self.attempt_id,
            )

    def _run_prompt_turns(self, run, config, bootstrap):
        limit = int(config.get("turn_end_reprompt_limit", 1))
        text = bootstrap
        for reprompt in range(limit + 1):
            pending = self.client.start_prompt(self.session_id, text)
            self.prompt_pending = True
            if reprompt == 0:
                if not execution_state.mark_ready(
                    self.attempt_id,
                    self.generation,
                    self.candidate_nonce,
                    acp_session_id=self.session_id,
                    protocol_version=1,
                    capabilities=self.capabilities,
                ):
                    self.exit_reason = "ready_fence_rejected"
                    return
            result, interrupted = self._wait_prompt(
                pending, timeout_seconds=config.get("prompt_timeout_seconds")
            )
            self.prompt_pending = False
            if interrupted:
                self.exit_reason = interrupted
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
            self.exit_reason = "without_finish:%s" % (result.get("stopReason") or "turn_ended")
            execution_state.record_turn_end(
                self.attempt_id,
                self.generation,
                self.candidate_nonce,
                self.exit_reason,
            )

    def run(self):
        claimed = state_store.claim_execution_ownership(
            self.attempt_id, self.generation, self.candidate_nonce, os.getpid()
        )
        if not claimed:
            return 3
        run, task, attempt, agent, execution = self._context()
        self.execution_id = execution["execution_id"]
        self._open_log(run["root_id"])
        endpoint = endpoint_path(
            state_store.runtime_root(), run["root_id"], self.attempt_id, self.generation
        )
        self.control = ControlServer(endpoint, self._control_request)
        self.control.start()
        if not execution_state.register_control_endpoint(
            self.attempt_id, self.generation, self.candidate_nonce, str(endpoint)
        ):
            self.exit_reason = "control_endpoint_fence_rejected"
            self._cleanup()
            return 4
        self._heartbeat_thread = threading.Thread(target=self._heartbeat, daemon=True)
        self._heartbeat_thread.start()
        config = json.loads(execution["config_json"])
        try:
            command = ensure_available(config)
        except RuntimeError as exc:
            self.exit_reason = str(exc)
            execution_state.record_turn_end(
                self.attempt_id,
                self.generation,
                self.candidate_nonce,
                self.exit_reason,
                error=True,
            )
            self._cleanup()
            return 5
        token = execution_secrets.derive_attempt_token(run, attempt["attempt_id"], agent["agent_id"])
        child_env = {key: value for key, value in os.environ.items() if key not in IDENTITY_ENV}
        child_env.update(
            {
                "AGENT_SWARM_ROOT_ID": run["root_id"],
                "AGENT_SWARM_TASK_ID": task["task_id"],
                "AGENT_SWARM_ATTEMPT_ID": attempt["attempt_id"],
                "AGENT_SWARM_AGENT_ID": agent["agent_id"],
                "AGENT_SWARM_ACTOR_TOKEN": token,
                "AGENT_SWARM_HOME": str(state_store.runtime_root()),
                "AGENT_SWARM_SKILL_DIR": str(SCRIPTS_DIR.parent),
            }
        )
        try:
            if self.stop_event.is_set() or not execution_state.ownership_is_live(
                self.attempt_id, self.generation, self.candidate_nonce
            ):
                self.exit_reason = "stopped_before_agent_popen"
                return 0
            self.agent = subprocess.Popen(
                [command] + list(config.get("args") or []),
                cwd=run["cwd"],
                env=child_env,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                start_new_session=True,
                bufsize=1,
            )
            if not execution_state.register_agent_process(
                self.attempt_id, self.generation, self.candidate_nonce, self.agent.pid
            ) or not execution_state.ownership_is_live(
                self.attempt_id, self.generation, self.candidate_nonce
            ):
                self.exit_reason = "agent_popen_fence_rejected"
                return 6
            self.client = AcpClient(
                self.agent.stdin,
                self.agent.stdout,
                request_handler=self._permission,
                event_handler=self._rpc_event,
            )
            self.client.start()
            initialized = self.client.initialize(timeout=30)
            self.capabilities = initialized.get("agentCapabilities") or {}
            auth_methods = [
                method.get("id")
                for method in initialized.get("authMethods") or []
                if isinstance(method, dict) and method.get("id")
            ]
            with state_store.transaction() as con:
                state_store.append_event(
                    con,
                    run["root_id"],
                    "AcpInitialized",
                    {"protocol_version": 1, "auth_methods": auth_methods},
                    attempt_id=self.attempt_id,
                )
            if self.stop_event.is_set() or not execution_state.ownership_is_live(
                self.attempt_id, self.generation, self.candidate_nonce
            ):
                self.exit_reason = "stopped_during_initialize"
                return 0
            session = self.client.new_session(cwd=run["cwd"], timeout=30)
            self.session_id = session.get("sessionId")
            if not self.session_id:
                raise RuntimeError("ACP session/new returned no sessionId")
            configured = configure_session(
                self.client,
                self.session_id,
                session.get("configOptions") or [],
                model=config.get("model"),
                permission_policy=config.get("permission_policy") or "allow_in_workspace",
            )
            with state_store.transaction() as con:
                state_store.append_event(
                    con,
                    run["root_id"],
                    "AcpSessionCreated",
                    {"session_id": self.session_id, "configured": configured},
                    attempt_id=self.attempt_id,
                )
            if self.stop_event.is_set() or not execution_state.ownership_is_live(
                self.attempt_id, self.generation, self.candidate_nonce
            ):
                self.exit_reason = "stopped_before_prompt"
                return 0
            bootstrap = prompt_builder.build_prompt(run, task, attempt, agent)
            self._run_prompt_turns(run, config, bootstrap)
            return 0
        except Exception as exc:
            self.exit_reason = "acp_error:%s" % exc
            if not self.stop_event.is_set() and not self._attempt_terminal():
                execution_state.record_turn_end(
                    self.attempt_id,
                    self.generation,
                    self.candidate_nonce,
                    self.exit_reason,
                    error=True,
                )
            return 7
        finally:
            self._cleanup()

    def _cleanup(self):
        self.stop_event.set()
        if self.client is not None and self.session_id:
            try:
                if self.prompt_pending:
                    self.client.cancel(self.session_id)
            except Exception:
                pass
            session_capabilities = (self.capabilities or {}).get("sessionCapabilities") or {}
            if "close" in session_capabilities:
                try:
                    self.client.close_session(self.session_id, timeout=1)
                except Exception:
                    pass
            self.client.close()
        agent_clean = True
        if self.agent is not None:
            agent_clean = terminate_process_group(
                self.agent.pid, grace=0.5, trusted=True
            )
            try:
                self.agent.wait(timeout=1)
            except Exception:
                pass
            for stream in (self.agent.stdin, self.agent.stdout):
                try:
                    stream.close()
                except Exception:
                    pass
        if self.control is not None:
            self.control.close()
        if agent_clean:
            execution_state.mark_closed(
                self.attempt_id, self.generation, self.candidate_nonce, self.exit_reason
            )
            execution_secrets.cleanup_run_seed_if_safe(self._context()[0]["root_id"])
            self.cleanup_succeeded = True
        else:
            self.exit_reason = "process_group_cleanup_failed"
            execution_state.mark_cleanup_failed(
                self.attempt_id, self.generation, self.candidate_nonce, self.exit_reason
            )
        self.cleanup_event.set()
        if self._log_file is not None:
            self._log("closed", reason=self.exit_reason)
            self._log_file.close()


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--attempt-id", required=True)
    parser.add_argument("--generation", required=True, type=int)
    parser.add_argument("--candidate-nonce", required=True)
    args = parser.parse_args(argv)
    return Worker(args.attempt_id, args.generation, args.candidate_nonce).run()


if __name__ == "__main__":
    raise SystemExit(main())
