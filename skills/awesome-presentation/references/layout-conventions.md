# 布局与展示约定

实现阶段（Spec 已批准）必须遵守。细节以生成项目内 `.claude/skills/presentation-*` 与源码为准。

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

### 流程

```text
需要右侧图？
  ├─ 否 → 不硬塞 Figure
  └─ 是 → 用户是否已提供图片路径/资产？
        ├─ 是 → Figure 引用 + alt/caption/source
        └─ 否 → 检测宿主是否有生图技能
              ├─ 有 → 单独询问是否调用（说明用途/风格）
              │     ├─ 同意 → 生成 → 写入 src/assets → Figure
              │     └─ 拒绝 → 占位 + 给出 prompt
              └─ 无 → 占位 + 给出 prompt（用户自行生成后替换）
```

### 有生图技能时

1. **先问再调**，禁止静默生成。问法示例：

   > 这一页右侧需要一张「证据链路」说明图。当前环境有生图技能（如 `guizang-material-illustration` / Imagine）。是否允许我现在生成并放进项目？  
   > **建议：允许**，比例 4:3，扁平说明风，中文短标签。

2. 获准后生成，保存到项目 `src/assets/`（或用户指定目录），用 `Figure` 引用。
3. registry `media` 与 Figure 的 alt/caption/source 对齐；source 写清「AI 生成 / 生成日期」等。

### 无技能或用户拒绝时

1. 输出**可复制的生图 prompt**（主题、构图、标签文案、宽高比、禁忌：无水印/无乱码英文 UI）。
2. 页面落入**占位图**（本地 SVG/PNG placeholder 即可），`Figure` 仍给有效 alt/caption；`source` 标明「占位 / 待用户按 prompt 替换」。
3. 在交付说明里列出：页 id、占位路径、完整 prompt、替换步骤。
4. 不要假装已有真实产品截图或生产数据图。

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
