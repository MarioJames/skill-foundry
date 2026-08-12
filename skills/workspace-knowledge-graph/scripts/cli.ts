#!/usr/bin/env bun

import { basename } from "node:path";

import {
  LEGACY_CONFIG_KEYS,
  loadOrCreateRootConfig,
  normalizeRootConfig,
  prepareRepoModels,
} from "./config.ts";
import {
  CONFIG_PATH,
  DISCOVERY_PATH,
  resolvePath,
  writeJson,
  type JsonObject,
} from "./core.ts";
import { discoverWorkspace } from "./discovery.ts";
import { relationShapeErrors } from "./relations.ts";
import { renderWorkspace } from "./render.ts";
import { bootstrapWorkspace } from "./render_root.ts";
import { validateWorkspace } from "./validate.ts";

type Command = "bootstrap" | "scan" | "init" | "validate";

interface CliArgs {
  command: Command;
  workspace: string;
}

function resolveWorkspace(workspace: string): string {
  return resolvePath(workspace);
}

export function cmdValidate(args: CliArgs): number {
  const workspace = resolveWorkspace(args.workspace);
  const [errors, warnings] = validateWorkspace(workspace);
  if (errors.length === 0 && warnings.length === 0) {
    console.log("工作区图谱校验通过。");
    return 0;
  }
  if (warnings.length > 0) {
    console.log("警告：");
    for (const item of warnings) {
      console.log(`- ${item}`);
    }
  }
  if (errors.length > 0) {
    console.log("错误：");
    for (const item of errors) {
      console.log(`- ${item}`);
    }
    return 1;
  }
  return 0;
}

export function cmdBootstrap(args: CliArgs): number {
  bootstrapWorkspace(resolveWorkspace(args.workspace));
  return 0;
}

export function ensureRepoOrder(
  config: JsonObject,
  discovery: JsonObject,
): JsonObject {
  const detectedOrder = (discovery.repos ?? []).map(
    (repo: JsonObject) => repo.name,
  );
  const declaredOrder = config.workspace?.repo_order ?? [];
  const finalOrder = declaredOrder.filter((name: string) =>
    detectedOrder.includes(name),
  );
  for (const name of detectedOrder) {
    if (!finalOrder.includes(name)) {
      finalOrder.push(name);
    }
  }
  config.workspace ??= {};
  config.workspace.repo_order = finalOrder;
  return config;
}

export function cmdScan(args: CliArgs): number {
  const workspace = resolveWorkspace(args.workspace);
  const discovery = discoverWorkspace(workspace);
  writeJson(`${workspace}/${DISCOVERY_PATH}`, discovery);
  console.log(
    `已写入扫描快照：${DISCOVERY_PATH}（${discovery.repos.length} 个仓库）`,
  );
  for (const repo of discovery.repos) {
    console.log(
      `- ${repo.name}: ${repo.detected_kind}, ${repo.package_manager}`,
    );
  }
  return 0;
}

export function jsonSyntaxError(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return (
    `${CONFIG_PATH} 必须使用 JSON 语法（\`.yaml\` 只是历史遗留的扩展名约定；`
    + `见 references/config-schema.md）：${detail}`
  );
}

