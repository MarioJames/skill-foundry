# 线上项目知识契约

```text
viking://user/resources/projects/
  RELATIONS.md
  MEMORY.md
  repos/
    <project-id>/
      graph.md
      domains.md
      knowledge.md
      entities.md        # 仅有稳定实体定义时创建
```

## 文件职责

- `RELATIONS.md`：全局项目注册与关系真源。项目条目保存稳定 ID、完整 Git remote、别名和按 peer 标注的当前/历史路径；关系条目保存稳定 relation ID、from、to、type、方向、摘要、核验时间和项目内证据路径。
- `MEMORY.md`：全局项目记忆。保存跨项目结构决策、路径迁移、用户外部操作和仍有后续价值的接续；用项目 ID 或 relation ID 标记关联对象。
- `repos/<project-id>/graph.md`：仓库自身的定位、职责、入口、常用操作和项目技能。
- `repos/<project-id>/domains.md`：仓库自身业务域的职责、流程、不变量和维护影响。
- `repos/<project-id>/knowledge.md`：仓库自身共享机制、运行边界、协议和工具链知识。
- `repos/<project-id>/entities.md`：可选；只保存跨任务稳定且值得单独检索的仓库内实体定义，不为目录一致性创建空文件。

## 归属规则

- Git remote 是项目身份的首要定位键；本地目录名和父目录只用于位置匹配。
- 路径和跨项目关系只写 `RELATIONS.md`，单仓文件不复制。
- 单仓实现事实只写对应项目目录，全局关系文件不展开其内部知识。
- 历史决策只写 `MEMORY.md`；当前关系状态回写 `RELATIONS.md`，避免用历史记录替代现状。
- 同一主题只保留一个规范来源。文件是否继续拆分由实际大小和并发编辑冲突决定，不按预设类型建立深层目录。
- 项目上下文查询只消费本契约下的 `resources/projects/`。自动召回摘要、通用 `memories/` 与旧 `resources/workspaces/` 不作为补充事实源。
