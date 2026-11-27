# Worktree 与分支

参数和判定规则看各脚本的 `--help`，本文只写脚本之外要你判断的事。

## Worktree

并行任务、主工作树有别人的改动、或要在另一个基线上验证时用。

```bash
bun <skill-dir>/scripts/wt.ts add --repo <主仓库> --name <任务名> [--branch <分支>] [--base <提交>]
bun <skill-dir>/scripts/wt.ts remove --path <worktree>
bun <skill-dir>/scripts/wt.ts gc --workspace <工作区根>... [--apply]
```

- **`add`** 在仓库和工作区之外建好 worktree：从 origin 的默认分支起新分支、链接 `.env`、检出子模块、装好依赖，stdout 的 `cwd` 就是工作目录。任务差异写 `.env.local`；按项目分支命名时传 `--branch`。
- **不直接 `git worktree add`。** 运行环境自建的 worktree（如 Claude Code 的 `isolation: worktree`）收尾时同样用 `remove` 回收。
- **`remove`** 核对无未提交改动、无未合入提交、无进程占用后才删除，已合入的本地分支一并删除。输出的 `remoteBranch` 不为空时按「分支」清理远端。成果确认可以丢弃才加 `--force`。
- **`gc`** 兜底盘点工作区内所有 worktree，整机盘点的 `scan.ts --clean` 会调用它；任务收尾只回收带任务名的。不用 `git worktree prune`，它会清掉别人的记录。
- **端口和数据不随 worktree 隔离。** 并行服务各用各的端口；数据库文件、bind mount 和私有配置不放进 worktree，删除时被忽略的文件会一起删掉。

## 分支

任务分支合入后，本地和远端的副本都要清理，是否已合入交给 `branch.ts` 判断。

```bash
bun <skill-dir>/scripts/branch.ts --repo <仓库> [--branch <分支>]... [--remote] [--apply --record <文件>]
```

- 默认只列出。`--apply` 必须带 `--record`，记录放 `<工作区根>/evidence/branch-cleanup/<仓库>-<日期>.json`。
- 长期不活跃、上游显示 `[gone]` 都不算已合入。脚本保留的分支不手动删除。

| 场景 | 做法 |
| --- | --- |
| 本任务 worktree 的分支已合入 | `wt.ts remove`；`remoteBranch` 不为空时再 `branch.ts --branch <分支> --remote --apply --record <文件>` |
| 在主工作树上开的任务分支已合入 | 主工作树干净且检出的是本任务分支时，切回默认分支并 `pull --ff-only` 再清理；否则不切换，只清理远端 |
| PR 还没合入 | 不清理，在交接或最终回复里写明分支和 PR |
| 别人留下的已合入本地分支和闲置 worktree | 任务收尾时不动。用户要整理环境时，用不带 `--task` 的 `scan.ts --clean` 清理 |
| 别人的远端分支 | 不动。用户要求整理整个仓库时，`branch.ts --remote` 先列出，清单经用户确认后再 `--apply` |
