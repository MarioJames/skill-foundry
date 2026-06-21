import os
import signal
import subprocess
import time
from typing import Any, Dict


def process_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    out = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True, check=False)
    if out.returncode == 0 and out.stdout.strip().startswith("Z"):
        return False
    return True


def terminate_process_group(pid: int, grace_seconds: float = 1.0) -> Dict[str, Any]:
    result: Dict[str, Any] = {"pid": pid, "terminated": False}
    if not process_alive(pid):
        result["terminated"] = True
        return result

    target = ("pid", pid)
    try:
        pgid = os.getpgid(pid)
        if pgid != os.getpgrp():
            os.killpg(pgid, signal.SIGTERM)
            target = ("group", pgid)
        else:
            os.kill(pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            result["terminated"] = True
            return result

    deadline = time.time() + grace_seconds
    while time.time() < deadline:
        if not process_alive(pid):
            result["terminated"] = True
            return result
        time.sleep(0.05)

    try:
        if target[0] == "group":
            os.killpg(target[1], signal.SIGKILL)
        else:
            os.kill(target[1], signal.SIGKILL)
    except ProcessLookupError:
        pass
    time.sleep(0.05)
    result["terminated"] = not process_alive(pid)
    return result
