# 单项后台交接

需要 Bun 与 Codex CLI。RPC 路径不要求安装 Herdr；持久或非 Codex 路径需要同一技能根下的 `herdr` 与其 CLI。`agents.json` 沿用唯一配置路径；旧配置不用迁移或覆盖。

先按 `SKILL.md` 盘点未完成工作；这一步不需要创建 JSON 或状态文件。把当前工作、尚未推进的待办及积压问题一起交给 Jev 判断独立性与并行收益。只有一个待判断项时用本入口；多个待判断项用批次入口，不能先凭主观收益筛到只剩一项。

## 准备与启动

从 [task.json](../examples/task.json) 创建私有交接文件。状态与诊断放在本任务分配的私有根；若宿主提供 ACCEPTANCE_TMPDIR 等隔离根，必须使用它，不能另建固定 /tmp 路径。正常开发的持久状态保存在临时工作区之外。字段：

- `scope_id`：父任务范围；所有后台和持久任务共享同一个 `--state`，沿用已有 scope 与未决记录。
- `id/revision`：逻辑任务和版本。相同版本已有 attempt 时拒绝重复派发；有意重试先处理旧 attempt，再增加 revision。
- `prompt/deliverable/acceptance/authorization`：自足上下文、产物、验收和授权来源。`cwd` 为实际绝对路径，`resources.reads/writes` 使用全体参与者一致的规范资源键（如 `repo/api/src`），不要用 glob 或 `..`。
- `owner`：父任务当前真正会访问的资源和 adapter；`external_agents`：同一调度范围内未由该 state 跟踪的其他活动，包括服务、数据库写入者和其他 Agent。每项给 `id/adapter/reads/writes`，Herdr 身份可加 `session_id` 去重。未知资源不得填空数组；先核实。这些是父任务证据，不是 runner 自动发现全机工作。
- `depends_on`：该 scope 已验收的上游任务 ID，脚本检查最新 attempt 并传入已验收产物；未验收不能派发。
- 可选 `complexity/assessment_evidence`：有依据的难度判断；缺省且无 override 时调用 Jev A。有 override 一律跳过 A。
- 并行独立性和收益写入 prompt/constraints，供 Jev B 判断。单项入口不接受 `parallel_evidence`；父任务不能以自己判断明确为由跳过 Jev。
- `goal/constraints`：写清整体目标、当前父任务正在做什么、积压问题及已知依赖；Jev 需要据此判断是否存在有收益的重叠工作，不能只给待派发项的孤立描述。包含任务相关数据保留、权限、安装、提交和外部操作限制。

用宿主的后台进程工具执行，设置较短的首轮输出等待并保存返回句柄；shell 里不要加裸 `&` 后丢掉进程身份。入口本身保持前台，负责其子进程直到回收完毕。

```sh
bun scripts/run-task.ts --input /private/task.json --state /private/scope.json --sandbox workspace-write
```

默认 sandbox 为 read-only；写代码显式传 workspace-write。不会提供 YOLO 开关。默认任务预算 30 分钟，可用 `--timeout-ms` 调整为 1 秒至 24 小时；单 RPC 响应预算 60 秒，清理各阶段宽限 3 秒。Jev 请求默认 60 秒，可用 `--jev-timeout-ms` 在 1–120 秒之间调整；超时保留失败决策，不自动重试。无输出不代表失败。

命令先输出 `attempt_id/runner_pid/state/result`；父宿主后台句柄可能更早返回。父 Agent 继续原工作；runner 自行读取双向 JSONL，按精确 thread/turn 收取结果并关闭独占 app-server。RPC 执行路径返回成功需要 completed 且 cleanup stopped；派发前的 serial 也正常退出 0，但未创建 worker。应结合结构化结果判断，退出码 0 本身不代表任务已经验收。2 表示未成功完成；参数/准入/基础设施错误非零。私有结果路径为 `STATE.results/ATTEMPT.json.rpc.json`，stderr 有界保留 64 KB。

持久任务使用同一个入口和状态，增加：

```sh
bun scripts/run-task.ts --input /private/task.json --state /private/scope.json --mode persistent --caller-pane PANE_ID --label 'MMDD｜FEA｜具体任务'
```

label 日期只取会话 createdAt 转 Asia/Shanghai。非 Codex profile 的 oneshot 同样要求 caller/label，使用原 Herdr adapter；不会偷偷修改模型。Herdr 任务启动后立即返回 lane，按 `herdr` 技能复用或释放；需要复杂批次时使用 [完整批次入口](jev-scheduling.md)。

## 收取、验收与取消

派发前返回 `serial`、`owner_required` 或 `need_context` 时没有创建 worker；`reason`、`selection`（原始 choice、confidence、实际门槛）和 `decision_id` 指向具体决策。`serial` 是正常结果，退出码 0，由父任务处理；其余未派发退出码 2。普通单项 Codex oneshot 的 B 要求 `confidence >= 0.65`，持久/非 Codex 路径及完整批次保留 0.80，A 仍为 0.80。即使 choice 已选并行，置信度不足也返回 `below_confidence_policy`，不能报告为“已并行”或“Jev 判断不适合并行”，也不要反复请求凑过线。

0.65 是有限标注场景上的运行取值，不是普遍最优点。问题定义同时区分有收益的并行、无收益的 serial、缺事实和需要父任务改授权；先校正问题语义再选阈值，不能只为某个失败样本降线。[TypeSafe 的 confidence 定义](https://docs.typesafe.ai/confidence)是概率分布的集中程度统计量，不等于所选选项的概率，也不是单次正确率。

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

> 父任务首次收到多项需求，以及收到追加/变更指令、拆出独立工作或收到子任务结果时，先加载并执行 agent-dispatch 的轻量判断，再继续编辑或等待。盘点全部未完成工作，不能仅因同项目、同页面或同目标归入串行；把当前工作与积压问题交给 Jev 判断未推进工作能否独立执行，再按结果启动 JSON-RPC 或 Herdr；只有当前一个原子操作且无积压，或硬检查阻止所有组合时说明未调用原因。受委派工作者不递归派发。

若全局指导仍只写“并行走 herdr”，应将调度入口更新为 `agent-dispatch`、终端生命周期保留给 `herdr`；修改全局指导需在用户授权范围内，不能以安装技能代替该接入。新安装或修改指导后应在新会话确认实际技能目录被发现。已有会话可能仍保留旧正文；技能无法处理未投递消息，也不保证每个宿主自动推送进程完成事件。

协议依据：[Codex App Server](https://learn.chatgpt.com/docs/app-server)。本次实现与 Codex 0.156.1 的本机生成 schema 核对，RPC 模型与 effort 从同一有效 profile 设置并读回；engine_default 不指定 effort。跨版本可用性仍需实际握手与测试，模型目录 supported 不是账户授权保证。
