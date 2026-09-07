# Unattended Execution

Use these command contracts for real CLI acceptance. When unattended execution is requested, continue authorized work through verification and cleanup without pausing for routine confirmations.

## Scope and preparation

Use the requested acceptance scope and CLI without reconfirmation. Read the relevant asset entry and prerequisites, resolve the CLI, then register the acceptance before creating rounds. Review-only tasks do not use this workflow. Necessary source or reference reads may precede registration; do not create state simply to satisfy an ordering ritual.

Resolve `ACC` from the staged skill copy first; this keeps sandboxed standalone-skill validation from accidentally using a stale global install:

```
ACC=""
if [ -n "${ACCEPTANCE_SANDBOX:-}" ]; then
  if [ -f "$ACCEPTANCE_SANDBOX/.agents/skills/asset-validation/scripts/acc.ts" ]; then
    ACC="$ACCEPTANCE_SANDBOX/.agents/skills/asset-validation/scripts/acc.ts"
  else
    ACC="$(find "$ACCEPTANCE_SANDBOX/.iso" -path '*/skills/asset-validation/scripts/acc.ts' -type f 2>/dev/null | head -1)"
  fi
fi
if [ -z "$ACC" ] && [ -f "skills/asset-validation/scripts/acc.ts" ]; then
  ACC="skills/asset-validation/scripts/acc.ts"
fi
if [ -z "$ACC" ]; then
  ACC="<loaded-skill-dir>/scripts/acc.ts"
fi
test -f "$ACC" || { echo "asset-validation acc.ts not found" >&2; exit 2; }
command -v bun >/dev/null 2>&1 || { echo "asset-validation requires Bun" >&2; exit 2; }
acc() { bun "$ACC" "$@"; }
acc bootstrap --name <asset_name> --type <type> --source <source_path> --goal "<one-line user goal>"
```

## Continuation Rule

Continue authorized preparation, execution, fixes, and cleanup to the requested completion criteria. Progress updates do not need approval; pause only for missing information or an action outside the permitted scope.

If an unattended round returns FAIL/CONDITIONAL and the next action stays inside the asset-under-test or strategy/task design, record the failure, finalize that round, then immediately start the fix/rerun round. `acc finalize` performs round cleanup by default. For a boundary-only additive fix, apply the scoped revalidation rule in `references/convergence-and-task-design.md`: preserve mapped, unaffected PASS evidence and re-run only affected tasks. **DO NOT** ask "should I continue" unless the fix would touch assets outside the asset-under-test, reset history, or expand destructive scope.

The unattended run is complete only after post-fix evidence produces a clean PASS and `acc finalize` reports cleanup, or after the same blocker repeats for at least three consecutive attempts and is recorded as blocked. A repaired defect is not enough: every affected task must pass from a fresh start without observer intervention. Unaffected passed tasks may be retained only through the documented boundary-only evidence-reuse exception.

A budget-exhausted acceptance is a terminal Blocked state, not a retry candidate. Set `--budget-max-rounds` during `acc accept update` to bound unattended runs; `acc start` rejects new rounds with `{"blocked": "budget-exhausted"}` once the limit is reached.

## Unattended Command Spine

After resolving the asset and prerequisites, run `bun "$ACC" bootstrap --name <asset_name> --type <type> --source <source_path> --goal "<goal>"`, or resume the requested existing acceptance. Record the actual authorization scope rather than inventing a confirmation event.

Review the relevant asset and fix authorized defects before launching rounds. Store strategy artifacts in a task-private directory:

```
WORK="$(mktemp -d "${ACCEPTANCE_TMPDIR:-${TMPDIR:-/tmp}}/acc-strategy.XXXXXX")"
```

