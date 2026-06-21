# Initial review & early fix

Before producing the acceptance strategy, do one static review pass. If there are major logic problems, fix a few rounds until none remain, then produce the strategy.

Principles:
- Only edit the asset-under-test itself.
- Look for: trigger-surface errors (description too broad/narrow), obvious script bugs, broken state machine / control flow, drift between docs and implementation.
- Script-bearing assets: first confirm scripts actually run (syntax, dependencies, the bash 3.2 empty-array `set -u` trap), then review logic.
- After fixing, briefly state what changed and why. Once there are no major problems, move to "produce strategy".

## Gotchas
- macOS ships bash 3.2: expanding an empty array under `set -u` aborts. Verify shell stubs with `/bin/bash`, guard with `${arr[@]+"${arr[@]}"}`.
- Don't "improve" unrelated code while reviewing — stay scoped to defects that affect acceptance.
