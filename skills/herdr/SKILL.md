---
name: herdr
description: "Proactively control Herdr to shorten the critical path. Trigger automatically when HERDR_ENV=1 and a task has independent repository, module, file-ownership, research, check, or test lanes; a long-running command, service, or monitor can overlap useful work; an additive independent user request arrives while another task is still running; or a coding agent can own an independent deliverable. Also trigger whenever the user mentions Herdr, panes, or tabs. Do not trigger for a superseding request, one short command, tightly serial work, overlapping mutable state, or coordination overhead that exceeds the likely saving. Requires HERDR_ENV=1."
---

# Herdr

Use Herdr when it shortens the task's critical path, not merely to increase pane count.

## Recognize useful concurrency

- **Fan out and join:** split independent repositories, exclusively owned modules/files, research alternatives, or checks/tests. Let the root lane integrate results and verify the combined outcome.
- **Overlap waiting:** run a long build, test, server, or monitor in its own pane while useful work continues elsewhere.
- **Accept an additive task mid-run:** when a new user message adds an independent request instead of replacing the active one, keep the active lane moving and start a coding-agent pane with a self-contained cwd, scope, constraints, ownership, and deliverable.
- **Stay serial:** do not split a replacement request, dependency chain, overlapping edits, shared mutable state, or work whose resource contention/merge cost cancels the saving. If “replace or add” is materially ambiguous, clarify before spawning.

## Decide and split

1. Check `test "${HERDR_ENV:-}" = 1`. If false, continue without Herdr unless the user explicitly required it; then report that Herdr is unavailable.
2. Identify independent lanes before splitting. Start the slowest useful lanes first and keep doing useful work in the caller pane.
3. Estimate whether `max(lane durations) + coordination overhead` beats serial execution. Avoid delegating trivial work or splitting tightly dependent steps.
4. Use sibling panes in the current tab only when the lane belongs to the caller's workspace/repository. When its target cwd is materially different, route it to the workspace that represents that directory and create a tab there; do not put it in the caller's workspace merely because that workspace is current.
5. Classify every created pane before launch: `oneshot`, `service`, or `coding-agent`. This classification determines cleanup.

Inspect only the relevant current CLI group before using it, for example `herdr pane` or `herdr agent`. The installed CLI is authoritative. Do not call `herdr --skill` during normal operation; use it only when the user explicitly requests the full manual, or after a concrete CLI failure that the relevant group output cannot resolve.

## Route by directory

Prefer [`scripts/route-lane.ts`](scripts/route-lane.ts) for create-time classification, workspace probing, and resource creation:

```bash
target_cwd=$PWD
skill_dir=/absolute/path/to/herdr
"$skill_dir/scripts/route-lane.ts" --type oneshot --scope same-task --cwd "$target_cwd" --caller-pane "$HERDR_PANE_ID"
"$skill_dir/scripts/route-lane.ts" --type coding-agent --cwd /target/repo --label task-name --caller-pane "$HERDR_PANE_ID"
```

Resolve the script relative to this `SKILL.md`, but capture the intended target cwd **before** any `cd` used to reach the skill directory. Prefer invoking the resolved absolute script path without changing directories. Never write `cd "$skill_dir" && scripts/route-lane.ts --cwd "$PWD"`: the target then becomes the skill directory and can create a workspace in the wrong place. `oneshot` and `service` default to `same-task`; `coding-agent` defaults to `independent`. Use `--dry-run` to inspect the decision without mutation. The script returns one JSON object containing `action`, matched and created IDs, and an exact `lane.cleanup_command` argv array. It creates only the routed pane/tab/workspace; start the command or agent separately using `result.pane_id`. When cleanup is due, execute that array exactly once and verify absence. Do not stringify, join, truncate, or `eval` it as shell text: execute it directly with Bun, for example `bun -e 'const p=JSON.parse(await Bun.stdin.text()); const r=Bun.spawnSync(p.lane.cleanup_command,{stdin:"inherit",stdout:"inherit",stderr:"inherit"}); process.exit(r.exitCode)' < "$route_json"`. Do not close the pane first and then try to close its parent tab/workspace.

For two or more sibling lanes, route the first lane normally. If that first route creates a workspace or tab, anchor every later `same-task` sibling route with `--caller-pane <first-result.pane_id>`, not the original caller pane. Then require each later result to have the same `result.tab_id` as the first lane. Reusing the original caller after the target workspace exists selects `create-tab`, producing adjacent tabs rather than sibling panes.

