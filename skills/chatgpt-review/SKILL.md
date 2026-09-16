---
name: chatgpt-review
description: 在架构决策、重要方案定稿、高风险变更，或假设存疑、排障停滞、重要验收需交叉验证时，主动调用 ChatGPT Pro 审查；也支持显式请求和续谈。简单低风险任务不自动触发。
---

# ChatGPT Review

Use the user's signed-in ChatGPT account for task-relevant discussion, including proactive reviews within the user's authorized workflow. Honor standing authorization without asking again; this does not authorize unrelated messages, new repository grants, project moves or publication.

## Routes

- Decide when to initiate a Pro review, prepare its context, or close a decision gate: [proactive review](references/proactive-review.md).
- Find or continue a requirement, choose its project/model, connect a browser, or assess the reply: [conversation and browser boundaries](references/conversation.md).
- Run the pre-send model check, record a conversation, capture a submitted turn, launch/check/cancel a background watcher, or consume its result: [commands and background tasks](references/commands.md).

## Core boundaries

- Reuse one conversation per requirement, matched to the exact repository where applicable. Keep durable mappings and replies in private local state and memory; public skill files contain only generic examples.
- Initiate review at consequential decision points without waiting for the user to name ChatGPT. Check for an existing review of the same decision and evidence before sending; explicit local-only instructions take precedence.
- Before every review message, including follow-ups, run `ensure-model` to select and verify 6 Pro, unless the user explicitly requests another model for that review. Follow the [model selection gate](references/conversation.md#select-the-review-model-before-every-send); do not inherit a model from other conversations or account defaults, and do not send after a failed check.
- Preserve the requested project and the user's naming rules. Verify repository access independently; a model response is not proof of a code read or a passing test.
- Use a distinct pinned browser session per requirement and include the observed CDP endpoint on every attached command. Never navigate another task's page to recover a failed monitor.
- Monitor the exact submitted user message in a Herdr service lane every 60 seconds while continuing other work. Bind status, results and notifications to its unique `runId`; only a current terminal result may be consumed.
- Leave credentials and challenges to the user. Clean the finished watcher/lane, preserve the shared browser and login state, and never resend a prompt just because monitoring timed out.
