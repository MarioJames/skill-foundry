# Local records and background tasks

The Bun helper has no package dependencies. Private state defaults to `~/.local/share/chatgpt-review`; `CHATGPT_REVIEW_HOME` can select a task-private test directory. Never put this directory inside a public repository. Records and replies are mode `0600`, directories `0700`.

## Open, reuse and close task tabs

The durable binding is `records/<requirement-id>.json`: task ID → conversation URL, project, repository and summary. Browser session names and CDP target IDs are temporary and never replace this binding. Search `list <keywords>` or persistent memory when the ID is unknown, check the exact requirement/repository with `show --id ...`, then:

```bash
bun <skill-dir>/scripts/review.ts open --id admin-auth-review --cdp 9222
```

For a registered task, `open` focuses an existing tab on that conversation or opens its stored URL in a new tab. For a new task, it opens the configured project; after the first submission immediately register the observed conversation URL. Repeat calls reuse the managed tab. A managed tab that has navigated elsewhere fails instead of opening duplicates or navigating it away. The output includes `target`, `owned`, `reused`, and `url`; pass this target to model checks, capture, watch and organize. It never sends a message. An existing tab is treated as user-owned unless this helper already recorded creating it.

The private `tabs/<id>.json` records ownership separately from the durable conversation record. Keep both under the Home state directory; do not use a temporary directory that gets deleted between tasks. OpenViking can additionally index the task, repository, conclusion and link for semantic discovery, but no memory-service call is needed to reopen a known ID.

After reading the current completed result, attempt `organize` and save the final summary. Use `status: complete` after successful organization, or `status: blocked` with the actual organization error when it cannot finish. In either case, release the completed task tab:

```bash
bun <skill-dir>/scripts/review.ts finish --id admin-auth-review --cdp 9222 --run <currentRunId>
```

This is a required controlling-Agent cleanup step, not a suggestion to the user. `finish` requires the saved completed result for the **current** run and a complete/blocked record, checks the live page is still on that completed turn, rechecks the current run before closing, closes only its recorded owned target, then verifies that target is gone. Organization failure does not block resource release: `organizationPending: true` reports outstanding title/project work without changing its error or verification flags; an incorrectly complete record is marked blocked. Reopen the durable conversation for recovery; tab closure alone never means the review is fully complete. Rerunning after closure is safe. It preserves user-owned/untracked tabs, active or newer turns, unrelated pages, other tabs, Chrome and login data. When the owned target is the last tab, it leaves an inert `about:blank` tab to keep the shared browser alive. It retains records and replies so `open` later restores the same conversation, even after browser restart. A user request to keep the tab open takes precedence; include the target and reason in the handoff. Failed/blocked monitoring still retains the tab when no completed reply can be verified and must be reported. A changed target is also retained: inspect it explicitly, and close its exact recorded owned target only after confirming it is an idle disposable project/draft page with no unsent text or active work. Never infer ownership from the URL alone. For task-created diagnostic tabs outside `open`, close their exact observed targets explicitly after use; never call browser-wide `close`.

## Configure and verify conversation organization

Read the existing private policy with `review.ts preferences`. Configure it once from the user's standing instructions and an observed project URL; do not hardcode a personal project or its ID in the skill:

```bash
bun <skill-dir>/scripts/review.ts configure \
  --project-url <observedProjectUrl> --project-name <exactProjectName> \
  --timezone Asia/Shanghai --language en
```

This writes only mode-0600 `preferences.json` under the private state root. `en` uses `FEA/DES/FIX/OPT/REL/EXP/DOC/RES`; `zh` uses their corresponding 功能/设计/修复/优化/发布/探索/文档/研究 labels. The supported title format is `MMDD｜TYPE｜Topic`, using **conversation creation time** in the configured timezone. Topic summarizes this conversation without repeating its project. If the user's naming policy differs, follow it through the UI with equivalent persistence verification instead of coercing it into this format.

After registering the assistant-created conversation and finishing its active response:

```bash
bun <skill-dir>/scripts/review.ts organize --id admin-auth-review \
  --cdp 9222 --target <targetId> --type FIX --topic 'Authentication recovery'
```