For a read-only directory lookup without type routing, use [`scripts/probe-workspace.ts`](scripts/probe-workspace.ts) with `--cwd <path>`. Both commands run directly through their Bun shebang, require `bun` and the installed `herdr` CLI, support paths containing spaces, and emit structured JSON errors with nonzero exit status. They use only Bun and Node built-ins; no package install is needed.

The router applies this fallback decision process internally; use it manually only when the script is unavailable:

1. Normalize the target cwd and, when applicable, resolve its Git/worktree root.
2. Read IDs with `herdr workspace list`, then inspect `cwd` and `foreground_cwd` using `herdr pane list --workspace <id>` for each candidate. Never treat the workspace label or a broad ancestor such as the home directory as directory evidence.
3. Prefer an exact cwd match, then a matching Git/worktree root. If a workspace matches, create the lane with `herdr tab create --workspace <id> --cwd <target-cwd> --no-focus`.
4. If none matches, create a workspace rooted at the target cwd with `herdr workspace create --cwd <target-cwd> --no-focus` instead of adding the tab to an unrelated workspace.
5. Verify the returned workspace, tab, root-pane IDs, and cwd before starting the command or coding agent.

## Operate

- Inspect layout before choosing `right` versus `down`.
- When adding multiple sibling panes around a primary/root pane, split the primary pane only once. Use that first secondary pane as the next split anchor, then continue splitting the newly created secondary branch. Repeatedly splitting the primary pane makes it the smallest viewport; chaining splits through the secondary branch keeps the primary pane as the largest observable area.
- Resolve the caller once with `herdr pane current --current`, record its returned pane and tab IDs, then use explicit IDs for every split, run, read, wait, move, and close. Never call `herdr pane current` without a target; UI focus may belong to another workspace.
- After every create, split, or move, verify the returned `tab_id`/`workspace_id` matches the intended parent before doing anything in the new pane.
- Preserve context and user focus with `--cwd "$PWD" --no-focus`.
- Preserve the tool shell's cwd across tasks: never use a bare `cd <target> && ...` for a probe, because that cwd may persist into later Bash batches and later skill invocations. Use a subshell `(cd <target> && ...)`, a command-native cwd option, or restore the saved physical cwd before the batch exits.
- Parse pane, tab, and agent IDs from command JSON; never predict IDs or rely on UI order.
- Use pane commands for shells, tests, servers, and logs. Use agent commands only for recognized coding agents.
- Target `--current`, an explicit ID, or a unique agent name; never depend on another client's focused pane.
- Honor a user-selected agent kind. Otherwise inspect `herdr agent` and choose the kind appropriate to the lane.
- Treat the `herdr pane run` payload as source text for the target interactive shell. Construct it once and pass it as one argument; do not take an already shell-escaped representation (for example text containing literal `\'` quote escapes) and inject it again.
- Keep that payload physically on one line across the caller/tool transport. A `\n` written inside a generated tool command can be decoded into a real newline before the target zsh receives it, splitting a quoted command and leaving the pane at a continuation prompt. For completion output, prefer a newline-free payload such as `command; check_rc=$?; echo "HERDR_CHECK_${token} rc=${check_rc}"`; if multiline input is genuinely required, send separately completed pane runs instead of embedding newline escapes.
- Assume the target shell may be interactive zsh. A `!` inside double quotes still triggers history expansion there, so the source received by the target must put negative globs in single quotes (for example `--glob '!bun.lock'`). When the caller supplies an exact command or the task is validating quoting, copy its option spelling literally into the target payload: `-g` is not acceptable evidence for `--glob`, even though ripgrep treats them as aliases. Before `pane run`, inspect the actual payload variable and make the exact literal a local gate (for this example, `[[ "$payload" == *"--glob '!bun.lock'"* ]]`); after the run, quote the echoed payload rather than describing a different command. Do not put `unsetopt BANG_HIST` earlier on the same payload line: zsh expands history for the complete line before executing that command. If disabling history expansion is unavoidable, send `unsetopt BANG_HIST` as its own pane run, wait for the shell to become idle again, then send the second payload.
- Also account for zsh `NOMATCH`: a glob with zero matches aborts the payload with `no matches found`. Prefer `find` or `rg --files` when zero matches are valid, quote a pattern meant for another program, or enable `NULL_GLOB` only for the bounded payload that needs it.
- Give every lane a bounded result contract: exit status, concise findings, and exact evidence paths. Filter or cap logs inside the lane instead of returning whole files or repository-wide dumps to the owning pane.
- Avoid fixed scratch or route-capture files such as `/tmp/lane1_route.json`. They can collide with another task and a later `rm -f` can delete someone else's evidence. Prefer keeping router JSON in a shell variable and parsing it with Bun; if files are necessary, create a task-owned directory with `scratch_dir="$(mktemp -d "${ACCEPTANCE_TMPDIR:-${TMPDIR:-/tmp}}/herdr-route.XXXXXX")"`, write only beneath it, and remove that exact directory after use. To verify removal in zsh, never probe `herdr-route.*` with `ls` or another raw optional glob; use `find "$scratch_parent" -maxdepth 1 -type d -name 'herdr-route.*' -print` and assert that its captured output is empty.
- For completion waits, ensure the match marker does not occur verbatim in the echoed command; construct it from pieces or verify foreground-process state as well.
- Do not use a deliberately shorter `pane wait-output --timeout` as a polling mechanism for a command with a longer bound: timeout is a failed Herdr command, not a neutral "still running" result. For progress checks use non-faulting `pane process-info --pane <pane_id>` or `pane read <pane_id>`; issue `wait-output` only with the real remaining completion bound.
- Join all required lane results before integration, and independently verify failures or ambiguous agent states.

