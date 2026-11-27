# 社区 PR：从创建到合并

向 `lobehub/lobehub`（目标分支 `canary`）提交和跟进 PR 时按本文执行。PR 的内容和格式以仓库自己的 `AGENTS.md`、`pr` 技能和 PR 模板为准。`<skill-dir>` 指本技能目录，脚本的参数和退出码看 `community-pr.ts --help`。

## 分工

- 创建前把改动范围和标题告诉用户，同意后才创建。
- 代为合并须有用户在当前对话中的明确授权，上下文能确定授权覆盖哪些 PR 时即可执行。
- 自己开的 PR 盯到合并或关闭，不等用户提醒。
- 交给别的 Agent 跟进时，交接里写明 PR 链接、worktree 路径、当前 `check` 输出和本文路径，确认对方已启动 `watch` 才算交出。

## 合并门槛

```bash
bun <skill-dir>/scripts/community-pr.ts check <PR>
```

只认 `check` 的输出，它列出的每一项都要处理。之前提交上的 👍、本地测试和其他 Agent 的审查都不算。

## 创建

- 从最新 `canary` 用 `wt.ts add` 起 worktree，分支名 `<type>/<feature-name>`，一个 PR 只做一件事。
- 推送前按仓库 `AGENTS.md` 自查：`bun run check`；缺陷修复带一个修复前失败、修复后通过的回归测试；需要产品验收的先有验收链接。
- 开普通 PR，不开 Draft。
- 只写社区版的问题和改动，全部用英文。内部、客户或租户的名称、链接、数据和对话内容不进标题、正文、评论、提交信息和代码注释。
- 正文写最终改动和验证证据，不写过程。
- 创建后立刻运行一次 `check`。

## 跟进

```bash
bun <skill-dir>/scripts/community-pr.ts watch <PR> [--until merged]
```

用 `watch` 等待，不写轮询脚本；超时就重新启动。**`watch` 退出并处理完之前不结束本轮回复。** 只有宿主保证进程退出时会唤醒你（如 Claude Code 的 `run_in_background`）才放后台；其他宿主前台运行并持续读输出，Codex 用 `write_stdin` 空输入轮询同一个会话。等待期间可以发进度，不发最终回复。

| `watch` 报告 | 处理 |
| --- | --- |
| `ci` 未通过 | 读失败日志。由本 PR 引起就修复并推送；不是就 `gh run rerun <run-id> --failed`，同一项连续两次失败停下告知用户。不为变绿改无关代码、跳过用例或放宽断言 |
| `codex` 有意见，或 `threads` 未解决 | 逐条判断：成立的修复并补测试，不成立的写明理由，然后逐条 `reply --resolve` |
| `codex` 结论不覆盖最新提交 | `request-review` |
| `comments` 待回应 | 回复对方的问题，涉及方向或范围取舍的先问用户。人工评审者开的线程回复后不加 `--resolve` |
| `mergeable` 有冲突 | 把最新 `canary` 合并进分支后推送，不 rebase，不强推 |
| `content` 需要修改 | 标题和正文用 `gh pr edit <PR> --title … --body-file …`；评论用 `gh api -X PATCH repos/<owner>/<repo>/issues/comments/<id> -F body=@<文件>`，线程里的回复把 `issues/comments` 换成 `pulls/comments` |
| `ready` | 已授权就按「代为合并」执行并核验结果；未授权就把 PR 链接和 `check` 输出交给用户。宿主能唤醒时后台运行 `watch --until merged`，否则下次回到会话先运行 `check` |
| `merged` | `wt.ts remove` 回收 worktree 和本地分支，远端分支还在时用 `branch.ts` 清理 |
| `closed` | 停下告诉用户，不重开、不另建 PR |

处理评审意见：

- 一轮意见全部处理完再推送一次，修复用新提交追加，不 amend、不强推。
- 推送后必须 `request-review`，Codex 不会自动评审新提交。
- 回复写在哪个提交里怎么改的，或为什么不改，一两句即可。
- `canary` 前进但没有冲突时不动分支。
- 同一条意见和 Codex 来回两轮仍不一致，或 `request-review --force` 之后仍迟迟不给 👍，停下交用户裁定。

```bash
bun <skill-dir>/scripts/community-pr.ts reply <PR> --thread <线程 ID> --body-file <文件> --resolve
bun <skill-dir>/scripts/community-pr.ts request-review <PR>
```

## 代为合并

获得授权后重新运行 `check`，结果为 `ready` 时用它输出的提交号合并，不开 auto-merge：

```bash
gh pr merge <PR> --repo lobehub/lobehub --squash --match-head-commit <check 输出的完整提交号>
```
