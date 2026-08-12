#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

import {
  IGNORED_DIRS,
  isDirectory,
  readJson,
  readText,
  shell,
  sortedDirectory,
  toPosix,
  utcNow,
  walkFiles,
  type JsonObject,
} from "./core.ts";

function isRecord(value: any): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isEmptyRecord(value: JsonObject): boolean {
  return Object.keys(value).length === 0;
}

export function listGitRepos(workspace: string): string[] {
  const repos: string[] = [];
  for (const child of sortedDirectory(workspace)) {
    const childPath = join(workspace, child.name);
    if (isDirectory(childPath) && existsSync(join(childPath, ".git"))) {
      repos.push(childPath);
    }
  }
  return repos;
}

export function countSourceFiles(
  root: string,
  patterns: Record<string, string>,
): Record<string, number> {
  const counts = Object.fromEntries(Object.keys(patterns).map((key) => [key, 0]));
  for (const path of walkFiles(root, { ignoredDirs: IGNORED_DIRS })) {
    const fileName = basename(path);
    for (const [key, pattern] of Object.entries(patterns)) {
      if (pattern.startsWith("*.") && fileName.endsWith(pattern.slice(1))) {
        counts[key] = (counts[key] ?? 0) + 1;
      }
    }
  }
  return counts;
}

