---
name: browser-harness
description: 验收前端页面：准备服务和登录态，通过 agent-browser 交互、采集证据并清理资源。
---

# Browser Harness

为 URL、HTML 文件或项目目录准备验收环境，通过 agent-browser 完成浏览器交互和截图、控制台、网络采证。项目测试由项目自身执行，本技能提供实际 `APP_URL`。

## 执行者与交接

父 Agent 默认通过当前宿主自带的 subagent 工具委派浏览器验收：Codex 用官方 subagent 并指定 `gpt-6.1-sol` / `medium`，Claude Code 用 Agent 工具新建 subagent 并指定 `sonnet`。不用 agent-dispatch RPC 或 Herdr 启动替代 Agent。派发前读取 [子 Agent 交接与复验](references/delegation.md)，按其中的宿主参数传入完整验收要求与资源归属。已受委派的验收 Agent 直接执行下方流程，不再派发。

父 Agent 负责验收标准、业务修复与最终确认；子 Agent 负责环境准备、浏览器交互、采证和自有资源清理。宿主没有 subagent 工具或指定模型不可用时报告具体阻塞，由父 Agent 承接已授权验收，不静默换模型、换宿主或改用其他执行载体。用户明确要求父 Agent 直接操作时遵从用户。

## 浏览器配置

默认使用 **自带 Chromium + 无头模式**，交互验收和采证共用同一命名 session/profile。遵循 agent-browser 原生配置，不另设浏览器配置层；日常验收不连接 Convorel 的 ChatGPT 浏览器，也不复用其 CDP、session 或 profile。

