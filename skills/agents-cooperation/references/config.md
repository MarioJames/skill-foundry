# 调度配置说明

SKILL.md 的“调度配置”写规则，本文写字段、派发推导、task 执行流程、额度 block 细节和配置流程。脚本为 `<skill>/scripts/agents-config.ts`（bun，无第三方依赖），输出 JSON 到 stdout，错误逐条列出 JSON 路径并非零退出。

## 位置与来源

- 配置：`~/.config/agents-cooperation/config.json`；`AGENTS_COOPERATION_CONFIG` 或脚本 `--config <path>` 覆盖。不存在时使用 `<skill>/assets/config.default.json`。不做多层合并。
- 默认配置是唯一默认来源，也是用户复制的起点：claude 与 codex 引擎、`claude_owner`、`codex_owner`、`claude_worker`（sonnet，high）、`codex_worker`（gpt-6.1-sol，high）为 enabled；pi 引擎与 `pi_worker`（class `task`）、grok 引擎与 `grok_owner`、`grok_worker` 以 `enabled: false` 的示例存在。各 owner 的 `max_parallel` 默认 3。
- 结构由 `<skill>/assets/config.schema.json`（JSON Schema draft 2020-12）定义，配置用 `"$schema"` 指向它；校验器直接读取 schema，字段表不在脚本里重复。

## 字段

```jsonc
{
  "$schema": "...",
  "version": 1,
  "engines": {
    "<engine-id>": {
      "enabled": true,
      "kind": "claude",              // herdr agent start --kind 的合法值之一
      "native_subagents": true       // 仅 kind 为 claude、codex、grok 时可为 true
    }
  },
  "owners": {
    "<owner-id>": {
      "enabled": true,
      "engine": "<engine-id>",       // 该引擎必须 native_subagents=true
      "model": "claude-opus-5-5",
      "effort": "high",
      "workers": ["<agent-id>"],     // 必填、非空、无重复，按优先级排序，可含 worker 与 task
      "max_parallel": 3              // 必填，≥1，该 owner 同时运行的子 agent 上限
    }
  },
  "agents": {
    "<agent-id>": {                  // key 必须以 _worker 结尾，不分 class
      "enabled": true,
      "engine": "<engine-id>",
      "class": "worker",             // 或 "task"
      "model": "sonnet",
      "effort": "high",
      "description": "可选，适用场景说明"
    }
  }
}
```

- **命名**：engine、owner、agent 的 id 匹配 `^[a-z][a-z0-9_]{0,39}$`；`agents` 下所有 key 以 `_worker` 结尾（task agent 也一样，如 `pi_worker`）。默认命名：引擎 `claude` `codex` `pi` `grok`，owner `claude_owner` `codex_owner` `grok_owner`，子 agent `claude_worker` `codex_worker` `pi_worker` `grok_worker`。
- **未知字段**：所有对象禁止多余字段，顶层只额外允许 `$schema`。
- **effort**：schema 只要求非空字符串，合法取值由脚本按引擎 kind 校验，是引擎原生语义，不做跨引擎统一：claude `low|medium|high|xhigh|max`；codex `minimal|low|medium|high|xhigh|max`；pi `off|minimal|low|medium|high|xhigh|max`；grok `none|minimal|low|medium|high|xhigh|max`；其他 kind 为任意非空字符串。
- **语义校验**：引用必须存在；enabled owner 的引擎必须 enabled 且 `native_subagents: true`；`workers` 中每个 id 存在，enabled owner 至少有一个 enabled、引擎 enabled 的 class `worker` 子 agent；每个引擎至多一个 enabled owner（宿主据此识别自己的 owner）。

## 派发方式推导

调度方式不入配置，由 owner 与子 agent 的引擎关系推导：

| 条件 | 方式 |
| --- | --- |
| class `worker`，引擎 == owner 引擎 | `native` |
| class `worker`，引擎 != owner 引擎 | `herdr` interactive |
| class `task` | `herdr` oneshot（即使同引擎） |

`resolve` 的输出：

