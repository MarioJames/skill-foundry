# Conversation reuse and browser boundaries

## Reuse the right conversation

1. Search persistent memory and `bun <skill-dir>/scripts/review.ts list <keywords>` before creating anything. Match the requirement and exact repository remote, not just a project name. Continue the same conversation for follow-ups; create a new one for an independent requirement.
2. Honor the user's designated ChatGPT project. Open its observed project URL and create there; verify the project breadcrumb after creation. Keep the project name/URL in local records, never in this distributable skill. Do not mix user-created conversations into the agent's workspace.
3. Read the relevant past decisions and check their current applicability. Tell ChatGPT what is a requirement, a hypothesis, or locally verified evidence. For repository linkage, select the GitHub app and require exact owner/repo, actual read revision, file references, and independently discovered code symbols. A 404 or a paraphrase of the prompt does not prove code access. Do not upload local code as a substitute without labeling that change of method.
4. Apply the [model selection gate](#select-the-review-model-before-every-send) immediately before sending, including when continuing an existing conversation. Send only relevant context; exclude credentials, environment files, and unrelated private information.
5. After creation, record the conversation immediately, then refresh its summary after each substantive reply. Store its URL, project, requirement/background, repo/revision where relevant, decisions and unresolved items. Also save the durable mapping through the available memory skill. A browser tab ID is temporary; the conversation URL is the durable identity.

Use the user's conversation naming rules. Obtain the conversation creation time from actual page/app metadata before applying a date-based title; never substitute an updated time or fabricate a creation timestamp. If creation metadata is unavailable, keep the current title and record naming as pending. Do not infer its date from the current clock, conversation ID, or message timestamps. Record the conversation and start its watcher before investigating optional naming metadata. Only title changes belong to a rename. Project moves require their own authorization and read-back verification.

## Select the review model before every send

The default review model is **6 Pro**. An explicit user request for a different model for this review overrides that default; a selection left in another conversation, an account default, or a stored record does not. Selecting the intended review model is part of the authorized review workflow and needs no separate confirmation.

For 6 Pro, use [`review.ts ensure-model`](commands.md#select-and-verify-the-model-before-sending) immediately before sending. It performs the following checks and selection through agent-browser. Continue only after exit code 0 and `verified: true` for the intended target and URL; a prior successful run is not a reusable permission to send after navigation or model changes. For an explicitly requested model outside the script's supported target, perform the same checks through the observed UI instead.

1. In this requirement's pinned tab, inspect the current model control immediately before every initial message or follow-up. Use the visible controls to identify the intended model and Pro mode; an account subscription label alone is not evidence.
2. If the selected model differs, open the selector and choose the intended model. Do not keep a lighter model just because it was already selected, and do not change another conversation to prepare this one.
3. Read the UI again after selection and confirm the intended model is selected before pressing Send. If it is already correct, confirm it without toggling. After navigation or a reload, repeat this check. Save the observed model label in the requirement record's `model` field; a previous record or an assistant's self-description is not current UI evidence.
4. If the intended model is unavailable, disabled, ambiguous, or fails to stay selected, do not send. Report the review as blocked with the observed reason and continue independent work; never silently fall back to another model.

In the UI verified on 2026-09-16, the composer control opens **Thinking effort**. Its **Select model** submenu offers **Latest**, while **Power** controls a five-position slider. With Latest selected, focus Power and use the arrow keys to reach **Pro, 5 of 5**; the menu and closed composer control must then identify **6 Pro**. High and Extra High are intermediate positions, not Pro. Inspect each resulting state rather than assuming a click on Power selects Pro, or that Latest alone identifies the intended version. If the layout changes, follow the observed controls and still require the final model label to match.

`ensure-model` verifies the selected UI state and never submits a message. The controlling Agent still owns sending and must stop when the command fails. `review.ts capture` and `watch` run after submission; they do not select models or enforce a pre-send check. Neither the UI check nor a captured reply's model slug proves which backend executed a request.

## Browser connection

Use `browser-harness` for browser/profile preparation and `agent-browser` for UI interaction. Reuse the installed regular Chrome and a persistent profile. ChatGPT login is headed; the user handles passwords, MFA and interactive challenges. Browser shutdown preserves the profile but ends an attached CDP connection.

Read the installed `agent-browser skills get core` guide. For an existing browser, discover its actual loopback CDP endpoint and target with `tab list --json`. Use a distinct named session per requirement and `--pin-tab`; include `--cdp` on **every** attached command, including reads. Omitting it can switch the daemon back to a newly launched browser. Never share one mutable active-tab session between background monitors.

`review.ts capture` and `watch` attach a dedicated session to the supplied target. They do not navigate, submit messages, reload a conversation, solve a challenge, or close Chrome. A changed URL, closed target, login requirement, or unrecognized page structure is a reported failure, not a reason to act on another tab.

## Consume and close the loop

Read the complete response and its citations. Judge the advice against local evidence; a model opinion is not an engineering test. Apply the [decision gate and repeat-review boundaries](proactive-review.md#close-the-gate-without-a-review-loop) before treating the work as final. Update the requirement record with the decision, evidence limits and next unresolved issue. Report the conversation link and whether repository reads actually succeeded.

Clean only the finished watcher and its Herdr lane. Preserve login data and any user-requested browser window. The watcher session auto-expires after inactivity; do not call `agent-browser close` against the shared CDP browser merely to clean its client. Old browser installations are retained until the user authorizes removal.

## A page can stop updating

Observed during a project move while a Pro response was running: the old tab kept showing progress after the persisted conversation already contained the final reply. Prefer creating in the intended project before submitting; avoid moving a conversation mid-response.

When progress remains unchanged for several checks, the controlling Agent may open the **same recorded conversation URL** in a temporary tab and compare the exact submitted user message. If that fresh view has the final answer, refresh the original verified tab or cancel its monitor and attach a new run to the verified replacement target. Close only the temporary tab you created. The watcher itself never reloads or navigates, and a stalled page never justifies resending the prompt.
