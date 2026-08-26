---
name: browser-harness
description: Use when validating frontend changes in a browser via vercel-labs/agent-browser, preparing dev server / login state per target shape (URL / *.html / project dir), collecting screenshot+console+network evidence, injecting APP_URL into project test commands, driving interactive exploration, or coordinating temporary remote review with the companion cloudflare-quick-tunnel skill.
---

# Browser Harness

## Overview

本技能是前端验收的浏览器脚手架：自动按 target 形态决定要不要起 dev server，准备登录态，采集复合证据。逐步浏览器动作（点、填、等、看）由 agent 直接调 [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser) CLI 完成；本技能不替你写 Playwright 脚本，也不封装项目自己的测试命令（journey 等由项目 testing-suite 承担，本技能只负责把 `APP_URL` 准备好）。Cloudflare Quick Tunnel 的标准进程、根地址生成、状态与清理由独立的 `cloudflare-quick-tunnel` 技能拥有；项目专用环境、Host 适配、URL 映射和兼容输出全部由本技能负责。

核心原则：在一轮验收里先用 `bh prepare` 取到稳定 `APP_URL`、必要时 `bh login` 准备登录态；然后视场景选择 `bh collect-evidence` 或直接调 `agent-browser` 原始 CLI。页面需求自测通过后先询问是否需要远程走查：不需要则 `bh cleanup`，需要则用 `bh share` 暴露当前服务并在走查结束后 cleanup。用户直接要求“启动并发布到公网”时，用 `bh publish` 一次完成启动与发布。

> 下文 `bh ...` 均为 `bun "$BH_DIR/bh.ts" ...` 的速记。agent 的每次 shell 调用都是新进程，alias、局部变量和 `export` 都不会自动延续，但宿主可能保留上一次 `cd` 的 cwd；每批先回到记录的任务/项目根目录或使用绝对 target，再解析 `BH_DIR`，并把 `prepare` 与依赖其输出的动作放在同一批次或显式重载所需值。

## 适用流程

- A. 一次性烟测 / 线上巡检：开页面 → 一键收齐 screenshot + console + 网络证据
- B. Journey / 项目测试跑测：`bh prepare` 拿 `APP_URL`，注入项目自带的 `bun run test:journey`（测试本体由项目 testing-suite 执行）
- C. 交互式探索：连续点 / 填 / 等 / 截，跨页面跳转 —— 直接用 `agent-browser` CLI，本技能负责前置和登录态
- D. 登录态准备：headed 弹窗登一次，落 browser-harness 持久化 profile，后续场景默认自动复用
- E. 页面需求开发完成：自测验收通过 → 询问是否启动远程走查 → 按回答 share 或 cleanup
- F. 直接公网发布：用户要求“启动 xx 项目并发布/暴露到公网” → `bh publish` → 返回临时访问域名

## **HARD CONSTRAINTS**（**MUST** / **DO NOT**）

- **DO NOT** 在本技能里改业务代码、mock、OneAPI 产物或后端反馈单。
- **DO NOT** 自动全局安装或升级 Bun、agent-browser、浏览器或项目依赖。依赖缺失时报告准确的安装前置；只有用户明确授权安装时才执行，并遵守当前项目的包管理器约定。
- **MUST** 用 `eval "$(bun "$BH_DIR/bh.ts" prepare ...)"` 读取 prepare 的 stdout 环境变量；**DO NOT** 从日志猜端口或自行拼 `APP_URL`。
- **MUST** 在页面需求自测通过后、cleanup 之前询问用户是否需要启动远程走查；等待回答期间只保留本任务的 dev server，并明确报告本地 URL / PID / 端口和保留原因。
- 用户不需要远程走查时，**MUST** 立即执行 `bh cleanup`；用户需要或已明确要求发布到公网时，保留 dev server + Cloudflare tunnel，直到用户确认走查结束后再 cleanup。
- **MUST** 让 `cleanup` 使用与 `prepare` / `share` / `publish` 相同的 target；HTML 文件会由 CLI 归一到所在目录。
- **DO NOT** 未经用户确认主动创建公网隧道；“启动并发布/暴露到公网”本身视为明确确认。
- 进入公网分支时 **MUST** 使用 `cloudflare-quick-tunnel` 伴生技能；`bh share` / `publish` / `cleanup` 已委托它管理同一条 tunnel，**DO NOT** 再手动创建第二条 tunnel。
- **DO NOT** 把 `*.trycloudflare.com` 的随机性当访问控制；Quick Tunnel 是无认证的临时公网入口，不得用于生产或敏感数据。
- **DO NOT** 把 `artifact_errors` 非空的 fallback 占位文件当有效证据。
- **DO NOT** 在采集阶段一次性 dump 全部 network body；按需查指定 `requestId`。
- **DO NOT** 在本 skill 复制或硬编码技能安装路径；dispatcher 以实际加载的 `SKILL.md` 目录为准。

