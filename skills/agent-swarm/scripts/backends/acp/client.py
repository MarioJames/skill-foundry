"""Minimal stable ACP v1 JSON-RPC client over newline-delimited stdio."""

import itertools
import json
import queue
import threading


class AcpError(RuntimeError):
    def __init__(self, code, message, data=None):
        super().__init__("ACP error %s: %s" % (code, message))
        self.code = code
        self.message = message
        self.data = data


class PendingRequest:
    def __init__(self, request_id, responses):
        self.request_id = request_id
        self._responses = responses

    def wait(self, timeout=None):
        try:
            value = self._responses.get(timeout=timeout)
        except queue.Empty as exc:
            raise TimeoutError("ACP request %s timed out" % self.request_id) from exc
        if isinstance(value, BaseException):
            raise value
        if "error" in value:
            error = value["error"]
            raise AcpError(error.get("code"), error.get("message"), error.get("data"))
        return value.get("result") or {}


class AcpClient:
    def __init__(self, writer, reader, request_handler=None, event_handler=None):
        self.writer = writer
        self.reader = reader
        self.request_handler = request_handler
        self.event_handler = event_handler
        self._ids = itertools.count(1)
        self._pending = {}
        self._pending_lock = threading.Lock()
        self._write_lock = threading.Lock()
        self._closed = threading.Event()
        self._thread = None

    def start(self):
        if self._thread is None:
            self._thread = threading.Thread(target=self._read_loop, name="acp-jsonrpc-reader", daemon=True)
            self._thread.start()

    def _write(self, message):
        if self._closed.is_set():
            raise AcpError(None, "ACP client is closed")
        encoded = json.dumps(message, ensure_ascii=False, separators=(",", ":"))
        with self._write_lock:
            self.writer.write(encoded + "\n")
            self.writer.flush()

    def start_request(self, method, params=None):
        request_id = next(self._ids)
        responses = queue.Queue(maxsize=1)
        with self._pending_lock:
            self._pending[request_id] = responses
        self._write({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params or {}})
        return PendingRequest(request_id, responses)

    def request(self, method, params=None, timeout=None):
        return self.start_request(method, params).wait(timeout)

    def notify(self, method, params=None):
        self._write({"jsonrpc": "2.0", "method": method, "params": params or {}})

    def _respond(self, request_id, result=None, error=None):
        message = {"jsonrpc": "2.0", "id": request_id}
        if error is not None:
            message["error"] = error
        else:
            message["result"] = result or {}
        self._write(message)

    def _read_loop(self):
        try:
            for raw in self.reader:
                if self._closed.is_set():
                    return
                try:
                    message = json.loads(raw)
                except ValueError:
                    continue
                if self.event_handler:
                    self.event_handler(message)
                request_id = message.get("id")
                if request_id is not None and ("result" in message or "error" in message):
                    with self._pending_lock:
                        responses = self._pending.pop(request_id, None)
                    if responses is not None:
                        responses.put(message)
                    continue
                method = message.get("method")
                if request_id is not None and method:
                    if self.request_handler is None:
                        self._respond(request_id, error={"code": -32601, "message": "method not found"})
                        continue
                    try:
                        result = self.request_handler(method, message.get("params") or {})
                    except Exception as exc:
                        self._respond(request_id, error={"code": -32000, "message": str(exc)})
                    else:
                        self._respond(request_id, result=result)
        finally:
            error = AcpError(None, "ACP transport closed")
            with self._pending_lock:
                pending = list(self._pending.values())
                self._pending.clear()
            for responses in pending:
                responses.put(error)

    def initialize(self, timeout=30):
        result = self.request(
            "initialize",
            {
                "protocolVersion": 1,
                "clientCapabilities": {},
                "clientInfo": {"name": "agent-swarm", "version": "1"},
            },
            timeout=timeout,
        )
        if result.get("protocolVersion") != 1:
            raise AcpError(None, "ACP agent did not negotiate protocolVersion=1")
        return result

    def new_session(self, *, cwd, mcp_servers=None, timeout=30):
        return self.request(
            "session/new",
            {"cwd": cwd, "mcpServers": list(mcp_servers or [])},
            timeout=timeout,
        )

    def start_prompt(self, session_id, text):
        return self.start_request(
            "session/prompt",
            {"sessionId": session_id, "prompt": [{"type": "text", "text": text}]},
        )

    def prompt(self, session_id, text, timeout=None):
        return self.start_prompt(session_id, text).wait(timeout)

    def set_config_option(self, session_id, config_id, value, timeout=10):
        return self.request(
            "session/set_config_option",
            {"sessionId": session_id, "configId": config_id, "value": value},
            timeout=timeout,
        )

    def cancel(self, session_id):
        self.notify("session/cancel", {"sessionId": session_id})

    def close_session(self, session_id, timeout=10):
        return self.request("session/close", {"sessionId": session_id}, timeout=timeout)

    def close(self):
        self._closed.set()
