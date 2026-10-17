# 调度配置说明

SKILL.md 的“调度配置”写规则，本文写字段、派发推导、herdr worker 生命周期、额度 block 细节和配置流程。脚本为 `<skill>/scripts/agents-config.ts`（bun，无第三方依赖），输出 JSON 到 stdout，错误逐条列出 JSON 路径并非零退出。

## 位置与来源

- 配置：`~/.config/agents-cooperation/config.json`；`AGENTS_COOPERATION_CONFIG` 或脚本 `--config <path>` 覆盖。不存在时使用 `<skill>/assets/config.default.json`。不做多层合并。
- 默认配置是唯一默认来源，也是用户复制的起点，按模型特点初始化：
  - 引擎：claude、codex 为 enabled 且 native；grok、opencode（`kind: opencode`）与 qoder（`kind: qodercli`）为 `enabled: false` 的示例。
  - owner：`claude_owner`（claude-opus-5-5，high）、`codex_owner`（gpt-6-astra，high）为 enabled，`max_parallel` 4。`workers` 顺序：`claude_owner` 为 `claude_worker`、`qoder_worker`、`opencode_worker`、`codex_worker`、`grok_worker`；`codex_owner` 为 `codex_worker`、`qoder_worker`、`opencode_worker`、`claude_worker`、`grok_worker`。grok 不当 owner（`native_subagents` 为 false），只作 herdr worker。即本引擎的原生 worker 第一位，免费 worker 紧随其后。
  - worker：`claude_worker`（claude / sonnet / high，tags `frontend` `ui` `browser` `docs`）、`codex_worker`（codex / gpt-6.1-sol / high，tags `backend` `algorithm` `test` `refactor`）为 enabled；`grok_worker`（grok / grok-4.7 / high，tags `research`）、`qoder_worker`（qoder / `Qwen3.8-Flash` / xhigh，tags `routine` `test` `lint` `scaffold`，免费模型，用于方案已冻结且范围明确的常规实现）与 `opencode_worker`（opencode / `opencode/glm-5.3-flash-free` / max，tags `mechanical` `test` `lint` `sweep`，免费模型，用于机械性包）为 `enabled: false`。
  - 用户配置按需启用：启用 `opencode`、`qoder` 引擎与 `opencode_worker`、`qoder_worker`；启用 `grok` 引擎与 `grok_worker` 后，它作为 herdr worker 使用。
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
      "native_subagents": true       // 仅 kind 为 claude、codex 时可为 true
    }
  },
  "owners": {
    "<owner-id>": {
      "enabled": true,
      "engine": "<engine-id>",       // 该引擎必须 native_subagents=true
      "model": "claude-opus-5-5",
      "effort": "high",
      "workers": ["<worker-id>"],    // 必填、非空、无重复，按优先级排序
      "max_parallel": 4              // 必填，≥1，该 owner 同时运行的子 agent 上限
    }
  },
  "workers": {
    "<worker-id>": {                 // key 必须以 _worker 结尾
      "enabled": true,
      "engine": "<engine-id>",
      "model": "sonnet",
      "effort": "high",
      "tags": ["frontend"],          // 可选，按领域选择用，见下文“tags”
      "description": "可选，适用场景说明"
    }
  }
}
```

- **命名**：engine、owner、worker 的 id 匹配 `^[a-z][a-z0-9_]{0,39}$`；`workers` 下所有 key 以 `_worker` 结尾。默认命名：引擎 `claude` `codex` `grok` `opencode` `qoder`，owner `claude_owner` `codex_owner`，worker `claude_worker` `codex_worker` `grok_worker` `opencode_worker` `qoder_worker`。顶层字段是 `workers`，不接受旧字段 `agents`（报未知字段）。
- **tags**：可选，字符串数组，每项匹配 `^[a-z][a-z0-9-]{0,31}$` 且不重复，标记该 worker 擅长的领域，只用于 `resolve --tag`（见下文）。标签集合由配置维护，技能规则不写死标签名。
- **未知字段**：所有对象禁止多余字段，顶层只额外允许 `$schema`；旧配置中残留的 worker 分类字段和 owner 任务优先字段同样报未知字段。
- **effort**：schema 只要求非空字符串，合法取值由脚本按引擎 kind 校验，是引擎原生语义，不做跨引擎统一：claude `low|medium|high|xhigh|max`；codex `minimal|low|medium|high|xhigh|max`；grok `none|minimal|low|medium|high|xhigh|max`；qodercli `auto|none|low|medium|high|xhigh|max|ultracode`；opencode 的 effort 对应模型的 variant，是 provider 与模型相关的值（如 `opencode/glm-5.3-flash-free` 为 `low|high|max`），不在常量表内、按任意非空字符串处理，以 `opencode models <provider> --verbose` 输出的 variants 为准；TUI 不能按次指定 variant，实际取值见下文“opencode 的约束”。
- **语义校验**：引用必须存在；每个 owner（不论 enabled）的引擎都必须 `native_subagents: true`，enabled owner 的引擎还必须 enabled；`workers` 中每个 id 存在，enabled owner 至少有一个 enabled、引擎 enabled 的 worker；每个引擎至多一个 enabled owner（宿主据此识别自己的 owner）；每个 worker 的引擎 kind 必须有 interactive 构建器或属于 native kind（claude、codex），grok、opencode 与 qodercli 都有 interactive 构建器；`native_subagents: true` 只允许 claude、codex（grok、opencode、qodercli 不可为 true）。

## 派发方式推导

调度方式不入配置，由 owner 与子 agent 的引擎关系推导：

| 条件 | 方式 |
| --- | --- |
| worker 引擎 == owner 引擎 | `native` |
| worker 引擎 != owner 引擎 | `herdr` interactive |

`resolve` 的输出：

- **native + claude**：`tool: Agent`，`params` 含 `model`、`effort`、`subagent_type: general-purpose`。只读类型可替换 `subagent_type`，`model` 与 `effort` 保持不变；不用 `fork`。
- **native + codex**：`tool: spawn_agent`，`params` 含 `model`、`reasoning_effort`、`fork_turns: "none"`。
- **herdr interactive**：`mode: interactive`、`kind`、`argv`；argv 是 `herdr agent start <name> --kind <kind> --pane <pane> -- <argv>` 中 `--` 之后的部分。
- **`--peer`**：`resolve --owner <self> --peer <owner-id>` 输出协作 owner 的 herdr interactive argv，用法见 [协作协议](peer-protocol.md#启动协作-owner)。
- **拒绝**：owner 或 worker 不存在、disabled、所属引擎 disabled、被 block 时非零退出。`--worker` 显式指定的子 agent 不在该 owner 的 `workers` 列表中也允许，但输出 `warnings`。输出中的子 agent 字段为 `worker`，`status` 输出 `workers`，`skipped[]` 的条目用 `worker` 标识。
- **`--owner <id> [--tag <tag>]`**：按 `workers` 顺序选第一个可用的 worker，输出 `selected_by: "order"`，`skipped` 记录被跳过的不可用候选；都不可用时非零退出，列出每个候选的不可用原因。额度耗尽后的自动切换就靠它。
- **`--tag <tag>`**：按 `workers` 顺序先取第一个可用且带该标签的候选，输出 `selected_by: "tag"`；没有时按原顺序回退，`selected_by` 为 `"order"`，并在 `warnings` 写明“无可用的 <tag> 标签候选，已按顺序回退”。带标签的候选被 block 或 disabled 时同样被跳过，记入 `skipped`。

各 kind 的 argv（以 `resolve` 输出为准，此处仅供对照）：

| kind | argv（`--` 之后） |
| --- | --- |
| claude | `--model <m> --effort <e> --permission-mode bypassPermissions` |
| codex | `-m <m> -c model_reasoning_effort=<e> --dangerously-bypass-approvals-and-sandbox` |
| grok | `-m <m> --effort <e> --permission-mode bypassPermissions` |
| qodercli | `-m <m> --reasoning-effort <e> --permission-mode bypass_permissions` |
| opencode | `-m <m> --auto`（variant 不在 argv，见下） |

其他 kind 报“不支持构建启动参数”。

**免审批**：所有 herdr 启动的异构 agent 都在 argv 中显式免审批（claude、grok `--permission-mode bypassPermissions`，codex `--dangerously-bypass-approvals-and-sandbox`，qodercli `--permission-mode bypass_permissions`，opencode `--auto`），不依赖用户全局配置；原生子 agent 沿用 owner 会话的权限模式，不由本配置控制。免审批意味着写入范围只靠交接文件约束，由 owner 验收 diff 保证。

qodercli 的约束：`effort` 取 effort 校验中的值，免费模型 `Qwen3.8-Flash` 默认 `xhigh`；信任范围之外的目录会弹信任提示且状态报 idle，见下文“Herdr 派发流程”的信任提示表。

opencode 的约束：

- **variant 不在 argv**：TUI 不支持按次设置 variant，使用 `~/.local/state/opencode/model.json` 中 `variant["<provider/model>"]` 记忆的值（如 `opencode/glm-5.3-flash-free` 实测为 `max`，状态栏显示 `· max`）；配置里的 effort 必须与它一致。`resolve` 读取该文件（路径基于环境变量 `HOME`，缺省取用户主目录）：一致时无 warning；记忆值与配置 effort 不一致或缺失时输出 `warnings`，含实际记忆值与修正方式；文件不可读时 `warnings` 为“无法核实 variant”。修正方式是在 opencode TUI 中对该模型切换一次 variant，使记忆值写入。派发后仍以 pane 状态栏显示的 variant 为准。
- **不用 `opencode run -i`**：它必须带消息且回复后退出，不是可多轮的常驻交互。
- **环境**：opencode 装在 `~/.opencode/bin`，依赖 zsh 的 PATH；herdr pane 内可用，直接在非 zsh 的 shell 里可能找不到命令。
- **权限**：`--auto` 自动批准权限，写入范围只靠交接文件约束，因此 owner 必须在验收时查 diff，发现越界按 SKILL.md 的交接规则打回修复或改派。

## Herdr 派发流程

herdr worker 指引擎与 owner 不同、经 Herdr pane 启动的 worker。每个 herdr worker 独占一个 lane（tab+pane），按以下生命周期执行；tab 命名、归属校验和清理规则以 `herdr` 技能为准，owner 协作的 lane 同样适用，见 [协作协议](peer-protocol.md#启动协作-owner)。

1. **新建 lane**：每个 worker 用独立 tab+pane，返回 pane ID 和 `cleanup_command`，记入台账。

   ```sh
   bun <herdr-skill>/scripts/route-lane.ts --type coding-agent --cwd <项目路径> --label 'MMDD｜TYPE｜Topic'
   ```
2. **启动**：`resolve --owner <owner-id> [--worker <id> | --tag <tag>]` 取 argv，`--` 之后原样使用。`<name>` 在本任务内唯一，同一 worker 并行多个时加序号（如 `qoder_worker-2`）。

   ```sh
   herdr agent start <name> --kind <kind> --pane <pane> -- <argv>
   ```
3. **信任提示**：各 CLI 对新目录的信任提示不同（实测见下表），都无法用启动参数跳过。只信任用户指定的目标项目目录，来源不明的仓库停下来问用户。启动后先用 `herdr agent read <name> --source visible` 读屏确认，再发 prompt；不是信任提示的 blocked 按读屏内容判断，不要盲目按键。

   | CLI | 新目录是否弹提示 | 默认选项与处理 | herdr 状态 |
   | --- | --- | --- | --- |
   | claude | 都弹（“Quick safety check … trust”），不按前缀继承 | 默认 No, exit：`send-keys <name> down`，读屏确认选中 `Yes, I trust this folder` 后再 `enter` | blocked（`agent start` 返回 `agent_not_ready`） |
   | codex | 都弹（“Trust this folder?”），不按前缀继承 | 默认 Trust and continue：`send-keys <name> enter` | blocked（同上） |
   | qodercli | 按 `~/.qoder/settings.json` 的 `permissions.trustDirectories` 前缀继承：已信任目录（本机含 `/home/mocha`，其下项目与默认位于 `~/.local/share/cow-workspace` 的视图）不弹，`/tmp` 等范围之外弹 “Trust folder” | 默认 Trust：读屏确认后 `send-keys <name> enter`；`--dangerously-skip-permissions` 与 `--permission-mode bypass_permissions` 都跳不过 | **idle**：`agent start` 看起来成功，直接发 prompt 会进信任对话框，必须读屏，不能只看状态 |
   | grok | 不弹 | 直接就绪；状态栏显示模型与 effort（如 `Grok 4.7 (low) · always-approve`），与 `resolve` 对照 | 就绪 |
   | opencode | 不弹（实测 `/tmp`） | 读屏确认模型和 variant（如 `· max`），与 `resolve` 的 `warnings` 对照 | 就绪 |

   其他 CLI 以读屏为准。Claude 与 Codex 作为协作 owner 启动时同样按此表，见 [协作协议](peer-protocol.md#启动协作-owner)。
4. **发送信封**：任务内容写成消息目录下的任务文件，prompt 只带任务文件和回复文件路径，格式沿用协作协议的信封风格；worker 守则同 SKILL.md 的“子 agent 交接”。

   ```text
   [agents-cooperation]
   from: owner (claude_owner claude-opus-5-5)
   to: worker (qoder_worker Qwen3.8-Flash)
   project: <项目路径>
   read: ~/.local/state/agents-cooperation/<collab-id>/004-claude-task.md
   reply: ~/.local/state/agents-cooperation/<collab-id>/005-qoder-reply.md
   你是 worker：按 agents-cooperation worker 职责处理，回复写入 reply 文件后结束本轮；不提交，不再派发。
   ```
5. **等待**：`herdr agent prompt <name> "<信封>" --wait --until idle --until done --until blocked --timeout <ms>`；owner 还要继续其他工作时，改用宿主后台任务运行 `herdr agent wait <name> --until idle --until done --until blocked`。超时或 blocked 先读输出判断原因，不盲目重发。
6. **验收**：owner 读回复文件，查看 diff 并复跑关键验证；回复文件缺失时用 `herdr agent read <name> --source recent` 查看原因。结果越界、需要判断或失败时，把 findings 交回同一 worker（多轮）或改派，不自己打补丁。
7. **关闭 lane**：一次性包验收通过（或失败且已核对部分产物）后，立即执行 `route-lane` 返回的 `cleanup_command` 关闭 lane，不留空闲 pane。需要多轮的包保留 lane 到该包结束再关。只关本任务创建的 lane，不关用户自己的 pane 或归属不明的资源。

`max_parallel` 计数包含 native 与 herdr worker。

## 并行上限

只有 owner 级一层：`owners.<id>.max_parallel` 必填，≥1，是该 owner 同时运行的子 agent（native 与 herdr worker 合计）上限。owner 按自己台账中“运行中”的条目计数，达到上限时新包标“待派发”，不突破。

不设全局或引擎级上限：各 owner 观测不到对方的子 agent，无法准确计数。额度和速率压力由下面的 block 机制处理。

## 免费或低成本模型的使用

免费或低成本 worker 靠 `tags` 与 `workers` 顺序着重调用，不设专用字段，规则全部在 SKILL.md 的“免费 worker 优先”：

- `opencode_worker`（`opencode/glm-5.3-flash-free`）带 `mechanical` 等标签，承接满足机械性判定的包，owner 用 `--tag mechanical` 派发；
- `qoder_worker`（`Qwen3.8-Flash`）带 `routine` 等标签，承接方案已冻结、范围明确、不含设计判断的常规实现，owner 用 `--tag routine` 派发；
- 二者在 `workers` 里紧随本引擎的原生 worker，不带 `--tag` 时仍取第一个（同引擎 native），带标签才越过顺序命中它们。

免费期结束或限流时，用 `block --engine opencode [--model <m>]` 暂停，或调整 `workers` 顺序、把它设为 `enabled: false`；规则本身不改，`resolve --tag` 会自动落到下一个可用的带标签 worker，没有时按顺序回退并给出 `warnings`。

## 额度耗尽 block 与自动解封

运行状态与配置分离，不写入 `config.json`。状态文件：`~/.local/state/agents-cooperation/availability.json`（`AGENTS_COOPERATION_STATE` 或 `--state <path>` 覆盖），由脚本原子写入（临时文件加 rename），文件不存在视为无 block。结构由 `<skill>/assets/availability.schema.json` 定义，脚本读取时校验，结构非法或同一 (engine, model) 重复都会报错。owner 不手工编辑，只用下面的命令：

```json
{ "version": 1, "blocks": [
  { "engine": "codex", "model": "gpt-6-astra", "reason": "usage limit",
    "since": "2026-10-16T22:00:00-04:00", "release_at": "2026-10-17T03:00:00-04:00", "by": "claude_owner" }
] }
```

- `model` 省略 = 整个引擎（账户级额度）；有值 = 该引擎下使用该 model 的 owner 与子 agent。`release_at` 省略 = 没有解封时间，直到手动 `unblock`。同一 (engine, model) 只保留一条，再次 `block` 覆盖。条目存在即表示 blocked。
- **release_at 取值**：`--release-at` 取自报错里的恢复时间，格式为 ISO 8601 含时区，或 `+<n>m|h|d`（n ≥ 1，从 block 时刻起算）。不传则不写 `release_at`，不自动解封，直到手动 `unblock`。配置里没有默认冷却时长字段，`block_ttl` 等多余字段报未知字段。
- **到期自动解封**：所有命令读取状态时，`release_at` 已过的条目视为失效；`block` / `unblock` 写入时顺带清除过期条目。不需要常驻进程。

命令：

| 命令 | 作用 |
| --- | --- |
| `block --engine <id> [--model <m>] [--release-at <ISO8601 \| +<n>m \| +<n>h \| +<n>d>] --reason <text> [--by <owner-id>]` | 写入 block，engine 必须存在于配置；输出写入后的条目 |
| `unblock --engine <id> [--model <m>]` | 删除精确匹配的条目，输出删除数量 |
| `status` | 当前有效的 block 列表，以及每个 owner 和子 agent 的可用性 |

可用性判定（`resolve`、`show`、`status` 共用）依次为：`disabled`（自身 enabled=false）→ `engine_disabled` → `blocked`（引擎级或 engine+model 级，附 `release_at` 和 `reason`）→ `available`；`show` 输出中每个 owner 和子 agent 都带 `availability`。

传播：

- owner 被 block 时，以它为发起方的 `resolve --owner` 一律拒绝，它的原生子 agent 随之不可派发；同引擎但不同 model 且未被 block 的子 agent，仍可被其他 owner 经 herdr 使用。
- 引擎级 block 则该引擎上的 owner 与子 agent 全部不可用。

owner 的处置步骤见 SKILL.md 的“额度耗尽”：识别信号、`block`（能解析出重置时间就写 `--release-at`；报错只针对某个模型时带 `--model`）、`resolve --owner <owner-id> [--tag <tag>]` 重选、整包改派并写台账。协作 owner 被 block 时降级为单 owner。

## 修改配置

1. 编辑 `~/.config/agents-cooperation/config.json`。没有就从 `assets/config.default.json` 复制，并把 `$schema` 改成技能安装目录下 `assets/config.schema.json` 的绝对路径；默认配置里的相对路径 `./config.schema.json` 只在技能目录内有效。
2. `bun <skill>/scripts/agents-config.ts validate`，按错误里的 JSON 路径逐条修正，直到输出 `ok: true`。
3. `show` 确认 owner、`workers` 顺序、`availability` 和并行上限符合预期。
4. 不要为了绕过校验放宽 schema；新增引擎 kind 或 effort 取值先改 schema 与脚本常量表。

示例：启用 opencode 作为机械性包的 worker（默认配置中已有 `opencode` 与 `opencode_worker` 的 disabled 示例）：

```jsonc
{
  "engines": { "opencode": { "enabled": true, "kind": "opencode", "native_subagents": false } },
  "workers": {
    "opencode_worker": {
      "enabled": true, "engine": "opencode",
      "model": "opencode/glm-5.3-flash-free", "effort": "max",
      "tags": ["mechanical", "test", "lint", "sweep"],
      "description": "免费模型，着重用于机械性包：跑测试汇总、lint 修复、批量修改、只读清点"
    }
  },
  "owners": { "claude_owner": { "workers": ["claude_worker", "codex_worker", "opencode_worker"] } }
}
```

模型取自已安装的 opencode，`effort` 取该模型 variants 之一，并要与 opencode TUI 记忆的 variant 一致（否则 `resolve` 给出 `warnings`）；`validate` 只校验结构与引用，不探测模型是否真实存在。
