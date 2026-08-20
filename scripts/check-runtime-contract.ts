#!/usr/bin/env bun

import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS_ROOT = join(REPOSITORY_ROOT, "skills");
const LEGACY_RUNTIME_EXTENSIONS = new Set([".bash", ".py", ".sh", ".zsh"]);

function walk(root: string): string[] {
  const paths: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) paths.push(...walk(path));
    else if (entry.isFile()) paths.push(path);
  }
  return paths;
}

function gitMode(path: string): string | null {
  const repositoryPath = relative(REPOSITORY_ROOT, path);
  const result = Bun.spawnSync({
    cmd: ["git", "-C", REPOSITORY_ROOT, "ls-files", "-s", "--", repositoryPath],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) return null;
  return result.stdout.toString().trim().split(/\s+/u)[0] || null;
}

function checkRuntimeFiles(errors: string[]): number {
  const runtimeFiles = walk(SKILLS_ROOT).filter((path) => {
    const repositoryPath = `/${relative(REPOSITORY_ROOT, path).replaceAll("\\", "/")}`;
    return repositoryPath.includes("/scripts/") || repositoryPath.includes("/hooks/");
  });
  let entrypoints = 0;

  for (const path of runtimeFiles) {
    const repositoryPath = relative(REPOSITORY_ROOT, path).replaceAll("\\", "/");
    if (LEGACY_RUNTIME_EXTENSIONS.has(extname(path))) {
      errors.push(`${repositoryPath}: bundled scripts and hooks must use Bun/TypeScript`);
      continue;
    }

    const source = readFileSync(path, "utf8");
    if (!source.startsWith("#!")) continue;
    entrypoints += 1;
    if (!source.startsWith("#!/usr/bin/env bun\n")) {
      errors.push(`${repositoryPath}: executable entrypoint must use #!/usr/bin/env bun`);
    }
    const mode = gitMode(path);
    if (mode !== "100755") {
      errors.push(`${repositoryPath}: Git mode must be 100755 (found ${mode ?? "untracked"})`);
    }
    const checked = Bun.spawnSync({
      cmd: [process.execPath, "--check", path],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    if (checked.exitCode !== 0) {
      const detail = checked.stderr.toString().trim().split("\n").at(-1) ?? "syntax check failed";
      errors.push(`${repositoryPath}: ${detail}`);
    }
  }
  return entrypoints;
}

function checkDocumentedCommands(errors: string[]): number {
  const markdownFiles = [join(REPOSITORY_ROOT, "README.md"), ...walk(SKILLS_ROOT).filter((path) => path.endsWith(".md"))];
  let documentedEntrypoints = 0;

  for (const path of markdownFiles) {
    let fenced = false;
    const repositoryPath = relative(REPOSITORY_ROOT, path).replaceAll("\\", "/");
    for (const [index, line] of readFileSync(path, "utf8").split(/\r?\n/u).entries()) {
      if (/^\s*```/u.test(line)) {
        fenced = !fenced;
        continue;
      }
      if (!fenced) continue;
      const trimmed = line.trim().replace(/^[$>]\s+/u, "");
      const firstToken = trimmed.split(/\s+/u)[0]?.replace(/^['"]|['"\\]$/gu, "") ?? "";
      if (!firstToken.includes("/scripts/") || !firstToken.includes(".ts")) continue;
      documentedEntrypoints += 1;
      errors.push(`${repositoryPath}:${index + 1}: invoke TypeScript entrypoints with explicit bun`);
    }
  }
  return documentedEntrypoints;
}

const errors: string[] = [];
const entrypoints = checkRuntimeFiles(errors);
const directDocumentedEntrypoints = checkDocumentedCommands(errors);

if (errors.length > 0) {
  for (const error of errors) console.error(`runtime-contract: ${error}`);
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  runtime: process.execPath,
  entrypoints,
  direct_documented_entrypoints: directDocumentedEntrypoints,
}, null, 2));
