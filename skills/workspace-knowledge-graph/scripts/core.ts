#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export type JsonObject = Record<string, any>;

export const CONFIG_PATH = ".workspace/metadata.yaml";
export const DISCOVERY_PATH = ".workspace/state/discovery.json";
export const RELATION_REGISTRY_PATH = ".workspace/relations/registry.yaml";
export const RELATION_INDEX_PATH = ".workspace/relations/index.md";
export const WORKSPACE_INDEX_PATH = ".workspace/index.md";
export const REPO_DOCS_PATH = ".workspace/repos";
export const ROOT_DOC_PATHS = ["AGENTS.md", "CLAUDE.md", "MEMORY.md"] as const;
export const MEMORY_DAILY_PATH = ".workspace/memory/daily";
export const IGNORED_DIRS = new Set([
  ".git",
  ".idea",
  ".vscode",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  "target",
  "vendor",
  "__pycache__",
  ".venv",
  ".workspace",
]);

export function utcNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

export function readText(path: string): string {
  return readFileSync(path, "utf8");
}

export function readJson<T = any>(path: string): T {
  return JSON.parse(readText(path)) as T;
}

export function writeText(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${content.trimEnd()}\n`, "utf8");
}

export function writeJson(path: string, data: any): void {
  writeText(path, JSON.stringify(data, null, 2));
}

export function toPosix(path: string): string {
  return path.split(sep).join("/");
}

export function resolvePath(path: string): string {
  let cursor = resolve(path);
  const missingParts: string[] = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) {
      return resolve(path);
    }
    missingParts.unshift(basename(cursor));
    cursor = parent;
  }
  return join(realpathSync(cursor), ...missingParts);
}

export function relLink(fromPath: string, target: string): string {
  return toPosix(relative(dirname(fromPath), target));
}

export function mdLink(label: string, fromPath: string, target: string): string {
  return `[${label}](${relLink(fromPath, target)})`;
}

export function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", "<br>");
}

export function renderCategoryCell(value: string): string {
  const escaped = escapeCell(value);
  return value.includes("`") ? escaped : `\`${escaped}\``;
}

export function unescapeCell(value: string): string {
  return value.replaceAll("\\|", "|").replaceAll("<br>", "\n").trim();
}

export function stripInlineLinks(value: string): string {
  return value.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
}

export function renderEvidenceList(
  evidence: string[],
  docAbs: string,
  workspace: string,
): string {
  if (evidence.length === 0) {
    return "-";
  }
  const rendered: string[] = [];
  for (const item of evidence) {
    if (item.startsWith("mention_count=")) {
      rendered.push(`\`${item}\``);
      continue;
    }
    const target = `${workspace}/${item}`;
    if (existsSync(target)) {
      rendered.push(`[\`${item}\`](${relLink(docAbs, target)})`);
    } else {
      rendered.push(`\`${item}\``);
    }
  }
  return rendered.join(", ");
}

export function stripAnchor(target: string): string {
  return target.split("#", 1)[0] ?? "";
}

export function isExternalLink(target: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(target) || target.startsWith("mailto:");
}

export function extractMarkdownLinks(content: string): string[] {
  return [...content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((match) => match[1]!);
}

export function extractMarkdownLinkPairs(content: string): Array<[string, string]> {
  return [...content.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)].map((match) => [
    match[1]!,
    match[2]!,
  ]);
}

export function ensureMemoryDailyDir(workspace: string): void {
  const dailyDir = `${workspace}/${MEMORY_DAILY_PATH}`;
  mkdirSync(dailyDir, { recursive: true });
  const gitkeep = `${dailyDir}/.gitkeep`;
  if (!existsSync(gitkeep)) {
    writeFileSync(gitkeep, "", "utf8");
  }
}

export function shell(...input: Array<string | { cwd?: string }>): string {
  let cwd: string | undefined;
  if (typeof input.at(-1) === "object") {
    cwd = (input.pop() as { cwd?: string }).cwd;
  }
  const args = input as string[];
  const command = args[0];
  if (command === undefined) {
    throw new TypeError("shell requires a command");
  }
  const result = spawnSync(command, args.slice(1), {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    return "";
  }
  return (result.stdout ?? "").trim();
}

export function pathExists(path: string): boolean {
  return existsSync(path);
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function sortedDirectory(path: string) {
  return readdirSync(path, { withFileTypes: true }).sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
}

export function* walkFiles(
  root: string,
  options: {
    ignoredDirs?: ReadonlySet<string>;
    skipHiddenDirs?: boolean;
  } = {},
): Generator<string> {
  const ignoredDirs = options.ignoredDirs ?? IGNORED_DIRS;
  let entries;
  try {
    entries = sortedDirectory(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = `${root}/${entry.name}`;
    if (entry.isDirectory()) {
      if (
        ignoredDirs.has(entry.name)
        || (options.skipHiddenDirs === true && entry.name.startsWith("."))
      ) {
        continue;
      }
      yield* walkFiles(fullPath, options);
      continue;
    }
    if (entry.isSymbolicLink()) {
      try {
        if (statSync(fullPath).isDirectory()) {
          continue;
        }
      } catch {
        continue;
      }
    }
    yield fullPath;
  }
}
