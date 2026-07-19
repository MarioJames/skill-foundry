# 配置模式

`workspace-knowledge-graph` 把 `.workspace/metadata.yaml` 作为 JSON 兼容的工作区级事实源读取。仓库级事实放在 `.workspace/repos/<repo>/` 下的 Markdown 中。

## 顶层键

- `workspace`：工作区元信息与路由规则
- `relations`：声明的跨仓关系
- `standalone_repos`：因没有已知依赖证据而有意留在关系图之外的仓库
- `suppressed_relations`：按键抑制有噪声的自动检测关系
- `suppressed_relation_types`：按类型抑制全部自动检测关系，例如 `["depends_on_repo_artifacts"]`

`memory_seed` 和顶层 `repos` 是遗留键，没有自动迁移。它们存在时 `init` 拒绝执行、`validate` 报错。请手动把有用的 `repos` 内容沉淀到 `.workspace/repos/<repo>/` 的 Markdown 事实源，把有价值的 `memory_seed` 条目搬进 `MEMORY.md`，然后删除这些键。

## workspace

```json
{
  "workspace": {
    "name": "demo-workspace",
    "summary": "相互关联的多仓业务工作区。",
    "positioning": "同一目录下协同维护的多个仓库。",
    "entry_policy": {
      "delete_workspace_md": true
    },
    "repo_order": ["repo-a", "repo-b"],
    "task_routes": [
      {
        "name": "前端页面与路由",
        "when": "涉及页面、路由、OneAPI 和浏览器验证时使用。",
        "read": [".workspace/repos/repo-a/index.md"]
      }
    ]
  }
}
```

根配置不承载仓库细节。仓库摘要、入口和操作事实属于 `.workspace/repos/<repo>/index.md`；业务域和共享机制属于 `domains/` 和 `shared/`。

`entry_policy` 目前只有一个键：`delete_workspace_md` 控制 `init` 是否清理遗留的根 `WORKSPACE.md`（生成配置默认开启）。根入口 `AGENTS.md` 和记忆文件 `MEMORY.md` 是固定契约，不做配置。

## relations

```json
{
  "relations": [
    {
      "from": "repo-a",
      "to": "repo-b",
      "type": "consumes_api",
      "direction": "directed",
      "summary": "repo-a 通过生成的客户端和 HTTP 路由前缀消费 repo-b 的 API。",
      "evidence": [
        "repo-a/config/config.ts",
        "repo-a/src/services/repo-b",
        "repo-b/app/router.ts"
      ]
    }
  ]
}
```

`direction` 取 `directed` 或 `peer`。

关系必须有证据支撑。不要仅因两个仓库类别、受众或交付形式相似就加 `peer` 关系。孤立仓库用 `standalone_repos`。

`relations` 和 `standalone_repos` 里的证据条目必须是真实可打开的工作区相对路径。不要用 `...` 占位或过期路径。证据路径不存在时 `validate` 阻断。

关系摘要保持仓库级，但在重要时仍要讲清连接机制和契约面：RPC 还是 HTTP、操作前缀、HTTP 路径前缀、生成目录、后端应用名、代理配置、模块配置、共享制品，以及代表性的消费方/提供方证据。每条边只需要契约面加 1-3 个代表性链路示例；不要展开成完整接口清单、操作表、字段级契约、错误码目录、mock 用例目录或排障手册。

registry 编译时会折叠弱重复边。某个 `(from, to)` 组合已有声明边时，同组合的纯检测 `depends_on_repo_artifacts` 提及边会从编译后的 registry 和阅读视图中去掉；原始提及计数保留在 `discovery.json`。其他类型的检测边（例如生成客户端产生的 `consumes_api`）则与同类型声明边合并。证据路径在去掉尾部斜杠后去重。

## standalone_repos

```json
{
  "standalone_repos": [
    {
      "repo": "asset-repo",
      "summary": "独立的资产交付仓库。",
      "reason": "未发现运行时依赖、生成客户端、Maven 同级提及或共享制品引用。",
      "evidence": ["asset-repo/build.sh", "asset-repo/release.sh"]
    }
  ]
}
```

`standalone_repos` 记录图谱边界。它不会并入 `relations`；只有找到具体的依赖、API、生成客户端、共享制品或源码引用证据后，才升级为真实关系。

