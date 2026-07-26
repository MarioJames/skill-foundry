---
name: browser-harness
description: Use when validating frontend changes in a browser via vercel-labs/agent-browser, preparing dev server / login state per target shape (URL / *.html / project dir), collecting screenshot+console+network evidence, injecting APP_URL into project test commands, or driving interactive exploration.
---

# Browser Harness

## Overview

本技能是前端验收的浏览器脚手架：自动按 target 形态决定要不要起 dev server，准备登录态，采集复合证据。逐步浏览器动作（点、填、等、看）由 agent 直接调 [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser) CLI 完成；本技能不替你写 Playwright 脚本，也不封装项目自己的测试命令（journey 等由项目 testing-suite 承担，本技能只负责把 `APP_URL` 准备好）。

核心原则：在一轮验收里先用 `bh prepare` 取到稳定 `APP_URL`、必要时 `bh login` 准备登录态；然后视场景选择 `bh collect-evidence` 或直接调 `agent-browser` 原始 CLI；结束统一 `bh cleanup`。

> 下文 `bh ...` 均为 `bash "$BH_DIR/bh.sh" ...` 的速记。agent 的每次 shell 调用都是新进程，alias 不会生效，请始终用完整形式。

## When to Use

- A. 一次性烟测 / 线上巡检：开页面 → 一键收齐 screenshot + console + 网络证据
- B. Journey / 项目测试跑测：`bh prepare` 拿 `APP_URL`，注入项目自带的 `tnpm run test:journey`（测试本体由项目 testing-suite 执行）
- C. 交互式探索：连续点 / 填 / 等 / 截，跨页面跳转 —— 直接用 `agent-browser` CLI，本技能负责前置和登录态
- D. 登录态准备：headed 弹窗登一次，落 browser-harness 持久化 profile，后续场景默认自动复用

## **HARD CONSTRAINTS**（**MUST** / **DO NOT**）

- **DO NOT** 在本技能里改业务代码、mock、OneAPI 产物或后端反馈单。
- **MUST** 用 `eval "$(bash "$BH_DIR/bh.sh" prepare ...)"` 读取 prepare 的 stdout 环境变量；**DO NOT** 从日志猜端口或自行拼 `APP_URL`。
- **MUST** 在验收结束时执行 `bh cleanup`（prepare 用了非 `.` 路径时 cleanup 传同一路径）。
- **DO NOT** 把 `artifact_errors` 非空的 fallback 占位文件当有效证据。
- **DO NOT** 在采集阶段一次性 dump 全部 network body；按需查指定 `requestId`。
- **DO NOT** 在本 skill 复制或硬编码技能安装路径；dispatcher 以实际加载的 `SKILL.md` 目录为准。

## Project Setup

依赖 vercel-labs/agent-browser CLI ≥ 0.29 已安装：

```bash
command -v agent-browser >/dev/null || {
  echo "请按 https://github.com/vercel-labs/agent-browser 安装 agent-browser，然后 'agent-browser install' 拉取 Chrome for Testing"
  exit 2
}
```

dispatcher 位于当前实际加载的 browser-harness 技能目录。先将
`BROWSER_HARNESS_SKILL_DIR` 设为实际加载本 `SKILL.md` 的目录（宿主加载技能时提供的
Base directory）；插件缓存目录和独立安装目录都使用同一方式。验收沙箱和既有 HOME
独立安装目录只作为兼容兜底：

```bash
BH_DIR="${BROWSER_HARNESS_SKILL_DIR:+$BROWSER_HARNESS_SKILL_DIR/scripts}"
if [ -z "$BH_DIR" ] && [ -n "${ACCEPTANCE_SANDBOX:-}" ]; then
  BH_DIR="$(find "$ACCEPTANCE_SANDBOX/.iso" -path '*/skills/browser-harness/scripts' -type d 2>/dev/null | head -1)"
fi
for candidate in \
  "$HOME/.codex/skills/browser-harness/scripts" \
  "$HOME/.claude/skills/browser-harness/scripts" \
  "$HOME/.cc-switch/skills/browser-harness/scripts"
do
  if [ -z "$BH_DIR" ] && [ -f "$candidate/bh.sh" ]; then
    BH_DIR="$candidate"
    break
  fi
done

if [ -z "$BH_DIR" ] || [ ! -f "$BH_DIR/bh.sh" ]; then
  echo "无法定位当前加载的 browser-harness scripts 目录" >&2
  exit 1
fi
```

