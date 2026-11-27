# 交互与证据

`bh` 是 `bun "$BH_DIR/bh.ts"` 的速记。命令在目标项目根运行；profile 选择见 [登录态](login.md)。每批命令恢复同一任务的浏览器身份：

```bash
export AGENT_BROWSER_SESSION="<task-session>"
export AGENT_BROWSER_HEADED=false
export AGENT_BROWSER_EXECUTABLE_PATH="<已核实的自带 Chromium 可执行文件绝对路径>"
export AGENT_BROWSER_PROFILE="$(bun "$BH_DIR/bh.ts" profile-dir)"
```

在本机 agent-browser 0.34 的实际验收中，open 带 profile、下一条 snapshot 不带时会切换到空白页。通过上述环境变量或每条命令传入同一 `--profile` 避免重启；采证后读回 DOM 的真实 origin 与交互结果，不能只看 summary 中的目标 URL。

## 目录

- [一次性烟测](#一次性烟测)
- [交互后采证](#交互后采证)
- [元素与请求定位](#元素与请求定位)
- [证据文件](#证据文件)

## 一次性烟测

```bash
if BH_PREPARE_ENV="$(bun "$BH_DIR/bh.ts" prepare "$TARGET")"; then
  eval "$BH_PREPARE_ENV"
else
  BH_PREPARE_STATUS=$?
  bun "$BH_DIR/bh.ts" cleanup "$TARGET"
  exit "$BH_PREPARE_STATUS"  # 仅结束当前命令批次；Agent 按失败原因修复后重试
fi
bun "$BH_DIR/bh.ts" collect-evidence "$APP_URL"
```

采证完成后按 [入口流程](../SKILL.md) 清理本次资源；已有保留要求时执行对应分支。

## 交互后采证

```bash
if BH_PREPARE_ENV="$(bun "$BH_DIR/bh.ts" prepare "$TARGET")"; then
  eval "$BH_PREPARE_ENV"
else
  BH_PREPARE_STATUS=$?
  bun "$BH_DIR/bh.ts" cleanup "$TARGET"
  exit "$BH_PREPARE_STATUS"  # 仅结束当前命令批次；Agent 按失败原因修复后重试
fi
# 仅在需要人工登录时执行以下两行，等待登录完成后再 close：
bun "$BH_DIR/bh.ts" login "$APP_URL/login"
agent-browser close  # 保留 profile；下面重新打开即恢复无头模式

# agent 直接驱动 agent-browser；用 profile-dir 复用 bh 持久化的登录态
PROFILE_DIR="$(bun "$BH_DIR/bh.ts" profile-dir)"
agent-browser open "$APP_URL/some/path" --profile "$PROFILE_DIR"
agent-browser snapshot --json
agent-browser click "@e3"
agent-browser fill "@e7" "hello"
agent-browser wait --text "已保存"
agent-browser screenshot --annotate step.png

# 交互后的正式归档复用当前页面，避免重新导航丢失瞬时状态
bun "$BH_DIR/bh.ts" collect-evidence "$APP_URL/some/path" --reuse-page
bun "$BH_DIR/bh.ts" cleanup "$TARGET"
agent-browser close
```

`collect-evidence` 默认会先执行一次 `agent-browser open`，适合一次性烟测；这会重新导航并可能把纯前端瞬时状态从 `Saved` 重置为 `Ready`。只有在同一 profile 已经打开目标页且交互完成后，才使用 `--reuse-page` 采集当前页面；此时 `<url>` 用作证据元数据，命令不会再次导航。不要对默认重载后的 DOM 断言交互前的瞬时状态。

## 元素与请求定位

`agent-browser snapshot --json` 返回页面无障碍树，每个可交互元素带 `@e1`/`@e2`/... ref。所有 `click` / `fill` / `hover` / `drag` 都用这个 ref 定位，比 CSS selector 稳定得多。

典型循环：

```bash
agent-browser open "$APP_URL/path" --profile "$(bun "$BH_DIR/bh.ts" profile-dir)"
agent-browser snapshot --json                       # 读取 ref
agent-browser click "@e3"                            # 触发跳转
agent-browser wait --text "目标文案"                 # 等页面稳定
agent-browser screenshot --annotate step.png
```

### 内滚边界与原生滚轮落点

验收滚动衔接时，不能仅设置 `scrollTop` 后宣称滚轮／触摸可用。先确认指针位于目标内滚区、内层已在边界，发送原生输入，再核对外层滚动变化与事件实际目标。

本机 `agent-browser 0.34.0` 实测：`mouse move` 后执行 `mouse wheel`（含 batch）仍把可信 wheel 发到 `(0,0)`，可能完全没滚，或滚了别的区域。先记录事件 `clientX/clientY` 与目标，确认命中这一版本问题时，用**同一命名 session** 的原生 stream 显式指定坐标，不换 CDP／profile：

1. `agent-browser stream status --json` 取得 `data.port`；只连接它返回的本任务本机端口。
2. 用 Bun WebSocket 向 `ws://127.0.0.1:<port>` 发送：

   ```json
   {"type":"input_mouse","eventType":"mouseWheel","x":200,"y":500,"deltaX":0,"deltaY":50}
   ```

3. 留证：发送前 `elementFromPoint(x,y)` 属于目标滚动区、内层 `scrollTop` 等于最大值；事件 `isTrusted=true` 且目标仍属于该区；发送后外层 `scrollTop` 确实变化。坐标取当前布局中的实际落点，不照抄示例。发送完关闭这个临时 WebSocket，不影响原浏览器 session。

2026-11-17 已在 390px 真实页面验证：可信事件命中树内 BUTTON，内层处于末端，外层 main 从 0 滚到 50。大滚动量可能让事件处理时的 hit-test 已落到下方内容，复验用小增量并同时记录前后几何。该记录只适用于已复现的 0.34.0 行为，其他版本先测，不默认回退。

### 网络深挖

```bash
# --json 输出统一是 {"success":true,"data":{...}} 信封；请求列表在 data.requests，id 字段名是 requestId
agent-browser network requests --type xhr,fetch --json | jq '.data.requests[].requestId'   # 列出
agent-browser network request <requestId>                              # 看某条 request/response 全文（含 body）
```

请求“列表”也可能包含 `postData`、请求头和响应正文；完成登录后，不能把它当作安全元数据直接输出。先在进程内投影允许字段（如 `requestId`、`method`、去除敏感查询参数的 URL、`status`、`resourceType`），再输出或持久化；登录/认证请求的 body、Cookie、Authorization 和 token 不进入工具结果、截图说明或交付证据。`network-xhr.json`、`network-errors.json` 和 HAR 也按此边界检查与脱敏，不能先 `cat` 原文再清理。

**DO NOT** 一次性 dump 全部 body；按需查指定 requestId，先确认不是登录、认证或其他含秘密的请求。意外输出凭据后立即停止使用该引用并报告需在源系统轮换；删除本地证据不能撤回历史工具输出。

## 证据文件

`bh collect-evidence` 输出 `<项目根>/.browser-harness/evidence/<ts>/`（各 JSON 均已从 `--json` 信封解包为裸数组/对象）。默认先打开 URL；交互后采证应显式加 `--reuse-page`：

| 文件 | 内容 |
|---|---|
| `screenshot.png` | 带 ref 编号的标注截图（`--annotate`） |
| `dom.json` | snapshot 的 `data` 对象（`origin` / `refs` / `snapshot`） |
| `console.json` | 控制台消息数组（含 error/warn） |
| `network-xhr.json` | 全量 XHR/fetch 请求数组（字段名 `requestId`） |
| `network-errors.json` | 4xx/5xx 请求数组 |
| `network.har` | 仅 `--har` 时生成（har 录制先于 open，覆盖首屏请求） |
| `summary.json` | 各文件相对路径 + 关键计数 + `artifact_errors`（采集失败的项） |

CLI 会幂等地将 `/.browser-harness/` 加入项目 `.gitignore`，不要把证据移到未忽略的可见目录。

stdout 也输出 `summary.json` 内容供 agent 直接读取。把 stdout 保存为变量或任务私有文件，并解析其中的绝对 `evidence_dir`；不要扫描通配符来反推本次目录。`artifact_errors` 非空说明对应文件是 fallback 占位，**DO NOT** 当有效证据引用。`open` 失败时整个命令以 exit 3 退出且不产出证据目录。需要某条请求 body 时用 `agent-browser network request <requestId>` 单独深挖，**DO NOT** 在采集阶段一次性 dump。
