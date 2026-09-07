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

### `asset-validation` — evidence-backed acceptance for agent assets

Reviews reusable assets with scoped static checks, or runs **real interactive CLI** acceptance when behavioral evidence is requested. The acceptance route stages the asset in isolation, feeds tasks, independently scores the outcome, and cleans up; ordinary review does not start that pipeline.

It includes progressive task ladders, clean post-fix PASS gates, typed staging profiles (`skill` / `plugin` / `agent` / `rule`), secret redaction, and budgeted unattended runs.

**Reach for it when** validating a skill, plugin, rule, or agent before release, or re-checking one after changes.

### `browser-harness` — browser acceptance scaffolding

Frontend acceptance helper around [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser). Resolves target shape (URL / static HTML / project dir), starts a dev server when needed, prepares login state, injects a stable `APP_URL`, and collects screenshot + console + network evidence. Step-level browser actions stay on the agent-browser CLI; temporary public review delegates standard tunnel lifecycle to `cloudflare-quick-tunnel` while retaining project-specific Host, environment, and URL mapping here.

**Reach for it when** doing smoke checks, journey prep with `APP_URL`, interactive browser exploration, or reusable headed login profiles.

### `cloudflare-quick-tunnel` — temporary public tunnel lifecycle

Creates standard anonymous Cloudflare Quick Tunnels for local HTTP services and owns the full start / status / stop / cleanup lifecycle. Its Bun CLI uses an isolated empty config, returns the generated tunnel root URL immediately without probing it, tracks exact process state, and keeps cleanup scoped to one caller-provided state directory; project URL mapping and custom environment belong to the caller.

**Reach for it when** a local service needs a temporary public review URL; use it through `browser-harness` when the service is part of frontend acceptance.

### `herdr` — developer-attached task routing

`herdr` adds routing to an Agent that remains a developer: the owning Agent keeps and executes a concrete primary work slice, while derived work stays local, replacements supersede stale work, and additive independent work can reuse or create an Agent lane. It then classifies each created lane as `oneshot`, `service`, or `coding-agent`, manages ownership and handoff, and joins the result back into the owning Agent. It does not turn the owning Agent into a pure orchestrator unless the user explicitly requests that role.

After the task decision, the bundled Bun/TypeScript resource router can split the caller tab, create a tab in an existing directory-matched workspace, or create a new workspace when no safe match exists. It matches target directories using cwd and Git roots, preserves focus, returns an explicit cleanup contract, and rolls back newly created resources when verification fails.

**Reach for it when** an Agent receives another task mid-run, independent commands or Agent deliverables can overlap safely, or Herdr runtime resources need coordination.

### `trigger-build-workflow` — safe commit, push, and optional build dispatch

Executes explicitly selected commit, push, and build actions without inferring authorization from repository contents. The workflow detector validates channel, version, and changelog inputs only for a requested dispatch; ordinary commits and pushes do not require release metadata.

**Reach for it when** committing and pushing changes, triggering a build, or publishing a beta/production release across repositories with different CI capabilities.

### `persistent-ssh-ops` — reusable remote-operation sessions

Keeps one TTY-backed SSH session per host through multi-step maintenance, deployment, log, and incident workflows. It ships a complete `server_define`/`server_ssh` zsh runtime and initializer, discovers registered profiles before legacy shell aliases, falls back to OpenSSH `Host` aliases, preserves remote context, verifies changes, redacts secret-bearing output, and closes every task-owned session.

**Reach for it when** remote work requires more than one command or interactive diagnostics.

### `provision-xray-hy2-node` — mixed Xray and Hysteria 2 runbook

Provisions or audits Xray VLESS Vision/REALITY on TCP/443 alongside Hysteria 2 on UDP/443, including DNS, DNS-01 certificates, layered firewalls, generic Mihomo clients, rollback, and external acceptance. All committed values are placeholders; generated credentials remain runtime-only.

**Reach for it when** setting up, migrating, troubleshooting, or accepting a mixed Xray + HY2 server.

### `changelog-writing` — audience-routed release notes

Turns release evidence into either customer-facing outcomes or technical/internal notes, with a stable JSON contract for workflow consumers and a package-free Git source collector.

**Reach for it when** drafting changelogs, GitHub Release bodies, beta notes, production updates, or engineering handoffs.

### `awesome-presentation` — content-first React slide decks

