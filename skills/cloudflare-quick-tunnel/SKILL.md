---
name: cloudflare-quick-tunnel
description: Create and manage temporary public URLs for local HTTP services through anonymous Cloudflare Quick Tunnels, including start, status, stop, cleanup, readiness checks, and lifecycle handoff to browser-harness. Use for temporary remote review or exposing a local service; do not use for production, authenticated access, named tunnels, or custom domains.
---

# Cloudflare Quick Tunnel

## Overview

本技能只负责匿名 Cloudflare Quick Tunnel 的完整生命周期：启动并探活公网入口、查询精确状态、停止进程、清理本轮状态与日志。前端开发验收仍由 `browser-harness` 负责；它的 `share` / `publish` / `cleanup` 会调用本技能脚本，不在自身复制 tunnel 实现。

> 下文 `cqt ...` 均为 `bun "$CQT_DIR/cqt.ts" ...` 的速记。每次 shell 调用都重新解析 `CQT_DIR`；不要依赖上一批命令留下的局部变量。

## HARD CONSTRAINTS

- 未经用户确认不得创建公网隧道；用户明确要求“发布、暴露到公网、生成远程走查地址”即视为确认。
- `*.trycloudflare.com` 是无认证随机地址，不是访问控制；不得承载生产或敏感数据。
- 只使用 PATH 中的 `cloudflared` 创建匿名 Quick Tunnel，并传入隔离的空配置；不接受 token、命名隧道、自定义域名、自定义 cloudflared 命令或 Cloudflare 环境变量覆盖。
- 不自动安装或升级 Bun、cloudflared、curl。缺失时报告准确前置。
- 生命周期命令必须复用同一个 `--state-dir`；不要用宽泛 `pgrep` 猜测或清理其他 tunnel。
- 把 `start` 的 stdout 当可 `eval` 环境变量读取；不要从日志猜公网 URL 或 PID。
- 交付公网 URL 前必须以脚本完成的公网探活为准。`start` 失败时不得交付日志中尚未验证的 URL。

## Setup

依赖 Bun ≥ 1.3、`cloudflared` 与 `curl`：

```bash
command -v bun >/dev/null || {
  echo "请先安装 Bun 1.3+：https://bun.sh"
  exit 2
}
command -v cloudflared >/dev/null || {
  echo "请先安装 cloudflared：https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/"
  exit 2
}
command -v curl >/dev/null || {
  echo "请先安装 curl"
  exit 2
}
```

将 `CLOUDFLARE_QUICK_TUNNEL_SKILL_DIR` 设为宿主加载本 `SKILL.md` 时提供的实际技能目录，再解析脚本目录；独立安装位置只作为兼容兜底：

```bash
CQT_DIR="${CLOUDFLARE_QUICK_TUNNEL_SKILL_DIR:+$CLOUDFLARE_QUICK_TUNNEL_SKILL_DIR/scripts}"
if [ -z "$CQT_DIR" ] && [ -n "${ACCEPTANCE_SANDBOX:-}" ]; then
  CQT_DIR="$(find "$ACCEPTANCE_SANDBOX/.iso" -path '*/skills/cloudflare-quick-tunnel/scripts' -type d 2>/dev/null | head -1)"
fi
for candidate in \
  "$HOME/.agents/skills/cloudflare-quick-tunnel/scripts" \
  "$HOME/.codex/skills/cloudflare-quick-tunnel/scripts" \
  "$HOME/.claude/skills/cloudflare-quick-tunnel/scripts" \
  "$HOME/.cc-switch/skills/cloudflare-quick-tunnel/scripts"
do
  if [ -z "$CQT_DIR" ] && [ -f "$candidate/cqt.ts" ]; then
    CQT_DIR="$candidate"
    break
  fi
done

if [ -z "$CQT_DIR" ] || [ ! -f "$CQT_DIR/cqt.ts" ]; then
  echo "无法定位当前加载的 cloudflare-quick-tunnel scripts 目录" >&2
  exit 1
fi
```

## Lifecycle

为每个任务创建专属状态目录，并在整个生命周期复用它。默认状态目录按当前物理工作目录隔离；跨 shell、多个服务并行或由其他技能联动时应显式传绝对 `--state-dir`。

```bash
TASK_STATE_DIR="$(mktemp -d)/quick-tunnel"
eval "$(bun "$CQT_DIR/cqt.ts" start "http://127.0.0.1:4173/preview/" --state-dir "$TASK_STATE_DIR")"
printf '公网地址：%s\nPID：%s\n日志：%s\n' "$PUBLIC_URL" "$TUNNEL_PID" "$TUNNEL_LOG"
```

`start` 会先停止同一状态目录中仍存活的旧 tunnel，再启动新实例；origin 的 path、query、hash 会保留到 `PUBLIC_URL`。stdout 包含：

- `ORIGIN_URL`
- `PUBLIC_URL`
- `TUNNEL_PID`
- `TUNNEL_LOG`
- `TUNNEL_STATE_DIR`

只读检查不创建进程：

```bash
eval "$(bun "$CQT_DIR/cqt.ts" status --state-dir "$TASK_STATE_DIR")"
printf '状态：%s\n' "$TUNNEL_STATUS" # running | stale | stopped
```

走查结束后停止 tunnel。`stop` 幂等并保留本轮日志；需要彻底回收本技能创建的状态与日志时执行 `cleanup`：

```bash
bun "$CQT_DIR/cqt.ts" stop --state-dir "$TASK_STATE_DIR"
bun "$CQT_DIR/cqt.ts" cleanup --state-dir "$TASK_STATE_DIR"
```

`cleanup` 只删除脚本明确拥有的状态文件和日志，再尝试移除空状态目录；不会递归删除调用方放入的其他文件。

## browser-harness 联动

使用 `browser-harness` 做前端验收时，仍调用 `bh share` / `bh publish` / `bh cleanup`。browser-harness 会为项目计算独立状态目录并委托本脚本；不要再额外启动第二条 tunnel。

- `bh share`：复用已由 `bh prepare` 启动的 dev server，然后调用 `cqt start`。
- `bh publish`：启动 dev server，再调用 `cqt start`；tunnel 失败会回收 dev server。
- `bh cleanup`：先调用 `cqt cleanup`，再停止 dev server。

## Runtime Notes

- macOS 使用 `launchctl` 托管 worker，其他平台使用 detached 进程；两者都把精确 PID 写入状态目录。
- Quick Tunnel 命令固定 origin Host，减少 Vite 等 dev server 因公网 Host 拒绝请求的问题。
- `status` 只依据状态目录中的精确 PID；`stale` 表示 PID 状态存在但进程已退出。
- `stop` 先发 `SIGTERM`，超时后仅对该 PID/独立进程组发 `SIGKILL`。

## Tests

```bash
cd "$CLOUDFLARE_QUICK_TUNNEL_SKILL_DIR"
bun test --max-concurrency 1
```

集成测试用 stub `cloudflared` / `curl` 验证固定 Quick Tunnel 参数、URL 保留和 start → status → stop → cleanup 的真实进程与状态回收。
