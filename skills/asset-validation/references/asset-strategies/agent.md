# Agent acceptance strategy (v1 deep)

Trigger surface: selected when it should be, not selected when it should not. description is trigger conditions, not a workflow summary; it should discriminate against neighboring agents and neighboring skills with concrete symptoms or task shapes.

Scope: each agent should have a single responsibility and a clear handoff boundary. If it claims multiple unrelated jobs, record AMBER unless the composition is explicitly designed and tested.

Logic: behavior after triggering matches its responsibility; tool boundaries respected. Verify that the agent uses only its intended tools, refuses or hands off out-of-scope work, and does not exceed destructive scope.

Evidence matrix: run positive and negative cases plus neighboring agents. Positive cases must show the agent is selected and performs the expected work; negative cases must show it stays quiet; neighbor cases must show it does not steal triggers.

progressive disclosure: agent prompts should route to references, scripts, or templates only when needed. Large embedded references in the agent definition are AMBER unless the agent cannot function without them.

Configuration: if the agent needs user/team/repo configuration, the config path and missing-config behavior must be documented. It should ask a clear question or fail cleanly, not infer hidden defaults.

Persistent state: if the agent writes persistent state, document the path, schema, retention, and cleanup. Prefer append-only logs, JSON, SQLite, or host-provided persistent data directories; uncontrolled writes to HOME or fixed `/tmp` paths are defects.

Hard fails: steals triggers / misses triggers; exceeds its tool scope.

Task prompts: de-guided — do not tell the asset-under-test which agent should be selected. The prompt should describe the user need naturally and let selection behavior prove itself.

Forensics: require transcript and programmatic evidence where possible: selection trace, tool calls, output artifacts, cleanup state, and any refusal/handoff messages. A correct artifact without evidence of agent selection is a bypass.

## Gotchas
- token parallelism is not meaningful agent use: if the main agent outsources trivial peripheral work while doing the real task by hand, record AMBER or FAIL.
- Agents with broad tool access need stronger negative and destructive-scope tests.
- An agent that merely restates a skill's checklist may be the wrong asset type; prefer a skill unless delegated execution/tool boundaries matter.
