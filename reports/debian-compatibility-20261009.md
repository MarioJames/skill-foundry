# Debian 技能兼容修复与真实运行验收

2026-10-09；宿主 Debian 13、x86_64、VMware，Bun 1.4.2。范围覆盖最初审查发现的 VM、调度/Herdr、浏览器/演示、SSH/zsh 和 CoW 风险。验收使用任务隔离目录，未改个人 shell 配置、系统包或其他项目。

| 技能 | 修复及实际结果 |
| --- | --- |
| `debian-testvm` | 区分 CPU 未透传、KVM 模块、设备权限和缺工具；ACL 读写权限有效，无需改组。官方镜像 SHA512 通过，真实启动后 QMP `query-kvm` 返回 `present/enabled: true`，SSH、cloud-init、sudo 正常。Docker 密钥下载曾发生 TLS 中断，增加有限重试及超时后镜像构建通过；生命周期 4 个用例、85 个断言全部通过。 |
| `agent-dispatch` | 自动 scope 优先使用当前 Codex 身份；身份冲突和缺失继续明确报错。当前安装副本能直接获得稳定 scope，实际 app-server 模型目录探测通过。7 秒以上的并行解锁用例使用局部 15 秒预算；失败清理核验进程身份并回收自有 runner/server，失败注入及回归通过。 |
| `herdr` | 当前 pane 能读回原生 Codex 会话，tab 名称符合 `1009｜FIX｜Debian 技能兼容`。任务自有 SSH tab 创建、命名、命令投递、输出读取与关闭均真实执行成功。 |
| `browser-harness` | 无 DISPLAY/WAYLAND 时，登录在创建 profile 前以退出码 2 拒绝启动。显式指定工具管理的浏览器，真实无头交互和两组采证通过，console、页面/网络错误及 artifact_errors 全空；服务及精确浏览器 PID 已释放。补充原生 installer 缓存目录核对，避免误认为通用缓存变量必然生效。 |
| `awesome-presentation` | 按指定 fork 的 pnpm monorepo 修正业务 Deck/core 路径、公开 imports、Deck id 命令和产物位置；补充 new 后正常生成 workspace lock、首份基线审图、原生 runner 自有 preview 的真实流程。任务生成项目修正 starter 重复 eyebrow、DOM metadata、正文字号；既有断言和门槛保持。项目 127 个测试及构建通过，三页键盘往返、Hash 直达和主题切换通过。独立审图后，三页 12 个矩阵案例与 starter 4 个案例全部通过，像素差为 0；各自 4 个 system 主题检查通过。 |
| `persistent-ssh-ops` | 按用户要求保留 zsh，明确其前置。隔离初始化/重跑与真实 zsh 登录 shell 扫描通过；在任务 VM 使用显式 runtime 入口真实密码登录，通过同一 TTY 的两次命令确认远端 PID、目录和环境状态复用，并验证 sudo，随后退出会话。 |
| `cow-workspace` | 无需源码修复。5 个真实 FUSE 生命周期用例、89 个断言通过，覆盖源码/依赖/Git 隔离、导出导入、重新挂载、占用与错误边界；任务挂载和 fixtures 已回收。 |

安装副本的 VM 额外端口转发功能已保留：5 个边界用例、47 个断言通过；另用真实 guest 服务验证 TCP/UDP 收发、重复添加、stop/start 后保留两条活动规则、运行中删除及 TCP 端口关闭。首次服务就绪前的探测出现 ECONNRESET，等待实际就绪后验证成功，未以探测结果修改转发逻辑。

## 验证与证据

- 技能仓库回归：208 个测试、1007 个断言、26 个文件，零失败。
- 独立 CoW、VM 生命周期、安装副本转发及演示项目测试分别为 5、4、5、127 个，全部通过；与上项合计 349 个测试。
- 15 个技能通过 skill-creator 官方格式校验；Python 的 YAML 依赖通过临时 `uv --with pyyaml` 提供。18 个 Bun 运行入口检查通过。
- 实测模板源 HEAD：`15cdabba6d6a04347c6015f1a9df94fd0c923c53`。QEMU 10.0.13；工具管理的 Chrome for Testing 155.0.8059.39。
- 公共证据根目录：`/tmp/debian-skill-acceptance-RPZ9Ij`。VM 的 `evidence/vm/{kvm-and-ssh.json,lifecycle.log,forward-live.json,cleanup.json}`、SSH 的 `evidence/ssh-persistent-tty.json`、CoW 的 `cow/{test.log,cleanup.json}`、浏览器的 `browser/{report.md,postfix.md}` 和截图/metrics 均保留。凭据输出不进入仓库或报告。
- 原始模板违规、首次 Docker TLS 失败和修复后的结果分别保留；最终技能源码 hash 位于 `evidence/final-source-hashes.json`。

## 环境与资源边界

QEMU/ISO 工具从 Debian 官方包解压到任务私有 runtime，以该目录的 PATH 完成全部 KVM 验收；未进行系统级安装。常规使用仍应按技能 doctor 准备工具路径与依赖。本次成功不表示缺少这些工具的默认 PATH 已可启动 VM。

安装副本仅同步本次修复，保留已有 VM 转发功能与用户配置；未预先安装的 awesome-presentation 没有新增全局安装。Docker 下载采用 curl 原生有限重试，选项行为参见 [curl 官方手册](https://curl.se/docs/manpage.html#--retry-all-errors)。

所有任务 VM、QEMU、SSH 会话、FUSE 挂载、浏览器及验收服务已释放，任务 Herdr tab 已关闭。可丢弃的 guest 和测试组件数据已按验收归属回收；官方镜像、Docker 镜像、隔离依赖和诊断证据保留用于复核，负责人为本次 Debian 兼容修复任务，复核完成后可精确回收。项目与用户持久数据未清理。

自动保护曾拦截私钥加载及向任务 VM 写 shell 启动文件；本次通过现有 testvm SSH 和显式 zsh 密码入口完成安全替代验证。未尝试绕过保护或修改真实 HOME。

本记录证明脚本运行和示例流程。正式 ACC 的 ChatGPT Review 前置当前不可用，未启动正式 ACC 轮次；调度候选被本地 owner_required 检查阻止时未启动 RPC worker，由父任务完成核验。
