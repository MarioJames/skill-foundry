import { parseArgs } from "node:util";

import { parsePythonFloat, parsePythonInteger } from "./number-utils.ts";

type OptionKind = "string" | "boolean" | "int" | "float";

interface OptionSpec {
  kind?: OptionKind;
  required?: boolean;
  choices?: readonly string[];
  default?: string | number | boolean | null;
  key?: string;
  help?: string;
}

type CommandSpecs = Record<string, Record<string, OptionSpec>>;

const ASSET_TYPES = ["skill", "plugin", "rule", "agent"] as const;
const MODES = ["stop-loss", "collect-first", "hybrid"] as const;
const CLIS = ["claude", "codex"] as const;
const VERDICTS = ["PASS", "CONDITIONAL", "FAIL", "blocked"] as const;
const ROUND_VERDICTS = [...VERDICTS, "running"] as const;

const COMMAND_SPECS: CommandSpecs = {
  bootstrap: {
    name: { required: true },
    type: { required: true, choices: ASSET_TYPES },
    source: { required: true },
    goal: {},
    "goal-file": {},
    strategy: {},
    "strategy-file": {},
    fixture: {},
    "task-prompts-file": {},
  },
  "asset add": {
    name: { required: true },
    type: { required: true, choices: ASSET_TYPES },
    source: { required: true },
  },
  "asset list": {
    type: { choices: ASSET_TYPES },
    name: {},
  },
  "accept new": {
    asset: { required: true },
    goal: {},
    "goal-file": {},
    strategy: {},
    "strategy-file": {},
    fixture: {},
    "task-prompts-file": {},
  },
  "accept update": {
    id: {},
    acceptance: {},
    status: { choices: ["draft", "active", "done"] },
    strategy: {},
    "strategy-file": {},
    "prompt-file": {},
    "criteria-file": {},
    "task-prompts-file": {},
    "ladder-file": {},
    fixture: {},
    "budget-max-rounds": { kind: "int" },
  },
  "accept list": {
    asset: {},
    status: {},
  },
  start: {
    acceptance: { required: true },
    mode: { required: true, choices: MODES },
    n: { kind: "int", default: 1 },
    cli: { choices: CLIS, default: "claude" },
  },
  launch: {
    round: { required: true },
    cli: { choices: CLIS, default: "claude" },
  },
  "round list": {
    acceptance: {},
    verdict: { choices: ROUND_VERDICTS },
  },
  show: {
    acceptance: { required: true },
  },
  "feed-task": {
    acceptance: {},
    round: {},
    task: { required: true },
    pane: {},
  },
  capture: {
    pane: {},
    round: {},
    out: {},
    start: { default: "-2000" },
  },
  wait: {
    round: {},
    pane: {},
    "idle-seconds": { kind: "float", required: true },
    "max-seconds": { kind: "float", required: true },
  },
  record: {
    round: { required: true },
    "transcript-file": {},
    report: {},
  },
  finding: {
    round: {},
    severity: {},
    status: {},
    summary: {},
    key: {},
  },
  "finding add": {
    round: { required: true },
    severity: { required: true },
    status: { required: true },
    summary: { required: true },
    key: { default: null },
  },
  "finding list": {
    round: { required: true },
  },
  finalize: {
    round: { required: true },
    verdict: { required: true, choices: VERDICTS },
    "next-round-reco": {},
    "keep-sandbox": { kind: "boolean", default: false },
    "allow-partial": {},
  },
  cleanup: {
    sandbox: {},
    round: {},
  },
  "profile list": {},
  "profile run-task": {
    acceptance: { required: true },
    task: { required: true },
    mode: { required: true, choices: MODES },
    cli: { choices: CLIS, default: "claude" },
    "wait-seconds": { kind: "float", default: 60 },
    "capture-start": { default: "-2000" },
    "finalize-verdict": { choices: VERDICTS },
    "next-round-reco": {},
  },
  history: {
    asset: { required: true },
  },
};

