# 从已批准 Deck Spec 到页面代码

**前提**：用户已批准 [content-discovery.md](content-discovery.md) 中的 Deck Spec。  
若无批准大纲，回到内容发现，不要从本文件开写。

## 目标

把**已批准**的页表落成：

1. `src/pages/{number-name}/`
2. `src/pages/registry.ts`
3. 每页与 Spec 一致的 `takeaway` + 正确的 recipe / 组件

权威细则以项目内技能为准：

- `.claude/skills/presentation-layouts/SKILL.md`
- `.claude/skills/presentation-components/SKILL.md`

机器真源：`src/rules/layout-catalog.ts`、`recommend-layout.ts`、`deck-validator.ts`。

## Step A — 对照 Spec，不重新发明叙事

- 页序、标题、takeaway 以批准 Spec 为准；实现中可微调用词，**不擅自加页/删主张**。
- 若容量或证据迫使结构调整：暂停编码，更新 Spec 片段并请用户确认。
- 默认 `start` 脚手架页在业务 Deck 就绪后删除。

Spec 页表 → 实现清单：

```text
| # | id | section（中） | sectionEn（英） | title | takeaway | intent | → layoutId | 组件 | 右图？ |
```

章节中英写入 registry，由 deck-meta 左侧展示；见 [layout-conventions.md](layout-conventions.md)。

六类场景仅作 recipe 起点（最终以 `recommendLayout` + catalog 为准）：

| 场景 | 典型 recipe 倾向 |
| --- | --- |
| 技术分享 | `architecture-matrix`、`process-horizontal`、`content-stack` |
| 课程培训 | `process-horizontal`、`content-stack`、`summary-stack` |
| 产品介绍 | `media-split`、`content-*`、`end-focus` |
| 方案汇报 | `comparison-split`、`summary-stack` |
| 管理汇报 | `summary-stack`、`data-focus`、`statement-focus` |
| 数据分析 | `data-focus`（insight 先于图） |

## Step B — recommendLayout

对每一页构造 `ContentProfile`（以项目导出为准）：

```ts
import { recommendLayout } from '../rules/recommend-layout';

const result = recommendLayout({
  intent: 'compare',
  itemCount: 2,
  titleLength: 18,
  bodyLength: 160,
  hasComparison: true,
  density: 'standard',
  previousLayoutIds: ['section-focus'],
  previousDensities: ['sparse'],
});
// 审阅：layoutId / alternatives / discouraged / reasons / capacityWarnings
```

必填：`intent`、`itemCount`、`density`。  
有事实就补：`titleLength`、`bodyLength`、`hasData`、`hasChart`、`imageCount`、`hasComparison`、`hasSequence`、`hasHierarchy`、`hasSingleTakeaway`、`previousLayoutIds`、`previousDensities`。

`capacityWarnings` 非空 → 改内容/拆页/换 recipe，并与 Spec 对齐；不要只取 `layoutId` 硬写。

## Step C — 建页目录

```text
src/pages/01-cover/
  index.tsx
  style.less          # 仅页面特有样式；颜色只用 --color-*
src/pages/02-problem/
  index.tsx
  style.less
…
src/pages/registry.ts
```

最小骨架（`top-bottom` + heading + callout）：

```tsx
import { SlideHeading } from '../../components/slide-heading';
import { Callout } from '../../components/callout';
import { TopBottomLayout } from '../../layouts/top-bottom';
import './style.less';

export function ProblemPage() {
  return (
    <TopBottomLayout
      className='problem-slide'
      data-density='sparse'
      data-visual-mode='type'
      header={
        // 章节中英在 registry.section / sectionEn，不要写 eyebrow
        <SlideHeading
          title='问题不是工具不够，而是反馈太慢'
          lead='把验收从口头对齐变成可重复证据。'
        />
      }
    >
      <Callout label='Takeaway' role='note'>
        先固定门禁，再讨论功能列表。
      </Callout>
    </TopBottomLayout>
  );
}
```

导入：从 `src/layouts/<name>`、`src/components/<name>` **目录直引**；不要造 barrel。

## Step D — registry

```ts
import type { SlideDefinition } from '../components/deck-player/types';
import { CoverPage } from './01-cover';
import { ProblemPage } from './02-problem';

export const slideRegistry = [
  {
    id: 'cover',
    title: '…',
    section: '开场',
    sectionEn: 'Open',
    component: CoverPage,
    takeaway: '…', // 与批准 Spec 一致
    intent: 'cover',
    layoutId: 'cover-split',
    density: 'sparse',
    visualMode: 'type',
    bodyLength: 40,
  },
  // …
] satisfies readonly SlideDefinition[];
```

每页**必须显式**：`intent`、`layoutId`、`density`、`visualMode`、`takeaway`，并写 **`section` + `sectionEn`**（deck-meta 左侧「中文 · English」）。  
媒体/图表按项目合同补 `media` / `chart`；左右右图流程见 [layout-conventions.md](layout-conventions.md)。  
diagnostics 挂在 `window.__PRESENTATION_VALIDATION__.diagnostics`。

## Step E — 组件与证据合同（摘要）

完整目录读项目内 `presentation-components`。硬约束：

| 组件 | 硬要求 |
| --- | --- |
| `Metric` | `label`/`value`；单页最多一个 hero |
| `Figure` | `src`/`alt`；叙事图还要 `caption`/`source` |
| `ChartFigure` | `insight`/`unit`/`range`/`source`/`summary`/`data` 全必填；1–7 条有限非负 |
| `SourceNote` | `label` 必填 |
| `StepFlow` | 真实顺序横向流程 |
| `SurfaceFrame` | 仅 header/main/footer 语义；普通块直角无阴影 |

示例数据必须标明非生产数据。Spec 里标了「待补」的素材：用明确占位或改口播，不编造。

## Step F — 静态自检

- 缺 metadata → 补五项必填
- 容量超限 → 拆页或换 recipe，必要时回内容发现
- 反模式（连续同 layout、无比较维度却 compare）→ 改结构
- takeaway 与 Spec 漂移 → 改回 Spec 或再确认用户

需要时调用 `validateDeck(slideRegistry)`（以项目导出为准）。
