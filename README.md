<p align="center">
  <img src="assets/logo.svg" alt="skill-foundry logo" width="180" />
</p>

# skill-foundry

> Forge once. Empower every agent.

`skill-foundry` is a small set of agent skills we run in production — workflows we got tired of re-explaining, hardened into portable, inspectable, versioned packages. Each skill ships with its scripts, prompts, references, and recovery rules, so you install a capability once and reuse it across Codex, Claude-style runtimes, and your own agent environments.

## Why skill-foundry

- **Production-proven, not aspirational** — every skill here earns its place doing real work in real runs, not by sounding good in a README.
- **Evidence over trust** — skills are verified by running them against a real CLI and capturing what actually happened (that is what `asset-validation` does).
- **Built to survive interruption** — long multi-agent work carries durable state and recovery rules, so a paused or crashed run resumes instead of restarting.
- **Portable & inspectable** — instructions, scripts, and references live together in Git; you version and audit behavior instead of trusting undocumented prompts.

## The Skills

### `agent-swarm` — task-tree orchestration for multi-agent runs

Successor to `ultra-team`. Coordinates one foreground Root session and background child sessions through a Python Runtime: explicit task tree, dispatch / implement / review / fix roles, durable SQLite state, lifecycle hooks, outbox actions, and recovery that must use `recover` (never silently fall back to `init`). Dormant by default; activates only on an explicit request such as `agent-swarm`, `agent swarm`, `agentswram`, or `蜂群模式`, or when a Runtime-injected `[ORCHESTRATION IDENTITY]` block is present.

**Reach for it when** large work needs delegated children, durable tracking, review loops, and safe resume.

### `asset-validation` — evidence-backed acceptance for agent assets

Most skills, plugins, rules, and agents are never actually exercised — they are eyeballed, shipped, and trusted. `asset-validation` closes that gap. It runs the asset-under-test as a **real interactive CLI** (in tmux, never a stand-in subagent), feeds real tasks, observes what happened, independently re-verifies, captures evidence, and cleans up the sandbox.

It includes progressive task ladders, clean post-fix PASS gates, typed staging profiles (`skill` / `plugin` / `agent` / `rule`), secret redaction, and budgeted unattended runs.

**Reach for it when** validating a skill, plugin, rule, or agent before release, or re-checking one after changes.

### `browser-harness` — browser acceptance scaffolding

Frontend acceptance helper around [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser). Resolves target shape (URL / static HTML / project dir), starts a dev server when needed, prepares login state, injects a stable `APP_URL`, and collects screenshot + console + network evidence. Step-level browser actions stay on the agent-browser CLI; this skill owns prepare / login / evidence / cleanup.

**Reach for it when** doing smoke checks, journey prep with `APP_URL`, interactive browser exploration, or reusable headed login profiles.

### `awesome-presentation` — content-first React slide decks

