# 初始化与环境

## 依赖

| 依赖 | 用途 | 缺失时 |
| --- | --- | --- |
| `git` | 浅克隆模板仓库（GitHub fork） | 安装 Git；确认 `git clone` 可用 |
| 模板仓读权限 | 下载脚手架 | fork 仓库需 public，或本机已配置对该私有仓的访问 |
| `tnpm` / `pnpm` / `npm` | 安装依赖 | 任选其一；内网用 tnpm，外网可 pnpm/npm |
| Playwright Chromium | `visual:*` | `tnpm exec playwright install chromium`（或对应包管理器） |

模板仓库（**GitHub fork**，已脱离内部 AntCode 源）：

```text
https://github.com/MarioJames/awesome-presentation.git
```

> 历史上用 `tnpx -y @alipay/cmdai presentation init` 入口，模板源被 cmdai 包内部硬编码为 AntCode 仓 `git@code.alipay.com:de_marketing_insurance/awesome-presentation.git`。现改为直接 `git clone` GitHub fork，不再依赖 cmdai / tnpm 生态拉脚手架。

## 运行时入口（权威）

初始化**只**用直接克隆：

```bash
git clone --depth 1 https://github.com/MarioJames/awesome-presentation.git <directory>
```

- `--depth 1`：浅克隆默认分支，等价于 cmdai 旧的浅克隆行为。
- 不再需要 `tnpx` / `@alipay/cmdai` / 内网 registry。
- 不要再用 `tnpx -y @alipay/cmdai presentation init`（模板源被包硬编码，无法指向 fork）。
- 仅当用户明确要求、且本机确实有 cmdai 入口并接受其内部模板源时，才回退到 cmdai。

## **HARD-GATE**：先问安装目录

在执行任何克隆 / 初始化之前，必须**单独问用户**项目装在哪里，并得到明确路径。

### 规则

1. **禁止默认静默**写到 `./awesome-presentation`、当前目录 `.` 或任意猜测路径。
2. **一次一问**（与内容发现同风格）。可带推荐，但用户未确认前不 init。
3. 推荐示例（按主题改 slug）：

   > Spec 已批准。项目要建在哪个目录？  
   > **我建议：`./<topic-slug>`**（相对当前工作目录 `/…`）。  
   > 你也可以给绝对路径，或指定已有空目录。选哪个？

4. 用户给出路径后，**原样使用**（或按用户意图解析相对路径）；不要擅自改到别的盘符/父目录。
5. 若用户说「当前目录 / 就在这」：确认 `PWD` 是否为空；非空则说明风险并询问是否换目录，或授权临时目录克隆后选择性合并。
6. 目录确认与 Spec 批准是两道闸：可以同一会话先后完成，但**不能跳过目录这一问**。

### 非空目录的停止条件

目标目录非空且不满足“已有项目”判定时，检查到这一事实后就停止工程动作，只问一个选择：

- **推荐**：用户确认一个新的空目录；
- **备选**：用户明确接受合并风险并授权「临时目录克隆后选择性合并到非空目标」。

禁止自行采用“临时空目录 init → 合并到非空目标”“只复制没有冲突的文件”或“先生成草稿再等确认”等第三条路径。这些方案仍会替用户决定目录合并语义；“保留现有文件”“做最小处理”也不构成授权。

### 已有项目

若用户指向的目录已是本脚手架（见下方判定），问清：

- 在此目录上改业务 Deck，还是另开新目录？

未确认前不要克隆，也不要往错误目录写页。

## 初始化命令

```bash
# <dir> = 用户刚确认的路径
git clone --depth 1 https://github.com/MarioJames/awesome-presentation.git <dir>

# 非空目录场景：先 clone 到临时目录再 rsync 进去（避免 git 拒绝克隆到非空目录）
# 仅当用户明确授权在非空目录落盘时使用，且仍须谨慎核对冲突文件
```

非空目录 Git 默认会失败（`destination path already exists and is not an empty directory`）。原 cmdai 的 `--force` 覆盖语义不复存在；改由人工确认：

- 推荐换用户确认的空目录；
- 或用户明确授权后，clone 到临时目录再选择性合并（仍须逐文件确认覆盖，不擅自决定合并语义）。

克隆后的后处理（**复刻 cmdai 旧行为**）：

```bash
cd <dir>
# 1. 删除浅克隆历史（cmdai 旧版会删临时目录，等价于不带 .git）
rm -rf .git

# 2. package.json.name 改为目录名归一化（kebab-case）
#    并删除模板的 repository 字段
#    （可用 jq 或手动改；下面给出 jq 版本）
jq 'del(.repository) | .name = "<dir-name-kebab>"' package.json > package.json.tmp \
  && mv package.json.tmp package.json
```

行为要点：

- `--depth 1` 浅克隆默认分支，等价于 cmdai 旧的浅克隆逻辑。
- 须手动改写目标 `package.json` 的 `name` 为目录名归一化结果，并去掉模板 `repository` 字段（cmdai 旧版会自动做，现需手工）。
- 非空目录直接失败，无 `--force`；按上文「非空目录」处理。
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
| `git: command not found` | 安装 Git；macOS 装 Xcode CLT，Linux 装 git 包 |
| `destination path already exists` | 目标非空；换用户确认的空目录，或用户授权后临时目录克隆再合并 |
| `Repository not found` / 403 | fork 仓库 private 或本机无权限；确认仓库可见性或配置 SSH/token |
| `Failed to connect` / 超时 | 网络 / 代理；GitHub 访问需确认代理设置 |
| `tnpm install` 失败 | 检查 registry / lock / 权限；外网可换 pnpm/npm |
| clone 后缺 `.claude/skills` | 克隆不完整或 fork 默认分支不含 skills；删目录后按同一用户路径重 clone，或核对 fork 默认分支 |
| `package.json` 后处理失败 | jq 未装则手动改 name、删 repository 字段 |

初始化、克隆或安装失败时，可以检查本次命令的错误、`git`/网络是否可用及明确的权限前置；随后停止并报告。不要扫描或复用 HOME 下的 npm/tnpm 缓存、其他项目、固定 `/tmp` 或系统临时目录中的旧脚手架来继续生成，这些都不是用户确认的模板来源，且可能过期或越界。
