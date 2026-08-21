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

Frontend acceptance helper around [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser). Resolves target shape (URL / static HTML / project dir), starts a dev server when needed, prepares login state, injects a stable `APP_URL`, and collects screenshot + console + network evidence. Step-level browser actions stay on the agent-browser CLI; temporary public review delegates standard tunnel lifecycle to `cloudflare-quick-tunnel` while retaining project-specific Host, environment, and URL mapping here.

**Reach for it when** doing smoke checks, journey prep with `APP_URL`, interactive browser exploration, or reusable headed login profiles.

### `cloudflare-quick-tunnel` — temporary public tunnel lifecycle

Creates standard anonymous Cloudflare Quick Tunnels for local HTTP services and owns the full start / status / stop / cleanup lifecycle. Its Bun CLI uses an isolated empty config, returns a verified tunnel root URL, tracks exact process state, and keeps cleanup scoped to one caller-provided state directory; project URL mapping and custom environment belong to the caller.

**Reach for it when** a local service needs a temporary public review URL; use it through `browser-harness` when the service is part of frontend acceptance.

### `herdr` — proactive multi-pane routing for Herdr

`herdr` shortens the critical path by routing independent work to the right pane, tab, or workspace instead of serializing everything in the caller. It classifies each lane as `oneshot`, `service`, or `coding-agent`; matches target directories using cwd and Git roots; verifies every created resource; and returns an explicit cleanup contract.

The bundled Bun/TypeScript router can split the caller tab, create a tab in an existing directory-matched workspace, or create a new workspace when no safe match exists. It preserves focus and rolls back newly created resources when verification fails.

**Reach for it when** independent commands, services, checks, or coding-agent deliverables can overlap safely and the Herdr CLI is available.

### `trigger-build-workflow` — safe commit, push, and optional build dispatch

Submits scoped Git changes and dispatches a release workflow only when the repository exposes a compatible `workflow_dispatch` contract. A bundled detector checks for channel, version, and changelog inputs; repositories without that contract automatically use a normal commit-and-push path without inventing release metadata.

**Reach for it when** committing and pushing changes, triggering a build, or publishing a beta/production release across repositories with different CI capabilities.

### `persistent-ssh-ops` — reusable remote-operation sessions

Keeps one TTY-backed SSH session per host through multi-step maintenance, deployment, log, and incident workflows. It discovers SSH aliases from the effective login shell, falls back to OpenSSH `Host` aliases, preserves remote context, verifies changes, redacts secret-bearing output, and closes every task-owned session.

**Reach for it when** remote work requires more than one command or interactive diagnostics.

### `provision-xray-hy2-node` — mixed Xray and Hysteria 2 runbook

Provisions or audits Xray VLESS Vision/REALITY on TCP/443 alongside Hysteria 2 on UDP/443, including DNS, DNS-01 certificates, layered firewalls, generic Mihomo clients, rollback, and external acceptance. All committed values are placeholders; generated credentials remain runtime-only.

**Reach for it when** setting up, migrating, troubleshooting, or accepting a mixed Xray + HY2 server.

### `changelog-writing` — audience-routed release notes

Turns release evidence into either customer-facing outcomes or technical/internal notes, with a stable JSON contract for workflow consumers and a package-free Git source collector.

**Reach for it when** drafting changelogs, GitHub Release bodies, beta notes, production updates, or engineering handoffs.

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
bunx skills add MarioJames/skill-foundry --skill cloudflare-quick-tunnel
bunx skills add MarioJames/skill-foundry --skill herdr
bunx skills add MarioJames/skill-foundry --skill trigger-build-workflow
bunx skills add MarioJames/skill-foundry --skill persistent-ssh-ops
bunx skills add MarioJames/skill-foundry --skill provision-xray-hy2-node
bunx skills add MarioJames/skill-foundry --skill changelog-writing
bunx skills add MarioJames/skill-foundry --skill awesome-presentation
bunx skills add MarioJames/skill-foundry --skill workspace-knowledge-graph

# Target a specific agent, or install globally
bunx skills add MarioJames/skill-foundry --all -a claude-code   # or: -a codex
bunx skills add MarioJames/skill-foundry --all -g
```

Restart or reload the target agent runtime after installation so it can discover the skills.

`herdr` requires Bun and an installed Herdr CLI. It does not use `HERDR_ENV` or other inherited
environment variables as an availability gate; the actual CLI response is authoritative, including
from agent sandboxes that do not inherit the parent Herdr environment.

Bun 1.3 or newer is the runtime for every bundled executable script and hook. No bundled
entrypoint is implemented in Python or Bash; external tools and user-provided commands retain
their own runtime requirements.

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
  skills/cloudflare-quick-tunnel \
  skills/herdr skills/trigger-build-workflow skills/persistent-ssh-ops \
  skills/provision-xray-hy2-node skills/changelog-writing \
  skills/awesome-presentation skills/workspace-knowledge-graph ~/.codex/skills/
```

Claude-style runtimes:

```bash
git clone https://github.com/MarioJames/skill-foundry.git
cd skill-foundry
mkdir -p ~/.claude/skills
cp -R skills/agents-orchestrator skills/asset-validation skills/browser-harness \
  skills/cloudflare-quick-tunnel \
  skills/herdr skills/trigger-build-workflow skills/persistent-ssh-ops \
  skills/provision-xray-hy2-node skills/changelog-writing \
  skills/awesome-presentation skills/workspace-knowledge-graph ~/.claude/skills/
```

Verify the installation:

