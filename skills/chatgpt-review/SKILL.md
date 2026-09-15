---
name: chatgpt-review
description: 用户要求在 ChatGPT 做方案或代码 review、续谈时使用；普通本地 review 不触发。
---

# ChatGPT Review

Use the user's signed-in ChatGPT account only for the requested discussion or review. This permits sending task-relevant prompts; unrelated messages, repository grants, project moves and publication require their own authorization.

## Routes

- Find or continue a requirement, choose its project/model, connect a browser, or assess the reply: [conversation and browser boundaries](references/conversation.md).
- Record a conversation, capture a submitted turn, launch/check/cancel a background watcher, or consume its result: [commands and background tasks](references/commands.md).

## Core boundaries

- Reuse one conversation per requirement, matched to the exact repository where applicable. Keep durable mappings and replies in private local state and memory; public skill files contain only generic examples.
- Preserve the requested project/model and the user's naming rules. Verify repository access independently; a model response is not proof of a code read or a passing test.
- Use a distinct pinned browser session per requirement and include the observed CDP endpoint on every attached command. Never navigate another task's page to recover a failed monitor.
- Monitor the exact submitted user message in a Herdr service lane every 60 seconds while continuing other work. Bind status, results and notifications to its unique `runId`; only a current terminal result may be consumed.
- Leave credentials and challenges to the user. Clean the finished watcher/lane, preserve the shared browser and login state, and never resend a prompt just because monitoring timed out.
