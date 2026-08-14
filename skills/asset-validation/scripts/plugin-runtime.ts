import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join, parse } from "node:path";

import { prepareRoundEnvironment } from "./envprep.ts";

export interface PluginInstall {
  installed: boolean;
  name?: string;
  reason?: string;
  plugin_dir?: string;
  settings?: string;
  cli_args?: string[];
  skills?: string[];
  agents?: string[];
  asset_type?: string;
  [key: string]: unknown;
}

function pathExistsOrIsSymlink(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function removeEntry(path: string): void {
  const stats = lstatSync(path);
  if (stats.isDirectory() && !stats.isSymbolicLink()) {
    rmSync(path, { recursive: true });
  } else {
    unlinkSync(path);
  }
}

function copyEntry(source: string, destination: string): void {
  if (statSync(source).isDirectory()) {
    if (pathExistsOrIsSymlink(destination)) removeEntry(destination);
    const copySource = lstatSync(source).isSymbolicLink() ? realpathSync(source) : source;
    cpSync(copySource, destination, {
      recursive: true,
      force: true,
      dereference: false,
      verbatimSymlinks: true,
    });
  } else {
    mkdirSync(join(destination, ".."), { recursive: true });
    copyFileSync(source, destination);
  }
}

function installManifestPath(sandbox: string): string {
  return join(sandbox, ".aut-acceptance", "plugin-install.json");
}

function readInstallManifest(sandbox: string): Record<string, unknown> {
  const path = installManifestPath(sandbox);
  if (!existsSync(path)) return {};
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return typeof data === "object" && data !== null && !Array.isArray(data)
      ? data as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function writeInstallManifest(sandbox: string, manifest: Record<string, unknown>): void {
  const path = installManifestPath(sandbox);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(manifest, null, 2), "utf8");
}

function claudePluginManifestPath(pluginDirectory: string): string {
  return join(pluginDirectory, ".claude-plugin", "plugin.json");
}

function ensureClaudePluginManifest(pluginDirectory: string, pluginName: string): string {
  const destination = claudePluginManifestPath(pluginDirectory);
  if (existsSync(destination)) return destination;

  const manifest: Record<string, unknown> = {
    name: pluginName,
    version: "1.0.0",
    description: `Acceptance-isolated staging plugin for ${pluginName}.`,
    author: { name: "asset-validation" },
  };
  for (const candidate of [
    join(pluginDirectory, "plugin.json"),
    join(pluginDirectory, ".codex-plugin", "plugin.json"),
  ]) {
    if (!existsSync(candidate)) continue;
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8"));
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const source = parsed as Record<string, unknown>;
        for (const key of [
          "version", "description", "author", "homepage", "repository", "license", "keywords",
        ]) {
          if (key in source) manifest[key] = source[key];
        }
        break;
      }
    } catch {
      // Fall back to the minimal generated manifest.
    }
  }
  mkdirSync(join(destination, ".."), { recursive: true });
  writeFileSync(destination, JSON.stringify(manifest, null, 2), "utf8");
  return destination;
}

function sessionIsolationPrompt(kind: string, names: string[]): string {
  const listed = names.length ? names.join(", ") : kind;
  return "Acceptance sandbox isolation: use only the asset staged through this "
    + `session plugin (${kind}: ${listed}). Do not use same-name global skills, `
    + "agents, or files under $HOME/.claude/skills as the asset source when a "
    + "staged copy exists under ACCEPTANCE_SANDBOX. A slash token such as "
    + "/asset-validation denotes a Claude skill name in the user task, not a "
    + "shell command or npm package. Never print settings files, auth tokens, or "
    + "secret environment values; report paths only.";
}

function readPluginName(source: string, fallback?: string): string {
  for (const manifest of [
    claudePluginManifestPath(source),
    join(source, ".codex-plugin", "plugin.json"),
    join(source, "plugin.json"),
  ]) {
    if (!existsSync(manifest)) continue;
    try {
      const data = JSON.parse(readFileSync(manifest, "utf8")) as Record<string, unknown>;
      if (data.name) return String(data.name);
    } catch {
      // Try the next supported manifest location.
    }
  }
  return fallback || basename(source);
}