## Project Setup

依赖 Bun ≥ 1.3 与 vercel-labs/agent-browser CLI ≥ 0.29。`share` / `publish` 还需要安装 `cloudflare-quick-tunnel` 伴生技能；其脚本负责检查 `cloudflared`，非公网流程不得因这些公网依赖缺失而失败：

```bash
command -v bun >/dev/null || {
  echo "请先安装 Bun 1.3+：https://bun.sh"
  exit 2
}
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
  "$HOME/.agents/skills/browser-harness/scripts" \
  "$HOME/.codex/skills/browser-harness/scripts" \
  "$HOME/.claude/skills/browser-harness/scripts" \
  "$HOME/.cc-switch/skills/browser-harness/scripts"
do
  if [ -z "$BH_DIR" ] && [ -f "$candidate/bh.ts" ]; then
    BH_DIR="$candidate"
    break
  fi
done

if [ -z "$BH_DIR" ] || [ ! -f "$BH_DIR/bh.ts" ]; then
  echo "无法定位当前加载的 browser-harness scripts 目录" >&2
  exit 1
fi
```

`bh share` / `publish` 默认从 browser-harness 的同级技能根查找 `cloudflare-quick-tunnel/scripts/cqt.ts`，也兼容上面的 HOME 安装根。只有两个技能不在同一技能根时，才把 `CLOUDFLARE_QUICK_TUNNEL_SKILL_DIR` 设为实际加载的伴生技能目录；不要指向复制出来的单个脚本。

## Standard Flow

### A. 一次性烟测 / 线上巡检

```bash
eval "$(bun "$BH_DIR/bh.ts" prepare https://prod.example.com)"
bun "$BH_DIR/bh.ts" collect-evidence "$APP_URL" --profile prod-monitor
bun "$BH_DIR/bh.ts" cleanup
```

`bh collect-evidence` 把 stdout 输出的 `summary.json` 直接给 agent 当回执，落盘的 `<项目根>/.browser-harness/evidence/<ts>/` 目录可按需深读。CLI 会幂等地把 `/.browser-harness/` 写入项目 `.gitignore`，避免证据被误提交。需要后续读取时，捕获 stdout 并从 JSON 的 `evidence_dir` 字段取得精确目录；不要用目录通配符猜“最新目录”，并发采集、zsh glob 和目录尾斜杠都可能让它选错或无匹配退出。

### B. Journey 跑测（APP_URL 注入项目 testing-suite）

```bash
eval "$(bun "$BH_DIR/bh.ts" prepare .)"
bun run test:journey -- --iteration 33 --task task-7 --app-url "$APP_URL"
bun "$BH_DIR/bh.ts" cleanup
```

journey 的登录态由 testing-suite 自己管理（`--auth open` 保存 storageState、`--auth use` 复用），与 `bh login` 的浏览器 profile 是两套独立机制，互不相通；`bh login` 只服务于 `bh collect-evidence` 和直接调 `agent-browser` 的场景。

### C. 交互式探索

```bash
eval "$(bun "$BH_DIR/bh.ts" prepare .)"
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
bun "$BH_DIR/bh.ts" cleanup
```

