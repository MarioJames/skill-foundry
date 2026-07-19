# Agent acceptance strategy (v1 deep)

Apply [common.md](common.md) for the shared dimensions. Below is what is specific to agent assets.

Selection surface: selected when it should be, not selected when it should not. The description must discriminate against neighboring agents and neighboring skills with concrete symptoms or task shapes (trigger-surface rule: common.md).

Scope: each agent should have a single responsibility and a clear handoff boundary. If it claims multiple unrelated jobs, record AMBER unless the composition is explicitly designed and tested.

Tool boundaries: behavior after triggering matches its responsibility. Verify that the agent uses only its intended tools, refuses or hands off out-of-scope work, and does not exceed destructive scope.

Evidence matrix: run positive and negative cases plus neighboring agents. Positive cases must show the agent is selected and performs the expected work; negative cases must show it stays quiet; neighbor cases must show it does not steal triggers.

Progressive disclosure: agent prompts should route to references, scripts, or templates only when needed. Large embedded references in the agent definition are AMBER unless the agent cannot function without them.

Selection forensics: require transcript and programmatic evidence where possible: selection trace, tool calls, output artifacts, cleanup state, and any refusal/handoff messages. A correct artifact without evidence of agent selection is a bypass.

Agent staging uses a sandbox-local session plugin wrapper (`acc-agent-<name>`) with `--bare`, isolation `--append-system-prompt`, sandbox `--settings`, and `--plugin-dir`, mirroring the skill staging path. The observer should require visible agent-selection transcript evidence (such as `Agent(<name>)` or the declared tool boundary) when positive trigger behavior is tested.

Hard fails: steals triggers / misses triggers; exceeds its tool scope.

## Gotchas
- Agents with broad tool access need stronger negative and destructive-scope tests.
- An agent that merely restates a skill's checklist may be the wrong asset type; prefer a skill unless delegated execution/tool boundaries matter.
