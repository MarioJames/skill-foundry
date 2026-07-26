# Gotchas

来自内容发现与 GitHub fork 集成的高频坑；发现新失败模式时优先记在这里。

## 内容发现（最高优先）

0. **未批准 Spec 就 init / 写页**
   本技能最大失败模式。**HARD-GATE**：无用户批准页表则零工程动作。

1. **未问安装目录就 init**
   Spec 批准后、执行 `git clone` 前，必须单独问清项目路径并得到确认；禁止静默写到默认目录。

2. **一次消息问一串**
   违反 grilling。一次一题，且每题带推荐答案。

3. **只整理不挑战**
   用户堆料时不裁剪、不压主张，产出的是文档不是演示。主动提议删页/合并。

4. **用版式讨论替代内容决策**
   「要不要三栏」「用哪个组件」在 Spec 批准前都是跑题。

5. **编造数据撑版面**
   缺证据就标待补或改文字主张；禁止伪装生产统计。

## 初始化

6. **直接 `git clone` GitHub fork，不再用 `tnpx`/`@alipay/cmdai`**
   权威命令：`git clone --depth 1 https://github.com/MarioJames/awesome-presentation.git <用户确认的目录>`。

7. **模板在 GitHub fork 仓库内**
   clone 直接拉 fork 仓库；离线或无 GitHub 访问会直接失败。

8. **非空目录默认失败**
   Git 拒绝克隆到非空目录（`destination path already exists`）。不要绕到临时空目录 clone 后自行合并——这仍然替用户决定了合并语义。先确认用户是在新空目录创建，还是明确授权临时目录克隆后选择性合并。

9. **package name 须手动改**
   旧版 cmdai 会自动改 `package.json.name` 为目录名归一化并删 `repository` 字段；现需 clone 后手动处理（jq 或手改）。不要假设 name 仍是 `awesome-presentation`。

10. **隐藏目录会复制**
    `.claude/` 等会进入目标项目；这是预期，项目内布局/组件技能依赖它。

11. **失败后拿缓存或旧项目续命**
    克隆、模板下载或安装失败后，禁止扫描 HOME 缓存、别的项目或系统临时目录寻找旧脚手架继续生成。报告原始阻断与所需权限/网络条件，等待重试；缓存命中不证明版本或来源可信。

## 编写 Deck

12. **两份「布局真相」是错的**
    不要在 Prompt 或本技能里手抄 recipe 容量表当第二真源。以 `src/rules/layout-catalog.ts` 与项目内 skills 为准。

13. **`columns` ≠ 整页标题带**
    需要「上标题 + 左右工作区」用 `TopColumnsLayout` / `header-columns`；`ColumnsLayout` 是可嵌套同级网格。

14. **默认三卡是反模式**
    三项解释优先纵向 `content-stack`，不要自动画三张卡片。

15. **dense 不缩正文**
    dense 只收紧结构间距和标题层级；body/caption 字号下限不变。超限就拆页或回 Spec。

16. **主题只换颜色**
    禁止在页面 Less 写 hex/`rgb()` 或自造 light/dark 分支；只用 `--color-*`。

17. **证据合同**
    叙事图缺 caption/source、图表缺 insight/unit/range/summary、示例数据不标注，都会在 validator / visual 阶段爆。

18. **registry 五项必填**
    依赖默认值会导致 diagnostics error。每次登记都写全 `intent/layoutId/density/visualMode/takeaway`。

19. **忘掉删 start 页**
    业务 Deck 交稿前应去掉脚手架起步页，除非用户明确要保留。

20. **用 SlideHeading.eyebrow 重复章节**
    章节中英写 registry `section`/`sectionEn`，由 deck-meta 左侧展示；内容页不要再传 eyebrow。

21. **静默生图或假截图**
    左右结构右图：有技能先问再调；无技能给 prompt + 占位。禁止未询问就生图，禁止伪装生产截图。

22. **实现时静默改叙事**
    加页、改 takeaway、删主张必须回到内容发现并再批准。

## 验收

23. **`visual:update` 不是 fix 按钮**
    它替换获批 PNG。必须先看 actual，再 update，再 check。

24. **未装 Chromium**
    visual 命令失败时先 `tnpm exec playwright install chromium`。

25. **单文件体积**
    `dist/single-index.html` 有体积门禁；塞入过大位图会失败。优先压缩图或改外链策略（以项目 packaging 文档为准）。

26. **字体子集**
    文案变更后 build 会按用字子集；不要改回 `@fontsource-variable/*` 全量字体。

## 技能边界

27. **本技能 vs 项目内 skills**
    本技能：内容发现（主）+ init 编排 + 门禁。
    项目内 `presentation-layouts` / `presentation-components`：完整选型目录（实现阶段）。
    init 后不读项目内技能就写页，容易选错 recipe/组件。

28. **与 inspecs / browser-harness 的关系**
    保险迭代工作流插件不是做 slide 的必选项。browser-harness 可选用于额外浏览器证据，不能替代项目 visual runner。
