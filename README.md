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

### `agents-orchestrator` — Agents orchestration patterns and routing

`agents-orchestrator` is an aggregation and routing layer for reusable Agents orchestration patterns, not one specific tree topology. It selects and composes parallel Swarm, develop-review-improve, verification-fix, RAVF (Review-Argue-Vote-Fix), and read-only multi-session review. One TypeScript/Bun Runtime gives every recipe append-only Attempt/Launch history, durable SQLite facts, idempotent Effects, bounded loops, and recovery that must use `recover` (never silently fall back to `init`). Tasks and dependencies may form a tree or graph internally; that representation is an execution detail rather than the definition of Orchestrator.

Explicit requests start the selected recipe. During ordinary work the skill may recommend — but never auto-start — a recipe only when it sees a concrete signal: multiple substantial independent workstreams, repeated failing unit/browser validation, or a high-risk change that warrants independent adjudication. Complexity alone, ordinary reviews, paths, links, and quoted examples are outside that boundary.

Codex ACP is the default Backend/profile; Claude CLI remains available through explicit `--backend claude_cli`. ACP stores real Agent-issued Session IDs, fences detached Workers and Launches, negotiates advertised model/permission options, and can load Agent-owned history without persisting dialogue locally. A dependency-free bootstrap installs the exact locked SDK plus Codex and Claude Code ACP Agents into `$HOME/.agents-orchestrator/dependencies`; Claude is prepared but never selected automatically, and the repository contains no dependency directory or generated Runtime bundle.

**Reach for it when** work benefits from explicit Agents coordination, durable convergence loops, independent adjudication, or safe resume.

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

Install with the [`skills`](https://github.com/vercel-labs/skills) CLI (`pnpm dlx` or `npx` can
replace `bunx` when Bun is unavailable):

```bash
# Everything
bunx skills add MarioJames/skill-foundry --all

# One skill
bunx skills add MarioJames/skill-foundry --skill agents-orchestrator
bunx skills add MarioJames/skill-foundry --skill asset-validation
bunx skills add MarioJames/skill-foundry --skill browser-harness
bunx skills add MarioJames/skill-foundry --skill awesome-presentation
bunx skills add MarioJames/skill-foundry --skill workspace-knowledge-graph

# Target a specific agent, or install globally
bunx skills add MarioJames/skill-foundry --all -a claude-code   # or: -a codex
bunx skills add MarioJames/skill-foundry --all -g
```

Restart or reload the target agent runtime after installation so it can discover the skills.

The first Runtime launch requires Bun and network access. It installs the exact `bun.lock` graph
into `$HOME/.agents-orchestrator/dependencies` (override with
`$AGENTS_ORCHESTRATOR_DEPENDENCY_HOME`) and reuses that verified content-addressed cache on later
commands. Bun is not installed automatically. Codex remains the default execution profile; Claude
ACP is installed into the same managed tree but is not selected or executed automatically. Gemini
is installed only when explicitly selected. The repository and installed Skill do not contain or
generate `node_modules`.

Use `--backend claude_cli` only when explicitly choosing the legacy Claude CLI Backend.

### Manual Fallback

If your runtime does not support `skills add`, clone the repository and copy the skill directories directly.

Codex:

```bash
git clone https://github.com/MarioJames/skill-foundry.git
cd skill-foundry
mkdir -p ~/.codex/skills
cp -R skills/agents-orchestrator skills/asset-validation skills/browser-harness \
  skills/awesome-presentation skills/workspace-knowledge-graph ~/.codex/skills/
```

Claude-style runtimes:

```bash
git clone https://github.com/MarioJames/skill-foundry.git
cd skill-foundry
mkdir -p ~/.claude/skills
cp -R skills/agents-orchestrator skills/asset-validation skills/browser-harness \
  skills/awesome-presentation skills/workspace-knowledge-graph ~/.claude/skills/
```

Verify the installation:

```bash
test -f ~/.codex/skills/agents-orchestrator/SKILL.md
test -f ~/.codex/skills/agents-orchestrator/scripts/bootstrap.ts
test -f ~/.codex/skills/agents-orchestrator/bun.lock
test -f ~/.codex/skills/asset-validation/SKILL.md
test -f ~/.codex/skills/browser-harness/SKILL.md
test -f ~/.codex/skills/awesome-presentation/SKILL.md
test -f ~/.codex/skills/workspace-knowledge-graph/SKILL.md
```

### Update Manual Installs

```bash
cd skill-foundry
git pull
rm -rf ~/.codex/skills/agents-orchestrator ~/.codex/skills/asset-validation \
  ~/.codex/skills/browser-harness ~/.codex/skills/awesome-presentation \
  ~/.codex/skills/workspace-knowledge-graph
cp -R skills/agents-orchestrator skills/asset-validation skills/browser-harness \
  skills/awesome-presentation skills/workspace-knowledge-graph ~/.codex/skills/
```

## Usage

After installation, invoke the installed skills through normal agent requests.

Orchestrate substantial parallel work:

```text
Use agents-orchestrator in swarm mode to coordinate implementation, validation, and final review.
```

Route a generic bounded loop from the current work state:

```text
Use agents-orchestrator in loop mode, at most 3 iterations, and stop when the acceptance tests pass.
```

Converge failing unit and browser validation:

```text
Use agents-orchestrator in verification-fix mode. Re-run tests, diagnose failures independently, fix them, and repeat until a clean pass.
```

Run ROI-aware review convergence:

```text
Use agents-orchestrator in RAVF mode: in each Review round, five Reviewers may contribute up to 25 original findings; a fixed five-Agent Argue pool challenges that round's complete Review; a fixed five-Agent low-cost Vote pool votes on every original issue; then the main Agent integrates original, revised, and rejected decisions before one coordinated fix. Any new post-fix findings enter another complete Argue → Vote → Fix round until a fresh Review is clean or a declared guard is reached.
```

Review a plan through independent consensus:

```text
Use agents-orchestrator for a multi-Agent plan review with 3 independent reviewers and a consensus result.
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

Each skill defines its own activation rules in `SKILL.md`. `agents-orchestrator` starts only after
explicit authorization; an implicit high-signal match may produce one recommendation but cannot
initialize a Run. Quoted names, file paths, links, and ordinary reviews do not activate it.

## Repository Layout

```text
skill-foundry/
├── assets/
│   └── logo.svg
├── skills/
│   ├── agents-orchestrator/
│   │   ├── SKILL.md
│   │   ├── agents/
│   │   ├── assets/
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

- `skills/agents-orchestrator/`
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
cd skills/agents-orchestrator
bun run typecheck
```

```bash
find skills -type f -name '*.md' -print
```

## License

Apache-2.0. See [LICENSE](LICENSE).
