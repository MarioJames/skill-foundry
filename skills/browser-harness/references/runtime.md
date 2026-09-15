# 平台、环境与清理排障

目录定位失败、自定义启动、跨 shell 批次、macOS 或清理异常时读取。

## 依赖与定位

依赖 Bun ≥ 1.3 与 vercel-labs/agent-browser CLI ≥ 0.29。`share` / `publish` 还需要安装 `public-acceptance` 伴生技能；其脚本负责检查 `cloudflared`，非公网流程不得因这些公网依赖缺失而失败：

```bash
command -v bun >/dev/null || {
  echo "请先安装 Bun 1.3+：https://bun.sh"
  exit 2
}
command -v agent-browser >/dev/null || {
  echo "请按 https://github.com/vercel-labs/agent-browser 安装 agent-browser，并配置已安装的 Chrome 路径；没有可用浏览器时再按授权安装"
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

## 浏览器与窗口模式

`login` / `collect-evidence` 直接调用 agent-browser，继承调用环境与其配置读取规则；本技能只管理验收 profile，不另设 `executablePath` 或 `headed` 配置层。agent-browser 默认优先级从低到高为：`~/.agent-browser/config.json` → 当前工作目录的 `agent-browser.json` → 环境变量 → CLI 参数。显式 `AGENT_BROWSER_CONFIG` / `--config` 会改用指定文件，替代默认配置文件读取。

普通已安装的 Google Chrome 可在用户配置中设置一次 `executablePath`，直接调用 agent-browser 和运行 harness 时共用。按平台核实实际安装位置，例如 Linux 的 `/usr/bin/google-chrome-stable` 或 macOS 的 `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`。已有可用 Chrome 时，无需额外运行 `agent-browser install` 下载 Chrome for Testing；未配置路径时的浏览器发现行为由 agent-browser 决定。

`headed` 独立于浏览器路径，同一份 Chrome 支持有头和无头模式。本机验收希望显示窗口时，可在现有用户配置中合并 `"headed": true`，保留其他配置。`collect-evidence` 不主动指定窗口模式；单次无头采证可用：

```bash
AGENT_BROWSER_HEADED=false bun "$BH_DIR/bh.ts" collect-evidence "$APP_URL"
```

`login` 为交互登录显式传入 `--headed`，优先于环境变量，所以以上无头覆盖仅适用于采证。切换浏览器路径或窗口模式前，先关闭本任务的 agent-browser 会话，再以新配置启动；已有会话或 `--reuse-page` 不会因此自动切换模式。关闭时保持同一 session/profile 边界，不关闭用户既有浏览器，也不删除持久化登录态。

## 运行约束

- shell 工具调用之间不共享 `BH_DIR`、`APP_URL` 或其他变量。不要把它们写到固定 `/tmp/<name>` 再假定后续存在；在同一批命令内完成解析与消费，或使用当前任务专属临时目录并在下一批显式重载。
- 跨批次仅保存成功 prepare 的 stdout 赋值行，见下方示例；失败时删除不完整文件并 cleanup，不让下一批 source 旧值。不要剥掉 `APP_URL=` / `DEV_SERVER_PID=` / `DEV_SERVER_LOG=` 后只存裸值。
- shell 宿主可能沿用前一批的 cwd；不要假定相对 target 仍从最初任务目录解析。每批显式 `cd "$TASK_ROOT"`，或把 target 固定为已验证的绝对路径。
- 不要假设交互式 shell 中的 `ls` 是 GNU coreutils；它可能被 alias 成 `eza`，而 `--time-style` 等 GNU 选项会变成无效参数。资源存在性与清理验证优先用精确路径的 `test`、`find` 或平台可用的 `stat`，不要为了报告旧日志时间额外运行不兼容的列表探针。
- `bh prepare` 在项目目录场景下 stdout 输出 `APP_URL=...`、`DEV_SERVER_PID=...`、`DEV_SERVER_LOG=...` 三行；先检查赋值命令的退出码，再 eval 成功结果，见 [入口示例](../SKILL.md)；直接把命令替换嵌入 eval 会吞掉 prepare 失败。其他场景仅输出 `APP_URL=`。项目 APP_URL 同时持久化给后续 `share`，cleanup 会删除该状态。
- macOS 下技能用 `launchctl submit` 托管 Bun dev worker，避免一次性 shell/exec 退出时回收子进程。如果 journey 报 `ERR_CONNECTION_REFUSED`，先看 `DEV_SERVER_PID` / `DEV_SERVER_LOG`，**DO NOT** 直接判定为页面或测试资产失败。
- macOS `launchctl` worker 的 `PATH` 可能比当前 shell 精简；技能对自动识别的 `dev` / `start` / `serve` 已使用当前 Bun 的绝对路径。自定义 `BH_DEV_COMMAND` 若调用其他 CLI，仍需传绝对可执行文件，例如 `BH_DEV_COMMAND="$(command -v bun) run server.ts" bh prepare .`。不要为此自动安装依赖或修改全局 `PATH`。
- `bh prepare` 的 dev 命令优先级：`BH_DEV_COMMAND` > `package.json scripts.dev` > `start` > `serve`；项目脚本统一通过 `bun run` 启动，都没有时报错让你显式指定。
- 自定义联调示例：`BH_DEV_COMMAND="bun run dev:api" BH_APP_HOST=api.example.test bh prepare .`
- `BH_DEV_COMMAND`、`BH_APP_HOST`、`BH_CURL_NO_PROXY` 是 browser-harness 自己的环境契约。单次调用优先使用上面的命令前缀；若先分行赋值，必须 `export BH_DEV_COMMAND=...` 后再运行 `bh prepare`。仅写 `BH_DEV_COMMAND=...` 再执行下一条命令不会进入子进程，技能会回退到 `package.json` 脚本。
- `bh cleanup` 按项目路径为伴生技能计算独立 state-dir：先委托它 cleanup 公网 tunnel，再停止 dev server；若 prepare/share/publish 时用的不是 `.`，cleanup 需传同一 target。HTML 文件 target 会归一到所在目录，未启动相关进程时是可重复的 no-op。
- 资源复核以 prepare 返回并持久化的精确 `DEV_SERVER_PID`、项目状态文件和本次 profile 为边界。不要用宽泛的 `pgrep -f 'headless|agent-browser'` 判定残留：`pgrep -f` 会匹配探针自身的 argv，产生假阳性并诱发误杀用户浏览器；必须核对精确 PID、父进程和本次 profile 路径，且只回收本任务创建的进程。
- 执行 `agent-browser close` 后，不要再用 `agent-browser snapshot`、`open` 或其他浏览器命令探测“是否已关闭”：这些命令可能惰性启动新会话，反而制造资源残留。关闭后的只读确认应检查本轮已记录的精确浏览器/CDP PID 或端口是否消失；若误触发了浏览器命令，必须再次关闭本轮会话并重新做外部精确检查。
- 本技能适配 agent-browser ≥ 0.29（`--json` 信封输出、`screenshot` 位置参数）；版本偏低时命令会输出 warn；报告所需版本，升级仍遵守当前授权。

## 跨批次保存 prepare 结果

`TASK_TMP` 是当前任务专属临时目录；下一批仅重载本次成功生成的文件。失败分支保留原始退出码，清理本任务资源后结束当前命令批次，由负责开发的 Agent 修复后继续。

```bash
umask 077
if bun "$BH_DIR/bh.ts" prepare "$TARGET" > "$TASK_TMP/prepare.env"; then
  . "$TASK_TMP/prepare.env"
else
  BH_PREPARE_STATUS=$?
  rm -f "$TASK_TMP/prepare.env"
  bun "$BH_DIR/bh.ts" cleanup "$TARGET"
  exit "$BH_PREPARE_STATUS"
fi
# 下一批仅在上述准备成功时重载：. "$TASK_TMP/prepare.env"
# 最终 cleanup 后删除本任务的 prepare.env
```
