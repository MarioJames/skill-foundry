# Agents Orchestrator ACP Backend 规范

状态：已实现，TypeScript/Bun Runtime，schema v3（Task/Attempt/Launch 基线 + 持久 mode 与 validator migration）。

## 1. 边界与目标

| 项目 | 约束 |
| --- | --- |
| 协议 | ACP `protocolVersion=1` |
| TypeScript SDK | 官方 `@agentclientprotocol/sdk@1.3.0` |
| 安装依赖 | 所有命令先经过 Bun bootstrap；首次启动在 `$HOME/.agents-orchestrator/dependencies` 安装固定版本 SDK、Codex ACP 与 Claude Code ACP |
| 外部 Agent | Claude/Codex/Gemini profile 固定版本；也支持绝对路径 custom Agent |
| 默认执行 | ACP Backend + Codex profile；Claude CLI 需显式 `--backend claude_cli` |
| 数据兼容 | 原位读取并确定性迁移既有 `runtime.sqlite3`；不得通过删除旧库恢复 |
| 对话历史 | 不落本地消息表；按 Agent profile + ACP session ID 调用 `session/load` |

ACP SDK 只负责协议。Agents Orchestrator 继续负责 Task 调度、Attempt 生命周期、进程所有权、权限策略、
Effect 幂等、停止、恢复和资源清理。

## 2. 全新数据模型

```text
Run(root_id)
└── Task(task_id, parent_task_id)
    └── Attempt(attempt_id, attempt_no)
        └── Launch(launch_id, launch_no)
            └── ACP Session(profile_id, external_session_id)
```

关键决定：

- 只有 `root_id` 由 Runtime 生成。
- `task_id`、`attempt_id`、`launch_id`、`profile_id`、`session_pk` 都使用 SQLite integer PK。
- 删除 `agents` 中间表。Attempt 已包含原来一对一 Agent 记录的业务字段。
- `tasks.parent_task_id` 是逻辑树边；ACP Session 是执行来源，不是父子关系。
- `tasks.created_by_session_pk` 只记录“哪个 ACP Session 创建了该 Task”。
- 外部 ACP Session 直接保存 Agent 返回的 `external_session_id`，不再套一层自造 agent ID。
- 重试业务工作时新增 Attempt；启动阶段的进程重试新增 Launch。旧 Launch 关闭后保留，不原地增加
  generation。

### 2.1 Runs

`runs` 保存目标、cwd、Root Task、并发/任务/重试预算、模型层级、冻结的执行配置、Root owner
lease 和 token seed 引用。

```text
root_id TEXT PRIMARY KEY
root_task_id INTEGER
execution_config_json TEXT
token_seed_ref / token_seed_hash
owner_token_hash / lease_epoch / lease_expires_at
```

### 2.2 Tasks

```text
task_id INTEGER PRIMARY KEY
root_id TEXT NOT NULL
parent_task_id INTEGER NULL
created_by_session_pk INTEGER NULL
goal / intent / output_contract / constraints / priority / status
```

通过 `root_task_id` 找根，递归 `parent_task_id` 可完整还原树。重试不会改变 Task，所以 Session
替换也不会破坏树。

### 2.3 Attempts

```text
attempt_id INTEGER PRIMARY KEY
task_id INTEGER NOT NULL
attempt_no INTEGER NOT NULL
state assigned|evaluating|active|waiting|stopping|done|failed|cancelled
backend_id / agent_type / model / config_json
actor_token_hash / heartbeat / result / retryable
UNIQUE(task_id, attempt_no)
```

同一个 Task 最多有一个 live Attempt。Actor token 为
`base64url(HMAC-SHA256(run_seed, root_id|attempt_id))`，数据库只保存 hash。

### 2.4 Launches

```text
launch_id INTEGER PRIMARY KEY
attempt_id INTEGER NOT NULL
launch_no INTEGER NOT NULL
owner_nonce / worker_pid / agent_pid / control_endpoint
session_name / backend_ref
status starting|running|stopping|turn_ended|error|closed
prompt_state pending|in_flight|ended|cancelled
ready_at / stop_requested_at / closed_at / exit_reason
UNIQUE(attempt_id, launch_no)
```

Launch 是 append-only fence。ACP Worker 必须 CAS 获取 `launch_id + owner_nonce` 后才能 Popen
Agent。控制 socket 请求也必须匹配 `launch_id`。

如果 starting Launch 的 Worker、Agent 进程和 socket 全部 absent：

1. 关闭旧 Launch；
2. 插入 `launch_no + 1`；
3. 插入 `spawn:<new_launch_id>` Effect；
4. 晚到 Worker 因旧 Launch 已关闭而无法 claim。

