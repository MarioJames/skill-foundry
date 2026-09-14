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

### `cloudflare-quick-tunnel` — public DEV acceptance

Prepares a local DEV service, discovers and verifies its actual listening port, creates a temporary Cloudflare review URL, and retrieves the application's development login credentials from effective environment configuration or the development database. Reports available plaintext credentials to the requesting user, verifies login, and explains hash-only or external-auth limitations without inventing passwords. Uses `browser-harness` for frontend interaction and evidence, and retains the service and tunnel for manual review until cleanup.

The existing Bun CLI owns anonymous tunnel start / status / stop / cleanup with isolated configuration and exact process state. It returns the generated root URL immediately; the acceptance workflow verifies reachability and pages afterward.

**Reach for it when** preparing a project for public acceptance, handing over a temporary review URL with login details, or inspecting and cleaning up an existing Quick Tunnel.

### `herdr` — parallel work and resource ownership

`herdr` is the preferred path when parallel work can shorten the critical path, including independent subtasks of one deliverable. The skill gives principles for task boundaries, write ownership, result integration, and resource cleanup, leaving the Agent to choose a useful split and continue work toward the complete result.

After the task decision, the bundled Bun/TypeScript resource router can split the caller tab, create a tab in an existing directory-matched workspace, or create a new workspace when no safe match exists. It matches target directories using cwd and Git roots, preserves focus, returns an explicit cleanup contract, and rolls back newly created resources when verification fails.

**Reach for it when** independent commands or Agent deliverables can overlap with a net time benefit, or Herdr runtime resources need coordination.

### `cow-workspace` — copy-on-write development workspaces

Prepares one fixed Git and dependency baseline, then uses `fuse-overlayfs` to give each task its own writable view on Linux. Shared `.env` configuration remains available while source edits, dependency changes, Git state, and build output stay local to each workspace. The Bun CLI exports task commits as Git bundles, resumes retained writes, and refuses unsafe cleanup. Herdr can route Agents to the returned working directory.

**Reach for it when** parallel development needs isolated writes without copying a complete source and dependency tree for every Agent.

Preparation makes one ordinary baseline copy when native reflinks are unavailable; subsequent workspaces reuse it through CoW. Task-specific configuration belongs in `.env.local`, using the project's loader. The shared `.env` target remains writable outside CoW, and databases, network services, and processes need their own isolation.

See the [CoW workspace guide](skills/cow-workspace/SKILL.md) for preparation, returned working directories, Git bundle handoff, recovery, and guarded cleanup. Operational rules live in that skill; no duplicate global workspace rule is required.

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
bunx skills add MarioJames/skill-foundry --skill cow-workspace
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

`cow-workspace` requires Linux, Git, Bun, `flock`, `fuse-overlayfs`, `fusermount3`, and a usable
`/dev/fuse`. Its CLI checks real mounting and does not install missing system tools or silently
fall back to a full copy per workspace. Prepare from a clean, committed repository; ignored root
`node_modules` is included automatically. See the [preparation requirements](skills/cow-workspace/SKILL.md#prepare-once-create-as-needed)
for extra dependency directories and unsupported layouts.

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
  skills/herdr skills/cow-workspace skills/trigger-build-workflow skills/persistent-ssh-ops \
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
  skills/herdr skills/cow-workspace skills/trigger-build-workflow skills/persistent-ssh-ops \
  skills/provision-xray-hy2-node skills/changelog-writing \
  skills/awesome-presentation skills/repo-knowledge-graph skills/tdd ~/.claude/skills/
```

Verify the installation:

```bash
test -f ~/.agents/skills/asset-validation/scripts/acc.ts
test -f ~/.agents/skills/browser-harness/scripts/bh.ts
test -f ~/.agents/skills/cloudflare-quick-tunnel/scripts/cqt.ts
test -f ~/.agents/skills/herdr/scripts/route-lane.ts
test -f ~/.agents/skills/cow-workspace/scripts/cow.ts
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
  ~/.agents/skills/herdr ~/.agents/skills/cow-workspace ~/.agents/skills/trigger-build-workflow \
  ~/.agents/skills/persistent-ssh-ops ~/.agents/skills/provision-xray-hy2-node \
  ~/.agents/skills/changelog-writing ~/.agents/skills/awesome-presentation \
  ~/.agents/skills/repo-knowledge-graph ~/.agents/skills/tdd
cp -R skills/asset-validation skills/browser-harness \
  skills/cloudflare-quick-tunnel \
  skills/herdr skills/cow-workspace skills/trigger-build-workflow skills/persistent-ssh-ops \
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
Use cloudflare-quick-tunnel to start this project in DEV, discover its actual port, create a public acceptance URL, and provide the configured login username and password. Verify the page and keep the service available until I finish.
```

Parallelize useful work through Herdr:

```text
Use herdr to parallelize independent parts of this task where it saves time, integrate the results, and clean up task-owned resources.
```

Prepare an isolated development directory with existing dependencies:

```text
Prepare an independent development directory for this repository so another Agent can edit it without copying the complete source and node_modules for each task. Reuse the shared .env, keep task overrides local, and report the working directory. When the work is committed, export the commits for integration and clean up the task workspace.
```

The installed skill's description helps the Agent select `cow-workspace`; selection is model-driven,
not an execution hook or guarantee. Name `cow-workspace` explicitly when you want to require it.
The [skill guide](skills/cow-workspace/SKILL.md) also provides direct CLI commands.

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

Each skill defines its own activation rules in `SKILL.md`. Prefer `herdr` implicitly when parallel work can
shorten the critical path, including within a single deliverable. `tdd` is meant to activate on every
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
│   ├── cow-workspace/
│   │   ├── SKILL.md
│   │   ├── agents/
│   │   ├── scripts/
│   │   └── tests/
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
- `skills/cow-workspace/`
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
bun test skills/cow-workspace/tests # Requires Linux, fuse-overlayfs and /dev/fuse
bun test skills/trigger-build-workflow/tests
bun test skills/persistent-ssh-ops/tests
```

`cow-workspace` passed fixture-based behavioral acceptance on 2026-09-09 with a real Codex CLI
using `gpt-6-astra` and `medium` reasoning. The run exercised the staged skill without global CoW
instructions and independently checked:

- Natural selection, real CoW mounts, and source/dependency/configuration isolation.
- Two task commits exported and integrated through Git bundles, including binary changes and deletion.
- Uncommitted changes surviving unmount/remount, and busy-workspace removal preserving data until the holder stopped.
- A fresh read-only environment-variable question that did not load the skill or create a workspace.

The original repository stayed unchanged; task mounts, temporary workspaces, processes, and the
acceptance sandbox were removed. This records the observed run; changes should be validated against
the affected scenarios again.

```bash
bun skills/herdr/scripts/route-lane.ts --help
bun skills/cow-workspace/scripts/cow.ts --help
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
