# 线上目录契约

## 命名空间

```text
viking://user/resources/workspaces/
  index.md
  governance.md
  <workspace>/
    manifest.json
    graph/
      metadata.yaml
      index.md
      relations/
        index.md
        registry.yaml
      repos/
        <repo>/
          index.md
          domains/*.md
          shared/*.md
    memory/
      MEMORY.md
      daily/YYYY-MM-DD.md
```

`index.md` 是跨工作区目录，只保存 workspace 名称、定位和仓库边界。`governance.md` 保存跨工作区统一的权威顺序、线上真源和并发写入规则。`manifest.json` 保存初始化来源、时间和每个线上文件对应的本地相对路径与内容哈希，用于判断重新同步是否会覆盖线上新变化。

## 分层职责

- `graph/metadata.yaml`：工作区级定位、任务路由、仓库顺序和声明关系。
- `graph/index.md`：人可读工作区摘要。
- `graph/relations/`：跨仓关系与证据。
- `graph/repos/<repo>/index.md`：仓库入口、项目技能路由和非显然操作。
- `graph/repos/<repo>/domains/`：业务域职责、流程和代表性证据。
- `graph/repos/<repo>/shared/`：跨切面机制、工具链和协议边界。
- `memory/MEMORY.md`：会持续改变该工作区后续行为的纠正、确认取舍、用户外部操作和接续约束。
- `memory/daily/`：按日期保存有后续价值的短期现场，时间指称查询的第一入口。

OpenViking 自身的 `memories/` 继续由插件承载跨工作区用户级实体、偏好和事件。不要把同一条工作区内容同时写进 `memories/` 与 `resources/workspaces/`。

## 写入归属

- 当前实现可直接验证的事实变化：更新最小 `graph/` 文件，并保留代码路径证据。
- 用户明确的工作区级纠正、确认决策、外部操作或未决接续：更新 `memory/MEMORY.md`。
- 与日期或当前阶段绑定、仍有后续价值的信息：新建或编辑当天 `memory/daily/<date>.md`。
- 跨工作区仍有效的用户偏好：交给 OpenViking 自动记忆；只有用户明确要求立即记住时才使用 `remember`。

同一主题只保留一份线上真源。更新现有文件优先用 `edit`；写入前先读，写入后再读并验证检索召回。
