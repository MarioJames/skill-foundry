#!/usr/bin/env bun

type Options = {
  to: string;
  from?: string;
  range?: string;
  auto?: "beta" | "production";
};

function usage(): void {
  console.log(`Usage:
  collect-commits.ts --from <tag-or-ref> [--to <tag-or-ref>]
  collect-commits.ts --range <git-range>
  collect-commits.ts --auto-beta [--to <tag-or-ref>]
  collect-commits.ts --auto-production [--to <tag-or-ref>]`);
}

function fail(message: string, code = 2): never {
  console.error(`error: ${message}`);
  process.exit(code);
}

function git(args: string[], allowFailure = false): { code: number; output: string; error: string } {
  const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  const response = {
    code: result.exitCode,
    output: result.stdout.toString().trimEnd(),
    error: result.stderr.toString().trim(),
  };
  if (!allowFailure && response.code !== 0) fail(response.error || `git ${args[0]} failed`, 1);
  return response;
}

function parseArgs(args: string[]): Options {
  const options: Options = { to: "HEAD" };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = () => {
      const next = args[index + 1];
      if (!next) fail(`${argument} requires a value`);
      index += 1;
      return next;
    };

    if (argument === "--from") options.from = value();
    else if (argument === "--to") options.to = value();
    else if (argument === "--range") options.range = value();
    else if (argument === "--auto-beta") options.auto = "beta";
    else if (argument === "--auto-production") options.auto = "production";
    else if (argument === "-h" || argument === "--help") {
      usage();
      process.exit(0);
    } else fail(`unknown argument: ${argument}`);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (git(["rev-parse", "--git-dir"], true).code !== 0) fail("run inside a git repository", 1);
if (options.range && (options.from || options.auto)) fail("use either --range or --from/--auto-*, not both");
if (options.from && options.auto) fail("use either --from or --auto-*, not both");

if (options.auto) {
  const pattern = options.auto === "beta" ? "beta-*" : "v[0-9]*.[0-9]*.[0-9]*";
  options.from = git(["tag", "--merged", options.to, "--sort=-creatordate", "--list", pattern])
    .output
    .split(/\r?\n/)
    .find(Boolean);
  if (!options.from) fail(`no ${options.auto} tag found reachable from ${options.to}`, 1);
}

if (!options.range) {
  if (!options.from) fail("missing --from, --range, --auto-beta, or --auto-production");
  options.range = `${options.from}..${options.to}`;
} else if (options.range.includes("..") && !options.range.includes("...")) {
  const separator = options.range.indexOf("..");
  options.from = options.range.slice(0, separator);
  options.to = options.range.slice(separator + 2);
}

git(["rev-list", "--count", options.range]);
const repository = git(["rev-parse", "--show-toplevel"]).output.split("/").pop();
const head = git(["rev-parse", "--short", options.to]).output;
const mergeBase = options.from ? git(["merge-base", options.from, options.to], true) : null;
const tags = git(["tag", "--merged", options.to, "--sort=-creatordate"]).output
  .split(/\r?\n/)
  .filter(Boolean)
  .slice(0, 10);
const count = git(["rev-list", "--count", options.range]).output;
const commits = git(["log", "--reverse", "--no-merges", "--format=- %h %s", options.range]).output;

console.log("# Changelog Commit Source\n");
console.log(`Repository: ${repository}`);
console.log(`Range: ${options.range}`);
console.log(`Head: ${head}`);
if (mergeBase?.code === 0 && mergeBase.output) {
  console.log(`Merge base: ${git(["rev-parse", "--short", mergeBase.output]).output}`);
}
console.log("\n## Recent reachable tags");
for (const tag of tags) console.log(`- ${tag}`);
console.log(`\n## Commit count\n${count}`);
console.log("\n## Commits (oldest first, no merges)");
if (commits) console.log(commits);