**NEVER** use a fixed path such as `/tmp/acc-toy`, `/tmp/acc-work-path.txt`, or any fixed `/tmp/.<name>_marker`. If the path must be persisted, first verify in the same batch that `WORK` is a non-empty existing absolute directory, then write to `"$WORK/.workpath"` or another file inside the current round sandbox / `ACCEPTANCE_TMPDIR`. An unset `WORK` makes `"$WORK/.acc-path"` target `/.acc-path`; fail before any write instead. Review-only mode normally has no `WORK`, so re-resolve paths per batch and create scratch with `mktemp -d "${ACCEPTANCE_TMPDIR:-${TMPDIR:-/tmp}}/<purpose>.XXXXXX"`.

Before writing `tasks.json`, write the asset capability profile into the strategy notes: asset type/category, realistic user goals, claimed capabilities, neighboring non-trigger cases, failure/recovery/cleanup modes, and what small/medium/complex mean for this asset. Task prompts must be derived from that profile. For complex assets, non-smoke tasks must be progressively larger realistic scenarios for that asset type, not generic toy chores and not a copy of the largest benchmark at every rung.

Run:

```
acc accept update --id <acceptance_id> --strategy-file "$WORK/strategy.md" --prompt-file "$WORK/acceptance-prompt.tmpl.md" --criteria-file "$WORK/acceptance-criteria.tmpl.md" --task-prompts-file "$WORK/tasks.json" --ladder-file "$WORK/ladder.json"
```

If the functional tasks need input fixtures, create the bounded fixture under `"$WORK"` and append `--fixture "$WORK/fixture"` to that same `accept update` call. `acc start` copies only the acceptance's recorded fixture; merely mentioning an outer path in task text leaves the round with `fixture: null` and breaks isolation.

Task prompts files are flat JSON objects only: `{"t1": "task body"}`; `acc accept new/update` rejects arrays or `{"tasks": [...]}` wrappers at write time, because `acc feed-task --task t1` reads the top-level `t1` key. The ladder file maps rung names to task keys (`{"smoke": ["t1"], ...}`); the finalize PASS gate reads it.

After updating acceptance artifacts, prefer the typed profile runner when it supports the asset type: `acc profile run-task --acceptance <acceptance_id> --task t1 --mode <mode> --cli <claude|codex>`. Here `<mode>` is not free-form: replace it with exactly one of `stop-loss`, `collect-first`, or `hybrid`; values such as `auto` are invalid. It wraps start/launch/feed/bounded wait/capture/record with the asset-type staging rules and secret redaction. If the type profile is not implemented yet, or when debugging an individual stage, then run `acc start --acceptance <acceptance_id> --mode <stop-loss|collect-first|hybrid> --cli <claude|codex>`, `acc launch --round <round_id> --cli <claude|codex>`, and `acc feed-task --round <round_id> --task t1`. In unattended mode, use `claude` unless the user explicitly selected `codex`.

**DO NOT** run `acc ... --help` or `acc record -h` during unattended execution; the command contract here is authoritative. Store raw ids in files when needed, never `KEY=value` lines unless the later command explicitly strips the prefix. Shell variables and the `acc()` wrapper do not persist across separate Bash tool calls; resolve `ACC` and recreate the wrapper in each batch, or store the path in a file inside `"$WORK"` such as `"$WORK/.acc-path"`.

## Observe Loop Details

`acc start` idempotently prepares the round environment. It creates the sandbox workdir, the isolated acceptance DB root, `ACCEPTANCE_TMPDIR`, sandbox runtime roots, and host-specific launch settings before the asset-under-test starts. It preserves the invoking `HOME` so the observed CLI keeps the user's real auth and keychain state, while sandboxing acceptance state, temp files, marketplace/profile roots, and staged assets through host-specific launch arguments. As a known exception, the observed CLI's own session logs may land under the real home; treat that as expected, not as sandbox pollution, and never quote secrets from those logs.

The returned env includes `ACCEPTANCE_HOME` for the isolated acceptance DB, plus `ACCEPTANCE_SANDBOX`, `ACCEPTANCE_TMPDIR`, `TMPDIR`/`TMP`/`TEMP` pointing to `ACCEPTANCE_TMPDIR`, `HOME` pointing at the invoking user home, and `CMDAI_CLAUDE_SETTINGS_PATH`.

