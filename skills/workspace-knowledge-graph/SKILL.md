---
name: workspace-knowledge-graph
description: 当用户要求为多仓工作区初始化或刷新知识图谱、生成或维护 AGENTS.md / MEMORY.md / CLAUDE.md 根路由文档、维护 .workspace/ 声明与跨仓关系视图，或提到工作区知识图谱、多仓扫描、仓库关系梳理、任务路由文档时使用。
---

# 工作区知识图谱

使用本技能初始化或刷新根路由文档（`AGENTS.md`、`CLAUDE.md`、`MEMORY.md`）、`.workspace/`、`.workspace/relations/registry.yaml`，以及 `.workspace/repos/<repo>/` 下的仓库文档。

## 产物语言约定

面向人的工作区产物默认使用中文，面向机器的令牌（文件名、配置键、命令等）保持原样；完整规则见 [references/output-contract.md](references/output-contract.md)。

## 工作流

1. `bootstrap`：创建根文档和 `.workspace/` 骨架。
2. `scan`：扫描工作区根目录下的同级 git 仓库，把机械扫描快照持久化到 `.workspace/state/discovery.json`。研究阶段依赖这个真实文件，而不是 bootstrap 的占位文件。机械识别对 Bigfish / Maven / JS monorepo（pnpm / yarn / npm workspaces）类工作区最完整，其他技术栈会退化成通用清单文件与计数；解读与关系证据始终由研究闭环负责。扫描后先跑一次 `init`，渲染出各仓库 index 的机械骨架，让后续写作在固定分节上填空，而不是徒手造表。
3. **研究-写作-评审闭环。** 有子代理可用时，不让研究员直接写最终事实源；先按仓库扇出 Research Agent 产出证据包，再由 Writer Agent 写入仓库 `index.md`、`domains/*.md`、`shared/*.md` 和关系候选，最后由 Review Agent 做只读语义评审并把缺口返给 Writer Agent 修补。见 [references/research-protocol.md](references/research-protocol.md) 和 [references/acceptance-standard.md](references/acceptance-standard.md)。首版只需推进到高密度可用入口，就绪门槛见 [references/progressive-maintenance.md](references/progressive-maintenance.md)。
4. 把全局发现归并进 `.workspace/metadata.yaml`：`positioning`、覆盖所有仓库的任务路由、有证据支撑的 `relations`，以及 `standalone_repos`。
5. `init`：基于扫描结果和持久事实源重新渲染派生文档。`domains/*.md` 和 `shared/*.md` 归 agent 所有；脚本只读取它们刷新文档表，绝不创建、覆盖或删除。
6. `validate`：作为兜底校验，只阻断结构、链接、证据路径和明显缺失的业务域骨架；不要用脚本阈值替代 Research/Writer/Review 闭环里的业务语义判断。见 [references/output-contract.md](references/output-contract.md)。
7. 迭代修改并重渲染，直到结构和语义评审都收敛。
8. `validate` 通过且 Review Agent 没有未处理的 `must_fix` 后，图谱才算就绪。
9. 按 [references/memory-protocol.md](references/memory-protocol.md) 维护 `MEMORY.md`。只有无法从代码、git/PR/CI、任务系统或图谱事实源可靠恢复，且遗漏会改变后续行为的用户偏好、用户纠正、用户完成的外部操作、用户确认取舍或接续状态才写；不写 commit 摘要、测试/文件/数量清单和例行图谱流水账。写入与消费规则由生成的 `AGENTS.md` 承载，`MEMORY.md` 本身只放实际条目或空占位。刷新存量工作区时同时压缩旧记忆。
10. 后续任务遵循 [references/progressive-maintenance.md](references/progressive-maintenance.md)：搜索、调试、测试、集成或用户补充任务语境时，修补最小且正确的事实源；用户首次提供的稳定对象称呼、项目归属和目录映射也要沉淀到路由/仓库/业务域事实源，然后重跑 `init` + `validate`。

## 命令

工作区根目录只接受直接输入：

- 用户给了目录，就用该目录作为 `WORKSPACE_ROOT`。
- 否则使用调用时的当前工作目录：`WORKSPACE_ROOT="$PWD"`。
- 不要通过 `git rev-parse --show-toplevel`、向上探测父目录、查找祖先 `.git` / `.workspace`、枚举 `WORKSPACE_ROOT` 之外的同级目录、目录名推断或任何其他启发式来发现、归一化或覆盖根目录。
- 只有用户明确要求换目标目录时才更改 `WORKSPACE_ROOT`。

命令在目标工作区根目录下执行。使用本技能目录的绝对路径；不要在技能目录里执行并把那个 `$PWD` 当成工作区。

```bash
SKILL_DIR="$HOME/.cc-switch/skills/workspace-knowledge-graph"  # 以实际加载本 SKILL.md 的目录为准；安装位置不同时先替换。
WORKSPACE_ROOT="$PWD"
python3 "$SKILL_DIR/scripts/workspace_graph.py" bootstrap --workspace "$WORKSPACE_ROOT"
python3 "$SKILL_DIR/scripts/workspace_graph.py" scan --workspace "$WORKSPACE_ROOT"
python3 "$SKILL_DIR/scripts/workspace_graph.py" init --workspace "$WORKSPACE_ROOT"
python3 "$SKILL_DIR/scripts/workspace_graph.py" validate --workspace "$WORKSPACE_ROOT"
```

`.workspace/metadata.yaml` 已存在时，`init` 会把扫描结果与本地声明合并后重新渲染派生文档。agent 撰写的内容按 [references/config-schema.md](references/config-schema.md) 中的所有权规则保留。遗留声明（顶层 `repos` / `memory_seed`、仓库级 `meta.yaml`）不做自动迁移：`init` 会拒绝执行并提示手动迁移。

## 关键约定

- `.workspace/metadata.yaml` 虽然扩展名是 `.yaml`，但**使用 JSON 语法**，以保证工具零依赖。手改必须是合法 JSON。
- 完整的所有权与字段契约见 [references/config-schema.md](references/config-schema.md)，包括仓库 index 分节恢复和操作行归一化。研究阶段的字段规则见 [references/research-protocol.md](references/research-protocol.md)。
- 跨仓关系保持仓库级粒度，且必须有证据支撑。仅凭类别相似不构成 peer 边。没有依赖证据的仓库放进 `standalone_repos`。证据路径必须是可打开的工作区相对路径，不允许 `...`。粒度红线见 [references/config-schema.md](references/config-schema.md) 的 relations。
- 仓库内深度内容放在 `domains/` 和 `shared/`。不要用每仓一个笼统总述掩盖多个会影响路由、归属或维护判断的独立能力；长尾按需补充小而稳定、有证据的事实。
- 根文件分工见 [references/output-contract.md](references/output-contract.md)：`AGENTS.md` 是生成产物，持久事实写入 `.workspace/metadata.yaml` 与 `.workspace/repos/**` 后由 `init` 刷新；`MEMORY.md` 是按需消费的非权威接续上下文，不是工作日志；`CLAUDE.md` 严格等于 `@AGENTS.md`。

## 参考文档

- `references/research-protocol.md`
- `references/config-schema.md`
- `references/output-contract.md`
- `references/acceptance-standard.md`
- `references/progressive-maintenance.md`
- `references/memory-protocol.md`
