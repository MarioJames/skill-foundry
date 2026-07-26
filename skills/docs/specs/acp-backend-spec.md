# Agent Swarm ACP Backend Spec

| 字段 | 值 |
| --- | --- |
| 状态 | Draft |
| 版本 | 0.2.0 |
| 日期 | 2026-07-25 |
| 范围 | `agent-swarm` 技能 Runtime 的可插拔执行后端 |
| ACP 基线 | 稳定版 ACP v1（`protocolVersion=1`）；不依赖 Draft ACP v2 语义 |
| 相关文档 | [runtime-contract.md](./runtime-contract.md)、[recovery-protocol.md](./recovery-protocol.md)、[action-schemas.md](./action-schemas.md)、[SKILL.md](../SKILL.md) |
| 权威约束 | 本 spec 不覆盖或修改 v2 Action 协议语义；与 `runtime-contract.md` 冲突时以 Runtime contract 为准，直至双方同步修订 |

---

## 1. 背景与问题

### 1.1 现状

Agent Swarm v2 Runtime 以 `Run → Task → Attempt → Agent Session` 管理任务树。子 Agent 的进程生命周期由 **Claude Code CLI** 驱动：

| 能力 | 当前实现 |
| --- | --- |
| 启动 | `claude --bg --name <session> --permission-mode bypassPermissions [--model] <prompt>` |
| 停止 | `claude stop <job_id>` |
| 观测 | `claude agents --json` |
| 心跳 / 完成门禁 | Claude 项目 Hooks（SessionStart、PostToolUse、Stop、SessionEnd 等） |
| 身份 | 子进程 env `AGENT_SWARM_*` + prompt 内 `[ORCHESTRATION IDENTITY]` |

编排内核（SQLite 状态、Scheduler、Outbox、Action Processor、Recovery）本身不依赖 Claude，但默认执行路径硬编码在 `claude_adapter.py` 与 `hook_manager.py`。

### 1.2 问题

1. **厂商锁定**：无法用 Codex / Gemini / OpenCode 等作为 child，只能用 Claude Code。
2. **观测面脆弱**：进程控制依赖 Claude 私有 CLI 输出解析（job id 正则、`agents --json` 形态）。
3. **Hooks 不可移植**：完成门禁、心跳依赖 Claude settings hooks；其他 agent 无等价机制。
4. **扩展成本高**：每加一个 agent 就要一套 CLI 适配，重复 M×N 集成。

### 1.3 目标

通过 **Agent Client Protocol (ACP)** 作为统一的 **Client ↔ Agent** 传输层，使 Runtime 能以同一套接口启动、投递、取消、观测多类 coding agent session，同时：

- **保留** v2 任务树、预算、依赖、finish 门禁、幂等 Action、Outbox 副作用模型；
- **解耦** “编排真相”与 “agent 进程实现”；
- **兼容** 现有 Claude CLI 后端（默认行为不变）；
- 为后续跨模型 Intent 路由、结构化 tool 事件观测打基础。

### 1.4 非目标

本 spec **不**做以下事项：

| 非目标 | 说明 |
| --- | --- |
| 用 ACP 替换 Runtime | ACP 不是任务编排协议；不提供 Task/依赖/预算/finish |
| 实现 Agent-to-Agent 点对点协议 | 不采用已废弃的另一类 “ACP/A2A 消息总线” 作为真相源 |
| 强制 Root 也走 ACP | Root 仍可为任意 foreground agentic 会话 |
| 删除 Claude CLI 后端 | v1 交付必须默认兼容 `claude --bg` |
| 证明语义质量 | Runtime 仍只校验结构与生命周期，不证明代码正确性 |
| 自建 IDE UI | 不做 Zed/JetBrains 面板；ACP Worker 作为 headless ACP Client |
| 统一所有 agent 的 skill/plugin 生态 | 只要求 child 能执行工作并回写 Runtime Action |

---

## 2. 术语

| 术语 | 定义 |
| --- | --- |
| **Runtime** | agent-swarm Python 运行时：状态库、Scheduler、Action、Outbox、Recovery |
| **Execution Backend** | 负责起停/观测外部 Agent Session 的适配实现 |
| **Claude CLI Backend** | 当前默认：`claude --bg` / `stop` / `agents --json` |
| **ACP Backend** | 通过 ACP JSON-RPC 管理 agent 子进程与 session 的后端 |
| **ACP Worker** | 每个 ACP Attempt 的常驻 supervisor 进程；独占 ACP stdio、处理双向 RPC、权限回调与 turn 生命周期 |
| **Agent Process** | ACP agent 可执行进程（stdio JSON-RPC server） |
| **ACP Session** | `session/new` 返回的 `sessionId` 所标识的对话上下文 |
| **Swarm Session** | Runtime 中 `agents` 表记录的 Attempt 绑定会话（`session_name` / `job_id`） |
| **Execution Record** | `execution_sessions` 中持久化的 Attempt 执行快照、worker 端点、进程与生命周期事实 |
| **Control Plane** | Action 协议 + 状态机 + 预算 + Outbox 语义 |
| **Data / Exec Plane** | 外部 agent 的启动、prompt、权限、进程存活 |
| **Lifecycle Guard** | 原 Claude Hooks 承担的心跳、Stop 门禁、失败注入；ACP 下需等价实现 |
| **Identity Bundle** | `AGENT_SWARM_ROOT_ID/TASK_ID/ATTEMPT_ID/AGENT_ID/ACTOR_TOKEN` 及 skill/home 路径 |

---

## 3. 设计原则

1. **Control Plane 稳定**：v2 Action 集合与生命周期不因后端变化而 fork。
2. **Exec Plane 可插拔**：所有外部进程副作用只经 `AgentBackend` 接口。
3. **Outbox 仍是唯一副作用队列**：spawn/stop 继续作为 `side_effect_outbox` 效果；后端不得绕过 Outbox 起进程。
4. **完成语义以 Runtime Action 为准**：`session/prompt` 结束 ≠ Task done；必须 `finish`。
5. **观测不信任 agent 自报**：存活/缺席以 Backend `observe` 为准；心跳超时策略保持现有 reap 语义。
6. **默认兼容**：未配置时行为与今日 Claude CLI 路径一致。
7. **能力协商**：ACP 可选能力（load/resume/close、fs、terminal）按 agent 广告使用，不得假设全量。
8. **常驻连接有唯一所有者**：短生命周期 Runtime CLI 不持有 ACP stdio；每个 ACP Attempt 由唯一 ACP Worker 持有连接并对外提供控制端点。
9. **执行配置不可漂移**：backend/agent/command/model/permission 在 Attempt 创建时解析并固化；stop/observe/recover 不重新读取当前环境推断历史执行方式。
10. **权限回调不是沙箱**：ACP permission policy 只决定如何响应 agent 的审批请求；真实目录隔离依赖 agent-native sandbox、容器或 OS 机制。

---

## 4. 总体架构

```text
┌──────────────────────────────────────────────────────────────────┐
│ Foreground Root (Claude / Codex / 人工 / 任意 agentic host)       │
│  - init / recover / action / wait / finish via agent_orchestrator │
└───────────────────────────────┬──────────────────────────────────┘
                                │ stdin JSON Actions
┌───────────────────────────────▼──────────────────────────────────┐
│ Agent Swarm Runtime CLI (short-lived Control Plane)              │
│  state_store · action_processor · scheduler · notes · recovery   │
│  side_effect_outbox + execution_sessions                         │
└───────────────────────────────┬──────────────────────────────────┘
                                │ AgentBackend
          ┌─────────────────────┼─────────────────────┐
          ▼                     ▼                     ▼
   ClaudeCliBackend       AcpBackend            (future)
   spawn: claude --bg     spawn: detached       ...
   stop:  claude stop            acp_worker
   observe: agents --json stop/observe: worker IPC
          │                     │
          │                     ├── execution state/events → SQLite
          │                     └── ACP stdio → Agent Process
          ▼                                      ▼
   Claude Code session                    Claude/Codex/Gemini ACP adapter
   + project Hooks
          │                     │
          └──────────┬──────────┘
                     ▼
        Child 回写：CLI Action 和/或 Runtime MCP tools
        → submit_estimate / create_tasks / write_note / wait / finish
```

