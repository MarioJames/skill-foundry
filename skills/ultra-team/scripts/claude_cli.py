import json
import os
import pathlib
import re
import shutil
import subprocess
import time
import uuid
from typing import List, Optional

DONE_STATES = {"done", "completed", "exited", "failed", "stopped", "error", "blocked"}
BACKGROUNDED_RE = re.compile(r"backgrounded ·\s*(\S+)")
ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")
QUOTA_MARKERS = (
    "quota",
    "usage limit",
    "rate limit",
    "limit exceeded",
    "insufficient credits",
    "额度",
    "配额",
    "用量",
    "限额",
)

_DEFAULT_JOBS_ROOTS = {
    "claude": pathlib.Path.home() / ".claude" / "jobs",
}
_CLAUDE_PERMISSION_MODE = "bypassPermissions"
_DEFAULT_BG_LAUNCH_TIMEOUT_SECONDS = 90.0
_DEFAULT_ACTIVE_AGENTS_TIMEOUT_SECONDS = 10.0
_BG_LAUNCH_STDIN_ENV = "ULTRA_TEAM_BG_LAUNCH_STDIN"


class NoQuotaError(RuntimeError):
    pass


class AllEnginesDispatchFailed(RuntimeError):
    def __init__(self, failures):
        self.failures = failures
        super().__init__("claude dispatch failed")


class EngineDispatchError(RuntimeError):
    def __init__(self, message, job_id=None, session_id=None, cwd=None, engine=None):
        super().__init__(message)
        self.job_id = job_id
        self.session_id = session_id
        self.cwd = cwd
        self.engine = engine

    def failure(self, fallback_engine):
        data = {"engine": self.engine or fallback_engine, "error": str(self)}
        if self.job_id:
            data["job_id"] = self.job_id
        if self.session_id:
            data["session_id"] = self.session_id
        if self.cwd:
            data["cwd"] = self.cwd
        return data


def engine() -> str:
    return "claude"


def jobs_root(eng: str) -> pathlib.Path:
    if eng != "claude":
        raise ValueError(f"unsupported engine: {eng}")
    env_key = "CLAUDE_JOBS_ROOT"
    override = os.environ.get(env_key, "").strip()
    if override:
        return pathlib.Path(override).expanduser()
    return _DEFAULT_JOBS_ROOTS[eng]


def _claude_flags(name: Optional[str] = None, agent: Optional[str] = None) -> List[str]:
    return _claude_flags_with_model(name=name, agent=agent)


def _claude_flags_with_model(name: Optional[str] = None, agent: Optional[str] = None, model: Optional[str] = None) -> List[str]:
    flags = []
    if name:
        flags.extend(["--name", name])
    flags.extend(["--permission-mode", _CLAUDE_PERMISSION_MODE])
    if model:
        flags.extend(["--model", model])
    if agent:
        flags.extend(["--agent", agent])
    return flags


def _launch_cmd(eng: str, prompt: str, name: Optional[str] = None, agent: Optional[str] = None, model: Optional[str] = None):
    if eng == "claude":
        return ["claude", "--bg", *_claude_flags_with_model(name=name, agent=agent, model=model), prompt]
    raise ValueError(f"unsupported engine: {eng}")


def bg_launch_timeout() -> float:
    raw = os.environ.get("ULTRA_TEAM_BG_LAUNCH_TIMEOUT_SECONDS", "").strip()
    if not raw:
        return _DEFAULT_BG_LAUNCH_TIMEOUT_SECONDS
    try:
        timeout = float(raw)
    except ValueError:
        return _DEFAULT_BG_LAUNCH_TIMEOUT_SECONDS
    return max(5.0, timeout)


def active_agents_timeout() -> float:
    raw = os.environ.get("ULTRA_TEAM_ACTIVE_AGENTS_TIMEOUT_SECONDS", "").strip()
    if not raw:
        return _DEFAULT_ACTIVE_AGENTS_TIMEOUT_SECONDS
    try:
        timeout = float(raw)
    except ValueError:
        return _DEFAULT_ACTIVE_AGENTS_TIMEOUT_SECONDS
    return max(1.0, timeout)


