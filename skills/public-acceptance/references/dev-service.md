# DEV 进程、端口与终端

没有本轮准备记录、需要启动或排查 DEV 服务时读取。已有确认的 APP_URL、PID 和日志直接复用；以下扫描用于发现未知服务，不在各阶段重复执行。

## 先探测，不先启动

将 `PUBLIC_ACCEPTANCE_SKILL_DIR` 设为本轮实际加载的技能目录，`PROJECT_DIR` 为目标项目的真实绝对路径。

```bash
bun "$PUBLIC_ACCEPTANCE_SKILL_DIR/scripts/dev.ts" inspect --project "$PROJECT_DIR"
```

探测脚本及其真实进程测试需要已安装的 strayd 和 Unix ps（Linux 完整验证；macOS 文件日志需另用 lsof 核实）。优先复用 `strayd --no-config list --json` 的原生扫描能力，避免用户隐藏规则漏掉运行中的服务。脚本再用当前进程 cwd、父子关系、TTY 和 Herdr `process-info` 校验，输出：

- `status`：`none` / `single` / `multiple` / `incomplete`；`single` 仅指一个监听进程，不代表只有一个端口或已通过 HTTP 验证。
- `candidates`：PID、进程 identity、cwd、实际 ports/hosts、运行时分类、匹配的 pane/tab、stdout/stderr 的文件或终端位置。不会输出完整命令行或环境变量。
- `warnings` / `pane_warning`：扫描限制与 Herdr 可用性。命令失败、`incomplete` 或权限受限不能当成“没有服务”。

仅 exact cwd 或路径边界内的 descendant cwd 作为候选；目录匹配仍需结合项目开发脚本核对。monorepo 子应用、同目录测试/生产进程、数据库和调试端口都不能直接复用。多候选时按本轮目标、启动记录、实际命令与响应消歧，不能默认挑第一个。

`none` 只表示当前未找到监听服务。启动前还要定向检查该项目的进程、已记录的启动进程 和相关 pane 输出，排除编译中、启动中或挂起的 DEV。已知启动进程存活时限时等待或排障，不再起第二份。

没有 strayd 时不自动安装：Linux 用 `ss -ltnp` 或 `lsof -nP -iTCP -sTCP:LISTEN`，macOS 用 lsof，获取 socket/PID；结合 `ps` 父子关系及 Linux `/proc/<pid>/cwd`、macOS `lsof -a -p <pid> -d cwd` 核实 cwd，再按 Herdr `pane list` / `process-info` 的 shell PID、前台 PID、TTY 关联 pane。Windows 须使用宿主原生探测能力；本页 Unix 命令不作 Windows 原生支持保证。工具或权限不足时明确报告缺失证据。

已有服务可以按本轮明确授权复用，不接管其停止权限。共享的远祖进程（如 Herdr daemon）不是 pane 归属证据；只接受服务的祖先链命中具体 pane shell/前台进程，或确实相同的 TTY。多个 pane 匹配时先消歧。

## 决定 DEV pane

Herdr 实际调用可用时加载 `herdr` 技能，按如下分支执行。保留当前焦点，不移动正在工作的 pane。

- 已有服务且唯一匹配原 pane：直接复用，不新建 tab、不重启服务。
- 已有服务但无 pane：直接记录已有可读日志位置，不为展示创建日志追踪 pane；没有可读日志时如实说明，不擅自重启。
- 无 DEV 进程：创建新 tab 的单个 pane，直接运行下一节的项目开发脚本。

新建时使用已加载 herdr 的 router，显式 `--scope independent` 以创建独立 tab，不能沿用 service 默认的同 tab split。`TAB_LABEL` 遵循当前会话的命名规则：

```bash
bun "$HERDR_SKILL_DIR/scripts/route-lane.ts" --type service --scope independent \
  --cwd "$PROJECT_DIR" --label "$TAB_LABEL"
```

消费成功 JSON 中的 `result.pane_id`、`result.tab_id` 与 `lane.cleanup_command`，记录资源归属；router 负责目录匹配、无焦点创建、命名回读和就绪检查。本任务的服务 pane 在开发脚本退出后继续保留，供手动重启；重启时确认已回到 shell，不向忙碌 pane 发送启动命令。

## 在 pane 前台启动

