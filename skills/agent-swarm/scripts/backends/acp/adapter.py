"""Execution Backend adapter controlling detached ACP Workers by persisted IPC."""

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
from backends.acp.processes import (
    pid_alive,
    process_group_alive,
    terminate_process_group,
)
from backends.acp.worker_protocol import control_request


WORKER = pathlib.Path(__file__).resolve().with_name("worker.py")
DETACHED_LAUNCHER = pathlib.Path(__file__).resolve().with_name("detached_launcher.py")
MIN_FRESH_WORKER_LAUNCH_TIMEOUT_SECONDS = 1.0


class AcpBackend(AgentBackend):
    backend_id = "acp"

    def __init__(self, config=None, execution_record=None):
        self.config = dict(config or {})
        self.execution_record = dict(execution_record or {})

    def _record(self, attempt_id=None):
        attempt_id = attempt_id or self.execution_record.get("attempt_id")
        record = state_store.get_execution(attempt_id) if attempt_id else None
        if record is None:
            raise RuntimeError("ACP execution record not found")
        if record["backend_id"] != "acp":
            raise RuntimeError("execution record is not ACP")
        self.execution_record = record
        return record

    def _ping(self, record, timeout=0.5):
        endpoint = record.get("control_endpoint")
        if not endpoint or not pathlib.Path(endpoint).exists():
            return None
        try:
            result = control_request(
                endpoint,
                "ping",
                {
                    "execution_id": record["execution_id"],
                    "generation": record["generation"],
                },
                timeout=timeout,
            )
        except Exception:
            return None
        if (
            result.get("ok")
            and result.get("execution_id") == record["execution_id"]
            and int(result.get("generation", -1)) == int(record["generation"])
        ):
            return result
        return None

    def _launch_worker(self, request, record):
        runtime_root = state_store.runtime_root()
        log_path = runtime_root / "logs" / record["root_id"] / "acp" / (record["attempt_id"] + ".worker.log")
        log_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        descriptor = os.open(str(log_path), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        candidate_nonce = secrets.token_hex(16)
        environment = {
            key: value
            for key, value in os.environ.items()
            if not key.startswith("AGENT_SWARM_")
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
                    "--attempt-id",
                    record["attempt_id"],
                    "--generation",
                    str(record["generation"]),
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

    def _advance_absent_generation(self, record):
        """Fence one absent starting generation and prepare an idempotent retry."""
        if record["status"] != "starting" or record.get("stop_requested_at") is not None:
            return False
        if process_group_alive(record.get("worker_pid")) or process_group_alive(
            record.get("agent_pid")
        ):
            return False
        endpoint = record.get("control_endpoint")
        if endpoint:
            try:
                pathlib.Path(endpoint).unlink()
            except FileNotFoundError:
                pass
            except OSError as exc:
                raise BackendUnknownError(
                    "ACP control endpoint could not be removed before generation advance"
                ) from exc
        next_generation = int(record["generation"]) + 1
        next_execution_id = "acp:%s:%d" % (record["attempt_id"], next_generation)
        with state_store.transaction() as con:
            current = state_store.get_execution(record["attempt_id"], con)
            if not current:
                return False
            owner_matches = current.get("owner_nonce") == record.get("owner_nonce")
            if (
                int(current["generation"]) != int(record["generation"])
                or current["execution_id"] != record["execution_id"]
                or not owner_matches
                or current["status"] != "starting"
                or current.get("stop_requested_at") is not None
            ):
                return False
            timestamp = state_store.now()
            cursor = con.execute(
                """UPDATE execution_sessions
                   SET generation=?, execution_id=?, owner_nonce=NULL,
                       worker_pid=NULL, agent_pid=NULL, control_endpoint=NULL,
                       acp_session_id=NULL, protocol_version=NULL,
                       capabilities_json=NULL, status='starting', prompt_state='pending',
                       last_worker_heartbeat_at=NULL, last_event_at=?, exit_reason=NULL,
                       ready_at=NULL, stop_requested_at=NULL, reconciled_at=NULL, closed_at=NULL
                   WHERE attempt_id=? AND generation=? AND execution_id=?
                     AND status='starting' AND stop_requested_at IS NULL""",
                (
                    next_generation,
                    next_execution_id,
                    timestamp,
                    record["attempt_id"],
                    record["generation"],
                    record["execution_id"],
                ),
            )
            if cursor.rowcount != 1:
                return False
            effects = state_store.fetchall(
                """SELECT id, payload_json FROM side_effect_outbox
                   WHERE root_id=? AND effect_type='spawn_agent'
                     AND status IN ('pending','running')""",
                (record["root_id"],),
                con,
            )
            for effect in effects:
                payload = json.loads(effect["payload_json"])
                if payload.get("attempt_id") != record["attempt_id"]:
                    continue
                if payload.get("execution_id") != record["execution_id"]:
                    continue
                payload.update(
                    {
                        "generation": next_generation,
                        "execution_id": next_execution_id,
                        "config_json": record["config_json"],
                    }
                )
                con.execute(
                    """UPDATE side_effect_outbox
                       SET payload_json=?, status='pending', claimed_at=NULL, last_error=NULL
                       WHERE id=?""",
                    (json.dumps(payload, ensure_ascii=False, sort_keys=True), effect["id"]),
                )
            state_store.append_event(
                con,
                record["root_id"],
                "ExecutionGenerationAdvanced",
                {
                    "previous_generation": record["generation"],
                    "generation": next_generation,
                    "reason": "worker_agent_control_absent",
                },
                attempt_id=record["attempt_id"],
            )
        self.execution_record = state_store.get_execution(record["attempt_id"])
        return True

    def spawn(self, request):
        if not isinstance(request, SpawnRequest):
            raise TypeError("ACP spawn requires SpawnRequest")
        attempt_id = request.metadata.get("attempt_id")
        record = self._record(attempt_id)
        if request.metadata.get("execution_id") != record["execution_id"]:
            raise RuntimeError("ACP spawn execution fence mismatch")
        ping = self._ping(record)
        if record.get("ready_at") is not None and (
            ping is not None or record["status"] == "closed"
        ):
            return SpawnResult(
                job_id=record["execution_id"],
                session_name=record["session_name"],
                extras={
                    "worker_pid": record.get("worker_pid"),
                    "agent_pid": record.get("agent_pid"),
                    "acp_session_id": record.get("acp_session_id"),
                    "protocol_version": record.get("protocol_version"),
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
            # A detached launcher can return before the new Worker imports the
            # Runtime and claims ownership.  A tiny stale-generation grace
            # must not immediately fence the fresh candidate into an endless
            # generation-advance loop.
            timeout = max(timeout, MIN_FRESH_WORKER_LAUNCH_TIMEOUT_SECONDS)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            record = self._record(attempt_id)
            ping = self._ping(record)
            if record.get("ready_at") is not None and (
                ping is not None or record["status"] == "closed"
            ):
                return SpawnResult(
                    job_id=record["execution_id"],
                    session_name=record["session_name"],
                    extras={
                        "worker_pid": record.get("worker_pid"),
                        "agent_pid": record.get("agent_pid"),
                        "acp_session_id": record.get("acp_session_id"),
                        "protocol_version": record.get("protocol_version"),
                    },
                )
            if record["status"] in {"error", "turn_ended", "closed"}:
                raise RuntimeError(record.get("exit_reason") or "ACP Worker failed before ready")
            if record.get("owner_nonce") and not pid_alive(record.get("worker_pid")):
                if pid_alive(record.get("agent_pid")):
                    raise BackendUnknownError(
                        "ACP Worker exited before ready while Agent Process remains alive"
                    )
                # Persisted ownership means a candidate existed. Keep the
                # generation fenced for the full launch grace before proving
                # all three resources absent and advancing it.
            time.sleep(0.03)
        record = self._record(attempt_id)
        if self._advance_absent_generation(record):
            raise BackendPendingError("absent ACP generation was fenced and advanced")
        raise BackendPendingError("ACP Worker is still starting")

    def stop(self, request):
        if not isinstance(request, StopRequest):
            raise TypeError("ACP stop requires StopRequest")
        record = self._record()
        execution_state.request_stop(record["attempt_id"], record["generation"])
        record = self._record()
        endpoint = record.get("control_endpoint")
        if endpoint and pathlib.Path(endpoint).exists():
            try:
                control_request(
                    endpoint,
                    "stop",
                    {
                        "execution_id": record["execution_id"],
                        "generation": record["generation"],
                        "timeout": 8,
                    },
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
                if record["status"] != "closed":
                    with state_store.transaction() as con:
                        timestamp = state_store.now()
                        con.execute(
                            """UPDATE execution_sessions SET status='closed', prompt_state='cancelled',
                                 exit_reason=COALESCE(exit_reason, 'stopped'), closed_at=?, last_event_at=?
                               WHERE attempt_id=? AND generation=?""",
                            (timestamp, timestamp, record["attempt_id"], record["generation"]),
                        )
                return {"stopped": True}
            time.sleep(0.05)
        nonce = record.get("owner_nonce")
        agent_clean = terminate_process_group(
            record.get("agent_pid"), grace=0.5, expected_nonce=nonce
        )
        worker_clean = terminate_process_group(
            record.get("worker_pid"), grace=0.5, expected_nonce=nonce
        )
        endpoint = record.get("control_endpoint")
        if endpoint and not pid_alive(record.get("worker_pid")):
            try:
                pathlib.Path(endpoint).unlink()
            except FileNotFoundError:
                pass
        endpoint_clean = not (
            endpoint and pathlib.Path(endpoint).exists()
        )
        if (
            agent_clean
            and worker_clean
            and endpoint_clean
            and not process_group_alive(record.get("agent_pid"))
            and not process_group_alive(record.get("worker_pid"))
        ):
            with state_store.transaction() as con:
                timestamp = state_store.now()
                con.execute(
                    """UPDATE execution_sessions SET status='closed', prompt_state='cancelled',
                         exit_reason=COALESCE(exit_reason, 'forced_stop'), closed_at=?, last_event_at=?
                       WHERE attempt_id=? AND generation=?""",
                    (timestamp, timestamp, record["attempt_id"], record["generation"]),
                )
            return {"stopped": True, "forced": True}
        raise BackendUnknownError("ACP stop could not prove Worker/Agent cleanup")

    def observe(self, *, job_id=None, session_name=None, cwd=None):
        record = self._record()
        if job_id and job_id != record["execution_id"]:
            return ObserveResult("unknown", error="execution id does not match record")
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
        if (
            not worker_group_alive
            and not agent_group_alive
            and not endpoint_exists
        ):
            return ObserveResult("absent")
        return ObserveResult("unknown", error="ACP execution facts are contradictory")

    def list_sessions(self, *, cwd=None):
        if not self.execution_record.get("root_id"):
            return []
        rows = state_store.list_executions(self.execution_record["root_id"])
        return [
            {
                "id": row["execution_id"],
                "job_id": row["execution_id"],
                "name": row["session_name"],
                "session_name": row["session_name"],
                "state": row["status"],
                "worker_pid": row.get("worker_pid"),
                "agent_pid": row.get("agent_pid"),
            }
            for row in rows
            if row["status"] not in {"closed", "error", "turn_ended"}
        ]

    def supports_hooks(self):
        return False
