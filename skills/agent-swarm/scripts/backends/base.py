"""Execution Backend contract shared by all child process adapters."""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Dict, Optional


@dataclass(frozen=True)
class SpawnRequest:
    prompt: str
    cwd: str
    session_name: str
    model: Optional[str] = None
    env: Dict[str, str] = field(default_factory=dict)
    backend_config: Dict[str, Any] = field(default_factory=dict)
    metadata: Dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class SpawnResult:
    job_id: str
    session_name: str
    extras: Dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class ObserveResult:
    presence: str
    session: Optional[Dict[str, Any]] = None
    error: Optional[str] = None


@dataclass(frozen=True)
class StopRequest:
    job_id: Optional[str] = None
    session_name: Optional[str] = None
    cwd: Optional[str] = None
    reason: Optional[str] = None


class AgentBackend(ABC):
    backend_id = ""

    @abstractmethod
    def spawn(self, request):
        raise NotImplementedError

    @abstractmethod
    def stop(self, request):
        raise NotImplementedError

    @abstractmethod
    def observe(self, *, job_id=None, session_name=None, cwd=None):
        raise NotImplementedError

    def session_alive(self, *, job_id=None, session_name=None, cwd=None):
        return self.observe(job_id=job_id, session_name=session_name, cwd=cwd).presence == "present"

    @abstractmethod
    def list_sessions(self, *, cwd=None):
        raise NotImplementedError

    @abstractmethod
    def supports_hooks(self):
        raise NotImplementedError


class BackendPendingError(RuntimeError):
    """Execution is still starting and must not be treated as spawn failure."""


class BackendUnknownError(RuntimeError):
    """Execution facts conflict; recovery must not create a replacement yet."""
