# 项目范式补充：Lobe / Admin

用于 Lobe/Admin 及明确沿用它们范式的项目，具体组件、接口和目录以当前仓库可用实现为准。

- 完整功能放在 src/features，跨页面基础组件放在 src/components，单页面私有 UI 放在页面自己的 components 目录。
- 通用表单字段收进 src/components/FormFields，各子组件通过统一 index.tsx 导出。
- 页面 layout、ConfigProvider、主题、国际化和基础组件沿用 Admin/Market 的已有组织方式，不在各页面另建一套。
- 表格优先使用项目已封装的 Table，查询、重置、刷新和操作区沿用同一套行为。
- 已有 Loading、Error 和权限错误页直接复用，简单加载态使用现成 Spin，不重新手写同等组件。
- Store 层先对照 Admin 的实际实现组织职责与调用，不另造笼统的数据访问包装。
- 全局共享类型放 src/types，模块私有类型留在所属模块。
- Next.js 与 Hono 集成时采用 Lobe 的 API 拦截路由，把请求交给 Hono app，再由业务 router 分发。
- 采用这套 Hono 范式时以 src/server/app.ts 为入口，按 routers、controllers、services、types、middlewares 分工，不再嵌套 server/hono 或自创 admin.run 调用层。
- tRPC 共享客户端已负责请求错误通知时，页面不重复调用报错或仅为 Alert 保留本地错误状态，字段错误交给 Form.Item。
- 企业改造先核对社区版已有行为，满足需求时继续复用，不无故替换成熟链路。
- tests 按 database、trpc 等实际职责分类，不把全部测试平铺，也不保留没有测试的占位目录。
- Next.js 页面使用真实 page/layout 路由，括号分组不进入 URL，实际路径段与地址要求一致。
