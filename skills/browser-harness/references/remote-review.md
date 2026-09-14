# 远程走查与服务保留

仅在用户已有远程走查或保留服务要求时进入本分支。普通验收通过后直接 cleanup，不主动追加走查问答。仅要求保留本地服务时，保留已启动的服务并报告 URL、PID、端口和原因，不创建 tunnel。

创建公网入口需要当前会话的用户授权；“启动并发布/暴露到公网/CF 公网验收/生成公网验收地址”已构成授权，不重复询问。只要求远程走查但尚未授权公网暴露时，在创建 tunnel 前说明暴露范围并询问；此前完成本地验收和可交付准备，等待期间只保留本任务必要资源。

公网流程需加载伴生 `public-acceptance` 技能。`share` / `publish` / `cleanup` 已委托它管理同一条 tunnel，不另起第二条。Quick Tunnel 是无认证临时公网入口，随机域名不是访问控制，不用于生产或敏感数据。

## 复用本轮服务

```bash
# TARGET 与 prepare 相同，使用项目绝对路径
if BH_REMOTE_ENV="$(bun "$BH_DIR/bh.ts" share "$TARGET")"; then
  eval "$BH_REMOTE_ENV"
else
  BH_REMOTE_STATUS=$?
  # share 失败保留已有走查服务，按原始错误处理，不交付残留 URL
  exit "$BH_REMOTE_STATUS"
fi
printf '远程走查地址：%s\n' "$REMOTE_REVIEW_URL"
```

`share` 仅支持包含 package.json、已经 prepare 且 dev PID 仍存活的项目。它读取持久化 APP_URL，提取 origin 和 TUNNEL_HTTP_HOST_HEADER，委托伴生技能创建 tunnel，再把 path/query/hash 拼到根地址上，输出 APP_URL、REMOTE_REVIEW_URL、CLOUDFLARED_PID、CLOUDFLARED_LOG。状态缺失或 PID 已退出时拒绝发布，不从日志猜端口。

地址生成后立即交付，启动命令不做公网 URL 探活；公网验收任务随后按 public-acceptance 主流程验证页面与登录并交付账号密码；报告服务与 tunnel 的 PID、日志、端口和保留原因。保留所需服务与 tunnel 至用户结束走查；无需保留的验收浏览器/验证进程及时关闭。结束时用相同 target 执行 cleanup。

## 直接启动并发布

用户已明确要求“启动 xx 项目并发布/暴露到公网”时无需再次确认：

```bash
TARGET=/absolute/path/to/project
if BH_REMOTE_ENV="$(bun "$BH_DIR/bh.ts" publish "$TARGET")"; then
  eval "$BH_REMOTE_ENV"
else
  BH_REMOTE_STATUS=$?
  bun "$BH_DIR/bh.ts" cleanup "$TARGET"
  exit "$BH_REMOTE_STATUS"
fi
printf '远程走查地址：%s\n' "$REMOTE_REVIEW_URL"
```

`publish` 一次完成 dev server 启动，并委托 `public-acceptance` 完成 tunnel 创建；stdout 额外包含 `DEV_SERVER_PID` / `DEV_SERVER_LOG`。伴生技能在生成地址前失败时会回收 dev server。公网地址生成后立即交付，启动命令不做 HTTP、TLS 或页面探活；公网验收任务随后执行页面、登录验证与账号交付。用户结束走查后仍用相同 target cleanup。

`publish` 沿用 `prepare` 的端口发现协议：dev stdout/stderr 必须打印 `http://localhost:<port>` 或 `http://127.0.0.1:<port>`。自建极简 server 或自定义 `BH_DEV_COMMAND` 时显式打印实际监听 URL；不要从进程列表猜端口。

### 与 public-acceptance 的边界

本技能保留 `share` / `publish` 作为前端流程入口，但不再复制标准 `cloudflared` 生命周期实现。匿名 [TryCloudflare Quick Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/) 的固定参数、隔离配置、根地址生成、精确 PID、macOS launchd 托管和 stop/cleanup 均以 `public-acceptance` 技能为事实源；public-acceptance 主流程负责公网验收编排与账号交付，以下项目相关运行时能力由 browser-harness 提供，编排时直接复用：

- 从 `APP_URL` 计算 tunnel origin 与 `TUNNEL_HTTP_HOST_HEADER`。
- 把 path/query/hash 拼接为最终 `REMOTE_REVIEW_URL`。
- 管理 `BH_*` / `BASE_PATH` 等项目环境契约、技能定位兼容和旧输出变量映射。

启动/发布任务的快速交付只证明地址已生成；若任务为公网验收或另含可用性验收要求，交付地址后按该范围验证，并分别报告“地址已生成”和“可达性已验证”。不要把探活加入启动成功条件。

## 伴生技能定位

`share` / `publish` 默认从 browser-harness 的同级技能根查找 `public-acceptance/scripts/cqt.ts`，也兼容 HOME 安装根。两个技能不在同一根时，将 `PUBLIC_ACCEPTANCE_SKILL_DIR` 设为实际加载的伴生技能目录，不指向复制出来的单个脚本。