Turns a presentation idea into a runnable React deck. The hard gate is content discovery first: grilling, outline approval, then scaffold / pages / build. Uses the open-source [awesome-presentation](https://github.com/MarioJames/awesome-presentation) scaffold (layouts, components, deck rules, offline single-file build).

**Reach for it when** building a tech talk, training deck, product narrative, or management report — even from a vague one-liner.

### `workspace-knowledge-graph` — multi-repo workspace routing and relations

Multi-repo workspaces accumulate tribal knowledge about ownership, connections, and agent entry points. This skill maintains a graph: `AGENTS.md` / `CLAUDE.md` / `MEMORY.md` root routes, `.workspace/` declarations, per-repo index docs, and evidence-backed cross-repo relations. Scan → research / write / review → `init` / `validate`.

Human-facing workspace artifacts default to Chinese; machine tokens (paths, keys, commands) stay as-is.

**Reach for it when** bootstrapping or refreshing a multi-repo knowledge graph, task routing, or relation map.

## Install

Install with the [`skills`](https://github.com/vercel-labs/skills) CLI:

```bash
# Everything
npx skills add MarioJames/skill-foundry --all

# One skill
npx skills add MarioJames/skill-foundry --skill agent-swarm
npx skills add MarioJames/skill-foundry --skill asset-validation
npx skills add MarioJames/skill-foundry --skill browser-harness
npx skills add MarioJames/skill-foundry --skill awesome-presentation
npx skills add MarioJames/skill-foundry --skill workspace-knowledge-graph

# Target a specific agent, or install globally
npx skills add MarioJames/skill-foundry --all -a claude-code   # or: -a codex
npx skills add MarioJames/skill-foundry --all -g
```

Restart or reload the target agent runtime after installation so it can discover the skills.

### Manual Fallback

If your runtime does not support `npx skills add`, clone the repository and copy the skill directories directly.

Codex:

```bash
git clone https://github.com/MarioJames/skill-foundry.git
cd skill-foundry
mkdir -p ~/.codex/skills
cp -R skills/agent-swarm skills/asset-validation skills/browser-harness \
  skills/awesome-presentation skills/workspace-knowledge-graph ~/.codex/skills/
```

Claude-style runtimes:

```bash
git clone https://github.com/MarioJames/skill-foundry.git
cd skill-foundry
mkdir -p ~/.claude/skills
cp -R skills/agent-swarm skills/asset-validation skills/browser-harness \
  skills/awesome-presentation skills/workspace-knowledge-graph ~/.claude/skills/
```

Verify the installation:

```bash
test -f ~/.codex/skills/agent-swarm/SKILL.md
test -f ~/.codex/skills/asset-validation/SKILL.md
test -f ~/.codex/skills/browser-harness/SKILL.md
test -f ~/.codex/skills/awesome-presentation/SKILL.md
test -f ~/.codex/skills/workspace-knowledge-graph/SKILL.md
```

### Update Manual Installs

```bash
cd skill-foundry
git pull
rm -rf ~/.codex/skills/agent-swarm ~/.codex/skills/asset-validation \
  ~/.codex/skills/browser-harness ~/.codex/skills/awesome-presentation \
  ~/.codex/skills/workspace-knowledge-graph
cp -R skills/agent-swarm skills/asset-validation skills/browser-harness \
  skills/awesome-presentation skills/workspace-knowledge-graph ~/.codex/skills/
```

## Usage

After installation, invoke the installed skills through normal agent requests.

Orchestrate a large task tree:

```text
Run this with agent-swarm and coordinate implementation, validation, and final review.
```

Validate an asset:

```text
Use asset-validation to validate this skill before release.
```

Browser acceptance:

```text
Use browser-harness to prepare the app, open it, and collect screenshot + console + network evidence.
```

Build a presentation:

```text
Use awesome-presentation to grill the talk outline, then scaffold the React deck after I approve the Deck Spec.
```

Bootstrap or refresh a multi-repo knowledge graph:

```text
Use workspace-knowledge-graph to scan this workspace, build the knowledge graph, and refresh AGENTS.md.
```

Each skill defines its own activation rules in `SKILL.md`. In particular, `agent-swarm` is dormant by default and only activates on an explicit orchestration request or an injected orchestration identity.

## Repository Layout

```text
skill-foundry/
├── assets/
│   └── logo.svg
├── skills/
│   ├── agent-swarm/
│   │   ├── SKILL.md
│   │   ├── hooks/
│   │   ├── references/
│   │   └── scripts/
│   ├── asset-validation/
│   │   ├── SKILL.md
│   │   ├── assets/
│   │   ├── references/
│   │   └── scripts/
│   ├── browser-harness/
│   │   ├── SKILL.md
│   │   └── scripts/
│   ├── awesome-presentation/
│   │   ├── SKILL.md
│   │   ├── agents/
│   │   └── references/
│   ├── workspace-knowledge-graph/
│   │   ├── SKILL.md
│   │   ├── agents/
│   │   ├── references/
│   │   └── scripts/
│   └── docs/
│       └── specs/
├── LICENSE
└── README.md
```

Installable skill packages:

- `skills/agent-swarm/`
- `skills/asset-validation/`
- `skills/browser-harness/`
- `skills/awesome-presentation/`
- `skills/workspace-knowledge-graph/`

## Verify

Useful local checks before publishing changes:

```bash
find skills -name SKILL.md -print
```

```bash
python3 - <<'PY'
from pathlib import Path
for path in Path("skills").rglob("*.py"):
    compile(path.read_text(), str(path), "exec")
print("python syntax ok")
PY
```

```bash
find skills -type f -name '*.md' -print
```

## License

Apache-2.0. See [LICENSE](LICENSE).
