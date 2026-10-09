# 初始化与环境

## 来源与依赖

模板真源：`https://github.com/MarioJames/awesome-presentation.git`。需要 Git 和仓库读权限；直接浅克隆，不使用旧 `tnpx -y @alipay/cmdai presentation init`（旧包模板源硬编码为内部 AntCode，不能指向该 fork）。

先读取本次 clone 的 `package.json.packageManager`、锁文件和 workspace；当前 fork 是 pnpm monorepo，应使用其中声明的 pnpm 版本及 frozen lock，不按通用 bun 偏好切换。只有项目无约定时才优先 bun、其次 pnpm。只有明确内网要求时才用 tnpm。

依赖缺失时报告准确前置；系统工具安装遵守当前授权，不自动装 Git、工具链或改变全局配置。

## 目录选择

- 用户给出路径：按其意图解析相对/绝对路径并使用，不重复确认。
- 用户要求修改当前或指定的已有脚手架项目：检查成立后直接改业务 Deck，跳过克隆。
- 新建项目但未指定路径：可选当前工作区内尚不存在的主题子目录并说明；先检查目标及父目录，不静默覆盖已有内容。仅在无法确定工作区或落盘会超出授权时询问。
- 目标是空目录：可直接 clone。目标非空且不是本脚手架：已有明确合并范围和覆盖授权时按其范围执行；否则说明冲突，询问换空目录或授权临时目录克隆后选择性合并。

“保留已有内容”不等于授权合并；不能以“只复制不冲突文件”绕过非空目录决策。已有合并授权不需逐文件重复问，但新出现的覆盖风险超出授权时须停止相关写入。

## 已有项目判定

检查以下结构：

- `pnpm-workspace.yaml` 与目标 `presentations/<id>/presentation.json`
- `presentations/<id>/src/pages/registry.ts`
- `packages/core/src/rules/layout-catalog.ts` 与 `packages/core/src/layouts/`

普通 React/Vite 项目若没有该规则与 registry，不硬套页面约定。按用户已授权的迁移范围处理；未授权迁移或合并时才澄清目标。

## 初始化

```bash
# <dir> = 请求中的路径或上述规则选定的安全新目录
git clone --depth 1 https://github.com/MarioJames/awesome-presentation.git <dir>
cd <dir>
```

仅对本次新克隆模板做后处理：移除其 `.git` 模板历史，将 `package.json.name` 改为新项目名（kebab-case），删除模板 `repository` 字段。不得删除已有目标项目的 `.git`；授权选择性合并时也不得把模板 `.git` 复制进去。

模板隐藏目录一并落盘，随后读取：

- `.claude/skills/presentation-layouts/SKILL.md`
- `.claude/skills/presentation-components/SKILL.md`

```bash
pnpm install --frozen-lockfile
# 新建业务 Deck；修改已有 Deck 时沿用其 id，不重复创建：
pnpm presentation new <id>
# new 增加 workspace importer 后，按项目生成锁文件并链接新 Deck 的依赖：
pnpm install --no-frozen-lockfile
pnpm presentation dev <id>
# 需要项目 visual runner 且缺少 Chromium 时，按已有下载授权执行：
pnpm exec playwright install chromium
```

`list/dev/build/visual:check` 等命令按项目 CLI 接收 Deck id，省略时通常选 `starter`；不要把 id 作为任意 Vite 参数传递，也不要把 `apps/showcase` 当成业务 Deck。

克隆后的首次安装使用 frozen lock；新建 Deck 属于新增 workspace，随后正常安装生成锁文件。不得手改 lock 或拼接 `node_modules` 链接；只修改已有 Deck 且依赖未变时不需要重新生成锁文件。

Debian/Linux 上还需浏览器对应的共享库；缺库时核对实际 Chromium 的启动错误和 `ldd` 结果。系统依赖安装须先取得授权，项目 Playwright runner 使用 `pnpm exec playwright install-deps chromium`；agent-browser 验收加载 browser-harness 的运行时说明。隔离下载使用工具已支持的原生目录设置并核对实际落盘位置，不假定环境变量一定生效。

## 失败处理

- `destination path already exists`：回到目录选择，不能自行覆盖或绕过合并授权。
- `Repository not found` / 403：核对本次仓库地址、可见性和现有访问权限，不输出 token。
- 超时或连接失败：检查本次网络/代理条件，报告原始阻断；可在已有授权内重试同一来源。
- 安装失败：检查实际包管理器、registry、lockfile 和权限，修复可确定的任务内问题；不能解决则报告阻断。
- 缺 `.claude/skills` 或规则文件：核对本次 clone 完整性和 fork 分支，不把普通模板冒充本脚手架；不无条件删除已有目录重来。

克隆、下载或安装失败后，不扫描 HOME 缓存、其他项目、固定 `/tmp` 或系统临时目录寻找旧脚手架继续生成。它们不是本次指定来源，不能证明版本与完整性。
