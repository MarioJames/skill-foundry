#!/usr/bin/env bun

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { repoDocPaths } from "./config.ts";
import {
  DISCOVERY_PATH,
  RELATION_REGISTRY_PATH,
  REPO_DOCS_PATH,
  escapeCell,
  relLink,
  renderCategoryCell,
  renderEvidenceList,
  stripInlineLinks,
  unescapeCell,
  writeText,
  type JsonObject,
} from "./core.ts";
import { repoMap } from "./discovery.ts";
import { normalizeCommandCell } from "./mdparse.ts";

function isRecord(value: any): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function packageScripts(repoScan: JsonObject): Record<string, string> {
  const scripts = repoScan.package?.script_commands ?? {};
  if (!isRecord(scripts)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(scripts).map(([key, value]) => [String(key), String(value)]),
  );
}

export function scriptRunner(repoScan: JsonObject): string {
  const packageManager = String(repoScan.package_manager ?? "tnpm");
  for (const runner of ["pnpm", "yarn", "bun", "npm"]) {
    if (packageManager.startsWith(runner)) {
      return runner;
    }
  }
  return "tnpm";
}

export function operationEntries(
  repoName: string,
  repoScan: JsonObject,
  workspace: string,
): JsonObject[] {
  const entries: JsonObject[] = [];
  const scripts = packageScripts(repoScan);
  const runner = scriptRunner(repoScan);
  const repoRoot = join(workspace, repoName);
  const addScript = (name: string, scene: string, note: string): void => {
    if (!(name in scripts)) {
      return;
    }
    entries.push({
      scene,
      command: `${runner} ${name}`,
      note,
      evidence: [`${repoName}/package.json`],
    });
  };
  if ("devs" in scripts) {
    let note: string;
    if (scripts.devs.includes("MOCK=none")) {
      note =
        repoScan.detected_kind === "bigfish-console"
          ? "Bigfish 开发模式带 MOCK=none；用于关闭 mock 并连接真实 API。"
          : "脚本包含 MOCK=none；用于关闭 mock 或直接联调。";
    } else {
      note = "package.json 暴露的联调开发入口。";
    }
    addScript("devs", "API 联调", note);
  }
  addScript("test:journey", "旅程测试", "仓库提供的旅程验证入口。");
  if (repoScan.detected_kind === "maven-service") {
    entries.push({
      scene: "构建工具",
      command: "mvn test / mvn package",
      note: "Maven 服务；使用 pom.xml 和模块 pom，不要运行 tnpm。",
      evidence: [`${repoName}/pom.xml`],
    });
  }
  if (existsSync(join(repoRoot, "build.sh"))) {
    entries.push({
      scene: "构建",
      command: "./build.sh",
      note: "该 shell 脚本是仓库构建入口。",
      evidence: [`${repoName}/build.sh`],
    });
  }
  if (existsSync(join(repoRoot, "release.sh"))) {
    entries.push({
      scene: "发布",
      command: "./release.sh",
      note: "该 shell 脚本是仓库发布入口。",
      evidence: [`${repoName}/release.sh`],
    });
  }
  return entries;
}

export function renderRepoPathList(
  workspace: string,
  indexAbs: string,
  repoName: string,
  paths: string[],
): string {
  if (paths.length === 0) {
    return "-";
  }
  const repoRoot = join(workspace, repoName);
  return paths
    .map((item) => {
      const target = join(repoRoot, item);
      return existsSync(target)
        ? `[\`${item}\`](${relLink(indexAbs, target)})`
        : `\`${item}\``;
    })
    .join(", ");
}

export const MECHANICAL_OPERATION_NOTES = new Set([
  "package.json 暴露的默认开发入口。",
  "Bigfish 开发模式带 MOCK=none；用于关闭 mock 并连接真实 API。",
  "脚本包含 MOCK=none；用于关闭 mock 或直接联调。",
  "package.json 暴露的联调开发入口。",
  "仓库提供的旅程验证入口。",
  "仓库提供的 OneAPI/mock 测试入口。",
  "仓库提供的 mock 初始化入口。",
  "仓库提供的 mock 同步入口。",
  "Maven 服务；使用 pom.xml 和模块 pom，不要运行 tnpm。",
  "该 shell 脚本是仓库构建入口。",
  "该 shell 脚本是仓库发布入口。",
  "该仓库声明了 pnpm workspace。",
  "Default development entry exposed by package.json.",
  "Bigfish dev with MOCK=none; use it to disable mock and connect to real APIs.",
  "Script includes MOCK=none; use it to disable mock or connect directly for integration.",
  "Integration development entry exposed by package.json.",
  "Repository-provided journey validation entry.",
  "Repository-provided OneAPI/mock test entry.",
  "Repository-provided mock initialization entry.",
  "Repository-provided mock synchronization entry.",
  "Maven service; use pom.xml and module poms. Do not run tnpm.",
  "Shell script is the repository build entry.",
  "Shell script is the repository release entry.",
  "This repository declares a pnpm workspace.",
]);