```bash
test -f ~/.codex/skills/agents-orchestrator/SKILL.md
test -f ~/.codex/skills/agents-orchestrator/scripts/bootstrap.ts
test -f ~/.codex/skills/agents-orchestrator/bun.lock
test -f ~/.codex/skills/asset-validation/scripts/acc.ts
test -f ~/.codex/skills/browser-harness/scripts/bh.ts
test -f ~/.codex/skills/cloudflare-quick-tunnel/scripts/cqt.ts
test -f ~/.codex/skills/herdr/scripts/route-lane.ts
test -f ~/.codex/skills/trigger-build-workflow/scripts/detect-build-workflow.ts
test -f ~/.codex/skills/trigger-build-workflow/scripts/dispatch-build-workflow.ts
test -f ~/.codex/skills/persistent-ssh-ops/SKILL.md
test -f ~/.codex/skills/persistent-ssh-ops/scripts/scan-hosts.ts
test -f ~/.codex/skills/provision-xray-hy2-node/references/templates.md
test -f ~/.codex/skills/changelog-writing/scripts/collect-commits.ts
test -f ~/.codex/skills/awesome-presentation/SKILL.md
test -f ~/.codex/skills/workspace-knowledge-graph/scripts/workspace_graph.ts
```

### Update Manual Installs

```bash
cd skill-foundry
git pull
rm -rf ~/.codex/skills/agents-orchestrator ~/.codex/skills/asset-validation \
  ~/.codex/skills/browser-harness ~/.codex/skills/cloudflare-quick-tunnel \
  ~/.codex/skills/herdr ~/.codex/skills/trigger-build-workflow \
  ~/.codex/skills/persistent-ssh-ops ~/.codex/skills/provision-xray-hy2-node \
  ~/.codex/skills/changelog-writing ~/.codex/skills/awesome-presentation \
  ~/.codex/skills/workspace-knowledge-graph
cp -R skills/agents-orchestrator skills/asset-validation skills/browser-harness \
  skills/cloudflare-quick-tunnel \
  skills/herdr skills/trigger-build-workflow skills/persistent-ssh-ops \
  skills/provision-xray-hy2-node skills/changelog-writing \
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

Expose a local HTTP service temporarily:

```text
Use cloudflare-quick-tunnel to publish http://127.0.0.1:4173 for remote review, report its status, and clean it up when I finish.
```

Route independent work across Herdr panes and workspaces:

```text
Use herdr to run independent checks in parallel, route different cwd targets to their matching workspaces, and clean up oneshot panes after collecting results.
```

Submit changes with workflow-aware fallback:

```text
Use trigger-build-workflow to commit and push these files; dispatch a build only if this repository supports the expected release inputs.
```

Operate a remote server through one persistent session:

```text
Use persistent-ssh-ops to inspect the service, apply the requested config change, verify it, and close the SSH session.
```

Provision a mixed proxy node:

```text
Use provision-xray-hy2-node to add Hysteria 2 beside the existing Xray listener and run external acceptance.
```

Draft release notes:

```text
Use changelog-writing to produce customer-facing production notes from the changes since v1.2.0.
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
`herdr` may activate implicitly when a concrete independent lane can shorten the critical path.

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
│   ├── cloudflare-quick-tunnel/
│   │   ├── SKILL.md
│   │   ├── agents/
│   │   ├── scripts/
│   │   └── tests/
│   ├── herdr/
│   │   ├── SKILL.md
│   │   ├── agents/
│   │   └── scripts/
│   ├── trigger-build-workflow/
│   │   ├── SKILL.md
│   │   ├── agents/
│   │   ├── scripts/
│   │   └── test/
│   ├── persistent-ssh-ops/
│   │   ├── SKILL.md
│   │   ├── agents/
│   │   └── scripts/
│   ├── provision-xray-hy2-node/
│   │   ├── SKILL.md
│   │   ├── agents/
│   │   └── references/
│   ├── changelog-writing/
│   │   ├── SKILL.md
│   │   ├── agents/
│   │   ├── references/
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
- `skills/cloudflare-quick-tunnel/`
- `skills/herdr/`
- `skills/trigger-build-workflow/`
- `skills/persistent-ssh-ops/`
- `skills/provision-xray-hy2-node/`
- `skills/changelog-writing/`
- `skills/awesome-presentation/`
- `skills/workspace-knowledge-graph/`

## Verify

Useful local checks before publishing changes:

```bash
bun scripts/check-runtime-contract.ts
find skills -name SKILL.md -print
find skills -path '*/node_modules' -prune -o -type f \
  \( -path '*/scripts/*' -o -path '*/hooks/*' \) ! -name '*.ts' -print
```

The pre-existing agents-orchestrator Runtime keeps its package-level checks:

```bash
(cd skills/agents-orchestrator && bun run typecheck && bun run test)

# Package-free migrated skills run their behavior tests directly with Bun.
bun test skills/asset-validation/tests
bun test skills/browser-harness/tests
bun test skills/cloudflare-quick-tunnel/tests
bun test skills/workspace-knowledge-graph/test
bun test skills/trigger-build-workflow/test
```

```bash
bun skills/herdr/scripts/route-lane.ts --help
bun skills/herdr/scripts/probe-workspace.ts --help
bun skills/trigger-build-workflow/scripts/detect-build-workflow.ts --help
bun skills/trigger-build-workflow/scripts/dispatch-build-workflow.ts --help
bun skills/changelog-writing/scripts/collect-commits.ts --help
bun skills/persistent-ssh-ops/scripts/scan-hosts.ts --help
bun skills/asset-validation/scripts/acc.ts --help
bun skills/browser-harness/scripts/bh.ts --version
bun skills/cloudflare-quick-tunnel/scripts/cqt.ts --version
bun skills/workspace-knowledge-graph/scripts/workspace_graph.ts --help
```

```bash
find skills -type f -name '*.md' -print
```

## License

Apache-2.0. See [LICENSE](LICENSE).