## Standard Flow

### A. 一次性烟测 / 线上巡检

```bash
eval "$(bash "$BH_DIR/bh.sh" prepare https://prod.example.com)"
bash "$BH_DIR/bh.sh" collect-evidence "$APP_URL" --profile prod-monitor
bash "$BH_DIR/bh.sh" cleanup
```

`bh collect-evidence` 把 stdout 输出的 `summary.json` 直接给 agent 当回执，落盘的 `evidence/<ts>/` 目录可按需深读。

### B. Journey 跑测（APP_URL 注入项目 testing-suite）

```bash
eval "$(bash "$BH_DIR/bh.sh" prepare .)"
tnpm run test:journey -- --iteration 33 --task task-7 --app-url "$APP_URL"
bash "$BH_DIR/bh.sh" cleanup
```

journey 的登录态由 testing-suite 自己管理（`--auth open` 保存 storageState、`--auth use` 复用），与 `bh login` 的浏览器 profile 是两套独立机制，互不相通；`bh login` 只服务于 `bh collect-evidence` 和直接调 `agent-browser` 的场景。

### C. 交互式探索

```bash
eval "$(bash "$BH_DIR/bh.sh" prepare .)"
bash "$BH_DIR/bh.sh" login "$APP_URL/login"     # 必要时；默认 profile

# agent 直接驱动 agent-browser；用 profile-dir 复用 bh 持久化的登录态
PROFILE_DIR="$(bash "$BH_DIR/bh.sh" profile-dir)"
agent-browser open "$APP_URL/some/path" --profile "$PROFILE_DIR"
agent-browser snapshot --json
agent-browser click "@e3"
agent-browser fill "@e7" "hello"
agent-browser wait --text "已保存"
agent-browser screenshot --annotate step.png

# 需要正式归档时回到封装命令
bash "$BH_DIR/bh.sh" collect-evidence "$APP_URL/some/path"
bash "$BH_DIR/bh.sh" cleanup
```

### D. 登录态准备

```bash
eval "$(bash "$BH_DIR/bh.sh" prepare https://staging.example.com)"
bash "$BH_DIR/bh.sh" login "$APP_URL/login"     # headed 弹窗，人工登一次
bash "$BH_DIR/bh.sh" cleanup
# 后续任何场景默认自动复用该登录态；多套登录态才用 --profile <name> 区分
```

## C 场景：交互式探索的最小教程

### ref 是什么

`agent-browser snapshot --json` 返回页面无障碍树，每个可交互元素带 `@e1`/`@e2`/... ref。所有 `click` / `fill` / `hover` / `drag` 都用这个 ref 定位，比 CSS selector 稳定得多。

典型循环：