export function renderOperationRow(row: JsonObject): string {
  return `| ${row.scene} | ${row.command} | ${row.note} | ${row.evidence} |`;
}

export function renderOperationSection(
  workspace: string,
  indexAbs: string,
  repoName: string,
  repoScan: JsonObject,
  repoModel: JsonObject,
): string[] {
  const entries = operationEntries(repoName, repoScan, workspace);
  const mechanicalByCommand = new Map<string, JsonObject>(
    entries.map((entry) => [normalizeCommandCell(entry.command), entry]),
  );
  const overrides = new Map<string, JsonObject>();
  const extraRows: JsonObject[] = [];
  const extraCommands = new Set<string>();
  for (const row of repoModel.operation_rows ?? []) {
    const command = normalizeCommandCell(row.command);
    const mechanical = mechanicalByCommand.get(command);
    const rowNote = unescapeCell(row.note);
    if (mechanical !== undefined) {
      if (
        unescapeCell(row.scene) === mechanical.scene
        && rowNote === mechanical.note
      ) {
        continue;
      }
      if (MECHANICAL_OPERATION_NOTES.has(rowNote)) {
        continue;
      }
      if (!overrides.has(command)) {
        overrides.set(command, row);
      }
      continue;
    }
    if (MECHANICAL_OPERATION_NOTES.has(rowNote)) {
      continue;
    }
    if (!extraCommands.has(command)) {
      extraCommands.add(command);
      extraRows.push(row);
    }
  }
  if (entries.length === 0 && extraRows.length === 0) {
    return ["- 暂无自动检测到的常用操作；需要时可从 README、package.json 或 pom.xml 补充。"];
  }
  const lines = [
    "| 场景 | 命令/入口 | 说明 | 证据 |",
    "| --- | --- | --- | --- |",
  ];
  for (const entry of entries) {
    const override = overrides.get(normalizeCommandCell(entry.command));
    if (override !== undefined) {
      lines.push(renderOperationRow(override));
      continue;
    }
    const evidence = renderEvidenceList(entry.evidence ?? [], indexAbs, workspace);
    lines.push(
      `| ${escapeCell(entry.scene)} | \`${escapeCell(entry.command)}\` | ${escapeCell(entry.note)} | ${evidence} |`,
    );
  }
  for (const row of extraRows) {
    lines.push(renderOperationRow(row));
  }
  return lines;
}

export function relationBucketForRepo(
  repoName: string,
  relations: JsonObject[],
): { outbound: JsonObject[]; inbound: JsonObject[]; peer: JsonObject[] } {
  const bucket: {
    outbound: JsonObject[];
    inbound: JsonObject[];
    peer: JsonObject[];
  } = {
    outbound: [],
    inbound: [],
    peer: [],
  };
  for (const relation of relations) {
    if (relation.direction === "peer") {
      if ([relation.from, relation.to].includes(repoName)) {
        bucket.peer.push(relation);
      }
      continue;
    }
    if (relation.from === repoName) {
      bucket.outbound.push(relation);
    } else if (relation.to === repoName) {
      bucket.inbound.push(relation);
    }
  }
  return bucket;
}

export function renderRelationLines(
  workspace: string,
  indexAbs: string,
  repoName: string,
  relations: JsonObject[],
): string[] {
  const bucket = relationBucketForRepo(repoName, relations);
  const rows: Array<[string, JsonObject]> = [];
  for (const [label, items] of [
    ["Outbound", bucket.outbound],
    ["Inbound", bucket.inbound],
    ["Peer", bucket.peer],
  ] as Array<[string, JsonObject[]]>) {
    for (const relation of items) {
      rows.push([label, relation]);
    }
  }
  if (rows.length === 0) {
    return ["- 暂无编译出的仓库级关系。"];
  }
  const registryLink = relLink(indexAbs, join(workspace, RELATION_REGISTRY_PATH));
  const lines = [
    "| 方向 | 仓库 | 类型 | 来源 |",
    "| --- | --- | --- | --- |",
  ];
  for (const [label, relation] of rows) {
    const other = relation.from === repoName ? relation.to : relation.from;
    const otherDoc = `${REPO_DOCS_PATH}/${other}/index.md`;
    const renderedLabel =
      ({ Outbound: "出站", Inbound: "入站", Peer: "双向" } as Record<string, string>)[
        label
      ] ?? label;
    lines.push(
      `| ${renderedLabel} | [${other}](${relLink(indexAbs, join(workspace, otherDoc))}) | \`${relation.type}\` | [registry.yaml](${registryLink}) |`,
    );
  }
  return lines;
}

export function renderDocTable(
  workspace: string,
  indexAbs: string,
  repoName: string,
  folder: "domains" | "shared",
  docs: JsonObject[],
): string[] {
  if (docs.length === 0) {
    return folder === "domains"
      ? ["- 暂无业务域文档；需要时按业务域补充。"]
      : ["- 暂无共享或平台文档。"];
  }
  const paths = repoDocPaths(repoName);
  const lines = ["| 文档 | 摘要 |", "| --- | --- |"];
  for (const item of docs) {
    const target = `${paths[folder]}/${item.slug}.md`;
    lines.push(
      `| [${item.slug}](${relLink(indexAbs, join(workspace, target))}) | ${escapeCell(stripInlineLinks(item.summary ?? "")) || "-"} |`,
    );
  }
  return lines;
}

