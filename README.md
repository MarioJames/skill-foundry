<p align="center">
  <img src="assets/logo.svg" alt="skill-foundry logo" width="180" />
</p>

# skill-foundry

> Forge once. Empower every agent.

`skill-foundry` is a set of agent skills taken from daily engineering work: orchestration, isolation, acceptance, release and operations. These are workflows we got tired of re-explaining. Each skill packages its instructions, Bun scripts, references and recovery rules, so you install a capability once and reuse it in Codex, Claude Code and other runtimes that read `SKILL.md`.

- **Proven in real work.** A skill earns its place by doing actual work, not by sounding good in a README.
- **Evidence over trust.** Behavior is checked against real CLIs, browsers and hosts; reports separate what was observed from what was assumed.
- **Built to resume.** Long multi-agent work keeps durable state, so a paused or crashed run continues instead of starting over.
- **Inspectable.** Instructions, scripts and references live together in Git, so behavior is versioned and reviewable.

## Skills

| Area | Skill | What it does |
| --- | --- | --- |
| Orchestration | [`agents-cooperation`](skills/agents-cooperation/SKILL.md) | Owner agents design, review and dispatch; workers chosen from a local config make every change |
| | [`herdr`](skills/herdr/SKILL.md) | Herdr tabs and panes, persistent terminals, agent start/stop, verified naming and precise cleanup |
| | [`agent-conduct`](skills/agent-conduct/SKILL.md) | Where reports, evidence and temporary files go; ready-to-run task worktrees and their reclamation; Docker and test leftovers; a read-only closure scan |
| Quality | [`tdd`](skills/tdd/SKILL.md) | Decides before coding which checks a change needs; writes tests only when they can fail |
| | [`feature-acceptance`](skills/feature-acceptance/SKILL.md) | Engineering preferences, interaction states and recovery paths for front-end and back-end work; records corrections where they belong |
| | [`browser-harness`](skills/browser-harness/SKILL.md) | Browser acceptance with agent-browser: services, login state, screenshot/console/network evidence |
| | [`public-acceptance`](skills/public-acceptance/SKILL.md) | Starts a DEV service, opens a temporary Cloudflare URL and hands over login details |
| | [`asset-validation`](skills/asset-validation/SKILL.md) | Reviews skills, plugins, rules and agents; runs real CLI acceptance when behavior must be proven |
| Release & ops | [`trigger-build-workflow`](skills/trigger-build-workflow/SKILL.md) | Commits, pushes and dispatches GitHub Actions builds only within the authorized scope |
| | [`changelog-writing`](skills/changelog-writing/SKILL.md) | Release notes for customers or engineers from release evidence, with a JSON contract |
| | [`persistent-ssh-ops`](skills/persistent-ssh-ops/SKILL.md) | One reusable TTY SSH session per host for multi-step maintenance and diagnostics |
| | [`debian-testvm`](skills/debian-testvm/SKILL.md) | Disposable Debian Stable VMs on QEMU/KVM for testing install and deploy scripts |
| | [`provision-xray-hy2-node`](skills/provision-xray-hy2-node/SKILL.md) | Runbook for Xray Vision/REALITY plus Hysteria 2 nodes, certificates and clients |
| Knowledge & content | [`repo-knowledge-graph`](skills/repo-knowledge-graph/SKILL.md) | Repository knowledge, project paths and cross-project relations in OpenViking |
| | [`awesome-presentation`](skills/awesome-presentation/SKILL.md) | React slide decks from materials or a brief, built on the awesome-presentation scaffold |

