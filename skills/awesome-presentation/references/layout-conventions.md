# 布局与展示约定

实现阶段遵守。细节以生成项目内 `.claude/skills/presentation-*` 与源码为准。

## 1. 章节标签：中文 · English（deck-meta 左侧）

章节语境**不在**页内 `SlideHeading` 的 `eyebrow` 重复展示，而写在 registry，由播放器顶栏左侧统一渲染。

| 字段 | 语言 | 示例 |
| --- | --- | --- |
| `section` | 中文 | `背景`、`方案`、`总结` |
| `sectionEn` | 英文 | `Context`、`Solution`、`Summary` |

展示形态：

```text
背景 · Context                    03 / 12
└ deck-meta__label（左）          └ counter（右）
```

### 实现要求

```ts
// registry
{
  id: 'problem',
  title: '…',
  section: '背景',
  sectionEn: 'Context',
  // …
}
```

```tsx
// 页面：不要再传 eyebrow 当章节名
<SlideHeading
  title='问题不是工具不够，而是反馈太慢'
  lead='把验收从口头对齐变成可重复证据。'
/>
```

- 每页都应有可读的 `section`；业务 Deck **应填** `sectionEn`（中英成对）。
- cover/end 页若 `kind: 'cover'`，deck-meta 会隐藏，仍建议 registry 写好中英，便于一致性与无障碍文案。
- `SlideHeading.eyebrow` 仅保留给 showcase / 固定构图等非 Deck 壳场景；内容页禁止用它重复 `section`/`sectionEn`。

## 2. 左右结构右侧配图与生图

适用：`media-split`、`content-two-column` / `header-columns`、以及任何「左文右图 / 右媒体」构图。

### 素材选择

1. 用户提供图片路径/资产时直接引用，填写 alt/caption/source。
2. 生成插图属于当前制作要求或已有用户授权，且工具可用时直接生成，保存到项目 `src/assets/` 或用户指定目录；registry `media` 与 Figure 保持一致，source 标明“AI 生成 / 日期”。不把生成图当产品截图或生产数据。
3. 当前请求未涵盖生图且必须使用该能力时，说明用途与范围后取得授权，已有授权不重复问。无工具或用户拒绝时使用明确占位，给可复制 prompt 与替换步骤。
4. 占位交付记录页 id、占位路径、prompt（主题、构图、标签、比例）和来源缺口；可以改用无图 recipe 时不硬塞 Figure。

### 占位最小约定

```tsx
import placeholder from '../../assets/placeholders/media-right.svg';
import { Figure } from '../../components/figure';

<Figure
  src={placeholder}
  alt='（占位）证据链路：需求到浏览器验收的串联示意'
  caption='占位图；请按交付清单中的 prompt 生成后替换。'
  source={{ label: '占位 / 待替换', detail: '见 docs 或对话中的生图 prompt' }}
  aspect='4:3'
  fit='contain'
/>
```

若仓库尚无 placeholder 文件，可先加一张简单 SVG（直角、语义色、居中「图示占位」字样），颜色只用 token 或单色 currentColor，避免写死品牌素材。

## 3. 与容量/证据合同

- 叙事媒体仍须 alt + caption + source；占位不豁免合同，只豁免「必须是最终艺术成品」。
- 超限时拆页或换 recipe，不靠缩小图注。
- 连续多页右图时注意 Deck 节奏，避免每页都 media-split。
