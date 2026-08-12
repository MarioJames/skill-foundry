#!/usr/bin/env bun

import { existsSync, statSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";

import {
  IGNORED_DIRS,
  MEMORY_DAILY_PATH,
  REPO_DOCS_PATH,
  extractMarkdownLinkPairs,
  extractMarkdownLinks,
  isDirectory,
  isExternalLink,
  readText,
  sortedDirectory,
  stripAnchor,
  toPosix,
  walkFiles,
  type JsonObject,
} from "./core.ts";
import {
  TABLE_CELL_SPLIT,
  firstParagraph,
  markdownSection,
  parseOperationRows,
  rawTableValue,
  tableValue,
} from "./mdparse.ts";
import { normalizeStandaloneRepos } from "./relations.ts";
import {
  LEGACY_MEMORY_GUIDANCE,
  MEMORY_DATED_BULLET_RE,
  MEMORY_PLACEHOLDERS,
  MEMORY_SCOPE_HEADING_RE,
  MEMORY_TASK_HEADING_RE,
  memoryCandidateLines,
  stripMemoryPlaceholder,
} from "./render_root.ts";

export const AUDIENCE_RELATION_RE =
  /(?:exposes?|consumes?|calls?|invokes?)[^.;|]{0,32}?(?:[Ff]acade|FACADE|RPC|rpc|API|api|client)|(?:暴露|消费|调用|依赖)[^。；|]{0,32}?(?:facade|Facade|FACADE|RPC|rpc|API|api|门面|客户端)/;
export const LITERAL_COUNT_RE =
  /\d+\s*(?:items?|controllers?|packages?|modules?|pages?|files?|people|reviewers?|owners?|entries?)|\d+\s*(?:个|项|条|人|名)?\s*(?:控制器|接口|页面|模块|包|评审人|评审者|负责人|文件|条目)/i;
export const LINE_CITATION_RE =
  /\blines?\s+\d+(?:\s*[-~]\s*\d+)?|第?\s*\d+(?:\s*[-~]\s*\d+)?\s*行/i;
export const UNRESOLVED_PROBE_RE =
  /not confirmed in this read|needs? manual follow[- ]?up|not yet read|need to check|本次未确认|待人工跟进|尚未阅读|需要核实|需确认/i;
export const FILE_LABEL_RE =
  /[\w@./\-]+\.(?:java|kt|ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|sh|md|json|xml|yaml|yml|toml|properties|sql|less|css|scss|html|vue)/;
export const MEMORY_ENTRY_RE =
  /^-\s+`?\d{4}-\d{2}-\d{2}`?\s+`?\[(?:偏好|纠正|用户操作|确认决策|接续|preference|correction|user[_ -]?action|confirmed[_ -]?decision|handoff)\]`?\s+\S/i;
export const MEMORY_NEGATED_ROUTINE_RE =
  /(?:不要|不再|无需|禁止|避免|停止|勿)|(?:do\s+not|don't|never|avoid|stop)\b/i;
export const MEMORY_ROUTINE_GRAPH_RE =
  /(?:初始化|刷新|重建).{0,24}(?:工作区)?(?:知识图谱|图谱)|(?:initialize|initialized|refresh|refreshed|rebuild).{0,24}(?:workspace\s+)?knowledge\s+graph|\b(?:bootstrap|scan|init|validate)(?:\s*\/\s*(?:bootstrap|scan|init|validate)){2,}\b/i;
export const DAILY_FILENAME_RE = /^\d{4}-\d{2}-\d{2}\.md$/;
export const DAILY_ENTRY_RE = /^-\s+(?:repo:\S+|workspace)\s+—\s+\S/;

function markdownFiles(path: string): string[] {
  if (!existsSync(path)) {
    return [];
  }
  return sortedDirectory(path)
    .filter((entry) => entry.name.endsWith(".md"))
    .map((entry) => join(path, entry.name));
}

function recursiveMarkdownFiles(path: string): string[] {
  if (!existsSync(path)) {
    return [];
  }
  return [...walkFiles(path)].filter((item) => extname(item) === ".md").sort();
}

export function dailyFileWarnings(workspace: string): string[] {
  const dailyDir = join(workspace, MEMORY_DAILY_PATH);
  if (!isDirectory(dailyDir)) {
    return [
      `缺少 ${MEMORY_DAILY_PATH} 目录。请重跑 init 创建 daily 短期价值层；`
        + "对后续工作有价值的短期信息写在那里。",
    ];
  }
  const warnings: string[] = [];
  const badNames = markdownFiles(dailyDir)
    .map((path) => basename(path))
    .filter((name) => !DAILY_FILENAME_RE.test(name))
    .sort();
  if (badNames.length > 0) {
    warnings.push(
      `${MEMORY_DAILY_PATH} 下文件名必须是 YYYY-MM-DD.md：${badNames.join(", ")}。`
        + "一天一个文件按日期命名，时间指称查询才能直接定位。",
    );
  }
  for (const path of markdownFiles(dailyDir)) {
    if (!DAILY_FILENAME_RE.test(basename(path))) {
      continue;
    }
    const badLines = readText(path)
      .split(/\r?\n/)
      .flatMap((line, index) =>
        line.trim()
        && !line.startsWith("# ")
        && !DAILY_ENTRY_RE.test(line.trim())
          ? [String(index + 1)]
          : [],
      );
    if (badLines.length > 0) {
      warnings.push(
        `${MEMORY_DAILY_PATH}/${basename(path)} 有非标准条目行`
          + `（行 ${badLines.slice(0, 5).join(", ")}）。每条应是单行：`
          + "`- repo:<repo> — …` 或 `- workspace — …`，标题行除外。",
      );
    }
  }
  return warnings;
}

export function docBodyFirstLine(lines: string[]): string {
  let start = 0;
  if (lines.length > 0 && lines[0]!.trim() === "---") {
    for (let index = 1; index < lines.length; index += 1) {
      if (lines[index]!.trim() === "---") {
        start = index + 1;
        break;
      }
    }
  }
  for (const line of lines.slice(start)) {
    const stripped = line.trim();
    if (stripped) {
      return stripped;
    }
  }
  return "";
}

export function declarationSummaryWarnings(config: JsonObject): string[] {
  const warnings: string[] = [];
  const declaredRelations = config.relations ?? [];
  if (Array.isArray(declaredRelations)) {
    for (const relation of declaredRelations) {
      if (
        relation === null
        || typeof relation !== "object"
        || Array.isArray(relation)
      ) {
        continue;
      }
      const summary = relation.summary ?? "";
      const match = typeof summary === "string" ? LITERAL_COUNT_RE.exec(summary) : null;
      if (match) {
        warnings.push(
          `关系 ${relation.from} -> ${relation.to} 的摘要`
            + `包含字面数量（\`${match[0]}\`）。声明摘要请保持定性；`
            + "需要精确数量时指向目录或 discovery 快照。",
        );
      }
    }
  }
  for (const entry of normalizeStandaloneRepos(config.standalone_repos ?? [])) {
    for (const field of ["summary", "reason"]) {
      const value = entry[field] ?? "";
      const match = typeof value === "string" ? LITERAL_COUNT_RE.exec(value) : null;
      if (match) {
        warnings.push(
          `独立仓库 ${entry.repo} 的 ${field} 包含字面数量`
            + `（\`${match[0]}\`）。声明摘要请保持定性；需要精确数量时`
            + "指向目录或 discovery 快照。",
        );
      }
    }
  }
  return warnings;
}

export function memoryPlaceholderWarnings(workspace: string): string[] {
  const memoryPath = join(workspace, "MEMORY.md");
  if (!existsSync(memoryPath)) {
    return [];
  }
  const memoryContent = readText(memoryPath);
  if (
    [...MEMORY_PLACEHOLDERS].some((placeholder) =>
      memoryContent.includes(placeholder),
    )
    && stripMemoryPlaceholder(memoryContent) !== memoryContent
  ) {
    return [
      "MEMORY.md 的 bootstrap 占位与有效记忆条目共存。"
        + "添加第一条记录时删除占位，或重跑 init 收敛它。",
    ];
  }
  return [];
}

export function memoryQualityWarnings(
  workspace: string,
  config: JsonObject,
): string[] {
  const memoryPath = join(workspace, "MEMORY.md");
  if (!existsSync(memoryPath)) {
    return [];
  }
  const content = readText(memoryPath);
  const candidateLines = memoryCandidateLines(content);
  const warnings: string[] = [];
  if (
    content
      .split(/\r?\n/)
      .some((line) => LEGACY_MEMORY_GUIDANCE.has(line.trim()))
  ) {
    warnings.push(
      "MEMORY.md 重复了记忆协议；写入规则应放在 AGENTS.md 的记忆边界，"
        + "MEMORY.md 只保留实际条目或空占位。请运行 init 自动迁移。",
    );
  }
  const invalidScopes: string[] = [];
  const unscopedEntries: string[] = [];
  const malformedEntries: string[] = [];
  const emptyFieldEntries: string[] = [];
  const continuationLines: string[] = [];
  const unknownRepos = new Set<string>();
  const duplicateScopes = new Set<string>();
  const seenScopes = new Set<string>();
  const seenTasks = new Set<string>();
  let parentScope: string | null = null;
  let currentScope: string | null = null;
  const knownRepos = new Set<string>(config.workspace?.repo_order ?? []);
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("## ")) {
      const match = MEMORY_SCOPE_HEADING_RE.exec(line);
      if (!match) {
        invalidScopes.push(line);
        parentScope = null;
        currentScope = null;
        continue;
      }
      parentScope = line.slice(3).trim();
      currentScope = parentScope;
      if (seenScopes.has(parentScope)) {
        duplicateScopes.add(parentScope);
      }
      seenScopes.add(parentScope);
      const repoName = match[1];
      if (repoName && !knownRepos.has(repoName)) {
        unknownRepos.add(repoName);
      }
      continue;
    }
    if (line.startsWith("### ")) {
      const taskMatch = MEMORY_TASK_HEADING_RE.exec(line);
      if (!taskMatch || parentScope === null) {
        invalidScopes.push(line);
        currentScope = null;
        continue;
      }
      currentScope = `${parentScope}/task:${taskMatch[1]}`;
      if (seenTasks.has(currentScope)) {
        duplicateScopes.add(currentScope);
      }
      seenTasks.add(currentScope);
      continue;
    }
    if (currentScope !== null && line && !line.startsWith("-")) {
      continuationLines.push(line);
      continue;
    }
    if (!line.startsWith("-") || MEMORY_PLACEHOLDERS.has(line)) {
      continue;
    }
    if (currentScope === null) {
      if (MEMORY_DATED_BULLET_RE.test(line)) {
        unscopedEntries.push(line);
      } else {
        continue;
      }
    }
    if (
      !MEMORY_ENTRY_RE.test(line)
      || !/(?:来源|source)\s*[:：]/i.test(line)
      || !/(?:结论|conclusion)\s*[:：]/i.test(line)
    ) {
      malformedEntries.push(line);
      continue;
    }
    const sourceMatch = /(?:来源|source)\s*[:：]\s*([^；;\n]*)/i.exec(line);
    const conclusionMatch =
      /(?:结论|conclusion)\s*[:：]\s*([^；;\n]*)/i.exec(line);
    const sourceValue = sourceMatch?.[1] ?? "";
    const conclusionValue = conclusionMatch?.[1] ?? "";
    const stripNoise = (value: string): string =>
      value.replace(/[\s。.!！?？]+/g, "");
    if (!stripNoise(sourceValue) || !stripNoise(conclusionValue)) {
      emptyFieldEntries.push(line);
    }
  }
  if (invalidScopes.length > 0 || unscopedEntries.length > 0) {
    const examples = [...invalidScopes.slice(0, 2), ...unscopedEntries.slice(0, 1)];
    const compactExamples = examples.map((item) =>
      item.length <= 120 ? item : item.slice(0, 117).trimEnd() + "...",
    );
    const detail = compactExamples.map((item) => `\`${item}\``).join("、");
    const suffix = detail ? `，例如 ${detail}` : "";
    warnings.push(
      "MEMORY.md 存在旧式或未分层条目，缺少有效 scope 分节"
        + `${suffix}。请使用 \`## workspace\` / \`## repo:<repo>\`，`
        + "具体任务嵌套 `### task:<task-key>`。",
    );
  }
  if (malformedEntries.length > 0) {
    warnings.push(
      "MEMORY.md 的记录必须是单行 `- <日期> [类型] 来源：…；结论：…`；"
        + "类型限偏好、纠正、用户操作、确认决策或接续。",
    );
  }
  if (emptyFieldEntries.length > 0) {
    warnings.push(
      "MEMORY.md 条目的来源和结论必须非空；"
        + "请写明可归因来源，以及未来 agent 应采用的当前有效结论。",
    );
  }
  if (continuationLines.length > 0) {
    warnings.push(
      "MEMORY.md 的 scope 内存在跨行正文。每条记忆必须保持单行；"
        + "请把补充语境压缩进同一条 `来源：…；结论：…` 记录。",
    );
  }
  if (unknownRepos.size > 0) {
    const scopes = [...unknownRepos]
      .sort()
      .map((name) => `\`repo:${name}\``)
      .join(", ");
    warnings.push(
      `MEMORY.md 的 repo scope 指向未知仓库：${scopes}。`
        + "请改成 repo_order 中的仓库名，或在跨仓语境下使用 workspace/task scope。",
    );
  }
  if (duplicateScopes.size > 0) {
    const duplicated = [...duplicateScopes]
      .sort()
      .map((scope) => `\`${scope}\``)
      .join(", ");
    warnings.push(
      `MEMORY.md 存在重复 scope/task 分节：${duplicated}。`
        + "请合并同一作用域的记录，避免按需读取遗漏或重复消费。",
    );
  }
  const routineCandidates = [...invalidScopes, ...candidateLines];
  if (
    routineCandidates.some(
      (item) =>
        MEMORY_ROUTINE_GRAPH_RE.test(item)
        && !MEMORY_NEGATED_ROUTINE_RE.test(item),
    )
  ) {
    warnings.push(
      "MEMORY.md 疑似记录例行图谱维护或 scan/init/validate 流水账。"
        + "若内容可由 git、代码、CI 或 `.workspace/` 恢复，请删除；"
        + "只保留无法重建且会影响后续行为的用户语境或接续状态。",
    );
  }
  return warnings;
}

