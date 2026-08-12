#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { basename, join, relative } from "node:path";

import {
  CONFIG_PATH,
  REPO_DOCS_PATH,
  readJson,
  readText,
  sortedDirectory,
  toPosix,
  writeJson,
  type JsonObject,
} from "./core.ts";
import { repoMap } from "./discovery.ts";
import {
  markdownSection,
  parseAgentIndexSections,
  parseEntryPathsFromTable,
  parseNestedDoc,
  parseOperationRows,
  rawTableValue,
  tableValue,
} from "./mdparse.ts";
import { autoRelations } from "./relations.ts";

export const LEGACY_CONFIG_KEYS = ["repos", "memory_seed"] as const;

function isRecord(value: any): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function defaultRootConfig(discovery: JsonObject): JsonObject {
  const repoOrder = (discovery.repos ?? []).map((repo: JsonObject) => repo.name);
  return {
    workspace: {
      name: discovery.workspace.name,
      summary: "TODO: 补充工作区摘要。",
      positioning: "TODO: 补充工作区定位。",
      entry_policy: {
        delete_workspace_md: true,
      },
      repo_order: repoOrder,
      task_routes: [],
    },
    relations: autoRelations(discovery),
    standalone_repos: [],
    suppressed_relations: [],
  };
}

export function loadOrCreateRootConfig(
  workspace: string,
  discovery: JsonObject,
): JsonObject {
  const configPath = join(workspace, CONFIG_PATH);
  if (existsSync(configPath)) {
    return readJson<JsonObject>(configPath);
  }
  const config = defaultRootConfig(discovery);
  writeJson(configPath, config);
  return config;
}

export interface RepoDocPaths {
  base: string;
  index: string;
  domains: string;
  shared: string;
}

export function repoDocPaths(repoName: string): RepoDocPaths {
  const base = `${REPO_DOCS_PATH}/${repoName}`;
  return {
    base,
    index: `${base}/index.md`,
    domains: `${base}/domains`,
    shared: `${base}/shared`,
  };
}

export function defaultEntryPaths(repoScan: JsonObject): string[] {
  const detectedKind = repoScan.detected_kind ?? "unknown";
  const manifests = repoScan.manifests ?? [];
  const entryCandidates: string[] = [];
  if (detectedKind === "bigfish-console") {
    entryCandidates.push(
      "config/config.ts",
      "config/routes",
      "src/pages",
      "src/services",
    );
  } else if (detectedKind === "maven-service") {
    entryCandidates.push("pom.xml", ...(repoScan.backend?.modules ?? []).slice(0, 2));
  } else if (detectedKind === "node-monorepo") {
    entryCandidates.push("pnpm-workspace.yaml", "package.json", "packages", "apps");
  } else {
    entryCandidates.push(...manifests.slice(0, 3));
  }
  for (const manifest of manifests) {
    if (!entryCandidates.includes(manifest) && entryCandidates.length < 4) {
      entryCandidates.push(manifest);
    }
  }
  const repoRoot = repoScan.path ? String(repoScan.path) : null;
  const primaryEntryPaths: string[] = [];
  for (const item of entryCandidates) {
    if (!item || primaryEntryPaths.includes(item)) {
      continue;
    }
    if (repoRoot !== null && !existsSync(join(repoRoot, item))) {
      continue;
    }
    primaryEntryPaths.push(item);
  }
  return primaryEntryPaths;
}

export function defaultRepoModel(repoScan: JsonObject): JsonObject {
  const detectedKind = repoScan.detected_kind ?? "unknown";
  return {
    category: detectedKind,
    audience: "TODO: 补充读者。",
    summary: "TODO: 补充仓库摘要。",
    role: "TODO: 补充仓库职责。",
    primary_entry_paths: defaultEntryPaths(repoScan),
    domains: [],
    shared_docs: [],
  };
}

