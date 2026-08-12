#!/usr/bin/env bun

import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";

import {
  bootstrapConfig,
  bootstrapDiscovery,
  bootstrapRelationRegistry,
} from "./config.ts";
import {
  CONFIG_PATH,
  DISCOVERY_PATH,
  RELATION_INDEX_PATH,
  RELATION_REGISTRY_PATH,
  REPO_DOCS_PATH,
  WORKSPACE_INDEX_PATH,
  ensureMemoryDailyDir,
  escapeCell,
  relLink,
  renderCategoryCell,
  renderEvidenceList,
  writeText,
  type JsonObject,
} from "./core.ts";
import { repoMap } from "./discovery.ts";
import { normalizeStandaloneRepos } from "./relations.ts";

export const MEMORY_GUIDANCE_IN_MEMORY_V1 =
  "只保存无法从代码、git/PR/CI、任务系统或 `.workspace/` 事实源可靠恢复，"
  + "且会改变后续决策的上下文。使用带日期的 `[偏好]`、`[纠正]`、"
  + "`[用户操作]`、`[确认决策]` 或 `[接续]` 条目，写清作用域、来源和当前有效结论；"
  + "按 `## workspace` / `## repo:<repo>` 分节，任务再嵌套 `### task:<task-key>`，"
  + "不要记录实现清单、测试结果、精确计数或例行图谱刷新，过期或已进入权威事实源的内容应压缩或删除。";

export const MEMORY_PLACEHOLDER = "- 暂无需要保留的上下文。";
export const MEMORY_PLACEHOLDERS = new Set([
  MEMORY_PLACEHOLDER,
  "- 暂无操作记忆。",
  "- No operation memory yet.",
]);
export const MEMORY_SCOPE_HEADING_RE = /^##\s+(?:workspace|repo:([^\s/]+))\s*$/;
export const MEMORY_TASK_HEADING_RE =
  /^###\s+task:([A-Za-z0-9][A-Za-z0-9._-]*)\s*$/;
export const MEMORY_LEGACY_HEADING_RE = /^##\s+\d{4}-\d{2}-\d{2}\b/m;
export const MEMORY_DATED_BULLET_RE =
  /^-\s+`?\d{4}-\d{2}-\d{2}`?(?=\s|[:：])/;
export const LEGACY_MEMORY_GUIDANCE = new Set([
  MEMORY_GUIDANCE_IN_MEMORY_V1,
  "按日期记录真实业务任务和用户补充语境：用户怎么称呼任务对象、最终定位到哪个项目/目录、做了什么、遗留了什么，供后续会话回答“上次做到哪”和“用户这样说时该去哪里”。例行图谱刷新不作为主要记忆。",
  "按日期记录已完成的重要动作：做了什么、动了哪些事实源、遗留了什么，供后续会话回答“上次做到哪”。",
  "记录这个工作区内重要的已完成操作，便于后续回忆。",
  "Records important completed operations in this workspace for later recall.",
]);

export const MEMORY_CONSUMPTION_STEP =
  "命中时间指称（“昨天/前天/上周/前几天/那次”等）时，先换算为具体日期，"
  + "再打开 [.workspace/memory/daily/](.workspace/memory/daily/) 下对应日期的文件（无文件则看相邻日期），"
  + "按行内 `repo:` / `workspace` 对象标签定位；需要语境时再按 scope 和任务关键词定位并读取"
  + " [MEMORY.md](MEMORY.md) 对应小节，代码细节用 git 兜底。"
  + "只有用户提到“上次/继续/之前”、任务明确续接未完成工作、需要恢复用户偏好/纠正/确认取舍/用户操作，"
  + "或对象称呼仍有歧义时，才按上述 scope 路径读取 `MEMORY.md` 对应小节；"
  + "不要默认读取整个 `MEMORY.md` 或整个 `.workspace/memory/daily/` 目录。";

