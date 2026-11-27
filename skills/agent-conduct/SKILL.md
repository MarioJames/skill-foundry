---
name: agent-conduct
description: Agent 守则，无需用户点名。会话开始或主任务切换时（含只读问答、LobeHub 聊天与任务调度发起的运行）先用 name-session.ts 按 MMDD｜TYPE｜Topic 命名当前会话。任何会在本机留下文件、进程、容器或 Git 状态的任务（写代码、跑测试、构建、验收、部署、排障）开始、汇报完成和收尾时使用：规定什么才算完成，以及报告、证据、临时目录、worktree、分支、Docker 容器与卷、R2 分享对象的落点和回收（wt.ts、branch.ts、scan.ts）。向 LobeHub 社区仓库（lobehub/lobehub）提交、跟进或合并 PR 时使用：创建前经用户同意，用 community-pr.ts 判定合并门槛并跟进到合并。
---

# Agent 守则

三件事：会话一开始就命名，让用户在任何宿主里都能认出它；说完成之前对照目标核对，不拿做过的那部分充数；对自己在本机留下的东西负责，用完的回收，有价值的放到约定位置。

命名适用于所有会话，包括只读问答。本文是每次都要守的规则，细则按当前要做的事去读对应的一份，不用全读：

| 要做的事 | 读 |
| --- | --- |
| 放报告和证据、起容器、写测试 teardown、起长驻进程 | [资源落点与创建](references/resources.md) |
| 建隔离工作树、清理合入后的分支 | [Worktree 与分支](references/worktree-branch.md) |
| 收尾回收、保留临时资源、删除 R2 分享对象 | [收尾](references/cleanup.md) |
| 向 `lobehub/lobehub` 提交、跟进或合并 PR | [社区 PR](references/community-pr.md) |
| 命名结果是 `skipped` 或 `failed`、给子 Agent 交接命名、任务调度派发的话题 | [会话命名细则](references/session-naming.md) |

## 会话命名

会话开始或主任务切换时，任务一明确就运行，先于读取其他技能、派发子任务和实质工作；被 Weaver 拉起的父 Agent 同样如此：

```bash
bun <skill-dir>/scripts/name-session.ts --type <FEA|DES|FIX|OPT|REL|EXP|DOC|RES> --topic '<主题>' [--dry-run]
```

- 你只定 TYPE 和主题：主题用用户的语言，简短具体，不重复项目名；主题还不明确时保留原标题。日期、宿主识别、归属判断和读回核对都由脚本完成，结果以 stdout 的 JSON 为准，不手工改标题，也不重放。
- `named` 为 `false` 时保留原标题，在回复里说一句。
- 同一目标下的进度、追问和子任务不重命名。主任务切换时，新标题合并前后任务的关键信息，TYPE 取当前主任务，例如 `1115｜OPT｜会话命名迁入 conduct` 之后转去排查 herdr 归属，改为 `1115｜FIX｜命名迁入 conduct 与 herdr 归属误判`。
- 子 Agent、fork、Weaver worker 不改父会话的标题，除非交接里明确交给它。

## 责任心

「完成」指用户要的结果在真实链路上做成并验证过，约定的交付物也都交了。说完成之前，对照原始目标和所用技能的交付要求逐项核对；没做到的直接说没做到，并在本任务内补完，不等用户追问。

## 本机资源

任务会留下文件、进程、容器或 Git 状态时适用。下面几条不读细则也要守：

- **落点。** 报告放 `<工作区根>/reports/`，证据放 `<工作区根>/evidence/`，中间产物放任务临时根；工作区根指仓库所在的上一级目录。任务开始时记下开始时间，并用 `mktemp -d` 建临时根，worker 共用父 Agent 交下来的这一个。报告和证据不进仓库，工作区根不放别的东西。
- **容器和进程。** 一次性容器用 `docker run --rm`；要活到任务后段的加 `owner`、`purpose`、`release-when` 标签，删除用 `docker rm -v`。长驻进程用 `systemd-run --user --scope`，unit 名带任务名。
- **Worktree 和分支只走脚本。** 隔离工作树用 `wt.ts add` 建、`wt.ts remove` 回收，不直接 `git worktree add`。分支合入后用 `branch.ts` 清理，不凭分支名、日期或 `git branch --merged` 手动删除。参数看各自的 `--help`。
- **只动本任务的。** 不用 `docker volume prune`、`docker system prune`、`git worktree prune`、批量 `rm /tmp/*` 这类宽泛命令；归属不明的保留。

### 收尾回收

收尾前运行只读扫描，时间窗从任务开始算起：

```bash
bun <skill-dir>/scripts/scan.ts --since <任务开始时间或 6h> --workspace <工作区根>
```

- 扫描结果是待核实的候选，不是删除清单。本任务创建的一次性资源直接回收，不用等用户确认；别人的不动，在回复里列出；归属不明的保留。
- 保留临时资源要写明所有者、具体依赖和本任务结束前就能核对的释放条件。「以后可能还要复验」「留给 owner 审查后处置」都不是保留理由。
- 父 Agent 验收 worker 时，同时核对并回收它留下的资源。
- 最终回复分开写「已回收」和「仍保留」，后者带原因、所有者、释放条件，以及端口、路径或分享链接。

各类资源的回收条件、扫描范围和保留规则见 [收尾](references/cleanup.md)。

### R2 分享对象

交给用户的设计文档、验收报告和它们引用的证据，分享链接永久保留。自测、探测和核对失败的上传是一次性资源，收尾时用 feature-delivery 的 `share.ts remove --task <任务>` 删除，它只删登记在该任务名下的对象。登记格式和删除时的核对见 [收尾的「R2 分享对象」](references/cleanup.md#r2-分享对象)。

## 社区 PR

向 LobeHub 社区仓库（`lobehub/lobehub`）提交、跟进或合并 PR 前，读 [社区 PR：从创建到合并](references/community-pr.md)，每种状况的处理以它为准。任何时候都成立的几条：

- **创建前经用户同意，合并由用户做。** 用户在本次对话里点名授权时才代为合并。
- **能不能合并只认 `community-pr.ts check`。** 之前提交上的 👍、本地测试和其他 Agent 的审查都不算。
- **自己开的 PR 用 `watch` 盯到合并或关闭。** `watch` 退出并处理完之前不结束本轮回复，除非宿主会在进程退出时唤醒你；每次推送后请求 Codex 复审。
- **公开内容一律英文，只写社区版的事。** 不带内部、客户或租户的内容。
