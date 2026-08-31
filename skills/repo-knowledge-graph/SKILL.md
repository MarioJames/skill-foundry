---
name: repo-knowledge-graph
description: 使用 OpenViking 按当前 Git 项目定位、查询和维护全局项目关系、项目记忆与单仓知识。用户提到项目归属或路径、跨仓依赖、此前项目工作、项目知识图谱，或需要从具体仓库续接相关上下文时使用；普通代码搜索和与项目无关的通用记忆问答不单独触发。
---

# 全局项目知识图谱

线上入口固定为：

```text
viking://user/resources/projects/RELATIONS.md
viking://user/resources/projects/MEMORY.md
viking://user/resources/projects/repos/<project-id>/
```

通过运行时已注册的 OpenViking `find` / `search` / `read` / `glob` / `grep` / `edit` / `write` 工具工作。不要调用本地 `ov` CLI、直连 HTTP 或重建数据库客户端；`viking://user/...` 是当前用户别名，不硬编码实际 user id。

## 定位当前项目

1. 在当前 Git 根目录读取 `remote.origin.url`，优先用完整 remote 在 `RELATIONS.md` 精确匹配稳定 `<project-id>`。同一 remote 的多个本地路径属于同一项目。
2. remote 缺失时，再用当前绝对路径或明确仓库名在 `RELATIONS.md` 匹配。路径只是按 peer 记录的位置，不是项目身份；不要从父目录名称推断归属。
3. 同名仓库必须用 remote、项目 ID 或精确路径消歧。仍有多个合理结果时说明歧义并询问，不合并事实。
4. 定位后把查询限定到 `viking://user/resources/projects/repos/<project-id>/`。不要查找或依赖工作空间根的 `AGENTS.md`、`CLAUDE.md`、`MEMORY.md` 或 `.workspace`。

## 查询

- 本技能处理项目知识时，事实源白名单只有 `viking://user/resources/projects/`（服务端展开实际 user id 后的同一路径也等价）。不要补读 `memories/`、旧 `resources/workspaces/` 或其他 OpenViking 目录；运行时自动注入的召回摘要只用于判断是否触发本技能，不引用其中事实，也不展开其 URI。
- 仓库结构、常用操作和项目技能读 `graph.md`；业务域读 `domains.md`；共享机制和技术边界读 `knowledge.md`；存在 `entities.md` 时用于稳定实体定义。
- 项目身份、本机路径和跨项目依赖只查 `RELATIONS.md`。用项目 ID、完整 remote、路径或 relation ID 做 `grep`，语义不确定时再用限定到 `projects/` 的 `find`。
- 续接、纠正、确认取舍或用户外部操作查 `MEMORY.md`，用项目 ID 和任务关键词缩小结果。
- 仓库内部问题先在该项目 URI 下 `find`；不足时用 `search(mode="list", target_uri=项目 URI)`。`search(mode="context")` 不支持 `target_uri`，只在确需跨项目上下文时使用。
- `projects/` 内的召回结果只用于筛选。选择 1–3 个最相关的规范文件 URI，用 `read` 核对原文后再行动；忽略 `.abstract.md`、`.overview.md` 等派生索引。

## 权威与边界

- 权威顺序：当前用户指令与当前代码、配置、Git/PR/CI、外部实时状态 > `repos/<project-id>/` 与 `RELATIONS.md` 的稳定事实 > `MEMORY.md` 的历史上下文。
- 仓库自身的 `AGENTS.md` 和项目技能仍是执行规范，线上项目知识不覆盖它们。
- `RELATIONS.md` 独占项目 ID、remote、路径、别名和跨项目关系；单仓文件不得复制这些内容。
- `repos/<project-id>/` 只保存该仓库自身的图谱、实体、领域和共享知识；跨仓边只写 `RELATIONS.md`。
- `MEMORY.md` 只保存会影响后续工作的跨项目决策、路径迁移、用户外部操作和接续，不复制稳定实现事实。
- 项目历史只以这里的 `MEMORY.md` 为入口；即使通用记忆中存在同名项目实体或旧迁移记录，也不并入答案，避免新旧模型混用。
- 查询依赖召回与 grep，不为渐进式披露预建深层目录；只有权威边界、文件过大或实际并发编辑冲突才拆文件。
- 只读问答、审查或定位不写线上资源。不把凭证、token、账号、个人隐私、`.env`、原始会话日志、临时 ID 或未提炼流水账写入项目知识。

## 维护

先 `read` 当前规范文件，再用 `edit` 做唯一匹配的最小修改并设置 `wait=true`；新增文件用 `write(mode="create", wait=true)`。只有核对完整旧内容或执行明确迁移时才用 `write(mode="replace")`。

更新后至少完成：

- `read` 精确 URI 验证正文；
- 在 `projects/` 或具体项目 URI 下用 `find` / `grep` 验证新事实可召回；
- 检查同一关系、路径或仓库事实没有在全局文件与单仓文件重复；
- 说明写入的 URI，以及仍需以当前代码复核的易漂移信息。

线上文件职责见 [references/online-layout.md](references/online-layout.md)。

## 故障与陷阱

- OpenViking 工具未注册或不可用时，明确说明线上项目上下文不可达；不要改用本地 CLI、HTTP、旧本地快照或自动记忆摘要冒充规范资源。
- 新写入的语义索引可能异步刷新；需要当场验收时使用 `wait=true`，超时后先 `read` 精确 URI 判断是否已写入，不要盲目重复创建。
- 工具返回的规范 URI 可能展开为 `viking://user/<id>/...`；后续调用继续使用当前用户别名，不把实际 user id 写进技能或配置。
- 目录级 `.abstract.md` / `.overview.md` 是派生索引，不是事实源；派生内容异常时先读规范文件，不能用错误摘要覆盖正文。