export const MEMORY_AUTHORITY_LINE =
  "- `MEMORY.md`: 按需读取的非权威上下文，仅作历史线索；不能覆盖当前用户指令、当前代码/配置、"
  + "git/CI 或 `.workspace/` 事实源，也不授权重复执行历史外部操作；再次依赖前先核验当前状态。";

export const MEMORY_BOUNDARY_LINES = [
  "- `MEMORY.md` 与 `.workspace/memory/daily/` 分工：`.workspace/memory/daily/YYYY-MM-DD.md` 承载与某个日期、阶段、当前任务或短期接续相关的有价值信息；`MEMORY.md` 承载会持续影响工作空间或仓库后续行为的长期结论，如用户偏好、纠正、用户完成的外部操作、确认取舍和长期接续约束。",
  "- 收尾时不直接转写本轮事件，先提炼为后续可复用的结论、约束、理由、线索或接续状态；是否写入只有一个判断条件：这条信息对后续工作有没有价值。能否从代码、git/PR/CI、任务系统或图谱事实源恢复，不参与是否写入的判断，只在消费时用于事实核验。",
  "- 价值判断通过后再选择承载层；没有价值就不写，不为满足流程强行创建条目。daily 每条以 `repo:<repo>` 或 `workspace` 对象标签开头，` — ` 分隔后保持单行；一天一个文件，先提炼、全保留、不压缩。",
  "- `MEMORY.md` 按 `## workspace` / `## repo:<repo>` 分节；具体任务嵌套 `### task:<task-key>`。每条使用 `- <日期> [偏好|纠正|用户操作|确认决策|接续] 来源：…；结论：…`。agent 推断不得伪装成用户确认。",
  "- 改动文件清单、完成摘要、测试结果、精确数量或例行 `scan/init/validate` 不因本轮发生过就自动成为记忆；只有先提炼出对后续工作有价值的信息才记录。用户更正后删除、压缩或明确替代旧结论。",
  "- 稳定对象映射、仓库入口、命令、业务事实和跨仓关系应晋升到 `.workspace/metadata.yaml` 或 `.workspace/repos/**`；记忆只保留对后续工作有独立价值的提炼信息。",
  "- 记忆写入与消费规则只放在 `AGENTS.md`；`MEMORY.md` 和 daily 文件只放实际记录，无条目时 `MEMORY.md` 仅保留标题和占位，不复制本节协议。",
];

export const WRAP_UP_REVIEW_LINES = [
  "- 交付结论前必须完成记忆评估：1） 从本轮对话、决策和实施结果中提取候选信息；"
    + "2） 不直接复制事件摘要，先提炼为后续可复用的结论、约束、理由、线索或接续状态；"
    + "3） 只以“这条信息对后续工作有没有价值”判断是否写入；"
    + "4） 有价值时再按作用范围和有效期选择 daily 或 `MEMORY.md`，没有价值就不写；"
    + "5） 评估结论为“无该记内容”时显式说明一句，不强行编造。",
  "- 评估不询问用户：毫无争议该记的内容直接记，无需陈述；有争议或可商榷的内容直接说明记了什么/没记什么及理由，不抛给用户决定。向用户确认“要不要记/记哪条”属于干扰。",
  "- 记忆发生变化时在最终答复中通知用户，只概括重点、不复述完整条目：daily 使用“记忆已新增：<重点>”或“记忆已更新：<重点>”；`MEMORY.md` 使用“工作空间全局记忆已新增：<重点>”或“工作空间全局记忆已更新：<重点>”。daily 与 `MEMORY.md` 同时变化时分别通知。",
];

export const DAILY_AUTHORITY_LINE =
  "- `.workspace/memory/daily/`: 按天的短期价值记录，用于时间锚点回溯；"
  + "不证明当前状态，再次依赖前先核验。";