### 4.1 责任边界

| 组件 | 负责 | 不负责 |
| --- | --- | --- |
| Runtime | 任务树、预算、幂等、finish 门禁、retry、recover | 解析 agent 自然语言结论为 done |
| AgentBackend | 解析执行记录；起停/观测 Claude session 或 ACP Worker | 直接持有跨 CLI 调用的 ACP stdio；改写 Task 状态 |
| ACP Worker | 独占 ACP Agent 进程与 stdio；处理 RPC、permission、prompt、关闭与诊断 | 创建 Task、伪造 finish、替代 Runtime retry 决策 |
| Child Agent | 执行工作、提交 Action、本地验证 | 自己 `claude --bg` / 私自起 sibling |
| Lifecycle Guard / Recovery | 将 worker/turn 事实归约为 retry、stalled 或 cleanup | 初始化 Run、代为 finish(done) |

### 4.2 与 ACP 角色映射

| ACP 角色 | Swarm 中的实体 |
| --- | --- |
| ACP Client | ACP Worker 内嵌的 `AcpClient`（headless） |
| ACP Agent | 外部 coding agent 适配器进程 |
| session | 一个 Attempt 的 Agent Session |
| `session/prompt` | 投递 bootstrap prompt（含 identity IDs + task，不含 token） |
| `session/update` | 可观测事件流（日志/诊断；可选用于弱心跳） |
| `session/request_permission` | Client 侧权限策略决策 |
| `mcpServers` on `session/new` | 可选注入 Runtime MCP（Phase 2+） |

ACP **不**映射为：

- Task 依赖图
- Parent/child wait 条件
- Notes 存储
- Actor token 鉴权

### 4.3 为什么必须有 ACP Worker

`agent_orchestrator.py action|reap|recover|stop` 都是一次性 CLI 调用；Action 处理和
`outbox.drain()` 返回后进程即退出。ACP stdio 则要求 Client 在整个 prompt turn 内持续读取
notifications、响应 `session/request_permission`，并保留可用于 cancel/close 的连接。

因此：

- **禁止**在 `outbox.drain()` 所在进程中仅启动后台线程后返回；线程会随 CLI 退出而消失。
- `execution_sessions` 只保存事实，不能让新进程重新获得既有 pipe。
- v1 固定采用“每 Attempt 一个 detached ACP Worker + 一个 Agent Process + 一个 ACP Session”。
- Runtime 后续通过 worker control endpoint 执行 stop，通过 execution record + worker heartbeat 执行 observe/recover。

---

## 5. 兼容性与版本策略

### 5.1 后端标识

```text
backend_id:
  - claude_cli   # 默认，现有行为
  - acp          # 本 spec 新增
```

Run 级配置在 `init` 时解析并写入 `runs.execution_json`。环境变量只参与这次解析；Run 创建后，
已有 Attempt 不再读取环境变量。Task/路由选择出的最终执行配置在 Attempt 创建时快照到
`execution_sessions`。

```json
{
  "execution": {
    "backend": "claude_cli",
    "acp": {
      "agent": "claude",
      "command": null,
      "args": [],
      "permission_policy": "allow_in_workspace",
      "prompt_timeout_seconds": null,
      "session_close_on_stop": true,
      "turn_end_reprompt_limit": 1
    },
    "routing": {
      "by_intent": {},
      "by_model_tier": {}
    }
  }
}
```

### 5.2 初始化覆盖与优先级

创建 Run 时的优先级从高到低：

1. `init` 显式 CLI 参数；
2. 当前进程的 `AGENT_SWARM_*` 环境变量；
3. 配置文件/内置默认值。

解析结果整体持久化。后续 `action|reap|recover|stop` 中的环境变量不得改变既有 Run 或 Attempt
的 backend。若需切换 backend，必须创建新 Attempt；不得让同一 Attempt 跨 backend 复用。

| 变量 | 含义 | 默认 |
| --- | --- | --- |
| `AGENT_SWARM_BACKEND` | `claude_cli` \| `acp` | `claude_cli` |
| `AGENT_SWARM_ACP_AGENT` | 逻辑 agent 名（配置表 key） | `claude` |
| `AGENT_SWARM_ACP_COMMAND` | agent 可执行文件绝对/PATH 命令 | 见 agent registry |
| `AGENT_SWARM_ACP_ARGS` | JSON 数组，追加参数 | `[]` |
| `AGENT_SWARM_ACP_PERMISSION_POLICY` | 权限审批策略 id | `allow_in_workspace` |
| `AGENT_SWARM_CLAUDE_BIN` | 仅 Claude CLI 后端 | 现有语义 |

### 5.3 ACP 版本、传输与能力探测

- v1 只实现稳定版 ACP v1，`initialize.protocolVersion=1`；协商结果不是 `1` → spawn 失败
  （retryable，走现有 spawn_failed 路径）。Draft ACP v2 需另行升级 spec。
- stdio transport 固定使用 UTF-8 newline-delimited JSON-RPC；不得实现或探测 Content-Length framing。
- ACP `initialize` 必须成功，并持久化 Agent 实际广告的 capabilities。
- 可选能力缺失时降级：
  - 无 `sessionCapabilities.close` → 用 `session/cancel` + 杀进程
  - 无 `loadSession` / `resume` → recover 不尝试恢复旧 ACP session，只重派新 Attempt
  - v1 Client 不广告 terminal/fs capabilities；Agent 若仍违规调用则返回 method-not-found

### 5.4 Python Client 与外部 Agent 依赖

- Runtime v1 内嵌一个基于 Python 标准库的最小 ACP v1 Client，只覆盖附录 B 的方法集；
  **不**在运行时自动 `pip install`，也不 shell out 到 `acpx`。
- 官方 Python SDK 作为协议 schema/测试参考依赖，用于 CI contract fixture 与字段漂移检查，
  不成为 standalone skill 的运行时前置条件。
- Claude/Codex/Gemini ACP adapter 属于外部执行依赖。内置 registry profile 必须锁定包名与版本；
  禁止默认执行 floating `latest`。用户显式 `command` 可覆盖 profile。
- `doctor` 必须在 spawn 前报告 command 是否存在、解析后的版本/profile 与认证前置条件；
  Runtime 不得静默联网安装 adapter。

### 5.5 默认行为保证

- 未设置任何 ACP 变量时：测试与生产路径与当前 v2 一致。
- Claude CLI 后端继续安装/合并 Claude project hooks。
- ACP 后端 **不**写入 `.claude/settings.local.json` hooks（避免污染非 Claude 工作流）；Lifecycle Guard 走 §8。

---

## 6. AgentBackend 接口

### 6.1 模块位置

```text
scripts/
  backends/
    __init__.py          # resolve_spawn_backend / resolve_execution_backend
    base.py              # Protocol / ABC + shared types
    claude_cli.py        # 现有 claude_adapter 迁移
    acp/
      __init__.py
      client.py          # JSON-RPC over stdio
      adapter.py         # AgentBackend；管理 worker，不直接持有 ACP pipe
      worker.py          # detached 常驻 supervisor；独占一个 Agent Process
      worker_protocol.py # ready handshake + mode 0600 control socket 协议
      permissions.py     # request_permission 策略
      registry.py        # 锁定的已知 agent profile 与用户覆盖
  claude_adapter.py      # 过渡期 re-export 或 thin wrapper（见迁移）
  outbox.py              # 注入 backend，不再硬编码 claude_adapter
```

### 6.2 类型

```python
# 逻辑形状；实现可用 TypedDict / dataclass

class SpawnRequest:
    prompt: str
    cwd: str
    session_name: str          # Runtime 生成的稳定名 agent-swarm-...
    model: str | None
    env: dict[str, str]        # Identity Bundle + AGENT_SWARM_HOME/SKILL_DIR
    backend_config: dict       # Run/Task 级 execution 配置切片
    metadata: dict             # root_id, task_id, attempt_id, agent_id

class SpawnResult:
    job_id: str                # opaque execution id；Claude=job id；ACP="acp:<attempt>:<generation>"
    session_name: str          # 回写 agents.session_name；可等于请求名
    extras: dict               # 可选：worker_pid, agent_pid, acp_session_id, protocol_version

class ObserveResult:
    presence: str              # "present" | "absent" | "unknown"
    session: dict | None
    error: str | None

class StopRequest:
    job_id: str | None
    session_name: str | None
    cwd: str | None
    reason: str | None
```

