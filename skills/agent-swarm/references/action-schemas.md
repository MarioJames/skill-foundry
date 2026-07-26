# Action examples

Use `python3 <skill_dir>/scripts/agent_orchestrator.py action-schema [ACTION]` as the authoritative,
machine-readable shape. These examples show typical payloads only.

## Estimate

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
        "notes": []
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
  "task_ids": ["task_data", "task_review"],
  "condition": "all_terminal",
  "listen_seconds": 45
}
```

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
    "commands": ["tnpm test"],
    "summary": "测试通过",
    "reason": ""
  },
  "review": {"status": "pass", "source": "self", "findings": []},
  "integration_check": {"status": "passed", "summary": "子任务结果已集成"},
  "caveats": []
}
```

For failure, send `status=failed`, `retryable`, a summary, and caveats. Failure bypasses done gates.
