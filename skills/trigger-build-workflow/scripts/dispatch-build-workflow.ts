#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { detectBuildWorkflow, type WorkflowDetection } from "./lib/workflow";

type Options = {
  repo: string;
  workflow?: string;
  environment?: string;
  version: string;
  changelogJsonFile?: string;
  changelogJson?: string;
  changelogFile?: string;
  changelog?: string;
  changelogSummary?: string;
  changelogSummaryFile?: string;
  message?: string;
  paths: string[];
  remote: string;
  branch?: string;
  watch: boolean;
  dryRun: boolean;
};

type Changelog = {
  full: string;
  summary: string;
  content: string;
};

function usage(): void {
  console.log(`Usage:
  dispatch-build-workflow.ts [options]

Options:
  --repo <path>              Git repo path. Defaults to current directory.
  --workflow <file>          Select a workflow explicitly. Defaults to safe auto-detection.
  --environment <env>        beta or production. Defaults from --version.
  --version <version>        Production semver X.Y.Z/vX.Y.Z. Non-semver selects beta.
  --changelog-json-file <path>
  --changelog-json <json>    JSON with changelog, changelog_summary, changelog_content.
  --changelog-file <path>    Markdown, or JSON auto-detected by a leading "{".
  --changelog <text>         Legacy Markdown changelog text.
  --changelog-summary <text>
  --changelog-summary-file <path>
  --message <message>        Commit message. Defaults from the selected mode.
  --path <path>              Stage only this path. Repeatable. Defaults to git add -A.
  --remote <name>            Git remote to push. Defaults to origin.
  --branch <name>            Branch/ref to push and dispatch. Defaults to current branch.
  --no-watch                 Dispatch without waiting for completion.
  --dry-run                  Print actions without committing, pushing, or dispatching.
  -h, --help                 Show this help.

When no compatible build workflow exists, the command succeeds in git-only
mode and performs only the normal stage, commit, and push path.`);
}

