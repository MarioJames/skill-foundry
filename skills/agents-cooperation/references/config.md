# 调度配置说明

SKILL.md 的“调度配置”写规则，本文写字段、派发推导、herdr worker 生命周期、运行状态库、额度 block 细节和配置流程。脚本有两个：`<skill>/scripts/agents-config.ts`（配置校验、派发推导、block）和 `<skill>/scripts/agents-runtime.ts`（herdr run/lane 登记与回收），均为 bun、无第三方依赖，输出 JSON 到 stdout，错误非零退出（`agents-config.ts` 的配置错误逐条列出 JSON 路径）。

## 位置与来源

- 配置：`~/.config/agents-cooperation/config.json`；`AGENTS_COOPERATION_CONFIG` 或脚本 `--config <path>` 覆盖。不存在时使用 `<skill>/assets/config.default.json`。不做多层合并。
- 默认配置是唯一默认来源，也是用户复制的起点；引擎、owner、worker、模型、effort、`workers` 顺序和 tags 的默认值都以 `<skill>/assets/config.default.json` 为准，本文不复述。
- 结构由 `<skill>/assets/config.schema.json`（JSON Schema draft 2020-12）定义，配置用 `"$schema"` 指向它；校验器直接读取 schema，字段表不在脚本里重复。

## 字段

```jsonc
{
  "$schema": "...",
  "version": 1,
  "chatgpt_review": true,           // 可选布尔；缺省等同 true。false 关闭本技能自动 Pro 审查
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
      "model": "<model-id>",
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
      "tags": ["frontend"],          // 可选，领域标签或类别保留标签，见下文“tags”
      "description": "可选，适用场景说明"
    }
  },
  "herdr": {                         // 必填
    "max_wait_minutes": 15           // ≥1，herdr agent 单次等待上限（分钟）
  }
}
```

- **命名**：engine、owner、worker 的 id 匹配 `^[a-z][a-z0-9_]{0,39}$`；`workers` 下所有 key 以 `_worker` 结尾。顶层字段是 `workers`，不接受旧字段 `agents`（报未知字段）。
- **herdr**：必填对象，`max_wait_minutes` 必填且不接受多余字段，是 ≥1 的整数，是 herdr agent 单次等待的上限，也是 `gc` 判定 lane 无进展的阈值基准（见“运行状态库”）；默认值以 `<skill>/assets/config.default.json` 为准，本文不复述。herdr worker 的 hidden session 不入配置：每个 run 由 `agents-runtime` 分配独立 session；旧配置里残留的共享 session 字段按未知字段处理，`validate` 报错并说明改法。
- **chatgpt_review**：顶层可选布尔，不是必填，没有别名，不与其他层合并，也不迁移旧字段。缺省等同开启；`assets/config.default.json` 显式为 `true`。只有布尔 `false` 关闭本技能的自动 ChatGPT 方案审查和实现结果复审及其等待门槛；owner 讨论、本地 review 和测试照常。非布尔由 schema 拒绝，不把字符串 `"false"` 当成关闭。`show` 的 `config.chatgpt_review` 与每次 `resolve` 的顶层 `chatgpt_review` 都是有效布尔。这是用户持久偏好，不是 owner 自行降级。开启时必审/免审规则照常；用户当轮明确要求调用 ChatGPT 时仍按该指令执行。执行细则见 SKILL.md。
- **tags**：可选，字符串数组，每项匹配 `^[a-z][a-z0-9-]{0,31}$` 且不重复。`mechanical`、`routine` 是类别保留标签，带其中之一的 worker 是免费 worker，由 `resolve --class mechanical|routine` 选取；其余标签是领域标签，按模型强项标注，只用于 `resolve --class judgment --tag` 选异构 worker（引擎与 owner 不同）；owner 本引擎的原生 worker 是 judgment 的隐式默认，选它时不看标签（见下文）。领域标签集合由配置维护，技能规则不写死。
- **未知字段**：所有对象禁止多余字段，顶层已知字段另含可选 `chatgpt_review`，并额外允许 `$schema`；旧配置中残留的 worker 分类字段和 owner 任务优先字段同样报未知字段。
- **effort**：schema 只要求非空字符串，合法取值由脚本按引擎 kind 校验，是引擎原生语义，不做跨引擎统一：claude `low|medium|high|xhigh|max`；codex `low|medium|high|xhigh|max`；grok `none|minimal|low|medium|high|xhigh|max`；qodercli `auto|none|low|medium|high|xhigh|max|ultracode`；opencode 的 effort 对应模型的 variant，是 provider 与模型相关的值（如 `opencode/glm-5.3-flash-free` 为 `low|high|max`），不在常量表内、按任意非空字符串处理，以 `opencode models <provider> --verbose` 输出的 variants 为准；TUI 不能按次指定 variant，实际取值见下文“opencode 的约束”。
- **约束走配置**：调度约束一律通过配置表达（`workers` 列表、`enabled`、`tags`、`max_parallel`、block），脚本和技能规则不另设硬编码限制，例如 owner 能派哪些 worker 只由 `owners.<id>.workers` 决定。
- **语义校验**：引用必须存在；每个 owner（不论 enabled）的引擎都必须 `native_subagents: true`，enabled owner 的引擎还必须 enabled；`workers` 中每个 id 存在，enabled owner 至少有一个 enabled、引擎 enabled 的 worker；每个引擎至多一个 enabled owner（宿主据此识别自己的 owner）；每个 worker 的引擎 kind 必须有 interactive 构建器或属于 native kind（claude、codex），grok、opencode 与 qodercli 都有 interactive 构建器；`native_subagents: true` 只允许 claude、codex（grok、opencode、qodercli 不可为 true）；同一 worker 不能同时带 `mechanical` 和 `routine`；类别 worker 可以在任何引擎上，与 owner 同引擎时按派发方式推导走 native。