```bash
agent-browser open "$APP_URL/path" --profile "$(bash "$BH_DIR/bh.sh" profile-dir)"
agent-browser snapshot --json | tee /tmp/snap.json   # 看到 ref
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

### --profile 是可选扩展 flag

默认情况下不用传 `--profile`：所有命令（`login` / `collect-evidence`，以及通过 `profile-dir` 拿到路径后直接调的 `agent-browser`）都用 browser-harness 自己的默认 profile，登录态因此默认就持久、跨调用自动复用，调用方不必每次去记/找之前用的路径。

`--profile <name>` 只在你需要**同时维护多套登录态**时才用（例如 `prod-monitor` 与 `staging`、不同租户/账号）。技能把名字解析成私有隐藏目录 `~/.browser-harness/profiles/<name>`（默认是 `default`）再传给 agent-browser，`login` 写入与 `collect-evidence` 读取指向同一目录。

C 场景里 agent 直接调 `agent-browser` 时，用 `--profile "$(bash "$BH_DIR/bh.sh" profile-dir [name])"` 取到该目录路径即可复用同一份登录态，不必记忆技能内部布局。

进阶：`BH_PROFILE_ROOT` 改存储根目录，`BH_DEFAULT_PROFILE` 改默认 profile 名；`--profile` 也可直接传一个路径（含 `/` 或以 `~` 开头）绕过技能目录。

## Runtime Pitfalls

- `bh prepare` 在项目目录场景下 stdout 输出 `APP_URL=...`、`DEV_SERVER_PID=...`、`DEV_SERVER_LOG=...` 三行；**MUST** 用 `eval "$(bh prepare ...)"` 形式读取。其他场景仅输出 `APP_URL=`。
- macOS 下技能用 `launchctl submit` 托管 dev server，避免一次性 shell/exec 退出时回收子进程。如果 journey 报 `ERR_CONNECTION_REFUSED`，先看 `DEV_SERVER_PID` / `DEV_SERVER_LOG`，**DO NOT** 直接判定为页面或测试资产失败。
- `bh prepare` 的 dev 命令优先级：`INSPECS_DEV_COMMAND` > `package.json scripts.dev` > `start` > `serve`；都没有时报错让你显式指定。
- 真实后端联调示例：`INSPECS_DEV_COMMAND="tnpm run devs" INSPECS_APP_HOST=dev.alipay.net bh prepare .`
- `bh login` **MUST** 在能弹 headed 浏览器的环境跑（本机或带显示转发的 SSH）。CI 环境没显示，应直接复用预先建好的 profile。
- `bh cleanup` 的状态文件按项目路径隔离：默认清理当前目录对应的 dev server，若 prepare 时用的不是 `.`，cleanup 需传同一项目路径（`bh cleanup path/to/proj`）。
- `bh collect-evidence` 的 `evidence/<ts>/` 默认落在当前目录；建议把 `evidence/` 加入项目 `.gitignore`，避免证据目录被误提交。
- 本技能适配 agent-browser ≥ 0.29（`--json` 信封输出、`screenshot` 位置参数）；版本偏低时命令会输出 warn，建议 `agent-browser upgrade`。

## Evidence

`bh collect-evidence` 输出 `evidence/<ts>/`（各 JSON 均已从 `--json` 信封解包为裸数组/对象）：

| 文件 | 内容 |
|---|---|
| `screenshot.png` | 带 ref 编号的标注截图（`--annotate`） |
| `dom.json` | snapshot 的 `data` 对象（`origin` / `refs` / `snapshot`） |
| `console.json` | 控制台消息数组（含 error/warn） |
| `network-xhr.json` | 全量 XHR/fetch 请求数组（字段名 `requestId`） |
| `network-errors.json` | 4xx/5xx 请求数组 |
| `network.har` | 仅 `--har` 时生成（har 录制先于 open，覆盖首屏请求） |
| `summary.json` | 各文件相对路径 + 关键计数 + `artifact_errors`（采集失败的项） |

stdout 也输出 `summary.json` 内容供 agent 直接读取。`artifact_errors` 非空说明对应文件是 fallback 占位，**DO NOT** 当有效证据引用。`open` 失败时整个命令以 exit 3 退出且不产出证据目录。需要某条请求 body 时用 `agent-browser network request <requestId>` 单独深挖，**DO NOT** 在采集阶段一次性 dump。

## Tests

技能自带 bash 单元测试（stub 化）+ 一条有条件真机冒烟（PATH 里有 agent-browser 才跑，防 stub 与真实 CLI 契约漂移）：

```bash
bash "$BROWSER_HARNESS_SKILL_DIR/tests/run-all.sh"
```

`bh login` headed 登录、launchctl 防回收、dev server 真实起停这三类仍需真环境人工/评估复测，不在自动化覆盖内。
