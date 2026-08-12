# Plugin acceptance strategy (v1 deep)

Apply [common.md](common.md) for the shared dimensions. Below is what is specific to plugin assets.

Distribution unit: evaluate the plugin as the installable distribution unit, not as isolated files. Inspect the applicable `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, or legacy root `plugin.json` for stable name/version, declared capabilities, bundled skills/agents/hooks, and any marketplace metadata. A plugin that works only when hand-copied from source but cannot be staged or distributed is AMBER or FAIL.

Install process: install produces a correct session-local plugin load path; isolated env vars redirect writes; the core path runs end-to-end. `acc launch --round <round_id>` auto-stages plugin assets under `ACCEPTANCE_SANDBOX` before starting the host CLI, then launches Claude with sandbox `--settings` and `--plugin-dir`. It must not write bundled skills/agents into a real or symlinked HOME skill root.

Internal components: after staging, the bundled agents/skills/hooks are discoverable by the host through the staged plugin and actually fire. A plugin round must not launch an empty host CLI and then ask for a bundled skill; if the skill/agent is absent from the sandboxed host, record a FAIL.

Unattended setup: if the plugin requires initialization, the path must be explicit and repeatable without interactive prompts (general configuration rule: common.md).

Composition: if the plugin depends on other skills, agents, MCP servers, apps, or host features, the strategy must name those dependencies and test the missing-dependency path. A plugin should fail clearly when a dependency is absent, not silently fall back to hand-written behavior.

Cross-host coverage: if the plugin targets both Claude and Codex, the Codex path is currently rig-blocked (session plugin staging is Claude-only). Keep full evidence for the Claude host path and mark the Codex path as `rig-blocked` in the verdict, not `environment-blocked`. **DO NOT** retry the Codex path expecting a different result.

Usage and telemetry: if the plugin advertises usage logging, metrics, or adoption hooks, verify that the logging is scoped, non-sensitive, and documented. If no usage telemetry exists, that is acceptable; do not require telemetry unless the plugin claims it.

Explicit invocation: every plugin task prompt must name the bundled skill or agent to use (for example: "Use the `echo` skill from `toy-echo-plugin` or the `echo-agent`; do not answer by hand"). The GREEN criteria must require visible transcript evidence of the component invocation, such as `Skill(echo)`, the named agent, or the plugin's declared command. A correct-looking answer without visible plugin/agent/command evidence is a bypass and must be recorded as FAIL or CONDITIONAL, then followed by an automatic fix/rerun if the fix stays inside the asset-under-test or strategy/task design. **DO NOT** stop to ask whether to continue a fix round in unattended mode.

Isolation evidence: the asset-under-test runs the real host CLI with the `acc start` isolation env; the observe-loop spine, scratch rules, and cleanup contract live in references/unattended-execution.md. **DO NOT** use real `~/.claude` or `~/.codex` state as evidence of plugin install behavior — staging, marketplace/profile roots, and `ACCEPTANCE_TMPDIR` keep round writes isolated while the invoking HOME is preserved for auth.

Hard fails: pollutes the real `~/.codex` or `~/.claude/settings.json`; a component installs but is unusable.

## Gotchas
- Stubbing the host CLI defeats the test — the asset is never really used. Run real, isolate via env vars, clean up after.