### 6.3 接口契约

```python
class AgentBackend(Protocol):
    backend_id: str

    def spawn(self, request: SpawnRequest) -> SpawnResult:
        """启动 Attempt 执行并等待 backend ready handshake。
        Claude ready=取得 background job id；ACP ready=worker 已完成 initialize、session/new，
        并已发出 session/prompt。成功后 Runtime 才把 Agent 置 evaluating。
        失败抛异常 → outbox spawn_failed 路径。
        """

    def stop(self, request: StopRequest) -> dict:
        """尽力停止 execution。ACP 通过 execution record 找 control endpoint；
        幂等：已关闭/不存在则 {stopped: True, not_required: True}。
        """

    def observe(self, *, job_id: str | None, session_name: str | None, cwd: str | None) -> ObserveResult:
        """用于 reap/wait watchdog；不得抛异常导致状态损坏，未知时 presence=unknown。"""

    def session_alive(self, *, job_id: str | None, session_name: str | None, cwd: str | None) -> bool:
        """observe().presence == 'present' 的便捷包装。"""

    def list_sessions(self, *, cwd: str | None = None) -> list[dict]:
        """诊断用；ACP 后端返回 Runtime 已知的活跃 session 视图。"""

    def supports_hooks(self) -> bool:
        """True 时 outbox/init 可安装 Claude project hooks。"""
```

### 6.4 Outbox 集成变更

spawn 与 stop/observe 的解析路径不同：

```python
def resolve_spawn_backend(run, task) -> tuple[AgentBackend, ExecutionConfig]:
    # 只在 Attempt 创建时解析；结果写入 execution_sessions
    ...

def resolve_execution_backend(execution_record) -> AgentBackend:
    # stop/observe/recover 只读持久化 backend_id，不重读 env
    ...
```

`_spawn` 调用形状从 kwargs 改为 `SpawnRequest`（或保持 kwargs 兼容层一期并存）。

Outbox effect payload 必须携带 `attempt_id` 与固化后的 `backend_id`/`execution_id`。同一个 drain
可以处理不同 backend 的 effect；禁止按 `root_id` 只解析一个 adapter。

**禁止**：Scheduler、Action Processor、Recovery 直接 import 具体 backend。

### 6.5 job_id / session_name 语义

| 字段 | Claude CLI | ACP |
| --- | --- | --- |
| `session_name` | `--name` | Runtime 侧逻辑名；写入 prompt metadata；用于列表过滤 |
| `job_id` | Claude background job id | Runtime 生成的 opaque execution id：`acp:<attempt_id>:<generation>` |
| 停止主键 | job_id | execution id → `execution_sessions` → worker control endpoint |
| 观测主键 | job_id 或 session_name | execution id → execution record + worker heartbeat/PID |

数据库字段不改名；`agents.job_id` 存后端 opaque 主键。`acp_session_id` 只在 execution record 中
诊断使用，不能脱离原连接承担 stop/observe 主键。

---

## 7. ACP Backend 详细设计

### 7.1 进程与连接模型

**v1 固定模型：每个 Attempt 一个 ACP Worker + 一个 Agent Process + 一个 ACP Session**

理由：

- Worker 生命周期独立于短生命周期 Runtime CLI
- 隔离 env / cwd / ACP connection / 崩溃域
- 与现有 “一 Attempt 一 Session” 一致
- 避免多 session 共享进程时的取消与权限串扰

可选后续优化：进程池按 `(agent_command, cwd)` 复用（非 v1）。

生命周期：

```text
spawn:
  1. Scheduler 固化 ExecutionConfig，创建 execution record(status=starting, generation=N)
  2. Outbox claim spawn:<attempt_id>
  3. AcpBackend 检查同 generation 的既有 worker（幂等重入）
  4. detached 启动 acp_worker --execution-id ... --generation N --candidate-nonce ...
  5. Worker CAS 获取 generation ownership；成功后创建 mode 0600 control socket
  6. Worker Popen(agent, 新 process group, stdio pipes, cwd, env)，立即登记 PID 并重查 stop fence
  7. Worker: initialize → authenticate（如需）→ session/new
  8. Worker 发出 session/prompt {sessionId, prompt:[{type:"text", text:bootstrap}]}，
     并写 ready/status=running
  9. AcpBackend 收到 ready handshake，返回 SpawnResult；Outbox 才 completed

stop:
  1. 由 execution id 查 worker control endpoint
  2. 发送 stop(execution_id, generation, reason)，等待有界 ack
  3. Worker: session/cancel（prompt 进行中）→ session/close（若支持）
  4. Worker terminate Agent Process（graceful → kill），清理 socket
  5. 更新 execution record 为 closed；重复 stop 返回 not_required

observe:
  1. 查 execution record，并校验 execution id + generation
  2. worker heartbeat 新鲜且控制端点可握手？→ present
  3. worker 失联/PID 不存在且 status 非 terminal？→ absent
  4. 记录或探测矛盾？→ unknown，不直接改 Task
```

Worker 必须以新 session/process group 脱离调用方，但不得 daemonize 到无法追踪；PID、generation、
control endpoint 和 heartbeat 都要进入 execution record。Runtime terminal 后不得残留 worker、Agent
Process 或 control socket。

### 7.2 Agent Registry

内置逻辑名映射到锁定的 registry profile（可配置覆盖）：

| agent key | 默认 command | 备注 |
| --- | --- | --- |
| `claude` | ACP Registry 的 `claude-acp` profile | 外部 adapter；不等同于 `claude --bg` |
| `codex` | ACP Registry 的 `codex-acp` profile | 外部 adapter |
| `gemini` | ACP Registry 的 `gemini` profile | 外部 adapter，通常为 CLI ACP 参数 |
| `custom` | 必须提供 `command` | 通用兜底 |

启动探测：

- profile 解析为锁定版本的 command/args；禁止默认下载 floating `latest`。
- `command` 不存在或不可执行 → spawn 失败，错误信息含安装提示，但 Runtime 不自动安装。
- `initialize` 超时（默认 30s，可配）→ spawn 失败。

### 7.3 JSON-RPC Client 要求

`AcpClient` 必须支持：

| 能力 | 要求 |
| --- | --- |
| Protocol | 稳定版 ACP v1；`protocolVersion=1` |
| Framing | UTF-8 newline-delimited JSON-RPC；单条消息不得含原始换行 |
| 并发 | 单连接上 request/response 匹配 id；notifications 无 id |
| Client methods | 实现 `session/request_permission`；v1 不实现且不广告 `fs/*`、`terminal/*` |
| 超时 | initialize / session/new / stop 有界；长 prompt turn 可配置 |
| 日志 | 将 RPC 轨迹写入 Run 诊断目录（脱敏 token） |
| 线程/异步 | `asyncio` 或专用 reader 线程均可，但只存在于常驻 Worker；不得依赖 drain 进程存活 |

**权限回调（v1 策略）**：

| policy id | 行为 |
| --- | --- |
| `allow_in_workspace` | 仅当请求暴露的全部标准 locations 可证明位于 cwd/additionalDirectories 时选择 allow；无法分类则 deny |
| `allow_all` | 全部 allow（仅本地可信环境；需显式配置） |
| `deny_all` | 全部 deny（测试用） |
| `prompt` | v1 不实现交互 UI；视为配置错误或降级 deny |

策略只能从 Agent 提供的 `PermissionOption` 中选择，不得假造未提供的 allow/deny option。
ACP 不保证每次 tool 执行都会请求 permission，`rawInput` 也没有跨 Agent 统一的路径字段；因此上述策略
只是 headless 审批自动化，**不是** cwd 沙箱。真实写入边界必须依赖目标 Agent 自身 sandbox、容器或
OS 机制，并在 registry profile 中声明。与 Claude CLI `bypassPermissions` 的差异必须写入 SKILL/docs。