export const SOURCE_AUTHORITY_LINES = [
  "- 当前用户指令，以及当前代码、配置、外部实时状态、git/PR/CI 证据：最高权威。",
  "- `AGENTS.md`: 生成的根路由、消费门禁与维护规则，不是持久事实源。",
  "- `.workspace/metadata.yaml`: 工作区级持久事实源。",
  "- `.workspace/relations/registry.yaml`: 由声明和扫描编译出的跨仓关系视图，不要手改。",
  "- `.workspace/repos/<repo>/index.md`: 仓库级事实源。",
  "- `.workspace/repos/<repo>/domains/*.md`: 业务域事实源。",
  "- `.workspace/repos/<repo>/shared/*.md`: 共享或平台机制事实源。",
  MEMORY_AUTHORITY_LINE,
  DAILY_AUTHORITY_LINE,
  "- `.workspace/state/discovery.json`: 自动扫描快照，只用于排障或审计。",
];

function splitLines(content: string): string[] {
  const lines = content.split(/\r\n|\n|\r/);
  if (/[\r\n]$/.test(content)) {
    lines.pop();
  }
  return lines;
}

export function renderBootstrapAgents(workspaceName: string): string {
  return [
    `# ${workspaceName} Agent 入口`,
    "",
    "## 阅读顺序",
    "",
    "1. 先读本文件，确认根路由和权威顺序。",
    "2. 阅读 [.workspace/metadata.yaml](.workspace/metadata.yaml) 和 [.workspace/index.md](.workspace/index.md)。",
    `3. ${MEMORY_CONSUMPTION_STEP}`,
    "4. 初始化后扫描仓库、补齐第一批事实源，再生成可用图谱。",
    "",
    "## 权威顺序",
    "",
    ...SOURCE_AUTHORITY_LINES,
    "",
    "## 记忆边界",
    "",
    ...MEMORY_BOUNDARY_LINES,
    "- 用户首次提供的稳定对象称呼、项目归属和目录映射，要补进任务路由、仓库 index、业务域或共享文档；无法消歧或缺少证据时不要硬写，先标为阻断或待用户确认。",
    "",
    "## 收尾记忆评估",
    "",
    ...WRAP_UP_REVIEW_LINES,
    "",
    "## 多仓关联维护",
    "",
    "- `AGENTS.md` 只存放每个工作区入口都必须消费的阅读顺序、路由、权威顺序和维护原则；不要放具体仓库细节。",
    "- 任务发现稳定可复用的单仓事实，或首次从用户说法补全任务对象到项目/目录的映射时，写入 `.workspace/repos/<repo>/index.md`、`domains/` 或 `shared/`。",
    "- 任务发现稳定可复用的多仓关系、契约面、双侧证据、任务路由或仓库边界时，写入 `.workspace/metadata.yaml`，再运行 `init` + `validate`。",
    "- 多仓事实要说明方向、连接机制、契约面和关键证据。不要存放完整接口清单、字段级契约、临时排障记录或低密度目录盘点。",
    "",
    "## 任务路由",
    "",
    "- TODO: 基于仓库扫描结果补充稳定任务路由。",
    "",
    "## 约束",
    "",
    "- 根入口文档只保留 `AGENTS.md`。",
    "- `CLAUDE.md` 必须严格只有一行：`@AGENTS.md`。",
    "- 图谱是持续维护的资产。初始化创建可用入口；后续任务补充稳定事实并重新运行 `init` + `validate`。",
    "- `AGENTS.md` 是生成产物。要修改路由、关系或仓库顺序，先改 `.workspace/metadata.yaml`，再重新运行 `init`。",
  ].join("\n");
}

export function renderBootstrapMemory(): string {
  return ["# 工作区记忆", "", "## workspace", "", MEMORY_PLACEHOLDER].join("\n");
}

