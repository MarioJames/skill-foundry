# 从本地工作区初始化

仅在用户明确要求初始化、迁移或重新同步时使用。本流程会写入线上 OpenViking；先确认服务健康和目标 workspace URI。

## 选择根目录

使用用户给定目录；未给出时使用调用时 `$PWD`。把它解析为经过 `test -d` 的绝对物理路径并在本轮复用，不向上查找 `.git` 或 `.workspace`，也不枚举根目录外的同级项目。

要求本地至少存在 `.workspace/metadata.yaml`。从 `workspace.name` 取得线上目录名，从 `workspace.repo_order` 取得允许迁移的仓库集合；缺字段、重名或目标线上目录已存在且来源不明时停止，不能猜测或盲覆盖。

## 迁移白名单

映射下列文件，并保留正文：

| 本地来源 | 线上目标 |
| --- | --- |
| `.workspace/metadata.yaml` | `graph/metadata.yaml` |
| `.workspace/index.md` | `graph/index.md` |
| `.workspace/relations/index.md` | `graph/relations/index.md` |
| `.workspace/relations/registry.yaml` | `graph/relations/registry.yaml` |
| `.workspace/repos/<repo_order 中的 repo>/**/*.md` | `graph/repos/<repo>/**/*.md` |
| `MEMORY.md` | `memory/MEMORY.md` |
| `.workspace/memory/daily/*.md` | `memory/daily/*.md` |

明确排除：`.workspace/state/discovery.json`、`.gitkeep`、不在 `repo_order` 的孤儿或验收目录、根 `AGENTS.md` / `CLAUDE.md`、凭证与任何白名单外文件。

## 初始化步骤

1. 读取线上 `workspaces/index.md` 和目标目录，确认是首次创建还是受控同步。
2. 为每个白名单文件计算 SHA-256，生成 `manifest.json`；manifest 使用 workspace 相对路径，不记录设备绝对路径。
3. 首次初始化使用 `write(mode="create")`。可并行写不同文件，但限制批次，任何失败都要记录精确 URI 并补齐后再验收。
4. 重新同步时对比线上 manifest 和当前线上正文：线上自上次初始化后有变化的文件不得被本地旧快照覆盖；逐文件 `read` 后合并，并用 `edit` 更新。
5. 最后写入或更新 manifest，再把 workspace 摘要补进全局 `index.md`。
6. `tree` 检查目录形状，抽样 `read` 每一层，并分别用仓库名、业务词、时间词做 workspace 限定检索。

## 失败处理

- 部分写入失败：不删除已成功文件；补齐失败 URI，manifest 最后写。
- 索引未完成：等待已有写入完成或用 `read` 验证，不重复覆盖。
- 线上与本地冲突：当前用户指令和当前代码证据优先；无法判断时停止并列出冲突文件。
- OpenViking 不可达：保留本地文件不动，报告未初始化；不得把本地成功读取描述成线上迁移成功。
