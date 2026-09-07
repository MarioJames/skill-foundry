# 交互与证据

`bh` 是 `bun "$BH_DIR/bh.ts"` 的速记。命令在目标项目根运行；profile 选择见 [登录态](login.md)。

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
bun "$BH_DIR/bh.ts" login "$APP_URL/login"     # 必要时；默认使用当前项目 profile

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

### 网络深挖

```bash
# --json 输出统一是 {"success":true,"data":{...}} 信封；请求列表在 data.requests，id 字段名是 requestId
agent-browser network requests --type xhr,fetch --json | jq '.data.requests[].requestId'   # 列出
agent-browser network request <requestId>                              # 看某条 request/response 全文（含 body）
```

**DO NOT** 一次性 dump 全部 body，会爆 token；按需查指定 requestId。

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