export function readFirstHeading(path: string): string | null {
  if (!existsSync(path)) {
    return null;
  }
  for (const line of readText(path).split(/\r?\n/)) {
    const stripped = line.trim();
    if (stripped.startsWith("#")) {
      return stripped.replace(/^#+/, "").trim();
    }
  }
  return null;
}

export function parsePackageJson(path: string): JsonObject {
  return existsSync(path) ? readJson<JsonObject>(path) : {};
}

export function parsePomModules(path: string): string[] {
  if (!existsSync(path)) {
    return [];
  }
  return [...readText(path).matchAll(/<module>([^<]+)<\/module>/g)].map(
    (match) => match[1]!,
  );
}

export function listPageGroups(repoRoot: string): string[] {
  const pagesDir = join(repoRoot, "src/pages");
  if (!existsSync(pagesDir)) {
    return [];
  }
  return sortedDirectory(pagesDir)
    .filter((entry) => isDirectory(join(pagesDir, entry.name)))
    .map((entry) => entry.name);
}

export function listRouteFiles(repoRoot: string): string[] {
  const routesDir = join(repoRoot, "config/routes");
  if (!existsSync(routesDir)) {
    return [];
  }
  return sortedDirectory(routesDir)
    .filter((entry) => entry.name.endsWith(".ts") && entry.name !== "index.ts")
    .map((entry) => toPosix(relative(repoRoot, join(routesDir, entry.name))));
}

export function listServiceTargets(repoRoot: string): string[] {
  const servicesDir = join(repoRoot, "src/services");
  if (!existsSync(servicesDir)) {
    return [];
  }
  return sortedDirectory(servicesDir)
    .filter((entry) => isDirectory(join(servicesDir, entry.name)))
    .map((entry) => entry.name);
}

export function parsePnpmWorkspaceGlobs(path: string): string[] {
  if (!existsSync(path)) {
    return [];
  }
  const globs: string[] = [];
  let inPackages = false;
  for (const rawLine of readText(path).split(/\r?\n/)) {
    const hashIndex = rawLine.indexOf("#");
    const line = (hashIndex >= 0 ? rawLine.slice(0, hashIndex) : rawLine).trimEnd();
    if (!line.trim()) {
      continue;
    }
    const stripped = line.trim();
    if (!line.startsWith(" ") && !line.startsWith("\t") && !stripped.startsWith("- ")) {
      inPackages = stripped === "packages:";
      continue;
    }
    if (inPackages && stripped.startsWith("- ")) {
      const value = stripped
        .slice(2)
        .trim()
        .replace(/^['"]+|['"]+$/g, "");
      if (value && !value.startsWith("!")) {
        globs.push(value);
      }
    }
  }
  return globs;
}

export function packageWorkspaceGlobs(packageJson: JsonObject): string[] {
  let workspaces = packageJson.workspaces;
  if (isRecord(workspaces)) {
    workspaces = workspaces.packages;
  }
  if (!Array.isArray(workspaces)) {
    return [];
  }
  return workspaces.filter(
    (item): item is string =>
      typeof item === "string" && Boolean(item) && !item.startsWith("!"),
  );
}

export function listWorkspacePackages(
  repoRoot: string,
  packageJson: JsonObject,
): string[] {
  const globs = parsePnpmWorkspaceGlobs(join(repoRoot, "pnpm-workspace.yaml"));
  for (const item of packageWorkspaceGlobs(packageJson)) {
    if (!globs.includes(item)) {
      globs.push(item);
    }
  }
  if (globs.length === 0) {
    globs.push("packages/*", "apps/*");
  }
  const names: string[] = [];
  for (const pattern of globs) {
    if (pattern.startsWith("/") || pattern.startsWith("..")) {
      continue;
    }
    const manifestPattern = `${pattern.replace(/\/+$/, "")}/package.json`;
    const manifests = [
      ...new Bun.Glob(manifestPattern).scanSync({
        cwd: repoRoot,
        absolute: true,
        onlyFiles: true,
        followSymlinks: false,
      }),
    ].sort();
    for (const manifest of manifests) {
      if (manifest.split(/[\\/]/).includes("node_modules")) {
        continue;
      }
      const name = parsePackageJson(manifest).name;
      if (name && !names.includes(name)) {
        names.push(name);
      }
    }
  }
  return names;
}

export function detectRepoKind(repoRoot: string, packageJson: JsonObject): string {
  if (existsSync(join(repoRoot, "pom.xml"))) {
    return "maven-service";
  }
  if (existsSync(join(repoRoot, "config/config.ts"))) {
    return "bigfish-console";
  }
  if (
    existsSync(join(repoRoot, "pnpm-workspace.yaml"))
    || packageWorkspaceGlobs(packageJson).length > 0
  ) {
    return "node-monorepo";
  }
  if (existsSync(join(repoRoot, "package.json"))) {
    return "node-repo";
  }
  return "unknown";
}

export function shellScriptsArePrimary(
  packageJson: JsonObject,
  repoRoot: string,
): boolean {
  if (isEmptyRecord(packageJson)) {
    return false;
  }
  if (
    ![join(repoRoot, "build.sh"), join(repoRoot, "release.sh")].some((path) =>
      existsSync(path),
    )
  ) {
    return false;
  }
  const scripts = packageJson.scripts ?? {};
  if (!isRecord(scripts)) {
    return true;
  }
  const npmWorkflowScripts = new Set(["dev", "start", "build", "test", "lint"]);
  return !Object.keys(scripts).some((name) => npmWorkflowScripts.has(name));
}

export function detectPackageManager(
  packageJson: JsonObject,
  repoRoot: string,
  detectedKind: string,
): string {
  if (detectedKind === "maven-service") {
    return "maven";
  }
  const packageManager = packageJson.packageManager;
  if (typeof packageManager === "string" && packageManager) {
    return packageManager;
  }
  if (existsSync(join(repoRoot, "pnpm-workspace.yaml"))) {
    return "pnpm";
  }
  if (isEmptyRecord(packageJson)) {
    return "N/A";
  }
  if (shellScriptsArePrimary(packageJson, repoRoot)) {
    return "shell-scripts";
  }
  for (const [lockfile, manager] of [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["package-lock.json", "npm"],
  ] as const) {
    if (existsSync(join(repoRoot, lockfile))) {
      return manager;
    }
  }
  return "tnpm";
}

export function collectManifestPaths(repoRoot: string): string[] {
  const candidates = [
    "package.json",
    "pom.xml",
    "pnpm-workspace.yaml",
    "build.gradle",
    "build.gradle.kts",
    "go.mod",
    "Cargo.toml",
    "pyproject.toml",
    "README.md",
    "config/config.ts",
  ];
  return candidates.filter((path) => existsSync(join(repoRoot, path)));
}

export function findRepoFiles(repoRoot: string, filename: string): string[] {
  return [...walkFiles(repoRoot, { ignoredDirs: IGNORED_DIRS })].filter(
    (path) => basename(path) === filename,
  );
}

function readUtf8Strict(path: string): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
}

function isUnicodeWord(character: string | undefined): boolean {
  return character !== undefined && /^[\p{L}\p{N}_]$/u.test(character);
}

function countBoundedLiteral(content: string, literal: string): number {
  const literalCharacters = [...literal];
  const first = literalCharacters[0];
  const last = literalCharacters.at(-1);
  if (first === undefined || last === undefined) {
    return 0;
  }
  let count = 0;
  let offset = 0;
  while (offset <= content.length - literal.length) {
    const index = content.indexOf(literal, offset);
    if (index < 0) {
      break;
    }
    const before = [...content.slice(0, index)].at(-1);
    const after = [...content.slice(index + literal.length)][0];
    if (
      isUnicodeWord(before) !== isUnicodeWord(first)
      && isUnicodeWord(last) !== isUnicodeWord(after)
    ) {
      count += 1;
    }
    offset = index + literal.length;
  }
  return count;
}

export function siblingMentions(
  repoRoot: string,
  siblingNames: string[],
): Record<string, JsonObject> {
  const files = findRepoFiles(repoRoot, "pom.xml");
  if (existsSync(join(repoRoot, "config/config.ts"))) {
    files.push(join(repoRoot, "config/config.ts"));
  }
  const mentions: Record<string, JsonObject> = {};
  for (const sibling of siblingNames) {
    let total = 0;
    const matched: string[] = [];
    for (const path of files) {
      let content: string;
      try {
        content = readUtf8Strict(path);
      } catch {
        continue;
      }
      const count = countBoundedLiteral(content, sibling);
      if (count > 0) {
        total += count;
        matched.push(toPosix(relative(repoRoot, path)));
      }
    }
    if (total > 0) {
      mentions[sibling] = { count: total, files: matched.sort() };
    }
  }
  return mentions;
}

export function buildRepoScan(
  repoRoot: string,
  siblingNames: string[],
): JsonObject {
  const packageJson = parsePackageJson(join(repoRoot, "package.json"));
  const readmeTitle = readFirstHeading(join(repoRoot, "README.md"));
  const detectedKind = detectRepoKind(repoRoot, packageJson);
  const scripts = isRecord(packageJson.scripts) ? packageJson.scripts : {};
  return {
    name: basename(repoRoot),
    path: repoRoot,
    remote: shell("git", "remote", "get-url", "origin", { cwd: repoRoot }),
    detected_kind: detectedKind,
    package_manager: detectPackageManager(packageJson, repoRoot, detectedKind),
    manifests: collectManifestPaths(repoRoot),
    readme_title: readmeTitle,
    counts: countSourceFiles(repoRoot, {
      java_files: "*.java",
      kt_files: "*.kt",
      ts_files: "*.ts",
      tsx_files: "*.tsx",
      py_files: "*.py",
      go_files: "*.go",
      rs_files: "*.rs",
    }),
    package: {
      name: packageJson.name ?? null,
      scripts: Object.keys(scripts).sort(),
      script_commands: scripts,
    },
    frontend: {
      page_groups: listPageGroups(repoRoot),
      route_files: listRouteFiles(repoRoot),
      service_targets: listServiceTargets(repoRoot),
    },
    backend: {
      modules: parsePomModules(join(repoRoot, "pom.xml")),
    },
    monorepo: {
      packages: listWorkspacePackages(repoRoot, packageJson),
    },
    sibling_mentions: siblingMentions(repoRoot, siblingNames),
  };
}

export function repoMap(discovery: JsonObject): Record<string, JsonObject> {
  return Object.fromEntries(
    (discovery.repos ?? []).map((repo: JsonObject) => [repo.name, repo]),
  );
}

export function discoverWorkspace(workspace: string): JsonObject {
  const repos = listGitRepos(workspace);
  const siblingNames = repos.map((repo) => basename(repo));
  const scanned = repos.map((repo) =>
    buildRepoScan(
      repo,
      siblingNames.filter((name) => name !== basename(repo)),
    ),
  );
  return {
    generated_at: utcNow(),
    workspace: {
      name: basename(resolve(workspace)),
      path: resolve(workspace),
      repo_count: repos.length,
    },
    repos: scanned,
  };
}
