# Runtime Action examples

Use `bun <skill_dir>/scripts/bootstrap.ts action-schema [ACTION]` as the authoritative,
machine-readable shape. These examples show typical payloads only.

When an injected identity is present, use its exact exported entrypoint through
`$AGENTS_ORCHESTRATOR_SKILL_DIR`; never initialize another Run.
The executable is always `bun "$AGENTS_ORCHESTRATOR_SKILL_DIR/scripts/bootstrap.ts" <command>`.

Action payloads, idempotency, budgets, and finish gates are Backend-neutral. ACP children submit the
same Actions through the exact Runtime CLI form documented in `SKILL.md`; a prompt turn or Agent
message never substitutes for a successful Action response.

Persistent modes add `start_mode` and `advance_mode`. Read
`operating-modes.md` and `review-consensus.md` for their complete executable workflows.

## Contents

- [Estimate](#estimate)
- [Create tasks](#create-tasks)
- [Write note](#write-note)
- [Wait](#wait)
- [Start and advance a persistent mode](#start-and-advance-a-persistent-mode)
- [Finish](#finish)

## Estimate

Use `strategy: "split"` before every `start_mode`; persistent recipes compile child Tasks and the
owner needs `wait` while their phases run. Use `direct` only when no mode or child Tasks will start.

```json
{
  "revision": false,
  "strategy": "split",
  "resolved_intent": "implement",
  "complexity": "high",
  "concerns": [{"name": "data", "parallelizable": true}],
  "unknowns": [],
  "estimated_files": [],
  "reason": "数据层与界面可独立交付"
}
```

## Create tasks

```json
{
  "tasks": [
    {
      "key": "data",
      "goal": "实现数据层",
      "intent_hint": "implement",
      "complexity_hint": "medium",
      "model_tier_hint": "balanced",
      "priority": 60,
      "output_contract": "提供 CRUD API 和测试",
      "constraints": {
        "write_scope": ["src/data/**"],
        "read_only": false,
        "notes": [],
        "profile_hint": "codex"
      },
      "depends_on": []
    },
    {
      "key": "review",
      "goal": "审查数据层",
      "intent_hint": "review",
      "complexity_hint": "low",
      "model_tier_hint": "balanced",
      "priority": 40,
      "output_contract": "提交结构化审查结论",
      "constraints": {"write_scope": [], "read_only": true, "notes": []},
      "depends_on": [{"task_key": "data", "condition": "success"}]
    }
  ]
}
```

`constraints.profile_hint` is optional. When present it must be a non-empty profile name frozen in
the Run allowlist; it is never an executable, argument object, or Agent identity.

## Write note

```json
{
  "category": "decision",
  "content": "继续使用现有会话 Cookie",
  "scope": "subtree",
  "pinned": true,
  "supersedes_id": null
}
```

## Wait

```json
{
  "task_ids": [2, 3],
  "condition": "all_terminal",
  "listen_seconds": 45
}
```

## Start and advance a persistent mode

```json
{
  "mode": "develop_review_improve",
  "objective": "Converge an implementation through independent review",
  "parent_mode_id": null,
  "config": {
    "phases": ["develop", "validate", "review", "verify", "improve", "revalidate", "re_review"],
    "exit_conditions": {
      "passed": "clean_review",
      "validation_failure": "blocked",
      "high_severity_unresolved": "blocked",
      "max_rounds": "budget_exhausted",
      "no_progress": "no_progress"
    },
    "max_rounds": 3,
    "max_tasks": 18,
    "max_seconds": 3600
  },
  "evidence": {"requirement": "bounded source evidence"}
}
```

```json
{"mode_id": 1, "operation": "advance", "reason": "current phase terminal"}
```

For an existing artifact whose deterministic checks are failing, select `verification_fix` rather
than the development loop:

```json
{
  "mode": "verification_fix",
  "objective": "Converge unit and browser validation",
  "config": {"max_rounds": 4, "max_tasks": 16, "max_seconds": 3600},
  "evidence": {"unit_command": "bun test", "browser_journey": "critical checkout flow"}
}
```

For ROI-aware review convergence, select ACP-only `ravf`. It fixes the Reviewer pool at five,
limits each Reviewer to five findings, caps each Review round's merged candidate set at 25, and
optionally accepts odd `arguers` / `voters` pools of 3, 5, or 7 (default 5); `vote_quorum` must equal
the Voter-pool size. After voting,
`advance_mode` returns `integration_required`; call it again with `ravf_integration.decisions` from
the main Agent. A post-fix Review with findings starts another full RAVF cycle; the 25-candidate
budget resets for that round. Read `review-consensus.md` before composing either Action.

## Finish

```json
{
  "status": "done",
  "retryable": false,
  "summary": "完成实现和集成",
  "changed_files": ["src/data/store.ts"],
  "artifacts": [],
  "validation": {
    "status": "passed",
    "commands": ["bun test"],
    "summary": "测试通过",
    "reason": ""
  },
  "review": null,
  "integration_check": {"status": "passed", "summary": "子任务结果已集成"},
  "mode_result": null,
  "caveats": []
}
```

The example is an ordinary non-review parent Task. Keep `review` null or omit it in that case. A
Task whose resolved Intent is `review` must instead submit a structured review and may use
`"source": "self"`. A non-review root that requires final review must cite the integer `task_id` of
a completed review Task; it must not claim `"source": "self"`.

`mode_result` is null or omitted for ordinary Tasks. Runtime-created mode Tasks must provide the
role-specific shape stated in their output contract; the Runtime validates and fingerprints it.

For failure, send `status=failed`, `retryable`, a summary, and caveats. Failure bypasses done gates.