## 派发方式推导

调度方式不入配置，由 owner 与子 agent 的引擎关系推导：

| 条件 | 方式 |
| --- | --- |
| worker 引擎 == owner 引擎 | `native` |
| worker 引擎 != owner 引擎 | `herdr` interactive |

`resolve` 的输出：

- **native + claude**：`tool: Agent`，`params` 含 `model`、`effort`、`subagent_type: general-purpose`。只读类型可替换 `subagent_type`，`model` 与 `effort` 保持不变；不用 `fork`。
- **native + codex**：`tool: spawn_agent`，`params` 含 `model`、`reasoning_effort`、`fork_turns: "none"`。
- **herdr interactive**：`mode: interactive`、`kind`、`argv`、`wait_timeout_ms`；argv 是 `herdr agent start <name> --kind <kind> --pane <pane> -- <argv>` 中 `--` 之后的部分（hidden session 里的命令还要带 `--session <session_name>`，session 名取自 `run open` 的输出，见下文）。`wait_timeout_ms` 为 `herdr.max_wait_minutes` 换算的毫秒数；native 输出不含该字段。
- **`--peer`**：`resolve --owner <self> --peer <owner-id>` 输出协作 owner 的 herdr interactive argv（协作 owner 的 lane 建在主 session，不带 `--session`，也不进状态库），`wait_timeout_ms` 同上；用法见 [协作协议](peer-protocol.md#启动协作-owner)。
- **`chatgpt_review`**：每次 `resolve`（native、herdr、`--worker`、`--class`、`--peer`）都在顶层带有效布尔。没有字段时为 `true`，`false` 保持 `false`。不改变 worker 选择。owner 每次派发前读取它。
- **拒绝**：owner 或 worker 不存在、disabled、所属引擎 disabled、被 block 时非零退出。`--worker` 显式指定的子 agent 不在该 owner 的 `workers` 列表中也允许，但输出 `warnings`。输出中的子 agent 字段为 `worker`，`status` 输出 `workers`，`skipped[]` 的条目用 `worker` 标识。
- **`--owner <id> --class mechanical|routine|judgment [--tag <domain>]`**：按池选 worker，`--class` 必填，缺失时非零退出。输出含 `class`、`selected_by` 和 `skipped`（被跳过的不可用候选，按尝试顺序）；都不可用时非零退出，列出每个候选的不可用原因。额度耗尽后的自动切换就靠它。
  - `mechanical`：依次取可用的 mechanical worker、可用的 routine worker，`selected_by: "class"`；都没有时按 judgment 回退，`selected_by: "order"`，`warnings` 写明“无可用免费 worker，已按 judgment 回退”。
  - `routine`：取可用的 routine worker，`selected_by: "class"`；没有时同样按 judgment 回退并写 warning，不落到 mechanical worker。
  - `judgment`：候选池排除带 `mechanical` / `routine` 的 worker，不带 `--tag` 时按 `workers` 顺序取第一个可用的（默认即同引擎原生），`selected_by: "order"`。
  - `--tag <domain>`：只能和 `--class judgment` 一起用（与 `mechanical` / `routine` 同用报错；`--tag mechanical|routine` 报错，应改用 `--class`）。只在 owner 自己的 `workers` 里引擎与 owner 不同的异构候选中取第一个可用且带该标签的，`selected_by: "tag"`；没有命中就回落到同引擎原生 worker，`selected_by: "native"`：该标签只在原生 worker 上或没有带该标签的异构候选时不出 warning；有带该标签的异构候选但因 block 或 disabled 被跳过时，`warnings` 写明“带 <tag> 标签的异构候选不可用，已回落到本引擎原生 worker”；原生也不可用时按原顺序回退，`selected_by: "order"`，并在 `warnings` 写明“无可用的 <tag> 标签候选，已按顺序回退”。被 block 或 disabled 的候选同样被跳过，记入 `skipped`。
  - **`peer_suggestion`**：`--class judgment --tag` 回落到原生 worker（`selected_by: native`）时，若本 owner 的原生 worker 不带该标签，而另一个可用（未 disabled、未 block）的 enabled owner 引擎上有带该标签的非免费 worker（不要求在本 owner 的 `workers` 里；owner 能派哪些 worker 只由 `workers` 列表决定，脚本不限制），输出 `peer_suggestion: { owner, reason }`，`reason` 为“<tag> 是 <owner> 侧 worker 的强项，可经 assign 交给该 owner”，不算 `warnings`，不改变本次选择。原生 worker 自带该标签、对方 owner 被 block 或 disabled、或已被列表里的异构 worker 命中时不给。owner 收到建议后按协作协议 `type: assign` 交给对方，没有可用协作 owner 时留在本引擎原生 worker。
- **`--worker <id>`**：不要求 `--class`，输出 `selected_by: "worker"`，只用于用户指定 worker 或续接同一包；与 `--class`、`--tag`、`--peer` 同用报错；指定的 worker 不在该 owner 的 `workers` 列表中（含对方 owner 引擎的 worker）也可启动，只输出 `warnings`。

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

qodercli 的约束：`effort` 取 effort 校验中的值，信任范围之外的目录会弹信任提示且状态报 idle，见下文“Herdr 派发流程”的信任提示表。

opencode 的约束：

- **variant 不在 argv**：TUI 不支持按次设置 variant，使用 `~/.local/state/opencode/model.json` 中 `variant["<provider/model>"]` 记忆的值（如 `opencode/glm-5.3-flash-free` 实测为 `max`，状态栏显示 `· max`）；配置里的 effort 必须与它一致。`resolve` 读取该文件（路径基于环境变量 `HOME`，缺省取用户主目录）：一致时无 warning；记忆值与配置 effort 不一致或缺失时输出 `warnings`，含实际记忆值与修正方式；文件不可读时 `warnings` 为“无法核实 variant”。修正方式是在 opencode TUI 中对该模型切换一次 variant，使记忆值写入。派发后仍以 pane 状态栏显示的 variant 为准。
- **不用 `opencode run -i`**：它必须带消息且回复后退出，不是可多轮的常驻交互。
- **环境**：opencode 装在 `~/.opencode/bin`，依赖 zsh 的 PATH；herdr pane 内可用，直接在非 zsh 的 shell 里可能找不到命令。
- **权限**：`--auto` 自动批准权限，写入范围只靠交接文件约束，因此 owner 必须在验收时查 diff，发现越界按 SKILL.md 的交接规则打回修复或改派。

## Herdr 派发流程

herdr worker 指引擎与 owner 不同、经 Herdr pane 启动的 worker。每个 owner 任务实例对应一个 run，独占一个 hidden Herdr session（无 TUI，用户的主 session 不会被 worker 淹没，不同 owner 或任务的 session 互不可见）；每个 herdr worker 独占其中一个 lane（tab+pane）。run、lane 和 session 的创建、关闭与回收全部经 `agents-runtime`，owner 不直接调用 `route-lane`（首次用 `--create-session`，后续用 `--session <name> --require-running`，每次均带 `--op-tag`），也不执行 `cleanup_command` 关闭 hidden lane。`--require-running` 禁止按需启动替代 server；runtime 还会拒绝 `started:true` 回执，并在登记 lane 为 `open` 前再次核对原实例证明。通用 route 的普通 `--session` 仍可按需启动。tab 命名、归属校验规则以 `herdr` 技能为准；协作 owner 自己的 lane 仍由 `route-lane` 直接建在主 session，见 [协作协议](peer-protocol.md#启动协作-owner)。

runtime 目前只支持 `HOME/.config/herdr/sessions`：`XDG_CONFIG_HOME` 为空、未设置或经路径规范化后等于 `HOME/.config` 时可用；其他值在 Runtime 初始化时明确拒绝，覆盖打开、关闭、gc 与查询等入口，拒绝前不访问 Herdr 资源，也不改变已有 run/lane 登记。此限制避免在一个配置根创建、却从另一个配置根验证或回收。

在 hidden session 里，本流程所有 `herdr agent` 命令（`start`、`read`、`send-keys`、`prompt`、`wait`、`list`）都写成 `herdr --session <session_name> agent ...`，漏写会落到主 session。

`agents-runtime` 的子命令（公共选项 `--state <sqlite>`、`--config <json>`，成功输出 JSON，失败非零退出并在 stderr 给出原因）：

| 命令 | 作用 |
| --- | --- |
| `run open --owner <owner-id> --collab <collab-id> --request <request-id> --cwd <path> --label <text>` | 登记 run，预留 session 名（此时不创建 session）；输出 run 行，含 `run_id`、`session_name`。调用方身份见下文；同一 `--request` 在 owner、collab、规范化 cwd 和调用方身份一致且 run 未关闭时返回已有 run，参数不一致报冲突，已关闭的 run 不重新激活 |
| `lane open --run <run-id> --worker <worker-id> --class mechanical\|routine\|judgment --name <name> --op <op-id>` | 顺带 `gc`；在 run 的 session 中建独立 tab+pane（首个 lane 同时创建 session）；输出 lane 行，含 `lane_id`、`pane_id`，另有 `gc_reports`。同一 run 内相同 `--op` 且参数一致返回已有 lane，参数不一致报冲突。worker 必须是 herdr 派发且未被 block；不负责 `agent start` |
| `lane mark --lane <lane-id> [--outcome accepted\|failed] [--keep-reason <text>] [--progress]` | 至少给一项。`--keep-reason ''` 清除保留原因；`--progress` 刷新 `last_progress_at` 并把 `health` 置回 `ok`；不改 `status` |
| `lane close --lane <lane-id>` | 只关闭登记的 pane，并确认它已不存在；失败时 lane 保持 `closing` 并写 `last_error`，可重试 |
| `run close --run <run-id>` | 顺带 `gc`；关闭本 run 仍开着的 lane，核对库存为空后停止并删除 session，最后置 `closed` |
| `ls [--run <run-id>] [--all]` | 只读：比对库与 Herdr 实况；默认列出未关闭 run，`--all` 含已关闭 |
| `gc` | 回收，规则见“运行状态库” |

1. **开 run**：任务首次 herdr 派发前，对本任务运行一次 `run open`。`--owner` 是自己的 owner id，`--collab` 取任务的 collab id（无协作消息目录时按 `MMDD-<topic-slug>` 取一个），`--request` 取任务内稳定的值，`--label` 是 `MMDD｜TYPE｜Topic`。记下输出的 `run_id` 和 `session_name`。
2. **新建 lane**：每个 worker 一个 lane。`--worker` 与 `--class` 来自 `resolve` 的结果，`--name` 是随后 `agent start` 用的 agent 名，在本 run 内唯一，同一 worker 并行多个时加序号（如 `qoder_worker-2`）；`--op` 在本 run 内唯一，重试同一次开 lane 时沿用同一值。结果不明的 lane 记为 `unknown`，只报告，不按标签认领。
3. **启动**：`resolve --owner <owner-id> --class <类别> [--tag <领域>]`（续接同一包或用户指定 worker 时用 `--worker <id>`）取 argv，`--` 之后原样使用。

   ```sh
   herdr --session <session_name> agent start <name> --kind <kind> --pane <pane_id> -- <argv>
   ```
4. **信任提示**：各 CLI 对新目录的信任提示不同（实测见下表），都无法用启动参数跳过。只信任用户指定的目标项目目录，来源不明的仓库停下来问用户。启动后先用 `herdr --session <session_name> agent read <name> --source visible` 读屏确认，再发 prompt；不是信任提示的 blocked 按读屏内容判断，不要盲目按键。

   | CLI | 新目录是否弹提示 | 默认选项与处理 | herdr 状态 |
   | --- | --- | --- | --- |
   | claude | 都弹（“Quick safety check … trust”），不按前缀继承 | 默认 No, exit：`send-keys <name> down`，读屏确认选中 `Yes, I trust this folder` 后再 `enter` | blocked（`agent start` 返回 `agent_not_ready`） |
   | codex | 都弹（“Trust this folder?”），不按前缀继承 | 默认 Trust and continue：`send-keys <name> enter` | blocked（同上） |
   | qodercli | 按 `~/.qoder/settings.json` 的 `permissions.trustDirectories` 前缀继承：已信任目录（本机含 `/home/mocha`，其下项目与默认位于 `~/.local/share/worktrees` 的 worktree）不弹，`/tmp` 等范围之外弹 “Trust folder” | 默认 Trust：读屏确认后 `send-keys <name> enter`；`--dangerously-skip-permissions` 与 `--permission-mode bypass_permissions` 都跳不过 | **idle**：`agent start` 看起来成功，直接发 prompt 会进信任对话框，必须读屏，不能只看状态 |
   | grok | 不弹 | 直接就绪；状态栏显示模型与 effort（如 `Grok 4.7 (low) · always-approve`），与 `resolve` 对照 | 就绪 |
   | opencode | 不弹（实测 `/tmp`） | 读屏确认模型和 variant（如 `· max`），与 `resolve` 的 `warnings` 对照 | 就绪 |

   其他 CLI 以读屏为准。Claude 与 Codex 作为协作 owner 启动时同样按此表，见 [协作协议](peer-protocol.md#启动协作-owner)。
5. **发送信封**：任务内容写成消息目录下的任务文件，prompt 只带任务文件和回复文件路径，格式沿用协作协议的信封风格；worker 守则同 SKILL.md 的“子 agent 交接”。

   ```text
   [agents-cooperation]
   from: owner (<owner-id> <model>)
   to: worker (<worker-id> <model>)
   project: <项目路径>
   read: ~/.local/state/agents-cooperation/<collab-id>/004-<owner>-task.md
   reply: ~/.local/state/agents-cooperation/<collab-id>/005-<worker>-reply.md
   你是 worker：按 agents-cooperation worker 职责处理，回复写入 reply 文件后结束本轮；不提交，不再派发。
   ```
6. **等待**：`herdr --session <session_name> agent prompt <name> "<信封>" --wait --until idle --until done --until blocked --timeout <wait_timeout_ms>`；owner 还要继续其他工作时，改用宿主后台任务运行 `herdr --session <session_name> agent wait <name> --until idle --until done --until blocked --timeout <wait_timeout_ms>`。`--timeout` 取 `resolve` 输出的 `wait_timeout_ms`，所有 `--wait` 与 `agent wait` 都必须带，不存在无超时的等待。Claude Code 的前台 Bash 最长 10 分钟，`wait_timeout_ms` 超过它时等待必须走宿主后台任务（`run_in_background`），不能在前台阻塞。超时或 blocked 先读输出判断原因，不盲目重发：无进展标 stale，按 SKILL.md 的心跳规则停掉重派；有进展用 `lane mark --progress` 记录并可再等一轮，每一轮同样带 `--timeout`，受同一上限约束。
7. **验收**：owner 读回复文件，查看 diff 并复跑关键验证；回复文件缺失时用 `herdr --session <session_name> agent read <name> --source recent` 查看原因。结果越界、需要判断或失败时，把 findings 交回同一 worker（多轮）或改派，不自己打补丁。随后 `lane mark --outcome accepted|failed`。
8. **关闭 lane（硬性）**：一次性包验收通过（或失败且已核对部分产物）后，立即 `lane close`，不留空闲 agent；hidden 后用户看不到这些 agent，不关就会一直占用资源。需要多轮的包保留 lane 到该包结束再关，期间 `lane mark --keep-reason` 写明原因。`lane close` 失败或停在 `closing` 时先看 `last_error`，重试；仍无法关闭的写入台账“阻塞/风险”列。只关本任务登记的 lane，不关用户自己的 pane 或归属不明的资源。
9. **收尾**：本任务的 lane 全部关闭后运行 `run close`。它顺带运行 `gc`，核对 session 中 workspace、tab、pane 的全集为空后才停止并删除 session；有任何未关闭 lane、`unknown` lane 或未知资源时不停止，run 保持 `closing`，报告原因，由用户处理。没有 `--force`。

**调用方身份**：`run open` 从脚本自身沿父进程链找 owner CLI 进程（Claude：祖先链中必须有 `CLAUDE_PID`；Codex：祖先链中的 codex TUI 客户端，排除 app-server），登记它的进程身份；找不到进程时退而登记宿主会话 ID（按 owner 引擎取 `CLAUDE_CODE_SESSION_ID`（Claude）或 `CODEX_THREAD_ID`（Codex），缺失记 null；它只是恢复线索，owner 进程身份存在时以进程身份为准）；两者都没有则拒绝创建 run。之后对该 run 的 `lane open`、`lane close`、`lane mark`、`run close` 都要求调用方身份与登记一致，`--run` 只是定位符；来自别的进程或宿主会话的调用会被拒绝。`ls` 与 `gc` 不要求身份。

**残余风险（已接受）**：hidden session 只用于查看（`herdr session attach <session_name>`），不要在其中新建 tab 或 pane。收尾时空库存检查与 `session stop` 之间若有人手动 attach 并新建资源，会被一同停止。

## 运行状态库

状态库是 sqlite 文件，`agents-config.ts` 与 `agents-runtime.ts` 共用，保存额度 block 和 herdr run/lane 登记。agent 配置仍是 JSON 加 schema，不进库。

**范围**：只登记 herdr 派发的 worker。native worker 的生命周期归宿主，仍只在台账记录，所以本库不是全部 worker 的登记。

**位置**：默认 `~/.local/state/agents-cooperation/state.sqlite`；`--state <sqlite>` 或环境变量 `AGENTS_COOPERATION_STATE` 覆盖，两个脚本共用同一解析。目录权限 0700，文件 0600，启用 WAL、busy_timeout 和外键。写入都是短 `BEGIN IMMEDIATE` 事务，外部 Herdr 调用期间不持有写事务。目标文件存在但不是 sqlite（例如仍指向旧 JSON）、属于其他应用或版本高于本脚本时拒绝并说明，不覆盖。

**版本与迁移**：`PRAGMA user_version` 加 `meta.app='agents-cooperation'`，在代码内按版本逐步迁移，不引入迁移工具；升级在一个写事务内执行，先校验旧数据。迁移序列先建 `meta`、`blocks`，再建 `runs`、`lanes`。旧版 `availability.json`：

- 只在使用默认状态路径时，打开库会自动发现同目录的 `availability.json` 并导入；自定义 `--state` 不自动迁移，也不动邻接文件。
- 导入在一个写事务内完成：把原文件 `rename` 为 `availability.json.importing-<时间>-<随机>`，读取并按 `<skill>/assets/availability.schema.json` 校验，写入 `blocks` 和 `meta.availability_imports`（快照路径、sha256、来源）；提交后只删除记录中对应且哈希未变的快照。事务回滚或中途退出时快照保留，下次打开把无记录的单个有效快照当作未完成的导入继续。
- 无记录的遗留快照：仅一个且校验通过则按正常流程导入；多个或校验失败则全部保留并报错，不会表现为空状态。快照领取后原路径又出现的文件保留，不导入不删除，在输出的 `state_warnings` 中提示。
- 显式导入：`agents-config.ts migrate-availability --from <path>`，同一内容（sha256）再次导入直接返回 `imported: 0`。

**表**（字段以代码内迁移为准，此处只列用途）：

- `blocks(engine, model NULL, reason, since, release_at NULL, by NULL)`：两个部分唯一索引（`model IS NULL` / `model IS NOT NULL`），`block` 在事务内 UPSERT，`unblock` 精确匹配，过期语义见下文。
- `runs`：`run_id`（`<collab_id>-<owner_id>-<随机>`）、`collab_id`、`request_id`、`owner_id`、`engine`、调用方身份（`owner_proc` JSON `{pid, starttime, boot_id, source}`、`host_session_id`、`owner_pane`）、`cwd`、`label`、`session_name`（唯一，`aw-<MMDD>-<engine>-<随机>`，run open 时预留）、`session_phase`、`session_proof`、`session_dir_id`、`stopped_fingerprint`、`stop_observed_at`、`status`、`lock_proc`、`lock_op`、`last_error` 和时间戳。
- `lanes`：`lane_id`、`run_id`、`op_id`、`worker_id`、`engine`、`model`、`class`、`agent_name`、`workspace_id`、`tab_id`、`pane_id`、`status`、`outcome`、`health`、`keep_reason`、`last_progress_at`、`last_error` 和时间戳；`(run_id, op_id)`、`(run_id, agent_name)` 唯一。

**状态机**：

- **lane `status`**：`opening`（已登记，尚未取得 route-lane 回执）→ `open`（回执齐全，记录 workspace、tab、pane ID）→ `closing`（正在关闭 pane）→ `closed`。`unknown`：开 lane 失败或回执缺失、`opening` 被恢复时进入，只报告，不按标签或名称认领，`lane close` 拒绝处理。`outcome` 为 `accepted` / `failed`，`health` 为 `ok` / `stale`，`keep_reason` 非空表示 owner 有意保留。
- **run `status`**：`active` → `closing` → `closed`。`run close` 或 gc 判定 owner 已退出后进入 `closing`，session 回收到终态后才置 `closed`；从未创建 session（`session_phase` 为 `none`）的 run 直接 `closed`。
- **`session_phase`**：`none`（只预留了名称）→ `creating`（首个 lane 开始创建）→ `created`（取得运行期证明）→ `stopping` → `stopped` → `deleting` → `deleted`；任何证据不符进入 `unknown`。每个破坏性动作之前先把阶段落库，中断后按阶段恢复：
  - `creating` 且库中没有回执：直接 `unknown`，不按名称、时间或 scope 成员认领。创建由 `route-lane --create-session` 完成：以 `systemd-run --user --scope` 启动，从不复用或恢复已存在的同名 session（`session_exists`），session 目录用原子 `mkdir` 占用，fork server 前必须仍为空；目录在其间被写入、出现已恢复的 workspace 或 socket 由别的进程提供时返回 `session_foreign`（只报告）；成功回执含运行期证明 `{unit, invocation_id, server_pid, server_starttime, boot_id}` 和 session 目录身份 `{dev, ino}`。
  - `created`：每次开 lane、关 lane、停止前，用证明复核（目录身份、原 server 进程、scope InvocationID、session 仍为 running），不一致即 `unknown`。关闭时逐 lane 尝试回收归属明确的 `open/closing` lane；未知、`opening` 或单个关闭失败分别报告，继续处理后续 lane，每个 lane 仍独立复核实例。只要有未关闭 lane 或错误便保留 session；全部 lane 已关闭且 workspace、tab、pane 全集为空，才进入 `stopping` 并执行 `herdr session stop`。
  - `stopping`：正常停止先确认原 server 已退出，持久提交 `stop_observed_at`，再记录 `stopped_fingerprint`（目录递归条目的相对路径、类型、大小、纳秒 mtime 的元数据哈希与明细）。恢复时已 stopped 必须有已提交的停止观察时间，且目录条目不晚于该时间，才补记指纹；stop 已完成但 `stop_observed_at` 尚未提交就中断，会保守进入 `unknown`。仍 running 且证明一致则重新做空库存断言后再停止；无法证明停止后目录未被重新使用则 `unknown`。不为查询而重新拉起 session。
  - `stopped`：删除前核对名称状态为 stopped、目录身份一致、当前元数据指纹与 `stopped_fingerprint` 完全一致；任一不符 `unknown`，保留目录。指纹只检测路径、类型、大小和纳秒 mtime 的变化，不保证所有重启方式必然改变指纹，也不是文件内容校验。然后进入 `deleting` 并执行 `herdr session delete`，确认名称与目录都不存在后 `deleted`，再置 run `closed`。`deleting` 恢复时同样先核对再重试。
  - `unknown`：只报告，run 保持 `closing`，需要用户检查。
- **关闭 lane**：`lane close` 只执行 `herdr --session <session_name> pane close <pane_id>`（参数数组，不经 shell；不用 tab 或 workspace close），随后查询确认 pane 已不存在才置 `closed`，查询失败则保持 `closing` 并写 `last_error`。Herdr 在 tab 的最后一个 pane 关闭时一并关闭 tab，在 workspace 的最后一个 tab 关闭时一并移除 workspace；他人在同 tab 插入的未知 pane 不受影响，会在库存比对中作为未知资源报告。

**互斥**：每个 run 的写操作持 run 锁（`lock_proc` 记录操作进程身份，`lock_op` 记录操作标记）。`finally` 释放前也扫描当前 op；中间 route/capture 退出并不证明原生子调用已结束，仍在途或证据不可读时保留 `lock_proc/lock_op`，把诊断写入 `last_error`，不覆盖操作的原异常。后续只经 dead-holder 扫描接管，持有者仍 alive 或 unknown 时拒绝。持有者 dead 时，还要确认没有遗留的在途外部调用才可接管：runtime 与 `route-lane` 启动的外部子调用在 argv 带 `--op-tag`，并以环境变量 `AGENTS_COOPERATION_OP_TAG` 把操作标记传给其子进程（常驻 herdr server 不携带）；释放与接管均扫描同 UID 进程的 argv 与 environ，命中同一标记即视为在途。同 boot 才扫描，跨 boot 视为无在途。仅 `/proc` stat 已证实状态为 `Z` 的僵尸进程直接跳过，它已退出，其子孙仍独立接受扫描；其他状态和不可读 stat 不据此跳过。某进程的 environ 读取失败（进程已消失除外）时无法证明无在途，保留锁；仅当其启动时间严格早于锁持有者（不可能是其子孙）才跳过，同 tick 或更晚、启动时间无法读取的进程仍保留锁。没有 TTL 接管。

**owner 判活三态**：用进程身份（`boot_id` 加 `/proc/<pid>/stat` 的 starttime）判断。`boot_id` 不同、pid 不存在、starttime 不同或进程为僵尸：`dead`；一致：`alive`；读取失败，或登记时没有进程证据（只有宿主会话 ID）：`unknown`。只有 `dead` 会触发自动回收。

**gc**（`lane open` 与 `run close` 顺带运行，不含正在操作的那个 run；也可手动 `agents-runtime gc`；无常驻进程或定时器）：逐个未关闭 run 取锁（取不到则该 run 记入 `reports` 的错误，不接管），然后：

1. 恢复：`creating` 无回执的 run 记为 `unknown`；`opening` lane 记为 `unknown`；`closing` lane 重试关闭；`status` 为 `closing` 的 run 继续推进 session 回收。
2. owner 为 `dead` 的 `active` run：置 `closing` 并推进回收，空库存断言不变，有未知资源时不停止 session。
3. owner 为 `alive` 或 `unknown`：`open` lane 的 `last_progress_at` 超过 `herdr.max_wait_minutes` 且无 `keep_reason` 时置 `health: stale`（写库）并报告；超过该上限三倍的 lane 无论有无 `keep_reason` 都报告。不自动关闭。
4. 名称以 `aw-` 开头、却不属于任何未关闭 run 的 session：只报告。

gc 的结果在输出的 `reports` 数组里（`lane open` / `run close` 为 `gc_reports`），实际执行的回收动作各有一条：`reclaimed`（owner 已死，带 `owner_life` 与终态 `session_phase`）、`resumed`（`from`/`to` 阶段）以及 lane 的 `marked_unknown`/`closed`。没有 `--force`：未知资源、`unknown` 状态和无法确认的 owner 一律只报告，由用户处理。

**ls**：只读，不刷新进度。每个 run 输出登记行、`owner_life`、`lanes` 和 `actual`：session 为 `running` 时给出 `status`、`inventory`（workspace、tab、pane 全集）、`unknown`（库存中不属于任何已登记 lane 的 ID）和 `missing`（未关闭但 pane 已不在的 lane）；不是 running 时给出 `status`（`stopped` / `absent`）和 `missing`；查询失败给出 `error`。`lane` 的 `health` 由 `ls` 即时只读计算（规则与 gc 相同：owner 非 `dead`、lane 为 `open`、无进展超过上限且无 `keep_reason` 时为 `stale`，不写库），台账触发点只跑 `ls` 即可；超过上限三倍的保留 lane 报告属于 gc。

`max_parallel` 计数包含 native 与 herdr worker。

## 并行上限

只有 owner 级一层：`owners.<id>.max_parallel` 必填，≥1，是该 owner 同时运行的子 agent（native 与 herdr worker 合计）上限。owner 按自己台账中“运行中”的条目计数，达到上限时新包标“待派发”，不突破。

不设全局或引擎级上限：各 owner 观测不到对方的子 agent，无法准确计数。额度和速率压力由下面的 block 机制处理。

## 免费或低成本模型的使用

免费 worker 由类别保留标签 `mechanical`、`routine` 标识，不设专用字段；包类别的含义和判定见 SKILL.md 的“包类别”，选择算法见“派发方式推导”。启用、暂停、调换都通过配置或 block 完成：用 `enabled`、`workers` 顺序和 `tags` 调整，免费期结束或限流时 `block --engine <id> [--model <m>]` 暂停；规则本身不改，`resolve --class` 会自动落到下一个可用的免费 worker，没有时按 judgment 回退并给出 `warnings`。

## 额度耗尽 block 与自动解封

运行状态与配置分离，不写入 `config.json`。block 记录在“运行状态库”的 `blocks` 表（位置、`--state` 覆盖和旧 `availability.json` 的迁移见上节），同一 (engine, model) 由部分唯一索引保证只有一条。owner 不手工编辑，只用下面的命令：

```json
{ "engine": "codex", "model": "gpt-6-astra", "reason": "usage limit",
  "since": "2026-10-16T22:00:00-04:00", "release_at": "2026-10-17T03:00:00-04:00", "by": "claude_owner" }
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
| `migrate-availability --from <path>` | 导入旧版 `availability.json` 快照，见“运行状态库”的迁移 |

可用性判定（`resolve`、`show`、`status` 共用）依次为：`disabled`（自身 enabled=false）→ `engine_disabled` → `blocked`（引擎级或 engine+model 级，附 `release_at` 和 `reason`）→ `available`；`show` 输出中每个 owner 和子 agent 都带 `availability`。

传播：

- owner 被 block 时，以它为发起方的 `resolve --owner` 一律拒绝，它的原生子 agent 随之不可派发；同引擎但不同 model 且未被 block 的子 agent，仍可被其他 owner 经 herdr 使用。
- 引擎级 block 则该引擎上的 owner 与子 agent 全部不可用。

owner 的处置步骤见 SKILL.md 的“额度耗尽”：识别信号、`block`（能解析出重置时间就写 `--release-at`；报错只针对某个模型时带 `--model`）、`resolve --owner <owner-id> --class <原类别> [--tag <领域>]` 重选、整包改派并写台账。协作 owner 被 block 时降级为单 owner。

## 本地 Web 配置页

需要 Bun 1.4.2。Web 依赖与普通 CLI 分离，首次在 `<skill>/web` 执行 `bun install`，然后运行：

```bash
bun <skill>/scripts/agents-config.ts web [--config PATH] [--state PATH] [--port N] [--no-open]
```

默认打开系统浏览器；自动化使用 `--no-open`。仅监听 `127.0.0.1`，退出终端服务会释放监听。配置与状态参数沿用现有环境变量覆盖。页面不展示读取来源和保存路径，内部路径由启动参数固定；目标不存在时使用默认资产初始化草稿，首次保存仅创建目标，不修改默认资产。

可视编辑引擎、负责人、工作代理、Owner Agent 单次等待上限和 ChatGPT Pro 自动审查开关，工作代理列表可拖动手柄调整优先顺序，也可使用上移或下移按钮。配置 ID 失焦或按 Enter 接受有效修改，保存或校验前同样接受输入；空值、格式错误和重复 ID 在字段内提示并阻止提交，切换实体或分区保留输入。引擎重命名同步负责人及工作代理的 engine 引用，工作代理重命名同步负责人的有序列表；未知字段不递归替换。删除保留其他引用。完整草稿由现有校验器检查，未知字段保留并报告。固定 effort 从共享元数据生成下拉选项，opencode variant 可输入。校验使用未保存配置，报告完整草稿错误。校验、放弃、重新加载、保存及状态反馈集中在页头操作区；“系统设置”中的“Owner Agent 等待上限”控制 Owner 每次通过 Herdr 等待子 Agent 回报的最长时间，超时后先检查进展，再决定继续等待或重新派发；配置仍为 `herdr.max_wait_minutes`，native 派发不使用此值。同一页的“ChatGPT Pro 自动审查”开关写入顶层 `chatgpt_review`，默认开；关闭后跳过本技能的自动 Pro 审查，本地 review 和测试照常。它与等待上限共用保存、未保存、放弃、重新加载和冲突保护，不单独保存。侧栏复用 ConsoleShell 收起状态隐藏品牌文字，移动导航抽屉保留文字。

任务看板只读展示已登记的协作 Herdr 任务，分成进行中、已完成、已关闭三列。点击任务卡打开详情，主区是按时间排列的调度时间线。之后的 run/lane 变化会自动留下调度事件；启用记录前的旧任务只保留已知历史概要，不补造中间过程。未登记的 native 会话和独立 CLI 不在看板范围内。

引擎表单可编辑精确引擎级额度恢复时间，显示本机 `Intl` 时区、提交带时区的 ISO 时间；不改模型级记录，启用状态独立。新日期必须在未来，已有过期日期只提示而不自动写入；空日期未编辑不解除无日期限制，明确清除已有或编辑过的日期才提交解除。额度读取失败在日期区域重试，不妨碍普通配置编辑。配置与日期共用顶部保存及草稿保护：先验证日期，再按配置、额度顺序写入。配置失败不写额度；配置成功但额度失败保留日期草稿并明确部分成功，重试仅提交未完成及后来的改动，两类保存中新输入均保留。重命名只重映射未保存的日期编辑，不迁移或清除旧引擎的运行历史。额度状态 warnings 仅放诊断详情。保存并非跨文件或数据库的原子事务。

保存要求页面读取的 revision，冲突保留草稿，需明确重新加载后继续；失败可重试。保存过程中继续输入会保留新输入，已提交快照及 revision 正常更新。普通外部修改会被检测，但不协作编辑器在最后检查与原子替换间仍有很窄的竞争窗口。包内开发与验证入口见 [`web/README.md`](../web/README.md)。

## 修改配置

1. 编辑 `~/.config/agents-cooperation/config.json`。没有就从 `assets/config.default.json` 复制，并把 `$schema` 改成技能安装目录下 `assets/config.schema.json` 的绝对路径；默认配置里的相对路径 `./config.schema.json` 只在技能目录内有效。
2. `bun <skill>/scripts/agents-config.ts validate`，按错误里的 JSON 路径逐条修正，直到输出 `ok: true`。
3. `show` 确认 owner、`workers` 顺序、`availability`、并行上限和 `config.chatgpt_review` 有效值符合预期。
4. 不要为了绕过校验放宽 schema；新增引擎 kind 或 effort 取值先改 schema 与脚本常量表。

示例：启用 opencode 作为机械性包的 worker（默认配置中已有 `opencode` 与 `opencode_worker` 的 disabled 示例）：

```jsonc
{
  "engines": { "opencode": { "enabled": true, "kind": "opencode", "native_subagents": false } },
  "workers": {
    "opencode_worker": {
      "enabled": true, "engine": "opencode",
      "model": "opencode/glm-5.3-flash-free", "effort": "max",
      "tags": ["mechanical"],
      "description": "免费模型，用于机械性包：跑测试汇总、lint 修复、批量修改、只读清点"
    }
  },
  "owners": { "claude_owner": { "workers": ["claude_worker", "opencode_worker"] } }
}
```

模型取自已安装的 opencode，`effort` 取该模型 variants 之一，并要与 opencode TUI 记忆的 variant 一致（否则 `resolve` 给出 `warnings`）；`validate` 只校验结构与引用，不探测模型是否真实存在。
