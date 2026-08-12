#!/usr/bin/env bun

import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  sep,
} from "node:path";

import {
  readText,
  resolvePath,
  stripAnchor,
  toPosix,
  type JsonObject,
} from "./core.ts";

export const SECTION_ALIASES: Record<string, readonly string[]> = {
  "Repository Facts": ["仓库事实", "Repository Facts"],
  "Common Operations": ["常用操作", "Common Operations"],
  Relations: ["关系", "Relations"],
  Docs: ["文档", "Docs"],
  "Auto Scan Snapshot": ["自动扫描快照", "Auto Scan Snapshot"],
  Summary: ["摘要", "Summary"],
  "Human Judgment": ["人工判断", "Human Judgment"],
};

export const FIELD_ALIASES: Record<string, readonly string[]> = {
  Category: ["类别", "Category"],
  Audience: ["读者", "Audience"],
  Summary: ["摘要", "Summary"],
  Role: ["职责", "Role"],
  "Primary Entries": ["主要入口", "Primary Entries"],
};

export const DERIVED_INDEX_SECTIONS = new Set([
  "仓库事实",
  "Repository Facts",
  "常用操作",
  "Common Operations",
  "关系",
  "Relations",
  "文档",
  "Docs",
  "自动扫描快照",
  "Auto Scan Snapshot",
]);

export const TABLE_CELL_SPLIT = /(?<!\\)\|/;
export const COMMAND_RUNNER_RUN = /^(tnpm|pnpm|npm|yarn|bun)\s+run\s+/;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function aliasValues(
  value: string,
  aliases: Record<string, readonly string[]>,
): readonly string[] {
  return aliases[value] ?? [value];
}

export function markdownSection(lines: string[], heading: string): string[] {
  const headings = new Set(aliasValues(heading, SECTION_ALIASES));
  let start: number | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const stripped = lines[index]!.trim();
    if (stripped.startsWith("## ") && headings.has(stripped.slice(3))) {
      start = index + 1;
      break;
    }
  }
  if (start === undefined) {
    return [];
  }
  let end = lines.length;
  for (let index = start; index < lines.length; index += 1) {
    if (lines[index]!.startsWith("## ")) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end);
}

export function firstParagraph(lines: string[]): string {
  const chunks: string[] = [];
  for (const line of lines) {
    const stripped = line.trim();
    if (!stripped) {
      if (chunks.length > 0) {
        break;
      }
      continue;
    }
    if (stripped.startsWith("#") || stripped.startsWith("- ")) {
      continue;
    }
    chunks.push(stripped);
  }
  return chunks.join(" ");
}

export function repoRelativeLink(
  workspace: string,
  repoName: string,
  docAbs: string,
  target: string,
): string | null {
  const withoutAnchor = stripAnchor(target);
  if (!withoutAnchor) {
    return null;
  }
  const resolved = resolvePath(
    isAbsolute(withoutAnchor)
      ? withoutAnchor
      : join(dirname(docAbs), withoutAnchor),
  );
  const repoRoot = resolvePath(`${workspace}/${repoName}`);
  const candidate = relative(repoRoot, resolved);
  if (isAbsolute(candidate) || candidate === ".." || candidate.startsWith(`..${sep}`)) {
    return null;
  }
  return candidate ? toPosix(candidate) : ".";
}

export function parseNestedDoc(
  workspace: string,
  docPath: string,
): JsonObject {
  const lines = readText(join(workspace, docPath)).split(/\r?\n/);
  const name = basename(docPath);
  return {
    slug: name.slice(0, name.length - extname(name).length),
    summary: firstParagraph(markdownSection(lines, "Summary")),
  };
}

export function rawTableValue(content: string, key: string): string | null {
  for (const label of aliasValues(key, FIELD_ALIASES)) {
    const pattern = new RegExp(
      `^\\|\\s*${escapeRegex(label)}\\s*\\|\\s*(.*?)\\s*\\|$`,
      "m",
    );
    const match = pattern.exec(content);
    if (match) {
      return match[1]!.trim();
    }
  }
  return null;
}

export function tableValue(content: string, key: string): string | null {
  let value = rawTableValue(content, key);
  if (value === null) {
    return null;
  }
  while (true) {
    const match = /^(`{2,})(.*)\1$/s.exec(value);
    if (!match) {
      break;
    }
    value = match[2]!.trim();
  }
  return value.replace(/^`([^`]*)`$/, "$1");
}

export function parseEntryPathsFromTable(
  workspace: string,
  repoName: string,
  indexAbs: string,
  value: string,
): string[] {
  const paths: string[] = [];
  const add = (item: string): void => {
    const normalized = item.trim().replace(/\/+$/, "");
    if (normalized && !paths.includes(normalized)) {
      paths.push(normalized);
    }
  };
  for (const match of value.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const repoPath = repoRelativeLink(workspace, repoName, indexAbs, match[1]!);
    if (repoPath) {
      add(repoPath);
    }
  }
  const withoutLinks = value.replace(/\[[^\]]*\]\([^)]*\)/g, "");
  for (const match of withoutLinks.matchAll(/`([^`]+)`/g)) {
    add(match[1]!);
  }
  return paths;
}

export function normalizeCommandCell(cell: string): string {
  let value = cell.replaceAll("\\|", "|").trim();
  const span = /`([^`]+)`/.exec(value);
  if (span) {
    value = span[1]!.trim();
  } else {
    const split = /(?:->|\()/.exec(value);
    if (split?.index !== undefined) {
      value = value.slice(0, split.index).trim();
    }
  }
  for (const prefix of ["bash ", "sh ", "./"]) {
    if (value.startsWith(prefix)) {
      value = value.slice(prefix.length).trim();
      break;
    }
  }
  value = value.replace(COMMAND_RUNNER_RUN, "$1 ");
  return value.replace(/\s+/g, " ");
}

export function parseOperationRows(lines: string[]): JsonObject[] {
  const rows: JsonObject[] = [];
  for (const line of lines) {
    const stripped = line.trim();
    if (!stripped.startsWith("|")) {
      continue;
    }
    const cells = stripped
      .replace(/^\|+/, "")
      .replace(/\|+$/, "")
      .split(TABLE_CELL_SPLIT)
      .map((cell) => cell.trim());
    if (cells.length < 3) {
      continue;
    }
    const firstCell = cells[0]!;
    const isDivider = [...firstCell].every((character) => ["-", " ", ":"].includes(character));
    if (["Scenario", "场景"].includes(firstCell) || isDivider) {
      continue;
    }
    if (cells.length === 3) {
      cells.push("-");
    }
    rows.push({
      scene: cells[0],
      command: cells[1],
      note: cells.slice(2, -1).join("\\|"),
      evidence: cells.at(-1)!,
    });
  }
  return rows;
}

export function parseAgentIndexSections(content: string): string[] {
  const sections: Array<[string, string[]]> = [];
  let current: [string, string[]] | null = null;
  for (const line of content.split(/\r?\n/)) {
    if (line.startsWith("## ")) {
      if (current !== null) {
        sections.push(current);
      }
      current = [line.slice(3).trim(), [line]];
      continue;
    }
    if (current !== null) {
      current[1].push(line);
    }
  }
  if (current !== null) {
    sections.push(current);
  }
  const preserved: string[] = [];
  for (const [heading, body] of sections) {
    if (DERIVED_INDEX_SECTIONS.has(heading)) {
      continue;
    }
    const text = body.join("\n").trimEnd();
    if (text) {
      preserved.push(text);
    }
  }
  return preserved;
}
