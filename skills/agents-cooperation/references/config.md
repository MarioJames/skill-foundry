# 调度配置说明

SKILL.md 的“调度配置”写规则，本文写字段、派发推导、task 执行流程、额度 block 细节和配置流程。脚本为 `<skill>/scripts/agents-config.ts`（bun，无第三方依赖），输出 JSON 到 stdout，错误逐条列出 JSON 路径并非零退出。

## 位置与来源

- 配置：`~/.config/agents-cooperation/config.json`；`AGENTS_COOPERATION_CONFIG` 或脚本 `--config <path>` 覆盖。不存在时使用 `<skill>/assets/config.default.json`。不做多层合并。
- 默认配置是唯一默认来源，也是用户复制的起点，按模型特点初始化：
  - 引擎：claude、codex 为 enabled 且 native；grok（native）、opencode（`kind: opencode`）与 qoder（`kind: qodercli`）为 `enabled: false` 的示例。
  - owner：`claude_owner`（claude-opus-5-5，high）、`codex_owner`（gpt-6-astra，high）为 enabled，`max_parallel` 4，`prefer_task: true`；`grok_owner`（grok-4.7，high）为 `enabled: false`。`workers` 顺序：`claude_owner` 为 `claude_worker`、`qoder_worker`、`codex_worker`、`opencode_worker`、`grok_worker`；`codex_owner` 为 `codex_worker`、`qoder_worker`、`claude_worker`、`opencode_worker`、`grok_worker`；`grok_owner` 为 `grok_worker`、`qoder_worker`、`claude_worker`、`codex_worker`、`opencode_worker`。即本引擎的原生 worker 第一位，免费 worker 紧随其后。
  - worker：`claude_worker`（claude / sonnet / high / class `worker`，tags `frontend` `ui` `browser` `docs`）、`codex_worker`（codex / gpt-6.1-sol / high / class `worker`，tags `backend` `algorithm` `test` `refactor`）为 enabled；`grok_worker`（grok / grok-4.7 / high / class `worker`，tags `research`）、`qoder_worker`（qoder / `Qwen3.8-Flash` / xhigh / class `worker`，tags `routine` `test` `lint` `scaffold`，免费模型，用于方案已冻结且范围明确的常规实现）与 `opencode_worker`（opencode / `opencode/glm-5.3-flash-free` / max / class `task`，tags `mechanical` `test` `lint` `sweep`，免费模型，着重用于 task）为 `enabled: false`。
  - 用户配置按需启用：启用 `opencode`、`qoder` 引擎与 `opencode_worker`、`qoder_worker`；grok 引擎启用后 `grok_owner`、`grok_worker` 仍可保持 disabled。
- 结构由 `<skill>/assets/config.schema.json`（JSON Schema draft 2020-12）定义，配置用 `"$schema"` 指向它；校验器直接读取 schema，字段表不在脚本里重复。

## 字段

```jsonc
{
  "$schema": "...",
  "version": 1,
  "engines": {
    "<engine-id>": {
      "enabled": true,
      "kind": "claude",              // herdr agent start --kind 的合法值之一（claude、codex、grok、opencode、qodercli）
      "native_subagents": true       // 仅 kind 为 claude、codex、grok 时可为 true
    }
  },
  "owners": {
    "<owner-id>": {
      "enabled": true,
      "engine": "<engine-id>",       // 该引擎必须 native_subagents=true
      "model": "claude-opus-5-5",
      "effort": "high",
      "workers": ["<worker-id>"],    // 必填、非空、无重复，按优先级排序，可含 worker 与 task
      "max_parallel": 4,             // 必填，≥1，该 owner 同时运行的子 agent 上限
      "prefer_task": true            // 可选，默认 true；见 SKILL.md“Task 契约”
    }
  },
  "workers": {
    "<worker-id>": {                 // key 必须以 _worker 结尾，不分 class
      "enabled": true,
      "engine": "<engine-id>",
      "class": "worker",             // 或 "task"
      "model": "sonnet",
      "effort": "high",
      "tags": ["frontend"],          // 可选，按领域选择用，见下文“tags”
      "description": "可选，适用场景说明"
    }
  }
}
```

