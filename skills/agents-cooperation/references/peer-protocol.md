# Owner 协作协议

两个 owner 通过 Herdr pane 和消息文件进行文字协作。只有接单 owner 向对方 pane 发送 prompt；协作 owner 把回复写入文件后结束本轮，不向接单 owner 的 pane 注入输入。

## 启动协作 owner

Herdr 的 tab 命名、归属校验和清理规则以 `herdr` 技能为准；模型、effort 和启动参数来自[调度配置](config.md)。

```sh
# 1. 在目标项目创建独立 lane，返回 pane ID 和 cleanup 命令
bun <herdr-skill>/scripts/route-lane.ts --type coding-agent --cwd <项目路径> --label 'MMDD｜TYPE｜Topic'

# 2. 生成协作 owner 的启动参数：协作 owner 取 status 中可用、引擎与自己不同的 enabled owner
bun <skill>/scripts/agents-config.ts resolve --owner <自己的-owner-id> --peer <协作-owner-id>

# 3. 启动协作 owner，`--` 之后原样使用 resolve 输出的 argv
herdr agent start owner-<engine-id> --kind <kind> --pane <pane> -- <argv>
```

默认配置下 `resolve` 的 argv 示例（以实际输出为准）：

```sh
herdr agent start owner-codex --kind codex --pane <pane> -- -m gpt-6-astra -c model_reasoning_effort=high
herdr agent start owner-claude --kind claude --pane <pane> -- --model claude-opus-5-5 --effort high --permission-mode bypassPermissions
```