### 7.4 Prompt 投递：同步 vs 异步

现有 `claude --bg`：**立即返回 job id**，工作在后台。

ACP `session/prompt`：**一次 turn 的请求-响应**，可能长时间占用。

v1 规范：

1. 只有 ACP Worker 可以调用 `session/prompt`；Runtime CLI/Outbox 进程不得持有这条长请求。
2. `spawn` 在 Worker 完成 `session/new`、发出 prompt 并写入 ready 后返回 `SpawnResult`，不等 turn 结束。
3. turn 结束后：
   - **不得**自动 `finish` Task；
   - 记录 `PromptTurnEnded` 事件（含 stopReason）；
   - 若 Attempt 已 terminal，进入正常 cleanup；
   - 若 Attempt 仍非 terminal，按 §8.2 的 bounded reprompt/retry 规则处理。
4. Child 在 turn 内应通过 shell/MCP 提交 Runtime Action。除 finish-gate 补救 prompt 外，v1 不提供
   任意多轮会话调度；业务上的继续执行仍由新 Task/Attempt 表达。

### 7.5 Bootstrap Prompt

复用并扩展 `prompt_builder.build_prompt`：

保留：

- `[ORCHESTRATION IDENTITY]`
- Task / Intent / Output contract / Constraints / Notes
- Runtime entrypoint 与 Action 纪律
- Recovery context

调整：

| 段落 | Claude CLI | ACP |
| --- | --- | --- |
| 禁止私自 spawn | “禁止 `claude --bg`” | “禁止绕过 Runtime 启动 sibling agent / 私自开并行 session” |
| Worktree | `worktree-init` + Claude settings | 通用 `bootstrap-cwd`（见 §8.5）；Claude agent 仍可调用兼容命令 |
| 后端提示 | 无 | 可选注明 `execution.backend=acp` 与回报方式 |

Identity env：在 **Agent Process** 的 `Popen(env=...)` 注入完整 Identity Bundle（与今日一致）。
bootstrap prompt 只写 root/task/attempt/agent id，不写 `actor_token`。v1 registry profile 必须验证
adapter 进程 env 会传入实际 shell/tool subprocess；不满足时该 profile 在 CLI Action 模式 clean fail，
等待 Phase 2 通过带派生短期 token 的 Runtime MCP 接入。不得把长期 token 放进模型 prompt 补救。

### 7.6 Child token handoff 与诊断 sidecar

当前 Outbox 是持久队列，不能把明文 child `actor_token` 放入 `payload_json` 后再声称“数据库仅存
hash”。v1 对所有新 child Attempt 使用 Run-scoped secret 派生：

1. `init` 为 Run 生成 256-bit `child_token_seed`，写入
   `$AGENT_SWARM_HOME/secrets/<root_id>.key`（目录 0700、文件 0600）；SQLite 只存 secret ref/hash。
2. child token 定义为 `base64url(HMAC-SHA256(seed, root_id|attempt_id|agent_id))`；Scheduler 把
   token hash 写入 `agents.actor_token_hash`，Outbox 只存 Attempt identity，不存明文 token。
3. 获得 execution ownership 的 Worker 在 Agent Popen 前按 secret ref 派生 token，注入进程 env；
   不写 RPC 日志、execution record 或 sidecar。
4. Run terminal 且所有 spawn/stop execution 已清理后删除 Run seed；pending effect 或 live execution
   存在时不得提前删除。
5. seed 丢失/权限错误时 pending spawn clean fail，不生成新 token、不绕过鉴权。

既有数据库中已存在的 legacy plaintext spawn payload 只为兼容旧 Claude Attempt 读取；消费后立即
改写 payload 为 redacted 形态。SQLite/WAL 不承诺安全擦除，因此新 Attempt 禁止继续写入明文。

可选诊断 sidecar 路径：

路径：

```text
$AGENT_SWARM_HOME/sessions/<root_id>/<attempt_id>.json
```

内容（权限 0600）：

```json
{
  "root_id": "...",
  "task_id": "...",
  "attempt_id": "...",
  "agent_id": "...",
  "token_hash": "...",
  "session_name": "...",
  "backend": "acp",
  "acp_session_id": "...",
  "cwd": "...",
  "created_at": "..."
}
```

- **禁止**把明文 `actor_token` 或 Run seed 写入 sidecar；Action 鉴权使用 Worker 派生并注入 env 的
  Attempt token，SQLite 与 sidecar 只保存 hash。
- sidecar 不是权威状态；spawn 成功后可写入用于人工诊断，stop/finish 后删除。
- crash recover、stop、observe 只依赖 `execution_sessions`，不能依赖可能丢失的 sidecar。

### 7.7 Session 登记表

ACP 无等价于 `claude agents --json` 的跨进程控制面。v1 **必须**新增 `execution_sessions`：

```sql
CREATE TABLE IF NOT EXISTS execution_sessions (
  attempt_id TEXT PRIMARY KEY,
  root_id TEXT NOT NULL,
  backend_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  owner_nonce TEXT,
  session_name TEXT NOT NULL,
  execution_id TEXT NOT NULL UNIQUE,
  config_json TEXT NOT NULL,
  acp_session_id TEXT,
  worker_pid INTEGER,
  agent_pid INTEGER,
  control_endpoint TEXT,
  agent_key TEXT,
  protocol_version INTEGER,
  capabilities_json TEXT,
  status TEXT NOT NULL, -- starting|running|turn_ended|stopping|closed|error
  prompt_state TEXT,    -- pending|in_flight|ended|cancelled
  last_worker_heartbeat_at REAL,
  last_event_at REAL,
  exit_reason TEXT,
  created_at REAL NOT NULL,
  ready_at REAL,
  stop_requested_at REAL,
  reconciled_at REAL,
  closed_at REAL
);
```

约束：

- `attempt_id` 唯一，Attempt 不能同时存在两个 execution。
- `generation + owner_nonce` 构成执行权 fencing token；它不只是诊断字段。record 创建或 generation
  推进时 `owner_nonce` 必须为 NULL，只有赢得 ownership CAS 的 Worker 能写入自己的随机 nonce。
- `config_json` 是 backend/agent/command/model/permission 的不可变快照。
- Agent Process 存活但 Worker 失联视为 `unknown`，先尝试 worker cleanup/孤儿回收；不得直接成功或重派。

### 7.8 Worker 控制协议与幂等恢复

Control endpoint 默认位于：

```text
$AGENT_SWARM_HOME/control/<root_id>/<attempt_id>-<generation>.sock
```

目录 mode 0700，socket mode 0600。最小命令：

- `ping`：返回 execution id、generation、worker/agent PID、prompt state；
- `stop`：有界执行 cancel → close → terminate/kill，并返回 cleanup 结果；
- `status`：返回不含 token/prompt 全文的诊断快照。

spawn effect 是 at-least-once，必须按下列顺序幂等：

1. Runtime 每次启动候选 Worker 都生成独立随机 nonce，但不预写为 owner。Worker 启动后、
   **Popen Agent Process 之前**，必须执行单条 SQLite CAS：仅当 `attempt_id + generation` 匹配、
   `owner_nonce IS NULL`、Run/Attempt 非 terminal 且无 stop fence 时，才把 `owner_nonce` 写成自己的
   nonce 并登记自己的 `worker_pid`。受影响行数不是 1 即失败，Worker 必须在启动 Agent 前退出。
2. Worker 在 Agent Popen 前、`session/new` 前、prompt 发送前、ready 回写前都要确认仍持有当前
   generation/owner_nonce，且 Run/Attempt 非 terminal、`stop_requested_at IS NULL`。
3. 若同 Attempt 的 record 为 running 且 endpoint 握手匹配 generation，直接复用并补记 outbox completed。
4. 若 record 为 starting 且 endpoint 尚未出现，在 `worker_launch_timeout` grace 内只能等待/返回 unknown；
   不得直接推断 absent 或推进 generation。
