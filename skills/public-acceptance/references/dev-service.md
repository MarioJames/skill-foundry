# DEV 进程、端口与终端

启动公网验收、复用已有服务或补日志可见性时读取。Agent 根据项目实际开发脚本与 HTTP 响应确认应用；脚本只提供进程证据和前台日志，不自动把任意监听端口当成 DEV。

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

`none` 只表示当前未找到监听服务。启动前还要定向检查该项目的进程、已记录 runner PID 和相关 pane 输出，排除编译中、启动中或挂起的 DEV。已知启动进程存活时限时等待或排障，不再起第二份。

没有 strayd 时不自动安装：Linux 用 `ss -ltnp` 或 `lsof -nP -iTCP -sTCP:LISTEN`，macOS 用 lsof，获取 socket/PID；结合 `ps` 父子关系及 Linux `/proc/<pid>/cwd`、macOS `lsof -a -p <pid> -d cwd` 核实 cwd，再按 Herdr `pane list` / `process-info` 的 shell PID、前台 PID、TTY 关联 pane。Windows 须使用宿主原生探测能力；Bun 前台 runner 和本页 Unix 命令不作 Windows 原生支持保证。工具或权限不足时明确报告缺失证据。

已有服务可以按本轮明确授权复用，不接管其停止权限。共享的远祖进程（如 Herdr daemon）不是 pane 归属证据；只接受服务的祖先链命中具体 pane shell/前台进程，或确实相同的 TTY。多个 pane 匹配时先消歧。

## 决定 DEV pane

Herdr 实际调用可用时加载 `herdr` 技能，按如下分支执行。保留当前焦点，不移动正在工作的 pane。

- 已有服务且唯一匹配原 pane：直接复用，不新建 tab、不重启服务。
- 已有服务但无 pane：stdout/stderr 指向可读普通文件时，在新的日志 pane 中 `tail -n 100 -F -- <实际日志文件>`；两个流写不同文件则同时追踪，路径作为独立参数安全引用。有本轮 `dev-process.json` 时也可使用其 `log_path`，但先核对 runner PID 与 identity。不能读取 `/proc/<pid>/fd/1` 管道或 TTY 来“接管”输出。没有日志、原终端不受 Herdr 管理或 pane 清单不完整时如实说明，不能为展示而重启。
- 无 DEV 进程：创建新 tab 的单个 pane，运行下一节的前台 runner。

新建时使用已加载 herdr 的 router，显式 `--scope independent` 以创建独立 tab，不能沿用 service 默认的同 tab split。`TAB_LABEL` 遵循当前会话的命名规则：

```bash
bun "$HERDR_SKILL_DIR/scripts/route-lane.ts" --type service --scope independent \
  --cwd "$PROJECT_DIR" --label "$TAB_LABEL"
```

消费成功 JSON 中的 `result.pane_id`、`result.tab_id` 与 `lane.cleanup_command`，记录资源归属；router 负责目录匹配、无焦点创建、命名回读和就绪检查。已经记录的本轮日志 pane 应复用，不能重复创建追踪器。只在新建且已就绪的 pane 执行命令，不向已有忙碌 pane 发送输入。

## 在 pane 前台启动

沿用项目包管理器和开发脚本，必要环境差异按项目规则传入，不能用生产脚本替代。先分配任务专属状态目录（每次启动使用新的目录，保留失败日志）；runner 必须在 pane 内执行，不在一次性工具 shell 中后台启动。可用 Herdr `pane run` 发送以下形状的命令，各路径和参数必须按目标 shell 正确引用：

```bash
bun "$PUBLIC_ACCEPTANCE_SKILL_DIR/scripts/dev-run.ts" \
  --project "$PROJECT_DIR" --state-dir "$DEV_STATE_DIR" -- bun run dev
```

