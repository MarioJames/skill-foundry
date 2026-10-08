# 子 Agent 交接与复验

父 Agent 派发、续接或接管验收时读取。使用当前宿主自带的 subagent 工具，不通过 shell、JSON-RPC runner 或 Herdr 模拟 subagent。本技能中的 `bh.ts` dispatcher 仍是环境和采证工具，与 Agent 调度无关。

## 首次派发

按当前宿主选择工具和模型；参数名以实际工具契约为准，下列只是对应关系：

| 宿主 | 工具 | 模型 | 上下文 | 续接 |
| --- | --- | --- | --- | --- |
| Codex | 官方 subagent（`spawn_agent`） | `model="gpt-6.1-sol"`、`reasoning_effort="medium"` | `fork_turns="none"`；覆盖模型时不能用完整历史 `all` | `followup_task`；运行中补充用 `send_message` |
| Claude Code | `Agent` 工具新建 subagent（如 `general-purpose`） | `model="sonnet"` | 新建 Agent 不带父对话；不用 `fork`，它会忽略模型覆盖 | 对同一 Agent ID/名称用 `SendMessage` |

Codex 示例：

```json
{
  "task_name": "browser_acceptance",
  "model": "gpt-6.1-sol",
  "reasoning_effort": "medium",
  "fork_turns": "none",
  "message": "按下方交接要求执行浏览器验收；你是受委派执行者，直接读取指定的 browser-harness/SKILL.md 并执行，不再派发。此处填入本轮完整交接内容。"
}
```

Claude Code 示例：

```json
{
  "description": "Browser acceptance",
  "subagent_type": "general-purpose",
  "model": "sonnet",
  "prompt": "按下方交接要求执行浏览器验收；你是受委派执行者，直接读取指定的 browser-harness/SKILL.md 并执行，不再派发。此处填入本轮完整交接内容。"
}
```

两种宿主的子 Agent 都不带父对话历史，交接必须自包含；不要为了少写交接而依赖父对话，其中可能没有原始验收标准。Claude Code 的 subagent 在后台运行，完成后会通知父 Agent；未收到结果前不预判结论，也不重复派发。

在交接内容（Codex `message` / Claude Code `prompt`）中给出实际已知值、缺失条件和允许的准备动作：

- **目标与标准：** 本轮要验证的用户需求、绝对项目目录、target、代码版本或未提交变更范围、关键页面、操作步骤、预期结果、失败路径及所需证据。注明哪些内容已经验证、哪些仍待验证。
- **执行环境：** 实际技能绝对路径、项目指令、启动/测试命令、已准备的 `APP_URL` 与成功 prepare 结果路径；尚未 prepare 时明确由子 Agent 准备并报告真实地址。不要猜 URL。
- **浏览器与登录：** 本任务 session、profile 名称及绝对路径、profile 所有者与保留要求、已核实的 Chromium 路径、无头设置、账号角色及授权凭据的读取位置。未建立的会话由子 Agent 按技能创建并回报；不把凭据正文写入报告。
- **权限与资源：** 允许的测试数据写入和禁止动作、已存在与本任务创建的服务/PID/端口、浏览器和清理所有者、证据保存位置，以及用户已要求的服务保留或远程走查。父 Agent 拥有主 tab 命名与 Git 提交权。

验收期间固定被测版本；父 Agent 可推进无冲突工作，不同时修改被测行为、测试数据或操作同一 session/profile。若必须修改，先停止验收并确认执行已停，再交接新版本，旧结果不能证明新版本通过。

已有成功 prepare 结果时核对 URL、PID 与 target 后直接复用；服务清理权随交接明确移交或仍由父 Agent 持有。借用用户服务时只使用其 URL，不运行该项目 target 的 prepare/cleanup。这两个命令按项目状态操作，会停止同 target 的服务，不能因换了 Agent 就重新执行。资源状态无法确认时先回报缺失事实，由父 Agent 查清归属；服务不可用且明确允许重建后才重新 prepare，并更新交接结果。

## 上下文与浏览器状态

子 Agent 的对话、shell 环境、浏览器状态是不同资源。共享文件系统或对话续接不保证 cwd、环境变量、服务或页面仍存在；每批命令显式设置 cwd，并重载本任务已核实的 session/profile、Chromium 路径和成功 prepare 结果。

同一 session/profile 同时只有一个执行者。复用已有资源须显式移交归属；不能把借用的用户服务视为本任务创建。登录态按原技能规则持久保留，临时 DOM 引用在页面改变或会话重开后重新获取。浏览器已关闭时，复验重新打开并执行必要步骤，不能宣称恢复了关闭前的瞬时状态。

新建任务 profile 时设置 `BH_DEFAULT_PROFILE` 为任务唯一名称，再通过 `profile-dir "$BH_DEFAULT_PROFILE"` 取得 `AGENT_BROWSER_PROFILE`；每批同时保留这两个变量与 session，使 bh login/collect-evidence 和直接 agent-browser 命令使用同一路径。复用已登录 profile 时沿用交接的名称/路径，并取得独占使用权，不另建空 profile 丢失登录态。无参 profile-dir 的工具默认值是项目共享 profile，不能据此认定为本任务自有；禁止并行打开同一 profile，关闭不删除登录态。

## 结果与继续工作

子 Agent 返回：

- 本轮版本、实际 `APP_URL`、各验收项的通过/失败/未执行及原因。
- 失败复现步骤、截图与 console/network 证据的精确路径，`artifact_errors` 和缺失证据；不以工具退出成功代替业务通过。
- 本轮创建或借用的服务、浏览器和验证进程，精确 PID/端口/session/profile、已完成的清理，以及保留原因和接管条件。按主技能默认清理自有进程、保留证据与持久登录态。

父 Agent 检查证据后确认结果；需要补采或修复后复验时，优先续接同一 Agent：Codex 用 `followup_task`，运行中的信息补充可用 `send_message`，但它不会唤醒空闲 Agent，不能代替续接工具；Claude Code 对同一 Agent ID/名称用 `SendMessage`，它保留原上下文，新建 `Agent` 调用则从零开始。

每次续接明确本轮变更、当前代码版本、复验范围、仍有效的标准，以及最新资源/登录状态。子 Agent 的旧对话不自动包含父 Agent 后来的修改与用户指令；新增或撤销的要求必须同步，不沿用已失效的通过结果。

原 Agent 不可续接时，确认其不再操作资源，再按同一宿主的首次派发参数创建新 Agent；重传完整交接，并附前轮结果、证据路径、未完成事项和资源归属。不要只说“继续上一轮”。

需要人工登录、额外权限或缺少关键预期时，子 Agent 返回准确阻塞和已完成结果，由父 Agent 处理后续接。子 Agent 中断或失联不等于资源已释放；父 Agent 接管并核对精确自有资源，保留失败证据，不宽泛杀进程或清空数据。
