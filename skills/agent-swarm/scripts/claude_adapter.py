"""The only module allowed to invoke ``claude --bg`` and process controls."""

import json
import os
import pathlib
import re
import subprocess


JOB_RE = re.compile(r"backgrounded\s*[·:]\s*(\S+)", re.IGNORECASE)
ATTACH_RE = re.compile(r"claude\s+attach\s+(\S+)")
TERMINAL_STATES = {"done", "completed", "exited", "failed", "stopped", "error", "cancelled"}


def claude_bin():
    override = os.environ.get("AGENT_SWARM_CLAUDE_BIN", "").strip()
    if override:
        return override
    for entry in os.environ.get("PATH", "").split(os.pathsep):
        if not entry:
            continue
        candidate = pathlib.Path(entry) / "claude"
        if not candidate.is_file() or not os.access(str(candidate), os.X_OK):
            continue
        if ".superconductor" in candidate.parts:
            continue
        return str(candidate)
    return "claude"


def _timeout(name, default):
    raw = os.environ.get(name, "").strip()
    try:
        return max(1.0, float(raw)) if raw else default
    except ValueError:
        return default


def _job_id(output):
    for expression in (JOB_RE, ATTACH_RE):
        match = expression.search(output or "")
        if match:
            return match.group(1)
    return None


def _text(value):
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return str(value)


def spawn(prompt, cwd, session_name, model=None, env=None):
    command = [
        claude_bin(),
        "--bg",
        "--name",
        session_name,
        "--permission-mode",
        "bypassPermissions",
    ]
    if model:
        command.extend(["--model", model])
    command.append(prompt)
    child_env = os.environ.copy()
    child_env.update(env or {})
    timeout_seconds = _timeout("AGENT_SWARM_BG_LAUNCH_TIMEOUT_SECONDS", 90.0)
    try:
        completed = subprocess.run(
            command,
            cwd=cwd,
            env=child_env,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            check=False,
            timeout=timeout_seconds,
        )
    except subprocess.TimeoutExpired as exc:
        partial = "%s\n%s" % (
            _text(getattr(exc, "stdout", None) or getattr(exc, "output", None)),
            _text(getattr(exc, "stderr", None)),
        )
        job_id = _job_id(partial)
        if job_id:
            return {"job_id": job_id, "session_name": session_name}
        raise RuntimeError(
            "claude --bg timed out after %.1fs without a job id: %s"
            % (timeout_seconds, partial.strip() or "no partial output")
        ) from exc
    output = "%s\n%s" % (completed.stdout or "", completed.stderr or "")
    job_id = _job_id(output)
    if not job_id:
        raise RuntimeError(
            "claude --bg failed (exit=%s): %s" % (completed.returncode, output.strip() or "no job id")
        )
    return {"job_id": job_id, "session_name": session_name}


def stop(job_id=None, session_name=None, cwd=None):
    if not job_id and session_name:
        matching = []
        for session in list_sessions(cwd=cwd):
            name = session.get("name") or session.get("session_name")
            state = session.get("state") or session.get("status")
            if name == session_name and state not in TERMINAL_STATES:
                matching.append(session)
        if len(matching) > 1:
            raise RuntimeError("multiple live Claude sessions match %s" % session_name)
        if matching:
            job_id = matching[0].get("job_id") or matching[0].get("id")
            if not job_id:
                raise RuntimeError("live Claude session %s has no stoppable job id" % session_name)
    if not job_id:
        return {"stopped": True, "not_required": True}
    completed = subprocess.run(
        [claude_bin(), "stop", job_id],
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        check=False,
        timeout=_timeout("AGENT_SWARM_AGENT_CONTROL_TIMEOUT_SECONDS", 10.0),
    )
    if completed.returncode != 0:
        raise RuntimeError((completed.stderr or completed.stdout or "claude stop failed").strip())
    return {"stopped": True}


def observe_session(job_id=None, session_name=None, cwd=None):
    """Return a current Claude session observation without trusting stale job files."""
    if not job_id and not session_name:
        return {"presence": "unknown", "error": "session identity is missing"}
    try:
        sessions = list_sessions(cwd=cwd)
    except Exception as exc:
        return {"presence": "unknown", "error": str(exc)}

    matching = []
    for session in sessions:
        if not isinstance(session, dict):
            continue
        candidate_id = session.get("job_id") or session.get("id")
        candidate_name = session.get("name") or session.get("session_name")
        if (job_id and candidate_id == job_id) or (session_name and candidate_name == session_name):
            matching.append(session)

    if not matching:
        return {"presence": "absent"}

    for session in matching:
        value = session.get("state") or session.get("status")
        if value not in TERMINAL_STATES:
            return {"presence": "present", "session": session}
    return {"presence": "absent", "session": matching[-1]}


def session_alive(job_id=None, session_name=None, cwd=None):
    """Compatibility wrapper for callers that only need a boolean."""
    return observe_session(job_id=job_id, session_name=session_name, cwd=cwd)["presence"] == "present"


def list_sessions(cwd=None):
    completed = subprocess.run(
        [claude_bin(), "agents", "--json"],
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        check=False,
        timeout=_timeout("AGENT_SWARM_AGENT_CONTROL_TIMEOUT_SECONDS", 10.0),
    )
    if completed.returncode != 0:
        raise RuntimeError((completed.stderr or completed.stdout or "claude agents failed").strip())
    try:
        items = json.loads(completed.stdout or "[]")
    except ValueError as exc:
        raise RuntimeError("claude agents returned invalid JSON") from exc
    if not isinstance(items, list):
        raise RuntimeError("claude agents returned a non-array result")
    if cwd:
        expected = os.path.realpath(cwd)
        items = [
            item for item in items
            if isinstance(item, dict) and os.path.realpath(item.get("cwd") or "") == expected
        ]
    return items
