# 主/副 Agent 协作协议

两个主级 Agent 通过 Herdr pane 和消息文件进行文字协作。只有主 Agent 向对方 pane 发送 prompt；副 Agent 把回复写入文件后结束本轮，不向主 Agent 的 pane 注入输入。

## 启动副 Agent

Herdr 的 tab 命名、归属校验和清理规则以 `herdr` 技能为准。

```sh
# 1. 在目标项目创建独立 lane，返回 pane ID 和 cleanup 命令
bun <herdr-skill>/scripts/route-lane.ts --type coding-agent --cwd <项目路径> --label 'MMDD｜TYPE｜Topic'

# 2. 启动副 Agent（主 Agent 是 Claude 时启动 Codex，反之亦然）
herdr agent start peer-codex --kind codex --pane <pane> -- -m gpt-6-astra -c model_reasoning_effort=high
herdr agent start peer-claude --kind claude --pane <pane> -- --model claude-opus-5-5 --effort high --permission-mode bypassPermissions
```

同一任务从讨论、开发到交叉 review 复用同一个副 Agent 会话，以保留上下文。Herdr 不可用或启动失败时，主 Agent 在台账中说明原因，用自己的 worker 独立完成，不改走其他入口。

- 在从未启动过该 CLI 的目录里，两个 CLI 都会先弹出目录信任提示，`agent start` 因此返回 `agent_not_ready`（blocked）；`-c` 配置覆盖和权限参数都跳不过这个提示。处理步骤：先用 `herdr agent read <peer> --source visible` 确认确实是信任提示，再按 CLI 选择信任，信任结果由 CLI 自己持久化：
  - Codex（"Trust this folder?"，默认选项就是 Trust and continue）：`herdr agent send-keys <peer> enter`
  - Claude（"Is this a project you created or one you trust?"，默认选项是 No, exit，直接回车会退出）：`herdr agent send-keys <peer> down`，读屏确认 `❯ Yes, I trust this folder` 后再 `enter`

  之后用 `herdr agent list` 确认状态变为 idle/done，再发 prompt。只信任用户指定的目标项目目录；来源不明的仓库停下来问用户。如果 blocked 不是信任提示，按读屏内容判断，不要盲目按键。
- `route-lane` 需要已验证的调用方 pane。在 Herdr 之外（例如普通 tmux）运行时，归属校验会失败，这时直接走上面的降级路径。

## 消息

消息目录为 `~/.local/state/agents-cooperation/<collab-id>/`，`collab-id` 取 `MMDD-<topic-slug>`。每条消息一个文件，命名为 `NNN-<from>-<type>.md`（如 `003-codex-reply.md`）。内容较长时放在文件里，prompt 只带信封和文件路径：

```text
[agents-cooperation]
from: 主agent (claude-opus-5-5, pane <id>)
to: 副agent (codex gpt-6-astra)
collab: <collab-id>   round: <n>   type: discuss | assign | review | info
project: <项目路径>
read: ~/.local/state/agents-cooperation/<collab-id>/002-claude-discuss.md
reply: ~/.local/state/agents-cooperation/<collab-id>/003-codex-reply.md
你是副 Agent：按 agents-cooperation 副 Agent 职责处理，回复写入 reply 文件后结束本轮。
```

发送与收取：

```sh
herdr agent prompt <peer> "<信封>" --wait --until idle --until done --until blocked --timeout 1800000
# 结束后读取 reply 文件；文件缺失时用 herdr agent read <peer> --source recent 查看原因
```

单轮等待超时，或 Agent 停在 `blocked`，要先读取输出判断原因；不要盲目重发同一条 prompt。

副 Agent 完成时不会主动通知主 Agent。主 Agent 发出 prompt 后，如果自己还要继续其他工作，就把 `herdr agent wait <peer> --until idle --until done --until blocked` 放到宿主的后台任务里运行（Claude Code 用 `run_in_background`），等待结束时会自动唤醒，不必靠心跳去发现副 Agent 已经完成。

## type 约定

| type | 副 Agent 的回复内容 |
| --- | --- |
| `discuss` | 对方案的意见、风险、替代方案，以及赞成或反对的明确结论 |
| `assign` | 冻结的方案文档路径和本侧工作包；回复每个包的状态、改动文件、验证结果和风险。完成前可写进度文件 `NNN-<from>-progress.md` |
| `review` | diff 范围（commit 区间或文件列表）和方案文档；按严重度列出 findings，写明文件、行号和失败场景，不直接修改对方代码 |
| `info` | 状态同步或取消通知；取消时副 Agent 要停止自己的 worker，并回报部分产物 |

## 副 Agent 守则

- 只在 `assign` 给定的写入范围内工作，并调度自己的 worker；需要越界时写进回复，不自行扩大。
- 不提交、不推送、不关闭非自己创建的资源，也不直接与用户沟通。如果用户在副 Agent 的 pane 中直接下达指令，照常执行，并在下一次回复中告知主 Agent。
- 回复以结论开头，不依赖终端输出传递关键信息。
