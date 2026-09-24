# 隧道 CLI 与生命周期

仅在直接使用 `cqt.ts` 或检查、清理隧道时读取。`cqt` 只管理匿名隧道；DEV 服务、账号查找及验收由主流程负责。

## Setup

依赖 Bun ≥ 1.3 与 `cloudflared`：

```bash
command -v bun >/dev/null || {
  echo "请先安装 Bun 1.3+：https://bun.sh"
  exit 2
}
command -v cloudflared >/dev/null || {
  echo "请先安装 cloudflared：https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/"
  exit 2
}
```

将 `PUBLIC_ACCEPTANCE_SKILL_DIR` 设为本轮加载的技能目录，直接使用其中的脚本：

```bash
CQT_DIR="$PUBLIC_ACCEPTANCE_SKILL_DIR/scripts"
```

## Lifecycle

`LOCAL_ORIGIN` 必须来自已核实的 DEV 服务实际监听地址，不能照抄示例端口。以下命令在同一 shell 批次解析并消费变量；跨批次重新解析脚本目录并使用已记录的绝对状态目录。

为每个任务创建专属状态目录，并在整个生命周期复用它。默认状态目录按当前物理工作目录隔离；跨 shell、多个服务并行或由其他技能联动时应显式传绝对 `--state-dir`。

```bash
TASK_STATE_DIR="$(mktemp -d -t cqt-acceptance.XXXXXX)"
TUNNEL_ENV="$(bun "$CQT_DIR/cqt.ts" start "$LOCAL_ORIGIN" --state-dir "$TASK_STATE_DIR")" || exit $?
eval "$TUNNEL_ENV"
printf '公网地址：%s\nPID：%s\n日志：%s\n' "$PUBLIC_URL" "$TUNNEL_PID" "$TUNNEL_LOG"
```

已有本轮地址时直接复用，不再调用 `start`；它会先停止同一状态目录中仍存活的旧 tunnel，再按收到的 origin 启动新实例。`PUBLIC_URL` 始终是 cloudflared 生成的 Quick Tunnel 根地址，不附加项目路径。stdout 包含：

- `ORIGIN_URL`
- `PUBLIC_URL`
- `TUNNEL_PID`
- `TUNNEL_LOG`
- `TUNNEL_STATE_DIR`

`start` 只等待 cloudflared 在日志中生成 `*.trycloudflare.com` 地址，解析成功后立即写入状态并输出上述变量。它不会请求公网 URL，也不会把 HTTP/TLS 可达性作为启动条件。地址刚生成时可能短暂返回 Cloudflare 5xx 或出现 TLS/传输错误；先交付生成的地址，不因此重建或停止本轮 tunnel；公网验收在地址交付后独立执行，使用一次浏览器验证结果如实报告，不另做 HTTP 轮询。

只读检查不创建进程：

```bash
TUNNEL_ENV="$(bun "$CQT_DIR/cqt.ts" status --state-dir "$TASK_STATE_DIR")" || exit $?
eval "$TUNNEL_ENV"
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
