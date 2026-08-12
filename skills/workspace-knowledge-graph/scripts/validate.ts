#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

import { repoDocPaths } from "./config.ts";
import {
  CONFIG_PATH,
  DISCOVERY_PATH,
  MEMORY_DAILY_PATH,
  RELATION_INDEX_PATH,
  RELATION_REGISTRY_PATH,
  REPO_DOCS_PATH,
  ROOT_DOC_PATHS,
  WORKSPACE_INDEX_PATH,
  extractMarkdownLinks,
  isExternalLink,
  readJson,
  readText,
  relLink,
  resolvePath,
  stripAnchor,
  toPosix,
  walkFiles,
  type JsonObject,
} from "./core.ts";
import {
  normalizeStandaloneRepos,
  relationShapeErrors,
} from "./relations.ts";
import { collectHygieneWarnings } from "./validate_hygiene.ts";

export const DOMAIN_COVERAGE_THRESHOLD = 5;

export function requiredPathsFromConfig(config: JsonObject): string[] {
  const paths = [
    CONFIG_PATH,
    DISCOVERY_PATH,
    RELATION_REGISTRY_PATH,
    RELATION_INDEX_PATH,
    WORKSPACE_INDEX_PATH,
    ...ROOT_DOC_PATHS,
  ];
  for (const repoName of config.workspace?.repo_order ?? []) {
    paths.push(repoDocPaths(repoName).index);
  }
  return paths;
}

export function generatedMarkdownPaths(workspace: string): string[] {
  const markdownFiles = ROOT_DOC_PATHS
    .map((path) => join(workspace, path))
    .filter((path) => existsSync(path));
  const workspaceDir = join(workspace, ".workspace");
  if (existsSync(workspaceDir)) {
    const memoryRoot = join(workspace, MEMORY_DAILY_PATH, "..");
    markdownFiles.push(
      ...[...walkFiles(workspaceDir)]
        .filter((path) => path.endsWith(".md"))
        .filter((path) => {
          const candidate = relative(memoryRoot, path);
          return (
            candidate === ".."
            || candidate.startsWith(`..${sep}`)
            || isAbsolute(candidate)
          );
        })
        .sort(),
    );
  }
  return markdownFiles;
}

function displayValue(value: any): string {
  if (value === null || value === undefined) {
    return "None";
  }
  return String(value);
}

function jsonErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function validateWorkspace(workspace: string): [string[], string[]] {
  const errors: string[] = [];
  const warnings: string[] = [];
  const configPath = join(workspace, CONFIG_PATH);
  if (!existsSync(configPath)) {
    return [[`缺少声明层文件：${CONFIG_PATH}`], warnings];
  }
  let config: JsonObject;
  try {
    config = readJson<JsonObject>(configPath);
  } catch (error) {
    return [
      [
        `${CONFIG_PATH} 必须使用 JSON 语法（\`.yaml\` 只是历史遗留的扩展名约定；`
          + `见 references/config-schema.md）：${jsonErrorMessage(error)}`,
      ],
      warnings,
    ];
  }
  if ("repos" in config) {
    errors.push(
      "根 `.workspace/metadata.yaml` 不能包含遗留的 `repos` 键（自动迁移已移除）。"
        + "请手动把仓库声明沉淀到 .workspace/repos/<repo>/ 的 Markdown 事实源，然后删除该键。",
    );
  }
  if ("memory_seed" in config) {
    errors.push(
      "根 `.workspace/metadata.yaml` 不能包含遗留的 `memory_seed` 键（自动迁移已移除）。"
        + "请手动把有用条目搬进 MEMORY.md，然后删除该键。",
    );
  }
  const discoveryPath = join(workspace, DISCOVERY_PATH);
  let discovery: JsonObject;
  if (!existsSync(discoveryPath)) {
    warnings.push(`缺少自动扫描快照：${DISCOVERY_PATH}`);
    discovery = { repos: [] };
  } else {
    discovery = readJson<JsonObject>(discoveryPath);
  }
  for (const requiredPath of requiredPathsFromConfig(config)) {
    if (!existsSync(join(workspace, requiredPath))) {
      errors.push(`缺少生成产物：${requiredPath}`);
    }
  }
  const claudePath = join(workspace, "CLAUDE.md");
  if (
    existsSync(claudePath)
    && readText(claudePath).trim() !== "@AGENTS.md"
  ) {
    errors.push("CLAUDE.md 必须严格只有一行：`@AGENTS.md`。");
  }
  if (
    config.workspace?.entry_policy?.delete_workspace_md
    && existsSync(join(workspace, "WORKSPACE.md"))
  ) {
    errors.push("配置要求删除 WORKSPACE.md，但根目录下该文件仍然存在。");
  }
  const standaloneNames = new Set(
    normalizeStandaloneRepos(config.standalone_repos ?? []).map(
      (entry) => entry.repo,
    ),
  );
  const taskRoutes = config.workspace?.task_routes ?? [];
  const routedTargets = new Set<string>();
  for (const route of taskRoutes) {
    if (!(route.read?.length > 0)) {
      errors.push(
        `任务路由 \`${route.name ?? "?"}\` 没有 read 目标；`
          + "请在 .workspace/metadata.yaml 的 task_routes 补充要阅读的文档路径。",
      );
    }
    for (const target of route.read ?? []) {
      routedTargets.add(target);
      if (!existsSync(join(workspace, target))) {
        errors.push(`task_routes 引用了不存在的路径：${target}`);
      }
    }
  }
  if (taskRoutes.length > 0) {
    for (const repoName of config.workspace?.repo_order ?? []) {
      if (standaloneNames.has(repoName)) {
        continue;
      }
      const repoPrefix = `${REPO_DOCS_PATH}/${repoName}/`;
      if (![...routedTargets].some((target) => target.startsWith(repoPrefix))) {
        errors.push(
          `核心仓库 \`${repoName}\` 未被任何任务路由覆盖；`
            + "请在 .workspace/metadata.yaml 的 task_routes 补充一条，或声明为独立仓库。",
        );
      }
    }
  }
  const relationRepoNames = new Set<string>(
    config.workspace?.repo_order ?? [],
  );
  for (const entry of normalizeStandaloneRepos(config.standalone_repos ?? [])) {
    if (!relationRepoNames.has(entry.repo)) {
      errors.push(`独立仓库声明不在 repo_order 中：${entry.repo}`);
    }
  }
  errors.push(...relationShapeErrors(config.relations ?? []));
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
      for (const evidence of relation.evidence ?? []) {
        if (typeof evidence !== "string" || !evidence) {
          continue;
        }
        if (!existsSync(join(workspace, evidence))) {
          errors.push(
            `关系证据路径不存在：${displayValue(relation.from)} -> ${displayValue(relation.to)} `
              + `\`${evidence}\`。证据必须是真实的工作区相对路径；`
              + "不要用 `...` 省略路径片段。",
          );
        }
      }
    }
  }
  for (const entry of normalizeStandaloneRepos(config.standalone_repos ?? [])) {
    for (const evidence of entry.evidence ?? []) {
      if (typeof evidence !== "string" || !evidence) {
        continue;
      }
      if (!existsSync(join(workspace, evidence))) {
        errors.push(
          `独立仓库证据路径不存在：${entry.repo} \`${evidence}\`。`
            + "证据必须是真实的工作区相对路径；不要用 `...` 省略路径片段。",
        );
      }
    }
  }
  const registryPath = join(workspace, RELATION_REGISTRY_PATH);
  if (existsSync(registryPath)) {
    const registry = readJson<JsonObject>(registryPath);
    for (const entry of normalizeStandaloneRepos(registry.standalone_repos ?? [])) {
      if (!relationRepoNames.has(entry.repo)) {
        errors.push(`registry 独立仓库不在 repo_order 中：${entry.repo}`);
      }
    }
    for (const relation of registry.relations ?? []) {
      const sourceRepo = relation.from;
      const targetRepo = relation.to;
      if (!relationRepoNames.has(sourceRepo)) {
        errors.push(`关系起点不在 repo_order 中：${displayValue(sourceRepo)}`);
      }
      if (!relationRepoNames.has(targetRepo)) {
        errors.push(`关系终点不在 repo_order 中：${displayValue(targetRepo)}`);
      }
      if (typeof sourceRepo !== "string" || typeof targetRepo !== "string") {
        continue;
      }
      const sourceIndex = join(
        workspace,
        REPO_DOCS_PATH,
        sourceRepo,
        "index.md",
      );
      const targetIndex = join(
        workspace,
        REPO_DOCS_PATH,
        targetRepo,
        "index.md",
      );
      if (existsSync(sourceIndex) && existsSync(targetIndex)) {
        const sourceExpected = relLink(sourceIndex, targetIndex);
        const targetExpected = relLink(targetIndex, sourceIndex);
        const sourceContent = readText(sourceIndex);
        const targetContent = readText(targetIndex);
        if (!sourceContent.includes(`[${targetRepo}](${sourceExpected})`)) {
          errors.push(`源仓库 index 缺少关系链接：${sourceRepo} -> ${targetRepo}`);
        }
        if (!targetContent.includes(`[${sourceRepo}](${targetExpected})`)) {
          errors.push(`目标仓库 index 缺少关系回链：${targetRepo} -> ${sourceRepo}`);
        }
      }
    }
  }
  for (const markdownPath of generatedMarkdownPaths(workspace)) {
    const content = readText(markdownPath);
    for (const rawTarget of extractMarkdownLinks(content)) {
      const target = stripAnchor(rawTarget);
      if (
        !target
        || target.startsWith("#")
        || isExternalLink(target)
      ) {
        continue;
      }
      const resolved = resolvePath(
        isAbsolute(target) ? target : join(markdownPath, "..", target),
      );
      if (!existsSync(resolved)) {
        const displayPath = toPosix(relative(workspace, markdownPath));
        errors.push(`链接失效：${displayPath} -> ${rawTarget}`);
      }
    }
  }
  for (const repo of discovery.repos ?? []) {
    const repoName = repo.name;
    if (!repoName) {
      continue;
    }
    const subareaCount =
      (repo.frontend?.page_groups ?? []).length
      + (repo.backend?.modules ?? []).length
      + (repo.monorepo?.packages ?? []).length
      + (repo.monorepo?.apps ?? []).length;
    const domainsDir = join(
      workspace,
      REPO_DOCS_PATH,
      repoName,
      "domains",
    );
    const domainDocs = existsSync(domainsDir)
      ? [...new Bun.Glob("*.md").scanSync({ cwd: domainsDir, onlyFiles: false })]
      : [];
    if (
      subareaCount >= DOMAIN_COVERAGE_THRESHOLD
      && domainDocs.length === 0
    ) {
      errors.push(
        `仓库 \`${repoName}\` 扫描到 ${subareaCount} 个页面/模块/包/应用，`
          + `却没有业务域文档。研究阶段必须在 .workspace/repos/${repoName}/domains/ 下`
          + "补充业务域事实；standalone 只表示没有已知跨仓关系，不能豁免复杂仓库的业务域入口。",
      );
    }
  }
  warnings.push(...collectHygieneWarnings(workspace, config, discovery));
  return [errors, warnings];
}