同一任务从讨论、开发到交叉 review 复用同一个协作 owner 会话，以保留上下文。Herdr 不可用、启动失败或没有可用的协作 owner（未配置、disabled、被 block）时，接单 owner 在台账中说明原因，用自己的子 agent 独立完成，不改走其他入口。降级只免除 owner 讨论；分级为必审时不免除 [ChatGPT 审查门槛](#chatgpt-审查门槛)，接单 owner 自己的子 agent 也只在门槛满足后实施依赖该方案的工作。

- 在从未启动过该 CLI 的目录里，两个 CLI 都会先弹出目录信任提示，`agent start` 因此返回 `agent_not_ready`（blocked）；`-c` 配置覆盖和权限参数都跳不过这个提示。处理步骤：先用 `herdr agent read <owner> --source visible` 确认确实是信任提示，再按 CLI 选择信任，信任结果由 CLI 自己持久化：
  - Codex（"Trust this folder?"，默认选项就是 Trust and continue）：`herdr agent send-keys <owner> enter`
  - Claude（"Is this a project you created or one you trust?"，默认选项是 No, exit，直接回车会退出）：`herdr agent send-keys <owner> down`，读屏确认 `❯ Yes, I trust this folder` 后再 `enter`

  之后用 `herdr agent list` 确认状态变为 idle/done，再发 prompt。只信任用户指定的目标项目目录；来源不明的仓库停下来问用户。如果 blocked 不是信任提示，按读屏内容判断，不要盲目按键。
- `route-lane` 需要已验证的调用方 pane。在 Herdr 之外（例如普通 tmux）运行时，归属校验会失败，这时直接走上面的降级路径。

## 消息

消息目录为 `~/.local/state/agents-cooperation/<collab-id>/`，`collab-id` 取 `MMDD-<topic-slug>`，必须唯一：创建前目录已存在且属于其他需求时，追加 `-2`、`-3`；同一需求始终沿用同一 `collab-id` 和 `decision-log.md`。每条消息一个文件，命名为 `NNN-<from>-<type>.md`（如 `003-codex-reply.md`）。

- 消息编号和 reply 文件名由接单 owner 分配并写进信封，协作 owner 不自行扫描编号。
- 消息文件不可覆盖；每版候选或冻结方案完整保存为一个消息文件，修订另存新编号。
- `plan.md` 只是指向当前放行版本的缓存指针，以 `decision-log.md` 的冻结事件为准，指针损坏时从日志重建。
- `decision-log.md` 与消息文件同目录，格式见 [decision-log](#decision-log)。

内容较长时放在文件里，prompt 只带信封和文件路径：

```text
[agents-cooperation]
from: 接单owner (claude_owner claude-opus-5-5, pane <id>)
to: 协作owner (codex_owner gpt-6-astra)
collab: <collab-id>   round: <n>   type: discuss | assign | review | info
project: <项目路径>
read: ~/.local/state/agents-cooperation/<collab-id>/002-claude-discuss.md
reply: ~/.local/state/agents-cooperation/<collab-id>/003-codex-reply.md
log: ~/.local/state/agents-cooperation/<collab-id>/decision-log.md   （仅接单 owner 维护，协作 owner 只读）
你是协作 owner：按 agents-cooperation 协作 owner 职责处理，回复写入 reply 文件后结束本轮。
```

发送与收取：

```sh
herdr agent prompt <owner> "<信封>" --wait --until idle --until done --until blocked --timeout 1800000
# 结束后读取 reply 文件；文件缺失时用 herdr agent read <owner> --source recent 查看原因
```

单轮等待超时，或 Agent 停在 `blocked`，要先读取输出判断原因；不要盲目重发同一条 prompt。

协作 owner 完成时不会主动通知接单 owner。接单 owner 发出 prompt 后，如果自己还要继续其他工作，就把 `herdr agent wait <owner> --until idle --until done --until blocked` 放到宿主的后台任务里运行（Claude Code 用 `run_in_background`），等待结束时会自动唤醒，不必靠心跳去发现协作 owner 已经完成。

## type 约定

| type | 协作 owner 的回复内容 |
| --- | --- |
| `discuss` | 对方案的意见、风险、替代方案，以及赞成或反对的明确结论 |
| `assign` | 冻结的方案文档路径和本侧工作包；依赖讨论方案时携带已放行方案引用（不可变消息文件路径），没有引用不得实施。回复每个包的状态、改动文件、验证结果和风险。完成前可写进度文件 `NNN-<from>-progress.md` |
| `review` | diff 范围（commit 区间或文件列表）和方案文档；按严重度列出 findings，写明文件、行号和失败场景，不直接修改对方代码 |
| `info` | 状态同步或取消通知，不得请求新的方案判断；请求判断即计为一轮 `discuss`。取消时协作 owner 要停止自己的子 agent，并回报部分产物 |

## 协作 owner 守则

- 先用 `show` 找到自己引擎对应的 owner，只在 `assign` 给定的写入范围内按配置调度自己的子 agent（`resolve` 取参数、受自己的 `max_parallel` 约束）完成改动，自己不改项目文件；需要越界时写进回复，不自行扩大。额度耗尽按 SKILL.md 的“额度耗尽”执行 `block` 并改派，在回复中写明。
- 不提交、不推送、不关闭非自己创建的资源，也不直接与用户沟通。如果用户在协作 owner 的 pane 中直接下达指令：属于当前协作需求的追加或变更，先记录并交接单 owner 判定依赖和门槛状态，再按其回复执行；与当前需求无关的普通实施指令照常派子 agent 执行，并在下一次回复中告知接单 owner。普通实施指令不视为必审方案的 ChatGPT 审查豁免。
- 回复以结论开头，不依赖终端输出传递关键信息。

## ChatGPT 审查门槛

本节适用于分级为必审的方案（含升级后的）：owner 讨论之后必须经过 ChatGPT 方案审查，接单 owner 处置意见并冻结后才能实施直接依赖该方案的工作；免审方案不送审，不适用本节。门槛是“完成必需审查并处置意见”，不是“取得模型同意”。预算上限见 SKILL.md 的方案讨论一节，本节写计数、等待、裁决和留痕细则。

### 计数

owner 讨论按接单 owner 发出的一次新的实质讨论请求计一轮；交叉 review 按同一集成审查对象的一次双向 review 计一轮，不按侧或按工作包分别计。二者同样先在日志占号，但不需要 task/run 绑定。

ChatGPT 阶段一轮 = 一次新的实质送审（方案审查对应一版方案，结果校验对应一版结果）。每轮按以下顺序推进，各步在 `decision-log.md` 追加事件：

1. **占号**：发出请求前记“占号”事件，写明阶段和轮次。
2. **提交并绑定**：发送后追加 Convorel task ID、run ID。占号后中断不退还；提交状态不明时，先按同 task/run 恢复核对，不另起请求。
3. **完整读取**：run complete 不等于审查完成；未取得完整可读回复不得裁决。
4. **处置**：逐条 finding 记录采纳、驳回或接受风险及依据。
5. **关闭或阻塞**：处置完成则关闭本轮；否则标阻塞并保留恢复位置。

修订、换 revision、换会话、换 collab 显示名、重派协作 owner 都不重置计数；同一请求的等待、读取、恢复、补归档不计轮。预算为零时只能裁决、阻塞或结束，普通调度不自动升级为远端结果校验。

自动等待设停止条件：到期则标阻塞并保留恢复位置，不反复起 watcher；停止等待不等于取消，也不等于通过。

### 裁决

- 任一轮可依据本地证据驳回误报。
- 末轮之后接单 owner 可：落实已识别问题的修订、驳回、在授权范围内接受残余风险、选择送审上下文中已出现的替代方案。
- 替换核心方案或使原审查关键前提失效，视为新受审候选，占用原预算；预算不足则阻塞，或取得用户明确豁免。审查结论不自动继承到后续版本。
- 轮次耗尽本身不是实施依据；违反用户验收要求的问题不能靠“接受风险”放行；缺失的用户授权、破坏性操作确认、材料可发送范围、权限限制不可被裁决覆盖；需改变目标或范围时交用户。
- 台账状态列沿用现有枚举；“ChatGPT 未通过·接单 owner 裁决”写进最近进展/风险列，不写成已通过。

### 调用方式

- 每轮通过 `chatgpt-review` 发起一次送审，按“占号 → 送审并绑定 → 完整读取 → 处置 → 关闭或阻塞”推进；同一需求复用同一个 Convorel task。
- 本流程内是否修订、再审、占用哪个预算，只由上文预算和接单 owner 决定；收到“未通过”或“证据不足”不自动再发，按[裁决](#裁决)处理。
- 送审请求区分用户已确认的目标、接单 owner 方案和未决问题；目标、范围或关键取舍未定时先问用户，不用审查结论代替用户确认。

### Convorel 阻塞与送审材料

- Convorel 缺失、登录或人工验证阻塞：标阻塞，等用户处理或明确豁免；不自动免除、不换模型、不重发。用户明确要求仅本地处理时不发送，日志记录该例外。
- 私有消息目录不在 MCP roots 内，方案正文经 stdin 送审，不为此扩大 roots。
- 源码快照：每轮源码证据均记录受审仓库绝对路径和固定基线 commit。脏工作区快照由该基线 commit、已保存的相关 diff 和所需未跟踪文件内容组成，并记录可恢复的快照引用。实际工具读取须能关联到相应版本或内容证据；无法确认其与送审快照对应关系的范围标为未知，不将“已提交材料”记为“实际已审阅全部材料”。只记文件范围或 hash 不算快照。
- 送审定位记录 Convorel task ID、run ID，以及读取的 prompt/reply 内容 version ID（`conversation history` 返回）；正文不复制进日志。

### 状态处置

- 回复版本复核同样受本任务既定的等待/恢复停止条件约束。结束门槛前核对当前回复版本与实际完整读取并处置的版本一致；发生变化（含 finish 报告 `replyChanged`）时读取新版本并追加处置（同 run，不计轮）。新版本不可读，或达到停止条件后仍持续变化时，标阻塞并保留实际已读版本和恢复位置，不无限追读，也不按旧版本结论放行。
- 正文已保存而仅命名等整理待完成：可记录缺口后裁决。正文未捕获或保存失败：不得声称留痕完整。补档不重发请求。
- 门槛不改变“owner 不亲自改文件”的规则。

## decision-log

`~/.local/state/agents-cooperation/<collab-id>/decision-log.md` 由接单 owner 维护，分三层。

**1. 任务头**（写一次）：`collab-id`、接单 owner、目标与验收、用户授权依据、ChatGPT 分级与依据、预算与规则版本、实际 Convorel state-dir（解析后的绝对路径）。

**2. 事件**（只追加），每条含：序号、带时区时间、事件类型、阶段·轮次、参与者·实际模型（无法核验写“未核验”）、输入与回复定位、原判断、源码快照引用（仓库路径 + 基线 commit + diff/未跟踪文件）、finding 处置（只记变化）、证据与状态变化。

- 事件类型：分级、升级、占号、提交、读取、处置、版本变化、阻塞、冻结，必要时补充豁免、恢复。
- ChatGPT 送审事件单列三个独立状态：run complete、Markdown 捕获、归档，以及 finish 回执的 `organizationPending`、`replyChanged`；未知记“未知”。
- finding 首次出现时分配需求内唯一编号，含发现阶段前缀、原轮次与序号：`P` = ChatGPT 方案审查、`V` = ChatGPT 结果校验、`D` = owner 讨论、`X` = 交叉 review；`B` 阻断、`S` 建议，如 `P1-B3`、`V1-S2`。后续跨轮、跨阶段处置沿用首次编号；新问题不得复用，严重度变化不重新编号。

**3. 冻结/收尾**：放行版本、相对最后受审版本的差异及依据、未决风险、接单 owner 裁决与授权依据、证据完整性、允许解锁的依赖工作。

模板示例：

```markdown
# decision-log: 1015-example-topic

## 任务头
- collab-id: 1015-example-topic
- 接单 owner: claude_owner（claude-opus-5-5）
- 目标与验收: <一句话>
- 用户授权依据: <消息或指令引用>
- ChatGPT 分级与依据: 必审——<命中的条件>
- 预算与规则版本: 讨论 3 / 交叉 review 2 / 方案审查 2 / 结果校验 2；peer-protocol <commit>
- Convorel state-dir: /home/<user>/.local/share/convorel

## 事件
| # | 时间 | 类型 | 阶段·轮次 | 参与者·模型 | 输入 / 回复 | finding 处置与状态 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 2026-10-15T09:00+08:00 | 占号 | ChatGPT 方案审查·1 | 接单 owner | 003-claude-plan.md | 预算 1/2 |
| 2 | 2026-10-15T09:02+08:00 | 提交 | ChatGPT 方案审查·1 | 未核验 | task <id> / run <id> | 已绑定；快照 <仓库路径>@<基线 commit> + diff 003-claude-plan.diff |
| 3 | 2026-10-15T09:20+08:00 | 读取 | ChatGPT 方案审查·1 | 未核验 | reply version <id> | complete / captured / stored；replyChanged=false；organizationPending=未知 |
| 4 | 2026-10-15T09:30+08:00 | 处置 | ChatGPT 方案审查·1 | 接单 owner | reply version <id> | P1-B1 采纳；P1-B3 驳回（本地证据：<路径>） |

## 冻结
- 放行版本: 005-claude-plan-v2.md
- 相对最后受审版本的差异: <无 / 差异及依据>
- 未决风险: <列表>
- 接单 owner 裁决与授权依据: <内容>
- 证据完整性: <完整 / 缺口>
- 允许解锁的依赖工作: <工作包>
```

消息目录、其中引用的 Convorel 内容版本和源码快照是持久证据，收尾时不回收。
