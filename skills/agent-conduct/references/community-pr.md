# 社区 PR：从创建到合并

向 LobeHub 社区仓库（`lobehub/lobehub`，目标分支 `canary`）提交和跟进 PR 时按本文执行。PR 的内容和格式以仓库自己的 `AGENTS.md`、`pr` 技能和 PR 模板为准，本文只规定它们之外的流程：谁决定、何时算可以合并、每种状况怎么处理。

`<skill-dir>` 指本技能目录，`PR` 可以写 PR 号或链接。

## 分工

- 创建 PR 前，把准备提交的改动范围和标题告诉用户，用户同意后才创建。
- 代为合并须有用户在当前对话中的明确授权。上下文能确定授权覆盖哪些 PR 时即可执行。合并前须让 `check` 达到门槛。
- 自己开的 PR 默认盯到合并或关闭，不等用户提醒。
- 把跟进交给别的 Agent 时，交接里写明 PR 链接、worktree 路径、当前 `check` 输出和本文路径，确认对方已经启动 `watch` 后才算交出。

## 合并门槛

门槛只认 `check` 的输出，三项同时成立：

- 最新提交上的 CI 全部完成且没有失败、取消或超时；跳过的检查项不算问题。本地测试和其他 Agent 的审查都不能替代。
- Codex 对最新提交评审完毕，没有未解决的意见，并给出 👍。之前提交上的 👍 不算数。
- 没有未解决的评审线程，没有待回应的人工评论。

```bash
bun <skill-dir>/scripts/community-pr.ts check <PR>
```

`check` 只读。退出码 0 表示达到门槛或已合并，10 有事项要处理，11 仍在等待，12 未合并就被关闭；`--help` 查看全部参数。

`check` 同时判定 PR 形态（普通 PR、目标分支）、是否冲突，以及标题、正文和本人评论能否公开；它列出的每一项都要处理，不凭印象或网页上的图标自行判断「应该可以了」。

## 创建

- 从最新 `canary` 用 `wt.ts add` 起 worktree，分支名按仓库约定 `<type>/<feature-name>`。一个 PR 只做一件事。
- 推送前按仓库 `AGENTS.md` 自查：`bun run check`，缺陷修复带一个修复前失败、修复后通过的回归测试，需要产品验收的改动先有验收链接。Codex 会按这些要求评审，漏掉就多一轮。
- 按仓库 `pr` 技能创建普通 PR，不开 Draft：Codex 只在 PR 创建、标为 ready 或被请求时评审。
- 只写社区版的问题和改动。内部、客户或租户的名称、链接、数据、验收材料和对话内容不进标题、正文、评论、提交信息和代码注释。
- 正文写最终改动和验证证据，不写过程：不解释自己复用了哪些旧证据、变基后重跑了什么、哪些话没有说。
- 创建后立刻运行一次 `check`，把内容类问题在评审开始前改掉。

## 跟进

用 `watch` 等待，它在有事要处理、达到门槛、被合并或关闭时退出；退出码 11 表示超时，重新启动即可。不写自己的轮询脚本，不用 `sleep` 循环。

**`watch` 退出并处理完之前，不结束本轮回复。** 本轮一结束就没人读 `watch` 的退出结果：Codex（包括在 LobeHub 里运行的 Codex）在后台进程退出时不会唤醒你，评审意见到了也只会躺在那里，直到用户来问。所以：

- 只有宿主保证进程退出时会唤醒你，才把 `watch` 放后台并结束本轮，例如 Claude Code 的 `run_in_background`。
- 其他宿主一律前台运行，并持续读取输出直到进程退出。Codex 的做法是用 `write_stdin` 空输入反复轮询同一个会话。等待期间可以发进度说明，但不发最终回复，也不写「后台已启动跟踪」这类收尾。
- `ready` 时按下表处理已有授权。遇到 `closed`、本文规定要交用户裁定的情况或需要用户拍板方向或范围的评论时，可结束本轮。

```bash
bun <skill-dir>/scripts/community-pr.ts watch <PR>                  # 等到有事或达到门槛
bun <skill-dir>/scripts/community-pr.ts watch <PR> --until merged   # 达到门槛后继续等合并
```

| `watch` 报告 | 处理 |
| --- | --- |
| `ci` 未通过 | 读失败日志，先判断是否由本 PR 引起。是，就修复并推送。不是（偶发失败、基础设施问题），用 `gh run rerun <run-id> --failed` 重跑；同一项连续两次失败就停下告知用户。不为变绿改无关代码、跳过用例或放宽断言 |
| `codex` 有意见，或 `threads` 未解决 | 逐条判断。成立的修复，并按仓库要求补测试；不成立的写明理由。然后逐条 `reply --resolve` |
| `codex` 结论不覆盖最新提交 | `request-review` |
| `comments` 待回应 | 回复对方的问题。涉及方向或范围取舍的先问用户。人工评审者开的线程回复后不加 `--resolve`，留给对方关闭 |
| `mergeable` 有冲突 | 把最新 `canary` 合并进分支后推送。PR 以 squash 合入，不需要 rebase，也不强推 |
| `content` 需要修改 | 标题和正文用 `gh pr edit <PR> --title … --body-file …`；评论用 `gh api -X PATCH repos/<owner>/<repo>/issues/comments/<id> -F body=@<文件>`，线程里的回复把 `issues/comments` 换成 `pulls/comments` |
| `ready` | 已授权就按「代为合并」执行，核验合并结果，再继续用户要求的后续操作。尚未授权就把 PR 链接和 `check` 输出交给用户合并。宿主能在进程退出时唤醒你，就在后台运行 `watch --until merged`；否则下次回到会话时先运行 `check`，已合并就按下一行回收 |
| `merged` | 用 `wt.ts remove` 回收 worktree 和本地分支；远端分支还在时用 `branch.ts` 清理 |
| `closed` | 停下，把关闭的情况告诉用户，不重开、不另建 PR |

处理评审意见时：

- 一轮意见全部处理完再推送一次。每推一次都会重跑 CI 并需要重新评审。
- 修复用新提交追加，不 amend、不强推，评审者要能看到增量。
- 推送后必须 `request-review`：Codex 不会自动评审新提交。脚本只发送 `@codex review` 这一句，不附说明；已有覆盖最新提交的评审或待响应的请求时自动跳过。
- 回复写在哪个提交里怎么改的，或为什么不改，一两句即可。

```bash
bun <skill-dir>/scripts/community-pr.ts reply <PR> --thread <线程 ID> --body-file <文件> --resolve
bun <skill-dir>/scripts/community-pr.ts request-review <PR>
```

- `canary` 前进但没有冲突时不动分支，不为「保持最新」反复合并和推送。
- 同一条意见和 Codex 来回两轮仍不一致，或 Codex 没有新意见却迟迟不给 👍（`request-review --force` 之后仍然如此），停下交用户裁定。

## 代为合并

获得「分工」规定的授权后，重新运行 `check`，结果为 `ready` 时用它输出的提交号合并，提交在此期间变化则合并会被拒绝。不开 auto-merge。

```bash
gh pr merge <PR> --repo lobehub/lobehub --squash --match-head-commit <check 输出的完整提交号>
```
