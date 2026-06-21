# Asset understanding & classification

Goal: read the asset, determine its type (skill/plugin/rule/agent) and purpose, confirm with the user, then `acc asset add`.

Unattended fast path: if confirmation is pre-authorized, do not inspect rig source, run environment checks, validate plugin internals, or write a phase heading before the first `acc asset add`. Read only entry files needed for type/purpose, record the assumed confirmation, then run `acc asset add` as the first `acc` write. After it succeeds, immediately continue to review/fix and strategy/start; do not pause at the asset-registration boundary.

Steps:
1. Read the entry files — `SKILL.md` / `plugin.json` / agent frontmatter / rule matcher — and summarize: type, trigger conditions, public interface, dependencies, whether it ships scripts.
2. Use AskUserQuestion to confirm: "I read this as a `<type>` whose purpose is `<goal>` — correct?" If the user explicitly pre-authorized unattended execution, record the confirmation you would have asked for and continue without stopping.
3. On confirmation: `python3 <skill_dir>/scripts/acc.py asset add --name <n> --type <t> --source <path>`.
4. Capture the user's intent (goal) for this asset — it feeds the acceptance you create next. In unattended mode, move directly to the next command batch; do not stop after step 3.

## Gotchas
- A skill's `description` is the trigger surface; read it as "when does this fire?", not as a summary. Over-broad or over-narrow descriptions are themselves defects to record.
- For plugins, the asset is the whole folder (agents + skills + hooks + marketplace), not a single file.
- Do not query SQLite directly. Use `acc asset list`, `acc accept list`, `acc round list`, or `acc history`; if the CLI lacks a needed read, add it before continuing.