export function repoOrderWarnings(
  config: JsonObject,
  discovery: JsonObject,
): string[] {
  const repoNames = (discovery.repos ?? []).map((repo: JsonObject) => repo.name);
  const declaredOrder = config.workspace?.repo_order ?? [];
  const undeclared = repoNames.filter((name: string) => !declaredOrder.includes(name));
  return undeclared.length > 0
    ? [`自动发现的仓库缺失于 repo_order：${undeclared.join(", ")}`]
    : [];
}

export function taskRouteDensityWarnings(config: JsonObject): string[] {
  const warnings: string[] = [];
  const routes = config.workspace?.task_routes ?? [];
  if (!Array.isArray(routes)) {
    return warnings;
  }
  for (const route of routes) {
    if (
      route === null
      || typeof route !== "object"
      || Array.isArray(route)
    ) {
      continue;
    }
    const reads = route.read ?? [];
    if (!Array.isArray(reads)) {
      continue;
    }
    const deepReads = reads.filter(
      (read) => !String(read).endsWith("/index.md"),
    );
    const isOverloaded =
      deepReads.length >= 3
      || (reads.length > 3 && deepReads.length >= 2);
    if (isOverloaded) {
      warnings.push(
        `任务路由 \`${route.name ?? "?"}\` 预加载了 ${reads.length} 个 read 目标，`
          + `其中 ${deepReads.length} 个是深层文档。`
          + "宽任务应保持 first-hop（通常先读 1-2 个仓库 index），"
          + "只有窄主题才直接指向具体 domain/shared；请压缩或确认这些目标都必读。",
      );
    }
  }
  return warnings;
}

