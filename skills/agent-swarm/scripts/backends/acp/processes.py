"""Bounded, identity-aware process-group observation and cleanup."""

import os
import signal
import subprocess
import time


def pid_alive(pid):
    if not pid:
        return False
    try:
        waited, _ = os.waitpid(int(pid), os.WNOHANG)
        if waited == int(pid):
            return False
    except ChildProcessError:
        pass
    try:
        os.kill(int(pid), 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def process_group_leader_alive(pid):
    if not pid_alive(pid):
        return False
    try:
        return os.getpgid(int(pid)) == int(pid)
    except (ProcessLookupError, PermissionError):
        return False


def process_group_members(pgid):
    """Return non-zombie PIDs in a process group, or None if ps is unavailable."""
    if not pgid:
        return []
    try:
        completed = subprocess.run(
            ["ps", "-axo", "pid=,pgid=,stat="],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            check=False,
            timeout=1,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if completed.returncode != 0:
        return None
    members = []
    for line in completed.stdout.splitlines():
        fields = line.split(None, 2)
        if len(fields) != 3:
            continue
        try:
            pid_value, group_value = int(fields[0]), int(fields[1])
        except ValueError:
            continue
        if group_value == int(pgid) and not fields[2].upper().startswith("Z"):
            members.append(pid_value)
    return members


def process_group_alive(pgid):
    if not pgid:
        return False
    # Reap a direct child leader before checking the group. Otherwise a lone
    # zombie leader makes killpg(..., 0) look like a live execution forever.
    pid_alive(pgid)
    members = process_group_members(pgid)
    if members is not None:
        return bool(members)
    try:
        os.killpg(int(pgid), 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def process_has_nonce(pid, expected_nonce):
    """Verify a persisted PID still belongs to this execution without logging env."""
    if not pid_alive(pid) or not expected_nonce:
        return False
    needle = ("AGENT_SWARM_EXECUTION_NONCE=%s" % expected_nonce).encode("utf-8")
    environ_path = "/proc/%d/environ" % int(pid)
    try:
        with open(environ_path, "rb") as stream:
            return needle + b"\0" in stream.read()
    except OSError:
        pass
    try:
        completed = subprocess.run(
            ["ps", "eww", "-p", str(int(pid)), "-o", "command="],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=1,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return needle in completed.stdout.split()


def wait_absent(pid, timeout=3):
    deadline = time.monotonic() + max(0, timeout)
    while time.monotonic() < deadline:
        if not pid_alive(pid):
            return True
        time.sleep(0.05)
    return not pid_alive(pid)


def wait_process_group_absent(pgid, timeout=3):
    deadline = time.monotonic() + max(0, timeout)
    while time.monotonic() < deadline:
        if not process_group_alive(pgid):
            return True
        time.sleep(0.05)
    return not process_group_alive(pgid)


def _signal_process_group(pgid, sig):
    members = process_group_members(pgid)
    try:
        os.killpg(int(pgid), sig)
        return True
    except ProcessLookupError:
        return True
    except PermissionError:
        # macOS may reject killpg after the leader exits. Fall back to the
        # already-resolved members of this verified/trusted group.
        signalled = False
        for member in members or []:
            try:
                os.kill(member, sig)
                signalled = True
            except ProcessLookupError:
                continue
            except PermissionError:
                return False
        return signalled


def terminate_process_group(pid, grace=1, *, expected_nonce=None, trusted=False):
    if not process_group_alive(pid):
        return True
    if not trusted and (
        not process_group_leader_alive(pid)
        or not process_has_nonce(pid, expected_nonce)
    ):
        return False
    if not _signal_process_group(pid, signal.SIGTERM):
        return not process_group_alive(pid)
    if wait_process_group_absent(pid, grace):
        return True
    if not _signal_process_group(pid, signal.SIGKILL):
        return not process_group_alive(pid)
    return wait_process_group_absent(pid, grace)
