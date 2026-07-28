# ACP TypeScript SDK Runtime boundary

Agents Orchestrator is an ACP Client and durable Runtime. It uses the official TypeScript SDK for
the protocol and does not implement a second framing or RPC stack.

## First-use dependency installation

All commands enter through the dependency-free `scripts/bootstrap.ts`. Bun is a required
prerequisite and is never installed automatically. A clean first launch requires network access.

The bootstrap:

1. hashes Runtime TypeScript sources, hooks, `package.json`, `bun.lock`, platform, architecture,
   Bun version, and dependency variant;
2. copies those sources into a private staging directory;
3. runs `bun install --frozen-lockfile --ignore-scripts`;
4. validates exact package versions, entry files, and executable permissions;
5. writes a private manifest and atomically publishes a content-addressed cache;
6. executes the cached Runtime.

The default dependency home is `$HOME/.agents-orchestrator/dependencies`. Override it with
`$AGENTS_ORCHESTRATOR_DEPENDENCY_HOME`. The historical environment spelling remains a Runtime-only
migration interface for existing installations; no separate legacy skill is shipped. Directories
are mode 0700 and lock metadata is mode 0600. Concurrent first launches share one installer. An
incomplete cache is never executed; damage causes an atomic rebuild. Installation failure occurs
before Run creation and removes staging and lock residue.

The locked base dependency tree contains:

| Package | Exact version | Purpose |
| --- | --- | --- |
| `@agentclientprotocol/sdk` | `1.3.0` | official ACP Client schemas and transport |
| `@agentclientprotocol/codex-acp` | `1.1.7` | default Codex ACP Agent |
| `@agentclientprotocol/claude-agent-acp` | `0.62.0` | explicitly selectable Claude Code ACP Agent |
| `@openai/codex` | `0.145.0` | Codex ACP runtime dependency |
| `@anthropic-ai/claude-agent-sdk` | `0.3.219` | Claude ACP runtime dependency |

Codex and Claude share this managed tree and common SDK. Codex is the default profile. Claude is
prepared on first use but is never selected or executed automatically. The explicit Gemini profile
adds `@google/gemini-cli@0.41.0` in its own digest variant. An absolute custom command is never
installed, rewritten, or replaced.

The repository and installed Skill contain no `node_modules`; the managed cache is persistent
support state outside both. A Run freezes its managed executable to the stable absolute
`<dependency-home>/bin/<agent>` path. Deleting or damaging the content cache restores the same
locked version behind that path and never upgrades silently.

## Ownership boundary

The official SDK owns:

- newline-delimited transport framing and RPC serialization;
- request/response correlation, pending request lifecycle, and method dispatch;
- ACP schemas, protocol version, typed methods, and connection lifecycle.

Agents Orchestrator owns:

- detached Worker and Agent process groups;
- append-only Launch ownership, PID, nonce, and control-socket fencing;
- permission decisions returned through the typed Client callback;
- advertised Session model/mode selection;
- Runtime finish, retry, reconciliation, stop, and cleanup gates;
- bounded structural diagnostics with raw Agent error text removed.

`scripts/backends/acp/client.ts` is only the typed callback adapter and SDK connection factory. It
must not add its own reader loop, request IDs, pending queues, RPC envelopes, dispatch, or copied
ACP schemas.

## Official API surface

The Worker uses `PROTOCOL_VERSION`, `client()`, `methods`, `ndJsonStream()`, and the typed
`ClientConnection` / `ClientContext` request and notification APIs. It owns the child process via
`node:child_process` because process groups and Launch fencing are Runtime responsibilities.

The Client registers only permission requests and Session updates. Unsupported callbacks are not
advertised and therefore fail closed through the SDK. Logged Session observations retain only
structural fields such as update type, method classification, and numeric error code. Prompts,
tokens, API keys, Agent payloads, and exception messages are not persisted.

## Profiles and Session configuration

- Codex: adapter `1.1.7`; default profile; model tiers `gpt-5.6-sol`, `gpt-5.6-terra`, and
  `gpt-5.6-luna`; default `allow_all` selects an advertised full-access mode.
- Claude: adapter `0.62.0`; explicit selection only; default `allow_all` selects advertised
  `bypassPermissions` when available.
- Gemini: CLI `0.41.0` via `gemini --acp`; explicit selection only; default
  `allow_in_workspace`.
- Custom: absolute user-supplied executable and argument array; no managed installation.

`allow_in_workspace` validates advertised filesystem locations. Its no-location exception accepts
only exact Bun Runtime commands for `bootstrap-cwd`, `action-schema`, or a one-object `action
--stdin` pipeline in the authorized cwd. `deny_all` chooses only an advertised rejection option.
`prompt` is rejected because the Worker has no interactive permission UI. Explicit models and
modes must be offered by the Agent; otherwise Session setup fails closed.

The Agent-issued Session ID is stored unchanged. `session-history` starts the frozen profile,
performs `session/load`, collects typed updates only in memory, and terminates the temporary Agent
process group. A missing or lost Session is a structured unavailable result, not a Runtime failure.

## Upstream source

- TypeScript SDK: <https://github.com/agentclientprotocol/typescript-sdk>
