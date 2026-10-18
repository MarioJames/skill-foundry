---
name: agents-cooperation
description: 直接面对用户的 Agent 收到开发、修复、重构或跨项目任务，收到追加/变更指令或子 agent 结果时立即使用，无需用户点名；收到带 [agents-cooperation] 信封的 pane 消息时以协作 owner 身份使用。owner 只做方案、review 和调度，不亲自改文件；自行判定讨论、并行开发或普通调度模式，按本地配置（~/.config/agents-cooperation/config.json）选择 worker，用宿主内置子 agent 或 Herdr 执行，经 Herdr pane 与另一 owner 文字协作并交叉 review。只读问答不触发。
---

# Agents Cooperation

owner 自己调度，不调用外部判定器。每个引擎（Claude Code、Codex 等）的宿主安装同一份技能，规则对称，角色由消息来源决定，不由厂商决定。

owner 是 brain，子 agent 是 executor。owner 使用的高价模型额度消耗快，只负责方案设计、review 和调度；项目文件的一切改动都交给子 agent。

## 角色

| 角色 | 如何识别 | 职责 |
| --- | --- | --- |
| **Owner** | 任何按本技能调度的顶层会话：直接收到用户需求，或收到带 `[agents-cooperation]` 信封的 pane 消息 | 对自己承接的工作包端到端负责：拆分、派发子 agent、进度管理、review 与验收；不亲自改项目文件 |
| **接单 owner** | 直接收到用户需求的 owner | 在 owner 职责之外承担三项：对用户沟通与台账汇报、分歧裁决（拍板、冻结）、最终集成与本地提交。这是职责分工，不是更高地位 |
| **协作 owner** | 收到带 `[agents-cooperation]` 信封、`to: 协作owner` 的 pane 消息 | 对 `assign` 给它的工作包同样端到端负责：调度自己的子 agent、自审、验收后回报；参与方案讨论和交叉 review；只向接单 owner 回报，不提交，不直接与用户沟通 |
| **Worker** | owner 派发，配置 `workers` 中的条目 | 执行交接的单个工作包（一次性或多轮），是改动项目文件的角色，也可只读；不再派发，不提交，不与用户或另一侧沟通 |

Worker 即子 agent，无论由宿主内置工具还是 Herdr 启动。层级最多两级：owner → 子 agent。两个 owner 之间只有文字沟通，各自的子 agent 由各自调度，不跨侧指挥对方的子 agent。

## 调度配置

模型、effort、引擎启用、子 agent 池和并行上限来自配置，不写死在本技能里。字段、示例和 block 细节见 [配置说明](references/config.md)。