export function orphanRepoDocWarnings(
  workspace: string,
  config: JsonObject,
  discovery: JsonObject,
): string[] {
  const warnings: string[] = [];
  const reposDocsDir = join(workspace, REPO_DOCS_PATH);
  if (!existsSync(reposDocsDir)) {
    return warnings;
  }
  const knownRepos = new Set<string>([
    ...(config.workspace?.repo_order ?? []),
    ...(discovery.repos ?? []).map((repo: JsonObject) => repo.name),
  ]);
  for (const child of sortedDirectory(reposDocsDir)) {
    const childPath = join(reposDocsDir, child.name);
    if (isDirectory(childPath) && !knownRepos.has(child.name)) {
      warnings.push(
        `孤儿仓库文档：${REPO_DOCS_PATH}/${child.name}/ `
          + "不匹配任何扫描到或声明的仓库。若该仓库已删除，请删掉这个文档目录。",
      );
    }
  }
  return warnings;
}

export function repoIndexTableWarnings(
  workspace: string,
  config: JsonObject,
): string[] {
  const warnings: string[] = [];
  for (const repoName of config.workspace?.repo_order ?? []) {
    const indexPath = join(workspace, REPO_DOCS_PATH, repoName, "index.md");
    if (!existsSync(indexPath)) {
      continue;
    }
    const indexContent = readText(indexPath);
    const fencedLines = indexContent
      .split(/\r?\n/)
      .flatMap((line, index) =>
        line.trimStart().startsWith("|") && line.includes("```")
          ? [String(index + 1)]
          : [],
      );
    if (fencedLines.length > 0) {
      warnings.push(
        `仓库 \`${repoName}\` 的 index.md 表格单元格出现 3 个及以上连续反引号`
          + `（行 ${fencedLines.join(", ")}）。行内代码只用单反引号；`
          + "不要把整个字段值包进反引号外壳。",
      );
    }
    const category = rawTableValue(indexContent, "Category");
    if (
      category
      && category.length > 2
      && category.startsWith("`")
      && category.endsWith("`")
      && category.slice(1, -1).includes("`")
    ) {
      warnings.push(
        `仓库 \`${repoName}\` 的 index.md 类别字段被反引号包裹却又含行内反引号。`
          + "GFM 会把它拆成损坏的代码跨度。去掉外层外壳，只保留内部行内代码。",
      );
    }
    const entryValue = rawTableValue(indexContent, "Primary Entries");
    if (entryValue) {
      const repoRoot = join(workspace, repoName);
      const withoutLinks = entryValue.replace(/\[[^\]]*\]\([^)]*\)/g, "");
      const unopenable: string[] = [];
      for (const match of withoutLinks.matchAll(/`([^`]+)`/g)) {
        const item = match[1]!.trim();
        if (!item || item.includes("*")) {
          continue;
        }
        if (!existsSync(join(repoRoot, item))) {
          unopenable.push(item);
        }
      }
      if (unopenable.length > 0) {
        const listed = unopenable.map((item) => `\`${item}\``).join(", ");
        warnings.push(
          `仓库 \`${repoName}\` 的 index.md 主要入口包含无法在仓库内打开的条目`
            + `（${listed}）。主要入口只应列出真实的仓库文件/目录，最好是相对链接。`
            + "命令放常用操作，散文放摘要或业务域文档。",
        );
      }
    }
    const audience = tableValue(indexContent, "Audience");
    if (audience && AUDIENCE_RELATION_RE.test(audience)) {
      warnings.push(
        `仓库 \`${repoName}\` 的 index.md 读者字段看起来在描述跨仓调用关系。`
          + "读者只应描述读者/维护者群体；暴露/消费 facade 的事实属于 `## 关系` 表和 registry.yaml。",
      );
    }
    if (audience) {
      const countMatch = LITERAL_COUNT_RE.exec(audience);
      if (countMatch) {
        warnings.push(
          `仓库 \`${repoName}\` 的 index.md 读者字段包含字面数量`
            + `（\`${countMatch[0]}\`）。团队规模和评审阈值会漂移；`
            + "指向 OWNERS 类文件而不是内联数字。",
        );
      }
    }
    const operationRows = parseOperationRows(
      markdownSection(indexContent.split(/\r?\n/), "Common Operations"),
    );
    const bareEvidence = operationRows
      .map((row) => row.evidence)
      .filter(
        (evidence) =>
          evidence !== "-"
          && !evidence.includes("](")
          && !evidence.includes("`"),
      );
    if (bareEvidence.length > 0) {
      const listed = bareEvidence
        .slice(0, 3)
        .map((item) => `\`${item}\``)
        .join(", ");
      warnings.push(
        `仓库 \`${repoName}\` 的 index.md 常用操作有 ${bareEvidence.length} 个证据`
          + `单元格不是链接、行内代码或 \`-\`（${listed}）。证据应指向可打开的文件。`
          + "若因未转义的 `|` 导致，请修复该行并把单元格内的管道符写成 `\\|`。",
      );
    }
  }
  return warnings;
}