## Safety and cleanup

- Keep background work unfocused unless the user asks to switch context.
- Never close a pane, tab, workspace, or session that this task did not create without explicit permission.
- Close exactly the resource named by the router's `lane.cleanup_resource`, using `lane.cleanup_target_id` or the returned `lane.cleanup_command` argv array. If using the array, pass it directly to `Bun.spawnSync`; do not coerce it into a whitespace-delimited string or pick fixed array positions. A single-pane tab/workspace is removed automatically when its last pane closes, so closing a child and then its parents creates avoidable `tab_not_found` or `workspace_not_found` failures.
- Prove cleanup with a non-faulting collection read: use `herdr workspace list` and confirm the closed workspace ID is absent, or inspect a still-existing parent before closing it. Do not query a deleted workspace/tab/pane merely to obtain `not_found` and call that success; the transcript must remain free of avoidable command errors.
- Do not treat `unknown` agent state as completion; inspect state and recent output.
- Close a task-created `oneshot` pane as soon as its exit status and bounded result have been collected, including after handled failures. Keep it only while concrete debugging evidence is still needed.
- Keep a useful `coding-agent` pane available for follow-up by default. Close it only when it was explicitly disposable, the user requests full cleanup, or it has no remaining value after its result is integrated.
- Keep a `service` pane only while something depends on it; then stop the service and close the pane. Report every retained pane's purpose and identifier, plus the port for services.
- Never close the caller/root coding-agent pane as part of child-lane cleanup.

## Gotchas

