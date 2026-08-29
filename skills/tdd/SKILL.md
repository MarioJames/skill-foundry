---
name: tdd
description: "MUST use before writing or changing any production code or tests. Use when implementing a feature, bugfix, refactor, scaffold, new file, wiring, API, UI, or adding a unit/e2e test. Triggers: 实现, 开发, 加功能, 修bug, 重构, 改代码, 写测试, TDD, 单测, implement, feature, fix, refactor. Default is fast path unless the assertion can fail on a wrong implementation of existing files. Do not use for read-only questions with no code or test changes. Slash: /tdd"
---

# TDD 规范

默认快速开发。覆盖率不是目标。新文件 / 新 class / 新函数本身不是写测试的触发器；触发器是新行为。

任何 always-TDD skill 都不是默认流程。过不了门槛就把它们当不存在。

## 门槛

动笔前只问一句：这条断言能不能在「目标文件已在、符号已导出」时，仍因实现算错而失败？

- 不能 → 禁止新建。
- 能，且错了会进生产或被当契约 → 先写会失败的测试，再写最小实现；或实现后按需求补同一类契约。
- 其余 → 直接实现，用对应方式验收。

期望值来自需求，不来自刚写的函数体。把实现翻译成绿测，叫确认式开发，不是测试。

## 何时 TDD

仅当能独立于实现写出 Given / When / Then（输入 → 输出 / 错误码 / 是否发请求）：

- 业务规则、校验、状态机、金额 / 日期 / 枚举 / 单位换算
- 请求 / RPC 参数组装、字段映射、权限、幂等、失败路径
- 错误码与分支（断言 code / 是否发请求，不要把完整中文提示当契约）
- 修 bug：先补能复现当前错误行为的用例（单测或浏览器 e2e）

换一种错误映射、错误金额或错误分支必须红。

## 何时不要

直接实现，禁止为红转绿新建测试：

- 新建文件、barrel、re-export、路由注册、provider / 模块接线、薄包装
- 文案、样式、布局、图标、className
- 注释、README、类型-only、生成物（OneAPI / mock / migration）
- 没有分支、计算、状态变化或错误路径的代码
- 探索 / 原型：先跑通，契约稳定后再钉

已有测试锁了字面量：只同步断言或 locator，不要新开一轮 TDD。

## 有效 case

必须同时成立：

1. 钉可观察行为，不钉结构。
2. 错误实现会红；删掉生产文件才红的，不是测试。
3. 重构内部结构仍绿（对 public 行为敏感，对实现不敏感）。
4. 一条行为；名字说清行为，不要 `and`。
5. 期望值能从需求推出，不读实现、不抄函数体。

```ts
expect(mapRole('viewer')).toEqual({ canEdit: false, canView: true })
expect(createOrder({ amount: -1 }).code).toBe('INVALID_AMOUNT')
```

## 无效 case

写了也不算，删掉重来：

- `existsSync` / 路径存在 / `toBeDefined` / `typeof === 'function'` / 目录快照
- render 不炸、组件能 mount、「标题等于某字符串」
- 常量等于自己、getter / setter、无断言调用
- 只 `toHaveBeenCalled`、把 mock 当被测对象
- snapshot / `toHaveTextContent` 锁运营文案
- 测第三方库或框架本身
- 为覆盖率、为新方法、为「看起来做了 TDD」而写
- 组合爆炸（4 × 6 全排列）；测可组合的叶子行为

```ts
expect(existsSync(resolve(root, 'packages/database/src/instance/adminDB/index.ts'))).toBe(true)
```

## 甜点位

测试是赌注：只下在「算错会进生产」的地方。一条能抓住错误金额的测试，胜过十个文件存在断言。

| 改动 | 做法 |
|---|---|
| 可算错的规则 / 映射 / 权限 / 失败路径 | 少量契约单测；能独立写出期望就 TDD |
| 前端交互 / 文案 / 样式 | 浏览器验收；不写 render 单测 |
| 接线 / 脚手架 | type-check + 会碎的已有测试 |
| 修 bug | 先复现，再修 |

先写后写不是甜点；断言是否独立于实现才是。Agent 圈里走仪式化红转绿通常更贵、测也不更好。测要少、要能杀死错误实现、要让重构仍然绿。

沿用仓库已有验证形态，没有就不要发明测试栈。只跑受影响的单测和相关 e2e；全量仅在需求明确要求、或相关用例盖不住风险时才跑。