export function normalizeMemoryDocument(content: string): string {
  const lines = splitLines(content);
  let changed = false;
  let inPreamble = true;
  for (let index = 0; index < lines.length; index += 1) {
    const stripped = lines[index]!.trim();
    if (stripped.startsWith("## ") || MEMORY_DATED_BULLET_RE.test(stripped)) {
      inPreamble = false;
    }
    if (!inPreamble) {
      continue;
    }
    if (LEGACY_MEMORY_GUIDANCE.has(stripped)) {
      lines[index] = "";
      changed = true;
    } else if (
      MEMORY_PLACEHOLDERS.has(stripped)
      && stripped !== MEMORY_PLACEHOLDER
    ) {
      lines[index] = MEMORY_PLACEHOLDER;
      changed = true;
    }
  }
  if (!changed) {
    return content;
  }
  const suffix = /[\r\n]$/.test(content) ? "\n" : "";
  const normalized = lines.join("\n").replace(/\n{3,}/g, "\n\n");
  return normalized.trimEnd() + suffix;
}

export function memoryCandidateLines(content: string): string[] {
  const candidates: string[] = [];
  let parentScope: string | null = null;
  let currentScope: string | null = null;
  for (const rawLine of splitLines(content)) {
    const line = rawLine.trim();
    if (line.startsWith("## ")) {
      const scopeMatch = MEMORY_SCOPE_HEADING_RE.exec(line);
      parentScope = scopeMatch ? line.slice(3).trim() : null;
      currentScope = parentScope;
      continue;
    }
    if (line.startsWith("### ")) {
      const taskMatch = MEMORY_TASK_HEADING_RE.exec(line);
      currentScope =
        taskMatch && parentScope !== null
          ? `${parentScope}/task:${taskMatch[1]}`
          : null;
      continue;
    }
    if (
      !line.startsWith("-")
      || MEMORY_PLACEHOLDERS.has(line)
    ) {
      continue;
    }
    if (currentScope !== null || MEMORY_DATED_BULLET_RE.test(line)) {
      candidates.push(line);
    }
  }
  return candidates;
}