5. grace 超时后，Runtime 只有在确认旧 Worker、旧 Agent Process/process group 与旧 control socket
   **全部 absent** 后，才能用 CAS 将旧 generation 标记 error/stop-fenced，并推进到新 generation；
   旧 Agent 仍 present 时可主动 terminate/kill，但必须确认清理成功。进程身份无法可靠核验或清理失败
   时保持 `unknown`，禁止推进 generation。新 generation 初始化为 `owner_nonce=NULL`、
   `stop_requested_at=NULL`；旧 generation 的结论保留在事件中，晚到 Worker 因 generation 不匹配失效。
6. Worker ready 之前调用方崩溃，后续 recover 通过 record/endpoint 对账；不得仅因 outbox claim
   超时重放 Agent Popen。
7. 晚到的旧 generation Worker、heartbeat、ready/stop ack 必须被拒绝；旧 Worker 自行清理后退出。

`stop` 以 execution terminal + worker/agent 均退出 + socket 删除作为完成条件。只写数据库 closed、但进程仍
存活，不算 stop completed。

Run stop 与 terminal cleanup 必须覆盖该 Run 的**全部非 terminal `execution_sessions`**，不能只遍历已经
写入 `agents.job_id` 的 Agent：

1. 先在事务中为全部目标 execution 写 `stop_requested_at`，再取消 pending spawn effect；这道 fence
   必须早于任何进程清理。
2. 对已有 control endpoint 的 execution 发送 stop；对尚未 ready、没有 endpoint 的 `starting`
   execution，在有界 grace 内等待候选 Worker 退出，不得继续完成 spawn。
3. Worker 在 Agent Popen 后、PID 登记后、`session/new` 前、prompt 前和 ready 前均重查 ownership 与
   stop fence；ready 回写本身也必须是带 `attempt_id + generation + owner_nonce + no-stop + nonterminal`
   条件的 CAS。发现 stop 时清理自己刚启动的 Agent process group，绝不回写 ready 或 spawn completed。
4. grace 后仍无法证明 worker/Agent 已退出时返回 `unknown` 并保持 cleanup 未完成；不得仅因没有
   `job_id` 就报告 stop 成功。Recovery/doctor 继续按 generation、PID 与 endpoint 做孤儿诊断。

### 7.9 MCP 注入（Phase 2，接口预留 v1）

`session/new.mcpServers` 可包含：

```json
{
  "name": "agent-swarm-runtime",
  "command": "python3",
  "args": ["$AGENT_SWARM_SKILL_DIR/scripts/runtime_mcp_server.py"],
  "env": [
    {"name": "AGENT_SWARM_ROOT_ID", "value": "..."},
    {"name": "AGENT_SWARM_TASK_ID", "value": "..."},
    {"name": "AGENT_SWARM_ATTEMPT_ID", "value": "..."},
    {"name": "AGENT_SWARM_AGENT_ID", "value": "..."},
    {"name": "AGENT_SWARM_MCP_CAPABILITY", "value": "..."},
    {"name": "AGENT_SWARM_HOME", "value": "..."},
    {"name": "AGENT_SWARM_SKILL_DIR", "value": "..."}
  ]
}
```

暴露 tools（与 Action 同语义）：

- `submit_estimate`
- `create_tasks`
- `write_note`
- `wait`
- `finish`
- `action_schema`

v1 **不要求**启用 MCP；child 仍可通过 shell 调 `agent_orchestrator.py action`。上述 capability 是
Phase 2 单独定义的、purpose-bound 且有 Attempt/有效期约束的短期凭据，不得直接复用 child
`actor_token`，也不得写入 prompt、数据库或日志。Phase 2 目标：MCP 为推荐回报路径，CLI 保留兼容。

---

## 8. Lifecycle Guard（Hooks 等价）

### 8.1 现有 Claude Hooks 职责对照

| Hook | 今日行为 | ACP 等价 |
| --- | --- | --- |
| SessionStart / PostToolUse → heartbeat | 刷新 `agents.heartbeat_at` | Action/bootstrap 刷新 Agent heartbeat；Worker/RPC 事件单独刷新 execution heartbeat |
| PostToolUseFailure | 注入恢复文案 | prompt 内协议 + 可选 MCP 错误映射；不做全工具拦截 |
| Stop finish_gate | 未 finish 阻止退出 | **见 8.2** |
| SessionEnd | 仅观察 | `PromptTurnEnded` / process exit 事件 |
| worktree-init | 身份校验 + settings merge | `bootstrap-cwd` 命令，hooks 合并仅 `supports_hooks()` |

### 8.2 Finish 门禁（硬要求）

**不变量**：Attempt 在 Runtime 侧非 terminal 时，外部 session 结束不得被解释为 success。

实现组合（v1 全部启用）：

1. **Prompt 纪律**：bootstrap 要求 finish；禁止“只回复完成”。
2. **Turn 结束检测**：`session/prompt` 返回后立即读取当前 Attempt；若已 terminal，进入 cleanup；
   否则记录 `PromptTurnEnded` 与 `AgentExitedWithoutFinish`，**不**自动 done。
3. **有界补救**：若 `turn_end_reprompt_limit > 0`，Worker 在同一 Session 最多补发一次收尾 prompt：
   “提交 finish(status=done|failed)，或明确报告无法完成”。补救 prompt 仍不得代替 Action。
4. **确定失败**：补救次数耗尽、Agent Process 退出或 prompt 返回错误且 Attempt 仍非 terminal时，
   Worker 写 execution `turn_ended|error` 和 exit reason，随后清理进程。Recovery 看到这个确定事实后
   立即把当前 Attempt 归约为 `failed + retryable`（受 attempt budget 约束），无需再等五分钟 heartbeat。
5. **普通 watchdog**：仅对 prompt 仍 in-flight 的 execution 保留现有策略：
   - Agent heartbeat 过期且 `observe=absent` → 可 retry；
   - heartbeat 过期且 `observe=present` → 报告 parent，不自动杀，除非显式 stop-and-retry；
   - observation `unknown` → 不改 Task，报告诊断。

**禁止**：Client 在 turn end 时伪造 `finish(status=done)`。

### 8.3 确定执行结果的归约

Worker 持久化 `turn_ended|error` 后可能立即退出，不能依赖它继续修改 Control Plane。Runtime 提供唯一的
`reconcile_execution_outcomes(root_id)`，并在以下入口的普通 heartbeat/`present|absent|unknown`
过滤之前调用：

- root `wait` 的 watchdog 路径；
- `reap`；
- `recover`；
- `stop`（先设置 Run no-new-spawns 与 execution stop fence，再读取确定结果；不启动 retry）。

该函数对当前 generation 的每条 execution 执行事务性归约：

1. 读取当前 Attempt 与 execution；若 execution 为 `turn_ended|error`（或已 closed 且 exit reason
   明确为未 finish），Attempt 仍非 terminal 且 `reconciled_at IS NULL`，调用现有 retry transition，
   将当前 Attempt 记为 failed，并按 attempt budget 把 Task 转入可重试或最终 failed 状态；
2. 同一事务写 `reconciled_at` 与对应事件，保证重复 `wait|reap|recover|stop` 不会重复扣预算或创建
   多个替代 Attempt；
3. 若 Attempt 已因合法 `finish` terminal，只标记 execution 已归约并继续 cleanup，不反向改写结果；
4. 事务提交后，`wait|reap|recover` 才可触发 scheduler/outbox drain，不能在状态提交前启动替代
   Worker；`stop` 调用不调度替代 Attempt，只继续 fenced cleanup。

这里的“立即 retry”指下一个 Runtime 命令或 wait watchdog tick 即处理确定事实；v1 不新增全局常驻
daemon。若 execution 仍 `starting|running` 或观测互相矛盾，继续走普通 watchdog 的三态规则，不能
把 unknown 归约成失败。

### 8.4 正常 finish 与自清理

Child 在 ACP tool/terminal 中执行 `finish` 时，Action CLI 必须先提交并返回结果，不能同步 stop 正在承载
该 tool call 的 ACP connection，否则会产生 self-cancel/deadlock。

Worker 每秒读取自身 Attempt 的 terminal 状态：