`collect-evidence` 默认会先执行一次 `agent-browser open`，适合一次性烟测；这会重新导航并可能把纯前端瞬时状态从 `Saved` 重置为 `Ready`。只有在同一 profile 已经打开目标页且交互完成后，才使用 `--reuse-page` 采集当前页面；此时 `<url>` 用作证据元数据，命令不会再次导航。不要对默认重载后的 DOM 断言交互前的瞬时状态。

### D. 登录态准备

```bash
eval "$(bun "$BH_DIR/bh.ts" prepare https://staging.example.com)"
bun "$BH_DIR/bh.ts" login "$APP_URL/login"     # headed 弹窗，人工登一次；按项目持久化
bun "$BH_DIR/bh.ts" cleanup
# 后续任何场景默认自动复用该登录态；多套登录态才用 --profile <name> 区分
```

### E. 页面需求自测后的远程走查分支

自测验收通过后先向用户询问：`自测已通过，是否需要启动临时公网地址进行远程走查？`

等待回答期间不要 cleanup；保留本轮 `prepare` 启动的 dev server，并报告保留原因、`APP_URL`、`DEV_SERVER_PID` 和端口。收到回答后：

```bash
# 用户不需要
bun "$BH_DIR/bh.ts" cleanup "$TARGET"

# 用户需要：复用 prepare 的服务，不重启 dev server
eval "$(bun "$BH_DIR/bh.ts" share "$TARGET")"
printf '远程走查地址：%s\n' "$REMOTE_REVIEW_URL"
```

`share` 从项目状态读取当前 `APP_URL`：本技能提取 origin、设置项目需要的 `TUNNEL_HTTP_HOST_HEADER`，再委托 `cloudflare-quick-tunnel start` 创建标准 tunnel；随后由本技能把 `APP_URL` 的 path/query/hash 拼接到伴生技能返回的根地址，并映射为兼容的 `APP_URL`、`REMOTE_REVIEW_URL`、`CLOUDFLARED_PID`、`CLOUDFLARED_LOG` 安全赋值。拿到地址后立即向用户交付，不做公网 URL 探活；同时说明这是临时无认证入口，并报告 dev server / tunnel 的 PID、日志和保留原因。用户确认走查结束后执行：

```bash
bun "$BH_DIR/bh.ts" cleanup "$TARGET"
```

### F. 直接启动并发布到公网

用户已明确要求“启动 xx 项目并发布/暴露到公网”时无需再次确认：

```bash
TARGET=/absolute/path/to/project
eval "$(bun "$BH_DIR/bh.ts" publish "$TARGET")"
printf '远程走查地址：%s\n' "$REMOTE_REVIEW_URL"
```

`publish` 一次完成 dev server 启动，并委托 `cloudflare-quick-tunnel` 完成 tunnel 创建；stdout 额外包含 `DEV_SERVER_PID` / `DEV_SERVER_LOG`。伴生技能在生成地址前失败时会回收 dev server。公网地址生成后立即交付，不做 HTTP、TLS 或页面探活。用户结束走查后仍用相同 target cleanup。

`publish` 沿用 `prepare` 的端口发现协议：dev stdout/stderr 必须打印 `http://localhost:<port>` 或 `http://127.0.0.1:<port>`。自建极简 server 或自定义 `BH_DEV_COMMAND` 时显式打印实际监听 URL；不要从进程列表猜端口。

### 与 cloudflare-quick-tunnel 的边界

本技能保留 `share` / `publish` 作为前端流程入口，但不再复制标准 `cloudflared` 生命周期实现。匿名 [TryCloudflare Quick Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/) 的固定参数、隔离配置、根地址生成、精确 PID、macOS launchd 托管和 stop/cleanup 均以 `cloudflare-quick-tunnel` 技能为事实源；以下非标准或项目相关内容只存在于 browser-harness：

- 从 `APP_URL` 计算 tunnel origin 与 `TUNNEL_HTTP_HOST_HEADER`。
- 把 path/query/hash 拼接为最终 `REMOTE_REVIEW_URL`。
- 管理 `BH_*` / `BASE_PATH` 等项目环境契约、技能定位兼容和旧输出变量映射。

## C 场景：交互式探索的最小教程

### ref 是什么

