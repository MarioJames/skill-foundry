# ACP Python SDK Runtime Boundary

Agents Orchestrator is an ACP Client and Runtime orchestrator. It does not implement an ACP Server or a
second ACP protocol stack.

## First-use dependency installation

- The skill contains no ACP wheels, ZIP archives, Node packages, or generated dependency bundle.
- The first ACP initialization installs into
  `$HOME/.agents-orchestrator/dependencies`; override it with
  `$AGENTS_ORCHESTRATOR_DEPENDENCY_HOME` (legacy `$AGENT_SWARM_DEPENDENCY_HOME`).
- Python installation prefers `uv`, then falls back to the active interpreter's `pip`. Exact
  versions are `agent-client-protocol==0.11.0`, `pydantic==2.13.4`,
  `pydantic-core==2.46.4`, `annotated-types==0.8.0`, `typing-extensions==4.16.0`, and
  `typing-inspection==0.4.2`.
- Agent installation prefers Bun, then pnpm, then npm. It installs Codex ACP 1.1.7 and Claude Code
  ACP 0.62.0 by default; an explicitly selected Gemini profile installs Gemini CLI 0.41.0.
- Every install uses an exact version, a process lock, a private staging directory, validation, and
  atomic replacement. A complete target is reused; an incomplete target is removed and rebuilt.
- Python and Node dependencies stay inside the skill dependency home. The Runtime never mutates
  global Python or global package-manager directories. Custom ACP commands are never installed.

First startup therefore requires network access plus `uv` or `pip` and preferably Bun. Installation
fails before Run creation if a pinned dependency cannot be installed. Existing Runtime cleanup
semantics still apply only to live Workers, Agent processes, sockets, Launches, and Effects; the
dependency home is persistent reusable support state.

## Ownership boundary

The official SDK exclusively owns:

- stdio framing and JSON-RPC serialization;
- request IDs, response matching, pending request lifecycle, and method dispatch;
- ACP schema parsing and serialization;
- connection and async request lifecycle.

Agents Orchestrator owns:

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

## Pinned ACP profiles

- Claude: `claude-agent-acp` 0.62.0; default `allow_all` selects `bypassPermissions`.
- Codex (default Backend profile): `@agentclientprotocol/codex-acp` 1.1.7; empty process arguments; model tiers
  `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`; default `allow_all` selects
  `agent-full-access`.
- Gemini: `@google/gemini-cli` 0.41.0 via `gemini --acp`; default
  `allow_in_workspace` and Agent-advertised models.
- Explicit `allow_in_workspace` and `deny_all` remain immutable Attempt-level overrides.

Select the legacy Claude CLI Backend with `--backend claude_cli`. A Run freezes its Backend,
profile allowlist, default profile, managed executable, models, and permission policy at
initialization. Codex remains the default execution profile; the default Claude Code ACP install
only makes that explicit profile immediately available. Manual fallback commands are:

```bash
bun add -g @agentclientprotocol/codex-acp@1.1.7
bun add -g @agentclientprotocol/claude-agent-acp@0.62.0
bun add -g @google/gemini-cli@0.41.0
```

Executable freezing preserves the selected absolute entrypoint, including a virtual-environment or
wrapper symlink. It performs PATH lookup once but does not dereference the entrypoint into a
different interpreter.

## Upstream sources

- SDK repository and tag: <https://github.com/agentclientprotocol/python-sdk/tree/0.11.0>
- Documentation: <https://agentclientprotocol.github.io/python-sdk/>
- Quickstart: <https://agentclientprotocol.github.io/python-sdk/quickstart/>
- PyPI: <https://pypi.org/project/agent-client-protocol/0.11.0/>