export function renderSnapshotLines(
  workspace: string,
  indexAbs: string,
  repoScan: JsonObject,
): string[] {
  const discoveryLink = relLink(indexAbs, join(workspace, DISCOVERY_PATH));
  const summarizeItems = (
    label: string,
    items: string[],
    threshold = 5,
  ): string => {
    if (items.length <= threshold) {
      return `- ${label}：${items.map((item) => `\`${item}\``).join(", ")}`;
    }
    return `- ${label}：\`${items.length}\` 项；完整自动扫描见 [${DISCOVERY_PATH}](${discoveryLink})。`;
  };
  const snapshotLines = [
    `- 检测类型：\`${repoScan.detected_kind ?? "unknown"}\``,
    `- 包管理器 / 构建工具：\`${repoScan.package_manager ?? "unknown"}\``,
  ];
  if (repoScan.remote) {
    snapshotLines.push(`- 远端：\`${repoScan.remote}\``);
  }
  if ((repoScan.frontend?.page_groups ?? []).length > 0) {
    const pageCount = repoScan.frontend.page_groups.length;
    snapshotLines.push(
      `- 页面分组：\`${pageCount}\` 项。优先阅读上方业务域文档；完整自动扫描见 [${DISCOVERY_PATH}](${discoveryLink})。`,
    );
  }
  if ((repoScan.frontend?.service_targets ?? []).length > 0) {
    snapshotLines.push(
      summarizeItems("服务目标", repoScan.frontend.service_targets),
    );
  }
  if ((repoScan.backend?.modules ?? []).length > 0) {
    snapshotLines.push(summarizeItems("Maven 模块", repoScan.backend.modules));
  }
  if ((repoScan.monorepo?.packages ?? []).length > 0) {
    snapshotLines.push(
      summarizeItems("Workspace 包", repoScan.monorepo.packages),
    );
  }
  if ((repoScan.monorepo?.apps ?? []).length > 0) {
    snapshotLines.push(
      summarizeItems("Monorepo 应用", repoScan.monorepo.apps),
    );
  }
  return snapshotLines;
}

export function renderRepoIndex(
  workspace: string,
  repoName: string,
  repoModel: JsonObject,
  repoScan: JsonObject,
  relations: JsonObject[],
): string {
  const paths = repoDocPaths(repoName);
  const indexAbs = join(workspace, paths.index);
  const agentSectionLines: string[] = [];
  for (const section of repoModel.agent_sections ?? []) {
    agentSectionLines.push("", section);
  }
  return [
    `# ${repoName}`,
    "",
    "## 仓库事实",
    "",
    "| 字段 | 内容 |",
    "| --- | --- |",
    `| 类别 | ${renderCategoryCell(repoModel.category ?? repoScan.detected_kind ?? "unknown")} |`,
    `| 读者 | ${escapeCell(repoModel.audience ?? "unknown")} |`,
    `| 摘要 | ${escapeCell(repoModel.summary ?? "")} |`,
    `| 职责 | ${escapeCell(repoModel.role ?? "")} |`,
    `| 主要入口 | ${renderRepoPathList(workspace, indexAbs, repoName, repoModel.primary_entry_paths ?? [])} |`,
    "",
    "## 常用操作",
    "",
    ...renderOperationSection(workspace, indexAbs, repoName, repoScan, repoModel),
    "",
    "## 关系",
    "",
    ...renderRelationLines(workspace, indexAbs, repoName, relations),
    "",
    "## 文档",
    "",
    "- 本页是持久的仓库级事实源。业务域和共享机制细节放在下方文档中。",
    "",
    "### 业务域",
    "",
    ...renderDocTable(workspace, indexAbs, repoName, "domains", repoModel.domains ?? []),
    "",
    "### 共享与平台",
    "",
    ...renderDocTable(workspace, indexAbs, repoName, "shared", repoModel.shared_docs ?? []),
    ...agentSectionLines,
    "",
    "## 自动扫描快照",
    "",
    ...renderSnapshotLines(workspace, indexAbs, repoScan),
  ].join("\n");
}

export function renderAllRepoDocs(
  workspace: string,
  config: JsonObject,
  repoModels: Record<string, JsonObject>,
  discovery: JsonObject,
  relations: JsonObject[],
): void {
  const byName = repoMap(discovery);
  for (const repoName of config.workspace.repo_order ?? []) {
    const repoModel = repoModels[repoName] ?? {};
    const repoScan = byName[repoName] ?? { name: repoName };
    const paths = repoDocPaths(repoName);
    mkdirSync(join(workspace, paths.domains), { recursive: true });
    mkdirSync(join(workspace, paths.shared), { recursive: true });
    writeText(
      join(workspace, paths.index),
      renderRepoIndex(workspace, repoName, repoModel, repoScan, relations),
    );
  }
}