function frontmatterName(path: string): string | null {
  try {
    let inFrontmatter = false;
    for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (line === "---") {
        if (!inFrontmatter) {
          inFrontmatter = true;
          continue;
        }
        break;
      }
      if (inFrontmatter && line.startsWith("name:")) {
        const name = line.slice(line.indexOf(":") + 1).trim().replace(/^["']|["']$/g, "");
        if (name) return name;
      }
    }
  } catch {
    // Fall through to the caller's fallback.
  }
  return null;
}

function readSkillName(source: string, fallback?: string): string {
  const name = frontmatterName(join(source, "SKILL.md"));
  return name || fallback || basename(source);
}

function readAgentName(source: string, fallback?: string): string {
  const candidates: string[] = [];
  if (existsSync(source) && statSync(source).isFile() && extname(source) === ".md") {
    candidates.push(source);
  }
  const agentsDirectory = join(source, "agents");
  if (existsSync(agentsDirectory)) {
    candidates.push(
      ...readdirSync(agentsDirectory)
        .filter((child) => extname(child) === ".md")
        .sort()
        .map((child) => join(agentsDirectory, child)),
    );
  }
  for (const candidate of candidates) {
    const name = frontmatterName(candidate);
    if (name) return name;
  }
  return fallback || parse(source).name;
}

function childNames(path: string): string[] {
  return existsSync(path) ? readdirSync(path).sort() : [];
}

export function installPluginSource(
  sandbox: string,
  sourcePath: string,
  options: { name?: string } = {},
): PluginInstall {
  if (!existsSync(sourcePath)) {
    return { installed: false, reason: `source not found: ${sourcePath}` };
  }
  const env = prepareRoundEnvironment(sandbox);
  const pluginName = readPluginName(sourcePath, options.name);
  const pluginDirectory = join(env.ACCEPTANCE_SANDBOX, ".iso", "claude-plugins", pluginName);
  copyEntry(sourcePath, pluginDirectory);
  ensureClaudePluginManifest(pluginDirectory, pluginName);
  const skills = childNames(join(sourcePath, "skills"));
  const agents = childNames(join(sourcePath, "agents"));
  const settings = env.CMDAI_CLAUDE_SETTINGS_PATH;
  const cliArgs = [
    "--bare",
    "--append-system-prompt",
    sessionIsolationPrompt("plugin", [...skills, ...agents]),
    "--settings",
    settings,
    "--plugin-dir",
    pluginDirectory,
  ];
  const manifest = {
    name: pluginName,
    source: sourcePath,
    plugin_dir: pluginDirectory,
    settings,
    skills,
    agents,
    cli_args: cliArgs,
  };
  writeInstallManifest(sandbox, manifest);
  return { installed: true, ...manifest };
}

export function installAgentSource(
  sandbox: string,
  sourcePath: string,
  options: { name?: string } = {},
): PluginInstall {
  if (!existsSync(sourcePath)) {
    return { installed: false, reason: `source not found: ${sourcePath}` };
  }
  const env = prepareRoundEnvironment(sandbox);
  const agentName = readAgentName(sourcePath, options.name);
  const pluginName = `acc-agent-${agentName}`;
  const pluginDirectory = join(
    env.ACCEPTANCE_SANDBOX,
    ".iso",
    "claude-agent-plugins",
    pluginName,
  );
  const agentsDestination = join(pluginDirectory, "agents");
  if (existsSync(join(sourcePath, "agents"))) {
    copyEntry(join(sourcePath, "agents"), agentsDestination);
  } else if (statSync(sourcePath).isFile() && extname(sourcePath) === ".md") {
    copyEntry(sourcePath, join(agentsDestination, basename(sourcePath)));
  }
  mkdirSync(pluginDirectory, { recursive: true });
  ensureClaudePluginManifest(pluginDirectory, pluginName);
  const agents = childNames(agentsDestination);
  const settings = env.CMDAI_CLAUDE_SETTINGS_PATH;
  const cliArgs = [
    "--bare",
    "--append-system-prompt",
    sessionIsolationPrompt("agent", agents),
    "--settings",
    settings,
    "--plugin-dir",
    pluginDirectory,
  ];
  const manifest = {
    name: pluginName,
    source: sourcePath,
    plugin_dir: pluginDirectory,
    settings,
    skills: [] as string[],
    agents,
    cli_args: cliArgs,
    staged_asset_type: "agent",
  };
  writeInstallManifest(sandbox, manifest);
  return {
    installed: true,
    name: pluginName,
    plugin_dir: pluginDirectory,
    settings,
    cli_args: cliArgs,
    skills: [],
    agents,
  };
}

export function installSkillSource(
  sandbox: string,
  sourcePath: string,
  options: { name?: string } = {},
): PluginInstall {
  if (!existsSync(sourcePath)) {
    return { installed: false, reason: `source not found: ${sourcePath}` };
  }
  const env = prepareRoundEnvironment(sandbox);
  const skillName = readSkillName(sourcePath, options.name);
  const pluginName = `acc-skill-${skillName}`;
  const pluginDirectory = join(
    env.ACCEPTANCE_SANDBOX,
    ".iso",
    "claude-skill-plugins",
    pluginName,
  );
  const skillDirectory = join(pluginDirectory, "skills", skillName);
  copyEntry(sourcePath, skillDirectory);
  mkdirSync(pluginDirectory, { recursive: true });
  ensureClaudePluginManifest(pluginDirectory, pluginName);
  const settings = env.CMDAI_CLAUDE_SETTINGS_PATH;
  const cliArgs = [
    "--bare",
    "--append-system-prompt",
    sessionIsolationPrompt("skill", [skillName]),
    "--settings",
    settings,
    "--plugin-dir",
    pluginDirectory,
  ];
  const manifest = {
    name: pluginName,
    source: sourcePath,
    plugin_dir: pluginDirectory,
    settings,
    skills: [skillName],
    agents: [] as string[],
    cli_args: cliArgs,
    staged_asset_type: "skill",
  };
  writeInstallManifest(sandbox, manifest);
  return {
    installed: true,
    name: pluginName,
    plugin_dir: pluginDirectory,
    settings,
    cli_args: cliArgs,
    skills: [skillName],
    agents: [],
  };
}

export function installCodexSkillSource(
  sandbox: string,
  sourcePath: string,
  options: { name?: string } = {},
): PluginInstall {
  if (!existsSync(sourcePath)) {
    return { installed: false, reason: `source not found: ${sourcePath}` };
  }
  const env = prepareRoundEnvironment(sandbox);
  const skillName = readSkillName(sourcePath, options.name);
  const skillDirectory = join(
    env.ACCEPTANCE_SANDBOX,
    ".agents",
    "skills",
    skillName,
  );
  copyEntry(sourcePath, skillDirectory);
  const sourceSkill = statSync(sourcePath).isDirectory()
    ? join(sourcePath, "SKILL.md")
    : sourcePath;
  const cliArgs = [
    "-c",
    `skills.config=[{path=${JSON.stringify(sourceSkill)},enabled=false}]`,
  ];
  const manifest = {
    name: skillName,
    source: sourcePath,
    plugin_dir: skillDirectory,
    skill_dir: skillDirectory,
    settings: null,
    skills: [skillName],
    agents: [] as string[],
    cli_args: cliArgs,
    staged_asset_type: "skill",
    staging: "codex-repo-skill",
  };
  writeInstallManifest(sandbox, manifest);
  return { installed: true, ...manifest };
}

export function cleanupPluginInstall(sandbox: string): Record<string, unknown> | null {
  const manifest = readInstallManifest(sandbox);
  if (!Object.keys(manifest).length) return null;
  const rawPluginDirectory = manifest.plugin_dir;
  const pluginDirectory = rawPluginDirectory ? String(rawPluginDirectory) : null;
  let removedPluginDirectory = false;
  if (pluginDirectory && existsSync(pluginDirectory)) {
    removeEntry(pluginDirectory);
    removedPluginDirectory = true;
  }
  try {
    unlinkSync(installManifestPath(sandbox));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return {
    name: manifest.name ?? null,
    removed_plugin_dir: removedPluginDirectory,
    plugin_dir: pluginDirectory,
    skills: manifest.skills ?? [],
    agents: manifest.agents ?? [],
  };
}
