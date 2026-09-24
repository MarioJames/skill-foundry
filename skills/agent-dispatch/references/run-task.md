# 单项后台交接

需要 Bun 与 Codex CLI。RPC 路径不要求安装 Herdr；持久或非 Codex 路径需要同一技能根下的 `herdr` 与其 CLI。`agents.json` 沿用唯一配置路径；旧配置不用迁移或覆盖。

## 准备与启动

从 [task.json](../examples/task.json) 创建私有交接文件。状态与诊断放在本任务分配的私有根；若宿主提供 ACCEPTANCE_TMPDIR 等隔离根，必须使用它，不能另建固定 /tmp 路径。正常开发的持久状态保存在临时工作区之外。字段：

- `scope_id`：父任务范围；所有后台和持久任务共享同一个 `--state`，沿用已有 scope 与未决记录。
- `id/revision`：逻辑任务和版本。相同版本已有 attempt 时拒绝重复派发；有意重试先处理旧 attempt，再增加 revision。
- `prompt/deliverable/acceptance/authorization`：自足上下文、产物、验收和授权来源。`cwd` 为实际绝对路径，`resources.reads/writes` 使用全体参与者一致的规范资源键（如 `repo/api/src`），不要用 glob 或 `..`。
- `owner`：父任务当前真正会访问的资源和 adapter；`external_agents`：同一调度范围内未由该 state 跟踪的其他活动，包括服务、数据库写入者和其他 Agent。每项给 `id/adapter/reads/writes`，Herdr 身份可加 `session_id` 去重。未知资源不得填空数组；先核实。这些是父任务证据，不是 runner 自动发现全机工作。
- `depends_on`：该 scope 已验收的上游任务 ID，脚本检查最新 attempt 并传入已验收产物；未验收不能派发。
- 可选 `complexity/assessment_evidence`：有依据的难度判断；缺省且无 override 时调用 Jev A。有 override 一律跳过 A。
- 并行独立性和收益写入 prompt/constraints，供 Jev B 判断。单项入口不接受 `parallel_evidence`；父任务不能以自己判断明确为由跳过 Jev。
- 可选 `goal/constraints`：整体目标与共同约束；务必包含任务相关数据保留、权限、安装、提交和外部操作限制。

用宿主的后台进程工具执行，设置较短的首轮输出等待并保存返回句柄；shell 里不要加裸 `&` 后丢掉进程身份。入口本身保持前台，负责其子进程直到回收完毕。

```sh
bun scripts/run-task.ts --input /private/task.json --state /private/scope.json --sandbox workspace-write
```

默认 sandbox 为 read-only；写代码显式传 workspace-write。不会提供 YOLO 开关。默认任务预算 30 分钟，可用 `--timeout-ms` 调整为 1 秒至 24 小时；单 RPC 响应预算 60 秒，清理各阶段宽限 3 秒。Jev 请求默认 60 秒，可用 `--jev-timeout-ms` 在 1–120 秒之间调整；超时保留失败决策，不自动重试。无输出不代表失败。

命令先输出 `attempt_id/runner_pid/state/result`；父宿主后台句柄可能更早返回。父 Agent 继续原工作；runner 自行读取双向 JSONL，按精确 thread/turn 收取结果并关闭独占 app-server。最终退出码 0 仅代表执行 completed 且 cleanup stopped，不代表交付已经验收。2 表示未成功完成；参数/准入/基础设施错误非零。私有结果路径为 `STATE.results/ATTEMPT.json.rpc.json`，stderr 有界保留 64 KB。

持久任务使用同一个入口和状态，增加：

```sh
bun scripts/run-task.ts --input /private/task.json --state /private/scope.json --mode persistent --caller-pane PANE_ID --label 'MMDD｜FEA｜具体任务'
```

label 日期只取会话 createdAt 转 Asia/Shanghai。非 Codex profile 的 oneshot 同样要求 caller/label，使用原 Herdr adapter；不会偷偷修改模型。Herdr 任务启动后立即返回 lane，按 `herdr` 技能复用或释放；需要复杂批次时使用 [完整批次入口](jev-scheduling.md)。

## 收取、验收与取消

派发前返回 `owner_required` 或 `need_context` 时没有创建 worker；`reason` 和 `decision_id` 指向具体决策。当前沿用原 Jev 采纳门槛：答案必须带 `confidence >= 0.80`。即使 choice 已选并行，置信度不足也返回 `below_confidence_policy`，不能报告为“已并行”，也不要反复请求凑过线；父任务处理尚未派发的工作。

```sh
bun scripts/dispatch-tasks.ts --action observe --state /private/scope.json --attempt ATTEMPT_ID
bun scripts/dispatch-tasks.ts --action accept --state /private/scope.json --attempt ATTEMPT_ID --evidence /private/acceptance.json
```

acceptance JSON 使用已有合同：

```json
{"task_revision":1,"attempt_id":"ATTEMPT_ID","artifact_refs":["actual/path"],"delivery_evidence_ref":"verification-log","owner_evidence_ref":"parent-review"}
```

由父 Agent 核对文件和验证，不能仅复制 worker 的自评。observe 确认 RPC 结果与进程清理后释放 slot，accept/resolve 后才释放写入预留。结果由 runner 绑定身份，worker 只返回 status/summary/artifact_refs；后台自动退出无需等待父 Agent 读取结果。

取消通过宿主已有后台句柄发送 SIGTERM/SIGINT 给记录中的 runner；它会尝试中断已知 turn 并清理自有进程组。不要 killall/pkill codex，也不按陈旧 PID 盲杀。宿主若直接强杀 runner，缺失终态须按 unknown 处理：核对记录的 server/进程组与身份，处理部分写入后显式 resolve。进程退出、取消请求获确认均不能证明外部副作用已撤销。

```sh
bun scripts/dispatch-tasks.ts --action resolve --state /private/scope.json --attempt ATTEMPT_ID --outcome failed_stopped --evidence /private/resolution.json
```

resolution 为 `{"evidence":"父任务核对进程已停、部分产物和写入归属的具体证据"}`。outcome 也可选 not_performed/cancelled_stopped。未证实停止不得 resolve；不重放未知 turn/start。结果/状态文件和工作目录不被清理命令删除。若需要新增审批或用户输入，runner 安全取消交互并返回 needs_owner；不能伪造批准或用户答案。

## 宿主触发接入

技能描述支持自动选择；对持续注入任务的父会话，可在实际会加载的项目 AGENTS.md 采用下列桥接规则。本仓库已加入，仅影响本仓库；跨项目使用需在相应指导中采用，不能擅自修改全局指令：

> 父任务所有者每次收到已投递的新指令或子任务完成/失败结果，都在继续长步骤或阻塞等待前执行 agent-dispatch 的轻量判断；就绪的独立工作及时派发，受委派工作者不得递归派发。

新安装或修改指导后应在新会话确认实际技能目录被发现。已有会话可能仍保留旧正文；技能无法处理未投递消息，也不保证每个宿主自动推送进程完成事件。

协议依据：[Codex App Server](https://learn.chatgpt.com/docs/app-server)。本次实现与 Codex 0.156.1 的本机生成 schema 核对，RPC 模型与 effort 从同一有效 profile 设置并读回；engine_default 不指定 effort。跨版本可用性仍需实际握手与测试，模型目录 supported 不是账户授权保证。