def bg_launch_stdin() -> Optional[str]:
    value = os.environ.get(_BG_LAUNCH_STDIN_ENV)
    return value if value else None


def parse_job_id(output: str):
    clean_output = ANSI_RE.sub("", output or "")
    match = BACKGROUNDED_RE.search(clean_output)
    return match.group(1) if match else None


def read_state(job_id: str, eng: str, timeout: float = 5.0):
    path = jobs_root(eng) / job_id / "state.json"
    deadline = time.time() + timeout
    while time.time() < deadline:
        if path.exists():
            try:
                return json.loads(path.read_text())
            except json.JSONDecodeError:
                pass
        time.sleep(0.2)
    return None


def job_state(job_id: str, eng: str):
    path = jobs_root(eng) / job_id / "state.json"
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError:
        return None


def is_done(state) -> bool:
    if not state:
        return False
    return (state.get("state") or state.get("status")) in DONE_STATES


def is_quota_error(text: str) -> bool:
    lowered = (text or "").lower()
    return any(marker in lowered for marker in QUOTA_MARKERS)


def dispatch_bg(
    prompt: str,
    eng: str,
    name: Optional[str] = None,
    agent: Optional[str] = None,
    model: Optional[str] = None,
    cwd: Optional[str] = None,
    on_job_started=None,
) -> dict:
    cmd = _launch_cmd(eng, prompt, name=name, agent=agent, model=model)
    timeout = bg_launch_timeout()
    try:
        out = subprocess.run(
            cmd,
            input=bg_launch_stdin(),
            capture_output=True,
            text=True,
            check=False,
            cwd=cwd,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as exc:
        partial = "\n".join(part for part in (exc.stdout, exc.stderr) if part)
        detail = f"dispatch_bg: {eng} --bg launch timed out after {timeout:.1f}s"
        if partial:
            detail = f"{detail}; partial_output={partial!r}"
        raise RuntimeError(detail)
    combined = f"{out.stdout}\n{out.stderr}"
    if is_quota_error(combined):
        raise NoQuotaError(combined.strip())
    job_id = parse_job_id(out.stdout) or parse_job_id(out.stderr)
    if not job_id:
        raise RuntimeError(f"dispatch_bg: cannot parse job id; stdout={out.stdout!r} stderr={out.stderr!r}")
    if on_job_started:
        on_job_started(eng, job_id)
    state = read_state(job_id, eng)
    if state is None:
        raise RuntimeError(f"dispatch_bg: missing state.json for {job_id}")
    if is_done(state):
        detail = state.get("detail") or state.get("needs") or state.get("state") or state.get("status")
        raise EngineDispatchError(
            f"{eng} background job {job_id} reached terminal state during dispatch: {detail}",
            job_id=job_id,
            session_id=state.get("sessionId"),
            cwd=state.get("cwd"),
            engine=eng,
        )
    return {"job_id": job_id, "session_id": state.get("sessionId"), "cwd": state.get("cwd")}


def dispatch_with_fallback(
    prompt: str,
    name: Optional[str] = None,
    agent: Optional[str] = None,
    model: Optional[str] = None,
    cwd: Optional[str] = None,
    on_job_started=None,
) -> dict:
    failures = []
    eng = engine()
    try:
        info = dispatch_bg(prompt, eng, name=name, agent=agent, model=model, cwd=cwd, on_job_started=on_job_started)
        info["engine"] = eng
        return info
    except NoQuotaError as exc:
        failures.append({"engine": eng, "error": str(exc)})
    except EngineDispatchError as exc:
        failures.append(exc.failure(eng))
    except RuntimeError as exc:
        failures.append({"engine": eng, "error": str(exc)})
    raise AllEnginesDispatchFailed(failures)


def read_log(job_id: str, eng: str) -> str:
    if eng != "claude":
        return ""
    cmd = ["claude", "logs", job_id]
    out = subprocess.run(cmd, capture_output=True, text=True, check=False)
    return out.stdout or ""


def stop(job_id: str, eng: str) -> None:
    if eng != "claude":
        return
    cmd = ["claude", "stop", job_id]
    subprocess.run(cmd, capture_output=True, text=True, check=False)


def rm(job_id: str, eng: str) -> None:
    if eng != "claude":
        return
    subprocess.run(["claude", "rm", job_id], capture_output=True, text=True, check=False)


def active_agents() -> list:
    try:
        out = subprocess.run(
            ["claude", "agents", "--json"],
            capture_output=True,
            text=True,
            check=False,
            timeout=active_agents_timeout(),
        )
    except subprocess.TimeoutExpired:
        return []
    if out.returncode != 0 or not out.stdout.strip():
        return []
    try:
        data = json.loads(out.stdout)
    except json.JSONDecodeError:
        return []
    return data if isinstance(data, list) else []


def _run_tmux(args, timeout: float = 10.0):
    out = subprocess.run(
        ["tmux", *args],
        capture_output=True,
        text=True,
        check=False,
        timeout=timeout,
    )
    return out


def _tmux_session_exists(session_name: str) -> bool:
    out = _run_tmux(["has-session", "-t", session_name], timeout=5.0)
    return out.returncode == 0


def _tmux_capture(session_name: str) -> str:
    out = _run_tmux(["capture-pane", "-pt", session_name, "-S", "-120"], timeout=5.0)
    if out.returncode != 0:
        return ""
    return out.stdout or ""


def attach_agent_and_send(
    job_id: str,
    cwd: str,
    prompt: str = "continue",
    attach_settle: float = 2.0,
    interrupt_first: bool = False,
    interrupt_settle: float = 0.5,
    after_send_settle: float = 1.0,
    detach_settle: float = 1.0,
) -> dict:
    if shutil.which("tmux") is None:
        raise RuntimeError("recover idle agent requires tmux to automate claude attach")
    session_name = f"ut-recover-{job_id}-{uuid.uuid4().hex[:8]}"
    pane_before = ""
    pane_after = ""
    try:
        attach = _run_tmux(
            [
                "new-session",
                "-d",
                "-s",
                session_name,
                "-c",
                cwd,
                f"claude attach {job_id}",
            ],
            timeout=10.0,
        )
        if attach.returncode != 0:
            raise RuntimeError(
                f"tmux attach session failed for {job_id}: {attach.stderr.strip() or attach.stdout.strip()}"
            )
        time.sleep(max(0.0, attach_settle))
        pane_before = _tmux_capture(session_name)

        if interrupt_first:
            interrupted = _run_tmux(["send-keys", "-t", session_name, "C-c"], timeout=5.0)
            if interrupted.returncode != 0:
                raise RuntimeError(
                    f"tmux interrupt failed for {job_id}: {interrupted.stderr.strip() or interrupted.stdout.strip()}"
                )
            time.sleep(max(0.0, interrupt_settle))

        sent = _run_tmux(["send-keys", "-t", session_name, prompt, "C-m"], timeout=5.0)
        if sent.returncode != 0:
            raise RuntimeError(
                f"tmux send-keys failed for {job_id}: {sent.stderr.strip() or sent.stdout.strip()}"
            )
        time.sleep(max(0.0, after_send_settle))

        detached = _run_tmux(["send-keys", "-t", session_name, "C-z"], timeout=5.0)
        if detached.returncode != 0:
            raise RuntimeError(
                f"tmux detach failed for {job_id}: {detached.stderr.strip() or detached.stdout.strip()}"
            )
        time.sleep(max(0.0, detach_settle))
        if _tmux_session_exists(session_name):
            pane_after = _tmux_capture(session_name)
        return {
            "job_id": job_id,
            "cwd": cwd,
            "input": prompt,
            "tmux_session": session_name,
            "interrupt_first": interrupt_first,
            "pane_before": pane_before,
            "pane_after": pane_after,
        }
    finally:
        if _tmux_session_exists(session_name):
            _run_tmux(["kill-session", "-t", session_name], timeout=5.0)