只要有孤儿进程或事实矛盾，就保持 unknown，不创建替代 Launch。

### 2.5 Agent profiles 与 ACP Sessions

`agent_profiles` 标识真实 Session 所属的状态域：

```text
agent_type / package_name / adapter_version / command / state_namespace
config_json
UNIQUE(agent_type, package_name, adapter_version, command, state_namespace)
```

`acp_sessions` 保存：

```text
session_pk INTEGER PRIMARY KEY
launch_id INTEGER UNIQUE
profile_id INTEGER
external_session_id TEXT
cwd / protocol_version / capabilities_json / mode / model / status
UNIQUE(profile_id, external_session_id)
```

`agent_type + external_session_id` 在当前默认单机/单 profile 场景下可定位唯一 Session。数据库仍保留
`profile_id`，避免以后同名 Agent 的多个包、命令或状态目录发生碰撞。若查询出现多个 profile，CLI
要求补充 `root_id`，不会猜测。

### 2.6 Effects 与 Actions

`effects` 使用类型化的 `attempt_id` 和 `launch_id`，Effect payload 不再携带 `agent_id`、
`execution_id` 或 generation。

```text
spawn:<launch_id>
stop:<launch_id>
```

`processed_actions` 以 `(root_id, action_id)` 幂等，并记录提交 Attempt 与可选来源 Session。

## 3. 会话创建与 Action 可见性

ACP Worker 顺序：

1. claim Launch ownership；
2. 建立 mode-0600 control socket；
3. Popen 独立进程组的 ACP Agent；
4. 官方 SDK `initialize`；
5. `session/new`，得到真实 `session_id`；
6. 按 Agent 广告设置 model/mode；
7. dispatch 首个 `session/prompt`；
8. 一个事务内插入 profile/Session、标记 Launch running，并把 Attempt 从 assigned 改为
   evaluating。

第 8 步消除了 prompt 已开始但 Runtime 仍拒绝 Action 的竞态。

Agent 合法提交 `finish` 后，Attempt/Task 终止。Worker 观察 terminal Attempt，取消未完成请求、关闭
连接、回收 Agent 进程组和 socket，最后关闭 Launch 和本地 Session 状态。

## 4. 历史查询：轻量方案

本地数据库不保存用户/Agent 消息、tool call 内容或流式 payload。历史命令：

```bash
bun scripts/bootstrap.ts session-history \
  --agent-type codex \
  --session-id <real-acp-session-id> \
  --actor-token <run-token>
```

实现：

1. 用 `agent_type + external_session_id` 找 `acp_sessions + agent_profiles`；
2. 启动冻结的 profile command；
3. 官方 SDK `initialize`；
4. 检查 `capabilities.loadSession`；
5. 调用 `session/load(cwd, session_id)`；
6. 只在内存收集 load 期间的 typed `session/update`；
7. 返回后立即关闭连接和 Agent 进程组。

结构化不可用结果：

| reason | 含义 |
| --- | --- |
| `not_recorded` | 本地没有该 Session 映射 |
| `ambiguous` | 多个 profile 匹配，需提供 root ID |
| `load_unsupported` | Agent 未声明 `session/load` |
| `session_missing` | Agent 状态库已丢失或删除该 Session |
| `agent_unavailable` | profile executable 无法启动或加载超时 |

Session 丢失不会更改 Task/Attempt，不触发恢复，也不被当成 Runtime 故障。

## 5. 调度与恢复

Scheduler 在一个事务中创建 Attempt、Launch 和 spawn Effect。依赖调度仍基于稳定 Task ID，
`success` 依赖需要上游 done，`terminal` 依赖接受任意终态。

持久 mode 通过 `start_mode` / `advance_mode` 编译到同一棵 Task tree，并以 schema migration 2
加入 `modes`、`mode_rounds`、`mode_tasks`、finding provenance 与 verification 表；不会创建第二个
Runtime 或第二份状态库。Mode compiler 把依赖结果、候选 finding 与 provenance 封装成最多 12KB
的内容，并保留完整 canonical JSON 的 SHA-256 和字节数后注入下游 prompt，避免 reviewer 只拿到
dependency 边而没有上游证据。

Reaper 对每个当前 child Attempt：

- backend present：保留；heartbeat 超时则只报告 stalled；
- backend unknown：不改状态；
- backend absent + Attempt terminal：关闭 Launch；
- Launch ended/closed + Attempt live：归约为一次 retryable failure；
- starting 且尚未 ready：留给 ACP adapter 的启动 grace 处理。

Parent 显式 kill 时，先把 Attempt/Task/Launch 标记为 stopping/failed，再写 stop Effect；只有 stop
完成后 Task 才回到 ready 并产生新 Attempt。