- More panes can make the critical path worse through startup, duplicated discovery, and merge overhead.
- Reusing the primary pane as the caller for every split progressively shrinks the pane the user is watching. For a multi-pane fan-out, record `primary_pane_id`, split it once, and update a separate `split_anchor_pane_id` to each newly created secondary pane for subsequent routes; never overwrite the primary ID.
- Fixed `/tmp/...` filenames are shared state, not disposable task ownership. Never write or delete predictable route JSON/error files there; use the isolation-aware `mktemp -d` pattern above.
- Unbounded lane output can erase execution-time savings by moving the bottleneck into root-context processing.
- A new user message is not automatically a new lane: status questions should be answered while work continues, and replacement requests should supersede stale work rather than fork it.
- Pass the payload of `herdr pane run` as one correctly quoted shell argument. Check for shell parse errors before waiting for a success marker.
- Do not embed an unverified `\n` escape in a generated pane payload. Tool/JSON decoding may turn it into a physical line break before zsh parses the command. Keep routine payloads single-line and use `echo` for the completion marker; after `pane run`, read the pane once and reject continuation prompts or unmatched-quote diagnostics before waiting.
- A newly created pane can briefly report its shell before it actually accepts input, which makes an immediate `herdr agent start` fail with `agent_pane_busy`. `route-lane.ts` performs an input/output readiness round trip before returning. After manual pane/tab/workspace creation, send a non-colliding marker with `herdr pane run`, match it with `herdr pane wait-output`, then confirm `process-info` has returned to the foreground shell before starting an agent.
- The router's readiness handshake is intentionally bounded at 15 seconds because a new interactive pane can take longer than 5 seconds to accept and echo input on a busy host. Do not wrap `route-lane.ts` in a tighter outer timeout; on `pane_not_ready` it rolls back the resource, after which the documented manual marker round trip is the safe fallback.
- In interactive zsh, `--glob "!file"` raises `event not found`. Use `--glob '!file'` in the source received by the target shell, and retain `--glob` when that exact form is under test rather than shortening it to `-g`. Treat the actual payload string as the evidence: gate it locally before sending and never report the requested long option when the echoed command used the short alias. `unsetopt BANG_HIST; rg --glob "!file" ...` on one payload line still fails because history expansion happens before `unsetopt` executes; disabling the option requires a separate completed pane run.
- In zsh, an unmatched pathname glob is an error rather than an empty list. Do not put optional raw globs in loops or argument lists; use `find`/`rg --files`, quote patterns consumed by another program, or opt into `NULL_GLOB` locally.
- Do not pass a display-escaped payload back to `herdr pane run`; sequences such as literal `\'` fragments can leave the target shell waiting at a continuation prompt. Preserve the original payload string and quote only at the caller boundary.
- Do not assign shell results to zsh special parameters such as `status`; zsh treats them as read-only and aborts the remaining payload. Use a task-specific name such as `typecheck_rc` or `test_rc`, especially before emitting the completion marker.
- Capture the requested cwd before changing into a skill/tool directory. `cd "$skill_dir" && route-lane.ts --cwd "$PWD"` silently routes the skill directory, not the caller's original cwd; use an absolute script path plus a saved `target_cwd`.
- Do not blindly resolve a relative target as `"$PWD/<relative>"`: a previous persistent `cd` can duplicate the path (for example `.../fixture/herdr-work/fixture/herdr-work`). At invocation start, resolve from a stable task root (`$ACCEPTANCE_SANDBOX` for acceptance fixtures, an explicit user/workspace path otherwise), require `test -d "$target_cwd"` before calling the router, and keep every exploratory `cd` inside a subshell.
- Herdr pane target syntax is inconsistent: use positional IDs for `herdr pane read "$pane_id" ...` and `herdr pane wait-output "$pane_id" --match "$marker" --timeout 15000`, but use `--pane "$pane_id"` for `pane layout` and `pane process-info`. For both commands, take that value from `lane.result.pane_id`; never pass `lane.result.tab_id` (such as `w11:t1`) to `--pane`, because it returns `pane_not_found`. Putting the wait target after `--match`, or passing `--workspace` to layout, is parsed incorrectly.
- On current Herdr, combining `--source recent-unwrapped` with `--lines N` can make `pane wait-output` miss an existing marker and can truncate `pane read`. Do not pass `--lines` to readiness waits; after the completion marker matches, bound evidence with task-specific filtering or a source mode verified not to truncate the needed result.
- A `wait-output` timeout exits nonzero. It is not a safe periodic status probe; use `process-info`/`read` while work is expected to continue, then perform one completion wait with a timeout at least as long as the lane's remaining bound.
- Cleanup is one routed operation, not a pane → tab → workspace cascade. For `create-workspace`, run the returned `herdr workspace close <id>`; for `create-tab`, close the returned tab; for `split-pane`, close only the returned pane. Closing the last pane already removes its empty parents, so subsequent parent closes fail with `not_found`.
- `lane.cleanup_command` is JSON argv, not a shell command string. Joining or hand-parsing it can silently drop the final target ID and execute only `herdr workspace close`; direct array execution through `Bun.spawnSync` is the canonical path.
- After that cleanup, verify disappearance from a list of surviving resources; do not issue `pane list --workspace <deleted-id>` or equivalent probes whose expected result is `not_found`.
- Commands that mutate state may execute with defaults when probed without required-looking arguments; use the documented group help instead.
- Herdr logical control-key names use a plus sign: `herdr pane send-keys <pane_id> ctrl+c` (and likewise `agent send-keys`). `ctrl-c` is invalid. Read `herdr --skill` or the relevant group help instead of guessing key spelling.
- A successful lane is not integrated evidence: verify the combined result in the owning pane.
