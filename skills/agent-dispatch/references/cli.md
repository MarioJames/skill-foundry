# 统一调度 CLI

从技能目录执行 `bun scripts/agent-dispatch.ts --help`；正常使用只需 `run → status → accept`。本页是公共输入与恢复边界，`examples/` 和旧的 `run-task.ts/decide-tasks.ts/dispatch-tasks.ts` 是内部协议参考，不是调用前置条件。需要 Bun、Codex CLI；选中 Herdr 路径时还需 Herdr CLI。`agents.json` 仍只从 `~/.config/herdr/agents.json` 或显式 `--config` 加载，Jev 使用调用者环境中的 `OPENROUTER_API_KEY`。

## 提交任务

脚本会从当前 Herdr 父会话生成 scope；无法解析时提供一次明确的 `--scope ID`，后续命令沿用输出中的 ID。所有 scope 的调度状态默认写入用户私有 `~/.config/agent-dispatch/state.sqlite`，执行结果写入同目录的私有结果文件。`--db PATH` 只用于明确指定另一持久数据库或隔离验收；不要通过换数据库绕过未决预留。CLI 不在项目中写状态。

```sh
bun scripts/agent-dispatch.ts run --input - <<'JSON'
{
  "version": 1,
  "cwd": "/absolute/repo",
  "goal": "实现登录改造并审核冻结的接口合同",
  "constraints": ["不提交 Git、不删除数据"],
  "owner": {
    "id": "parent",
    "adapter": "codex",
    "work": "正在修改 src/login；contracts/login.json 已冻结",
    "reads": ["src/login", "contracts/login.json"],
    "writes": ["src/login"]
  },
  "external": [],
  "authorization": { "delegate": true, "basis": "用户授权这次只读审核" },
  "tasks": [{
    "key": "api-review",
    "prompt": "审核 contracts/login.json 的错误响应",
    "deliverable": "附接口位置的风险清单",
    "acceptance": ["逐项给出风险依据或明确说明未发现问题"],
    "reads": ["contracts/login.json"],
    "writes": [],
    "depends_on": []
  }]
}
JSON
```

一个和多个待判断项使用同样的 `tasks`；必须包括当前尚未推进的全部工作，不只填父任务已选中的一项。`run` 返回 decision、attempt 和 runner/lane 身份；选中 wave 后 RPC runner 独立运行，父任务继续无冲突工作。`serial` 表示本轮由父任务处理，不表示任务完成。`blocked` 是本地准入，回执会说明是否曾请求 Jev。低置信度保留 Jev 原始选项与本地采纳结果。

`owner` 描述当前实际工作和资源占用，`external` 包含尚未由此数据库跟踪的相关活动。读写与依赖的 `[]` 只表示已核实为空；未知写 `null` 或省略，CLI 作为阻塞处理。文件资源相对 `cwd`，数据库、服务、Redis、对象存储用 `db/`、`service/`、`redis/`、`bucket/` 前缀；不把文件隔离当作外部数据隔离。当前任务还需明确授权、交付物和验收标准。可选 `mode: "persistent"` 选择 Herdr，缺省为 oneshot；有效引擎为非 Codex 时也走 Herdr。选中 Herdr 任务时追加 `--caller-pane ID --label 'MMDD｜FEA｜具体任务'`。

后续直接运行 `run`，CLI 从 SQLite 读取当前事实。事实变化时只传变化部分，例如 `run --input -` 可接收 `{"owner":{"work":"正在验收结果"}}`；追加任务只传新的 `tasks`，修改已有任务可只传 `key`、`if_revision` 和变化字段。未重新提交的旧任务会保留；同 key、相同事实不增加 revision；改变事实必须提供 `if_revision` 为旧修订号。旧修订仍占用资源时，新修订不能重叠启动。取消的任务必须以新修订重新定义才能再次执行。后端执行 profile、内部任务结构、结果路径与初始 revision 由 CLI 负责。

## 收取、验收与异常

```sh
bun scripts/agent-dispatch.ts status --scope SCOPE
bun scripts/agent-dispatch.ts accept --scope SCOPE --attempt ATTEMPT --input - <<'JSON'
{"artifact_refs":["delivered/path"],"delivery_evidence_ref":"test-log","owner_evidence_ref":"parent-review"}
JSON
```

`status` 默认观察精确 attempt，并分别报告执行、交付、父任务验收和资源清理状态；`--cached` 只读数据库。父任务核对产物与验收标准后才能 `accept`。`accept` 从已存记录填入 attempt、task 和 revision 身份，不能仅复制 worker 自评。已验收依赖在下次 `run` 解锁。`check` 读取已有事实但不保存输入，`check --live` 再探测配置与能力；它和 `run/start` 使用同一模型探测路径。`plan` 保存一次冻结决策，`start --decision ID` 对当前事实、配置、依赖和容量重新准入，但不再请求 Jev。首次 `check` 或 `plan` 也需要 `--input`。

`cancel --task KEY` 撤销尚未启动的任务；`cancel --attempt ID` 对精确自有 runner/session 请求停止。随后执行 `status`，检查部分产物。对于失败、取消或未知执行，证实停止并核对写入后用 `resolve --attempt ID --outcome failed_stopped|cancelled_stopped|not_performed --evidence TEXT` 明确处置。`cleanup --attempt ID --caller-pane PANE` 仅关闭已可安全回收的自有 Herdr lane。未知结果仍占用写入权；不要重跑同一 attempt、换 scope/database、自动降级模型或清除持久数据。

错误输出含阶段、字段路径、预期类型和修正方式；能力阻塞与 Jev `serial` 不混淆。`status` 能读回有界执行结果；scope 锁残留时先根据锁文件 PID、记录的 attempt 与实际进程确认原执行已退出，再精确处理锁。数据库、执行结果和诊断默认保留。