1. 发现 terminal 后标记 shutdown requested；
2. 给当前 tool/action 返回一个短 grace window；
3. prompt 未自然结束则 `session/cancel`；
4. 有 close capability 则 `session/close`；
5. terminate/kill Agent Process，删除 control socket，写 execution closed。

Root `finish` 的最终门禁除现有 Task/Attempt/Outbox 条件外，还必须确认该 Run 没有非 terminal execution
record。ACP Worker 清理失败时 Run 不得报告 cleanup complete。

### 8.5 bootstrap-cwd

统一 CLI：

```bash
python3 "$AGENT_SWARM_SKILL_DIR/scripts/agent_orchestrator.py" bootstrap-cwd
```

行为：

- 校验 Identity Bundle
- 刷新 heartbeat
- 若 `backend.supports_hooks()`：执行现有 worktree hook merge
- 否则：仅写诊断 marker + heartbeat

保留 `worktree-init` 作为 alias，避免破坏已有 prompt。

### 8.6 Hook 安装策略

```text
init / spawn:
  if backend.supports_hooks():
      hook_manager.ensure_project_hooks(...)
  else:
      skip Claude settings mutation
```

`stop` / Run terminal cleanup：仅清理本 Run 拥有的 hooks（现有 ownership 字段保留）。

---

## 9. 模型与路由

### 9.1 扩展 model_policy

现有：`model_tier_hint` → `strong|balanced|fast` → model 名字符串。

扩展（向后兼容）：

```json
{
  "model_tiers_json": {
    "strong": "claude-opus-4",
    "balanced": "claude-sonnet-4",
    "fast": "claude-haiku"
  },
  "execution": {
    "backend": "acp",
    "routing": {
      "by_intent": {
        "review": { "agent": "codex", "model": "o3" },
        "implement": { "agent": "claude", "model": null }
      },
      "by_model_tier": {
        "fast": { "agent": "gemini" }
      }
    }
  }
}
```

Attempt 创建时的解析顺序：

1. Task 显式 `execution_override`（若将来 schema 允许）
2. `routing.by_intent[resolved_intent]`
3. `routing.by_model_tier[tier]`
4. Run 默认 `execution.backend` + `execution.acp.agent`

环境变量已在 Run init 时合并，不参与这里的解析。最终结果必须整体写入
`execution_sessions.config_json`；为查询方便，`agents` 表在 Phase 1 增加：

- `backend_id TEXT`
- `agent_key TEXT`

既有数据库 migration 将历史 Agent 明确标为 `claude_cli`；**禁止**从 `job_id` 字符串形态猜测
backend。Phase 3 开启混合路由后，stop/observe 仍按 Attempt execution record 分派。

### 9.2 Claude CLI 后端的 model

继续传 `--model`；与今日一致。

### 9.3 ACP 后端的 model

优先使用 agent 广告的 session config/model capability 设置。仅写入 bootstrap prompt 的
`[MODEL HINT]` 不算模型选择成功：若用户显式要求某 model 而 Agent 不支持可验证的 model 配置，
spawn 必须失败；只有 tier hint 才允许记录降级警告后继续。

---

## 10. 状态、事件与诊断

### 10.1 新增/扩展事件

| 事件 | 何时 |
| --- | --- |
| `AgentProcessStarted` | 已有；payload 增加 `backend_id`, `acp_session_id` |
| `AgentSpawnFailed` | 已有 |
| `AcpWorkerStarted` | Worker PID/control endpoint 已登记，但尚未 ready |
| `AcpWorkerReady` | initialize + session/new + prompt sent，spawn effect 可完成 |
| `AcpWorkerLost` | 非 terminal execution 的 worker 已确定缺席 |
| `AcpInitialized` | initialize 成功 |
| `AcpSessionCreated` | session/new 成功 |
| `PromptTurnEnded` | session/prompt 返回 |
| `AgentExitedWithoutFinish` | turn end 或 process exit 且 Attempt 非 terminal |
| `AcpPermissionDecision` | 权限回调结果（采样/限流，避免刷屏） |
| `ExecutionClosed` | worker、Agent Process、socket 均已清理 |
| `AgentStopped` | 已有 |

### 10.2 doctor / inspect

扩展输出：

- 当前 backend、agent registry 解析结果
- 活跃 execution_sessions：generation、worker/agent PID、control handshake、prompt state
- 最近 ACP RPC 错误
- hooks 是否安装（及是否被跳过）
- 数据库状态、PID 与 control endpoint 相互矛盾时 `healthy=false`，不得自动覆盖事实

### 10.3 日志位置

```text
$AGENT_SWARM_HOME/logs/<root_id>/acp/<attempt_id>.ndjson
```

禁止记录完整 `actor_token`、authenticate credential、permission secret 或完整 prompt；RPC 日志采用
method + id + timing + redacted summary，prompt 仅存 hash/长度与可选截断摘要。

---

## 11. 安全

1. **Actor token**：数据库、Outbox、sidecar、prompt 与日志只存 hash/identity，不存明文；Run seed 仅在
   mode 0600 的受保护临时 secret file 中存在。Worker 获得 ownership 后才派生 Attempt token，并只在
   Agent Process 的受控 env 中传递。Phase 2 使用独立的短期 MCP capability，不复用 actor token。
2. **权限策略**：ACP 默认 `allow_in_workspace` 且无法分类即 deny；`allow_all` 需显式配置。
3. **路径与沙箱**：ACP 路径必须绝对，但 permission metadata 不是强制执行边界；真正的 cwd
   限制由 agent-native sandbox/容器/OS 提供。Registry profile 必须声明 sandbox 能力与缺失行为。
4. **密钥**：agent authenticate 不把长期密钥写入 SQLite 事件。
5. **供给链**：内置 profile 锁定 adapter 版本；自定义 `command` 需绝对路径或显式 allowlist，
   文档警告任意 command 风险；Runtime 不自动联网安装。
6. **控制端点**：control 目录 0700、socket 0600；请求必须匹配 execution id + generation，
   不接受仅凭 PID 的 stop/status。
7. **多 tenant**：单用户本机假设与现网一致；不做远程多租户隔离。

---

## 12. 对外接口与 CLI

### 12.1 保持不变

```bash
agent_orchestrator.py init|action|recover|reap|stop|inspect|doctor|action-schema|worktree-init
```

Action JSON schema 不变。

### 12.2 新增/扩展

```bash
# 显式 backend（也可全靠 env）
agent_orchestrator.py init --task "..." --cwd "$PWD" \
  --backend acp \
  --acp-agent claude

# 别名
agent_orchestrator.py bootstrap-cwd   # worktree-init 的超集

# 诊断
agent_orchestrator.py doctor --root-id <id>   # 含 backend 段
```

### 12.3 SKILL.md 变更要点（实现阶段）

- 激活边界不变。
- “Runtime launches `claude --bg`” 改为 “Runtime launches child via configured Execution Backend（默认 Claude CLI）”。
- 禁止子 agent 私自 spawn 的表述 generic 化。
- 增加 ACP 依赖安装与权限策略说明。
- Hooks 描述标明 “仅 Claude CLI backend”。

---

## 13. 对技能代码的影响矩阵

| 路径 | 影响 | 说明 |
| --- | --- | --- |
| `scripts/state_store.py` | 中 | `execution_sessions`、Run execution JSON、schema migration |
| `scripts/execution_secrets.py` | **新增** | Run seed 创建/权限校验、Attempt token 派生、terminal cleanup |
| `scripts/scheduler.py` | 中 | 创建 Attempt 时解析并固化 ExecutionConfig |
| `scripts/outbox.py` | 中高 | effect 级 Backend 解析、worker ready handshake、幂等补偿 |
| `scripts/action_processor.py` | 中 | terminal execution cleanup 门禁；hooks 条件化；配置透传 |
| `scripts/recovery.py` | 高 | execution 对账、worker lost/turn ended 归约、跨进程 stop/孤儿清理 |
| `scripts/prompt_builder.py` | 中 | 文案 generic + 可选 backend 段 |
| `scripts/model_policy.py` | 中 | routing |
| `scripts/agent_orchestrator.py` | 中 | init 配置解析、bootstrap-cwd、doctor 输出、hooks 条件化 |
| `scripts/claude_adapter.py` | 迁移 | 迁入 `backends/claude_cli.py` |
| `scripts/hook_manager.py` | 小 | 仅 supports_hooks 时调用 |
| `scripts/hook_runtime.py` / `hooks/*` | 无功能变 | Claude 路径继续用 |
| `scripts/backends/acp/adapter.py` | **新增** | worker 启停/观测适配，不直接持有 ACP stdio |
| `scripts/backends/acp/worker.py` | **新增** | 常驻 supervisor、ACP RPC、turn 与 cleanup 生命周期 |
| `scripts/backends/acp/client.py` | **新增** | 最小稳定 ACP v1 JSON-RPC client |
| `scripts/backends/acp/worker_protocol.py` | **新增** | ready/stop/status IPC |
| `scripts/runtime_mcp_server.py` | Phase 2 新增 | |
| `SKILL.md` / `references/*` | 中 | 文档 |
| `tests/*` | 中高 | fake backend + acp fake server |