export function nestedDocWarnings(
  workspace: string,
  config: JsonObject,
): string[] {
  const warnings: string[] = [];
  for (const repoName of config.workspace?.repo_order ?? []) {
    for (const folder of ["domains", "shared"]) {
      const docsDir = join(workspace, REPO_DOCS_PATH, repoName, folder);
      if (!existsSync(docsDir)) {
        continue;
      }
      const missingSummary: string[] = [];
      const h1Opening: string[] = [];
      const unresolvedProbe: string[] = [];
      const summaryWithLinks: string[] = [];
      for (const docPath of markdownFiles(docsDir)) {
        const docRel = `${REPO_DOCS_PATH}/${repoName}/${folder}/${basename(docPath)}`;
        if (basename(docPath, ".md") === "index") {
          warnings.push(
            `${docRel} 用 index.md 作为嵌套文档名，容易与目录索引混淆。`
              + "请改成主题化的 kebab-case slug 并重跑 init。",
          );
        }
        const lines = readText(docPath).split(/\r?\n/);
        if (docBodyFirstLine(lines).startsWith("# ")) {
          h1Opening.push(basename(docPath));
        }
        const summary = firstParagraph(markdownSection(lines, "Summary"));
        if (!summary || summary.startsWith("TODO")) {
          missingSummary.push(basename(docPath));
        }
        if (
          extractMarkdownLinks(summary).some(
            (target) =>
              target
              && !isExternalLink(target)
              && !target.startsWith("#"),
          )
        ) {
          summaryWithLinks.push(basename(docPath));
        }
        const judgmentLines = markdownSection(lines, "Human Judgment");
        if (judgmentLines.some((line) => UNRESOLVED_PROBE_RE.test(line))) {
          unresolvedProbe.push(basename(docPath));
        }
      }
      if (unresolvedProbe.length > 0) {
        warnings.push(
          `仓库 \`${repoName}\` 的 ${folder}/ 有 ${unresolvedProbe.length} 篇文档的 `
            + `\`人工判断\` 小节包含未完成的仓库内排查（${unresolvedProbe.join(", ")}）。`
            + "该小节只用于仓库证据无法回答的问题；未决排查应被核实、改写或删除。",
        );
      }
      if (h1Opening.length > 0) {
        warnings.push(
          `仓库 \`${repoName}\` 的 ${folder}/ 有 ${h1Opening.length} 篇文档以 H1 开头`
            + `（${h1Opening.join(", ")}）。嵌套文档应直接以 \`## 摘要\` 开头；文件名就是主题。`,
        );
      }
      if (missingSummary.length > 0) {
        warnings.push(
          `仓库 \`${repoName}\` 的 ${folder}/ 有 ${missingSummary.length} 篇文档缺少可提取的 `
            + `\`## 摘要\` 首段，导致仓库 index 文档表摘要渲染为 \`-\`：${missingSummary.join(", ")}`,
        );
      }
      if (summaryWithLinks.length > 0) {
        warnings.push(
          `仓库 \`${repoName}\` 的 ${folder}/ 有 ${summaryWithLinks.length} 篇文档在 `
            + `\`## 摘要\` 里包含相对链接（${summaryWithLinks.join(", ")}）。摘要是纯文本；`
            + "把路径证据移到后续小节，避免提取后深度断裂。",
        );
      }
    }
    const singular = join(workspace, REPO_DOCS_PATH, repoName, "domain");
    if (existsSync(singular) && markdownFiles(singular).length > 0) {
      warnings.push(
        `仓库 \`${repoName}\` 存在单数 \`domain/\`；渲染器只读 \`domains/\`。`
          + "请改名为 `domains/` 并重跑 init，否则这些业务域文档会被忽略。",
      );
    }
  }
  return warnings;
}