export function stripMemoryPlaceholder(content: string): string {
  if (![...MEMORY_PLACEHOLDERS].some((placeholder) => content.includes(placeholder))) {
    return content;
  }
  const hasSubstance =
    memoryCandidateLines(content).length > 0
    || MEMORY_LEGACY_HEADING_RE.test(content);
  if (!hasSubstance) {
    return content;
  }
  const kept = splitLines(content).filter(
    (line) => !MEMORY_PLACEHOLDERS.has(line.trim()),
  );
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

export function renderBootstrapWorkspaceIndex(): string {
  return [
    "# 工作区拓扑",
    "",
    "- 当前只初始化了骨架。",
    "- 下一步扫描同级仓库、补齐第一批事实源，然后重新渲染可用图谱。",
  ].join("\n");
}

export function renderBootstrapRelationIndex(): string {
  return [
    "# 工作区关系",
    "",
    "- 当前只初始化了骨架。关系摘要等待 agent 研究后补充。",
  ].join("\n");
}

export function renderClaude(): string {
  return "@AGENTS.md";
}

export function hasSuppressedRelations(config: JsonObject): boolean {
  return Boolean(config.suppressed_relations?.length || config.suppressed_relation_types?.length);
}

export function renderSuppressionNotes(config: JsonObject): string[] {
  const notes: string[] = [];
  for (const relation of config.suppressed_relations ?? []) {
    if (["from", "to", "type"].every((key) => key in relation)) {
      notes.push(`- \`${relation.from} -> ${relation.to}\` (\`${relation.type}\`)`);
    }
  }
  for (const relationType of config.suppressed_relation_types ?? []) {
    notes.push(`- 类型 \`${relationType}\``);
  }
  return notes;
}

export function renderAgents(
  workspace: string,
  config: JsonObject,
  discovery: JsonObject,
): string {
  void workspace;
  void discovery;
  const taskRoutes = config.workspace.task_routes ?? [];
  const routeLines: string[] = [];
  for (const route of taskRoutes) {
    const reads = (route.read ?? [])
      .map((item: string) => `[${item}](${item})`)
      .join(", ");
    const when = route.when.replace(/[.。]+$/, "");
    let line = `- \`${route.name}\`: ${when}。`;
    if (reads) {
      line += `优先阅读：${reads}`;
    }
    routeLines.push(line);
  }
  const standaloneEntries = normalizeStandaloneRepos(config.standalone_repos ?? []);
  if (standaloneEntries.length > 0) {
    const routedReads = new Set<string>(
      taskRoutes.flatMap((route: JsonObject) => route.read ?? []),
    );
    const unroutedEntries = standaloneEntries.filter(
      (entry) =>
        ![...routedReads].some((read) =>
          read.startsWith(`${REPO_DOCS_PATH}/${entry.repo}/`),
        ),
    );
    if (unroutedEntries.length > 0) {
      const links = unroutedEntries
        .map(
          (entry) =>
            `[${entry.repo}](${REPO_DOCS_PATH}/${entry.repo}/index.md)`,
        )
        .join(", ");
      routeLines.push(
        `- \`独立仓库\`: 涉及 ${links} 这类独立交付仓库时，直接阅读对应 index.md`
          + "（没有已知核心链路依赖，不属于跨仓集成）。",
      );
    }
  }
  if (routeLines.length === 0) {
    routeLines.push("- `待补充`: 在 `.workspace/metadata.yaml` 的 `task_routes` 下补充稳定路由。");
  }
  const constraintLines = [
    "- 根入口只保留 `AGENTS.md`；不要维护 `WORKSPACE.md`。",
    "- 跨仓关系保持仓库级粒度；更深细节放到 `.workspace/repos/` 下。",
    "- 没有依赖证据的仓库放入 `.workspace/metadata.yaml` 的 `standalone_repos`；不要用弱 peer 关系代替。",
    "- 图谱是持续维护的资产。搜索、调试或集成工作发现稳定可复用事实时，修补最小且正确的事实源，并重新运行 `init` + `validate`。",
  ];
  if (hasSuppressedRelations(config)) {
    constraintLines.push(
      "- 部分自动检测关系会通过 `.workspace/metadata.yaml` 的 `suppressed_relations` / `suppressed_relation_types` 过滤；说明见 `.workspace/relations/index.md`。",
    );
  }
  constraintLines.push(
    "- `AGENTS.md` 是生成产物。要修改路由、关系或仓库顺序，先改 `.workspace/metadata.yaml`，再重新运行 `init`。",
  );
  return [
    `# ${config.workspace.name} Agent 入口`,
    "",
    "## 阅读顺序",
    "",
    "1. 先读本文件，确认根路由、任务路由和权威顺序。",
    "2. 命中下方任务路由后，直接阅读对应的 `.workspace/repos/<repo>/index.md`。",
    `3. ${MEMORY_CONSUMPTION_STEP}`,
    "4. 处理跨仓关系时，先读 [.workspace/relations/index.md](.workspace/relations/index.md)。做全局拓扑或结构化审计时，再读 [.workspace/index.md](.workspace/index.md) 和 [.workspace/relations/registry.yaml](.workspace/relations/registry.yaml)。",
    "",
    "## 权威顺序",
    "",
    ...SOURCE_AUTHORITY_LINES,
    "",
    "## 记忆边界",
    "",
    ...MEMORY_BOUNDARY_LINES,
    "- 用户首次提供的稳定对象称呼、项目归属和目录映射，要补进任务路由、仓库 index、业务域或共享文档；无法消歧或缺少证据时不要硬写，先标为阻断或待用户确认。",
    "",
    "## 收尾记忆评估",
    "",
    ...WRAP_UP_REVIEW_LINES,
    "",
    "## 多仓关联维护",
    "",
    "- `AGENTS.md` 只存放每个工作区入口都必须消费的阅读顺序、路由、权威顺序和维护原则；不要放具体仓库细节。",
    "- 任务发现稳定可复用的单仓事实，或首次从用户说法补全任务对象到项目/目录的映射时，写入 `.workspace/repos/<repo>/index.md`、`domains/` 或 `shared/`。",
    "- 任务发现稳定可复用的多仓关系、契约面、双侧证据、任务路由或仓库边界时，写入 `.workspace/metadata.yaml`，再运行 `init` + `validate`。",
    "- 多仓事实要说明方向、连接机制、契约面和关键证据。不要存放完整接口清单、字段级契约、临时排障记录或低密度目录盘点。",
    "",
    "## 任务路由",
    "",
    ...routeLines,
    "",
    "## 约束",
    "",
    ...constraintLines,
  ].join("\n");
}

export function renderStandaloneRepoSection(
  workspace: string,
  docAbs: string,
  config: JsonObject,
): string[] {
  const entries = normalizeStandaloneRepos(config.standalone_repos ?? []);
  if (entries.length === 0) {
    return [];
  }
  const lines = [
    "",
    "## 独立仓库",
    "",
    "这些仓库不在 `relations` 边集合中。只有找到具体依赖、调用或共享制品证据后，才升级为关系边。",
    "",
    "| 仓库 | 边界 | 证据 |",
    "| --- | --- | --- |",
  ];
  for (const entry of entries) {
    const repo = entry.repo;
    const repoDoc = join(workspace, REPO_DOCS_PATH, repo, "index.md");
    const repoCell = existsSync(repoDoc)
      ? `[${repo}](${relLink(docAbs, repoDoc)})`
      : `\`${repo}\``;
    const boundary = entry.reason || entry.summary || "声明为独立仓库。";
    const evidence = renderEvidenceList(entry.evidence ?? [], docAbs, workspace);
    lines.push(`| ${repoCell} | ${escapeCell(boundary)} | ${evidence} |`);
  }
  return lines;
}

export function renderWorkspaceIndex(
  workspace: string,
  config: JsonObject,
  repoModels: Record<string, JsonObject>,
  discovery: JsonObject,
): string {
  const byName = repoMap(discovery);
  const workspaceIndexAbs = join(workspace, WORKSPACE_INDEX_PATH);
  const lines = [
    "# 工作区拓扑",
    "",
    "## 概览",
    "",
    `- 名称：\`${config.workspace.name}\``,
    `- 定位：${config.workspace.positioning ?? ""}`,
    `- 自动扫描时间：\`${discovery.generated_at}\``,
    "",
    "## 仓库矩阵",
    "",
    "| 仓库 | 类别 | 读者 | 职责 | 入口 |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const repoName of config.workspace.repo_order ?? []) {
    const repoModel = repoModels[repoName] ?? {};
    const repoScan = byName[repoName] ?? {};
    const repoDoc = `${REPO_DOCS_PATH}/${repoName}/index.md`;
    const repoDocAbs = join(workspace, repoDoc);
    const entry =
      (repoModel.primary_entry_paths ?? [])
        .slice(0, 3)
        .map((item: string) => `\`${item}\``)
        .join(", ")
      || "-";
    lines.push(
      `| [${repoName}](${relLink(workspaceIndexAbs, repoDocAbs)}) | ${renderCategoryCell(repoModel.category ?? repoScan.detected_kind ?? "unknown")} | `
        + `${escapeCell(repoModel.audience ?? "unknown")} | ${escapeCell(repoModel.role ?? "")} | ${entry} |`,
    );
  }
  lines.push(...renderStandaloneRepoSection(workspace, workspaceIndexAbs, config));
  lines.push(
    "",
    "## 关系和审计入口",
    "",
    `- 工作区级事实源：[.workspace/metadata.yaml](${relLink(workspaceIndexAbs, join(workspace, CONFIG_PATH))})`,
    `- 派生关系视图，不要手改：[${RELATION_REGISTRY_PATH}](${relLink(workspaceIndexAbs, join(workspace, RELATION_REGISTRY_PATH))})`,
    `- 可读关系摘要：[${RELATION_INDEX_PATH}](${relLink(workspaceIndexAbs, join(workspace, RELATION_INDEX_PATH))})`,
    `- 自动扫描快照：[${DISCOVERY_PATH}](${relLink(workspaceIndexAbs, join(workspace, DISCOVERY_PATH))})，只用于排障或审计。`,
  );
  return lines.join("\n");
}

export function renderRelationRegistry(
  config: JsonObject,
  discovery: JsonObject,
  relations: JsonObject[],
): JsonObject {
  return {
    generated_at: discovery.generated_at,
    workspace: config.workspace.name,
    repo_order: config.workspace.repo_order ?? [],
    relations,
    standalone_repos: normalizeStandaloneRepos(config.standalone_repos ?? []),
  };
}

export function renderRelationIndex(
  relations: JsonObject[],
  standaloneRepos: JsonObject[] | null = null,
  config: JsonObject | null = null,
): string {
  const grouped = new Map<string, JsonObject[]>();
  for (const relation of relations) {
    if (!grouped.has(relation.type)) {
      grouped.set(relation.type, []);
    }
    grouped.get(relation.type)!.push(relation);
  }
  const lines = [
    "# 工作区关系",
    "",
    "结构化权威源是 `registry.yaml`；本页是可读摘要。",
    "",
  ];
  for (const relationType of [...grouped.keys()].sort()) {
    lines.push(`## ${relationType}`, "");
    for (const relation of grouped.get(relationType)!) {
      const arrow = relation.direction === "peer" ? "<->" : "->";
      lines.push(
        `- \`${relation.from}\` ${arrow} \`${relation.to}\`: ${relation.summary ?? ""}`,
      );
    }
    lines.push("");
  }
  const standaloneEntries = normalizeStandaloneRepos(standaloneRepos ?? []);
  if (standaloneEntries.length > 0) {
    lines.push(
      "## 独立仓库",
      "",
      "以下仓库声明为没有仓库级依赖边。不要只因为类别相似就改成 peer 关系。"
        + "边界详情和证据在 [.workspace/index.md](../index.md) 的独立仓库表中。",
      "",
    );
    for (const entry of standaloneEntries) {
      const brief = entry.summary || entry.reason || "声明为独立仓库。";
      lines.push(`- \`${entry.repo}\`: ${brief}`);
    }
    lines.push("");
  }
  if (config && hasSuppressedRelations(config)) {
    lines.push(
      "## 抑制说明",
      "",
      "以下自动检测关系通过 `.workspace/metadata.yaml` 的 `suppressed_relations` / `suppressed_relation_types` 过滤，未进入当前关系图。",
      "",
    );
    const notes = renderSuppressionNotes(config);
    lines.push(...(notes.length > 0 ? notes : ["- 已配置抑制规则。"]), "");
  }
  return lines.join("\n");
}

export function bootstrapWorkspace(workspace: string): void {
  const filesToWrite = new Map<string, string>([
    ["AGENTS.md", renderBootstrapAgents(basename(workspace))],
    ["CLAUDE.md", renderClaude()],
    ["MEMORY.md", renderBootstrapMemory()],
    [CONFIG_PATH, JSON.stringify(bootstrapConfig(basename(workspace)), null, 2)],
    [WORKSPACE_INDEX_PATH, renderBootstrapWorkspaceIndex()],
    [DISCOVERY_PATH, JSON.stringify(bootstrapDiscovery(workspace), null, 2)],
    [
      RELATION_REGISTRY_PATH,
      JSON.stringify(bootstrapRelationRegistry(basename(workspace)), null, 2),
    ],
    [RELATION_INDEX_PATH, renderBootstrapRelationIndex()],
  ]);
  for (const [relativePath, content] of filesToWrite) {
    const absolutePath = join(workspace, relativePath);
    if (!existsSync(absolutePath)) {
      writeText(absolutePath, content);
    }
  }
  mkdirSync(join(workspace, REPO_DOCS_PATH), { recursive: true });
  ensureMemoryDailyDir(workspace);
}
