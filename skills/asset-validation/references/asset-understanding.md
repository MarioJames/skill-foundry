# Asset understanding and registration

For behavioral acceptance, identify the asset type (skill/plugin/rule/agent), purpose, source, and authorized side effects. Review-only requests do not need registration.

Read the relevant entry files and resolve these facts from the request. Inspect prerequisites when they affect execution. Ask only if an ambiguity changes the evaluation; existing authorization applies in attended and unattended runs.

Register with `bun <skill_dir>/scripts/acc.ts bootstrap --name <name> --type <type> --source <path> --goal "<goal>"`. The same name/type/source reuses the asset registration but opens a fresh acceptance; resume an existing acceptance instead when that is the requested task. A same-name asset with different type or source is rejected. Check any source-shape warning before proceeding.

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
- Do not query SQLite directly. Use documented scoped reads such as `acc asset list`, `acc accept list`, `acc round list`, or `acc history --asset <asset-name-or-id>`; bare `acc history` is invalid. Add a missing read only when rig changes are authorized; otherwise report the specific evidence gap.
