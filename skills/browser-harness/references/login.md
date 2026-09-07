# 登录态与 profile

需要登录或多账号时读取。`bh` 是 `bun "$BH_DIR/bh.ts"` 的速记；目录定位见 [平台与运行时](runtime.md)。

```bash
if BH_PREPARE_ENV="$(bun "$BH_DIR/bh.ts" prepare "$TARGET")"; then
  eval "$BH_PREPARE_ENV"
else
  BH_PREPARE_STATUS=$?
  bun "$BH_DIR/bh.ts" cleanup "$TARGET"
  exit "$BH_PREPARE_STATUS"  # 仅结束当前命令批次；Agent 按失败原因修复后重试
fi
bun "$BH_DIR/bh.ts" login "$APP_URL/login"
```

`login` 需要能弹 headed 浏览器的本机或显示转发环境；CI 应复用预先建好的 profile。登录态持久化供后续验收复用，关闭浏览器不等于删除 profile。只清理本次临时凭据或临时 profile，不删除用户既有登录态。

Journey 的 `--auth open` / `--auth use` storageState 由项目 testing-suite 管理，与 `bh login` profile 不互通；`bh login` 服务于 collect-evidence 和直接调用 agent-browser。

## profile 选择

默认情况下不用传 `--profile`：`login` / `collect-evidence` 和无参 `profile-dir` 会从当前工作目录向上查找最近的 `.git` 或 `package.json` 作为项目根，并生成项目 profile。命名规则统一为 `<项目根父目录>-<项目根目录>`，转小写并把连续空格、标点归一成 `-`；例如在 `/workspaces/lobe/admin` 或其子目录运行时，默认 profile 为 `lobe-admin`，目录为 `~/.browser-harness/profiles/lobe-admin`。找不到项目标记时以当前工作目录作为项目根。

因此同一项目的子目录会自动复用同一份登录态。若命令的当前目录与被验收项目不同，先在项目目录执行，或显式传 `--profile`，不要依赖另一仓库的上下文 profile。

`--profile <name>` 只在你需要覆盖项目默认值或**同时维护多套登录态**时使用（例如 `prod-monitor` 与 `staging`、不同租户/账号）。技能把名字解析成私有隐藏目录 `~/.browser-harness/profiles/<name>` 再传给 agent-browser，`login` 写入与 `collect-evidence` 读取指向同一目录。

交互验收中 agent 直接调 `agent-browser` 时，用 `--profile "$(bun "$BH_DIR/bh.ts" profile-dir [name])"` 取到该目录路径即可复用同一份登录态，不必记忆技能内部布局。

覆盖优先级为：显式 `--profile` / `profile-dir <name>` > `BH_DEFAULT_PROFILE` > 当前项目自动命名。`BH_PROFILE_ROOT` 可改存储根目录；`--profile` 也可直接传一个路径（含 `/` 或以 `~` 开头）绕过技能目录。
