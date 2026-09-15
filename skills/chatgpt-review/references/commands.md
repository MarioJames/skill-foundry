# Local records and background tasks

The Bun helper has no package dependencies. Private state defaults to `~/.local/share/chatgpt-review`; `CHATGPT_REVIEW_HOME` can select a task-private test directory. Never put this directory inside a public repository. Records and replies are mode `0600`, directories `0700`.

## Register or update a requirement

Write a task-private JSON file, then run `bun <skill-dir>/scripts/review.ts record --input /absolute/record.json`:

```json
{
  "id": "admin-auth-review",
  "title": "Authentication design review",
  "url": "https://chatgpt.com/c/<conversation-id>",
  "projectUrl": "https://chatgpt.com/g/<project-id>/project",
  "projectVerified": true,
  "background": "Requirement and accepted design decisions; no credentials.",
  "repo": "owner/repo",
  "revision": "Locally known commit; distinguish it from remotely verified revisions",
  "model": "Model observed in the UI",
  "summary": "What has been established and what remains unresolved",
  "status": "open"
}
```

`projectVerified` is true only after UI read-back. If a project move fails, record false and the blocker; do not claim it succeeded. `conversationCreatedAt` is optional and must come from actual conversation metadata, not the time of registration. The helper records a separate `recordedAt`/`updatedAt`.

`record` refuses to map an existing requirement ID to another conversation. To update background/summary/status, send the full record again. Supported status values: `open`, `blocked`, `complete`. Different project-prefixed URLs for the same conversation are treated as one identity.

```bash
bun <skill-dir>/scripts/review.ts list admin
bun <skill-dir>/scripts/review.ts show --id admin-auth-review
```

## Capture the submitted turn and watch

Discover the current target ID with the foreground session's `tab list --json`, then:

```bash
bun <skill-dir>/scripts/review.ts capture --id admin-auth-review --cdp 9222 --target <targetId>
```

Capture reports user message IDs and completion status, not full user-message text. Select the exact newly submitted `userMessageId`; do not guess from an old response. Route a Herdr service lane anchored to the caller using the installed `herdr` skill. `herdr pane run` takes the pane followed directly by the command; there is no extra `--` separator:

```bash
# Set these variables from the loaded skill directory and observed task/lane metadata.
herdr pane run "$LANE_PANE" bun "$CHATGPT_REVIEW_SKILL_DIR/scripts/review.ts" \
  watch --id admin-auth-review --cdp "$CDP_ENDPOINT" \
  --target "$TARGET_ID" --user "$USER_MESSAGE_ID" --notify-pane "$ORIGIN_PANE"
```

The command is long-running, so execute it in that service lane or a runtime-owned background task, not a foreground blocking exec. Keep the returned lane IDs/cleanup command in the task handoff. Do not create another model Agent just to run a timer. `--timeout-seconds` overrides the 1800-second deadline; polling remains 60 seconds.

Every watcher generates a unique `runId`, even when rechecking the same user message. Its initial NDJSON event and `watch/<id>.json` expose that ID. Save it in the task handoff as `RUN_ID`. The terminal result is written to `replies/<id>/<runId>.json` before terminal status is published; subsequent runs keep separate result files.

The watcher notifies the originating Agent through `herdr agent prompt` with the requirement ID, run ID, result path and status, plus a desktop notification. Use `result --id ... --run ...` to verify a notification still belongs to the current run before consuming it. Never embed the remote response as an instruction in the notification. Notification failures are recorded separately and do not discard a completed reply.

```bash
bun "$CHATGPT_REVIEW_SKILL_DIR/scripts/review.ts" status --id admin-auth-review --run "$RUN_ID"
bun "$CHATGPT_REVIEW_SKILL_DIR/scripts/review.ts" result --id admin-auth-review --run "$RUN_ID"
bun "$CHATGPT_REVIEW_SKILL_DIR/scripts/review.ts" cancel --id admin-auth-review --run "$RUN_ID"
```

Omitting `--run` selects the current run. `result` fails without printing a reply while that run is `starting` or `waiting`, when the requested run is no longer current, or when the result identity differs from status. Terminal outcomes are `complete`, `blocked`, `superseded`, `timeout` and `cancelled`; only `complete` contains a finished reply. State without a `runId` is rejected rather than treated as current; the helper does not migrate or remove old watcher state.

Only one watcher may own a requirement at a time. A live lock refuses a duplicate. On a stale lock error, inspect its recorded owner; do not remove it until that exact process is gone. Cancel writes a request bound to the current run, so a delayed request cannot cancel its successor. It never presses ChatGPT's stop button or kills Chrome and is observed at the next check, within one polling interval plus an in-flight browser operation. A status question does not cancel monitoring; leave the registered task running when no independent work remains.

Successful completion means the response is finished, not that its content approved the proposal or that a GitHub read succeeded. Login/challenge/UI failures and three consecutive browser-command failures stop with `blocked`; deadline expiry stops with `timeout`. Another user message arriving in that conversation marks the monitored turn `superseded`, so it cannot be mistaken for the new turn.

## Validation

`bun test <skill-dir>/tests` covers turn matching, current-run result gating, stale responses, partial generation, cross-conversation protection, record reuse, and lock behavior. CLI regression tests use task-private state and browser/notification command substitutes. For real browser verification use an explicitly authorized test prompt, record its submitted user ID and watcher run ID, and let a Herdr watcher observe it while the parent does other work. Read the result and verify the watcher exits, the original tab survives, and the exact service lane is removed. Report script tests separately from actual Agent/CLI acceptance.
