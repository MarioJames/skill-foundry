# {{ASSET_NAME}} acceptance criteria

Overall verdict: PASS / CONDITIONAL / FAIL.
Per-item: GREEN/AMBER/RED (expand along the dimensions in references/asset-strategies/{{ASSET_TYPE}}.md).
Verdict owner: observer only. The asset-under-test output can be evidence only when corroborated by observed commands, transcript markers, files, processes, state, or cleanup checks.
Coverage ladder: smoke / representative / complex / failure-recovery / negative-boundary. Declare it with `acc accept update --ladder-file`; `acc finalize --verdict PASS` mechanically blocks while any declared rung task lacks a non-stale PASS round (`--allow-partial <reason>` records a waived finding). After a qualifying boundary-only additive fix, the reason may explicitly map unaffected task keys to retained PASS round ids; every changed or dependent task still requires a fresh PASS. Mark any rung intentionally left out of the declaration, and why.
Asset-fit: criteria must explain why each rung is realistic for this asset type and which claimed capability it covers. Generic toy tasks unrelated to the asset domain are insufficient evidence except for smoke.
Hard-fail items: {{HARD_FAILS}}.
