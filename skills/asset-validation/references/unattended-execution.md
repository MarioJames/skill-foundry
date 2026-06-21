# Unattended Execution

Use this reference when the user is away, sleeping, or explicitly asks for the whole acceptance flow to finish automatically.

## Fast Path Gate

Read only the asset entry files needed to classify type and purpose, record the pre-authorized confirmation, then make the first `acc` write `acc asset add`. For plugin assets, the entry file before this write is `plugin.json` only; do not read bundled `skills/`, `agents/`, hooks, marketplace files, or other implementation files until after `acc asset add`.

Do not inspect rig source, run environment checks, validate plugin internals, or print phase headings before that write. Do not read `references/`, `scripts/acc.py`, `scripts/observe.py`, run `python3 "$ACC" --help`, run `python3 "$ACC" asset --help`, run `ls "$ACC"`, or scan this skill directory before that first `acc asset add`; the command contract below is sufficient. After `acc asset add`, continue in the same execution batch to review/fix, write strategy files, `acc accept new`, `acc accept update`, and `acc start`; do not pause for open-ended thinking between these commands.

The first shell batch that touches `acc` must begin with the asset registration itself, not with `echo $ACCEPTANCE_TMPDIR`, `ls "$ACC"`, `python3 "$ACC" --help`, or command discovery:

```
ACC="$HOME/.claude/skills/asset-validation/scripts/acc.py"
python3 "$ACC" asset add --name <asset_name> --type <type> --source <source_path>
```

Do not open references before the first `acc asset add`; do not open references before the first `acc asset add`.

## Continuation Rule

In unattended mode, never return control after asset understanding, classification, tool preflight, review-and-fix, strategy drafting, or any phase summary; never return control after any phase summary. A progress summary is allowed only immediately before the next `acc` command or observe-loop action in the same turn.

If an unattended round returns FAIL/CONDITIONAL and the next action stays inside the asset-under-test or strategy/task design, record the failure, finalize that round, then immediately start the fix/rerun round. `acc finalize` performs round cleanup by default. Do not ask "should I continue" unless the fix would touch assets outside the asset-under-test, reset history, or expand destructive scope.

## Unattended Command Spine

Unattended command spine:

In unattended mode, do not expand rig source or run broad validation before `acc asset add`. Read only enough asset entry files to classify type/purpose (`plugin.json` only for plugins), record the pre-authorized confirmation, then run `python3 "$ACC" asset add --name <asset_name> --type <type> --source <source_path>` before review/fix. `acc asset add` still happens before review, validation, or rig introspection.

After `acc asset add`, the next action is not a phase heading or open-ended planning. Immediately run the review/fix scan. If no major blocker remains, immediately create strategy artifacts under:

```
WORK="$(mktemp -d "${ACCEPTANCE_TMPDIR:-${TMPDIR:-/tmp}}/acc-strategy.XXXXXX")"
```

never use a fixed path such as `/tmp/acc-toy` or `/tmp/acc-work-path.txt`. If the path must be persisted, write it to `"$WORK/.workpath"`.

Run:

```
acc accept new --asset <asset_id_or_name> --goal-file "$WORK/goal.md" --strategy-file "$WORK/strategy.md"
acc accept update --id <acceptance_id> --prompt-file "$WORK/acceptance-prompt.tmpl.md" --criteria-file "$WORK/acceptance-criteria.tmpl.md" --task-prompts-file "$WORK/tasks.json"
```

After updating acceptance artifacts, then run `acc start --acceptance <acceptance_id> --mode <mode> --cli <claude|codex>`, `acc launch --round <round_id> --cli <claude|codex>`, and `acc feed-task --round <round_id> --task t1`. In unattended mode, use `claude` unless the user explicitly selected `codex`.

Task prompts files are flat JSON objects only: `{"t1": "task body"}`. Do not write `{"tasks": [...]}` arrays or per-task objects; `tasks.json` must be a flat object like `{"t1": "body to send"}` because `acc feed-task --task t1` reads the top-level `t1` key.

Do not run `acc ... --help` or `acc record -h` during unattended execution; the command contract here is authoritative. Store raw ids in files when needed, never `KEY=value` lines unless the later command explicitly strips the prefix.

## Observe Loop Details

`acc start` idempotently prepares the round environment. It creates the sandbox workdir, the isolated acceptance DB root, `ACCEPTANCE_TMPDIR`, sandbox runtime roots, and sandbox Claude settings file before the asset-under-test starts. It preserves the invoking `HOME` so Claude/Code keeps the user's real auth and keychain state, while sandboxing acceptance state, temp files, marketplace/profile roots, and plugin staging through env vars plus Claude `--settings`/`--plugin-dir`.

The returned env includes `ACCEPTANCE_HOME` for the isolated acceptance DB, plus `ACCEPTANCE_SANDBOX`, `ACCEPTANCE_TMPDIR`, `TMPDIR`/`TMP`/`TEMP` pointing to `ACCEPTANCE_TMPDIR`, `HOME` pointing at the invoking user home, and `CMDAI_CLAUDE_SETTINGS_PATH`.

Do not write memories, global notes, or host configuration while observing or while running as the asset-under-test unless the user explicitly requests that persistent side effect. Environment workarounds and reusable lessons can be reported in the round record instead of persisted outside the acceptance evidence boundary.

Observer scratch/evidence workdirs must be created under `ACCEPTANCE_TMPDIR` from the `acc start` output, or under the returned round sandbox. Do not create top-level `asset-validation-round*` or sibling `/tmp/acc-*` scratch directories outside the current round boundary. `acc finalize` removes the round sandbox, kills only this round's `acc-<round_tag>` tmux session, cleans plugin staging, and cleans nested round sandboxes recorded in the sandboxed acceptance DB before deleting the parent sandbox.

`acc launch --round <round_id> --cli <claude|codex>` starts tmux with the selected real asset-under-test CLI and the start output's isolation env. For Claude plugin assets it stages the plugin under the round sandbox and launches with sandbox `--settings` plus `--plugin-dir`, not by writing bundled skills/agents into the real or symlinked HOME skill root.

`acc feed-task --round <round_id> --task t1` waits for the round pane input prompt, then sends the de-guided task body. After `acc feed-task`, do not run an open-ended background poll and do not wait for the round DB row to leave `running` before `finalize` because only `acc finalize` changes that DB verdict. Wait only for the pane to return to an input prompt or for a short bounded timeout.

Capture and record evidence:

```
acc capture --round <round_id> --out "$WORK/transcript.txt"
acc record --round <round_id> --transcript-file "$WORK/transcript.txt" --report <summary>
```

Run any needed `acc finding`, then `acc finalize`. A successful `acc finalize` must return a `cleanup` object showing that it removed isolation roots including `ACCEPTANCE_TMPDIR` and killed only this round's `acc-<round_tag>` tmux session. A pane showing the expected answer is not a verdict while the round table still says `running`; finish the database state with `acc finalize` before returning. Use `acc finalize --keep-sandbox` only to preserve a failed round for local debugging; a kept round must be followed by `acc cleanup --round <round_id>` before returning.

After every successful phase-mutating command (`asset add`, `accept new`, `accept update`, `start`, `launch`, `feed-task`, `capture`, `record`, `finalize`, and debug-only `cleanup`), the next action must be the next concrete tool call in this spine, not a standalone prose summary.
