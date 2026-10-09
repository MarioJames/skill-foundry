# 构建、验收与交付

命令真源是本次项目的 `package.json` 和 `presentation` CLI。当前 fork 使用 pnpm workspace，以下按目标 Deck id 执行；既有项目以其实际约定为准，tnpm 仅限明确要求的环境。

## 项目检查

| 目标 | 命令示例 | 说明 |
| --- | --- | --- |
| 单测 | `pnpm test` | 使用项目脚本，不把 bun 内置 runner 当项目测试；不为示例文案堆快照 |
| 构建 | `pnpm presentation build <id>` | 字体子集、类型、站点、单 HTML 与 verify，以实际脚本为准 |
| 视觉回归 | `pnpm presentation visual:check <id>` | 相对已有 baseline 检查，不写 baseline |
| 更新视觉基线 | `pnpm presentation visual:update <id>` | 先审 actual，变化符合本次授权才更新并重跑 check |
| 组合检查 | `pnpm presentation check <id>` | 若 test/build/visual:check 已覆盖，不重复跑同一检查 |

首次成稿先运行项目测试和 build，再检查 actual 截图、diagnostics、metadata、字号和 overflow。新 Deck 缺 baseline/manifest 时先确认实际内容正确、各项规则检查通过，再按已有成稿授权建立 baseline 并执行 `visual:check`；缺基线本身不能算回归通过。已有 baseline 的局部改动可使用项目 check。`visual:update` 不是消除布局或诊断失败的按钮。

## 浏览器验收入口

加载可用的 `browser-harness` 技能，通过 `prepare <项目绝对路径>` 获取实际 `APP_URL`，不写死 5173，也不另起第二个 dev server。若项目选择 pnpm，可通过 `BH_DEV_COMMAND` 显式指定该项目的开发脚本（方式以 browser-harness 为准）。前置缺失时报告阻断，不能将构建成功描述为浏览器验收通过。

使用 agent-browser 检查关键页面：键盘翻页、主题切换、Hash 直达（如 `/#/1`）、页面无溢出、字体与图片加载；采集 screenshot、console、network 证据，交互后的瞬时状态按 browser-harness 使用 `--reuse-page`。

项目 visual runner 补充 browser-harness 未覆盖的矩阵、diagnostics 与像素回归。当前 `packages/tooling/scripts/visual-runner.mjs` 不接受 APP_URL 注入，会选择空闲端口启动自己的 preview 并在 finally 清理；按其真实配置运行并记录该 URL。browser-harness 继续使用成功 prepare 的 APP_URL，不杜撰 URL 参数或同时占用同一端口。

典型项目矩阵和检查项（以项目脚本为准）：

- registry 全部页面 × 1280×720 / 1024×768 × light/dark，以及 system 主题偏好。
- reduced motion、Hash、`intent/layoutId/density/visualMode` metadata。
- `window.__PRESENTATION_VALIDATION__.diagnostics` 无未豁免 error。
- overflow、安全区、正文/注释字号下限、字体与图片加载。
- console / page error、失败请求、HTTP 错误、相对已有 baseline 的像素 diff。

需要 Chromium 时按当前授权使用 `pnpm exec playwright install chromium`，在独立缓存中下载须先核实工具支持。原生 runner 需要外部浏览器时使用它已有的 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`，显式指向已核实的工具管理 Chromium；不依赖系统 Chrome 回退。证据通常在 `artifacts/visual-validation/<id>/` 与其 `diff/` 子目录，实际路径以 runner 输出为准。

已覆盖的检查不机械重跑。验收通过后按 browser-harness 默认 cleanup，并关闭本次浏览器/验证进程；用户已有保留或远程走查要求才保留对应资源，公网创建仍需现有授权。

## 交付

报告项目路径与按实际包管理器重新启动的命令、实际 APP_URL、关键页面结果、console/network 错误和证据位置。说明 dev server、浏览器、验证进程是否释放；保留时写明原因、PID 和端口。

构建产物通常为 `presentations/<id>/dist/index.html` 与 `single-index.html`，以构建输出核对。单文件体积上限和字体子集以项目 packaging 配置为准，不通过塞大位图或恢复全量字体绕过容量约束。列明占位图、来源缺口、示例数据、未建立的 baseline 等实际限制。

不可只跑类型/构建或单张截图就宣称完整视觉验收通过，也不可删除 diagnostics、伪造证据或盲目更新 baseline。