const TOP_COMMANDS = [
  "bootstrap",
  "asset",
  "accept",
  "start",
  "launch",
  "round",
  "show",
  "feed-task",
  "capture",
  "wait",
  "record",
  "finding",
  "finalize",
  "cleanup",
  "profile",
  "history",
] as const;

const REQUIRED_SUBCOMMANDS: Record<string, readonly string[]> = {
  asset: ["add", "list"],
  accept: ["new", "update", "list"],
  round: ["list"],
  profile: ["list", "run-task"],
};

export interface ParsedCommand {
  path: string;
  options: Record<string, string | number | boolean | null | undefined>;
  positionals: string[];
}

export interface HelpRequest {
  help: string;
}

export class CliUsageError extends Error {
  readonly usage: string;

  constructor(message: string, usage = topUsage()) {
    super(message);
    this.name = "CliUsageError";
    this.usage = usage;
  }
}

function topUsage(): string {
  return `usage: acc [-h] {${TOP_COMMANDS.join(",")}} ...`;
}

function camelCase(value: string): string {
  return value.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function commandPath(argv: string[]): { path: string; offset: number } {
  const command = argv[0];
  if (!command) {
    throw new CliUsageError("the following arguments are required: cmd");
  }
  if (!TOP_COMMANDS.includes(command as typeof TOP_COMMANDS[number])) {
    throw new CliUsageError(
      `argument cmd: invalid choice: '${command}' (choose from ${TOP_COMMANDS.map((item) => `'${item}'`).join(", ")})`,
    );
  }
  const subcommands = REQUIRED_SUBCOMMANDS[command];
  if (subcommands) {
    const subcommand = argv[1];
    if (!subcommand) {
      throw new CliUsageError(
        `the following arguments are required: sub`,
        `usage: acc ${command} {${subcommands.join(",")}} ...`,
      );
    }
    if (!subcommands.includes(subcommand)) {
      throw new CliUsageError(
        `argument sub: invalid choice: '${subcommand}' (choose from ${subcommands.map((item) => `'${item}'`).join(", ")})`,
        `usage: acc ${command} {${subcommands.join(",")}} ...`,
      );
    }
    return { path: `${command} ${subcommand}`, offset: 2 };
  }
  if (command === "finding" && ["add", "list"].includes(argv[1] ?? "")) {
    return { path: `finding ${argv[1]}`, offset: 2 };
  }
  return { path: command, offset: 1 };
}

export function renderHelp(path?: string): string {
  if (!path) {
    return `${topUsage()}\n\ncommands:\n  ${TOP_COMMANDS.join("\n  ")}`;
  }
  const spec = COMMAND_SPECS[path] ?? {};
  const positional = path === "show" ? " {prompt,criteria}" : "";
  const options = Object.entries(spec).map(([name, option]) => {
    const value = option.kind === "boolean" ? "" : ` <${name.replace(/-/g, "_")}>`;
    return `  --${name}${value}${option.required ? " (required)" : ""}`;
  });
  return `usage: acc ${path}${positional} [options]${options.length ? `\n\noptions:\n${options.join("\n")}` : ""}`;
}

function parseNumber(name: string, value: unknown, kind: "int" | "float"): number {
  const raw = String(value);
  if (kind === "int") {
    const parsed = parsePythonInteger(raw);
    if (parsed === null) {
      throw new CliUsageError(`argument --${name}: invalid int value: '${raw}'`);
    }
    return parsed;
  }
  const parsed = parsePythonFloat(raw);
  if (!parsed.ok) {
    throw new CliUsageError(`argument --${name}: invalid float value: '${raw}'`);
  }
  return parsed.value;
}

function normalizeNegativeOptionValues(
  args: string[],
  spec: Record<string, OptionSpec>,
): string[] {
  const normalized: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] as string;
    const name = token.startsWith("--") && !token.includes("=") ? token.slice(2) : null;
    const option = name ? spec[name] : undefined;
    const next = args[index + 1];
    if (option && option.kind !== "boolean" && next?.startsWith("-")
        && parsePythonFloat(next).ok) {
      normalized.push(`${token}=${next}`);
      index += 1;
    } else {
      normalized.push(token);
    }
  }
  return normalized;
}

