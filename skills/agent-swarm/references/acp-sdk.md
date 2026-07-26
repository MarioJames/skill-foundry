# ACP Python SDK Runtime Boundary

Agent Swarm is an ACP Client and Runtime orchestrator. It does not implement an ACP Server or a
second ACP protocol stack.

## Offline dependency injection

- Supported Runtime: CPython 3.10 through 3.14 on macOS/Linux arm64 or x86_64; Linux bundles cover
  glibc and musl.
- The installed skill includes `assets/acp-runtime/manifest.json`, a pure-Python archive, and 30
  interpreter/platform-specific `pydantic-core` archives.
- Exact bundled versions are `agent-client-protocol==0.11.0`, `pydantic==2.13.4`,
  `pydantic-core==2.46.4`, `annotated-types==0.8.0`, `typing-extensions==4.16.0`, and
  `typing-inspection==0.4.2`.
- Every archive is SHA-256 verified before import. Distribution metadata and upstream license files
  remain in the archives.

The first ACP operation extracts only the matching native archive into
`$AGENT_SWARM_HOME/dependencies/acp-runtime` under a process lock, then injects the native directory
and read-only pure archive into that interpreter. Extraction is idempotent and offline; it never
invokes pip/uv, mutates global Python, or accesses the network. The persistent cache is Runtime
support data, not a live execution resource; Worker, Agent, and control-socket cleanup semantics are
unchanged.

Missing, corrupt, unsupported-platform, or unsupported-Python bundle state fails before the Agent
process starts with a reinstall-the-skill instruction. `scripts/build_acp_runtime_bundle.py` is a
maintainer-only reproducible builder and is never called by the Runtime.

## Ownership boundary

The official SDK exclusively owns:

- stdio framing and JSON-RPC serialization;
- request IDs, response matching, pending request lifecycle, and method dispatch;
- ACP schema parsing and serialization;
- connection and async request lifecycle.

Agent Swarm owns:

- the detached Worker and Agent process group;
- append-only Launch ownership, PID, and control-socket fencing;
- permission policy decisions returned through the typed Client callback;
- advertised Session model/mode selection;
- Runtime finish, stop, retry, reconciliation, and cleanup gates;
- redacted semantic diagnostics.

`scripts/backends/acp/client.py` is only a typed callback adapter plus a `connect_to_agent` factory.
It must not contain framing, a reader loop, request IDs, pending queues, JSON-RPC envelopes, method
dispatch, or copied ACP schemas.

## Official API surface

The Worker uses `acp.PROTOCOL_VERSION`, `acp.Client`, `acp.connect_to_agent`,
`acp.ClientSideConnection`, `acp.schema` models, and `acp.text_block`. It keeps its own
`asyncio.create_subprocess_exec(..., start_new_session=True)` lifecycle because Runtime process
groups and Launch fencing cannot be delegated to the SDK.

The Client callback adapter implements typed `request_permission` and `session_update`. Filesystem,
terminal, elicitation, and extension calls are not advertised and fail closed with the official
`RequestError.method_not_found` response if an Agent sends them anyway.

Raw stream observations use the SDK observer hook and retain only direction, method, response/error
classification, and error code. Agent payloads and exception messages are not persisted.

## Pinned external profiles

- Claude: `claude-agent-acp` 0.62.0; default `allow_all` selects `bypassPermissions`.
- Codex: `@agentclientprotocol/codex-acp` 1.1.7; empty process arguments; model tiers
  `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`; default `allow_all` selects
  `agent-full-access`.
- Explicit `allow_in_workspace` and `deny_all` remain immutable Attempt-level overrides.

Executable freezing preserves the selected absolute entrypoint, including a virtual-environment or
wrapper symlink. It performs PATH lookup once but does not dereference the entrypoint into a
different interpreter.

## Upstream sources

- SDK repository and tag: <https://github.com/agentclientprotocol/python-sdk/tree/0.11.0>
- Documentation: <https://agentclientprotocol.github.io/python-sdk/>
- Quickstart: <https://agentclientprotocol.github.io/python-sdk/quickstart/>
- PyPI: <https://pypi.org/project/agent-client-protocol/0.11.0/>
