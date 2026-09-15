# Conversation reuse and browser boundaries

## Reuse the right conversation

1. Search persistent memory and `bun <skill-dir>/scripts/review.ts list <keywords>` before creating anything. Match the requirement and exact repository remote, not just a project name. Continue the same conversation for follow-ups; create a new one for an independent requirement.
2. Honor the user's designated ChatGPT project. Open its observed project URL and create there; verify the project breadcrumb after creation. Keep the project name/URL in local records, never in this distributable skill. Do not mix user-created conversations into the agent's workspace.
3. Read the relevant past decisions and check their current applicability. Tell ChatGPT what is a requirement, a hypothesis, or locally verified evidence. For repository linkage, select the GitHub app and require exact owner/repo, actual read revision, file references, and independently discovered code symbols. A 404 or a paraphrase of the prompt does not prove code access. Do not upload local code as a substitute without labeling that change of method.
4. Check the selected model in the UI. Do not silently replace the requested model. Send only relevant context; exclude credentials, environment files, and unrelated private information.
5. After creation, record the conversation immediately, then refresh its summary after each substantive reply. Store its URL, project, requirement/background, repo/revision where relevant, decisions and unresolved items. Also save the durable mapping through the available memory skill. A browser tab ID is temporary; the conversation URL is the durable identity.

Use the user's conversation naming rules. Obtain the conversation creation time from actual page/app metadata before applying a date-based title; never substitute an updated time or fabricate a creation timestamp. If creation metadata is unavailable, keep the current title and record naming as pending. Do not infer its date from the current clock, conversation ID, or message timestamps. Record the conversation and start its watcher before investigating optional naming metadata. Only title changes belong to a rename. Project moves require their own authorization and read-back verification.

## Browser connection

Use `browser-harness` for browser/profile preparation and `agent-browser` for UI interaction. Reuse the installed regular Chrome and a persistent profile. ChatGPT login is headed; the user handles passwords, MFA and interactive challenges. Browser shutdown preserves the profile but ends an attached CDP connection.

Read the installed `agent-browser skills get core` guide. For an existing browser, discover its actual loopback CDP endpoint and target with `tab list --json`. Use a distinct named session per requirement and `--pin-tab`; include `--cdp` on **every** attached command, including reads. Omitting it can switch the daemon back to a newly launched browser. Never share one mutable active-tab session between background monitors.

`review.ts capture` and `watch` attach a dedicated session to the supplied target. They do not navigate, submit messages, reload a conversation, solve a challenge, or close Chrome. A changed URL, closed target, login requirement, or unrecognized page structure is a reported failure, not a reason to act on another tab.

## Consume and close the loop

Read the complete response and its citations. Judge the advice against local evidence; a model opinion is not an engineering test. Update the requirement record with the decision, evidence limits and next unresolved issue. Report the conversation link and whether repository reads actually succeeded.

Clean only the finished watcher and its Herdr lane. Preserve login data and any user-requested browser window. The watcher session auto-expires after inactivity; do not call `agent-browser close` against the shared CDP browser merely to clean its client. Old browser installations are retained until the user authorizes removal.

## A page can stop updating

Observed during a project move while a Pro response was running: the old tab kept showing progress after the persisted conversation already contained the final reply. Prefer creating in the intended project before submitting; avoid moving a conversation mid-response.

When progress remains unchanged for several checks, the controlling Agent may open the **same recorded conversation URL** in a temporary tab and compare the exact submitted user message. If that fresh view has the final answer, refresh the original verified tab or cancel its monitor and attach a new run to the verified replacement target. Close only the temporary tab you created. The watcher itself never reloads or navigates, and a stalled page never justifies resending the prompt.