function fileLabelFullMatch(value: string): boolean {
  return new RegExp(`^(?:${FILE_LABEL_RE.source})$`).test(value);
}

export function linkLabelWarnings(
  workspace: string,
  config: JsonObject,
): string[] {
  const warnings: string[] = [];
  for (const repoName of config.workspace?.repo_order ?? []) {
    const repoDocsDir = join(workspace, REPO_DOCS_PATH, repoName);
    if (!existsSync(repoDocsDir)) {
      continue;
    }
    const pathLabelHits = new Map<string, number>();
    const fileLabelHits = new Map<string, number>();
    for (const docPath of recursiveMarkdownFiles(repoDocsDir)) {
      const docName = toPosix(relative(repoDocsDir, docPath));
      for (const [label, rawTarget] of extractMarkdownLinkPairs(readText(docPath))) {
        const target = stripAnchor(rawTarget).trim();
        if (!target || target.startsWith("#") || isExternalLink(target)) {
          continue;
        }
        const cleanLabel = label
          .trim()
          .replace(/^`+|`+$/g, "")
          .trim();
        if (cleanLabel.startsWith("./") || cleanLabel.startsWith("../")) {
          pathLabelHits.set(docName, (pathLabelHits.get(docName) ?? 0) + 1);
          continue;
        }
        if (cleanLabel.includes("*")) {
          continue;
        }
        if (
          fileLabelFullMatch(cleanLabel)
          && basename(target.replace(/\/+$/, "")) !== basename(cleanLabel)
        ) {
          fileLabelHits.set(docName, (fileLabelHits.get(docName) ?? 0) + 1);
        }
      }
    }
    if (pathLabelHits.size > 0) {
      const total = [...pathLabelHits.values()].reduce((sum, value) => sum + value, 0);
      warnings.push(
        `仓库 \`${repoName}\` 的文档有 ${total} 处路径式链接标签`
          + `（${[...pathLabelHits.keys()].sort().join(", ")}）。以 \`./\` 或 \`../\` 开头的标签难读且不便复制；`
          + "用文件名或仓库相对标签，让 href 承载路径深度。",
      );
    }
    if (fileLabelHits.size > 0) {
      const total = [...fileLabelHits.values()].reduce((sum, value) => sum + value, 0);
      warnings.push(
        `仓库 \`${repoName}\` 的文档有 ${total} 处文件名标签指向了不同路径`
          + `（${[...fileLabelHits.keys()].sort().join(", ")}）。若标签是文件名，href 应直接指向该文件，`
          + "而不是目录或另一个文件。",
      );
    }
  }
  return warnings;
}

