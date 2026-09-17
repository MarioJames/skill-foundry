# Reviews through the Convorel conversation service

Convorel is required for this skill’s browser-backed review workflow. This skill initiates review tasks and owns review policy. Convorel owns the complete conversation lifecycle: creation/binding, continuation, persistence, recovery, turn tracking, waiting/results, requested organization and safe resource release, plus read-only code access. Calling lifecycle commands from a skill does not transfer their state machine to the skill. The former in-skill browser/record/watcher runtime is retired.

## Resolve installation and private state

Use the installed `convorel` executable, or resolve the checkout/package CLI and invoke `bun --no-env-file /absolute/path/to/convorel/src/cli.ts`. Read its `--help` and installation `docs/quickstart.md` for configuration and tunnel setup. There is no bundled Convorel skill or skill wrapper.

Use the requirement's existing `CONVOREL_HOME` on every command. For a new binding, choose persistent private storage outside MCP-shared roots, then initialize with the authorized workspace, observed loopback CDP endpoint, model and designated project:

```bash
convorel init --workspace /absolute/project --cdp 9222 --model '6 Pro' \
  --project-url <observed-project-url> --project-name <exact-project-name> \
  --timezone Asia/Shanghai
```

The default review model is this skill's policy, not Convorel's default: new Convorel configuration requires an explicit model. Honor a user-selected alternative. Check `conversation status` for an existing task's saved model/project before sending: task configuration is snapshotted at creation, so changing init does not change an existing task. If its model differs from the required review model, stop and report that mismatch; do not send under an unintended model or create a duplicate review to evade it.

Reuse configured project preferences from authorized private records; do not copy personal values into this skill. `doctor` checks local CDP/MCP health, not remote ChatGPT code access. Do not install tools, widen roots or start a second tunnel merely to repair a failed review.

## Prepare and send

Use `conversation list`, then `conversation status --id ID`, and match the exact requirement/workspace. For known tasks retain the same home and ID. Older Convorel `review` commands are now named `conversation`; existing task JSON remains valid.

Write the complete request to a private UTF-8 file. Adapt [review-prompt.md](review-prompt.md), then add the actual decision, constraints, exact project path/revision, key code blocks with explanations, relevant paths for MCP reads, verified test summaries and unresolved questions. The template is guidance, not an automatic wrapper. Convorel sends only its correlation marker plus your file contents. It adds no workspace path, persona, template or source bundle. Inspect the final file before submission.

```bash
convorel conversation start --id ID --prompt-file /private/request.md
```

Record the returned `currentRun`, conversation URL when observed, and private state root. Sending is already guarded by the transport's current model/page check; no separate skill-owned model command is needed. Repeating the same request key/content does not resend. A conflicting key/content fails.

For a material follow-up after consuming the current completed response and organizing the conversation:

```bash
convorel conversation followup --id ID --prompt-file /private/followup.md --request-id UNIQUE_KEY
```

Each follow-up file must include whatever new instructions/context that turn needs; Convorel does not inject review policy. It restores the existing remote conversation and retains earlier local runs, so a follow-up is not a fresh disconnected session.

## Monitor, consume, organize and finish

Run `conversation wait --id ID --run RUN_ID` in a task-owned Herdr service lane using the installed herdr routing skill. It checks every 60 seconds. Keep the returned lane IDs and cleanup command. Convorel emits status JSON and an exit code; it does not notify the parent itself. Arrange completion notification through the owning runtime/Herdr lane, then verify the exact result instead of treating a notification as the answer.

```bash
convorel conversation status --id ID --run RUN_ID
convorel conversation resume --id ID --run RUN_ID
convorel conversation result --id ID --run RUN_ID
convorel conversation organize --id ID --run RUN_ID --type DES --topic 'Decision topic'
convorel conversation finish --id ID --run RUN_ID
```

`resume` observes and reconciles; it does not send. For a `prepared` run whose pre-send error has been resolved, explicitly call `conversation retry --id ID --run RUN_ID` to continue the same recorded message. It rechecks model, page and draft; never retry `submitting`/`delivery_unknown` or replace a changed draft to force progress. Only a current completed `result` may be consumed. Assess findings locally and store the decision, accepted/rejected points, revision and limits in the existing private task deliverable or memory. Do not edit service JSON or fabricate verification flags.

Organization must return `verified: true` for configured title/project. A returned `error` remains unfinished work even if the CLI exits zero. Record it, then still attempt finish on a verified completed turn; `organizationPending` preserves the error without retaining a disposable owned tab. Finish never authorizes cleanup of other tabs or state. Report retained targets/reasons and release only the task-owned watcher lane. Keep durable state for future reuse. `finish` releases owned browser resources; it does not delete conversation history. A completed `resume` can return saved state without opening the page; `followup` restores it when a new turn is requested. Do not implement a parallel registry or recovery loop in this skill.

## Existing conversation handoff

Old `CHATGPT_REVIEW_HOME` data (default `~/.local/share/chatgpt-review`) is retained as historical evidence, not a second live service. Do not delete or rewrite it, copy its JSON into Convorel state, or reuse its watcher run IDs. Before taking over a requirement, verify no older watcher is still active; do not stop an unrelated process.

Read only that requirement's `records/<id>.json` for its durable URL/repo/summary, and its `watch/<id>.json` plus matching `replies/<id>/<runId>.json` for the exact submitted user message ID and recorded outcome. Check IDs and conversation identity; never guess from the latest visible answer. Existing private preferences can supply already authorized project settings.

First look for an existing Convorel binding. If none exists, initialize the intended persistent private Convorel home and explicitly attach the known conversation and message:

```bash
convorel conversation attach --id ID --url <recorded-conversation-url> --user-message <verified-user-message-id>
```

Attach sends nothing. It persists the binding and a new Convorel run, observes that exact remote turn, and fails rather than replace a missing or changed conversation. Keep the returned new run ID; use the standard status/resume/result/followup/finish flow from then on. An already-open page is borrowed and must remain open. Older transcripts/summaries remain in their original archive; attach does not claim to import all historical turns or transfer old tab ownership. If message identity cannot be established, report the missing evidence instead of creating a duplicate conversation.
