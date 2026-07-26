"""Compatibility functions for callers migrating to ``backends.claude_cli``."""

from backends.base import SpawnRequest, StopRequest
from backends.claude_cli import ClaudeCliBackend, claude_bin


def spawn(prompt, cwd, session_name, model=None, env=None):
    result = ClaudeCliBackend().spawn(SpawnRequest(prompt, cwd, session_name, model, env or {}))
    return {"job_id": result.job_id, "session_name": result.session_name, **result.extras}


def stop(job_id=None, session_name=None, cwd=None):
    return ClaudeCliBackend().stop(StopRequest(job_id, session_name, cwd))


def observe_session(job_id=None, session_name=None, cwd=None):
    result = ClaudeCliBackend().observe(job_id=job_id, session_name=session_name, cwd=cwd)
    return {"presence": result.presence, "session": result.session, "error": result.error}


def session_alive(job_id=None, session_name=None, cwd=None):
    return ClaudeCliBackend().session_alive(job_id=job_id, session_name=session_name, cwd=cwd)


def list_sessions(cwd=None):
    return ClaudeCliBackend().list_sessions(cwd=cwd)