Run stop 遍历全部 open Launch，而不是依赖是否已有 Session ID。全部资源关闭后 Run 才变为
cancelled；否则保持 stopping 并返回 open Launch IDs。

## 6. 权限和模型

- `prompt` policy 在无头模式下直接拒绝。
- `allow_in_workspace` 只选择 Agent 提供的安全模式，并验证 permission location。
- 无 location 的 execute 只对精确匹配的 Runtime `bootstrap-cwd`、`action-schema`、单对象
  `action --stdin` 形式开放 allow-once。
- Claude/Codex 默认 `allow_all`，分别选择 `bypassPermissions` / `agent-full-access`；显式
  `allow_in_workspace` 可降权。
- Attempt 模型必须出现在 Agent 广告的 config options 中，否则 fail closed。
- 默认 Backend/profile 为 ACP + Codex；Run 初始化时冻结 profile allowlist、default profile、
  executable、model 与 permission policy。旧 Claude CLI Run 按其持久配置恢复，不会被重新解释为
  Codex。
- `multi_session_review` 仅用于 ACP：至少三个独立 reviewer Session；每个候选 finding 再由不同的
  reproduce/falsify verifier 裁决。只有双 confirmed 才确认、双 rejected 才拒绝，混合结论保持
  unresolved；未解决的 high/critical finding 会阻止 mode 成功。

## 7. 首次启动依赖安装

仓库只发布 TypeScript 源码、`package.json` 和 `bun.lock`，不携带依赖目录或生成产物。
`scripts/bootstrap.ts` 仅依赖 Bun/Node 内置 API。Bun 是前置条件且不会被自动安装；全新首次启动需要
网络。默认 dependency home 为 `$HOME/.agents-orchestrator/dependencies`，可用
`$AGENTS_ORCHESTRATOR_DEPENDENCY_HOME`（兼容等值 `$AGENT_SWARM_DEPENDENCY_HOME`）覆盖。

bootstrap 对 Runtime 源码、lockfile、平台与 Bun 版本计算 digest，在 mode-0700 私有 staging 中执行
`bun install --frozen-lockfile --ignore-scripts`，逐项校验精确版本和 executable，再通过原子 rename 发布。
并发首次启动由进程锁串行化；完整缓存直接复用，损坏缓存安全重建；安装失败发生在 Run 创建前且清理
staging、lock 与不完整 target。

基础树固定为 `@agentclientprotocol/sdk@1.3.0`、`@agentclientprotocol/codex-acp@1.1.7`、
`@agentclientprotocol/claude-agent-acp@0.62.0`、`@openai/codex@0.145.0` 和
`@anthropic-ai/claude-agent-sdk@0.3.219`。Codex 与 Claude 共用该树；Codex 是默认 profile，Claude
只被准备，不会自动选择或执行。Gemini 仅在显式选择时加入
`@google/gemini-cli@0.41.0`。custom Agent 永不自动安装或覆盖。

官方 SDK 独占 framing、RPC request/response matching、schema、dispatch 与 connection。
Agents Orchestrator 的 `client.ts` 只实现 typed callback adapter 和 SDK connection factory。

## 8. 验收标准

- clean schema 不包含 `agents`、generation 或本地 message 表；
- Task tree 可由 integer `parent_task_id` 完整还原；
- retry 会保留旧 Attempt/Launch 历史；
- real ACP `session_id` 与 Agent profile 能准确定位 Session；
- fake/real ACP direct、split、stop、crash 后无 Worker/Agent/socket 残留；
- append-only Launch retry 能拒绝晚到旧 Worker；
- Session load 能回放历史，Session 丢失返回正常提示；
- Runtime/database/prompt 中不存在明文 child token；
- 全新 HOME 与 dependency home 能由 bootstrap 安装固定版本依赖并执行首次 `init`；仓库内无
  `node_modules`，第二次启动复用缓存，损坏后恢复同一冻结 executable 路径。

## 9. 版本记录

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| TypeScript/Bun | 2026-07-27 | 全量迁移 Runtime、测试、fixtures 与 manual harness；引入 dependency-free bootstrap、冻结 Bun lockfile 和共享 ACP 依赖缓存 |
| clean-break | 2026-07-26 | 删除 agents 中间层和 generation mutable record；引入 Task/Attempt/Launch/ACP Session 模型、真实 session ID、轻量 session/load 历史与内置 SDK 注入 |
| schema v2 | 2026-07-26 | canonical 命名迁移；ACP + Codex 默认 profile；加入持久 swarm/loop/multi-session review mode 与有界哈希证据传递 |
| schema v3 | 2026-07-26 | 为 develop-review-improve loop 增加持久 validator/revalidator 角色与迁移，强制确定性验证和修复后复验 |
