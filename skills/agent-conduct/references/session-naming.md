# 会话命名细则

命名本身只需要 SKILL.md 里那一条命令。遇到下面的情况才读本文：输出里有 `skipped` 或 `failed`、要给子 Agent 或新标签页交接命名归属、任务调度派发的话题。

## 输出

stdout 输出 JSON：`label`、`named`，以及 `targets` 里每个目标的 `status`（`named`、`unchanged`、`dry-run`、`skipped`、`failed`）。每次写入都读回核对；写入超时或读回不一致时不重放，读一次现状后报告。

`named` 为 `false`（没有可写且归属本次运行的标题）时保留原标题，在回复里简短说明。

## 宿主

| 宿主 | 识别 | 写入 |
| --- | --- | --- |
| LobeHub | `LOBEHUB_TOPIC_ID` 与 `LOBEHUB_OPERATION_ID` | 同时满足两点才用 `lh topic edit` 改话题标题：话题的 `metadata.runningOperation.operationId` 等于本次运行的 `LOBEHUB_OPERATION_ID`；进程链没有显示这份身份是继承来的。后者指：话题已记录 `metadata.heteroSessionId` 时，它要等于最内层 Agent 自己的会话 ID（`CLAUDE_CODE_SESSION_ID` 或 `CODEX_THREAD_ID` 中，在离本进程最近的一层引入的那个）；在 Linux 上，`LOBEHUB_OPERATION_ID` 沿祖先进程最多延续到该 Agent 的父进程，也就是启动它的 LobeHub 进程。在 LobeHub 运行里启动的 Herdr、tmux 这类长驻宿主会把运行身份传给后来在里面启动的 Agent，而祖先运行仍在进行，只比运行编号挡不住，这时记为 `skipped`（`session_mismatch`、`inherited_operation`）。祖先 Agent 的环境被继承、群组里共享话题的成员、运行已结束等情况同样记为 `skipped`，不写入，再按下面几行判断。此时不命名 Herdr 标签页：承载 LobeHub 守护进程的终端不是这个会话 |
| Codex | `CODEX_THREAD_ID`，本机 Codex app-server daemon 在运行 | 改该线程的原生标题。不为命名启动 daemon；`CODEX_SESSION_ID` 可能指父会话，不能代替 |
| Claude Code | `CLAUDE_CODE_SESSION_ID` | 没有可写的标题接口，只从会话记录取 `createdAt`，供 Herdr 标签页使用 |
| Herdr | `HERDR_PANE_ID`，同级装有 herdr 技能 | 用上面得到的标题调用 herdr 的 `name-tab.ts`，只有能证明标签页属于本进程时才改名，证明失败记为 `failed`，任务照常继续 |

## 归属与特殊来源

- **按当前任务直接设置。** 不管现有标题是谁设的、看起来是否已经像样，也不征求确认；宿主自动生成的标题不合规范时立即修正。只改标题，不动项目、分组、顺序、置顶和归档状态。
- **任务调度发起的运行同样命名。** LobeHub 任务派发的话题（输出里 `trigger` 为 `task`、带 `taskId`）初始标题通常是派发提示词或任务原标题，开始工作前照常改名。Topic 写这次任务的具体目标，可以带任务编号，例如 `1115｜FIX｜T-123 图片上传失败`；不照抄「由 T-xxx 调度派发……」这类提示词。只改话题标题，不改任务本身。
- **命名归会话的所有者。** 归属看交接内容，不看焦点、pane 数量或 Agent 类型。子 Agent、fork、Weaver worker 可能继承父会话的环境变量，不改父会话的标题，除非交接里明确交给它；它有自己独立的话题、线程或标签页时，按交接里的任务命名自己的。新建目标标签页的一方负责初始命名（herdr 的 `route-lane.ts --label`），交接里写明自己的 caller、目标 ID 和命名归属。
