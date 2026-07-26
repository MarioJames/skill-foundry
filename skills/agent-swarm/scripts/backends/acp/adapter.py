"""Execution Backend adapter controlling detached ACP Workers by Launch ID."""

import json
import os
import pathlib
import secrets
import subprocess
import sys
import time

import execution_state
import state_store
from backends.base import (
    AgentBackend,
    BackendPendingError,
    BackendUnknownError,
    ObserveResult,
    SpawnRequest,
    SpawnResult,
    StopRequest,
)
from backends.acp.processes import pid_alive, process_group_alive, terminate_process_group
from backends.acp.worker_protocol import control_request


WORKER = pathlib.Path(__file__).resolve().with_name("worker.py")
DETACHED_LAUNCHER = pathlib.Path(__file__).resolve().with_name("detached_launcher.py")
MIN_FRESH_WORKER_LAUNCH_TIMEOUT_SECONDS = 1.0


class AcpBackend(AgentBackend):
    backend_id = "acp"

    def __init__(self, config=None, execution_record=None):
        self.config = dict(config or {})
        self.execution_record = dict(execution_record or {})

    def _record(self, launch_id=None):
        launch_id = launch_id or self.execution_record.get("launch_id")
        record = state_store.get_launch(launch_id) if launch_id else None
        if record is None:
            raise RuntimeError("ACP Launch record not found")
        if record["backend_id"] != "acp":
            raise RuntimeError("Launch backend is not ACP")
        self.execution_record = record
        return record

    @staticmethod
    def _job_id(record):
        return record.get("backend_ref") or "acp-launch:%s" % record["launch_id"]

    def _ping(self, record, timeout=0.5):
        endpoint = record.get("control_endpoint")
        if not endpoint or not pathlib.Path(endpoint).exists():
            return None
        try:
            result = control_request(
                endpoint,
                "ping",
                {"launch_id": record["launch_id"]},
                timeout=timeout,
            )
        except Exception:
            return None
        if result.get("ok") and int(result.get("launch_id", -1)) == record["launch_id"]:
            return result
        return None

    def _launch_worker(self, request, record):
        runtime_root = state_store.runtime_root()
        log_path = (
            runtime_root
            / "logs"
            / record["root_id"]
            / "acp"
            / ("launch-%s.worker.log" % record["launch_id"])
        )
        log_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        descriptor = os.open(str(log_path), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        candidate_nonce = secrets.token_hex(16)
        environment = {
            key: value for key, value in os.environ.items() if not key.startswith("AGENT_SWARM_")
        }
        environment["AGENT_SWARM_HOME"] = str(runtime_root)
        environment["AGENT_SWARM_EXECUTION_NONCE"] = candidate_nonce
        environment["PYTHONDONTWRITEBYTECODE"] = "1"
        try:
            subprocess.run(
                [
                    sys.executable,
                    str(DETACHED_LAUNCHER),
                    sys.executable,
                    str(WORKER),
                    "--launch-id",
                    str(record["launch_id"]),
                    "--candidate-nonce",
                    candidate_nonce,
                ],
                cwd=request.cwd,
                env=environment,
                stdin=subprocess.DEVNULL,
                stdout=descriptor,
                stderr=descriptor,
                close_fds=True,
                check=True,
            )
        finally:
            os.close(descriptor)

    def _advance_absent_launch(self, record):
        """Close one proven-absent Launch and append its retry Launch."""
        if record["status"] != "starting" or record.get("stop_requested_at") is not None:
            return False
        if process_group_alive(record.get("worker_pid")) or process_group_alive(record.get("agent_pid")):
            return False
        endpoint = record.get("control_endpoint")
        if endpoint:
            try:
                pathlib.Path(endpoint).unlink()
            except FileNotFoundError:
                pass
            except OSError as exc:
                raise BackendUnknownError(
                    "ACP control endpoint could not be removed before Launch retry"
                ) from exc
        with state_store.transaction() as con:
            current = state_store.get_launch(record["launch_id"], con)
            latest = state_store.get_current_launch(record["attempt_id"], con)
            attempt = state_store.get_attempt(record["attempt_id"], con)
            if not current or not latest or not attempt:
                return False
            if (
                latest["launch_id"] != current["launch_id"]
                or current.get("owner_nonce") != record.get("owner_nonce")
                or current["status"] != "starting"
                or current.get("stop_requested_at") is not None
                or attempt["state"] != "assigned"
            ):
                return False
            timestamp = state_store.now()
            con.execute(
                """UPDATE launches SET status='closed', prompt_state='cancelled',
                     exit_reason='worker_agent_control_absent', closed_at=?, last_event_at=?
                   WHERE launch_id=? AND status='starting'""",
                (timestamp, timestamp, current["launch_id"]),
            )
            cursor = con.execute(
                """INSERT INTO launches(
                     attempt_id, launch_no, session_name, status, prompt_state,
                     created_at, last_event_at
                   ) VALUES (?, ?, ?, 'starting', 'pending', ?, ?)""",
                (
                    current["attempt_id"],
                    current["launch_no"] + 1,
                    current["session_name"],
                    timestamp,
                    timestamp,
                ),
            )
            launch_id = cursor.lastrowid
            payload = {
                "root_id": current["root_id"],
                "task_id": current["task_id"],
                "attempt_id": current["attempt_id"],
                "launch_id": launch_id,
                "backend_id": "acp",
            }
            con.execute(
                """INSERT INTO effects(
                     root_id, attempt_id, launch_id, effect_type, payload_json,
                     idempotency_key, status, attempts, created_at
                   ) VALUES (?, ?, ?, 'spawn_agent', ?, ?, 'pending', 0, ?)""",
                (
                    current["root_id"],
                    current["attempt_id"],
                    launch_id,
                    json.dumps(payload, ensure_ascii=False, sort_keys=True),
                    "spawn:%s" % launch_id,
                    timestamp,
                ),
            )
            state_store.append_event(
                con,
                current["root_id"],
                "LaunchRetried",
                {
                    "previous_launch_id": current["launch_id"],
                    "launch_id": launch_id,
                    "reason": "worker_agent_control_absent",
                },
                task_id=current["task_id"],
                attempt_id=current["attempt_id"],
            )
        self.execution_record = state_store.get_launch(launch_id)
        return True

    def spawn(self, request):
        if not isinstance(request, SpawnRequest):
            raise TypeError("ACP spawn requires SpawnRequest")
        try:
            launch_id = int(request.metadata.get("launch_id"))
        except (TypeError, ValueError) as exc:
            raise RuntimeError("ACP spawn requires an integer launch_id") from exc
        record = self._record(launch_id)
        ping = self._ping(record)
        if record.get("ready_at") is not None and (ping is not None or record["status"] == "closed"):
            session = state_store.get_session_for_launch(record["launch_id"])
            return SpawnResult(
                job_id=self._job_id(record),
                session_name=record["session_name"],
                extras={
                    "launch_id": record["launch_id"],
                    "worker_pid": record.get("worker_pid"),
                    "agent_pid": record.get("agent_pid"),
                    "external_session_id": session.get("external_session_id") if session else None,
                    "protocol_version": session.get("protocol_version") if session else None,
                },
            )
        if record["status"] == "closed":
            raise RuntimeError(record.get("exit_reason") or "ACP Worker closed before ready")
        worker_alive = pid_alive(record.get("worker_pid"))
        agent_alive = pid_alive(record.get("agent_pid"))
        if record.get("owner_nonce") and not worker_alive and agent_alive:
            raise BackendUnknownError("ACP Worker is absent while its Agent Process is still alive")
        launched_worker = record.get("owner_nonce") is None
        if launched_worker:
            self._launch_worker(request, record)

        timeout = float(self.config.get("worker_launch_timeout_seconds") or 12)
        if launched_worker:
            timeout = max(timeout, MIN_FRESH_WORKER_LAUNCH_TIMEOUT_SECONDS)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            record = self._record(launch_id)
            ping = self._ping(record)
            if record.get("ready_at") is not None and (ping is not None or record["status"] == "closed"):
                session = state_store.get_session_for_launch(record["launch_id"])
                return SpawnResult(
                    job_id=self._job_id(record),
                    session_name=record["session_name"],
                    extras={
                        "launch_id": record["launch_id"],
                        "worker_pid": record.get("worker_pid"),
                        "agent_pid": record.get("agent_pid"),
                        "external_session_id": session.get("external_session_id") if session else None,
                        "protocol_version": session.get("protocol_version") if session else None,
                    },
                )
            if record["status"] in {"error", "turn_ended", "closed"}:
                raise RuntimeError(record.get("exit_reason") or "ACP Worker failed before ready")
            if record.get("owner_nonce") and not pid_alive(record.get("worker_pid")):
                if pid_alive(record.get("agent_pid")):
                    raise BackendUnknownError(
                        "ACP Worker exited before ready while Agent Process remains alive"
                    )
            time.sleep(0.03)
        record = self._record(launch_id)
        if self._advance_absent_launch(record):
            raise BackendPendingError("absent ACP Launch was fenced; replacement Launch appended")
        raise BackendPendingError("ACP Worker is still starting")

    def stop(self, request):
        if not isinstance(request, StopRequest):
            raise TypeError("ACP stop requires StopRequest")
        record = self._record()
        execution_state.request_stop(record["launch_id"])
        record = self._record()
        endpoint = record.get("control_endpoint")
        if endpoint and pathlib.Path(endpoint).exists():
            try:
                control_request(
                    endpoint,
                    "stop",
                    {"launch_id": record["launch_id"], "timeout": 8},
                    timeout=10,
                )
            except Exception:
                pass
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline:
            record = self._record()
            endpoint_exists = bool(
                record.get("control_endpoint") and pathlib.Path(record["control_endpoint"]).exists()
            )
            if (
                not process_group_alive(record.get("worker_pid"))
                and not process_group_alive(record.get("agent_pid"))
                and not endpoint_exists
            ):
                self._close_record(record, "stopped")
                return {"stopped": True}
            time.sleep(0.05)
        nonce = record.get("owner_nonce")
        agent_clean = terminate_process_group(record.get("agent_pid"), grace=0.5, expected_nonce=nonce)
        worker_clean = terminate_process_group(record.get("worker_pid"), grace=0.5, expected_nonce=nonce)
        endpoint = record.get("control_endpoint")
        if endpoint and not pid_alive(record.get("worker_pid")):
            try:
                pathlib.Path(endpoint).unlink()
            except FileNotFoundError:
                pass
        endpoint_clean = not (endpoint and pathlib.Path(endpoint).exists())
        if agent_clean and worker_clean and endpoint_clean:
            self._close_record(record, "forced_stop")
            return {"stopped": True, "forced": True}
        raise BackendUnknownError("ACP stop could not prove Worker/Agent cleanup")

    @staticmethod
    def _close_record(record, reason):
        with state_store.transaction() as con:
            timestamp = state_store.now()
            con.execute(
                """UPDATE launches SET status='closed', prompt_state='cancelled',
                     exit_reason=COALESCE(exit_reason, ?), closed_at=COALESCE(closed_at, ?),
                     last_event_at=? WHERE launch_id=?""",
                (reason, timestamp, timestamp, record["launch_id"]),
            )
            con.execute(
                """UPDATE acp_sessions SET status='closed', closed_at=COALESCE(closed_at, ?)
                   WHERE launch_id=? AND status='active'""",
                (timestamp, record["launch_id"]),
            )

    def observe(self, *, job_id=None, session_name=None, cwd=None):
        record = self._record()
        if job_id and job_id not in {record.get("backend_ref"), self._job_id(record)}:
            return ObserveResult("unknown", error="job id does not match Launch")
        worker_alive = pid_alive(record.get("worker_pid"))
        agent_alive = pid_alive(record.get("agent_pid"))
        worker_group_alive = process_group_alive(record.get("worker_pid"))
        agent_group_alive = process_group_alive(record.get("agent_pid"))
        endpoint_exists = bool(
            record.get("control_endpoint") and pathlib.Path(record["control_endpoint"]).exists()
        )
        ping = self._ping(record) if endpoint_exists else None
        if ping is not None and worker_alive:
            return ObserveResult("present", session=ping)
        if not worker_alive and (agent_alive or agent_group_alive):
            return ObserveResult(
                "unknown",
                session={"agent_pid": record.get("agent_pid")},
                error="orphan Agent Process is alive without its ACP Worker",
            )
        if not worker_group_alive and not agent_group_alive and not endpoint_exists:
            return ObserveResult("absent")
        return ObserveResult("unknown", error="ACP Launch facts are contradictory")

    def list_sessions(self, *, cwd=None):
        if not self.execution_record.get("root_id"):
            return []
        return [
            {
                "id": self._job_id(row),
                "job_id": self._job_id(row),
                "launch_id": row["launch_id"],
                "name": row["session_name"],
                "session_name": row["session_name"],
                "state": row["status"],
                "worker_pid": row.get("worker_pid"),
                "agent_pid": row.get("agent_pid"),
            }
            for row in state_store.list_launches(self.execution_record["root_id"])
            if row["backend_id"] == "acp" and row["status"] not in {"closed", "error", "turn_ended"}
        ]

    def supports_hooks(self):
        return False