export function parseCli(argv: string[]): ParsedCommand | HelpRequest {
  if (argv[0] === "-h" || argv[0] === "--help") {
    return { help: renderHelp() };
  }
  let resolved: { path: string; offset: number };
  try {
    resolved = commandPath(argv);
  } catch (error) {
    if (argv.includes("-h") || argv.includes("--help")) {
      const command = argv[0] && TOP_COMMANDS.includes(argv[0] as typeof TOP_COMMANDS[number])
        ? argv[0]
        : undefined;
      return { help: renderHelp(command) };
    }
    throw error;
  }
  if (argv.includes("-h") || argv.includes("--help")) {
    return { help: renderHelp(resolved.path) };
  }
  const spec = COMMAND_SPECS[resolved.path];
  if (!spec) throw new CliUsageError(`unknown command path: ${resolved.path}`);
  const utilOptions: Record<string, { type: "string" | "boolean" }> = {};
  for (const [name, option] of Object.entries(spec)) {
    utilOptions[name] = { type: option.kind === "boolean" ? "boolean" : "string" };
  }
  let values: Record<string, string | boolean | undefined>;
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: normalizeNegativeOptionValues(argv.slice(resolved.offset), spec),
      options: utilOptions,
      allowPositionals: true,
      strict: true,
    });
    values = parsed.values as Record<string, string | boolean | undefined>;
    positionals = parsed.positionals;
  } catch (error) {
    throw new CliUsageError(
      error instanceof Error ? error.message : String(error),
      renderHelp(resolved.path).split("\n\n", 1)[0],
    );
  }
  const options: ParsedCommand["options"] = {};
  for (const [name, option] of Object.entries(spec)) {
    let value: string | number | boolean | null | undefined = values[name];
    if (value === undefined && "default" in option) value = option.default;
    if (option.required && value === undefined) {
      throw new CliUsageError(
        `the following arguments are required: --${name}`,
        renderHelp(resolved.path).split("\n\n", 1)[0],
      );
    }
    if (value !== undefined && value !== null && option.choices
        && !option.choices.includes(String(value))) {
      throw new CliUsageError(
        `argument --${name}: invalid choice: '${value}' (choose from ${option.choices.map((item) => `'${item}'`).join(", ")})`,
        renderHelp(resolved.path).split("\n\n", 1)[0],
      );
    }
    if (value !== undefined && value !== null && (option.kind === "int" || option.kind === "float")) {
      value = parseNumber(name, value, option.kind);
    }
    options[option.key ?? camelCase(name)] = value;
  }
  if (resolved.path === "show") {
    if (positionals.length !== 1) {
      throw new CliUsageError(
        positionals.length ? "unrecognized arguments: " + positionals.slice(1).join(" ") : "the following arguments are required: kind",
        renderHelp(resolved.path).split("\n\n", 1)[0],
      );
    }
    if (!["prompt", "criteria"].includes(positionals[0] as string)) {
      throw new CliUsageError(
        `argument kind: invalid choice: '${positionals[0]}' (choose from 'prompt', 'criteria')`,
        renderHelp(resolved.path).split("\n\n", 1)[0],
      );
    }
  } else if (positionals.length) {
    throw new CliUsageError(
      `unrecognized arguments: ${positionals.join(" ")}`,
      renderHelp(resolved.path).split("\n\n", 1)[0],
    );
  }
  return { path: resolved.path, options, positionals };
}

export function formatUsageError(error: CliUsageError): string {
  return `${error.usage}\nacc: error: ${error.message}`;
}