**不变**：Action 语义、finish 结构门禁、预算数字默认值、激活 boundary。

---

## 14. 测试计划

### 14.1 单元

| 用例 | 期望 |
| --- | --- |
| `resolve_spawn_backend` 默认 claude_cli | 返回 Claude 实现并固化 ExecutionConfig |
| env `AGENT_SWARM_BACKEND=acp` | 返回 ACP 实现 |
| Run 创建后修改 env | 既有 Attempt backend/config 不漂移 |
| ACP initialize 失败 | spawn 异常，attempt retryable fail |
| ACP worker ready | initialize + session/new + prompt sent 后 job_id 回写，state evaluating |
| drain 进程退出 | worker/Agent 继续存活并能处理 permission/update |
| spawn ready 前调用方崩溃 | recover 复用原 worker，不重复 Popen |
| stale outbox claim 重放 | 同 Attempt 始终只有一个 live generation |
| 旧 Worker 延迟启动 | 新 generation 已推进后，旧 Worker ownership CAS 失败且未 Popen Agent |
| Worker crash 但 Agent orphan 存活 | 保持 unknown，不推进 generation；确认回收 orphan 后才能 retry |
| stop 来自新 CLI 进程 | 经 control endpoint cancel/close/kill，完整 ack |
| stop 命中 starting execution | 先写 stop fence；Worker 不得 ready，已 Popen 的 Agent 被清理 |
| stop 幂等 | 二次 stop 不抛 |
| worker/Agent PID 与 record 矛盾 | unknown + doctor unhealthy，不误判 absent/present |
| permission allow_in_workspace | 标准 locations 全在 workspace 才 allow；缺失/越界 deny |
| prompt end 未 finish | bounded reprompt 后 failed+retryable，不进入 done |
| turn ended 重复对账 | `reconcile_execution_outcomes` 只扣一次 attempt budget、只创建一次 retry |
| spawn payload / prompt / sidecar | 不含明文 actor token；Agent env 收到的派生 token 可通过 Action 鉴权 |
| finish 正常返回 | Action 先返回，随后 worker 自清理，无 self-cancel/deadlock |
| prompt_builder ACP 模式 | 无 “claude --bg” 专有禁令残留错误 |

### 14.2 集成（fake agent）

提供 `tests/fixtures/fake_acp_agent.py`，支持按场景配置：

- 最小 initialize / session/new / session/prompt / cancel / close；
- 发 permission request、持续 update、延迟 prompt、无 finish 返回、异常退出、忽略 cancel；
- prompt 内可调用真实 `agent_orchestrator.py action`（subprocess）完成 estimate+finish

至少跑通：

1. `init → split → create_tasks → ACP spawn → child finish → worker cleanup → root wait → root finish`；
2. spawn ack 丢失后 recover，不重复启动；
3. 旧 generation Worker 延迟到新 generation 之后启动，ownership fence 保证只有一个 Agent Process；
4. Worker crash 后 orphan Agent 继续存活时不启动新 generation；成功回收 orphan 后才允许 retry；
5. child 未 finish，独立 `wait|reap|recover` 均可幂等触发一次 retry；
6. `stop` 分别在 initialize 中和 Agent Popen 后/ready 前发生，均不回写 ready 且最终零残留；
7. `stop` 从独立 CLI 调用并清理 worker、Agent Process、socket；
8. permission 越界/无法分类被拒绝且 Runtime 不崩溃。

### 14.3 回归

- 现有 `tests/` 在默认 backend 下 **必须全绿**
- Claude hooks 测试不在 acp 模式运行 install 断言
- CI 检查 ACP v1 contract fixture；若官方 schema 漂移，不得静默放宽 client parser

### 14.4 手动验收（真实 agent）

矩阵（环境具备时）：

| Agent | 场景 |
| --- | --- |
| Registry `claude-acp` profile | 单 child direct finish |
| codex-acp（若可得） | 只读 review intent |
| 权限拒绝 | 可识别的越界请求被 deny；同时明确这不是 OS sandbox 证明 |
| cleanup | 正常 finish、stop、worker crash 后均无 worker/agent/socket 残留 |

---

## 15. 分阶段交付

### Phase 0 — 接口抽出（无行为变化）

- 引入 `AgentBackend` + `backends/claude_cli.py`
- outbox/recovery 改为 effect/execution 级依赖接口
- `runs.execution_json` 与 `execution_sessions` schema/migration 先落地；历史执行明确写 `claude_cli`
- init 配置优先级、Attempt immutable snapshot、generation ownership CAS 契约测试
- 测试全绿
- **验收**：用户无感

### Phase 1 — ACP MVP

- 最小稳定 ACP v1 `AcpClient` + `AcpBackend`
- 每 Attempt 一个 detached Worker + 一个 Agent Process + 一个 Session
- `execution_sessions` 表
- ready/control IPC、generation 与 worker heartbeat
- spawn/stop/observe/recover 幂等闭环；stop 覆盖尚无 job_id 的 starting execution
- Run seed / Attempt token 派生，Outbox/prompt/sidecar 无明文 token
- `reconcile_execution_outcomes` 在 wait/reap/recover/stop 入口统一归约确定结果
- prompt end bounded reprompt/retry、正常 finish 自清理
- Fake ACP agent 集成测试
- env/init 开关
- **验收**：fake agent 跑通 split 闭环、ack 丢失恢复、未 finish retry、跨 CLI stop 与零残留；
  默认路径无回归

### Phase 1b — 真实 Agent 兼容与诊断加固

- bootstrap-cwd alias
- doctor 扩展
- registry 锁定 profiles、认证 preflight、permission policies 与 sandbox capability 文档
- Claude/Codex 至少各完成一次真实 Agent 场景；能力差异写入 profile，不污染 Control Plane
- **验收**：真实 Agent 的 direct finish/stop/permission 行为符合 contract；缺失依赖 clean fail

### Phase 2 — Runtime MCP

- `runtime_mcp_server.py`
- session/new 注入 MCP
- 文档推荐 MCP 回报
- **验收**：无 shell 的假 agent 仅靠 MCP finish 成功

### Phase 3 — 路由与多 agent

- intent/tier → agent 路由
- 真实多厂商矩阵文档
- **验收**：同一 Run 内 review child 与 implement child 可用不同 agent key

### 明确不做的后续（需新 spec）

- ACP session 跨 Runtime 重启的 load/resume 恢复同一会话
- 进程池复用
- 远程 ACP over HTTP 作为一等后端
- Root 自身嵌入为 ACP Agent 对外服务

---

