# Unattended Execution

Use this reference when the user is away, sleeping, or explicitly asks for the whole acceptance flow to finish automatically.

## Fast Path Gate

The unattended fast path is a positive sequence with no detours:

1. Read only the asset entry files needed to classify type and purpose — `SKILL.md`, the host plugin manifest (`.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, or legacy root `plugin.json`), agent frontmatter, or the rule matcher.
2. Record the pre-authorized confirmation.
3. Make the first `acc` write immediately: the first shell batch that touches `acc` must begin with the asset registration itself. Prefer `acc bootstrap`, which registers the asset and opens the acceptance in one write (`acc asset add` + `acc accept new` remain the two-step equivalent).
4. Continue in the same execution batch to review/fix, strategy files, `acc accept update`, and `acc start`; do not pause for open-ended thinking between these commands.

Everything else waits until after that first write: bundled `skills/`, `agents/`, hooks, or marketplace files; rig source, environment checks, or plugin-internal validation; this skill's `references/`, `scripts/acc.ts`, `scripts/observe.ts`; and any discovery such as `bun "$ACC" --help`, `bun "$ACC" asset --help`, `ls "$ACC"`, `echo $ACCEPTANCE_TMPDIR`, phase headings, or scanning this skill directory. The command contract in this reference is authoritative; **DO NOT** open references before the first `acc` write.

Resolve `ACC` from the staged skill copy first; this keeps sandboxed standalone-skill validation from accidentally using a stale global install:

```
ACC=""
if [ -n "${ACCEPTANCE_SANDBOX:-}" ]; then
  ACC="$(find "$ACCEPTANCE_SANDBOX/.iso" -path '*/skills/asset-validation/scripts/acc.ts' -type f 2>/dev/null | head -1)"
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

In unattended mode, **NEVER** return control after asset understanding, classification, tool preflight, review-and-fix, strategy drafting, or any phase summary. A progress summary is allowed only immediately before the next `acc` command or observe-loop action in the same turn.

If an unattended round returns FAIL/CONDITIONAL and the next action stays inside the asset-under-test or strategy/task design, record the failure, finalize that round, then immediately start the fix/rerun round. `acc finalize` performs round cleanup by default. **DO NOT** ask "should I continue" unless the fix would touch assets outside the asset-under-test, reset history, or expand destructive scope.

The unattended run is complete only after a fresh post-fix round produces a clean PASS and `acc finalize` reports cleanup, or after the same blocker repeats for at least three consecutive attempts and is recorded as blocked. A repaired defect is not enough; the next round must prove that the asset can pass from a clean start without observer intervention.

A budget-exhausted acceptance is a terminal Blocked state, not a retry candidate. Set `--budget-max-rounds` during `acc accept update` to bound unattended runs; `acc start` rejects new rounds with `{"blocked": "budget-exhausted"}` once the limit is reached.

## Unattended Command Spine

In unattended mode, do not expand rig source or run broad validation before the first `acc` write. Read only enough asset entry files to classify type/purpose (the applicable host manifest only for plugins), record the pre-authorized confirmation, then run `bun "$ACC" bootstrap --name <asset_name> --type <type> --source <source_path> --goal "<goal>"` before review/fix. Registration still happens before review, validation, or rig introspection.

After the bootstrap write, the next action is not a phase heading or open-ended planning. Immediately run the review/fix scan. If no major blocker remains, immediately create strategy artifacts under:

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

`acc start` idempotently prepares the round environment. It creates the sandbox workdir, the isolated acceptance DB root, `ACCEPTANCE_TMPDIR`, sandbox runtime roots, and sandbox Claude settings file before the asset-under-test starts. It preserves the invoking `HOME` so Claude/Code keeps the user's real auth and keychain state, while sandboxing acceptance state, temp files, marketplace/profile roots, and plugin staging through env vars plus Claude `--settings`/`--plugin-dir`. As a known exception, the observed CLI's own session logs (for example `~/.claude/projects` JSONL) land under the real home; treat that as expected, not as sandbox pollution, and never quote secrets from those logs.

The returned env includes `ACCEPTANCE_HOME` for the isolated acceptance DB, plus `ACCEPTANCE_SANDBOX`, `ACCEPTANCE_TMPDIR`, `TMPDIR`/`TMP`/`TEMP` pointing to `ACCEPTANCE_TMPDIR`, `HOME` pointing at the invoking user home, and `CMDAI_CLAUDE_SETTINGS_PATH`.

**DO NOT** write memories, global notes, or host configuration while observing or while running as the asset-under-test unless the user explicitly requests that persistent side effect. Environment workarounds and reusable lessons can be reported in the round record instead of persisted outside the acceptance evidence boundary.

Sandbox settings may contain auth env values copied only so `--bare` launches can authenticate. **NEVER** print settings files, token-bearing env values, or raw command lines containing secrets. `acc capture` and `acc record` redact known secret keys automatically; reports should still name settings paths only and never quote settings file contents.

Observer scratch/evidence workdirs must be created under `ACCEPTANCE_TMPDIR` from the `acc start` output, or under the returned round sandbox. **DO NOT** create top-level `asset-validation-round*`, sibling `/tmp/acc-*` scratch directories, or fixed marker files directly under `/tmp` outside the current round boundary. `acc finalize` removes the round sandbox, kills only this round's `acc-<round_tag>` tmux session, cleans plugin staging, and cleans nested round sandboxes recorded in the sandboxed acceptance DB before deleting the parent sandbox.

`acc launch --round <round_id> --cli <claude|codex>` starts tmux with the selected real asset-under-test CLI and the start output's isolation env. For Claude plugin assets it stages the plugin under the round sandbox and launches with `--bare`, an isolation `--append-system-prompt`, sandbox `--settings`, and `--plugin-dir`, not by writing bundled skills/agents into the real or symlinked HOME skill root. Standalone skill assets are staged the same way through a temporary sandbox-local plugin wrapper so the observed CLI can discover the skill by name without polluting real HOME skill roots or being shadowed by a global same-name skill.

`acc feed-task --round <round_id> --task t1` waits for the round pane input prompt, then sends the de-guided task body and records the fed task key on the round; the ladder PASS gate reads that recorded coverage, so always feed through `feed-task --round` or `profile run-task`. After `acc feed-task`, do not run an open-ended background poll and do not wait for the round DB row to leave `running` before `finalize` because only `acc finalize` changes that DB verdict. Use `acc wait --round <round_id> --idle-seconds <N> --max-seconds <M>` to wait until the pane stops changing (idle) or the max time elapses, then capture.

Capture and record evidence:

```
acc capture --round <round_id> --out "$WORK/transcript.txt"
acc record --round <round_id> --transcript-file "$WORK/transcript.txt" --report <summary>
```

Run any needed `acc finding`, then `acc finalize`. A successful `acc finalize` must return a `cleanup` object showing that it removed isolation roots including `ACCEPTANCE_TMPDIR` and killed only this round's `acc-<round_tag>` tmux session. A pane showing the expected answer is not a verdict while the round table still says `running`; finish the database state with `acc finalize` before returning. Use `acc finalize --keep-sandbox` only to preserve a failed round for local debugging; a kept round must be followed by `acc cleanup --round <round_id>` before returning.

This documented spine is the PASS-gate contract. Do not open, grep, or line-slice `scripts/catalog.ts`, `scripts/commands.ts`, or any other ACC implementation file to predict whether finalize will pass. Invoke `acc finalize --verdict <PASS|FAIL|CONDITIONAL>` directly; if it returns a structured rejection, satisfy the reported requirement and retry the command.

Independent history verification uses `acc history --asset <asset-name-or-id>`; never invoke bare `acc history`, because its required `--asset` omission is a usage error. Other state checks still go through documented scoped `acc` reads. **DO NOT** run `sqlite3` on `state.sqlite3`; if a read is missing, add a narrow `acc` read command first.

After every successful phase-mutating command (`bootstrap`, `asset add`, `accept new`, `accept update`, `profile run-task`, `start`, `launch`, `feed-task`, `capture`, `record`, `finalize`, and debug-only `cleanup`), the next action must be the next concrete tool call in this spine, not a standalone prose summary.

If finalizing a round leaves any acceptance criterion unmet, any accepted cleanup missing, or any manually fixed behavior unproven, the next concrete action is a repair plus a new `acc start` for the same acceptance. **DO NOT** summarize as "done" from a failed or conditional round.
