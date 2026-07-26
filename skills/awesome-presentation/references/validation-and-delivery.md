# 构建、验收与交付

命令真源是项目 `package.json`；以生成项目内脚本为准。

## 命令矩阵

| 目标 | 命令 | 说明 |
| --- | --- | --- |
| 单测 | `tnpm test` | 规则、组件契约等；不为示例文案堆快照 |
| 构建 | `tnpm run build` | 字体子集 → tsc → 站点 → 单 HTML → verify；产物 `dist/index.html` + `dist/single-index.html` |
| 仅单文件别名 | `tnpm run build:single` | 兼容入口，优先仍用 `build` |
| 开发预览 | `tnpm run dev` | 默认 `http://127.0.0.1:5173`；Hash `/#/1` |
| 批准视觉基线 | `tnpm run visual:update` | **有意批准**；先审 actual，再跑 |
| 视觉回归 | `tnpm run visual:check` | 与已批 baseline 像素对比，不写 baseline |
| 持续门禁 | `tnpm run check` | test → build → visual:check（需已有合法 baseline） |

## 推荐验收顺序

### 首次成稿 / 页数或布局大变

```bash
tnpm test
tnpm run build
tnpm run dev
# 浏览器扫一遍：键盘翻页、主题切换、Hash 直达、关键页无溢出
```

需要像素门禁时：

```bash
tnpm exec playwright install chromium   # 首次
tnpm run visual:update                  # 人工审阅后再批准
tnpm run visual:check
```

### 小改文案 / 局部组件（已有 baseline）

```bash
tnpm run check
```

## 浏览器门禁覆盖什么

visual runner 动态读 registry，典型覆盖：

- 页数 × viewport（1280×720、1024×768）× 显式 light/dark
- system 主题偏好（两 viewport）
- 固定 reduced motion
- Hash 与 `intent/layoutId/density/visualMode` metadata
- `window.__PRESENTATION_VALIDATION__.diagnostics`（未豁免 error 失败）
- overflow、安全区、正文/注释字号下限
- 字体与图片加载
- console / page error / 失败请求 / HTTP 错误
- 像素 diff（相对已批 baseline）

证据目录常见于 `artifacts/visual-validation/`；diff 在其下 `diff/`。

## 交付清单

向用户回报：

1. **项目路径**与如何再次打开  
2. **预览**：`cd <dir> && tnpm run dev` → `http://127.0.0.1:5173`  
3. **构建产物**  
   - 站点：`dist/index.html`  
   - 离线单文件：`dist/single-index.html`（默认体积门禁约 5MB，可用环境变量覆盖，见项目 packaging 说明）  
4. **门禁结果**：test/build/visual 哪些跑了、是否通过  
5. **已知缺口**：占位图、待补来源、示例数据、未批 baseline、未替换的 start 页等  

## 可选：用 browser-harness 做烟测

若环境已安装 `browser-harness` 与 `agent-browser`，可对 dev server 做截图 + console + network 证据采集；本技能不强制依赖它。项目自带 `visual:*` 仍是布局/主题/diagnostics 的权威门禁。

## 不要做的验收替代

- 只跑 `tsc` 或只 `build` 成功就宣称完成视觉验收  
- 单一 viewport / 单一主题截一张图代替矩阵  
- 用 `visual:update`「消掉」失败而不看 actual  
- 删除或伪造 `window.__PRESENTATION_VALIDATION__` 以绕过 runner  
