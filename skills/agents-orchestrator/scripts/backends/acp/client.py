"""Narrow Agent Swarm callbacks and connection factory for the official SDK."""

import inspect


def _sdk():
    from backends.acp.registry import ensure_sdk_available

    ensure_sdk_available()
    import acp

    return acp


class AgentSwarmClient:
    """Map official typed Client callbacks to Runtime business policy."""

    def __init__(self, permission_handler, session_update_handler=None):
        self.permission_handler = permission_handler
        self.session_update_handler = session_update_handler
        self.connection = None

    def on_connect(self, connection):
        self.connection = connection

    async def request_permission(
        self, session_id, tool_call, options, **kwargs
    ):
        acp = _sdk()
        request = acp.RequestPermissionRequest(
            session_id=session_id,
            tool_call=tool_call,
            options=options,
            field_meta=kwargs or None,
        )
        decision = self.permission_handler(request)
        if inspect.isawaitable(decision):
            decision = await decision
        if decision is None or decision.selected_option_id is None:
            outcome = acp.schema.DeniedOutcome(outcome="cancelled")
        else:
            outcome = acp.schema.AllowedOutcome(
                outcome="selected",
                option_id=decision.selected_option_id,
            )
        return acp.RequestPermissionResponse(outcome=outcome)

    async def session_update(self, session_id, update, **kwargs):
        if self.session_update_handler is None:
            return
        result = self.session_update_handler(session_id, update)
        if inspect.isawaitable(result):
            await result

    async def write_text_file(self, session_id, path, content, **kwargs):
        raise _sdk().RequestError.method_not_found("fs/write_text_file")

    async def read_text_file(
        self, session_id, path, line=None, limit=None, **kwargs
    ):
        raise _sdk().RequestError.method_not_found("fs/read_text_file")

    async def create_terminal(
        self,
        session_id,
        command,
        args=None,
        env=None,
        cwd=None,
        output_byte_limit=None,
        **kwargs
    ):
        raise _sdk().RequestError.method_not_found("terminal/create")

    async def terminal_output(self, session_id, terminal_id, **kwargs):
        raise _sdk().RequestError.method_not_found("terminal/output")

    async def release_terminal(self, session_id, terminal_id, **kwargs):
        raise _sdk().RequestError.method_not_found("terminal/release")

    async def wait_for_terminal_exit(self, session_id, terminal_id, **kwargs):
        raise _sdk().RequestError.method_not_found("terminal/wait_for_exit")

    async def kill_terminal(self, session_id, terminal_id, **kwargs):
        raise _sdk().RequestError.method_not_found("terminal/kill")

    async def create_elicitation(self, message, mode, **kwargs):
        raise _sdk().RequestError.method_not_found("elicitation/create")

    async def complete_elicitation(self, elicitation_id, **kwargs):
        raise _sdk().RequestError.method_not_found("elicitation/complete")

    async def ext_method(self, method, params):
        raise _sdk().RequestError.method_not_found("_" + method)

    async def ext_notification(self, method, params):
        raise _sdk().RequestError.method_not_found("_" + method)


def connect_agent(client, writer, reader, *, stream_observer=None):
    """Create the official typed client-side connection."""
    kwargs = {"observers": [stream_observer]} if stream_observer else {}
    return _sdk().connect_to_agent(
        client,
        writer,
        reader,
        use_unstable_protocol=True,
        **kwargs
    )
