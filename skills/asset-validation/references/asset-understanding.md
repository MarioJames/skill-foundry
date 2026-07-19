# Asset understanding & classification

Goal: read the asset, determine its type (skill/plugin/rule/agent) and purpose, confirm with the user, then make the first `acc` write with `acc bootstrap`.

Unattended fast path: if confirmation is pre-authorized, do not inspect rig source, run environment checks, validate plugin internals, or write a phase heading before the first `acc` write. Read only entry files needed for type/purpose, record the assumed confirmation, then run `acc bootstrap` as the first `acc` write. After it succeeds, immediately continue to review/fix and strategy/start; do not pause at the asset-registration boundary.

Steps:
1. Read the entry files — `SKILL.md` / `plugin.json` / agent frontmatter / rule matcher — and summarize: type, trigger conditions, public interface, dependencies, whether it ships scripts.
2. Use AskUserQuestion to confirm: "I read this as a `<type>` whose purpose is `<goal>` — correct?" If the user explicitly pre-authorized unattended execution, record the confirmation you would have asked for and continue without stopping.
3. On confirmation: `python3 <skill_dir>/scripts/acc.py bootstrap --name <n> --type <t> --source <path> --goal "<one-line user goal>"` — registers the asset and opens the acceptance in one write. Re-running with the same name/type/source reuses the asset registration (idempotent) and opens a fresh acceptance; a same-name asset with different type or source is rejected - pick a new name. Heed any `warning` in the output: it flags a declared type that does not match the source shape.
4. The `--goal` is the user's intent for this asset — it seeds the acceptance you just opened. In unattended mode, move directly to the next command batch; do not stop after step 3.

After registration and before task design, write a capability profile for the asset:

- asset type and primary category;
- realistic user goals this asset should handle;
- trigger/entry conditions and neighboring non-trigger cases;
- claimed capabilities and which ones require real execution evidence;
- expected side effects and cleanup boundaries;
- failure/recovery modes that matter for this asset type;
- what "small", "medium", and "complex" tasks mean for this specific asset.

Use this profile to derive acceptance tasks. Do not use a generic toy task ladder unrelated to the asset's actual domain.

## Gotchas
- A skill's `description` is the trigger surface; read it as "when does this fire?", not as a summary. Over-broad or over-narrow descriptions are themselves defects to record.
- For plugins, the asset is the whole folder (agents + skills + hooks + marketplace), not a single file.
- Do not query SQLite directly. Use `acc asset list`, `acc accept list`, `acc round list`, or `acc history`; if the CLI lacks a needed read, add it before continuing.