**DO NOT** write memories, global notes, or host configuration while observing or while running as the asset-under-test unless the user explicitly requests that persistent side effect. Environment workarounds and reusable lessons can be reported in the round record instead of persisted outside the acceptance evidence boundary.

Sandbox settings may contain auth env values copied only so `--bare` launches can authenticate. **NEVER** print settings files, token-bearing env values, or raw command lines containing secrets. `acc capture` and `acc record` redact known secret keys automatically; reports should still name settings paths only and never quote settings file contents.

Observer scratch/evidence workdirs must be created under `ACCEPTANCE_TMPDIR` from the `acc start` output, or under the returned round sandbox. **DO NOT** create top-level `asset-validation-round*`, sibling `/tmp/acc-*` scratch directories, or fixed marker files directly under `/tmp` outside the current round boundary. `acc finalize` removes the round sandbox, kills only this round's `acc-<round_tag>` tmux session, cleans plugin staging, and cleans nested round sandboxes recorded in the sandboxed acceptance DB before deleting the parent sandbox.

`acc launch --round <round_id> --cli <claude|codex>` starts tmux with the selected real asset-under-test CLI and the start output's isolation env. Claude plugin and standalone-skill assets are staged under the round sandbox and launched with `--bare`, an isolation `--append-system-prompt`, sandbox `--settings`, and `--plugin-dir`, not by writing into real or symlinked HOME skill roots. Codex standalone skills are copied to the round sandbox's `.agents/skills/<name>` repository discovery path. For either host, verify the executed asset path: if a same-name global skill wins, behavior may be green but isolated provenance is not, so record FAIL or CONDITIONAL rather than a clean PASS.

`acc feed-task --round <round_id> --task t1` waits for the round pane input prompt, then sends the de-guided task body and records the fed task key on the round; the ladder PASS gate reads that recorded coverage, so always feed through `feed-task --round` or `profile run-task`. After `acc feed-task`, do not run an open-ended background poll and do not wait for the round DB row to leave `running` before `finalize` because only `acc finalize` changes that DB verdict. Use `acc wait --round <round_id> --idle-seconds <N> --max-seconds <M>` to wait until the pane stops changing (idle) or the max time elapses, then capture.

Capture and record evidence:

```
acc capture --round <round_id> --out "$WORK/transcript.txt"
acc record --round <round_id> --transcript-file "$WORK/transcript.txt" --report <summary>
```

Run any needed `acc finding`, then `acc finalize`. A successful `acc finalize` must return a `cleanup` object showing that it removed isolation roots including `ACCEPTANCE_TMPDIR` and killed only this round's `acc-<round_tag>` tmux session. A pane showing the expected answer is not a verdict while the round table still says `running`; finish the database state with `acc finalize` before returning. Use `acc finalize --keep-sandbox` only to preserve a failed round for local debugging; a kept round must be followed by `acc cleanup --round <round_id>` before returning.

This documented spine is the PASS-gate contract. Do not open, grep, or line-slice `scripts/catalog.ts`, `scripts/commands.ts`, or any other ACC implementation file to predict whether finalize will pass. Invoke `acc finalize --verdict <PASS|FAIL|CONDITIONAL>` directly; if it returns a structured rejection, satisfy the reported requirement and retry the command.

Independent history verification uses `acc history --asset <asset-name-or-id>`; never invoke bare `acc history`, because its required `--asset` omission is a usage error. Other state checks still go through documented scoped `acc` reads. **DO NOT** run `sqlite3` on `state.sqlite3`; if a read is missing, add a narrow CLI operation only when rig changes are authorized, otherwise report the evidence gap.

Keep progressing through the recorded tasks and cleanup. Inspect the preceding result before choosing the next command, and give concise progress updates when useful.

If finalizing a round leaves any acceptance criterion unmet, any accepted cleanup missing, or any manually fixed behavior unproven, the next concrete action is a repair plus a new `acc start` for the same acceptance. Re-run affected tasks; do not repeat mapped, unaffected PASS tasks after a qualifying boundary-only fix. **DO NOT** summarize as "done" from a failed or conditional round.