末尾 `bun run dev` 仅为示例，替换为项目已有命令。需要 shell 语法时显式用 `-- bash -lc '<项目命令>'`；命令本身必须保持前台，不能内含 nohup、`&` 或自行脱离进程树。新 pane 不自动继承本轮工具 shell 的临时变量；命令中展开已确认的绝对路径，必要环境通过项目加载规则或明确传参传递，不把凭据写入可见命令。

`dev-run.ts` 同时向 pane 和私有 `dev.log` 写 stdout/stderr，在 `dev-process.json` 记录 runner PID/identity、child PID、项目路径、日志和退出状态。不保存命令或环境。状态文件独占创建，防止重复启动覆盖现场；文件存在时先核对已有进程，不能盲目删文件重跑。

读取启动记录后用 runner PID 限定监听进程的整棵子树：

```bash
bun "$PUBLIC_ACCEPTANCE_SKILL_DIR/scripts/dev.ts" inspect \
  --project "$PROJECT_DIR" --root-pid "$DEV_RUNNER_PID"
```

未出监听端口时检查 runner 的存活 identity、退出状态与日志，在项目合理启动时限内复查。失败或超时停止依赖步骤并清理本轮新资源。不能拿 shell、bun/pnpm 启动器 PID 没有监听端口当成失败，实际监听者常为孙进程。

## 确认 APP_URL 与发布

从同一候选的实际端口及监听 hosts 生成本地候选地址；`0.0.0.0` 转 `127.0.0.1`，`::` 使用 `[::1]`（仅在验证 IPv4 也能连接时使用 `127.0.0.1`）。多个端口逐一结合日志、协议和实际响应区分应用与调试端口，不机械使用最小值。HTTPS、base path、Host 要按项目事实处理。

限时请求候选地址，例如 `curl --noproxy '*' --connect-timeout 2 --max-time 5 -i "$CANDIDATE_URL"`；核对应用特征及预期鉴权响应。连接成功或状态码 200 本身不是应用身份验证。最终使用前再次确认 PID identity、端口归属和存活状态没有变化。只有归属与本地响应都确认后才确定 `APP_URL`。

本流程启动或发现的 DEV：直接 `cqt start <已核实的 origin>`；browser-harness 使用 **APP_URL 这个 URL target** 做 prepare/采证，不调用项目目录 prepare/publish/share。那些目录命令维护另一套 DEV PID 生命周期，可能停止并重启服务。若入场前已经由 browser-harness 管理，则保留原 target 和 share/cleanup 流程，不把服务登记到第二套状态。

tunnel 继续后台托管，默认没有 tunnel pane。需要排障或用户要求时才为它新建日志 pane，不能为展示重复启动 tunnel。

## 保留与清理

手动验收期间保留新 DEV pane、必要的日志追踪 pane 与 tunnel，交付 APP_URL、公网地址、PID/实际端口、日志、pane/tab ID、状态目录、归属和清理命令。清理顺序：

1. 使用本轮 tunnel 的原 state-dir（或原 browser-harness target）清理隧道。
2. 新 DEV runner：核对状态中的 runner PID/identity 仍匹配后，仅向 runner PID 发送 SIGTERM；runner 转发终止信号至自己的子进程，超时后只对已记录且 identity 未变化的子进程强制退出。确认 runner、child 和发现的监听 PID/端口已经退出。没有确认则报告具体残留，不能宽泛杀进程。
3. 使用创建时返回的精确 `lane.cleanup_command` 回收本任务 tab/pane；先确认 tab 没有被用户加入其他 pane/工作，发生变化时只清理自己创建的 pane。已有服务、已有 pane 均不关闭。只追踪日志的 pane 关闭不会停止其外部服务。
4. 保留有诊断价值的启动日志与状态并报告位置；数据库和项目数据不在清理范围内。没有必要继续保留的浏览器与验证进程及时释放。

没有 Herdr 时明确说明日志展示降级；按宿主平台的已有托管方式启动并记录 PID/日志/停止方法，仍遵守先探测、归属验证、复用和精确清理。`dev-run.ts` 自身不负责跨一次性 shell 存活。
