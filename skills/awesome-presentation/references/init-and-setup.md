# 初始化与环境

## 依赖

| 依赖 | 用途 | 缺失时 |
| --- | --- | --- |
| `tnpm` / `tnpx` | 包管理与一次性执行 `@alipay/cmdai` | 按团队规范安装 tnpm |
| `@alipay/cmdai`（经 `tnpx`） | `presentation init` | **不要**默认 `tnpm i -g`；运行时用 `tnpx -y @alipay/cmdai …` |
| `git` | 浅克隆模板仓库 | 安装 Git；确认 `git clone` 可用 |
| 模板仓读权限 | 下载脚手架 | 配置 AntCode SSH/HTTPS 权限 |
| Playwright Chromium | `visual:*` | `tnpm exec playwright install chromium` |

默认模板仓库（与 cmdai 源码一致）：

```text
git@code.alipay.com:de_marketing_insurance/awesome-presentation.git
```

## 运行时入口（权威）

初始化**只**用：

```bash
tnpx -y @alipay/cmdai presentation init <directory>
```

- `-y`：非交互拉取/执行包，避免卡住确认。
- 不要求 PATH 里已有全局 `cmdai`。
- 不要写 `npx` 替代 `tnpx`（本技能默认 tnpm 生态）。
- 仅当用户明确要求全局安装、或 `tnpx` 不可用且用户同意时，才考虑 `tnpm i -g @alipay/cmdai`。

帮助自检（可选）：

```bash
tnpx -y @alipay/cmdai presentation --help
```

期望出现：

```text
Usage: cmdai presentation init [directory] [options]
```

## **HARD-GATE**：先问安装目录

在执行任何 `presentation init` 之前，必须**单独问用户**项目装在哪里，并得到明确路径。

### 规则

1. **禁止默认静默**写到 `./awesome-presentation`、当前目录 `.` 或任意猜测路径。
2. **一次一问**（与内容发现同风格）。可带推荐，但用户未确认前不 init。
3. 推荐示例（按主题改 slug）：

   > Spec 已批准。项目要建在哪个目录？  
   > **我建议：`./<topic-slug>`**（相对当前工作目录 `/…`）。  
   > 你也可以给绝对路径，或指定已有空目录。选哪个？

4. 用户给出路径后，**原样使用**（或按用户意图解析相对路径）；不要擅自改到别的盘符/父目录。
5. 若用户说「当前目录 / 就在这」：确认 `PWD` 是否为空；非空则说明风险并询问是否换目录或 `--force`。
6. 目录确认与 Spec 批准是两道闸：可以同一会话先后完成，但**不能跳过目录这一问**。

### 非空目录的停止条件

目标目录非空且不满足“已有项目”判定时，检查到这一事实后就停止工程动作，只问一个选择：

- **推荐**：用户确认一个新的空目录；
- **备选**：用户明确接受覆盖风险并授权在原目录使用 `--force`。

禁止自行采用“临时空目录 init → 合并到非空目标”“只复制没有冲突的文件”或“先生成草稿再等确认”等第三条路径。这些方案仍会替用户决定目录合并语义；“保留现有文件”“做最小处理”也不构成授权。

### 已有项目

若用户指向的目录已是本脚手架（见下方判定），问清：

- 在此目录上改业务 Deck，还是另开新目录？

未确认前不要 `init --force`，也不要往错误目录写页。

## 初始化命令

```bash
# <dir> = 用户刚确认的路径
tnpx -y @alipay/cmdai presentation init <dir>

# 仅当目录非空且用户明确要求覆盖模板同名文件
tnpx -y @alipay/cmdai presentation init <dir> --force
```

行为要点：

- 远程 `--depth 1` 浅克隆默认分支，复制到目标目录后删除临时目录。
- 会改写目标 `package.json` 的 `name` 为目录名归一化结果，并去掉模板 `repository` 字段。
- 非空目录无 `--force` 时直接失败，不要擅自 force。
- 成功后模板内的 `.claude/skills/presentation-layouts` 与 `presentation-components` 会一并落到项目中。

## 安装依赖

```bash
cd <用户确认的目录>
tnpm install
tnpm exec playwright install chromium   # 仅在需要 visual 门禁时
```

## 已有项目判定

同时满足即可跳过 init：

- 存在 `src/pages/registry.ts`
- 存在 `src/rules/layout-catalog.ts`
- 存在 `src/layouts/cover`（或 `top-bottom` / `top-columns` / `columns`）

若只有一个普通 React/Vite 项目、没有上述规则与 registry，不要硬套本技能的页面约定；应 init 到用户确认的新目录，或请用户确认迁移。

## 失败排查

| 现象 | 处理 |
| --- | --- |
| 未问目录就 init | 技能违规；停下来补问路径 |
| `tnpx: command not found` | 确认 tnpm 安装；用户同意后再考虑全局 `cmdai` 或等价入口 |
| `Failed to download presentation template` | 查 SSH key / VPN / 仓库权限；本地可先 `git ls-remote <repo>` |
| `Target directory is not empty` | 换用户确认的空目录，或用户确认后 `--force` |
| 包拉取失败 | 检查内网 registry 对 `@alipay/cmdai` 的访问 |
| `tnpm install` 失败 | 检查 registry / lock / 权限 |
| init 后缺 `.claude/skills` | 模板下载不完整；删目录后按同一用户路径重 init，或核对远程默认分支是否包含 skills |

初始化、下载或安装失败时，可以检查本次命令的错误、`tnpx`/Git 是否可用及明确的权限前置；随后停止并报告。不要扫描或复用 HOME 下的 npm/tnpm 缓存、其他项目、固定 `/tmp` 或系统临时目录中的旧脚手架来继续生成，这些都不是用户确认的模板来源，且可能过期或越界。