- **命名**：engine、owner、worker 的 id 匹配 `^[a-z][a-z0-9_]{0,39}$`；`workers` 下所有 key 以 `_worker` 结尾（task 子 agent 也一样，如 `opencode_worker`）。默认命名：引擎 `claude` `codex` `grok` `opencode` `qoder`，owner `claude_owner` `codex_owner` `grok_owner`，worker `claude_worker` `codex_worker` `grok_worker` `opencode_worker` `qoder_worker`。顶层字段是 `workers`，不接受旧字段 `agents`（报未知字段）。
- **tags**：可选，字符串数组，每项匹配 `^[a-z][a-z0-9-]{0,31}$` 且不重复，标记该 worker 擅长的领域，只用于 `resolve --tag`（见下文）。标签集合由配置维护，技能规则不写死标签名。
- **prefer_task**：owner 的可选布尔字段，缺省按 `true`，`show` 输出带生效值；规则见 SKILL.md 的“Task 契约”。
- **未知字段**：所有对象禁止多余字段，顶层只额外允许 `$schema`。
- **effort**：schema 只要求非空字符串，合法取值由脚本按引擎 kind 校验，是引擎原生语义，不做跨引擎统一：claude `low|medium|high|xhigh|max`；codex `minimal|low|medium|high|xhigh|max`；grok `none|minimal|low|medium|high|xhigh|max`；qodercli `auto|none|low|medium|high|xhigh|max|ultracode`；opencode 的 effort 对应 `--variant`，是 provider 与模型相关的值（如 `opencode/glm-5.3-flash-free` 为 `low|high|max`），不在常量表内、按任意非空字符串处理，以 `opencode models <provider> --verbose` 输出的 variants 为准。
- **语义校验**：引用必须存在；enabled owner 的引擎必须 enabled 且 `native_subagents: true`；`workers` 中每个 id 存在，enabled owner 至少有一个 enabled、引擎 enabled 的 class `worker` 子 agent；每个引擎至多一个 enabled owner（宿主据此识别自己的 owner）；class `worker` 的引擎 kind 必须有 interactive 构建器或可作为 native（claude、codex、grok），class `task` 的引擎 kind 必须有 oneshot 构建器，因此 opencode 只能是 class `task`，qodercli 两者皆可；`native_subagents: true` 只允许 claude、codex、grok（opencode、qodercli 不可为 true）。

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
- **herdr oneshot**：`mode: oneshot`、`kind`、`argv`、`task_file_placeholder: "{task_file}"`；claude 与 codex 的任务文件经 stdin 传入（输出带 `stdin: "{task_file}"`），grok、opencode 与 qodercli 以参数传入文件（无 stdin）。
- **`--peer`**：`resolve --owner <self> --peer <owner-id>` 输出协作 owner 的 herdr interactive argv，用法见 [协作协议](peer-protocol.md#启动协作-owner)。
- **拒绝**：owner 或 worker 不存在、disabled、所属引擎 disabled、被 block 时非零退出。`--worker` 显式指定的子 agent 不在该 owner 的 `workers` 列表中也允许，但输出 `warnings`。输出中的子 agent 字段为 `worker`，`status` 输出 `workers`，`skipped[]` 的条目用 `worker` 标识。
- **`--class worker|task`**：按 `workers` 顺序选第一个可用的该 class 子 agent；都不可用时非零退出，列出每个候选的不可用原因。额度耗尽后的自动切换就靠它。`skipped` 记录被跳过的不可用候选。
- **`--tag <tag>`**：只能与 `--class` 同用。按 `workers` 顺序先取第一个可用且带该标签的候选；没有时按原顺序回退，并在 `warnings` 写明“无可用的 <tag> 标签候选，已按顺序回退”。带标签的候选被 block 或 disabled 时同样被跳过，记入 `skipped`。

各 kind 的 argv（以 `resolve` 输出为准，此处仅供对照）：

| kind | interactive（`--` 之后） | oneshot |
| --- | --- | --- |
| claude | `--model <m> --effort <e> --permission-mode bypassPermissions` | `claude -p --model <m> --effort <e> --permission-mode bypassPermissions`，任务文件经 stdin |
| codex | `-m <m> -c model_reasoning_effort=<e> --dangerously-bypass-approvals-and-sandbox` | `codex exec -m <m> -c model_reasoning_effort=<e> --dangerously-bypass-approvals-and-sandbox -`，任务文件经 stdin |
| grok | `-m <m> --effort <e> --permission-mode bypassPermissions` | `grok --prompt-file {task_file} -m <m> --effort <e> --permission-mode bypassPermissions --output-format json` |
| qodercli | `-m <m> --reasoning-effort <e> --permission-mode bypass_permissions` | `qodercli -p "执行附件中的任务说明，结果按任务文件要求回报" -m <m> --reasoning-effort <e> --permission-mode bypass_permissions --output-format json --no-session-persistence --attachment {task_file}` |
| opencode | 不支持 | `opencode run "执行附件中的任务说明，结果按任务文件要求回报" -m <m> --variant <e> --format json --auto -f {task_file}` |

其他 kind 报“不支持构建启动参数”。

**免审批**：所有 herdr 启动的异构 agent 都在 argv 中显式免审批（claude、grok `--permission-mode bypassPermissions`，codex `--dangerously-bypass-approvals-and-sandbox`，qodercli `--permission-mode bypass_permissions`，opencode 仅 oneshot 用 `--auto`），不依赖用户全局配置；原生子 agent 沿用 owner 会话的权限模式，不由本配置控制。免审批意味着写入范围只靠交接或任务文件约束，由 owner 验收 diff 保证。

qodercli 的约束：prompt 是位置参数，必须放在 `--attachment` 之前；`effort` 取上表值，免费模型 `Qwen3.8-Flash` 默认 `xhigh`。

opencode 的约束：

- **只支持 oneshot**：TUI 不接受 `--variant`，无法保证 effort，所以 opencode 只能是 class `task`，配成 class `worker` 校验报错。
- **argv 顺序**：消息是位置参数，必须放在 `-f` 之前；`-f` 是数组参数，会吞掉其后的位置参数。argv 以 `resolve` 输出为准，不手工调整顺序。
- **环境**：opencode 装在 `~/.opencode/bin`，依赖 zsh 的 PATH；herdr pane 内可用，直接在非 zsh 的 shell 里可能找不到命令。
- **权限**：`--auto` 自动批准权限，写入范围只靠任务文件约束，因此 owner 必须在验收时查 diff，发现越界按 task 契约改派 worker。

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

同时满足以下四条才可交给 task agent：不含设计决策、写入范围是明确的文件清单（只读则为空）、结果可由一条命令或明确检查项验证、不需要续接上下文且一次执行完成。典型：按既定规则批量改名、改文案、改配置，跑测试并汇总，只读检索与清点。不满足任一条，或执行中发现需要判断时，task agent 停止回报，由 owner 改派 worker。`prefer_task` 为 `true`（缺省）时满足契约的包必须先 `resolve --class task`，规则见 SKILL.md 的“Task 契约”。

### 免费或低成本模型的使用

免费或低成本模型（默认配置中的 `opencode_worker`，`opencode/glm-5.3-flash-free`）通过两处配置着重调用，不新增规则：

- owner 保持 `prefer_task: true`，满足契约的包先走 `--class task`；
- 把该 task worker 放在 `owners.<id>.workers` 中 task 类的第一位（默认配置里 task 类只有它一个）。

免费 worker（`qoder_worker`，class `worker`，tag `routine`）则靠 SKILL.md 的 `--class worker --tag routine` 规则优先承接方案已冻结、范围明确的常规实现包；它在 `workers` 里紧随原生 worker，`--tag routine` 才能越过顺序命中它。

免费期结束或限流时，用 `block --engine opencode [--model <m>]` 暂停，或调整 `workers` 顺序、把它设为 `enabled: false`；规则本身不改，`resolve --class task` 会自动落到下一个可用的 task worker，没有时退回 worker（见 SKILL.md）。

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

示例：启用 opencode 作为 task worker（默认配置中已有 `opencode` 与 `opencode_worker` 的 disabled 示例），并放在 task 类第一位：

```jsonc
{
  "engines": { "opencode": { "enabled": true, "kind": "opencode", "native_subagents": false } },
  "workers": {
    "opencode_worker": {
      "enabled": true, "engine": "opencode", "class": "task",
      "model": "opencode/glm-5.3-flash-free", "effort": "max",
      "tags": ["mechanical", "test", "lint", "sweep"],
      "description": "免费模型，着重用于机械化 task：跑测试汇总、lint 修复、批量修改、只读清点"
    }
  },
  "owners": { "claude_owner": { "workers": ["claude_worker", "codex_worker", "opencode_worker"] } }
}
```

模型取自已安装的 opencode，`effort` 取该模型 variants 之一；`validate` 只校验结构与引用，不探测模型是否真实存在。