`agent-browser snapshot --json` 返回页面无障碍树，每个可交互元素带 `@e1`/`@e2`/... ref。所有 `click` / `fill` / `hover` / `drag` 都用这个 ref 定位，比 CSS selector 稳定得多。

典型循环：

```bash
agent-browser open "$APP_URL/path" --profile "$(bun "$BH_DIR/bh.ts" profile-dir)"
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

默认情况下不用传 `--profile`：`login` / `collect-evidence` 和无参 `profile-dir` 会从当前工作目录向上查找最近的 `.git` 或 `package.json` 作为项目根，并生成项目 profile。命名规则统一为 `<项目根父目录>-<项目根目录>`，转小写并把连续空格、标点归一成 `-`；例如在 `/workspaces/lobe/admin` 或其子目录运行时，默认 profile 为 `lobe-admin`，目录为 `~/.browser-harness/profiles/lobe-admin`。找不到项目标记时以当前工作目录作为项目根。

因此同一项目的子目录会自动复用同一份登录态。若命令的当前目录与被验收项目不同，先在项目目录执行，或显式传 `--profile`，不要依赖另一仓库的上下文 profile。

`--profile <name>` 只在你需要覆盖项目默认值或**同时维护多套登录态**时使用（例如 `prod-monitor` 与 `staging`、不同租户/账号）。技能把名字解析成私有隐藏目录 `~/.browser-harness/profiles/<name>` 再传给 agent-browser，`login` 写入与 `collect-evidence` 读取指向同一目录。

C 场景里 agent 直接调 `agent-browser` 时，用 `--profile "$(bun "$BH_DIR/bh.ts" profile-dir [name])"` 取到该目录路径即可复用同一份登录态，不必记忆技能内部布局。

覆盖优先级为：显式 `--profile` / `profile-dir <name>` > `BH_DEFAULT_PROFILE` > 当前项目自动命名。`BH_PROFILE_ROOT` 可改存储根目录；`--profile` 也可直接传一个路径（含 `/` 或以 `~` 开头）绕过技能目录。

## Runtime Pitfalls

- shell 工具调用之间不共享 `BH_DIR`、`APP_URL` 或其他变量。不要把它们写到固定 `/tmp/<name>` 再假定后续存在；在同一批命令内完成解析与消费，或使用当前任务专属临时目录并在下一批显式重载。
- 若 `prepare` 结果必须跨批次，原样保存其 stdout 赋值行：`umask 077; bun "$BH_DIR/bh.ts" prepare "$TARGET" > "$TASK_TMP/prepare.env"`，下一批用 `. "$TASK_TMP/prepare.env"` 重载后再消费，并在 cleanup 后删除。不要剥掉 `APP_URL=` / `DEV_SERVER_PID=` / `DEV_SERVER_LOG=` 后只写裸值，否则 `source` 会把 URL、PID 或日志路径当作命令。
- shell 宿主可能沿用前一批的 cwd；不要假定相对 target 仍从最初任务目录解析。每批显式 `cd "$TASK_ROOT"`，或把 target 固定为已验证的绝对路径。
- 不要假设交互式 shell 中的 `ls` 是 GNU coreutils；它可能被 alias 成 `eza`，而 `--time-style` 等 GNU 选项会变成无效参数。资源存在性与清理验证优先用精确路径的 `test`、`find` 或平台可用的 `stat`，不要为了报告旧日志时间额外运行不兼容的列表探针。
- `bh prepare` 在项目目录场景下 stdout 输出 `APP_URL=...`、`DEV_SERVER_PID=...`、`DEV_SERVER_LOG=...` 三行；**MUST** 用 `eval "$(bh prepare ...)"` 形式读取。其他场景仅输出 `APP_URL=`。项目 APP_URL 同时持久化给后续 `share`，cleanup 会删除该状态。
- macOS 下技能用 `launchctl submit` 托管 Bun dev worker，避免一次性 shell/exec 退出时回收子进程。如果 journey 报 `ERR_CONNECTION_REFUSED`，先看 `DEV_SERVER_PID` / `DEV_SERVER_LOG`，**DO NOT** 直接判定为页面或测试资产失败。
- macOS `launchctl` worker 的 `PATH` 可能比当前 shell 精简；技能对自动识别的 `dev` / `start` / `serve` 已使用当前 Bun 的绝对路径。自定义 `BH_DEV_COMMAND` 若调用其他 CLI，仍需传绝对可执行文件，例如 `BH_DEV_COMMAND="$(command -v bun) run server.ts" bh prepare .`。不要为此自动安装依赖或修改全局 `PATH`。
- `bh prepare` 的 dev 命令优先级：`BH_DEV_COMMAND` > `package.json scripts.dev` > `start` > `serve`；项目脚本统一通过 `bun run` 启动，都没有时报错让你显式指定。
- 自定义联调示例：`BH_DEV_COMMAND="bun run dev:api" BH_APP_HOST=api.example.test bh prepare .`
- `BH_DEV_COMMAND`、`BH_APP_HOST`、`BH_CURL_NO_PROXY` 是 browser-harness 自己的环境契约。单次调用优先使用上面的命令前缀；若先分行赋值，必须 `export BH_DEV_COMMAND=...` 后再运行 `bh prepare`。仅写 `BH_DEV_COMMAND=...` 再执行下一条命令不会进入子进程，技能会回退到 `package.json` 脚本。
- `bh login` **MUST** 在能弹 headed 浏览器的环境跑（本机或带显示转发的 SSH）。CI 环境没显示，应直接复用预先建好的 profile。
- `bh share` 只复用仍存活的 `bh prepare` 项目；没有持久化 APP_URL 或 dev PID 已退出时拒绝发布，不从日志猜端口。
- browser-harness 通过 `TUNNEL_HTTP_HOST_HEADER` 把 origin Host 固定为本地 `APP_URL` 的 host，减少 Vite 等 dev server 因公网 Host 拒绝请求的情况；并由自身把 `APP_URL` 的 path/query/hash 映射到 `REMOTE_REVIEW_URL`。
- `bh cleanup` 按项目路径为伴生技能计算独立 state-dir：先委托它 cleanup 公网 tunnel，再停止 dev server；若 prepare/share/publish 时用的不是 `.`，cleanup 需传同一 target。HTML 文件 target 会归一到所在目录，未启动相关进程时是可重复的 no-op。
- 资源复核以 prepare 返回并持久化的精确 `DEV_SERVER_PID`、项目状态文件和本次 profile 为边界。不要用宽泛的 `pgrep -f 'headless|agent-browser'` 判定残留：`pgrep -f` 会匹配探针自身的 argv，产生假阳性并诱发误杀用户浏览器；必须核对精确 PID、父进程和本次 profile 路径，且只回收本任务创建的进程。
- 执行 `agent-browser close` 后，不要再用 `agent-browser snapshot`、`open` 或其他浏览器命令探测“是否已关闭”：这些命令可能惰性启动新会话，反而制造资源残留。关闭后的只读确认应检查本轮已记录的精确浏览器/CDP PID 或端口是否消失；若误触发了浏览器命令，必须再次关闭本轮会话并重新做外部精确检查。
- `bh collect-evidence` 默认把证据写入最近项目根的 `.browser-harness/evidence/<ts>/`，并幂等地把 `/.browser-harness/` 加入该项目的 `.gitignore`；不要把证据移回可见且未忽略的项目目录。
- 本技能适配 agent-browser ≥ 0.29（`--json` 信封输出、`screenshot` 位置参数）；版本偏低时命令会输出 warn，建议 `agent-browser upgrade`。

## Evidence

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

stdout 也输出 `summary.json` 内容供 agent 直接读取。把 stdout 保存为变量或任务私有文件，并解析其中的绝对 `evidence_dir`；不要扫描通配符来反推本次目录。`artifact_errors` 非空说明对应文件是 fallback 占位，**DO NOT** 当有效证据引用。`open` 失败时整个命令以 exit 3 退出且不产出证据目录。需要某条请求 body 时用 `agent-browser network request <requestId>` 单独深挖，**DO NOT** 在采集阶段一次性 dump。
