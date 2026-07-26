---
name: awesome-presentation
description: >
  先把演示内容与用户聊清楚（grilling + 大纲批准），再用 GitHub fork 脚手架落成 React slide deck。
  主路径是内容发现与 Deck Spec 确认；init / 写 pages / build 只在用户批准大纲之后。
  触发词：演示文稿、slide deck、presentation、PPT、技术分享稿、大纲澄清、grilling 演示内容、
  git clone awesome-presentation、awesome-presentation、做一套 slides、生成演示。
  Use when the user runs /awesome-presentation。
---

# Awesome Presentation

把「一场说得清楚的演示」做成可运行的 React 文稿项目。

**最重要的环节不是生成 PPT，而是和用户把要讲的内容聊清楚。**  
脚手架、layout、组件、build 都是第二阶段。内容含糊时出一堆漂亮空壳页，比不出页更糟。

借鉴：

- [superpowers:brainstorming](https://github.com/obra/superpowers/blob/main/skills/brainstorming/SKILL.md)：**HARD-GATE**、一次一问、2–3 方案、分段批准
- [grilling](https://github.com/mattpocock/skills/blob/main/skills/productivity/grilling/SKILL.md)：沿决策树追问、每题给推荐、确认前不行动

脚手架真源：GitHub fork `https://github.com/MarioJames/awesome-presentation.git`；工程入口：`git clone --depth 1`（直接克隆，不再走 `@alipay/cmdai`）。本技能不复制 layout/component 长表。

## When to Use

- 要做技术分享 / 方案 / 培训 / 产品 / 管理 / 数据类演示，哪怕只有一句模糊想法
- 有长文、旧 PPT、草稿，需要先压成可讲的叙事再落项目
- 提到 `git clone awesome-presentation`、`awesome-presentation`、交互式演示脚手架

不要用：保险后台业务页、普通 Bigfish 应用、只改 GitHub fork 模板源码。

## **HARD-GATE**（必须遵守）

在用户**明确批准 Deck Spec（页级大纲）之前**：

- 禁止 `git clone`（脚手架）、安装依赖、写页面代码、改 registry、跑 build/visual
- 禁止用「先搭个空项目再说」绕过内容决策
- 禁止**擅自假定**项目目录；init 前必须单独问清安装路径并得到确认

用户催「直接做」时：仍先抛一版完整 Spec（主张 + 页表 + takeaway + 裁剪），要其一句话批准，再实现。这里的“完整”指**可审核的 Deck Spec**，不是逐页上屏文案或口播稿：每一页都必须在页表中显式写出 `takeaway`，不能用一段详细页稿代替页表后声称 Spec 已就绪。

完整问法与决策树见 [references/content-discovery.md](references/content-discovery.md)。

## Standard Flow

```text
内容发现（主路径）          实现（批准后）
─────────────────         ────────────────
读已有材料                  init + install
一次一问 grilling           读项目内 layouts/components 技能
2–3 叙事弧 + 推荐           按批准页表写 pages/registry
分段呈现 Deck Spec          test / build / 预览
用户批准  ───────────────►  交付路径与缺口
```

### Phase 0 — 内容发现（主路径）

按 [references/content-discovery.md](references/content-discovery.md) 执行，摘要：

1. **能查的先查**：用户贴的文、仓库里的稿、旧 deck；不要拿事实题烦用户。
2. **一次只问一个问题**；每题带**你的推荐答案**和简短理由。
3. **决策树顺序**：目的/成功标准 → 听众与场景 → 单一核心主张 → 叙事弧（2–3 方案）→ 证据素材 → 范围裁剪 → 页级大纲。
4. **分段确认 Spec**：元信息 → 叙事弧 → 页表 → 裁剪；每段问是否 OK。
5. **就绪条件**：主张 + 听众 + 完整页表（每页 takeaway）+ 裁剪确认 + 用户批准。

Deck Spec 最小页表形态：

```text
| # | id | section | title | takeaway | intent 草案 | 证据/素材 | 备注 |
```

此阶段可以只输出 Markdown Spec，**不创建工程**。

### Phase 1 — 工程前置（仅 Spec 批准后）

见 [references/init-and-setup.md](references/init-and-setup.md)。

1. **先问安装目录（必问，单独一题）**  
   未得到用户明确路径前，禁止 init。可推荐默认（如 `./<topic-slug>`），但必须等用户确认或改写。  
   示例：「项目要建在哪个目录？我建议 `./my-talk`（相对当前工作区），也可以给绝对路径。」
2. **再初始化**（直接 `git clone` GitHub fork）：

```bash
git clone --depth 1 https://github.com/MarioJames/awesome-presentation.git <用户确认的目录>
cd <用户确认的目录>
# 复刻 cmdai 后处理：删 .git、改 package.json.name 为目录名、删 repository 字段
tnpm install   # 或 pnpm install / npm install
```

目标目录非空且又不是现有脚手架时，必须停下来让用户在「换一个明确的空目录」与「明确授权在临时目录克隆后选择性合并」之间选择；“保留既有内容”不等于授权你自行决定合并语义。初始化或网络失败后也不要搜索 HOME 缓存、旧项目或系统临时目录拼装替代模板，直接报告失败与下一步。

已是本脚手架项目（有 `src/rules/layout-catalog.ts` + `src/pages/registry.ts`）则跳过克隆，但仍须确认是在该目录上改还是另开新目录。

### Phase 2 — 按批准 Spec 落页

见 [references/content-to-deck.md](references/content-to-deck.md) 与 [references/layout-conventions.md](references/layout-conventions.md)。

1. 读项目内：
   - `.claude/skills/presentation-layouts/SKILL.md`
   - `.claude/skills/presentation-components/SKILL.md`
2. 机器真源：`src/rules/*`、`src/pages/registry.ts`（不要另造规则表）。
3. 对 Spec 每一页：`recommendLayout` → primitive + 语义组件 → `src/pages/{number-name}/`。
4. registry **显式**写 `intent/layoutId/density/visualMode/takeaway`，并写 **`section`（中文）+ `sectionEn`（英文）**；deck-meta 左侧展示「中文 · English」。内容页 `SlideHeading` **不要**再传章节 eyebrow。
5. **左右结构右侧配图**：有生图技能则先问用户是否调用；无技能或拒绝则给出 prompt + 占位图（详见 layout-conventions）。
6. 去掉默认 `start` 页（业务 Deck 就绪后）。
7. 实现中若 Spec 与容量/证据冲突：**停写、改 Spec、再问用户**，禁止缩字硬塞。

禁止：默认三卡、Dashboard、装饰图填空、连续三页同 layout/dense、静默生图、用 eyebrow 重复章节。

### Phase 3 — 构建与交付

见 [references/validation-and-delivery.md](references/validation-and-delivery.md)。

```bash
tnpm test && tnpm run build
tnpm run dev   # http://127.0.0.1:5173  Hash /#/1
```

视觉基线：`visual:update`（先审 actual）→ `visual:check`。已有 baseline 可用 `tnpm run check`。

交付：项目路径、预览方式、`dist/index.html` / `dist/single-index.html`、门禁结果、未完成素材。

## Decision Rules

| 情况 | 动作 |
| --- | --- |
| 想法模糊 / 只有主题词 | 留在 Phase 0 grilling，不 init |
| 用户甩长文 | 先提炼草案再 grilling 裁剪，不从第一页开写 |
| Spec 未批准 | **HARD-GATE**，零工程动作 |
| Spec 已批准、无项目 | 先问目录 → `git clone --depth 1 <GitHub fork> <dir>` → install → 落页 |
| Spec 已批准、已有脚手架 | 确认目录后直接改 pages/registry |
| 目录未确认 | 禁止克隆；单独再问一次安装路径 |
| 目录非空且不是脚手架 | 保留原内容并停止；推荐新空目录，或等待用户明确授权临时目录克隆后选择性合并；禁止自行决定合并语义 |
| 克隆 / 下载失败 | 报告原命令与阻断，给权限 / 网络 / 重试建议；禁止从 HOME 缓存、旧项目或系统临时目录找替代模板 |
| 用户只要大纲不要代码 | Phase 0 交付 Spec 后结束 |
| 容量超限 | 拆页或换 recipe；回 Spec 确认；禁缩字号 |
| 无顺序/对比/层级/媒体 | 不用对应 process/compare/architecture/media recipe |
| 示例数字 | 标明「示例 fixture / 非生产数据」 |
| 左右结构需要右图 | 有生图技能 → 先问再调；否则 prompt + 占位图 |
| 章节标签 | registry `section` + `sectionEn`；禁止内容页 eyebrow 重复 |

## Progressive Disclosure

| 文件 | 何时读 |
| --- | --- |
| [references/content-discovery.md](references/content-discovery.md) | **默认必读**：grilling、决策树、Spec、**HARD-GATE** |
| [references/content-to-deck.md](references/content-to-deck.md) | Spec 批准后：recommendLayout、registry、组件骨架 |
| [references/layout-conventions.md](references/layout-conventions.md) | 中英章节 deck-meta、右侧生图/占位 |
| [references/init-and-setup.md](references/init-and-setup.md) | 批准后：问目录、`git clone` 初始化、依赖 / 权限 |
| [references/validation-and-delivery.md](references/validation-and-delivery.md) | test/build/visual、交付 |
| [references/gotchas.md](references/gotchas.md) | 排障与已知坑 |

## Gotchas（高频）

- **先聊天后脚手架**：未批准 Spec 就 init 是本技能最大失败模式。
- **一次多问**：连发一串问题 = 违反 grilling；拆开问。
- **只做秘书不做对手**：不挑战范围与重复页，产出的是备忘录不是演示。
- 初始化用 `git clone --depth 1 https://github.com/MarioJames/awesome-presentation.git`，不再走 `@alipay/cmdai` / `tnpx`。
- init 前必须问清项目目录；模板在 GitHub fork 仓库内，需 Git + 仓库读权限（public 或已配置访问）。
- 选型目录在项目内 `presentation-layouts` / `presentation-components`，本技能不抄长表。
- `visual:update` 不是修失败的捷径。

完整列表见 [references/gotchas.md](references/gotchas.md)。
