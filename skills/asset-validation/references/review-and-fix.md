# Initial review & early fix

Before producing the acceptance strategy, do one static review pass. If there are major logic problems, fix a few rounds until none remain, then produce the strategy.

Principles:
- Only edit the asset-under-test itself.
- Review-only has no strategy `WORK` by default. Re-resolve the Bun ACC entry in each shell batch if it is needed; never write `"$WORK/.acc-path"` unless `WORK` was created and validated as a non-empty absolute directory in that same batch. Put temporary review inputs under `mktemp -d "${ACCEPTANCE_TMPDIR:-${TMPDIR:-/tmp}}/<purpose>.XXXXXX"`, not a fixed or top-level `/tmp` path.
- Do not widen a completed review with optional error-path or portability probes that the task did not request. For a requested exit-code check, create the isolated scratch first, then capture with `>"$SCRATCH/stdout" 2>"$SCRATCH/stderr"`; never redirect to an illustrative `/tmp-placeholder`, `/dev` guess, root path, or other unvalidated target.
- Look for: trigger-surface errors (description too broad/narrow), obvious script bugs, broken state machine / control flow, drift between docs and implementation.
- Script-bearing assets: first confirm scripts actually run (syntax, dependencies, the bash 3.2 empty-array `set -u` trap), then review logic.
- Skill assets should run the active skill-creator's canonical validator. Prefer a discovered Bun/TypeScript entry: `bun <skill-creator-dir>/scripts/quick_validate.ts <skill_dir>`. Search symlinked roots with `find -L`, checking `${CODEX_HOME:-$HOME/.codex}/skills` and `$HOME/.claude/skills`. If no `quick_validate.ts` exists, discover and run the authoritative external fallback with `python3 <skill-creator-dir>/scripts/quick_validate.py <skill_dir>`. That Python file belongs to the external skill-creator and is a review tool only; it is not imported by ACC, shipped in this skill, or a runtime dependency of `scripts/acc.ts`. If neither canonical entry exists (or its required interpreter is unavailable), state that gap in the report and run the asset's declared Bun check (for example, `(cd <skill_dir> && bun run check)`) when available. A custom smoke test must not silently claim canonical validation.
- Do not inspect, grep, or read an external validator's implementation merely to predict its dependencies. Run the discovered entry directly. If and only if its failure explicitly says `ModuleNotFoundError: No module named 'yaml'`, and the task allows temporary `uv` use, rerun it as `uv run --no-project --with pyyaml python3 "$VALIDATOR_PY" <skill_dir>`; do not mutate project or global Python state.

Use this discovery order without assuming a hard-coded global install:

```bash
VALIDATOR_TS="$(find -L "${CODEX_HOME:-$HOME/.codex}/skills" "$HOME/.claude/skills" -path '*/skill-creator/scripts/quick_validate.ts' -type f 2>/dev/null | head -1)"
VALIDATOR_PY="$(find -L "${CODEX_HOME:-$HOME/.codex}/skills" "$HOME/.claude/skills" -path '*/skill-creator/scripts/quick_validate.py' -type f 2>/dev/null | head -1)"
if [ -n "$VALIDATOR_TS" ]; then
  bun "$VALIDATOR_TS" <skill_dir>
elif [ -n "$VALIDATOR_PY" ] && command -v python3 >/dev/null 2>&1; then
  python3 "$VALIDATOR_PY" <skill_dir>
else
  echo "canonical skill validator unavailable" >&2
fi
```
- After fixing, briefly state what changed and why. Once there are no major problems, move to "produce strategy".

## Gotchas
- macOS ships bash 3.2: expanding an empty array under `set -u` aborts. Verify shell stubs with `/bin/bash`, guard with `${arr[@]+"${arr[@]}"}`.
- macOS uses BSD `cat`, which has no GNU `cat -A`. For visible whitespace and line endings use the portable `sed -n 'l' <file>` (or `od -An -tx1c <file>` when byte-level evidence is needed); do not spend an acceptance attempt probing unsupported GNU-only flags.
- `rg -n` emits `line:text`, not a bare line number. Never interpolate its whole output into a BSD `sed` address: that turns source text into a sed program and can fail with `invalid command code`. If a bounded source slice is genuinely needed, extract and validate the numeric prefix first (for example, `match_line="$(rg -n -m1 '<pattern>' <path> | cut -d: -f1)"`, verify it with `grep -Eq '^[0-9]+$'`, then use `sed -n "${match_line},$((match_line + 40))p" <path>`). Do not inspect ACC implementation this way to discover its command contract or PASS gate; those are defined by `SKILL.md` and `references/unattended-execution.md`.
- Ripgrep and grep exit `0` for a match, `1` for no matches, and `2+` for an actual error. When an empty inspection result is valid, handle only code 1 explicitly: `rg -n '<pattern>' <path> || { rg_rc=$?; [ "$rg_rc" -eq 1 ] || exit "$rg_rc"; }`. Apply the same pattern with a task-specific variable to `grep`. Do not chain an optional probe through `&&`, and do not use blanket `|| true`, which hides real path, syntax, and I/O errors.
- Don't "improve" unrelated code while reviewing — stay scoped to defects that affect acceptance.
