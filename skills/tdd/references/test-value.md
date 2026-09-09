# 常见误区与来源

用于判断当前用例是否值得保留，不是要求逐项补测试的清单。删除规则来自本技能的使用反馈；下列工程分享支持行为验证、减少实现耦合等原则，并不主张一律删除负向测试。

## 删除与负向契约

用户要求「移除自动恢复功能」时，删除实现及其专属测试和 fixture；已有正常启动测试继续验证启动行为。不要再加 `does not restore removed recovery`、源码禁词或 `expect(existsSync('recovery.ts')).toBe(false)`。这些用例只留下删除历史，没有新的产品契约。

如果用户另有明确要求「取消任务后不得继续发送请求」，就从任务入口触发取消，验证后续请求没有发生。是否使用 `.not`、测试名是否出现旧功能名，不是判断依据；依据是当前仍需保证的行为。仅要求删除某项能力，不足以自行发明“永久禁止它回来”的需求。

## 其他常见误区

| 场景 | 低价值做法 | 处理方式 |
| --- | --- | --- |
| 金额换算或字段映射 | 把实现中的公式／映射再抄进 expected | 用可独立确认的例子验证；共享同一错误来源的双份代码不能互证 |
| 重构组件状态或拆函数 | 锁私有状态名、子组件名和 helper 调用顺序 | 保留用户操作与输出断言，让等价重构无需改测试 |
| 点击按钮应提交订单 | 手动调用 mock submit，然后断言它被调用 | 通过按钮触发真实接线，在网络边界验证关键参数及成功／失败反馈 |
| 跨服务失败处理 | mock 整个 service 直接返回最终错误，再测试该错误 | 让边界依赖报错，执行真实 service 的错误处理路径 |
| 修改一处运营文案 | 新增整页 DOM 快照，或为删除提示新增“不再出现”用例 | 更新受影响的现有 locator／断言并做浏览器验收 |
| 扩充用例数量 | 多个普通正数重复同一条金额规则，每层都照抄 | 保留能区分独立错误的边界和规则；跨层用例只补不同的接线／持久化风险 |
| 测试列表中每个结果 | 空结果也能通过 `results.forEach(assert)` | 先验证需求要求的数量／成员，再验证其值，避免意外跳过所有断言 |
| 异步失败验证 | 不等待 Promise，或只在 `catch` 内断言 | 使用测试框架支持的 await／rejects 等方式，让未抛错或错误结果确实失败 |
| 修复后出现红灯 | 批量更新快照、把精确值改成 truthy、跳过失败用例 | 按当前需求判断是实现错误还是预期失效，再做对应修正 |

表中的替代方式只适用于确有未覆盖契约的场景。已有验证足够时，直接删掉重复用例，不要求每删一个测试就补一个替代品。

## 一手分享与采纳范围

- [Google Testing Blog：Change-Detector Tests Considered Harmful（2015）](https://testing.googleblog.com/2015/01/testing-on-toilet-change-detector-tests.html)：把生产代码的信息换一种写法再断言，只能发现变化，不能证明修改前后哪个行为正确。用于识别复制配置、源码扫描和机械快照等问题。
- [Kent C. Dodds：Testing Implementation Details（2020）](https://kentcdodds.com/blog/testing-implementation-details)：直接测试内部状态可能在正确重构时失败，却在事件接线错误时通过。采纳公共入口和使用者可见结果，不据此禁止所有单元测试。
- [Google Testing Blog：Don’t Overuse Mocks（2013）](https://testing.googleblog.com/2013/05/testing-on-toilet-dont-overuse-mocks.html)：过度 mock 会暴露实现细节，并依赖替身与真实依赖保持一致。采纳必要边界隔离，不机械限制 mock 数量，也不要求测试访问真实外部服务。
- [Google Testing Blog：Code Coverage Best Practices（2020）](https://testing.googleblog.com/2020/08/code-coverage-best-practices.html)：覆盖率证明代码执行过，不能证明断言充分；追数字可能制造低价值测试。用覆盖率发现缺口，结合业务风险判断，不照搬统一覆盖率目标。
- [Anthropic：Measuring and improving coding audit realism with deployment resources（2026）](https://alignment.anthropic.com/2026/coding-audit-realism/)：审计场景包括 agent 修改测试以制造通过、没有修正底层问题。用于提醒区分合理更新废弃断言与为变绿削弱有效断言；该研究不能证明所有测试修改或 agent 生成的测试都有问题。
