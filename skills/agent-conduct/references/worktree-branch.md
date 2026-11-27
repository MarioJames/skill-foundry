# Worktree 与分支

需要隔离工作树，或任务分支合入后要清理本地和远端分支时读本文。脚本的参数和判定以各自的 `--help` 为准。

## Worktree

需要和主工作树隔离时（并行任务、主工作树有别人的改动、要在另一个基线上验证）用 worktree。不用 CoW：它不支持子模块，在 ext4 上每个基线都是完整拷贝，成果还要导出 bundle 再合回来。

```bash
bun <skill-dir>/scripts/wt.ts add --repo <主仓库> --name <任务名> [--branch <分支>] [--base <提交>]
bun <skill-dir>/scripts/wt.ts remove --path <worktree>
bun <skill-dir>/scripts/wt.ts gc --workspace <工作区根>... [--apply]
```

- **`add` 建好就能用。**
  - 位置固定在 `~/.local/share/worktrees/<仓库名>/<任务名>`（`AGENT_WORKTREE_ROOT` 可改），在仓库和工作区之外。
  - 默认先从 origin 读取实际的默认分支并 fetch，从它新建 `wt/<任务名>` 分支；本地 `origin/HEAD` 可能过期，不作依据。连不上 origin 时退回本地记录，并在输出的 `baseNote` 中说明。不从主工作树当前检出的分支起步，那常常是别人进行中的工作。按项目分支命名时传 `--branch`。
  - 链接主仓库的 `.env`，任务差异写 `.env.local`，不改链接目标。
  - 子模块从主仓库的本地副本检出，没有对应提交时才走远端。
  - 按锁文件离线安装依赖；pnpm 从 store 硬链接，通常几秒完成。
  - stdout 输出 JSON，`cwd` 就是工作目录。
- **改用 `add`，不要直接 `git worktree add`。** 运行环境自带的隔离（如 Claude Code 的 `isolation: worktree`）会自建 worktree，本技能管不到创建这一步。这类 worktree 照样在收尾时用 `remove` 回收，或者由 `gc` 兜底。
- **`remove` 先核对，再删除。** 依次核对：没有未提交改动、没有未合入默认分支的提交、没有进程在用；通过后删除 worktree，已合入的本地任务分支一并删除。合入的判断和 branch.ts 相同：以 origin 实际声明的默认分支为准，squash、rebase 合入都算。远端还有同名分支时，输出的 `remoteBranch` 会列出，按下面的「分支」一节处理。确认成果可以丢弃时才加 `--force`；有进程在用时，加 `--force` 也拒绝。
- **`gc` 是兜底，不管 worktree 是谁建的。** 它盘点工作区内所有仓库的 worktree，分三类：
  - 失效记录：HEAD 仍在某个分支上的，标为清理；
  - 已合入、无改动、无进程占用、闲置超过 `--min-idle`（默认 24h）的，标为可回收；
  - 其余一律保留。
  默认只列出，加 `--apply` 才执行；失效记录逐条删除，不做整仓 prune。`remove`、`gc` 和收尾扫描都向 origin 查询实际默认分支（只读），连不上时才用本地 `origin/HEAD` 记录。
- **端口和数据不随 worktree 隔离。** 并行服务各用各的端口；数据库、Redis、对象存储按全局数据规则隔离。数据库文件、bind mount 和私有配置不放进 worktree，删除 worktree 时被忽略的文件会一起删掉。

## 分支

任务分支合入主线后，本地和远端的副本都要清理。是否已合入、删不删、怎么留痕，都交给 branch.ts 判断；不要凭分支名、日期或 `git branch --merged` 手动删除。

```bash
bun <skill-dir>/scripts/branch.ts --repo <仓库> [--branch <分支>]... [--remote] [--apply --record <文件>]
```

- **以远端实际默认分支为准。** 先 `fetch --prune`，再向 origin 查询它声明的默认分支。本地 `main`、过期的 `origin/HEAD` 都不作依据。
- **三种情况算已合入：**
  - 分支头是默认分支的祖先（merge、fast-forward）；
  - 分支上的提交逐个 rebase 进了默认分支；
  - 整个分支被 squash 成默认分支上的一个提交。
- **内容判断不出时，看 PR。** squash 时手工改过内容的，内容比对认不出来。这时以 GitHub PR 为证据：已合入的 PR 覆盖了分支头，且合并提交在默认分支上。
- **这些不算已合入：** 长期不活跃、上游显示 `[gone]`。
- **一律保留：**
  - 默认分支；
  - 在任一工作树检出的分支；
  - 有未关闭 PR 的分支；
  - 有未合入提交的分支，包括 PR 合入后又推了新提交的。
- **远端从严：**
  - GitHub 仓库只删有已合入 PR 证据的分支；gh 查不到 PR 时，远端分支一律保留。
  - 删除带 `--force-with-lease`：判断之后有人推了新提交，删除会被拒绝。
  - 受保护分支由服务端拒绝删除。
- **删除要留痕。** `--apply` 必须同时用 `--record` 指定一个新文件，写入每个分支删除前的 SHA、证据、PR 和恢复命令。记录放在 `<工作区根>/evidence/branch-cleanup/<仓库>-<日期>.json`，不放进仓库。
- **按场景处理：**

| 场景 | 做法 |
| --- | --- |
| 本任务 worktree 的分支已合入 | `wt.ts remove` 删除 worktree 和本地分支。输出的 `remoteBranch` 不为空时，再用 `branch.ts --branch <分支> --remote --apply --record <文件>` 删除远端分支 |
| 在主工作树上开的任务分支已合入 | 主工作树干净、且检出的是本任务分支时：先切回默认分支并 `pull --ff-only`，再用 `branch.ts --branch <分支> --remote --apply …` 清理。主工作树有别人的改动，或检出的不是本任务分支时，不切换，只清理远端 |
| PR 还没合入 | 不清理。在交接或最终回复里写明分支和 PR，合入后由接手的 Agent 处理，或由下次扫描发现 |
| 仓库开启了「合入后自动删除 head 分支」 | 远端分支已被删除；`fetch --prune` 后只剩本地分支，照常清理 |
| 用户要求整理整个仓库 | 不带 `--branch` 先列出，把可删除清单交给用户确认后再 `--apply` |
| 其他情况 | 只处理本任务创建的分支。扫描列出的其他已合入分支，在回复里提一句，不要顺手删除 |
