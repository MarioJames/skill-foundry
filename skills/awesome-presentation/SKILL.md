---
name: awesome-presentation
description: 使用 awesome-presentation 脚手架创建或修改 React 演示文稿；内容讨论按需要进行。
---

# Awesome Presentation

把已有材料或演示目标做成可运行的 React slide deck。脚手架来源是 `https://github.com/MarioJames/awesome-presentation.git`，用 `git clone --depth 1` 初始化；布局与组件真源保留在生成项目内。

## 选择路线

- **直接完成**：材料与目标足够，或用户说“直接做 / 你定 / 别问了”时，读材料、内部整理 Deck Spec 页表，然后完成实现、构建和浏览器验收。已有内容授权、目录和实现范围直接使用，不增加大纲批准或独立目录确认。
- **讨论内容**：用户要求共同打磨、大纲讨论，或存在无法从材料推断且影响正确性的关键缺口时，读 [内容发现](references/content-discovery.md)，只澄清相关问题。用户只要大纲时交付大纲，不生成项目；要求先讨论时按其节奏，不提前实现。

内部页表记录核心主张、听众、页序、每页 takeaway、证据/素材及裁剪。一般叙事、措辞和布局取舍可在授权范围内自行决定；未知事实、真实数据和来源不得猜测。

## 完成演示

1. 整理材料与页表，复用用户已给的目标、页数和路径。确需讨论时才加载 [内容发现](references/content-discovery.md)。
2. 新项目按 [初始化与环境](references/init-and-setup.md) 检查目录并 clone；已有脚手架项目且用户要在此修改时直接使用。未指定路径可在当前工作区选择新的主题子目录并说明；非空陌生目录的合并/覆盖须有明确授权。
3. 读取生成项目内 `.claude/skills/presentation-layouts/SKILL.md` 和 `.claude/skills/presentation-components/SKILL.md`，按 [页表到代码](references/content-to-deck.md) 实现。机器规则以 `src/rules/*` 和 `src/pages/registry.ts` 为准，不复制第二份容量表。
4. 按 [布局约定](references/layout-conventions.md) 写 registry、章节和图像来源。显式填写 `intent/layoutId/density/visualMode/takeaway`、`section/sectionEn`；业务 Deck 就绪后移除默认 start 页。
5. 按 [验收与交付](references/validation-and-delivery.md) 完成项目检查、构建，以 `browser-harness` 为浏览器验收入口；项目 visual runner 补充尚未覆盖的矩阵和像素检查。通过后默认清理本次资源，已有保留要求时按其范围保留。

## 约束

- 包管理按当前请求和项目约定选择；无明确要求时优先 bun，其次 pnpm，再 npm。tnpm 仅用于用户/项目明确要求的内网环境，不作为默认命令。
- 初始化只使用指定 GitHub fork；克隆/安装失败时根据本次错误排障并报告，不扫描 HOME 缓存、旧项目或系统临时目录拼装替代模板。
- 非空目录合并不因“保留既有内容”自动获准。只修改已授权的文件；新增或真实覆盖风险超出授权时才询问。
- 材料不足可明确占位、标待补或改口播；不编造生产数据、引用或产品截图。示例数据须标明“示例 / 非生产数据”。
- 容量以项目 catalog、recommendLayout 与 diagnostics 为准。超限时在目标和页数约束内拆页、换 recipe 或删冗余并同步页表，不缩小正文/图注硬塞；只有必须改变用户固定约束或核心主张时才澄清。
- recipe 要有对应的顺序、比较、层级或媒体语义；不默认三卡，不用装饰图填空。章节由 registry 的 deck-meta 展示，内容页不以 eyebrow 重复章节。
- 生图按现有授权及可用工具执行，标明 AI 来源；缺素材时提供明确占位与替换信息，不伪造真实证据。
- 不用 `visual:update` 掩盖失败；先审 actual，确认变化符合本次授权，再更新基线并复验。

交付项目路径、实际 APP_URL、构建产物、关键页面与错误结果、素材缺口及资源清理状态。排障时按需读 [已知问题](references/gotchas.md)。
