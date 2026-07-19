# 研究协议

`scan` 只产出机械事实：文件清单、计数、检测类型、同级仓库提及。图谱的解读层无法只靠脚本得出：每个仓库是干什么的、业务域怎么划分、哪些跨仓链路重要、哪些本地命令不显然。这部分解读工作必须通过 **Research Agent -> Writer Agent -> Review Agent** 的闭环完成，而不是只靠脚本阈值约束。

有子代理可用时，主 agent 必须扇出 Research Agent，而不是自己一遍浅扫填满所有仓库。Research Agent 只产出证据包和判断建议；Writer Agent 才写事实源；Review Agent 做只读语义评审并把缺口返回给 Writer Agent 修补。脚本 `validate` 是兜底，只负责机械结构、链接、证据路径和明显空洞，不替代 Review Agent 的业务语义判断。

## 时机

在 `scan` 之后执行。研究开始前先跑一次 `init`：它会用扫描结果渲染各仓库 index 的机械骨架，Writer Agent 在固定分节上填空，而不是徒手造表。`.workspace/state/discovery.json` 必须已经存在，让每个研究员从机械事实出发，而不是重新扫描；`bootstrap` 只留占位，真实快照由 `scan` 写入。

第一轮研究把工作区从空骨架推进到高密度可用入口；就绪门槛见 [progressive-maintenance.md](progressive-maintenance.md)，密度标准见下方「深度与密度」，长尾缺口留给渐进维护。

## 产物语言

遵循 [output-contract.md](output-contract.md) 的产物语言规则：面向人的事实源与摘要默认中文，面向机器的令牌（仓库名、路径、命令、代码标识符、包名、关系类型、JSON 键）保持原拼写。存量且仍准确的英文事实可保留，但新写的正文不默认用英文。

## 深度与密度

研究不是源码百科全书。只保留能帮未来 agent 路由任务、理解归属边界、选对入口、避免高概率误操作的事实。

- 单仓事实保持聚焦：仓库角色、真实入口、非显然命令、团队能认出的重要业务域、共享机制、代表性路径。
- `domains/` 是项目业务事实层，不是每仓一个概览占位。核心仓库存在多个会影响任务路由、归属边界、契约理解或维护入口的独立能力时，应写成多篇业务域文档，或在少数宽文档中用清晰小节覆盖这些能力并说明为什么不拆。
- 多仓事实是必做研究，不是可选点缀。记录谁消费谁、连接机制、契约面、消费方证据、提供方证据，以及契约变化时应检查哪些事实源。
- 每条跨仓边只需要契约面加 1-3 个代表性链路示例来证明关系成立；粒度红线的完整枚举见 [config-schema.md](config-schema.md) 的 relations。
- 优先内容密度。一句话如果不改变路由、边界、入口选择、关系判断或维护动作，就不要进图谱。
- 再做一次“可恢复性”检查：单次 `rg`、manifest、目录树或 `discovery.json` 已经直接给出的清单，不因“真实”就复制进图谱；只有综合后的边界、不变量、误操作护栏和影响判断值得持久化。

## 闭环分工

- Research Agent 按仓库切分，不按小节切分。每个 Research Agent 分 1-2 个仓库；紧耦合仓库（如前端加上它消费的后端）在业务域只有合在一起才讲得通时应编成一组。
- Research Agent 可以阅读同级仓库来核实跨仓契约证据，但不编辑 `.workspace/` 文件，不运行 `init` / `validate`，也不改 `.workspace/metadata.yaml` 的全局声明。
- Writer Agent 拥有写入权。按 Research Agent 返回的证据包，写入对应仓库的 `index.md`、`domains/*.md`、`shared/*.md`，并把全局发现归并进 `.workspace/metadata.yaml`。
- Review Agent 只读。它读取 `discovery.json`、Research 证据包、Writer 沉淀后的事实源和生成文档，按 [acceptance-standard.md](acceptance-standard.md) 给出 `must_fix` / `should_fix` / `acceptable` / `needs_human_judgment`。
- 主 agent 负责闭环调度（时序见下方「主 Agent 闭环」）。

## Research Agent 证据包

输入：工作区根目录、分配的仓库路径、`.workspace/state/discovery.json`。

对每个分配到的仓库，返回结构化证据包，不直接写文件：

- 仓库定位建议：类别、读者、摘要、职责、主要入口、非显然常用操作及证据；同时指出哪些扫描结果是删除候选，不应进入事实源。
- 业务域候选：团队能认出的业务域名称、为什么应独立成域或为什么可合并、职责、关键流程、入口边界、维护影响面、代表性证据路径。
- 共享机制候选：跨切面的配置、运行时入口、生成产物边界、mock/测试/工具链链接和维护注意事项。
- 跨仓关系候选：方向、关系类型、连接机制、契约面、消费方证据、提供方证据、1-3 个代表性链路示例，以及契约变化时需要检查的事实源。
- 缺口：低置信事实、证据不足的判断、需要产品/团队知识才能回答的 `needs_human_judgment`。

业务域候选要覆盖项目中的重要业务事实，不要把所有能力压成“核心域”、“门户域”这类没有入口边界和维护影响面的总述。