`standalone` 只表示没有已知仓库级关系边，不表示仓库简单，也不豁免任务路由和业务域研究。扫描到多个页面、模块、workspace package 或应用的独立仓库，仍需按真实能力补充 `domains/`；纯交付仓只有在本身没有复杂子区时才会自然低于机械覆盖门槛。

## 仓库 Markdown 事实源

`repo/index.md` 使用固定的 Markdown 分节：

```markdown
# repo-a

## 仓库事实

| 字段 | 内容 |
| --- | --- |
| 类别 | `bigfish-console` |
| 读者 | 运营前端维护者；团队归属见仓库 OWNERS。 |
| 摘要 | 一句话说明仓库定位。 |
| 职责 | 说明该仓库在业务链路中负责什么。 |
| 主要入口 | [`config/config.ts`](../../../repo-a/config/config.ts) |

## 常用操作

| 场景 | 命令/入口 | 说明 | 证据 |
| --- | --- | --- | --- |
| API 联调 | `tnpm devs` | Bigfish 开发模式带 MOCK=none；用于关闭 mock 并连接真实 API。 | [`repo-a/package.json`](../../../repo-a/package.json) |

## 关系

| 方向 | 仓库 | 类型 | 来源 |
| --- | --- | --- | --- |
| 出站 | [repo-b](../repo-b/index.md) | `consumes_api` | [registry.yaml](../../relations/registry.yaml) |

## 文档
```

`repo/index.md` 由 `init` 重新渲染。所有权按分节划分：仓库事实表的字段、agent 修改或新增的常用操作行、自定义 `##` 小节会被恢复保留；`## 关系`、`## 文档`、`## 自动扫描快照` 是派生分节，每次重新生成。正文必须写在 `##` 分节内：H1 与第一个 `##` 之间的内容不属于任何分节，刷新时不保留。刷新时仍会解析遗留的英文分节名。已不存在对应机械命令、且说明仍是脚本生成文案的操作行会在刷新时清理。常用操作只保留非显然变体、真实交付入口和高概率误操作护栏；默认 dev/build/test/install、manifest 中名称已自解释的脚本和等价 runner 拼写不进入事实源。

`domains/*.md` 和 `shared/*.md` 是 agent 拥有的持久事实，不是渲染副本。`init` 只读取它们、把摘要提取进仓库 index 的文档表，绝不创建、覆盖或删除这些文件。自由格式小节和每条路径的注释都能在刷新后存活。不要在这里复述跨仓关系；从仓库 index 和 `registry.yaml` 读取即可。除非一篇文档大到影响阅读，否则不要把一个业务域拆成多篇子文档；但也不要把多个会影响路由、归属或维护判断的独立业务能力合并成一篇笼统概览。

业务域/共享文档由渲染器解析，以下是格式契约，不是风格建议：

- 新产物正文必须以 `## 摘要` 开头，不要以 H1、列表或 TODO 占位开头。历史工作区的 `## Summary` 仍可解析。第一个普通段落会被提取到仓库 index 的文档表；摘要缺失或还是 TODO 时渲染为 `-`，并触发 `validate` 警告。
- 摘要是纯文本，不放行内相对链接。路径证据放在摘要之后，指向仓库根需要四段 `../`，例如 `../../../../<repo>/src/...`。
- 文件名就是文档的 slug，会成为仓库 index 中的标签。使用主题化 slug（如 `oneapi-mock.md`），永远不要用 `index.md`；目录保持复数 `domains/` 和 `shared/`。frontmatter 的 `title` 是自由元信息，不影响标签。
- 链接标签用短标签（`X.java`）或仓库相对路径（`app/web/X.java`），不要用 `./` / `../` 阶梯串；文件名标签必须直接链到该文件，而不是所在目录。

```markdown
## 摘要

用一个普通段落说明这个业务域或机制负责什么。该段落会被提取到仓库 index 的文档表。

## 职责和关键流程

刷新后会保留的自由格式细节。
```

## suppressed_relations

```json
{
  "suppressed_relations": [
    {
      "from": "repo-a",
      "to": "repo-c",
      "type": "depends_on_repo_artifacts"
    }
  ]
}
```

只用抑制规则处理会误导图谱的噪声检测关系。存在抑制规则时，生成的根文档和关系文档应当把这件事写透明。