function die(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function readValue(args: string[], index: number, option: string): [string, number] {
  const value = args[index + 1];
  if (!value) die(`${option} requires a value`);
  return [value, index + 1];
}

function parseArgs(args: string[]): Options {
  const options: Options = {
    repo: ".",
    version: "",
    paths: [],
    remote: "origin",
    watch: true,
    dryRun: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    let value: string;

    switch (argument) {
      case "--repo":
        [value, index] = readValue(args, index, argument);
        options.repo = value;
        break;
      case "--workflow":
        [value, index] = readValue(args, index, argument);
        options.workflow = value;
        break;
      case "--environment":
      case "--env":
        [value, index] = readValue(args, index, argument);
        options.environment = value;
        break;
      case "--version":
        [value, index] = readValue(args, index, argument);
        options.version = value;
        break;
      case "--changelog-json-file":
        [value, index] = readValue(args, index, argument);
        options.changelogJsonFile = value;
        break;
      case "--changelog-json":
        [value, index] = readValue(args, index, argument);
        options.changelogJson = value;
        break;
      case "--changelog-file":
        [value, index] = readValue(args, index, argument);
        options.changelogFile = value;
        break;
      case "--changelog":
        [value, index] = readValue(args, index, argument);
        options.changelog = value;
        break;
      case "--changelog-summary":
        [value, index] = readValue(args, index, argument);
        options.changelogSummary = value;
        break;
      case "--changelog-summary-file":
        [value, index] = readValue(args, index, argument);
        options.changelogSummaryFile = value;
        break;
      case "--message":
      case "-m":
        [value, index] = readValue(args, index, argument);
        options.message = value;
        break;
      case "--path":
        [value, index] = readValue(args, index, argument);
        options.paths.push(value);
        break;
      case "--remote":
        [value, index] = readValue(args, index, argument);
        options.remote = value;
        break;
      case "--branch":
        [value, index] = readValue(args, index, argument);
        options.branch = value;
        break;
      case "--no-watch":
        options.watch = false;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "-h":
      case "--help":
        usage();
        process.exit(0);
      default:
        die(`unknown argument: ${argument}`);
    }
  }

  return options;
}

function capture(command: string[], cwd?: string, allowFailure = false): { code: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const output = {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
  if (!allowFailure && output.code !== 0) {
    die(`${command[0]} failed: ${(output.stderr || output.stdout).trim() || `exit ${output.code}`}`);
  }
  return output;
}

function run(command: string[], cwd?: string): void {
  const result = Bun.spawnSync(command, { cwd, stdout: "inherit", stderr: "inherit", stdin: "inherit" });
  if (result.exitCode !== 0) die(`${command[0]} failed with exit ${result.exitCode}`);
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function printDryRun(command: string[]): void {
  console.log(`dry-run: ${command.map(shellQuote).join(" ")}`);
}

function requiredString(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") die(`changelog JSON field ${JSON.stringify(field)} must be a string`);
  return value.trim();
}

function parseChangelog(options: Options): Changelog {
  let markdown = options.changelog?.trim() ?? "";
  let jsonText = options.changelogJson?.trim() ?? "";
  let summary = options.changelogSummary?.trim() ?? "";

  if (options.changelogFile) {
    const fileText = readFileSync(options.changelogFile, "utf8").trim();
    if (fileText.startsWith("{")) jsonText = fileText;
    else markdown = fileText;
  }
  if (options.changelogJsonFile) jsonText = readFileSync(options.changelogJsonFile, "utf8").trim();
  if (options.changelogSummaryFile) summary = readFileSync(options.changelogSummaryFile, "utf8").trim();

  let full = markdown;
  let content = markdown;
  if (jsonText) {
    let payload: unknown;
    try {
      payload = JSON.parse(jsonText);
    } catch (error) {
      die(`invalid changelog JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) die("changelog JSON must be an object");
    const record = payload as Record<string, unknown>;
    const jsonChangelog = requiredString(record, "changelog");
    const jsonContent = requiredString(record, "changelog_content");
    const jsonSummary = requiredString(record, "changelog_summary");
    content = content || jsonContent || jsonChangelog;
    full = jsonChangelog || content;
    summary = summary || jsonSummary;
  }

  if (!summary) {
    const firstContentLine = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    summary = (firstContentLine ?? "")
      .replace(/^#{1,6}\s+/, "")
      .replace(/^[-*+]\s+/, "")
      .replace(/^\d+[.)]\s+/, "")
      .slice(0, 180)
      .trim();
  }

  return { full: full || content, summary, content };
}

function printDetection(detection: WorkflowDetection): void {
  console.log(`workflow_mode=${detection.mode}`);
  console.log(`workflow_reason=${detection.reason}`);
  if (detection.workflow) {
    console.log(`workflow=${detection.workflow.name}`);
    if (!detection.workflow.compatible) console.log(`workflow_missing=${detection.workflow.missing.join(", ")}`);
  }
}

const options = parseArgs(process.argv.slice(2));
const repoResult = capture(["git", "-C", options.repo, "rev-parse", "--show-toplevel"], undefined, true);
if (repoResult.code !== 0) die(`not a git repository: ${options.repo}`);
const repoRoot = repoResult.stdout.trim();

const branch = options.branch ?? capture(["git", "branch", "--show-current"], repoRoot).stdout.trim();
if (!branch) die("cannot determine current branch; pass --branch");

const detection = detectBuildWorkflow(repoRoot, options.workflow);
printDetection(detection);

let environment: "beta" | "production" | null = null;
let version = options.version.trim();
let workflowArgs: string[] = [];

if (detection.mode === "dispatch") {
  const semver = /^v?\d+\.\d+\.\d+$/;
  environment = (options.environment?.trim() || (semver.test(version) ? "production" : "beta")) as
    | "beta"
    | "production";
  if (environment !== "beta" && environment !== "production") die("--environment must be beta or production");
  if (environment === "production" && !semver.test(version)) die("production requires --version X.Y.Z or vX.Y.Z");
  if (environment === "beta") version = "";

  const changelog = parseChangelog(options);
  if (!changelog.content) die(`${environment} dispatch requires changelog content from changelog-writing`);

  const workflow = detection.workflow!;
  const capabilities = workflow.capabilities;
  workflowArgs = ["workflow", "run", workflow.name, "--ref", branch, "-f", `${capabilities.channelInput}=${environment}`];
  if (environment === "production") workflowArgs.push("-f", `${capabilities.versionInput}=${version}`);

  if (capabilities.changelogInput === "changelog") {
    workflowArgs.push("-f", `changelog=${changelog.full}`);
  } else {
    workflowArgs.push("-f", `${capabilities.changelogInput}=${changelog.content}`);
    if (capabilities.changelogSummaryInput) {
      if (!changelog.summary) die(`workflow '${workflow.name}' requires a changelog summary`);
      workflowArgs.push("-f", `${capabilities.changelogSummaryInput}=${changelog.summary}`);
    }
  }

  if (!options.dryRun) {
    capture(["gh", "--version"]);
    capture(["gh", "auth", "status"]);
  }
} else if (options.environment || options.version || options.changelog || options.changelogFile || options.changelogJson || options.changelogJsonFile) {
  console.log("info: workflow-specific release options ignored in git-only mode");
}

const addCommands = options.paths.length > 0
  ? options.paths.map((path) => ["git", "add", "--", path])
  : [["git", "add", "-A"]];

if (options.dryRun) {
  for (const command of addCommands) printDryRun(command);
} else {
  for (const command of addCommands) run(command, repoRoot);
}

let hasChanges: boolean;
if (options.dryRun) {
  const statusCommand = ["git", "status", "--porcelain"];
  if (options.paths.length > 0) statusCommand.push("--", ...options.paths);
  hasChanges = capture(statusCommand, repoRoot).stdout.trim().length > 0;
} else {
  const diffCommand = ["git", "diff", "--cached", "--quiet"];
  if (options.paths.length > 0) diffCommand.push("--", ...options.paths);
  const diffResult = capture(diffCommand, repoRoot, true);
  if (diffResult.code > 1) die(`git diff failed: ${diffResult.stderr.trim()}`);
  hasChanges = diffResult.code === 1;
}

if (hasChanges) {
  const commitMessage = options.message
    ?? (environment === "production"
      ? `chore: release ${version.replace(/^v/, "")}`
      : environment === "beta"
        ? "chore: trigger beta build"
        : "chore: submit changes");
  const commitCommand = ["git", "commit"];
  if (options.paths.length > 0) commitCommand.push("--only");
  commitCommand.push("-m", commitMessage);
  if (options.paths.length > 0) commitCommand.push("--", ...options.paths);
  if (options.dryRun) printDryRun(commitCommand);
  else run(commitCommand, repoRoot);
} else {
  console.log("info: no staged changes; pushing current HEAD");
}

const headSha = capture(["git", "rev-parse", "HEAD"], repoRoot).stdout.trim();
const upstream = capture(
  ["git", "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
  repoRoot,
  true,
);
const pushCommand = upstream.code === 0 ? ["git", "push"] : ["git", "push", "-u", options.remote, branch];

if (options.dryRun) printDryRun(pushCommand);
else run(pushCommand, repoRoot);

console.log(`branch=${branch}`);
console.log(`commit=${headSha}`);

if (detection.mode === "git-only") {
  console.log("dispatch=skipped");
  process.exit(0);
}

if (options.dryRun) {
  printDryRun(["gh", ...workflowArgs]);
  process.exit(0);
}

const workflowName = detection.workflow!.name;
const beforeId = capture(
  ["gh", "run", "list", "--workflow", workflowName, "--branch", branch, "--limit", "1", "--json", "databaseId", "--jq", ".[0].databaseId // \"\""],
  repoRoot,
).stdout.trim();
run(["gh", ...workflowArgs], repoRoot);

let runId = "";
for (let attempt = 0; attempt < 24; attempt += 1) {
  const runs = capture(
    ["gh", "run", "list", "--workflow", workflowName, "--branch", branch, "--limit", "20", "--json", "databaseId,headSha"],
    repoRoot,
  ).stdout;
  const parsedRuns = JSON.parse(runs) as Array<{ databaseId: number; headSha: string }>;
  const match = parsedRuns.find((candidate) => candidate.headSha === headSha && String(candidate.databaseId) !== beforeId);
  if (match) {
    runId = String(match.databaseId);
    break;
  }
  Bun.sleepSync(5000);
}
if (!runId) die(`workflow dispatched, but no new run was found for ${headSha}`);

const runUrl = capture(["gh", "run", "view", runId, "--json", "url", "--jq", ".url"], repoRoot).stdout.trim();
console.log(`run_id=${runId}`);
console.log(`run_url=${runUrl}`);
console.log(`environment=${environment}`);
console.log(`version=${environment === "production" ? version : "workflow-generated"}`);

if (options.watch) {
  run(["gh", "run", "watch", runId, "--exit-status"], repoRoot);
  const conclusion = capture(
    ["gh", "run", "view", runId, "--json", "status,conclusion,url", "--jq", '"status=\\(.status)\\nconclusion=\\(.conclusion)\\nurl=\\(.url)"'],
    repoRoot,
  ).stdout.trim();
  console.log(conclusion);
} else {
  console.log("watch=skipped");
}