The command binds to the registered conversation and refuses an active response or changed page. It reads the latest loaded conversation response (reloading if the browser session did not capture it), selecting only ID, title, `create_time`, project ID and archive/pin flags. Request headers, credentials, prompts and full response bodies are never printed or persisted. It uses the target's sidebar options to rename and independently move to the configured project. It never clicks Archive or changes pin/star flags. Open the target's project/history in the same tab first if its sidebar entry is unavailable; the command does not search or navigate other chats.

Each change must receive a successful save response before reloading, then match a **new** successful conversation GET. Menu closure and local DOM text alone do not count. HTTP rejection stops without repeatedly submitting or reloading away an unacknowledged save. Success returns `verified: true`, the actual title/creation time/project, and `changed`; it updates the private requirement record with `titleVerified`, `projectVerified` and `organizationVerifiedAt`. Rerunning an already organized conversation verifies it without renaming or moving again. Failure exits nonzero and records `organizationError` with verification flags false, even after a partial successful change. Correct the reported problem and rerun without resending the review prompt. Do not declare the review fully complete with these flags false or omit the pending step from a handoff; release the completed conversation tab with `finish` while retaining the blocked record.

## Select and verify the model before sending

Use the observed loopback CDP endpoint, target ID, and exact page URL. New unsent chats are supported; this command does not require a registered conversation:

```bash
bun <skill-dir>/scripts/review.ts ensure-model --id admin-auth-review \
  --cdp 9222 --target <targetId> --url <observedChatGPTUrl> --model "6 Pro"
```

`--model` defaults to `6 Pro`; other models are rejected before browser attachment. The command pins its session to the supplied target, checks the URL before each action, selects Latest when needed, focuses Power and increases it to Pro, then confirms both `6 Pro` / `Pro, 5 of 5` in the menu and `6 Pro` on the closed control. Already-correct settings are checked without toggling their model or power. UI drift, disabled controls, login/challenge, an active response, a changed page, or a model label mismatch produce a nonzero exit. Retries are bounded; failure never sends a message or falls back to a lighter model.

Success returns JSON with `verified: true`, `expectedModel`, `observedModel`, `before`, `changed`, `url`, `target`, `session`, `verifiedAt`, and menu/power `evidence`. Require exit code 0 and check the result's target and URL immediately before sending. It does not submit, navigate, reload, close Chrome, update the requirement record, or verify backend inference. Use `observedModel` when recording the turn; repeat the command for each follow-up and after navigation or any model change.

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

Initially use `projectVerified: false` unless placement has actually been verified; `organize` verifies and fills both title/project flags and `conversationCreatedAt`. Preserve those fields when updating the record. A failed or deferred organization remains outstanding work, not a completed review. The helper's separate `recordedAt`/`updatedAt` must never supply the title date.

Set `model` to the label observed after the [pre-send model selection gate](conversation.md#select-the-review-model-before-every-send), refreshing it for each submitted turn. This field records the observation; `record` does not validate the model or replace `ensure-model`.

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

`bun test <skill-dir>/tests` covers model switching and read-back, model/UI failures, turn matching, current-run result gating, stale responses, partial generation, cross-conversation protection, record reuse, lock behavior, organization persistence, task URL reuse, tab ownership, and safe completion cleanup. CLI regression tests use task-private state and browser/notification command substitutes. Run `bun <skill-dir>/tests/browser.integration.ts --chrome <installed-Chrome-path>` for real connection/cleanup regression: it uses a disposable Chrome profile and private namespace, checks that listing and binding add no blank tabs, verifies pin protection after target closure, and releases its own browser/clients. It sends no ChatGPT messages and does not attach to the user browser. Validate model selection on an authorized unsent browser tab with a lower initial model/power, run `ensure-model`, read back the UI, and rerun to confirm idempotency; no test prompt is needed. To verify response monitoring, use an explicitly authorized test prompt, record its submitted user ID and watcher run ID, and let a Herdr watcher observe it while the parent does other work. Read the result and verify the watcher exits, the original tab survives until its reply is consumed and organized, `finish` closes only the owned target, `open` reuses the persisted link, and the exact service lane is removed. Report script tests separately from actual Agent/CLI acceptance.
