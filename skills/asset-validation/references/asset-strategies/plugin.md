# Plugin acceptance strategy (v1 deep)

Distribution unit: evaluate the plugin as the installable distribution unit, not as isolated files. Inspect `plugin.json` for stable name/version, declared capabilities, bundled skills/agents/hooks, and any marketplace metadata. A plugin that works only when hand-copied from source but cannot be staged or distributed is AMBER or FAIL.

Install process: install produces a correct session-local plugin load path; isolated env vars redirect writes; the core path runs end-to-end. `acc launch --round <round_id>` auto-stages plugin assets under `ACCEPTANCE_SANDBOX` before starting the host CLI, then launches Claude with sandbox `--settings` and `--plugin-dir`. It must not write bundled skills/agents into a real or symlinked HOME skill root.

Sandbox rule: use `ACCEPTANCE_SANDBOX` for the round root and `ACCEPTANCE_TMPDIR` for prompt/criteria/task files, transcripts, installers, and scratch files. Create scratch space with `WORK="$(mktemp -d "${ACCEPTANCE_TMPDIR:-${TMPDIR:-/tmp}}/acc-strategy.XXXXXX")"`; if the path must be persisted, write it inside `"$WORK/.workpath"`; never write fixed /tmp paths such as `/tmp/acc-toy` or `/tmp/acc-work-path.txt`; fixed names collide across rounds and agents.

Internal components: after staging, the bundled agents/skills/hooks are discoverable by the host through the staged plugin and actually fire. A plugin round must not launch an empty host CLI and then ask for a bundled skill; if the skill/agent is absent from the sandboxed host, record a FAIL.

initialization and configuration: if the plugin requires setup, the path must be explicit and repeatable. Prefer documented config files or a structured setup command; hidden defaults, prompts that cannot run unattended, or environment assumptions outside the sandbox are defects.

Persistent data: if the plugin stores data, it must document the location and use a host-supported persistent data directory or a sandboxed round path during acceptance. Fixed `/tmp` paths, uncontrolled writes to real HOME, or unbounded caches are defects.

Hooks and guardrails: plugin Hooks should be on-demand Hooks scoped to the plugin/session, with clear trigger patterns and failure behavior. Broad always-on hooks that block unrelated commands, mutate unrelated files, or silently change tool semantics are hard to trust.

composition: if the plugin depends on other skills, agents, MCP servers, apps, or host features, the strategy must name those dependencies and test the missing-dependency path. A plugin should fail clearly when a dependency is absent, not silently fall back to hand-written behavior.

cross-host coverage: if the plugin targets both Claude and Codex, run or explicitly environment-block both host paths. If one host CLI is absent, keep full evidence for the available host and mark the other path as environment-blocked rather than GREEN.

Usage and telemetry: if the plugin advertises usage logging, metrics, or adoption hooks, verify that the logging is scoped, non-sensitive, and documented. If no usage telemetry exists, that is acceptable; do not require telemetry unless the plugin claims it.

Task prompt schema: `--task-prompts-file` expects a flat JSON object such as `{"t1": "Echo ..."}`. Do not use `{"tasks": [...]}`; `acc feed-task --task t1` will not find nested IDs.

Plugin invocation must be explicit. Every plugin task prompt must name the bundled skill or agent to use (for example: "Use the `echo` skill from `toy-echo-plugin` or the `echo-agent`; do not answer by hand"). The GREEN criteria must require visible transcript evidence of the component invocation, such as `Skill(echo)`, the named agent, or the plugin's declared command (`tr '[:lower:]' '[:upper:]'`). A correct-looking answer without visible plugin/agent/command evidence is a bypass and must be recorded as FAIL or CONDITIONAL, then followed by an automatic fix/rerun if the fix stays inside the asset-under-test or strategy/task design. Do not stop to ask whether to continue a fix round in unattended mode.

Hard fails: pollutes the real `~/.codex` or `~/.claude/settings.json`; a component installs but is unusable.

Real execution + isolation + cleanup: the asset-under-test runs the real host CLI with the `acc start` isolation env. That env preserves the invoking HOME for auth/keychain state, while sandbox settings, plugin staging, marketplace/profile roots, and `ACCEPTANCE_TMPDIR` keep round writes isolated; do not use real ~/.claude or real ~/.codex as evidence of plugin install behavior. After `acc feed-task --round <round_id> --task t1`, wait only for the pane prompt or a short bounded timeout; do not wait for the round DB verdict to stop saying `running`, because `acc finalize` is what changes that state. Capture evidence with `acc capture --round <round_id> --out "$WORK/transcript.txt"`, then call `acc record --round <round_id> --transcript-file "$WORK/transcript.txt" --report <summary>` and `acc finalize` before returning. At round end `acc finalize` kills only this round's `acc-<round_tag>` tmux session, removes this round's isolation roots including `ACCEPTANCE_TMPDIR`, cleans plugin staging, and confirms no pollution. Use `acc cleanup --round <round_id>` only for rounds finalized with `--keep-sandbox` or orphan repair.

## Gotchas
- Stubbing the host CLI defeats the test — the asset is never really used. Run real, isolate via env vars, clean up after.
- Check both Codex and Claude host paths if the plugin targets both; if one host CLI is absent, keep full marketplace evidence and mark that item environment-blocked.
