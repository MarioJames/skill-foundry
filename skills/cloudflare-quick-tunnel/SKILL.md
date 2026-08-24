---
name: cloudflare-quick-tunnel
description: Create and manage temporary public URLs for local HTTP services through the standard anonymous Cloudflare Quick Tunnel lifecycle, including start, readiness checks, status, stop, and cleanup. Use for temporary exposure of a local service; do not use for project-specific URL mapping, production, authenticated access, named tunnels, or custom domains.
---

# Cloudflare Quick Tunnel

## Overview

本技能只负责标准匿名 Cloudflare Quick Tunnel 的完整生命周期：启动并探活公网入口、查询精确状态、停止进程、清理本轮状态与日志。它不解释项目环境变量，不拼接业务 path/query/hash，也不添加项目专用的 cloudflared 参数；这些内容由调用方负责。

> 下文 `cqt ...` 均为 `bun "$CQT_DIR/cqt.ts" ...` 的速记。每次 shell 调用都重新解析 `CQT_DIR`；不要依赖上一批命令留下的局部变量。

## HARD CONSTRAINTS

- 未经用户确认不得创建公网隧道；用户明确要求“发布、暴露到公网、生成远程走查地址”即视为确认。
- `*.trycloudflare.com` 是无认证随机地址，不是访问控制；不得承载生产或敏感数据。
- 只使用 PATH 中的 `cloudflared` 创建匿名 Quick Tunnel，并传入隔离的空配置；不接受 token、命名隧道、自定义域名或自定义 cloudflared 命令。
- 不生成、解释或改写项目环境变量；标准进程环境会原样传给 cloudflared，调用方对其提供的值负责。
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
eval "$(bun "$CQT_DIR/cqt.ts" start "http://127.0.0.1:4173" --state-dir "$TASK_STATE_DIR")"
printf '公网地址：%s\nPID：%s\n日志：%s\n' "$PUBLIC_URL" "$TUNNEL_PID" "$TUNNEL_LOG"
```

`start` 会先停止同一状态目录中仍存活的旧 tunnel，再按收到的 origin 启动新实例。`PUBLIC_URL` 始终是 cloudflared 生成并探活后的 Quick Tunnel 根地址，不附加项目路径。stdout 包含：

- `ORIGIN_URL`
- `PUBLIC_URL`
- `TUNNEL_PID`
- `TUNNEL_LOG`
- `TUNNEL_STATE_DIR`

公网入口生成后仍可能短暂返回 Cloudflare 5xx，透明代理也可能把这个阶段表现为 TLS/传输错误。`start` 会把 HTTP 5xx 与 `curl 000` 视为“尚未就绪”，在固定 180 秒墙钟窗口内持续探活并周期性报告最后状态；快速失败不会提前耗尽等待窗口。只有实际获得 HTTP 100–499 才会输出上述变量。超时后会报告最后一次 HTTP/传输状态并精确停止本轮 tunnel，不会交付中间 URL。

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

## Runtime Notes

- macOS 使用 `launchctl` 托管 worker，其他平台使用 detached 进程；两者都把精确 PID 写入状态目录。
- macOS worker 只为保持跨平台一致性而原样恢复调用进程环境，不识别其中任何项目变量。
- `start` 不设置 origin Host、不映射业务 URL，也不输出调用方专用变量。
- `status` 只依据状态目录中的精确 PID；`stale` 表示 PID 状态存在但进程已退出。
- `stop` 先发 `SIGTERM`，超时后仅对该 PID/独立进程组发 `SIGKILL`。

## Tests

```bash
cd "$CLOUDFLARE_QUICK_TUNNEL_SKILL_DIR"
bun test --max-concurrency 1
```

集成测试用 stub `cloudflared` / `curl` 验证标准 Quick Tunnel 参数、根 URL 输出和 start → status → stop → cleanup 的真实进程与状态回收。
