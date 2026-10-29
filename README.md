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
| Orchestration | [`herdr`](skills/herdr/SKILL.md) | Herdr tabs and panes, persistent terminals, agent start/stop, verified naming and precise cleanup |
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

`chatgpt-review` used to live here. It is now bundled and maintained with [Convorel](https://github.com/MarioJames/convorel); install it from there. `agents-cooperation` was retired in favour of [Weaver](https://github.com/MarioJames/weaver), which dispatches work to agents on other engines.

## How they fit together

A typical development task touches several skills:

1. **Plan.** The agent plans the work itself, or hands it to [Weaver](https://github.com/MarioJames/weaver) when you ask for dispatch to other engines; high-risk designs go through a ChatGPT review called via Convorel's `chatgpt-review`.
2. **Isolate.** Work that would collide gets its own worktree from `agent-conduct`; long-running processes live in `herdr` panes.
3. **Build and check.** `tdd` decides which tests are worth writing; `feature-acceptance` and `browser-harness` verify behavior; `public-acceptance` shares a temporary URL when someone else needs to look.
4. **Ship.** `trigger-build-workflow` commits, pushes or dispatches a build only within what you authorized; `changelog-writing` turns the result into release notes.

Each skill also works alone.

## Install

Use the [`skills`](https://github.com/vercel-labs/skills) CLI. `pnpm dlx` or `npx` can replace `bunx`.

```bash
# Everything
bunx skills add MarioJames/skill-foundry --all

# Selected skills
bunx skills add MarioJames/skill-foundry --skill agent-conduct tdd

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

Ask in normal language. Name a skill when you want to require it; selection is otherwise model-driven and never guaranteed by installation alone. `agent-conduct` and `tdd` are written to activate on development work without being named.

```text
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
