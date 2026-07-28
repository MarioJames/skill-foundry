# Orchestration routing

Orchestrator aggregates Agents orchestration patterns and routes work to one recipe or a bounded
composition. A Task tree or dependency graph is a Runtime representation, not the product model.

## Start boundary

Use three activation levels:

1. **Explicit start:** the user names Agents Orchestrator, asks to use Agents, or names a recipe.
   Start the selected recipe after the required estimate.
2. **Active identity:** `[ORCHESTRATION IDENTITY]` is present. Continue or recover that Run; never
   initialize another one.
3. **Implicit opportunity:** a concrete signal below is present. Recommend one recipe once, state
   the expected benefit and coordination cost, and wait for opt-in. Do not start the Runtime merely
   because this skill loaded.

Do not recommend or start for a one-file or one-step change, a tightly coupled task with no useful
independence, ordinary review, explanation, or debugging, a vague request to "use best practices",
complexity without a concrete orchestration signal, or a path/link/quotation/example containing a
mode name.

## Recipe selection

| Work signal | Recipe | Selection boundary |
| --- | --- | --- |
| At least two substantial independent workstreams with separable ownership or write scopes | `swarm` | Parallel benefit must exceed coordination and integration cost. |
| A new implementation needs an independent deterministic validation and review gate | `develop_review_improve` | Begin with development; do not use for an already-failing artifact that only needs convergence. |
| Unit or browser validation is failing, or an existing artifact must repeatedly validate, diagnose, and fix | `verification_fix` | Require a deterministic command or observable browser journey and a bounded retry budget. |
| A reusable or high-risk change needs broad independent review, fair challenge, ROI/code-bloat judgment, multi-Agent voting, main-Agent integration, and fixes | `ravf` | Use only when adjudication value justifies five Reviewers plus bounded odd Arguer/Voter pools and up to 25 candidate decisions. |
| A frozen plan or artifact needs independent consensus but no iterative fix loop | `multi_session_review` | Keep read-only unless the user explicitly requests follow-up fixes. |

Generic `loop mode` is not a recipe. Route it from the current work state:

- no implementation yet -> `develop_review_improve`;
- implementation exists and deterministic validation is the convergence oracle ->
  `verification_fix`;
- findings are judgment-heavy and need ROI-aware adjudication -> `ravf`.

Compose recipes only when the phases genuinely differ. Typical examples are `swarm` discovery and
implementation followed by `verification_fix`, or a high-risk delivery followed by `ravf`. Keep one
owner, one Run, explicit parent modes, and the smallest sufficient composition depth.

## Recommendation format

Keep an implicit recommendation short:

```text
建议启用 agents-orchestrator 的 <recipe>：<concrete signal and expected benefit>。
代价是 <agent/time/model overhead>；确认后我再启动。
```

Do not repeat a declined recommendation unless the work state changes materially. A user request
to avoid Agents or orchestration overrides every implicit signal.