- **native + claude**：`tool: Agent`，`params` 含 `model`、`effort`、`subagent_type: general-purpose`。只读类型可替换 `subagent_type`，`model` 与 `effort` 保持不变；不用 `fork`。
- **native + codex**：`tool: spawn_agent`，`params` 含 `model`、`reasoning_effort`、`fork_turns: "none"`。
- **native + grok**：`tool: spawn_subagent`，`params` 含 `model`、`subagent_type`，并带 `warnings`：grok 不支持按次设置 effort，子 agent 沿用 owner 会话的 effort。另外，`model` 参数在全 xAI 模型目录且开启 `subagent_model_inheritance` 时会被隐藏，此时模型沿用父会话，派发后必须核对实际模型。
- **herdr interactive**：`mode: interactive`、`kind`、`argv`；argv 是 `herdr agent start <name> --kind <kind> --pane <pane> -- <argv>` 中 `--` 之后的部分。
- **herdr oneshot**：`mode: oneshot`、`kind`、`argv`、`task_file_placeholder: "{task_file}"`；claude 与 codex 的任务文件经 stdin 传入（输出带 `stdin: "{task_file}"`），pi 与 grok 以参数传入文件。
- **`--peer`**：`resolve --owner <self> --peer <owner-id>` 输出协作 owner 的 herdr interactive argv，用法见 [协作协议](peer-protocol.md#启动协作-owner)。
- **拒绝**：owner 或子 agent 不存在、disabled、所属引擎 disabled、被 block 时非零退出。`--agent` 显式指定的子 agent 不在该 owner 的 `workers` 列表中也允许，但输出 `warnings`。
- **`--class worker|task`**：按 `workers` 顺序选第一个可用的该 class 子 agent；都不可用时非零退出，列出每个候选的不可用原因。额度耗尽后的自动切换就靠它。

各 kind 的 argv（以 `resolve` 输出为准，此处仅供对照）：

| kind | interactive（`--` 之后） | oneshot |
| --- | --- | --- |
| claude | `--model <m> --effort <e> --permission-mode bypassPermissions` | `claude -p --model <m> --effort <e> --permission-mode bypassPermissions`，任务文件经 stdin |
| codex | `-m <m> -c model_reasoning_effort=<e>` | `codex exec -m <m> -c model_reasoning_effort=<e> -`，任务文件经 stdin |
| pi | `--model <m> --thinking <e>` | `pi -p --mode json --no-session --model <m> --thinking <e> @{task_file}` |
| grok | `-m <m> --effort <e> --permission-mode bypassPermissions` | `grok --prompt-file {task_file} -m <m> --effort <e> --permission-mode bypassPermissions --output-format json` |

其他 kind 报“不支持构建启动参数”。

## Herdr 派发流程

先按 [协作协议](peer-protocol.md#启动协作-owner) 的方式用 `route-lane` 取得 pane，信任提示按同一节处理。

**interactive（跨引擎 worker）**：`herdr agent start <name> --kind <kind> --pane <pane> -- <argv>` 启动，交接内容写成消息目录下的文件，`herdr agent prompt <name> "<信封或文件路径>" --wait --until idle --until done --until blocked --timeout <ms>` 发送，结果由 worker 写入约定文件。生命周期、等待和 SendMessage 之外的续接都沿用协作协议；worker 守则同 SKILL.md 的子 agent 交接。

**oneshot（task agent）**：

1. 任务说明写入任务文件（目标、写入文件清单、验证命令或检查项、禁止事项、回报格式），并约定结果文件路径。
2. 用 `herdr pane run <pane> '<argv，{task_file} 已替换>'` 执行；有 `stdin` 字段时加 `< <任务文件>`，输出重定向到结果文件，命令末尾回显带唯一标记的结束行（含退出码）。
3. 用 `herdr pane wait-output --match '<结束标记>' --timeout <ms>` 等待；超时先读 pane 输出判断原因，不盲目重跑。
4. owner 读结果文件，复核 diff 和验证，等同 worker 验收；结果显示越界、需要判断或失败时，不重跑，改派 worker。

## 并行上限

只有 owner 级一层：`owners.<id>.max_parallel` 必填，≥1，是该 owner 同时运行的子 agent（worker 与 task 合计）上限。owner 按自己台账中“运行中”的条目计数，达到上限时新包标“待派发”，不突破。

不设全局或引擎级上限：各 owner 观测不到对方的子 agent，无法准确计数。额度和速率压力由下面的 block 机制处理。

## Task 契约

同时满足以下四条才可交给 task agent：不含设计决策、写入范围是明确的文件清单（只读则为空）、结果可由一条命令或明确检查项验证、不需要续接上下文且一次执行完成。典型：按既定规则批量改名、改文案、改配置，跑测试并汇总，只读检索与清点。不满足任一条，或执行中发现需要判断时，task agent 停止回报，由 owner 改派 worker。

## 额度耗尽 block 与自动解封

运行状态与配置分离，不写入 `config.json`。状态文件：`~/.local/state/agents-cooperation/availability.json`（`AGENTS_COOPERATION_STATE` 或 `--state <path>` 覆盖），由脚本原子写入（临时文件加 rename），文件不存在视为无 block。结构由 `<skill>/assets/availability.schema.json` 定义，脚本读取时校验，结构非法或同一 (engine, model) 重复都会报错。owner 不手工编辑，只用下面的命令：

```json
{ "version": 1, "blocks": [
  { "engine": "codex", "model": "gpt-6-astra", "reason": "usage limit",
    "since": "2026-10-16T22:00:00-04:00", "until": "2026-10-17T03:00:00-04:00", "by": "claude_owner" }
] }
```

- `model` 省略 = 整个引擎（账户级额度）；有值 = 该引擎下使用该 model 的 owner 与子 agent。`until` 省略 = 重置时间未知，直到手动 `unblock`。同一 (engine, model) 只保留一条，再次 `block` 覆盖。
- **到期自动解封**：所有命令读取状态时，`until` 已过的条目视为失效；`block` / `unblock` 写入时顺带清除过期条目。不需要常驻进程。

命令：

| 命令 | 作用 |
| --- | --- |
| `block --engine <id> [--model <m>] [--until <ISO8601 \| +<n>m \| +<n>h \| +<n>d>] --reason <text> [--by <owner-id>]` | 写入 block，engine 必须存在于配置；输出写入后的条目 |
| `unblock --engine <id> [--model <m>]` | 删除精确匹配的条目，输出删除数量 |
| `status` | 当前有效的 block 列表，以及每个 owner 和子 agent 的可用性 |

可用性判定（`resolve`、`show`、`status` 共用）依次为：`disabled`（自身 enabled=false）→ `engine_disabled` → `blocked`（引擎级或 engine+model 级，附 `until` 和 `reason`）→ `available`；`show` 输出中每个 owner 和子 agent 都带 `availability`。

传播：

- owner 被 block 时，以它为发起方的 `resolve --owner` 一律拒绝，它的原生子 agent 随之不可派发；同引擎但不同 model 且未被 block 的子 agent，仍可被其他 owner 经 herdr 使用。
- 引擎级 block 则该引擎上的 owner 与子 agent 全部不可用。

owner 的处置步骤见 SKILL.md 的“额度耗尽”：识别信号、`block`（能解析出重置时间就写 `--until`；报错只针对某个模型时带 `--model`）、`resolve --class` 重选、整包改派并写台账。协作 owner 被 block 时降级为单 owner。

## 修改配置

1. 编辑 `~/.config/agents-cooperation/config.json`。没有就从 `assets/config.default.json` 复制，并把 `$schema` 改成技能安装目录下 `assets/config.schema.json` 的绝对路径；默认配置里的相对路径 `./config.schema.json` 只在技能目录内有效。
2. `bun <skill>/scripts/agents-config.ts validate`，按错误里的 JSON 路径逐条修正，直到输出 `ok: true`。
3. `show` 确认 owner、`workers` 顺序、`availability` 和并行上限符合预期。
4. 不要为了绕过校验放宽 schema；新增引擎 kind 或 effort 取值先改 schema 与脚本常量表。

示例：启用 pi 作为 task agent（默认配置中已有 `pi` 与 `pi_worker` 的 disabled 示例）：

```jsonc
{
  "engines": { "pi": { "enabled": true, "kind": "pi", "native_subagents": false } },
  "agents": {
    "pi_worker": {
      "enabled": true, "engine": "pi", "class": "task",
      "model": "cc-switch-agentplan/deepseek-v4.1-flash", "effort": "medium",
      "description": "按既定规则批量改写、只读检索和清点"
    }
  },
  "owners": { "claude_owner": { "workers": ["claude_worker", "codex_worker", "pi_worker"] } }
}
```

模型取自已安装的 pi 配置；`validate` 只校验结构与引用，不探测模型是否真实存在。