在 pane 的交互 shell 中直接运行项目已有开发脚本，沿用项目包管理器；不加启动包装器、不创建 DEV 状态文件。pane 的 cwd 已由 router 设置为项目目录，例如：

```bash
bun run dev
```

需要非敏感环境覆盖时直接使用 `env NAME=value <项目命令>`。新 pane 不自动继承工具 shell 的临时变量；必要配置按项目加载规则或明确传参传入，凭据不写入可见命令。不要用 `exec` 替换交互 shell，也不要用 nohup、`&` 或额外后台管理器启动 DEV。

输出直接显示在 pane，已有项目日志文件可一并交付，不强制 tee 或新建落盘日志。记录 pane/tab、项目目录、实际启动命令、监听端口和当时的进程信息。

用户可在同一 pane 中 Ctrl+C 停止服务，再重跑同一命令。后台隧道独立存活，停止或重启 DEV 不触发隧道 stop/start，也不因临时不可达自动重建。复用隧道需保持原本地 origin（协议、地址和端口）；按项目支持的方式固定端口，重启后若端口漂移，先恢复原端口，不能把旧公网地址误报为可用。需要公网 origin 配置时，取得地址后在同一 pane 用相应环境覆盖重启 DEV，隧道保持不变。

从启动输出和实际监听端口确定就绪地址；需要定位监听者时，使用已确认的项目启动进程 PID 限定 `dev.ts inspect --root-pid` 的子树。服务仍在启动时按项目合理时限等待输出，退出或超时则报告错误。手动重启后 PID 会变化，旧记录仅作线索，清理时重新核对当前进程归属。

## 确认 APP_URL 与发布

从同一候选的实际端口及监听 hosts 生成本地候选地址；`0.0.0.0` 转 `127.0.0.1`，`::` 使用 `[::1]`（仅在验证 IPv4 也能连接时使用 `127.0.0.1`）。多个端口逐一结合日志、协议和实际响应区分应用与调试端口，不机械使用最小值。HTTPS、base path、Host 要按项目事实处理。

启动记录与监听证据一致即可确定 `APP_URL`，不额外进行本地 HTTP 探活。仅归属或协议有歧义时补做一次限时请求，结合应用特征消歧；连接成功或状态码 200 本身不能证明应用身份。页面可达性统一在公网浏览器验证中确认。

本流程启动或发现的 DEV：直接 `cqt start <已核实的 origin>`；browser-harness 使用 **APP_URL 这个 URL target** 做 prepare/采证，不调用项目目录 prepare/publish/share。那些目录命令维护另一套 DEV PID 生命周期，可能停止并重启服务。若入场前已经由 browser-harness 管理，则保留原 target 和 share/cleanup 流程，不把服务登记到第二套状态。

tunnel 继续后台托管，默认没有 tunnel pane。需要排障或用户要求时才为它新建日志 pane，不能为展示重复启动 tunnel。

## 保留与清理

手动验收期间保留新 DEV pane 与 tunnel，交付 APP_URL、公网地址、PID/实际端口、pane 输出或已有日志、pane/tab ID、隧道状态目录、启动命令、归属和清理命令。清理顺序：

1. 使用本轮 tunnel 的原 state-dir（或原 browser-harness target）清理隧道。
2. 本任务新建的 DEV：核对 pane 当前仍运行该项目开发脚本后，在该 pane 发送 Ctrl+C；确认服务退出并回到 shell。若有残留，只对已核实归属和当前 identity 的进程发送终止信号，不按旧 PID 或名称宽泛杀进程。pane 已被用户用于其他工作时保留并说明。
3. 使用创建时返回的精确 `lane.cleanup_command` 回收本任务 tab/pane；先确认 tab 没有被用户加入其他 pane/工作，发生变化时只清理自己创建的 pane。已有服务、已有 pane 均不关闭。只追踪日志的 pane 关闭不会停止其外部服务。
4. 保留有诊断价值的启动日志与状态并报告位置；数据库和项目数据不在清理范围内。没有必要继续保留的浏览器与验证进程及时释放。

没有 Herdr 时明确说明日志展示降级；按宿主平台的已有托管方式启动并记录 PID/日志/停止方法，仍遵守先探测、归属验证、复用和精确清理。不在一次性工具 shell 中裸后台启动 DEV。