export function splitTableCells(strippedLine: string): string[] {
  let inner = strippedLine;
  if (inner.startsWith("|")) {
    inner = inner.slice(1);
  }
  inner = inner.replace(/(?<!\\)\|\s*$/, "");
  return inner.split(TABLE_CELL_SPLIT).map((cell) => cell.trim());
}

export function malformedTableRows(content: string): number[] {
  const bad: number[] = [];
  let inFence = false;
  let expected: number | null = null;
  let pendingHeader = false;
  content.split(/\r?\n/).forEach((line, index) => {
    const lineNo = index + 1;
    const stripped = line.trim();
    if (stripped.startsWith("```") || stripped.startsWith("~~~")) {
      inFence = !inFence;
      expected = null;
      pendingHeader = false;
      return;
    }
    if (inFence) {
      return;
    }
    if (!stripped.startsWith("|")) {
      expected = null;
      pendingHeader = false;
      return;
    }
    const cells = splitTableCells(stripped);
    if (pendingHeader) {
      pendingHeader = false;
      if (
        cells.length > 0
        && cells.every(
          (cell) =>
            Boolean(cell)
            && [...cell].every((character) =>
              ["-", ":", " "].includes(character),
            ),
        )
      ) {
        return;
      }
      expected = null;
    }
    if (expected === null) {
      expected = cells.length;
      pendingHeader = true;
      return;
    }
    if (cells.length !== expected) {
      bad.push(lineNo);
    }
  });
  return bad;
}

export function tableShapeWarnings(
  workspace: string,
  config: JsonObject,
): string[] {
  const warnings: string[] = [];
  for (const repoName of config.workspace?.repo_order ?? []) {
    const repoDocsDir = join(workspace, REPO_DOCS_PATH, repoName);
    if (!existsSync(repoDocsDir)) {
      continue;
    }
    const badRows: string[] = [];
    for (const docPath of recursiveMarkdownFiles(repoDocsDir)) {
      const docName = toPosix(relative(repoDocsDir, docPath));
      badRows.push(
        ...malformedTableRows(readText(docPath)).map(
          (lineNo) => `${docName}:${lineNo}`,
        ),
      );
    }
    if (badRows.length > 0) {
      warnings.push(
        `仓库 \`${repoName}\` 的文档有 ${badRows.length} 行表格单元格数与表头不一致`
          + `（${badRows.join(", ")}）。单元格内的管道符必须写成 \`\\|\`，`
          + "否则重渲染时内容可能被挤进多余单元格或丢失。",
      );
    }
  }
  return warnings;
}