`login` 为人工登录显式添加 `--headed`，登录后关闭本任务会话，再以无头模式继续验收，持久化 profile 保留。若旧配置仍有 `"headed": true`，本次任务设置 `AGENT_BROWSER_HEADED=false`；浏览器路径必须显式指向已安装的自带 Chromium（工具管理的浏览器缓存），不依赖自动发现、也不回退到系统 Chrome。配置优先级、已有配置迁移和模式切换见 [平台与运行时](references/runtime.md#浏览器与窗口模式)。

## 默认流程

1. 固定任务根目录与 target；按实际加载的本 `SKILL.md` 所在目录定位 dispatcher。
2. 未准备环境时运行 `prepare` 取得 `APP_URL`；已交接成功 prepare 结果或既有服务 URL 时核实并复用，不重复 prepare。需要登录时读 [登录态与 profile](references/login.md)。
3. 按 [交互与证据](references/interaction-evidence.md) 检查关键页面和失败路径；项目测试也使用同一个 `APP_URL`。
4. 验收通过后默认 cleanup 本任务拥有清理权的服务，并关闭本次浏览器和验证进程；借用服务不执行其 target 的 cleanup。已有用户远程走查或保留服务要求时才进入 [远程与保留分支](references/remote-review.md)，不额外询问是否走查。
5. 报告实际 `APP_URL`、关键页面结果、console/network 错误、证据目录和清理动作；说明服务、浏览器、验证进程是否释放。保留资源时写明原因、PID 和端口。

以下命令展示尚未准备环境、且已确认 target 没有其他所有者服务的项目分支；已有服务按交接复用，URL target 无本地服务需要 cleanup。

```bash
# BROWSER_HARNESS_SKILL_DIR = 实际加载本 SKILL.md 的目录
BH_DIR="$BROWSER_HARNESS_SKILL_DIR/scripts"
export AGENT_BROWSER_SESSION="<task-session>"
export BH_DEFAULT_PROFILE="$AGENT_BROWSER_SESSION"
export AGENT_BROWSER_HEADED=false
# 先核实工具管理的 Chromium 实际路径；不填系统 Chrome 或 Convorel 浏览器路径
export AGENT_BROWSER_EXECUTABLE_PATH="<已核实的自带 Chromium 可执行文件绝对路径>"
export AGENT_BROWSER_PROFILE="$(bun "$BH_DIR/bh.ts" profile-dir "$BH_DEFAULT_PROFILE")"
# TARGET = 用户目标 URL、HTML 绝对路径或项目绝对路径
# 在任务/项目根运行；失败时停止依赖动作，并清理本任务已创建的资源
if BH_PREPARE_ENV="$(bun "$BH_DIR/bh.ts" prepare "$TARGET")"; then
  eval "$BH_PREPARE_ENV"
else
  BH_PREPARE_STATUS=$?
  bun "$BH_DIR/bh.ts" cleanup "$TARGET"
  exit "$BH_PREPARE_STATUS"  # 仅结束当前命令批次；Agent 按失败原因修复后重试
fi
bun "$BH_DIR/bh.ts" collect-evidence "$APP_URL"
bun "$BH_DIR/bh.ts" cleanup "$TARGET"
agent-browser close
```

每次 shell 调用的变量不会自动延续，cwd 也可能变化；在同一批解析并消费结果，或显式重载任务私有环境文件。目录定位、跨批次、自定义启动和 macOS 故障读 [平台与运行时](references/runtime.md)。下文及引用中的 `bh` 均指 `bun "$BH_DIR/bh.ts"`。

## 必要约束

- 先用赋值命令检查 prepare 的退出码，仅成功后 eval 其 stdout；失败即清理本任务资源，不消费残留 APP_URL、不继续采证。不要将命令替换直接嵌入 eval，它会掩盖 prepare 失败。项目 target 同时输出 `DEV_SERVER_PID` / `DEV_SERVER_LOG`；不得从日志猜端口或自行拼 URL。
- 项目 journey/testing-suite 通过其现有参数或环境变量消费 `APP_URL`，例如 `bun run test:journey -- --app-url "$APP_URL"`；不在本技能重新实现测试。
- `collect-evidence` 默认重新打开 URL。交互后要保留瞬时状态，须在同一 profile 已打开目标页时使用 `--reuse-page`，此时 URL 只作元数据。
- `artifact_errors` 非空的文件是 fallback 占位，不能作为有效证据判通过；`open` 失败退出 3 且无证据目录。从 stdout 的 `evidence_dir` 取精确目录，不猜“最新”目录。请求 body 按 `requestId` 单条读取。
- `cleanup` 使用与 prepare/share/publish 相同的 target；HTML target 归一到所在目录。它回收 tunnel 和 dev server，浏览器须另行关闭。
- 项目 `prepare` 会停止该 target 状态文件中已有的存活服务，`cleanup` 也按 target 清理，不按 Agent 隔离。执行前核实所有权和保留要求；借用服务只使用交接 URL，不对其项目 target 执行 prepare/cleanup。需要重建自有服务时，先确认旧执行者已停且无人依赖，再操作。
- 整个交互与采证流程使用同一命名 session 和 profile。跨命令保留 `AGENT_BROWSER_SESSION` / `AGENT_BROWSER_PROFILE` 或逐次传参；遗漏 profile 可能使 agent-browser 重启到空白页。不要操作共享默认 session。
- 清理边界是本任务创建的精确 PID、target、profile；保留用户既有服务和登录态。核对 PID、父进程与 profile，不用宽泛 `pgrep -f` 杀进程。close 后只从外部查精确 PID/CDP 端口，不再用 snapshot/open 探测，以免重启浏览器。
- 验收失败时，子 Agent 返回复现步骤、原始证据及资源状态；负责开发的父 Agent 修复业务/环境问题，再按交接规则续接复验，直到通过或遇到真实阻塞。子 Agent 不擅自修改业务代码、测试预期或 mock；父 Agent 直接执行时仍负责修复与复验。不要修改诊断或证据来伪造通过。
- 不自动全局安装或升级 Bun、agent-browser、浏览器或项目依赖；缺失时报告准确前置，并依据已有安装授权与项目包管理约定执行。

## 按需分支

- 登录、多账号、profile 复用：[登录态](references/login.md)。
- 点击/填写/截图、网络深挖、证据结构：[交互采证](references/interaction-evidence.md)。
- 用户要求远程走查、保留服务或启动并发布：[远程流程](references/remote-review.md)。创建公网仍须用户授权，已有授权不重复问；加载 public-acceptance，复用同一 tunnel。启动获得地址立即交付，不把探活作为启动条件。
- 依赖、dispatcher 定位、自定义服务、macOS、清理故障：[平台排障](references/runtime.md)。
