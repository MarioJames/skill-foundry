"""Mode-0600 Unix control socket protocol for one ACP Worker."""

import json
import hashlib
import os
import pathlib
import socket
import stat
import threading


UNIX_SOCKET_PATH_LIMIT = 100


def _ensure_private_directory(directory):
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    metadata = directory.lstat()
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
        raise RuntimeError("ACP control path is not a private directory")
    getuid = getattr(os, "getuid", None)
    if getuid is not None and metadata.st_uid != getuid():
        raise RuntimeError("ACP control directory is owned by another user")
    os.chmod(str(directory), 0o700)


def endpoint_path(runtime_root, root_id, launch_id):
    runtime_root = pathlib.Path(runtime_root)
    directory = runtime_root / "control" / root_id
    filename = "launch-%d.sock" % int(launch_id)
    candidate = directory / filename
    # macOS sockaddr_un.sun_path is only 104 bytes. Keep the descriptive
    # default when it fits, otherwise use a deterministic, non-secret digest
    # under the same protected Runtime home.
    if len(os.fsencode(str(candidate))) > UNIX_SOCKET_PATH_LIMIT:
        digest = hashlib.sha256(
            ("%s|%d" % (root_id, int(launch_id))).encode("utf-8")
        ).hexdigest()[:16]
        directory = runtime_root / "control" / ".s"
        candidate = directory / (digest + ".sock")
    if len(os.fsencode(str(candidate))) > UNIX_SOCKET_PATH_LIMIT:
        # A valid Runtime home can itself exceed sockaddr_un.sun_path.  Keep
        # the socket in a per-user mode-0700 directory under the deliberately
        # short POSIX /tmp alias, and include the canonical Runtime root in the
        # digest so independent homes cannot share an endpoint.
        runtime_identity = os.path.realpath(str(runtime_root))
        digest = hashlib.sha256(
            (
                "%s|%s|%d"
                % (runtime_identity, root_id, int(launch_id))
            ).encode("utf-8")
        ).hexdigest()[:24]
        uid = getattr(os, "getuid", lambda: "unknown")()
        directory = pathlib.Path("/tmp") / (".agent-swarm-control-%s" % uid)
        candidate = directory / (digest + ".sock")
    if len(os.fsencode(str(candidate))) > UNIX_SOCKET_PATH_LIMIT:
        raise RuntimeError(
            "AGENT_SWARM_HOME is too long for a secure Unix control socket path"
        )
    _ensure_private_directory(directory)
    return candidate


class ControlServer:
    def __init__(self, endpoint, handler):
        self.endpoint = pathlib.Path(endpoint)
        self.handler = handler
        self.socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.socket.bind(str(self.endpoint))
        os.chmod(str(self.endpoint), 0o600)
        self.socket.listen(4)
        self.socket.settimeout(0.2)
        self.closed = threading.Event()
        self.thread = threading.Thread(target=self._serve, name="acp-worker-control", daemon=True)

    def start(self):
        self.thread.start()

    def _serve(self):
        while not self.closed.is_set():
            try:
                connection, _ = self.socket.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            with connection:
                stream = connection.makefile("rwb")
                try:
                    raw = stream.readline()
                    request = json.loads(raw.decode("utf-8"))
                    response = self.handler(request)
                except Exception as exc:
                    response = {"ok": False, "error": str(exc)}
                stream.write((json.dumps(response, sort_keys=True) + "\n").encode("utf-8"))
                stream.flush()

    def close(self):
        self.closed.set()
        try:
            self.socket.close()
        except OSError:
            pass
        try:
            self.endpoint.unlink()
        except FileNotFoundError:
            pass


def control_request(endpoint, command, payload=None, timeout=2):
    request = dict(payload or {})
    request["command"] = command
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.settimeout(timeout)
    try:
        client.connect(str(endpoint))
        stream = client.makefile("rwb")
        stream.write((json.dumps(request, sort_keys=True) + "\n").encode("utf-8"))
        stream.flush()
        raw = stream.readline()
        if not raw:
            raise RuntimeError("ACP Worker control endpoint closed without a response")
        return json.loads(raw.decode("utf-8"))
    finally:
        client.close()