export const IDENTIFIER_PART_RE = /^[A-Za-z][A-Za-z0-9_]{5,}$/;
export const GRAPH_VOCABULARY = new Set([
  "consumes_api",
  "depends_on_repo_artifacts",
  "peer",
  "directed",
]);
export const SOURCE_CORPUS_SUFFIXES = new Set([
  "java",
  "kt",
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "go",
  "rs",
  "rb",
  "sh",
  "md",
  "json",
  "xml",
  "yaml",
  "yml",
  "toml",
  "properties",
  "sql",
  "less",
  "css",
  "scss",
  "html",
  "vue",
  "acl",
  "conf",
  "txt",
  "gradle",
  "cfg",
  "ini",
]);
export const MAX_CORPUS_FILE_BYTES = 1_000_000;

export function extractIdentifierCandidates(
  text: string,
  extraVocabulary: Set<string> | null = null,
): Set<string> {
  const vocabulary = new Set([
    ...GRAPH_VOCABULARY,
    ...(extraVocabulary ?? []),
  ]);
  const candidates = new Set<string>();
  for (const match of text.matchAll(/`([^`]+)`/g)) {
    const span = match[1]!.trim();
    if (!span || /[ \t<>*(){}$#\\'",]/.test(span)) {
      continue;
    }
    if (span.includes("/") || span.includes("-")) {
      continue;
    }
    for (const part of span.replace(/^@+/, "").split(".")) {
      if (!IDENTIFIER_PART_RE.test(part)) {
        continue;
      }
      if (!part.includes("_") && part === part.toLowerCase()) {
        continue;
      }
      if (vocabulary.has(part) || part.includes("Xxx")) {
        continue;
      }
      candidates.add(part);
    }
  }
  return candidates;
}

export function declaredRelationVocabulary(config: JsonObject): Set<string> {
  const vocabulary = new Set<string>();
  const relations = config.relations ?? [];
  if (Array.isArray(relations)) {
    for (const relation of relations) {
      if (
        relation !== null
        && typeof relation === "object"
        && !Array.isArray(relation)
        && typeof relation.type === "string"
        && relation.type
      ) {
        vocabulary.add(relation.type);
      }
    }
  }
  for (const relationType of config.suppressed_relation_types ?? []) {
    if (typeof relationType === "string" && relationType) {
      vocabulary.add(relationType);
    }
  }
  return vocabulary;
}

export function findMissingIdentifiers(
  workspace: string,
  repoNames: string[],
  tokens: Set<string>,
): Set<string> {
  let missing = new Set(tokens);
  for (const repoName of repoNames) {
    const repoRoot = join(workspace, repoName);
    if (!isDirectory(repoRoot)) {
      continue;
    }
    for (const path of walkFiles(repoRoot, {
      ignoredDirs: IGNORED_DIRS,
      skipHiddenDirs: true,
    })) {
      if (missing.size === 0) {
        return missing;
      }
      const suffix = extname(path).slice(1).toLowerCase();
      if (suffix && !SOURCE_CORPUS_SUFFIXES.has(suffix)) {
        continue;
      }
      let text: string;
      try {
        if (statSync(path).size > MAX_CORPUS_FILE_BYTES) {
          continue;
        }
        text = readText(path);
      } catch {
        continue;
      }
      const haystack = `${basename(path)}\n${text}`;
      missing = new Set([...missing].filter((token) => !haystack.includes(token)));
      if (missing.size === 0) {
        return missing;
      }
    }
  }
  return missing;
}

export function identifierExistenceWarnings(
  workspace: string,
  config: JsonObject,
): string[] {
  const repoOrder = config.workspace?.repo_order ?? [];
  const extraVocabulary = declaredRelationVocabulary(config);
  const candidatesByRepo = new Map<string, Map<string, string[]>>();
  for (const repoName of repoOrder) {
    const repoDocsDir = join(workspace, REPO_DOCS_PATH, repoName);
    if (!existsSync(repoDocsDir)) {
      continue;
    }
    for (const docPath of recursiveMarkdownFiles(repoDocsDir)) {
      const docName = toPosix(relative(repoDocsDir, docPath));
      const candidates = [
        ...extractIdentifierCandidates(readText(docPath), extraVocabulary),
      ].sort();
      for (const token of candidates) {
        if (!candidatesByRepo.has(repoName)) {
          candidatesByRepo.set(repoName, new Map());
        }
        const byToken = candidatesByRepo.get(repoName)!;
        if (!byToken.has(token)) {
          byToken.set(token, []);
        }
        byToken.get(token)!.push(docName);
      }
    }
  }
  if (candidatesByRepo.size === 0) {
    return [];
  }
  const allTokens = new Set<string>();
  for (const byToken of candidatesByRepo.values()) {
    for (const token of byToken.keys()) {
      allTokens.add(token);
    }
  }
  const missingTokens = findMissingIdentifiers(workspace, repoOrder, allTokens);
  const warnings: string[] = [];
  for (const repoName of repoOrder) {
    const missing = [
      ...(candidatesByRepo.get(repoName)?.entries() ?? []),
    ]
      .filter(([token]) => missingTokens.has(token))
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    if (missing.length > 0) {
      const listed = missing
        .map(([token, docs]) => {
          const uniqueDocs = [...new Set(docs)].sort();
          return `\`${token}\`（${uniqueDocs.join(", ")}）`;
        })
        .join("; ");
      warnings.push(
        `仓库 \`${repoName}\` 的文档引用了工作区 grep 找不到的代码标识符：${listed}。`
          + "这些常是转写错误。编辑文档前先核对代码；确实存在于代码里的奇怪拼写是事实，"
          + "不要随意更正。",
      );
    }
  }
  return warnings;
}

