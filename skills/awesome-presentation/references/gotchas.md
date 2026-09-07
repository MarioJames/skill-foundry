# 已知问题

## 内容与授权

- 信息足够或用户授权自行决定时，内部页表后直接完成；不要退回“先批 Spec”、目录必问或逐段必批。用户明确要求讨论时才按其节奏讨论。
- 已给材料先读，裁剪重复信息，每页一个 takeaway；页面漂亮不能弥补缺事实。未知数据标待补或改口播，示例标为非生产数据。
- 容量调整先拆页或换 recipe 并同步页表，只有必须改变用户固定约束或核心主张且未获授权时才澄清。

## 初始化

- 权威命令：`git clone --depth 1 https://github.com/MarioJames/awesome-presentation.git <dir>`，不用旧 cmdai/tnpx 内部模板入口。
- 请求给出路径或指向已有脚手架时直接使用；未指定时可选安全新子目录并说明。非空陌生目录仍须有明确合并/覆盖授权，不能自行临时 clone 后复制进去绕过。
- 新 clone 的 `package.json.name` 和模板 `repository` 要调整；只移除本次 clone 的模板 `.git`，不碰已有项目 Git 历史。
- `.claude/skills/presentation-layouts/SKILL.md` 与 `.claude/skills/presentation-components/SKILL.md` 是项目内选型指导，隐藏目录应完整保留。
- 克隆/安装失败后只排查本次来源与错误，不扫描缓存或其他项目拼装旧模板。详见 [初始化与环境](init-and-setup.md)。
- 包管理器按请求/项目约定，无约定优先 bun、pnpm；不无条件使用 tnpm。项目测试脚本用 `bun run test`，避免误选 bun 内置 runner。

## 页面实现

- 布局真源是 `src/rules/layout-catalog.ts` 和项目内 skills，不在提示中手抄第二套容量表。
- 上标题加左右工作区用 `TopColumnsLayout` / `header-columns`；`ColumnsLayout` 是可嵌套同级网格。
- 三项解释不自动做三卡，可用纵向 `content-stack`；连续布局和 dense 选择考虑 Deck 节奏。
- dense 只收紧结构间距和标题层级，不降低 body/caption 字号下限；超限拆页或换 recipe。
- 页面 Less 只用 `--color-*`，不写 hex/rgb 或自造 light/dark 分支。
- 叙事图保留 alt/caption/source；图表保留 insight/unit/range/source/summary/data 等项目契约。生图标明 AI 来源，不冒充生产截图；无素材时明确占位。
- registry 显式写 `intent/layoutId/density/visualMode/takeaway`；章节中英写 `section/sectionEn`，内容页不以 `SlideHeading.eyebrow` 重复章节。
- 业务 Deck 就绪后移除默认 start 页，除非用户要求保留。详见 [实现](content-to-deck.md) 与 [布局约定](layout-conventions.md)。

## 验收

- browser-harness 是浏览器验收入口；项目 visual runner 补其未覆盖的矩阵、diagnostics 和像素回归，使用真实 APP_URL 与实际项目配置。
- `visual:update` 替换 baseline，先审 actual；不能用它盲目清除回归失败。
- 字体子集与单 HTML 体积按项目 packaging 规则，不恢复全量字体或无限塞位图。
- 验收通过后默认清理，已有远程/保留要求才进入对应分支。完整交付规则见 [验收与交付](validation-and-delivery.md)。