Turns presentation materials or a goal into a runnable React deck. When scope is clear, it builds and validates directly; collaborative outline discussion is available when requested or when essential content is missing. Uses the open-source [awesome-presentation](https://github.com/MarioJames/awesome-presentation) scaffold (layouts, components, deck rules, offline single-file build).

**Reach for it when** building a tech talk, training deck, product narrative, or management report — even from a vague one-liner.

### `repo-knowledge-graph` — repository knowledge and cross-project relations

Uses the current Git remote to locate one repository's online graph, domains, entities, and shared knowledge. Project identities, peer-specific paths, and cross-project edges live in one global relation source; cross-project decisions and continuation live in one global memory source.

**Reach for it when** retrieving or maintaining repository knowledge, resolving project identity and paths, following cross-repository dependencies, or continuing earlier project work.

### `tdd` — when to test, and what counts as a test

A thin coding-time gate: default is fast path. Write a test only when the assertion can still fail on a wrong implementation after the files already exist. Pins business rules, mappings, permissions, and bug reproductions; skips scaffolding, copy, layout, and tautological green tests.

**Reach for it when** implementing or changing production code or tests. The skill description is meant to fire on every development change; the body then decides TDD vs skip.

## Install

Install with the [`skills`](https://github.com/vercel-labs/skills) CLI (`pnpm dlx` or `npx` can
replace `bunx` when Bun is unavailable):

```bash
# Everything
bunx skills add MarioJames/skill-foundry --all

# One skill
bunx skills add MarioJames/skill-foundry --skill asset-validation
bunx skills add MarioJames/skill-foundry --skill browser-harness
bunx skills add MarioJames/skill-foundry --skill cloudflare-quick-tunnel
bunx skills add MarioJames/skill-foundry --skill herdr
bunx skills add MarioJames/skill-foundry --skill trigger-build-workflow
bunx skills add MarioJames/skill-foundry --skill persistent-ssh-ops
bunx skills add MarioJames/skill-foundry --skill provision-xray-hy2-node
bunx skills add MarioJames/skill-foundry --skill changelog-writing
bunx skills add MarioJames/skill-foundry --skill awesome-presentation
bunx skills add MarioJames/skill-foundry --skill repo-knowledge-graph
bunx skills add MarioJames/skill-foundry --skill tdd

# Target a specific agent, or install globally
bunx skills add MarioJames/skill-foundry --all -a claude-code   # or: -a codex
bunx skills add MarioJames/skill-foundry --all -g
```

Restart or reload the target agent runtime after installation so it can discover the skills.

`herdr` requires Bun and an installed Herdr CLI. It does not use `HERDR_ENV` or other inherited
environment variables as an availability gate; the actual CLI response is authoritative, including
from agent sandboxes that do not inherit the parent Herdr environment.

Bun 1.3 or newer runs the Agent-facing script and hook entrypoints. Installable resources under
`assets/`, including the SSH zsh runtime, retain their target runtime; the Bun initializer installs
that runtime with the required permissions. External tools keep their own runtime requirements.

Use one installation entry per skill in each host. For Codex, do not install the same skill in both
`~/.agents/skills` and `~/.codex/skills`; keep the chosen copy synchronized from this repository.

### Manual Fallback

If your runtime does not support `skills add`, clone the repository and copy the skill directories directly.

Codex:

```bash
git clone https://github.com/MarioJames/skill-foundry.git
cd skill-foundry
mkdir -p ~/.agents/skills
cp -R skills/asset-validation skills/browser-harness \
  skills/cloudflare-quick-tunnel \
  skills/herdr skills/trigger-build-workflow skills/persistent-ssh-ops \
  skills/provision-xray-hy2-node skills/changelog-writing \
  skills/awesome-presentation skills/repo-knowledge-graph skills/tdd ~/.agents/skills/
```

Claude-style runtimes:

```bash
git clone https://github.com/MarioJames/skill-foundry.git
cd skill-foundry
mkdir -p ~/.claude/skills
cp -R skills/asset-validation skills/browser-harness \
  skills/cloudflare-quick-tunnel \
  skills/herdr skills/trigger-build-workflow skills/persistent-ssh-ops \
  skills/provision-xray-hy2-node skills/changelog-writing \
  skills/awesome-presentation skills/repo-knowledge-graph skills/tdd ~/.claude/skills/
```

Verify the installation:

```bash
test -f ~/.agents/skills/asset-validation/scripts/acc.ts
test -f ~/.agents/skills/browser-harness/scripts/bh.ts
test -f ~/.agents/skills/cloudflare-quick-tunnel/scripts/cqt.ts
test -f ~/.agents/skills/herdr/scripts/route-lane.ts
test -f ~/.agents/skills/trigger-build-workflow/scripts/detect-build-workflow.ts
test -f ~/.agents/skills/trigger-build-workflow/scripts/dispatch-build-workflow.ts
test -f ~/.agents/skills/persistent-ssh-ops/SKILL.md
test -f ~/.agents/skills/persistent-ssh-ops/scripts/scan-hosts.ts
test -f ~/.agents/skills/provision-xray-hy2-node/references/templates.md
test -f ~/.agents/skills/changelog-writing/scripts/collect-commits.ts
test -f ~/.agents/skills/awesome-presentation/SKILL.md
test -f ~/.agents/skills/repo-knowledge-graph/SKILL.md
test -f ~/.agents/skills/tdd/SKILL.md
```

### Update Manual Installs

```bash
cd skill-foundry
git pull
rm -rf ~/.agents/skills/asset-validation \
  ~/.agents/skills/browser-harness ~/.agents/skills/cloudflare-quick-tunnel \
  ~/.agents/skills/herdr ~/.agents/skills/trigger-build-workflow \
  ~/.agents/skills/persistent-ssh-ops ~/.agents/skills/provision-xray-hy2-node \
  ~/.agents/skills/changelog-writing ~/.agents/skills/awesome-presentation \
  ~/.agents/skills/repo-knowledge-graph ~/.agents/skills/tdd
cp -R skills/asset-validation skills/browser-harness \
  skills/cloudflare-quick-tunnel \
  skills/herdr skills/trigger-build-workflow skills/persistent-ssh-ops \
  skills/provision-xray-hy2-node skills/changelog-writing \
  skills/awesome-presentation skills/repo-knowledge-graph skills/tdd ~/.agents/skills/
```

## Usage

After installation, invoke the installed skills through normal agent requests.

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

Route a new request across the current Agent and Herdr runtime:

```text
Use herdr to keep my current development slice in this Agent and decide whether the new request belongs here or needs another Agent; if independent, route it to the right workspace and clean up the lane after handoff.
```

Submit changes within the requested scope:

```text
Use trigger-build-workflow to commit and push these files without dispatching a build. Select --commit --push for this authorized scope; add --dispatch only when a build is requested.
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
Use awesome-presentation to turn these materials into a React deck, build it, and verify it in the browser. Make routine narrative and layout choices from the brief.
```

Retrieve repository knowledge and cross-project context:

```text
Use repo-knowledge-graph to identify this repository from its Git remote and load its online knowledge and relations.
```

Decide whether a change needs a real test:

```text
Use tdd before implementing this feature or adding a unit test.
```

Each skill defines its own activation rules in `SKILL.md`. `herdr` may activate implicitly when an
active Agent receives another task or a concrete independent lane can shorten the critical path. `tdd` is meant to activate on every
production-code or test change; the skill body then chooses TDD vs skip.

## Repository Layout

```text
skill-foundry/
├── assets/
│   └── logo.svg
├── skills/
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
│   │   └── tests/
│   ├── persistent-ssh-ops/
│   │   ├── SKILL.md
│   │   ├── agents/
│   │   ├── assets/
│   │   ├── scripts/
│   │   └── tests/
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
│   ├── repo-knowledge-graph/
│   │   ├── SKILL.md
│   │   ├── agents/
│   │   └── references/
│   ├── tdd/
│   │   ├── SKILL.md
│   │   └── agents/
├── LICENSE
└── README.md
```

Installable skill packages:

- `skills/asset-validation/`
- `skills/browser-harness/`
- `skills/cloudflare-quick-tunnel/`
- `skills/herdr/`
- `skills/trigger-build-workflow/`
- `skills/persistent-ssh-ops/`
- `skills/provision-xray-hy2-node/`
- `skills/changelog-writing/`
- `skills/awesome-presentation/`
- `skills/repo-knowledge-graph/`
- `skills/tdd/`

## Verify

Useful local checks before publishing changes:

```bash
bun scripts/check-runtime-contract.ts
find skills -name SKILL.md -print
find skills -path '*/node_modules' -prune -o -type f \
  \( -path '*/scripts/*' -o -path '*/hooks/*' \) ! -name '*.ts' -print
```

Package-free migrated skills run their behavior tests directly with Bun:

```bash
bun test skills/asset-validation/tests
bun test skills/browser-harness/tests
bun test skills/cloudflare-quick-tunnel/tests
bun test skills/trigger-build-workflow/tests
bun test skills/persistent-ssh-ops/tests
```

```bash
bun skills/herdr/scripts/route-lane.ts --help
bun skills/herdr/scripts/probe-workspace.ts --help
bun skills/trigger-build-workflow/scripts/detect-build-workflow.ts --help
bun skills/trigger-build-workflow/scripts/dispatch-build-workflow.ts --help
bun skills/changelog-writing/scripts/collect-commits.ts --help
bun skills/persistent-ssh-ops/scripts/init-server-config.ts --help
bun skills/persistent-ssh-ops/scripts/scan-hosts.ts --help
bun skills/asset-validation/scripts/acc.ts --help
bun skills/browser-harness/scripts/bh.ts --version
bun skills/cloudflare-quick-tunnel/scripts/cqt.ts --version
```

```bash
find skills -type f -name '*.md' -print
```

## License

Apache-2.0. See [LICENSE](LICENSE).