export function lineCitationWarnings(
  workspace: string,
  config: JsonObject,
): string[] {
  const warnings: string[] = [];
  const globalPattern = new RegExp(LINE_CITATION_RE.source, "gi");
  for (const repoName of config.workspace?.repo_order ?? []) {
    const repoDocsDir = join(workspace, REPO_DOCS_PATH, repoName);
    if (!existsSync(repoDocsDir)) {
      continue;
    }
    const hits: string[] = [];
    for (const docPath of recursiveMarkdownFiles(repoDocsDir)) {
      const docName = toPosix(relative(repoDocsDir, docPath));
      const count = [...readText(docPath).matchAll(globalPattern)].length;
      if (count > 0) {
        hits.push(`${docName}（${count}）`);
      }
    }
    if (hits.length > 0) {
      warnings.push(
        `仓库 \`${repoName}\` 的文档包含行号引用（${hits.join(", ")}）。`
          + "行号引用会随文件编辑漂移；改用 bean ID、方法名或小节名等稳定锚点。",
      );
    }
  }
  return warnings;
}

export function subareaCoverageTokens(name: string): Set<string> {
  const tokens = new Set<string>([name]);
  const tail = name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name;
  if (tail) {
    tokens.add(tail);
    tokens.add(tail.replace(/(?<!^)(?=[A-Z])/g, "_").toUpperCase());
  }
  return new Set([...tokens].filter(Boolean));
}

export function domainSubareaCoverageWarnings(
  workspace: string,
  config: JsonObject,
  discovery: JsonObject,
): string[] {
  const warnings: string[] = [];
  const scanByRepo = new Map<string, JsonObject>(
    (discovery.repos ?? []).map((repo: JsonObject) => [repo.name, repo]),
  );
  for (const repoName of config.workspace?.repo_order ?? []) {
    const scan = scanByRepo.get(repoName) ?? {};
    const subareas = [
      ...(scan.frontend?.page_groups ?? []),
      ...(scan.monorepo?.packages ?? []),
      ...(scan.monorepo?.apps ?? []),
    ];
    if (subareas.length === 0) {
      continue;
    }
    const domainsDir = join(workspace, REPO_DOCS_PATH, repoName, "domains");
    const domainDocs = markdownFiles(domainsDir);
    if (domainDocs.length === 0) {
      continue;
    }
    const corpusParts = domainDocs.map((path) => readText(path));
    const sharedDir = join(workspace, REPO_DOCS_PATH, repoName, "shared");
    if (existsSync(sharedDir)) {
      corpusParts.push(...markdownFiles(sharedDir).map((path) => readText(path)));
    }
    const corpus = corpusParts.join("\n");
    const uncovered = subareas.filter(
      (subarea: string) =>
        ![...subareaCoverageTokens(subarea)].some((token) =>
          corpus.includes(token),
        ),
    );
    if (uncovered.length > 0) {
      warnings.push(
        `仓库 \`${repoName}\` 有 ${uncovered.length} 个业务子区未被任何业务域/共享文档提及`
          + `（${uncovered.join(", ")}）。这些页面分组/包很可能是研究阶段漏掉的业务域；`
          + `确认后补进 .workspace/repos/${repoName}/domains/，`
          + "或在既有文档里说明其状态（如未挂载、已废弃）。",
      );
    }
  }
  return warnings;
}

export function collectHygieneWarnings(
  workspace: string,
  config: JsonObject,
  discovery: JsonObject,
): string[] {
  const warnings: string[] = [];
  warnings.push(...repoOrderWarnings(config, discovery));
  warnings.push(...taskRouteDensityWarnings(config));
  warnings.push(...orphanRepoDocWarnings(workspace, config, discovery));
  warnings.push(...domainSubareaCoverageWarnings(workspace, config, discovery));
  warnings.push(...declarationSummaryWarnings(config));
  warnings.push(...memoryPlaceholderWarnings(workspace));
  warnings.push(...dailyFileWarnings(workspace));
  warnings.push(...memoryQualityWarnings(workspace, config));
  warnings.push(...nestedDocWarnings(workspace, config));
  warnings.push(...repoIndexTableWarnings(workspace, config));
  warnings.push(...tableShapeWarnings(workspace, config));
  warnings.push(...linkLabelWarnings(workspace, config));
  warnings.push(...lineCitationWarnings(workspace, config));
  warnings.push(...identifierExistenceWarnings(workspace, config));
  return warnings;
}
