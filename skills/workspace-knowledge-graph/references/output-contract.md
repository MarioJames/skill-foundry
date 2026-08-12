# 输出契约

本文中的 `bootstrap`、`scan`、`init`、`validate` 都指向 Bun CLI：`bun "$SKILL_DIR/scripts/workspace_graph.ts" <command> --workspace "$WORKSPACE_ROOT"`；`SKILL_DIR` 与 `WORKSPACE_ROOT` 的取值规则见技能主文档。

`bootstrap` 之后，工作区至少包含：

```text
AGENTS.md
CLAUDE.md
MEMORY.md
.workspace/
  metadata.yaml
  index.md
  memory/
    daily/
  state/
    discovery.json
  relations/
    registry.yaml
    index.md
  repos/
```

`init` 之后，工作区应包含：

```text
AGENTS.md
CLAUDE.md
MEMORY.md
.workspace/
  metadata.yaml
  index.md
  memory/
    daily/
  state/
    discovery.json
  relations/
    registry.yaml
    index.md
  repos/
    <repo>/
      index.md
      domains/
        *.md
      shared/
        *.md
```

## 产物语言

面向人的 Markdown 产物默认渲染中文标题、指引、占位、操作说明和可读摘要。agent 撰写的仓库/业务域/共享事实、任务路由描述、关系摘要、操作记录和 metadata 中供人阅读的字段值遵循同一语言，除非用户明确要求其他产物语言。面向机器的名称保持不变：文件名、目录名、JSON/YAML 键、关系类型、命令、代码标识符、包名，以及 `CLAUDE.md` 中严格的指针内容。

## 根文件规则

- `AGENTS.md`：生成的根入口索引。内容为阅读顺序、任务路由、权威顺序、记忆消费门禁和多仓维护原则。只存每个工作区入口都必须消费的指引，不存具体仓库细节。不复制仓库矩阵；矩阵在 `.workspace/index.md`。独立仓库兜底路由只列出未被专属路由覆盖的独立仓库。自包含任务先命中 task route 并读取仓库 index；只有续接、偏好/纠正/确认取舍/用户操作、未决状态或称呼歧义场景才定位 `MEMORY.md` 的相关小节，不默认整文件读取。
- `CLAUDE.md`：严格单行指针 `@AGENTS.md`。
- `MEMORY.md`：按需消费的非权威长期记忆层。候选信息先提炼，再以“对后续工作有没有价值”为唯一写入条件；价值通过后，会持续影响工作空间或仓库后续行为的信息写在这里。文件只放实际条目，无条目时仅保留标题和空占位；写入与消费规则属于 `AGENTS.md`，不在这里复制。以 `workspace` / `repo:<repo>` 为父 scope，具体任务嵌套 `task:<task-key>`；允许类型、层级选择、紧凑格式、晋升/压缩和冲突处理见 [memory-protocol.md](memory-protocol.md)。当前用户指令和当前事实证据优先于历史记忆；记忆不能授权重复执行外部操作。
- `.workspace/memory/daily/`：按天承载与某个日期、阶段、当前任务或短期接续相关的有价值信息。价值判断通过后，每条以 `repo:<repo>` 或 `workspace` 对象标签开头并保持单行；先提炼、全保留、不压缩，是时间指称查询的第一入口。置于 `.workspace/` 受管目录内避免误删。
- `.workspace/metadata.yaml`：仅作为工作区级事实源。
- `.workspace/relations/registry.yaml`：编译出的有证据关系边，加上 `standalone_repos` 边界说明。独立仓库不是关系边。
- `.workspace/repos/<repo>/`：仓库级事实源。分节所有权与恢复规则见 [config-schema.md](config-schema.md)。
- bootstrap 阶段允许 `AGENTS.md`、`.workspace/index.md` 和关系摘要保留占位，直到 agent 填入第一批事实源。

## validate 清单

`validate` 对**结构与证据问题阻断**：契约文件缺失或非法（含 `CLAUDE.md` 指针、JSON 语法、遗留声明键、WORKSPACE.md 残留）、任务路由与关系的目标 / 端点 / 回链缺失、核心仓库不被任何路由覆盖、关系与独立仓库的证据路径不存在（含 `...` 占位）、生成 Markdown 链接失效、任何仓库扫描到大量子区域却没有业务域文档。`standalone` 只表示没有跨仓边，不豁免复杂仓库的业务域入口。

对**内容纪律问题只警告**：业务域/共享文档的摘要与命名、表格形态与证据单元格、链接标签、易漂移值（行号锚点、字面数量）、读者字段语义、零命中代码标识符、未决排查措辞、MEMORY 占位共存/旧格式/明显图谱流水账、daily 文件名与条目格式、子区覆盖缺口、孤儿或单数目录等。

每条错误与警告都写明修复位置；以脚本输出为准，本清单不逐条复述检查项。`validate` 通过后，按 [acceptance-standard.md](acceptance-standard.md) 做语义评审。

## 渐进维护契约

生成的图谱是持续维护的工作区入口，不是一次性穷尽报告。就绪门槛与后续修补规则见 [progressive-maintenance.md](progressive-maintenance.md)。

## 权威顺序

1. 当前用户指令，以及当前代码、配置、外部实时状态、git/PR/CI 证据
2. `AGENTS.md`：根路由、消费门禁与维护规则
3. `.workspace/metadata.yaml`：工作区级事实
4. `.workspace/relations/registry.yaml`：编译出的跨仓关系视图，不要手改
5. `.workspace/repos/<repo>/index.md`：仓库级事实
6. `.workspace/repos/<repo>/domains/*.md`：业务域事实
7. `.workspace/repos/<repo>/shared/*.md`：共享/平台事实
8. `MEMORY.md`：按需读取的历史上下文，不是当前状态证据
9. `.workspace/memory/daily/`：按天的历史现场记录，用于时间锚点回溯，不是当前状态证据
10. `.workspace/state/discovery.json`：可自动刷新的扫描快照，用于审计或排障

## 刷新模型

- `state/discovery.json` 是可自动刷新的证据。`scan` 和 `init` 都会写它；`bootstrap` 只留空占位。
- `relations/registry.yaml` 由扫描结果加本地声明编译而来；折叠与去重规则见 [config-schema.md](config-schema.md) 的 relations。
- 解读层来自工作区级的 `.workspace/metadata.yaml` 和仓库级的仓库/业务域/共享 Markdown。渲染器按 [config-schema.md](config-schema.md) 保留 agent 拥有的正文。
- `init` 重新渲染所有派生文档并保留 `MEMORY.md` 条目；移除技能生成过的已知旧规则前言、升级旧占位，自定义前言和真实条目原样保留。有有效条目后移除占位。
- `bootstrap`/`init` 幂等创建 `.workspace/memory/daily/`(含 `.gitkeep`)，只补缺失，绝不覆盖已有记录。