## 16. 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| Runtime CLI 短生命周期 | ACP pipe/permission handler 随调用方退出 | detached Worker 独占连接；ready/control IPC |
| spawn effect ack 丢失 | 重复 Agent/重复修改 | Attempt 唯一 record + ownership CAS；Worker/Agent/socket 全部 absent 后才推进 generation |
| `session/prompt` 长请求 | 阻塞 / 与 bg 模型不一致 | Worker 持有长请求；spawn 只等 ready，不等 turn end |
| 无 Stop hook | 静默退出未 finish 或永久 active | bounded reprompt；确定 turn end 立即 failed+retryable；禁止自动 done |
| finish 触发自我 stop | tool call 被自身 cancel、死锁 | Action 先返回；Worker 观察 terminal 后异步自清理 |
| env 被 adapter 丢弃 | 子 agent 无法通过 CLI Action 鉴权 | registry profile 验证 env 能到真实 tool subprocess；失败则该 profile clean fail，等待 Phase 2 MCP capability；禁止把 token 写入 prompt/sidecar 补救 |
| 权限模型不一致 | 把审批误当沙箱导致越权 | 未分类 deny；profile 声明真实 sandbox；文档对比 bypassPermissions |
| agent 输出非结构化 | 误判完成 | 完成只认 Action |
| ACP schema/adapter 漂移 | 连不上或行为变化 | 锁定 ACP v1 与 adapter 版本；contract test；显式升级 |
| 多 backend 行为漂移 | 难支持 | 契约测试固定 Control Plane；Backend 只测 exec |
| worker/PID/socket 残留 | stop 假成功、资源泄漏 | generation 握手；cleanup gate；orphan repair 与零残留测试 |
| stop 与 starting/ready 竞争 | stop 后仍启动或出现幽灵 Agent | 先持久化 stop fence；Worker 关键点重查；ready CAS 拒绝 terminal/stopped execution |

---

## 17. 验收标准（Definition of Done）

### 对产品

1. 默认配置下，现有 Claude CLI 蜂群行为与文档一致，旧测试通过。
2. 可在配置后通过 ACP 启动至少一种真实或 fake agent 完成 child Task。
3. 任意 backend 下，未 `finish` 的 Attempt 不会被标为 `done`。
4. ACP turn 未 finish 时在有界补救后进入 retryable failure，不会永久卡在 present/active。
5. Parent `wait` / `reap` / `stop` / `recover` 在 ACP 模式下语义正确（recover v1 允许新 Attempt 而非 session resume）。
6. 正常 finish、失败、stop、recover 后没有本 Run 的 worker、Agent Process 或 control socket 残留。
7. SKILL 与 runtime-contract 描述与实现一致。

### 对工程

1. 无 Control Plane 模块直接依赖 `claude` CLI 字符串（仅 `backends/claude_cli.py` 与 hooks）。
2. 新增 fake ACP 集成测试在 CI 可跑（不依赖外网与真实模型）。
3. spawn effect 在 ready ack 丢失/claim 重放时不会为同一 Attempt 创建两个 live execution。
4. stop/observe 可由不同于 spawn 的 Runtime CLI 进程完成，不依赖内存中的 ACP handle。
5. backend/config 在 Attempt 创建后不可因环境变化漂移；不从 job_id 形态推断 backend。
6. permission 文档与实现明确不宣称 cwd sandbox；无法分类的请求默认 deny。
7. 明文 child token 不进入 SQLite/Outbox/prompt/sidecar/log；seed 文件权限和 terminal cleanup 有测试。
8. turn ended/error 通过统一对账函数只归约一次；stop 对 starting/running execution 都有 fence 与零残留测试。
9. 本 spec 状态可升为 Accepted，并在 `runtime-contract.md` 增加 “Execution Backend” 小节链接本文。

---

## 18. 文档同步清单（实现时）

| 文档 | 变更 |
| --- | --- |
| `SKILL.md` | 后端可插拔、ACP 配置、hooks 范围 |
| `runtime-contract.md` | Execution Backend、opaque job_id、Worker ownership、cleanup gate、hooks 条件化 |
| `recovery-protocol.md` | execution 对账、跨进程 observe/stop、turn ended retry；无 session resume |
| `action-schemas.md` | 无需改 schema；可注明与 backend 无关 |
| `.workspace/repos/imctl-ai/...` | 若晋升为稳定事实，更新 agent-swarm 域摘要 |
| 本文件 | 状态 Draft → Accepted；记录偏差 |

---

## 19. 已定事项与开放问题

| ID | 问题 | 倾向 | 需谁拍板 |
| --- | --- | --- | --- |
| D1 | ACP Client 形态 | 内嵌标准库最小 ACP v1 Client；不调用 acpx，不在运行时 pip install | 已定 |
| D2 | 长连接所有权 | 每 Attempt 一个 detached ACP Worker；Runtime CLI 不持有 pipe | 已定 |
| D3 | `session/prompt` spawn 门槛 | 只等 initialize + session/new + prompt sent 的 worker ready | 已定 |
| D4 | 同一 Run 混用 backend | Phase 3 再开；但 execution schema 从 Phase 0 起按 Attempt 固化 | 已定 |
| D5 | 权限默认 | `allow_in_workspace` 且无法分类 deny；仅是审批，不是沙箱 | 已定 |
| O1 | Claude/Codex adapter profile 的升级节奏 | 仓库显式锁版本、定期 contract 验证后升级 | 维护者 |
| D6 | Runtime MCP credential | 不复用 actor_token；Phase 2 定义 purpose-bound、短期 MCP capability | 已定；细节归 Phase 2 spec |
| O3 | Worker control 使用 Unix socket 的 Windows 兼容 | v1 支持 macOS/Linux；Windows 需等价 named pipe 新增说明 | 实现负责人 |

---

## 20. 附录

### A. 当前 Claude 适配表面（迁移对照）

| 函数 | 文件 | 迁入 |
| --- | --- | --- |
| `spawn` | `claude_adapter.py` | `backends/claude_cli.py` |
| `stop` | 同上 | 同上 |
| `observe_session` / `session_alive` / `list_sessions` | 同上 | 同上 |
| `_DefaultAdapter` | `outbox.py` | spawn 用 `resolve_spawn_backend`；stop/observe/recover 用 `resolve_execution_backend` |
| hook ensure/cleanup | `hook_manager.py` | 条件调用 |

### B. ACP 方法最小子集（v1 Client 视角）

**必须调用/支持（Agent methods）**：`initialize`, `session/new`, `session/prompt`；进行中 stop 时发送 `session/cancel`

**尽量调用**：`session/close`（若广告）

**必须响应（Client methods）**：`session/request_permission`

**v1 不广告**：`fs/read_text_file`, `fs/write_text_file`, `terminal/*`；违规调用返回 method-not-found

传输固定为稳定 ACP v1 stdio：UTF-8、每行一个 JSON-RPC message。Client capabilities 只广告实际
实现的方法；不得广告 fs/terminal 后再用 method-not-found 拒绝正常调用。

### C. 配置示例

```bash
# 默认：无变化
python3 scripts/agent_orchestrator.py init --task "拆分实现并审查" --cwd "$(pwd)"

# ACP + 指定 agent
export AGENT_SWARM_BACKEND=acp
export AGENT_SWARM_ACP_AGENT=claude
export AGENT_SWARM_ACP_PERMISSION_POLICY=allow_in_workspace
python3 scripts/agent_orchestrator.py init --task "拆分实现并审查" --cwd "$(pwd)"
```

### D. 参考链接

- Agent Client Protocol 介绍：https://agentclientprotocol.com/get-started/introduction
- Stable v1 overview：https://agentclientprotocol.com/protocol/v1/overview
- Stable v1 transports：https://agentclientprotocol.com/protocol/v1/transports
- Stable v1 session setup：https://agentclientprotocol.com/protocol/v1/session-setup
- Stable v1 prompt turn：https://agentclientprotocol.com/protocol/v1/prompt-turn
- ACP Python SDK：https://github.com/agentclientprotocol/python-sdk
- ACP Agent Registry：https://github.com/agentclientprotocol/registry
- Claude Agent ACP adapter（生态示例）：https://github.com/agentclientprotocol/claude-agent-acp
- 本技能 Runtime 契约：[runtime-contract.md](./runtime-contract.md)

---

## 21. 变更记录

| 版本 | 日期 | 说明 |
| --- | --- | --- |
| 0.2.0 | 2026-07-25 | 补齐常驻 ACP Worker/IPC、generation ownership fence、starting stop fence、确定结果统一归约、无明文 token 的跨进程 handoff、Attempt 级配置固化、权限边界与 ACP v1 依赖策略 |
| 0.1.0 | 2026-07-25 | 初稿：架构、Backend 接口、ACP MVP、Hooks 等价、分阶段交付与验收 |
