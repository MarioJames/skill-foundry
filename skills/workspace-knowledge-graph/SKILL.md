---
name: workspace-knowledge-graph
description: 使用 OpenViking 定位、查询和维护跨设备共享的工作区知识图谱与工作区记忆。用户提到工作区知识图谱、多仓关系、项目归属、此前工作、workspace 记忆线上化或从本地 .workspace 初始化线上记忆时使用；普通代码搜索或通用 OpenViking 记忆问答不单独触发。
---

# 线上工作区知识图谱

本技能是 OpenViking 工作区知识的薄路由层。线上入口固定为：

```text
viking://user/resources/workspaces/index.md
viking://user/resources/workspaces/<workspace>/
```

不要在技能中重建本地扫描、渲染或数据库客户端；通过运行时已注册的 OpenViking `find` / `search` / `read` / `glob` / `grep` / `edit` / `write` 工具工作。`viking://user/...` 是当前用户别名，不硬编码实际 user id。

## 查询

1. 优先从用户明确给出的工作区名或路径确定 `<workspace>`；不确定时读取线上 `index.md`，或在 `viking://user/resources/workspaces` 下按仓库名、模块名和任务关键词搜索。不要靠本地目录名猜归属。
2. 已知工作区时，先用 `find(target_uri=工作区 URI)` 做小范围召回；结果不足再用 `search(mode="list", target_uri=工作区 URI)`。`search(mode="context")` 不支持 `target_uri`，只在确实需要跨工作区记忆时使用。
3. 只选择 1–3 个最相关的精确文件 URI，并用 `read` 读原文后再行动。摘要只用于筛选，不作为事实证据。
4. 时间指称优先定位 `memory/daily/YYYY-MM-DD.md`；续接、纠正、确认取舍或用户外部操作优先查 `memory/MEMORY.md`；仓库入口和业务边界查 `graph/repos/`；跨仓关系查 `graph/relations/`；工作区路由查 `graph/metadata.yaml` 或 `graph/index.md`。
5. 同名仓库可能属于不同工作区。所有检索都要保留 workspace scope，不能把 `enterprise/admin`、`lobe/admin` 等同名仓库的事实合并。

## 使用边界

- 权威顺序：当前用户指令与当前代码、配置、外部实时状态、Git/PR/CI > 线上图谱事实 > 线上工作区记忆。OpenViking 内容用于定位和续接，不证明当前实现或外部状态。
- 路由到具体仓库后，仍须读取该仓库自己的 `AGENTS.md` 和命中的项目技能；线上图谱不覆盖仓库级执行规范。
- 只读问答、审查或定位不产生线上写入。用户请求初始化、同步、记忆或图谱维护时，才执行外部写入。
- 不把凭证、token、账号、个人隐私、`.env`、原始会话日志、临时 ID 或未提炼的流水账写入工作区资源。
- 不用 `remember` 镜像工作区文件。自动记忆层继续承载用户级实体、事件和偏好；可审计的工作区图谱与工作区记忆写在 `resources/workspaces/`。

## 维护

稳定事实发生变化时，先 `read` 当前线上文件，再用 `edit` 做唯一匹配的最小修改并设置 `wait=true`；新增文件用 `write(mode="create", wait=true)`。只有已核对完整旧内容或执行明确初始化时才用 `write(mode="replace")`，避免多设备盲覆盖。

更新后至少完成：

- `read` 精确 URI 验证正文；
- 用工作区限定的 `find` 或 `search(mode="list")` 验证新事实可召回；
- 说明写入的 workspace、URI 和仍需以当前代码复核的易漂移信息。

线上目录与文件职责见 [references/online-layout.md](references/online-layout.md)。只有用户要求从本地工作区初始化或重新同步时，才读取 [references/bootstrap-from-local.md](references/bootstrap-from-local.md)。

## 故障与陷阱

- `search(mode="context")` 不能带 `target_uri`；限定工作区用 `find` 或 list 模式。
- 工具返回的规范 URI 可能展开为 `viking://user/<id>/...`；调用时继续使用当前用户别名，不把该 id 写进技能或本地配置。
- 新写入的语义索引可能异步刷新；需要当场验收时使用 `wait=true`，不要用重复写入轮询。
- 目录级 `.abstract.md` / `.overview.md` 是 OpenViking 派生索引，不是事实源；若出现语言异常或乱码，先 `read` 精确原文确认正文，再只修复派生文件并重建向量，避免用错误摘要覆盖正常内容。
- 本地 `.workspace/state/discovery.json`、孤儿 `repos/` 目录和生成入口不是迁移真源；初始化必须按 `metadata.yaml.workspace.repo_order` 过滤。
- OpenViking 不可用时，明确说明线上记忆暂不可达；不要假设本地仍有 `.workspace` 或根 `MEMORY.md`，不得重新生成本地图谱、恢复本地双写或声称掌握跨设备最新状态。
