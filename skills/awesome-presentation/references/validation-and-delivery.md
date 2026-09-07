# 构建、验收与交付

命令真源是项目 `package.json`。以下使用 bun 示例；按请求或项目选择 pnpm 时改用 `pnpm run <script>` / `pnpm exec <tool>`，tnpm 仅限明确要求的环境。

## 项目检查

| 目标 | 命令示例 | 说明 |
| --- | --- | --- |
| 单测 | `bun run test` | 使用项目脚本，避免把 bun 内置 test runner 当项目测试；不为示例文案堆快照 |
| 构建 | `bun run build` | 字体子集、类型、站点、单 HTML 与 verify，以实际脚本为准 |
| 单文件别名 | `bun run build:single` | 如存在；通常优先 build |
| 视觉回归 | `bun run visual:check` | 相对已有 baseline 检查，不写 baseline |
| 更新视觉基线 | `bun run visual:update` | 先审 actual，变化符合本次授权才更新并重跑 check |
| 组合检查 | `bun run check` | 如组合 test/build/visual:check 已覆盖，不重复跑同一检查 |

首次成稿先运行项目测试和 build。已有 baseline 的局部改动可使用项目 check；失败时按实际结果修复。`visual:update` 不是消除失败按钮；只有用户要求人工审批基线或变化超出本次授权时才等批准，不给普通交付附加新关卡。

## 浏览器验收入口

加载可用的 `browser-harness` 技能，通过 `prepare <项目绝对路径>` 获取实际 `APP_URL`，不写死 5173，也不另起第二个 dev server。若项目选择 pnpm，可通过 `BH_DEV_COMMAND` 显式指定该项目的开发脚本（方式以 browser-harness 为准）。前置缺失时报告阻断，不能将构建成功描述为浏览器验收通过。

使用 agent-browser 检查关键页面：键盘翻页、主题切换、Hash 直达（如 `/#/1`）、页面无溢出、字体与图片加载；采集 screenshot、console、network 证据，交互后的瞬时状态按 browser-harness 使用 `--reuse-page`。

项目 visual runner 补充 browser-harness 未覆盖的矩阵、diagnostics 与像素回归，命令按其已有 URL 参数/环境变量注入同一个 APP_URL。若 runner 自行管理服务或不支持 URL 注入，遵循项目真实配置并说明，不杜撰参数或重复启动同端口服务。

典型项目矩阵和检查项（以项目脚本为准）：

- registry 全部页面 × 1280×720 / 1024×768 × light/dark，以及 system 主题偏好。
- reduced motion、Hash、`intent/layoutId/density/visualMode` metadata。
- `window.__PRESENTATION_VALIDATION__.diagnostics` 无未豁免 error。
- overflow、安全区、正文/注释字号下限、字体与图片加载。
- console / page error、失败请求、HTTP 错误、相对已有 baseline 的像素 diff。

需要 Chromium 时按当前安装授权使用 `bun x playwright install chromium` 或 `pnpm exec playwright install chromium`。证据通常在 `artifacts/visual-validation/` 与其 `diff/` 子目录，实际路径以 runner 输出为准。

已覆盖的检查不机械重跑。验收通过后按 browser-harness 默认 cleanup，并关闭本次浏览器/验证进程；用户已有保留或远程走查要求才保留对应资源，公网创建仍需现有授权。

## 交付

报告项目路径与按实际包管理器重新启动的命令、实际 APP_URL、关键页面结果、console/network 错误和证据位置。说明 dev server、浏览器、验证进程是否释放；保留时写明原因、PID 和端口。

构建产物通常为 `dist/index.html` 与 `dist/single-index.html`，以构建输出核对。单文件体积上限和字体子集以项目 packaging 配置为准，不通过塞大位图或恢复全量字体绕过容量约束。列明占位图、来源缺口、示例数据、未建立的 baseline 等实际限制。

不可只跑类型/构建或单张截图就宣称完整视觉验收通过，也不可删除 diagnostics、伪造证据或盲目更新 baseline。