`chatgpt-review` used to live here. It is now bundled and maintained with [Convorel](https://github.com/MarioJames/convorel); install it from there.

## How they fit together

A typical development task touches several skills:

1. **Plan.** `agents-cooperation` picks a mode and prints a progress ledger. Design questions go to a discussion between two owner agents (for example Claude Code and Codex); only high-risk designs then go through a ChatGPT review called via Convorel's `chatgpt-review`.
2. **Isolate.** Workers that would collide get their own worktree from `agent-conduct`; the second owner agent and long-running processes live in `herdr` panes.
3. **Build and check.** Workers implement. `tdd` decides which tests are worth writing; `feature-acceptance` and `browser-harness` verify behavior; `public-acceptance` shares a temporary URL when someone else needs to look.
4. **Ship.** `trigger-build-workflow` commits, pushes or dispatches a build only within what you authorized; `changelog-writing` turns the result into release notes.

Each skill also works alone.

### `agents-cooperation` in brief

- **Roles.** Every top-level session is an owner agent. The one facing you takes the order and also talks to you, arbitrates disagreements and commits; a collaborating owner on another engine takes assigned work packages. Owners only design, review and dispatch, so the expensive models stay out of execution. Workers (native sub-agents or other-engine CLIs in `herdr` panes, one-shot or multi-round) make every file change.
- **Config.** `~/.config/agents-cooperation/config.json` (default: `assets/config.default.json`) defines engines, owners, their `workers` lists (with domain `tags` describing each model's strengths), models, efforts, and per-owner parallel limits. Dispatch is derived: same engine is native, a worker on another engine runs in its own `herdr` tab and pane that is closed once a one-shot package is accepted. Every package has a class (mechanical, routine or judgment) and `resolve --class` is required: mechanical and routine packages go to free workers first, while judgment packages default to the owner's native worker and use a domain `--tag` only when the work is another engine's strength. Owners dispatch only the workers in their configured `workers` list; a judgment package that belongs to the other owner's strengths is assigned to that owner instead (`resolve` returns a `peer_suggestion`). `resolve` yields the exact model, effort and arguments for every dispatch, and a usage-limit hit blocks that engine or model until its reset time, after which it unblocks itself.
- **Modes.** Design discussion, parallel development split between both sides, or ordinary dispatch. A progress ledger accompanies every update.
- **Review gate.** ChatGPT review is mandatory only for high-risk designs: security, migrations of persisted data, costly-to-reverse architecture, irreversible effects, an owner deadlock, or an explicit request. Such a design must pass review after owner discussion, and only the work that depends on it waits; everything else keeps moving. Other designs are frozen by the order-taking owner after owner discussion. Rounds are budgeted per stage: discussion 3, cross review 2, design review 2, result review 2. Each round is logged before it is sent, and revisions never reset the count. When the budget runs out, the order-taking owner decides within the user's authorization and records that ChatGPT did not pass the design.
- **Trace.** Each requirement keeps an append-only `decision-log.md`, every plan version as its own message file, source snapshots for uncommitted code, and Convorel task, run and content-version references.

Install the same skill on every host; the role follows the message source, not the vendor. Details: [skill entry](skills/agents-cooperation/SKILL.md), [config reference](skills/agents-cooperation/references/config.md) and [owner protocol](skills/agents-cooperation/references/peer-protocol.md).

## Install

Use the [`skills`](https://github.com/vercel-labs/skills) CLI. `pnpm dlx` or `npx` can replace `bunx`.

```bash
# Everything
bunx skills add MarioJames/skill-foundry --all

# Selected skills
bunx skills add MarioJames/skill-foundry --skill agents-cooperation tdd

# A specific agent, or a global install
bunx skills add MarioJames/skill-foundry --skill '*' --agent claude-code   # or: codex
bunx skills add MarioJames/skill-foundry --skill '*' -g

# Update installed skills
bunx skills update
```

Reload the agent runtime afterwards so it discovers the skills. Keep one copy of each skill per host; for Codex, do not install the same skill in both `~/.agents/skills` and `~/.codex/skills`.

### Manual install

```bash
git clone https://github.com/MarioJames/skill-foundry.git
cd skill-foundry
target=~/.agents/skills   # Claude Code: ~/.claude/skills
mkdir -p "$target"
for skill in skills/*/; do
  name=$(basename "$skill")
  rm -rf "$target/$name"
  cp -R "$skill" "$target/$name"
done
```

Run the same loop after `git pull` to update. It replaces only the directories it copies, so keep personal edits in a fork rather than in the installed copy.

### Requirements

Bun 1.3 or newer runs every script and hook entrypoint. Some skills also need host tools; none of them installs system packages for you.

| Skill | Also needs |
| --- | --- |
| `agents-cooperation` | Herdr for the collaborating owner and cross-engine sub-agents (falls back to own native sub-agents without it); Convorel with `chatgpt-review` for high-risk designs |
| `herdr` | Herdr CLI; the CLI response decides availability, and inherited `HERDR_*` variables are not trusted for identity |
| `agent-conduct` | Git; the project's package manager for worktree installs; Docker CLI for the container and volume part of the scan (skipped when absent) |
| `browser-harness` | agent-browser with its bundled Chromium; `DISPLAY` or `WAYLAND_DISPLAY` for headed login ([runtime setup](skills/browser-harness/references/runtime.md)) |
| `public-acceptance` | `cloudflared` for anonymous Quick Tunnels |
| `trigger-build-workflow` | Git and an authenticated `gh` for workflow dispatch |
| `persistent-ssh-ops` | OpenSSH and zsh; the initializer installs the bundled zsh runtime |
| `debian-testvm` | Linux x86_64 with read/write `/dev/kvm`, `qemu-system-x86_64`, `qemu-img`, `tar`, `genisoimage` or `xorriso`, OpenSSH, `curl`; `doctor` explains what is missing ([host setup](skills/debian-testvm/SKILL.md#prepare-once)) |
| `repo-knowledge-graph` | OpenViking tools registered in the agent runtime |
| `awesome-presentation` | Git and the scaffold's own package manager |

## Usage

Ask in normal language. Name a skill when you want to require it; selection is otherwise model-driven and never guaranteed by installation alone. `agents-cooperation` and `tdd` are written to activate on development work without being named.

```text
Use agents-cooperation to split this work across sub-agents, discuss the design with a Codex owner first, and cross-review the result.
Use agent-conduct to give this task its own ready-to-run worktree, and remove it once the branch is merged.
Use browser-harness to open the app and collect screenshot, console and network evidence.
Use public-acceptance to start this project in DEV, create a public URL and give me the login details.
Use asset-validation to validate this skill before release.
Use agent-conduct to scan what this task left behind since it started and clean up what it owns.
Use trigger-build-workflow to commit and push these files without dispatching a build.
Use changelog-writing to produce customer-facing notes for the changes since v1.2.0.
Use persistent-ssh-ops to inspect the service, apply the config change, verify it and close the session.
Use debian-testvm to boot a clean Debian VM with docker and run this install script.
Use awesome-presentation to turn these materials into a React deck and verify it in the browser.
```

## Development

Each skill lives in `skills/<name>/` with `SKILL.md` plus optional `agents/`, `scripts/`, `references/`, `assets/` and `tests/`.

Metadata conventions:

- The directory name and `SKILL.md` frontmatter `name` are the same lowercase, hyphenated identifier; installers and `$skill-name` references use it.
- `agents/openai.yaml` is present in every skill. `interface.display_name` is an English title that keeps product names and acronyms (`ChatGPT`, `SSH`, `TDD`).
- Frontmatter `description`, `interface.short_description` and `interface.default_prompt` are written in Chinese, state when the skill applies and keep meaningful exclusions.
- Scripts are TypeScript run with an explicit `bun`; documented commands must not call `scripts/*.ts` directly.

Checks before publishing:

```bash
bun scripts/check-runtime-contract.ts
bun test skills/asset-validation/tests
bun test skills/browser-harness/tests
bun test skills/feature-acceptance/tests
bun test skills/public-acceptance/tests
bun test skills/herdr/tests
bun test skills/trigger-build-workflow/tests
bun test skills/persistent-ssh-ops/tests
bun test skills/agent-conduct/tests
bun test skills/debian-testvm/tests/doctor.test.ts   # host diagnostics only
bun test skills/debian-testvm/tests/testvm.test.ts   # needs /dev/kvm, QEMU and built images
```

Behavioral acceptance of a changed skill goes through `asset-validation` with a real CLI; re-run the affected scenarios after each change. Compatibility reports live in [`reports/`](reports/).

## License

Apache-2.0. See [LICENSE](LICENSE).
