---
name: browser-harness
description: 验收前端页面：准备服务和登录态，通过 agent-browser 交互、采集证据并清理资源。
---

# Browser Harness

为 URL、HTML 文件或项目目录准备验收环境，通过 agent-browser 完成浏览器交互和截图、控制台、网络采证。项目测试由项目自身执行，本技能提供实际 `APP_URL`。

## 默认流程

1. 固定任务根目录与 target；按实际加载的本 `SKILL.md` 所在目录定位 dispatcher。
2. `prepare` 取得 `APP_URL`；需要登录时读 [登录态与 profile](references/login.md)。
3. 按 [交互与证据](references/interaction-evidence.md) 检查关键页面和失败路径；项目测试也使用同一个 `APP_URL`。
4. 验收通过后默认 cleanup 并关闭本次浏览器和验证进程。已有用户远程走查或保留服务要求时才进入 [远程与保留分支](references/remote-review.md)，不额外询问是否走查。
5. 报告实际 `APP_URL`、关键页面结果、console/network 错误、证据目录和清理动作；说明服务、浏览器、验证进程是否释放。保留资源时写明原因、PID 和端口。

```bash
# BROWSER_HARNESS_SKILL_DIR = 实际加载本 SKILL.md 的目录
BH_DIR="$BROWSER_HARNESS_SKILL_DIR/scripts"
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
- 清理边界是本任务创建的精确 PID、target、profile；保留用户既有服务和登录态。核对 PID、父进程与 profile，不用宽泛 `pgrep -f` 杀进程。close 后只从外部查精确 PID/CDP 端口，不再用 snapshot/open 探测，以免重启浏览器。
- 验收失败时，负责开发的 Agent 应回到当前已授权的开发任务修复业务/环境问题，再准备环境并继续浏览器验收，直到通过或遇到真实阻塞。browser-harness 只提供验收工具，不限制同一 Agent 的开发职责；不要修改 mock、诊断或证据来伪造通过。
- 不自动全局安装或升级 Bun、agent-browser、浏览器或项目依赖；缺失时报告准确前置，并依据已有安装授权与项目包管理约定执行。

## 按需分支

- 登录、多账号、profile 复用：[登录态](references/login.md)。
- 点击/填写/截图、网络深挖、证据结构：[交互采证](references/interaction-evidence.md)。
- 用户要求远程走查、保留服务或启动并发布：[远程流程](references/remote-review.md)。创建公网仍须用户授权，已有授权不重复问；加载 cloudflare-quick-tunnel，复用同一 tunnel。启动获得地址立即交付，不把探活作为启动条件。
- 依赖、dispatcher 定位、自定义服务、macOS、清理故障：[平台排障](references/runtime.md)。