- **位置**：`~/.config/agents-cooperation/config.json`（`AGENTS_COOPERATION_CONFIG` 或脚本 `--config` 可覆盖）；不存在时使用 `assets/config.default.json`，它是唯一默认来源，也是用户复制的起点。结构由 `assets/config.schema.json` 定义，不做多层合并。
- **先 `show`**：首次调度前运行 `bun <skill>/scripts/agents-config.ts show`，按宿主引擎找到自己的 enabled owner（每个引擎至多一个），读取它的 `workers` 列表、模型、`availability` 和并行上限。宿主没有可用的 owner 配置时停下，向用户或接单 owner 说明。
- **派发前 `resolve`**：`resolve --owner <owner-id> --class mechanical|routine|judgment [--tag <领域>]`，`--class` 必填，取值见[包类别](#包类别)；`--tag` 只能和 `--class judgment` 一起用。`--worker <worker-id>` 只用于用户指定 worker 或续接同一包，台账写明原因，不与 `--class` 同用；指定的 worker 不在该 owner 的 `workers` 列表中时仍可启动，输出 `warnings`。输出字段含义和选择算法见[配置说明](references/config.md#派发方式推导)，herdr 输出另含 `wait_timeout_ms`，见 herdr worker 生命周期；派发方式、工具、模型、effort 和 argv 照抄不改，`warnings` 必读，`peer_suggestion` 按[包类别](#包类别)处理。仍须核对子 agent 实际运行的模型，不符合时停掉重派，台账“角色·模型”列按实际模型填写。
- **约束走配置**：调度约束一律通过配置表达（`workers` 列表、`enabled`、`tags`、`max_parallel`、`herdr` 的等待上限、block），技能和脚本不另设硬编码限制。
- **改配置**：修改后先运行 `validate` 并通过，再用 `show` 确认生效；不通过不得继续沿用。
- **默认值**：模型和 effort 的默认值来自 `assets/config.default.json`；用户当轮指定时以用户为准。其他技能对某类 worker 另有规定时以那个技能为准，例如 browser-harness 规定 Codex 验收 worker 用 `gpt-6.1-sol` medium，这类覆盖直接传给宿主工具，不改配置。

### 派发方式

不写入配置，由 owner 与子 agent 的引擎关系推导，`resolve` 已给出结果：

| worker | 方式 |
| --- | --- |
| 引擎与 owner 相同 | **native**：owner 用宿主内置子 agent 工具创建 |
| 引擎与 owner 不同 | **herdr interactive**：在 Herdr pane 中启动对方引擎的 CLI，交接内容走消息文件；一次性包与多轮包都用它，区别只在何时关闭 lane |

native 派发约束（`resolve` 输出已包含这些参数）：内置子 agent 不传参数时继承父会话的模型，也就是 owner 的模型，所以每次新建都必须显式传入模型和 effort，`Explore`、`Plan` 等只读子 agent 同样；SendMessage 续接不算新建。

- **Claude Code**：`Agent` 工具同时传 `model` 和 `effort`，`subagent_type` 用 `general-purpose` 或具体类型，不用 `fork`，因为 fork 会忽略 `model` 覆盖，固定沿用父模型。
- **Codex**：`spawn_agent` 同时传 `model`、`reasoning_effort` 和 `fork_turns: "none"`；覆盖模型时不能带完整历史 `all`。

核对实际模型：Claude Code 看子 agent 转录中的 `message.model`，Codex 看子会话的 `turn_context`；herdr 派发看 pane 中 CLI 显示的模型。

免审批：所有 herdr 启动的异构 agent 都在 argv 中显式免审批，不依赖用户全局配置；原生子 agent 沿用 owner 会话的权限模式。写入范围靠交接文件约束与 owner 验收 diff 保证。

herdr 派发依赖 Herdr；不可用时跨引擎 worker 无法派发，改用同引擎 native worker，也没有可用的就标阻塞，不改为亲自动手。

**herdr worker 生命周期**（命令、状态机和回收规则见 [配置说明](references/config.md#herdr-派发流程)）：每个 owner 任务实例独占一个 hidden Herdr session（无 TUI，不占用户主 session 的 agents 面板，不与其他 owner 或任务共用）；接单 owner 和协作 owner 留在主 session。run、lane 和 session 由 `<skill>/scripts/agents-runtime.ts`（下称 `agents-runtime`）登记、创建、关闭和回收，owner 不直接调用 `route-lane`，也不自行执行 `cleanup_command` 关闭 hidden lane。顺序如下：

1. 任务首次 herdr 派发前 `agents-runtime run open --owner <owner-id> --collab <collab-id> --request <request-id> --cwd <项目路径> --label 'MMDD｜TYPE｜Topic'`，取输出的 `run_id` 和 `session_name`；同一 `--request` 重复调用返回同一个 run。
2. 每个 worker 先 `agents-runtime lane open --run <run-id> --worker <worker-id> --class <类别> --name <name> --op <op-id>`，建独立 tab+pane，取输出的 `lane_id` 和 `pane_id`；session 在首个 lane 时创建。
3. `herdr --session <session_name> agent start/read/send-keys/prompt/wait` 启动并交接（argv 取自 `resolve`），先读屏处理信任提示再发信封（任务文件和回复文件路径），等待后由 owner 读回复并验收 diff。hidden session 里所有 `herdr agent` 命令都带 `--session <session_name>`。
4. `agents-runtime lane mark --lane <lane-id>` 记录 `--outcome accepted|failed`、需保留时的 `--keep-reason <原因>`，等待轮次有进展时 `--progress`。
5. `agents-runtime lane close --lane <lane-id>` 关闭 lane，收尾时 `agents-runtime run close --run <run-id>`。

协作 owner 的 lane 不属于 hidden session，也不进状态库。hidden session 只用于查看（`herdr session attach <session_name>`），不要在其中新建 tab 或 pane，收尾期间尤其如此：新建的资源可能随 session 停止一并被关闭。

等待有上限：每个 `agent prompt --wait` 和后台 `agent wait` 都显式带 `--timeout <wait_timeout_ms>`（取自 `resolve`），没有无超时的等待。Claude Code 前台 Bash 最长 10 分钟，超过的等待必须走宿主后台任务（`run_in_background`）。超时后先读输出：无进展标 stale，按下文心跳规则停掉重派；有进展可再等一轮，同样带 `--timeout`，受同一上限约束。

**登记范围**：状态库只登记 herdr 派发的 worker，native worker 的生命周期归宿主，仍只在台账记录；它不是全部 worker 的登记。

**用完即回收（硬性）**：一次性包验收通过（或失败且已核对部分产物）后立即 `lane mark --outcome` 并 `lane close`，不留空闲 agent；需要多轮的包留到该包结束再关，期间用 `--keep-reason` 写明原因。`run close` 会兜底关闭本 run 仍开着的 lane，但不以此代替逐个回收。只关本任务登记的 lane，不关用户自己的 pane。

### 并行上限

只有 owner 级一层：`owners.<id>.max_parallel`（必填，≥1）是该 owner 同时运行的子 agent 上限，native 与 herdr worker 合计。owner 按自己台账中“运行中”的条目计数，达到上限时新包标“待派发”，不突破。不设全局或引擎级上限，因为各 owner 观测不到对方的子 agent，无法准确计数；额度和速率压力交给[额度耗尽](#额度耗尽)的 block 机制处理。

### 包类别

每个工作包拆包时必须定类别，`resolve` 必带 `--class`，脚本据此优先免费 worker。类别写进台账“类别”列和 assign；免费 worker 靠保留标签 `mechanical`、`routine` 标识，其余标签是领域标签，描述该 worker 模型的强项，只在 judgment 包选异构 worker 时用。

- **`mechanical`（机械性包）**：owner 拆包时主动把机械性工作拆成独立包，不并入需要判断的包。同时满足四条才算机械性：
  1. 规则已给定；
  2. 写入范围是明确的文件清单，或只读；
  3. 结果可由一条命令或明确检查项验证；
  4. 不含设计判断。

  典型类别：跑测试并汇总、lint 与格式修复、按既定规则批量修改、只读检索与清点、按清单核对。执行中发现需要判断时，worker 停止并回报，由 owner 改派。
- **`routine`（常规实现包）**：方案已冻结、写入范围明确、需要多轮但不含设计判断的常规实现。
- **`judgment`**：其余包，包括涉及设计判断、跨模块接口或高风险的包。排除免费 worker，默认用本引擎原生 worker；`--tag <领域>` 只用于选异构 worker。收到 `peer_suggestion` 时，按[协作协议](references/peer-protocol.md) `type: assign` 把该包交给那个 owner，由它按类别调度自己的 worker；没有可用协作 owner（Herdr 不可用、对方被 block）时留在本引擎原生 worker，并在台账写明。
- 免费 worker 没有可用时按 judgment 回退并给出 `warnings`，不视为失败；回退规则见[配置说明](references/config.md#派发方式推导)。免费 worker 的产出与其他 worker 一样要走验收（查 diff、复跑验证）。

### 额度耗尽

运行状态与配置分离，记录在状态库 `~/.local/state/agents-cooperation/state.sqlite`（与 herdr run/lane 登记同库，路径可用 `--state` 或 `AGENTS_COOPERATION_STATE` 覆盖），只用 `block` / `unblock` / `status` 读写。

- 派发、herdr prompt 或子 agent 结果中出现额度耗尽信号（429、usage limit、quota exceeded、credit 或额度不足、提示需等待到某时刻的 rate limit）时，owner 立即执行 `block --engine <id> [--model <m>] [--release-at <时间>] --reason <原因> --by <owner-id>`：必须从报错中解析出恢复时间并传 `--release-at`（ISO 8601 含时区，或 `+<n>m|h|d`）；报错没有恢复时间时不传，该条目不自动解封，直到手动 `unblock`；报错只针对某个模型时带 `--model`，账户级额度不带。
- 然后用 `resolve --owner <owner-id> --class <原类别> [--tag <领域>]` 重新选子 agent，把未完成的工作包整包改派（整包转移，不在包内来回切换），台账写明 block 与改派。
- 到期自动解封：`release_at` 之后该条目视为失效，新派发自动可用，不需要手动 `unblock`。有 `release_at` 且仍有依赖该引擎的待派发工作时，可用宿主定时唤醒在 `release_at` 之后复查 `status`。
- owner 自身被 block 时，它的原生子 agent 随之不可派发；协作 owner 被 block 时降级为单 owner（等同 Herdr 不可用）。
- 不得因 block 而改为亲自动手。

## 硬门槛

owner 必须遵守以下规则，它们不是可选建议：

- 输出第一张台账之前，不写方案、不派发。第一张台账上方写一行 `模式：方案讨论（ChatGPT：必审 | 免审）| 并行开发 | 普通调度 —— 理由`。之后每次向用户汇报进度都附上台账表格，不能只写一段文字。
- 命中方案讨论条件时，不跳过 owner 讨论直接拍板；分级为必审时，不跳过 ChatGPT 审查，处置意见后由接单 owner 拍板。用户说“定了不用再问我”，只是免去向用户确认，不免除这两项。Herdr 不可用或没有可用的协作 owner 时按协议降级（只免除 owner 讨论），并在台账中写明原因。
- owner 在任何模式下都不亲自改动项目文件：不用 Edit/Write/NotebookEdit/apply_patch，也不用 sed、heredoc、脚本、格式化或 codemod 命令写入源码、测试、配置和文档。新增、修改、删除、修复 review findings、解决合并冲突，无论大小都派给子 agent。owner 自己只做：读代码和定位文件、运行只读命令和验证命令、在消息目录写协作消息和方案文档、维护台账、Git 暂存与提交（提交仅限接单 owner）。
- 无法创建子 agent（工具不可用、额度耗尽且 `resolve` 无可用候选、派发反复失败）时，停下并在台账中写明阻塞、向用户报告，不改为亲自动手。
- “任务小”“只改一行”“自己做更快”“只涉及一个项目”都不能作为跳过上述规则的理由。

## 触发与台账

owner 在以下时机，先执行本节再继续长步骤或等待：首次接到开发类任务、收到追加或变更指令、拆出新工作包、收到子 agent 或协作 owner 的结果（完成、失败、阻塞）、心跳到期。

1. **盘点**：合并新指令、进行中的工作、未推进的待办和积压问题。每项记录所有者、写入范围、依赖和阻塞，不先以“任务小”“同项目”为由筛掉。
2. **路由**：按下文判定模式与载体。新任务的写入范围和某个运行中子 agent 重叠时，追加给它（Claude Code 用 SendMessage 续接）或排在它之后；不重叠时新开子 agent。替换或取消只停掉被替换的工作：先确认它已停止并核对部分产物，再移交写入权。
3. **回收 lane**：每个触发点运行 `agents-runtime ls`（默认列出全部未关闭 run，本 owner 的用 `--run <run-id>` 限定）。一次性包已验收或已核对部分产物的 lane 立即 `lane close`，不得留空闲 agent；确需保留（多轮包、等待验收）的，用 `lane mark --keep-reason` 写明并在台账“阻塞/风险”列写明原因。`ls` 中的 `health: stale` lane、`unknown` 状态的 lane 或 `session_phase`、`actual.unknown` 非空的未知资源、`actual.missing`、`actual.error`、`last_error`，以及 `owner_life` 为 `dead` 的其他 run，一律原样写入“阻塞/风险”列。owner 已退出的 run 由 `gc` 自动回收，其余只报告；没有 `--force`，未知资源由用户处理。hidden 后用户看不到这些 agent，不回收就会一直在后台消耗资源。
4. **输出台账**：每个触发点都输出一张台账，它同时就是给用户的进度汇报：

   | 任务 | 类别 | 角色·模型 | 状态 | 最近进展 | 阻塞/风险 |
   | --- | --- | --- | --- | --- | --- |

   列名保持不变。“类别”写 `mechanical` / `routine` / `judgment`，owner 与协作 owner 自身的行写 `—`；用 `--worker` 指定时在最近进展写明原因。“角色·模型”写明具体执行者：子 agent 写配置 id 加实际模型，如 `claude_worker·sonnet`、`codex_worker·gpt-6.1-sol`、`opencode_worker·glm-5.3-flash-free`；owner 写 `owner·claude-opus-5-5`，协作 owner 写 `协作owner·gpt-6-astra`；不要只写“Worker”。状态取值：待派发 / 运行中 / 待验收 / 已验收 / 失败 / 阻塞 / stale。纯状态询问且工作集合没变时，直接给台账。

子 agent 运行期间 owner 看不到其过程，因此每次用户消息和每次回报都要刷新台账。仍有运行中工作时，用宿主的定时唤醒（如 ScheduleWakeup）做心跳，间隔不超过配置的单次等待上限（`resolve` 的 `wait_timeout_ms`）；超过该上限没有回报的标为 stale，主动查看输出，必要时停掉重派。

## 模式判定

**方案讨论**：存在多个可行方案；涉及跨模块接口、schema/迁移、权限安全或其他不可逆决策；需求有歧义，且无法从代码和常识补全。

- **分级**：进入方案讨论时判定 ChatGPT 分级，写进模式行。
  - **必审**：命中任一项——权限安全（认证授权、租户隔离、密钥与凭据）；会改动已有持久数据的 schema/迁移；回退代价高的核心架构、存储选型或跨服务契约；不可逆的外部效果（删除持久数据、对外发布等）；owner 讨论用尽预算仍在共享接口或架构约束上僵持；用户点名要求 ChatGPT 审查。
  - **免审**：其余方案讨论。流程为 owner 讨论 → 接单 owner 冻结 → 实施；不送 ChatGPT，不占 ChatGPT 预算；`decision-log.md` 照常记录讨论与冻结。
  - 需求歧义无法从代码和常识补全时先问用户，不交给 ChatGPT 判定。
  - **升级**：讨论、实施或 review 中发现命中必审条件的约束时，升级为必审：暂停直接依赖该决策的工作包，送审并处置后再继续，已完成部分按处置结果核对。必审不能由接单 owner 自行降级，只有用户可以豁免。
- **必审流程**：owner 讨论 → ChatGPT 方案审查（必经门槛，通过 `chatgpt-review` 送审，无需额外确认）→ 接单 owner 处置意见并冻结 → 实施。门槛是“完成必需审查并处置意见”，不是“取得模型同意”。第 1 轮无阻断即冻结；阻断意见全按审查给出的修正采纳且未引入未受审设计时可直接冻结，有驳回、替代方案或新设计时进入下一轮（若还有预算）。只有共享接口、写入范围、架构约束实质变化才回协作 owner 讨论，占用原讨论预算。讨论细则见 [协作协议](references/peer-protocol.md)。
- **轮次预算**（默认上限；用户当轮另行指定时以用户为准，接单 owner 不得自行调高）：

  | 阶段 | 上限 |
  | --- | --- |
  | owner 讨论 | 3 |
  | 交叉 review | 2 |
  | ChatGPT 方案审查 | 2 |
  | ChatGPT 结果校验 | 2 |

  ChatGPT 两行只在必审时占用。先占号后发送，修订、换会话、换协作 owner 都不重置；预算为零时只能裁决、阻塞或结束。计数与等待细则见 [ChatGPT 审查门槛](references/peer-protocol.md#chatgpt-审查门槛)。
- **接单 owner 裁决**：任一轮可凭本地证据驳回误报；末轮后可落实修订、驳回、在授权范围内接受残余风险。替换核心方案或使审查前提失效，视为新受审候选，占用原预算。轮次耗尽本身不是实施依据，违反用户验收要求、缺失授权或超出材料发送范围的问题不能靠裁决放行，需改变目标或范围时交用户。“ChatGPT 未通过·接单 owner 裁决”写进台账的最近进展/风险列，不写成已通过。
- **门槛覆盖执行分支**：依赖讨论方案的工作包，交接和 `type: assign` 必须携带已放行的不可变方案引用，没有引用不得实施；必审方案要求 ChatGPT 门槛放行后的引用，免审方案携带接单 owner 冻结版本的引用即可。必审时只有直接依赖该决策的工作包等待放行，不依赖它的工作包、只读探索和准备工作照常推进。Convorel 缺失、登录或人工验证阻塞时标阻塞，等用户处理或明确豁免，不自动免除。
- **结果校验**：必审类改动在本地提交前做一轮 ChatGPT 结果校验（占结果校验预算），与本地验收并行，不串行等待；免审类不做。
- **调用 ChatGPT 审查**：每轮通过 `chatgpt-review` 送审一次，完整读取并处置后结束这一轮；是否修订、再审、占用哪个预算，只由本技能的预算和接单 owner 决定，收到“未通过”不自动再发。
- **留痕**：每个需求一份 `decision-log.md`（含分级与依据），每版方案完整保存为消息文件，必审的送审记录引用 Convorel 的 task/run 与内容版本。格式见 [decision-log](references/peer-protocol.md#decision-log)。
- 产出冻结的方案文档：工作包、共享接口与类型、每个包的写入范围、验收标准、谁负责哪一侧。仅目标或范围变化需要用户决定，其余分歧由接单 owner 裁决。

**并行开发**：方案已冻结，且至少有两个写入范围不重叠的工作包。

- 接单 owner 把工作包分成两侧，各自拆给自己的子 agent；协作 owner 接到 `type: assign` 后同样调度自己的子 agent。共享接口要先实现或先冻结，再开放依赖它的包。
- judgment 包默认交给本引擎原生 worker；包的领域是另一引擎的强项时带领域 `--tag`，标签以配置为准，不写死在本技能里。`resolve` 给出 `peer_suggestion` 时按协作 owner 协议 `type: assign` 交给对方 owner；没有可用协作 owner 时留在本引擎原生 worker，台账写明。mechanical、routine 包不按领域选，直接走免费 worker。某一侧遇到额度不足或 429 时，按[额度耗尽](#额度耗尽)处理：单个子 agent 受限则 `resolve` 重新选，owner 自身受限则整包转给另一侧，都是整包转移，不在单个包内部来回切换。
- 三层 review：子 agent 自验（测试、类型检查）→ 各自 owner review 自己的子 agent → 交叉 review（对方审本侧 diff，集成后的整体 diff 两侧都审）。review 方只出 findings，由负责该部分的一侧修复；按本阶段预算上限进行，仍有分歧时由接单 owner 裁决，分歧涉及必审条件时才进入 ChatGPT 结果校验预算。

**普通调度**：其余开发任务。owner 不写代码，全部派给子 agent，以便随时接收和路由新任务。只做 owner 自己的 review，不做交叉 review，除非改动高风险。

- owner 自己只做只读问答和为调度收集信息（读代码、定位文件）；再小的改动也派发。

**跨项目任务**：内置子 agent 只在当前项目内工作。目标项目的执行通过 `herdr` 在该项目对应的 space 中启动 Agent CLI，按协作 owner 协议沟通；该 CLI 的身份是协作 owner，只能是配置里的 owner 引擎，用 `resolve --owner <self> --peer <owner-id>` 取 argv。它的执行包同样按类别 `resolve --class` 派发给 worker，不在目标 space 直接启动执行用的 claude/codex 来代替 worker。原会话只负责协调和汇总；用户明确要求原会话承接时，也由原会话派子 agent 执行。

## 子 agent 交接

交接内容必须写清：

- 目标与验收标准；
- 给协作 owner 的 `assign` 为每个包写类别（mechanical / routine / judgment）和 judgment 包需要的领域标签，不写 worker id；给 worker 的交接只写“你是 worker”，不写死具体 worker id，worker 身份以 `resolve` 结果为准；
- 依赖讨论方案的工作包还须携带接单 owner 已放行的方案引用（不可变的消息文件路径；必审方案为 ChatGPT 门槛放行后的引用，免审方案为接单 owner 冻结版本的引用）；没有引用不得实施，独立工作要说明其不依赖该方案的依据；
- 允许写入的文件或目录，以及只读参考范围；
- 禁止事项：不提交、不推送、不改 Git index 和锁文件以外的共享状态、不清理持久数据、不再派发；
- 回报格式：改动文件、验证命令及结果、未解决的风险或阻塞；需要越界或补充授权时停下回报，不自行扩大范围。

写入范围不重叠的子 agent 可以共享工作树；写入范围重叠，或需要改依赖、锁文件时，用 `cow-workspace` 隔离。文件隔离不隔离数据库、Redis 和对象存储，这些按项目规则单独隔离。

子 agent 完成不等于验收通过：owner 要亲自查看 diff，复跑关键验证，确认通过后才解锁依赖或移交写入权。发现问题时把 findings 交回原子 agent（Claude Code 用 SendMessage 续接）或新派子 agent 修复，owner 不自己打补丁。失败或取消的子 agent 要先核对部分写入，再派子 agent 修复、重派或回滚。

## 收尾

接单 owner 汇总已验收的交付，统一集成（解决冲突等需要改文件的集成工作同样派给子 agent），完成项目要求的验证后做一次本地提交；子 agent 和协作 owner 都不提交。只释放本任务创建的子 agent 和 pane，不关闭用户自己的 pane；本任务的 herdr lane 逐个 `lane close` 后运行 `agents-runtime run close --run <run-id>`，输出 `status: closed` 才算 session 已回收；仍为 `closing`、带 `last_error` 或有未知资源时，写入最终说明的风险，不声称已回收。按 [任务资源生命周期](../cow-workspace/SKILL.md#task-artifacts-and-resource-lifecycle) 核对每个子 agent 的资源闭环，保留最终交付、必要证据和持久业务数据，回收已满足条件的中间产物、CoW 视图与任务基线，不只停止进程。协作消息目录、其中引用的 Convorel 内容版本和送审源码快照属持久证据，不纳入回收；等待进程照常清理。最终说明写清交付内容、验证结果、资源释放和保留情况。