export function mergeObjects(base: any, override: any): any {
  if (isRecord(base) && isRecord(override)) {
    const merged = { ...base };
    for (const [key, value] of Object.entries(override)) {
      merged[key] = key in merged ? mergeObjects(merged[key], value) : value;
    }
    return merged;
  }
  return override;
}

export function normalizeRootConfig(config: JsonObject): JsonObject {
  config.relations ??= [];
  config.standalone_repos ??= [];
  config.suppressed_relations ??= [];
  return config;
}

export function discoverNestedDocs(
  workspace: string,
  repoName: string,
  folder: "domains" | "shared",
): JsonObject[] {
  const paths = repoDocPaths(repoName);
  const docsDir = join(workspace, paths[folder]);
  if (!existsSync(docsDir)) {
    return [];
  }
  return sortedDirectory(docsDir)
    .filter((entry) => entry.name.endsWith(".md"))
    .map((entry) =>
      parseNestedDoc(
        workspace,
        toPosix(relative(workspace, join(docsDir, entry.name))),
      ),
    );
}

export function parseExistingRepoIndex(
  workspace: string,
  repoName: string,
): JsonObject {
  const indexAbs = join(workspace, repoDocPaths(repoName).index);
  if (!existsSync(indexAbs)) {
    return {};
  }
  const content = readText(indexAbs);
  const model: JsonObject = {};
  for (const [key, field] of [
    ["Category", "category"],
    ["Audience", "audience"],
    ["Summary", "summary"],
    ["Role", "role"],
  ] as const) {
    const value = tableValue(content, key);
    if (value) {
      model[field] = value;
    }
  }
  const entryValue = rawTableValue(content, "Primary Entries");
  if (entryValue) {
    model.primary_entry_paths = parseEntryPathsFromTable(
      workspace,
      repoName,
      indexAbs,
      entryValue,
    );
  }
  const operationRows = parseOperationRows(
    markdownSection(content.split(/\r?\n/), "Common Operations"),
  );
  if (operationRows.length > 0) {
    model.operation_rows = operationRows;
  }
  const agentSections = parseAgentIndexSections(content);
  if (agentSections.length > 0) {
    model.agent_sections = agentSections;
  }
  return model;
}

export function prepareRepoModels(
  workspace: string,
  config: JsonObject,
  discovery: JsonObject,
): Record<string, JsonObject> {
  const scans = repoMap(discovery);
  const repoModels: Record<string, JsonObject> = {};
  for (const repoName of config.workspace?.repo_order ?? []) {
    let model = defaultRepoModel(scans[repoName] ?? { name: repoName });
    const existingIndex = parseExistingRepoIndex(workspace, repoName);
    const existingDocs = {
      domains: discoverNestedDocs(workspace, repoName, "domains"),
      shared_docs: discoverNestedDocs(workspace, repoName, "shared"),
    };
    model = mergeObjects(model, existingIndex);
    model = mergeObjects(model, existingDocs);
    model.domains ??= [];
    model.shared_docs ??= [];
    model.operation_rows ??= [];
    model.agent_sections ??= [];
    repoModels[repoName] = model;
  }
  return repoModels;
}

export function bootstrapConfig(workspaceName: string): JsonObject {
  return {
    workspace: {
      name: workspaceName,
      summary: "TODO: 补充工作区摘要。",
      positioning: "TODO: 补充工作区定位和边界。",
      entry_policy: {
        delete_workspace_md: true,
      },
      repo_order: [],
      task_routes: [],
    },
    relations: [],
    standalone_repos: [],
    suppressed_relations: [],
  };
}

export function bootstrapDiscovery(workspace: string): JsonObject {
  return {
    generated_at: null,
    workspace: {
      name: basename(workspace),
      path: workspace,
      repo_count: 0,
    },
    repos: [],
  };
}

export function bootstrapRelationRegistry(workspaceName: string): JsonObject {
  return {
    generated_at: null,
    workspace: workspaceName,
    repo_order: [],
    relations: [],
    standalone_repos: [],
  };
}
