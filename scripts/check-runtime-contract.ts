#!/usr/bin/env bun

import { readFileSync, readdirSync, statSync } from "node:fs";
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
    const trackedMode = gitMode(path);
    const executable = (statSync(path).mode & 0o111) !== 0;
    if ((trackedMode !== null && trackedMode !== "100755") || (trackedMode === null && !executable)) {
      errors.push(`${repositoryPath}: entrypoint mode must be executable (found ${trackedMode ?? "untracked non-executable"})`);
    }
    try {
      const loader = extname(path) === ".tsx" ? "tsx" : "ts";
      new Bun.Transpiler({ loader }).transformSync(source);
    } catch (error) {
      const detail = error instanceof Error ? error.message.split("\n").at(-1) : String(error);
      errors.push(`${repositoryPath}: ${detail || "syntax check failed"}`);
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
      if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(firstToken)) continue;
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
  mode_dependent_documented_entrypoints: directDocumentedEntrypoints,
}, null, 2));