## Writer Agent 职责

Writer Agent 根据 Research 证据包写事实源。写入时遵守 [config-schema.md](config-schema.md) 的固定分节和所有权规则：

- `.workspace/repos/<repo>/index.md`：摘要、职责、读者要写提炼后的含义，不是文件清单。读者必须描述谁阅读或维护这个仓库；跨仓调用属于关系，工具/插件事实放常用操作或自定义小节。主要入口必须是仓库内真实可打开的文件或目录。常用操作只保留非显然操作和高概率误操作护栏；默认 dev/build/test/install、manifest 脚本清单与 npm/tnpm 等价拼写不写。
- `.workspace/repos/<repo>/domains/*.md`：一个真实业务域一篇。把扫描到的页面分组、模块、包归并成团队能认出的业务域，用代表性路径证据说明职责、关键流程、入口边界和维护影响面。任一仓库扫描到至少五个子区域却没有业务域文档时，`validate` 会阻断；`standalone` 不豁免，其他业务域覆盖质量交给 Review Agent 评审。不要罗列每个扫描子区域；提高信号的示例或分组区间足以辅助导航。
- `.workspace/repos/<repo>/shared/*.md`：存在跨切面的平台或共享机制时才写。聚焦权威配置、运行时入口、生成产物边界、mock/测试/工具链链接和维护注意事项。
- `.workspace/metadata.yaml`：集中归并 `positioning`、覆盖所有仓库（含独立仓库）的 `task_routes`、有证据支撑的 `relations`，以及没有依赖证据的 `standalone_repos`。

跨仓关系摘要保持定性，不复述易变的扫描计数。字段构成见上文「Research Agent 证据包」的跨仓关系候选项；粒度与 schema 红线见 [config-schema.md](config-schema.md) 的 relations。

## 业务域 / 共享文档契约

渲染器会解析业务域/共享文档。格式契约（`## 摘要` 开头、主题化 slug、路径深度、链接标签）统一见 [config-schema.md](config-schema.md) 的「仓库 Markdown 事实源」。

## 规则

- 每条非平凡断言都要有证据：读者可打开的仓库相对路径。读真实代码和配置；不要只凭目录名推断业务域。
- 依赖版本、IP、环境主机名、线上 URL 等易变值会悄悄过期。把声明位置记为持久事实，把字面值当成带日期的示例。跨仓版本事实要说明数值来自哪一侧的 manifest。
- 字面数量容易漂移。优先写规模描述，或指向目录 / `discovery.json`。确需精确数量时当场数一遍并写明是快照。不要在生成的扫描计数旁边再手写一份相同数量。避免行号锚点；改用方法名、bean ID、操作类型、路由名、文件路径或小节名。
- 写解读，不写清单。不要把 `discovery.json` 的原始页面/模块清单照抄一遍；仓库 index 已按数量汇总并链接快照。少量高价值事实优于大面积低密度覆盖。
- `standalone_repos` 只表达没有已知跨仓依赖，不代表仓库简单，也不豁免业务域研究。独立仓库扫描到多个会影响任务路由或维护判断的子区时，仍须提供业务域入口。
- 图谱深度是迭代出来的。稳定事实对当前任务有用就现在补；只是"将来可能有用"就留给后续任务，不要展开成全量重读。
- 自动检测的召回很窄：`scan` 只从 Maven 配置提及和 `src/services/<repo>` 生成客户端两类信号产出候选关系。其他栈的跨仓证据（npm 依赖、HTTP 调用、共享制品等）必须由研究员自己找；「扫描没发现依赖」不构成独立性证据。
- Research Agent 不得执行 `init`、`validate` 或任何渲染派生文档的命令；Writer Agent 写入事实源后由主 agent 统一运行。
- Review Agent 不做编辑，只返回可执行发现。`needs_human_judgment` 只用于仓库证据无法回答的问题，不要用来标记"还没读"的工作。

## 主 Agent 闭环

1. 按仓库切分派出 Research Agent，等待全部证据包返回。
2. 将证据包交给 Writer Agent；Writer Agent 写入仓库事实源和 `.workspace/metadata.yaml`。
3. 跑 `init`，再跑 `validate`。若 `validate` 因核心业务域缺失阻断，说明写作阶段没有沉淀最低限度的业务域骨架；补派 Research Agent 或让 Writer Agent 修补，不要降级检查。
4. `validate` 通过后，派 Review Agent 做只读语义评审。Review Agent 重点检查业务域是否覆盖任务路由承诺的主要能力、宽文档是否掩盖独立能力、关系证据是否足够具体、声明是否一致；并做“删除候选”压缩轮，移除可由源码/manifest/discovery 直接恢复的清单和跨层复述。
5. 对 Review Agent 的 `must_fix`，交回 Writer Agent 修补，然后重跑 `init` + `validate` + Review 受影响部分。`should_fix` 可以进入后续渐进维护，但必须明确记录为有意接受或待后续证据补齐。
6. 没有未处理的 `must_fix`，且脚本校验通过后，图谱才算就绪。