export function cmdInit(args: CliArgs): number {
  const workspace = resolveWorkspace(args.workspace);
  bootstrapWorkspace(workspace);
  const discovery = discoverWorkspace(workspace);
  let config: JsonObject;
  try {
    config = loadOrCreateRootConfig(workspace, discovery);
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    console.log(jsonSyntaxError(error));
    return 1;
  }
  const legacyKeys = LEGACY_CONFIG_KEYS.filter((key) => key in config);
  if (legacyKeys.length > 0) {
    console.log(
      `${CONFIG_PATH} 包含遗留声明键 ${legacyKeys.map((key) => `\`${key}\``).join(", ")}：\n`
        + "- 请手动把有用的 `repos` 声明沉淀到 .workspace/repos/<repo>/ 的 Markdown 事实源。\n"
        + "- 请手动把有价值的 `memory_seed` 条目搬进 MEMORY.md。\n"
        + "- 删除这些遗留键后重跑 init。",
    );
    return 1;
  }
  const shapeErrors = relationShapeErrors(config.relations ?? []);
  if (shapeErrors.length > 0) {
    console.log(`${CONFIG_PATH} 的关系声明缺少必需字段，init 拒绝执行：`);
    for (const item of shapeErrors) {
      console.log(`- ${item}`);
    }
    return 1;
  }
  config = normalizeRootConfig(config);
  config = ensureRepoOrder(config, discovery);
  const repoModels = prepareRepoModels(workspace, config, discovery);
  writeJson(`${workspace}/${CONFIG_PATH}`, config);
  renderWorkspace(workspace, config, repoModels, discovery);
  return 0;
}

const COMMANDS: Record<Command, (args: CliArgs) => number> = {
  bootstrap: cmdBootstrap,
  scan: cmdScan,
  init: cmdInit,
  validate: cmdValidate,
};

function rootHelp(program: string): string {
  return [
    `usage: ${program} [-h] {bootstrap,scan,init,validate} ...`,
    "",
    "初始化或刷新工作区文档。",
    "",
    "positional arguments:",
    "  {bootstrap,scan,init,validate}",
    "    bootstrap           创建工作区根骨架和占位文件，只补缺失文件。",
    "    scan                扫描工作区并输出 discovery JSON。",
    "    init                缺配置时创建配置，并渲染工作区文档。",
    "    validate            校验生成的工作区文档和本地链接。",
    "",
    "options:",
    "  -h, --help            show this help message and exit",
  ].join("\n");
}

function commandHelp(program: string, command: Command): string {
  return [
    `usage: ${program} ${command} [-h] --workspace WORKSPACE`,
    "",
    "options:",
    "  -h, --help            show this help message and exit",
    "  --workspace WORKSPACE",
  ].join("\n");
}

function fail(program: string, message: string, command?: Command): never {
  const usage = command
    ? `usage: ${program} ${command} [-h] --workspace WORKSPACE`
    : `usage: ${program} [-h] {bootstrap,scan,init,validate} ...`;
  const errorProgram = command ? `${program} ${command}` : program;
  console.error(usage);
  console.error(`${errorProgram}: error: ${message}`);
  process.exit(2);
}

export function parseArgs(argv: string[]): CliArgs | null {
  const program = basename(process.argv[1] ?? "workspace_graph.ts");
  if (argv.length === 0) {
    fail(program, "the following arguments are required: command");
  }
  if (argv[0] === "-h" || argv[0] === "--help") {
    console.log(rootHelp(program));
    return null;
  }
  const command = argv[0] as Command;
  if (!(command in COMMANDS)) {
    fail(
      program,
      `argument command: invalid choice: '${argv[0]}' (choose from 'bootstrap', 'scan', 'init', 'validate')`,
    );
  }
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(commandHelp(program, command));
    return null;
  }
  let workspace: string | undefined;
  const unrecognized: string[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    const item = argv[index]!;
    if (item === "--workspace") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) {
        fail(program, "argument --workspace: expected one argument", command);
      }
      workspace = value;
      index += 1;
      continue;
    }
    if (item.startsWith("--workspace=")) {
      workspace = item.slice("--workspace=".length);
      continue;
    }
    unrecognized.push(item);
  }
  if (workspace === undefined) {
    fail(
      program,
      "the following arguments are required: --workspace",
      command,
    );
  }
  if (unrecognized.length > 0) {
    fail(program, `unrecognized arguments: ${unrecognized.join(" ")}`);
  }
  return { command, workspace };
}

export function main(argv = process.argv.slice(2)): number {
  const args = parseArgs(argv);
  return args === null ? 0 : COMMANDS[args.command](args);
}
