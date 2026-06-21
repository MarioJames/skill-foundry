<p align="center">
  <img src="assets/logo.svg" alt="skill-foundry logo" width="180" />
</p>

# skill-foundry

> Forge once. Empower every agent.

`skill-foundry` is a small set of agent skills we run in production — workflows we got tired of re-explaining, hardened into portable, inspectable, versioned packages. Each skill ships with its scripts, prompts, references, and recovery rules, so you install a capability once and reuse it across Codex, Claude-style runtimes, and your own agent environments.

## Why skill-foundry

- **Production-proven, not aspirational** — every skill here earns its place doing real work in real runs, not by sounding good in a README.
- **Evidence over trust** — skills are verified by running them against a real CLI and capturing what actually happened (that's literally what `asset-validation` does).
- **Built to survive interruption** — long, multi-agent work carries durable state and recovery rules, so a paused or crashed run resumes instead of restarting.
- **Portable & inspectable** — instructions, scripts, and references live together in Git; you version and audit behavior instead of trusting undocumented prompts.

## The Skills

### `asset-validation` — evidence-backed acceptance for agent assets

Most skills, plugins, rules, and agents are never actually exercised — they're eyeballed, shipped, and trusted. `asset-validation` closes that gap. It runs the asset-under-test as a **real interactive CLI** (in tmux, never a stand-in subagent), feeds it real tasks, observes what actually happens, independently re-verifies, captures evidence, and cleans up the sandbox. You end with acceptance you can point at — *here's the run, here's what it did* — before you publish, refactor, or trust an asset.

**Reach for it when** validating a skill, plugin, rule, or agent before release, or re-checking one after changes.

### `ultra-team` — a harness for large-scale agent orchestration

Coordinating many agents on big work without losing state, context, or accountability is hard. `ultra-team` is distilled orchestration experience turned into a runnable harness: an explicit task tree with dispatch / implement / review / fix child roles, recursion and recovery protocols, lifecycle hooks, and durable runtime state. A root agent stays in the foreground and delegates; interrupted runs resume instead of starting over. It is dormant by default and only activates on an explicit `ultra team` request.

**Reach for it when** complex work needs delegation, tracking, review, and safe resume.

## Install

Install with the [`skills`](https://github.com/vercel-labs/skills) CLI:

```bash
# Everything
npx skills add MarioJames/skill-foundry --all

# One skill
npx skills add MarioJames/skill-foundry --skill asset-validation
npx skills add MarioJames/skill-foundry --skill ultra-team

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
cp -R skills/asset-validation skills/ultra-team ~/.codex/skills/
```

Claude-style runtimes:

```bash
git clone https://github.com/MarioJames/skill-foundry.git
cd skill-foundry
mkdir -p ~/.claude/skills
cp -R skills/asset-validation skills/ultra-team ~/.claude/skills/
```

Verify the installation:

```bash
test -f ~/.codex/skills/asset-validation/SKILL.md
test -f ~/.codex/skills/ultra-team/SKILL.md
```

### Update Manual Installs

For manual installs, pull the latest repository and replace the copied skill directories:

```bash
cd skill-foundry
git pull
rm -rf ~/.codex/skills/asset-validation ~/.codex/skills/ultra-team
cp -R skills/asset-validation skills/ultra-team ~/.codex/skills/
```

## Usage

After installation, invoke the installed skills through normal agent requests.

Validate an asset:

```text
Use asset-validation to validate this skill before release.
```

Run explicit orchestration:

```text
Run this in ultra team mode and coordinate implementation, validation, and final review.
```

Each skill defines its own activation rules in `SKILL.md`. In particular, `ultra-team` is dormant by default and only activates when the user explicitly asks for `ultra team`.

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
│   └── ultra-team/
│       ├── SKILL.md
│       ├── hooks/
│       ├── references/
│       └── scripts/
├── LICENSE
└── README.md
```

Only `skills/asset-validation/` and `skills/ultra-team/` are installable skill packages in the current repository shape.

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
