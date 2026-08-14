import { basename } from "node:path";
import { randomUUID } from "node:crypto";

import * as catalog from "./catalog.ts";
import {
  cleanupSandbox,
  isolationEnv,
  makeSandbox,
  prepareRoundEnvironment,
  rsyncFixture,
  type IsolationEnv,
} from "./envprep.ts";
import { RuntimeActionError, TaskNotFoundError } from "./errors.ts";
import {
  cleanupPluginInstall,
  installAgentSource,
  installCodexSkillSource,
  installPluginSource,
  installSkillSource,
} from "./plugin-runtime.ts";
import {
  CalledProcessError,
  defaultRunner,
  sleepSeconds,
  type Runner,
} from "./process.ts";
import type { Connection } from "./db.ts";
import { takeCodePoints } from "./text-utils.ts";

export {
  cleanupPluginInstall,
  cleanupSandbox as cleanup,
  installAgentSource,
  installCodexSkillSource,
  installPluginSource,
  installSkillSource,
  isolationEnv,
  makeSandbox,
  prepareRoundEnvironment,
  rsyncFixture,
};

export function tmuxNewSession(
  session: string,
  cwd: string,
  command: string,
  runner: Runner = defaultRunner,
): string {
  runner(["tmux", "new-session", "-d", "-s", session, "-c", cwd, command]);
  return session;
}

export function hasSession(session: string, runner: Runner = defaultRunner): boolean {
  try {
    runner(["tmux", "has-session", "-t", session], { captureOutput: true });
    return true;
  } catch (error) {
    if (error instanceof CalledProcessError) return false;
    throw error;
  }
}

function hasSettingsArgument(args: string[]): boolean {
  return args.some((argument) => argument === "--settings" || argument.startsWith("--settings="));
}

function isClaudeCli(cli: string): boolean {
  return basename(cli).startsWith("claude");
}

function defaultCliArgs(cli: string, env: IsolationEnv, cliArgs: string[] = []): string[] {
  const args = [...cliArgs];
  if (isClaudeCli(cli) && !hasSettingsArgument(args)) {
    return ["--settings", env.CMDAI_CLAUDE_SETTINGS_PATH, ...args];
  }
  return args;
}

function shellQuote(value: string): string {
  if (!value) return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function tmuxNewSessionEnv(
  session: string,
  cwd: string,
  cli: string,
  env: Record<string, string>,
  cliArgs: string[] = [],
  runner: Runner = defaultRunner,
): string {
  const assignments = Object.entries(env)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${key}=${shellQuote(String(value))}`)
    .join(" ");
  const args = [cli, ...cliArgs].map((argument) => shellQuote(String(argument))).join(" ");
  return tmuxNewSession(session, cwd, `env ${assignments} ${args}`, runner);
}

export function sessionName(roundTag: string): string {
  return `acc-${roundTag}`;
}

export interface LaunchResult {
  session: string;
  pane: string;
  existing: boolean;
}

export function launchRound(
  roundTag: string,
  sandbox: string,
  cli: string,
  cliArgs: string[] = [],
  runner: Runner = defaultRunner,
): LaunchResult {
  const env = prepareRoundEnvironment(sandbox);
  const session = sessionName(roundTag);
  const pane = `${session}:0.0`;
  if (hasSession(session, runner)) {
    return { session, pane, existing: true };
  }
  const args = defaultCliArgs(cli, env, cliArgs);
  tmuxNewSessionEnv(session, sandbox, cli, env, args, runner);
  return { session, pane, existing: false };
}

export function killSession(session: string, runner: Runner = defaultRunner): boolean {
  try {
    runner(["tmux", "kill-session", "-t", session], { captureOutput: true });
    return true;
  } catch (error) {
    if (error instanceof CalledProcessError) return false;
    throw error;
  }
}

export interface FeedTaskOptions {
  runner?: Runner;
  readyTimeout?: number;
  readySettleDelay?: number;
  submitDelay?: number;
  submitAttempts?: number;
  resubmitDelay?: number;
  pasteAttempts?: number;
  pasteRetryDelay?: number;
}

export function feedTask(
  connection: Connection,
  acceptanceId: string,
  taskKey: string,
  pane: string,
  options: FeedTaskOptions = {},
): string {
  const runner = options.runner ?? defaultRunner;
  const readyTimeout = options.readyTimeout ?? 20;
  const readySettleDelay = options.readySettleDelay ?? 3;
  const submitDelay = options.submitDelay ?? 0.8;
  const submitAttempts = options.submitAttempts ?? 4;
  const resubmitDelay = options.resubmitDelay ?? 2;
  const pasteAttempts = options.pasteAttempts ?? 3;
  const pasteRetryDelay = options.pasteRetryDelay ?? 2;
  const prompts = catalog.getTaskPrompts(connection, acceptanceId);
  if (!(taskKey in prompts)) {
    throw new TaskNotFoundError(`task '${taskKey}' not found for acceptance ${acceptanceId}`);
  }
  if (!waitForPrompt(pane, { timeout: readyTimeout, runner })) {
    throw new RuntimeActionError(`pane did not become ready for input: ${pane}`);
  }
  if (readyTimeout > 0) sleepSeconds(readySettleDelay);
  const body = prompts[taskKey] as string;
  let pasted = false;
  for (let attempt = 0; attempt < pasteAttempts; attempt += 1) {
    const buffer = `acc-task-${taskKey}-${process.pid}-${randomUUID()}-${attempt}`;
    runner(["tmux", "set-buffer", "-b", buffer, "--", body]);
    runner(["tmux", "paste-buffer", "-p", "-d", "-b", buffer, "-t", pane]);
    sleepSeconds(submitDelay);
    if (readyTimeout <= 0 || paneContainsBody(pane, body, runner)) {
      pasted = true;
      break;
    }
    if (attempt + 1 < pasteAttempts) {
      runner(["tmux", "send-keys", "-t", pane, "C-u"]);
      sleepSeconds(pasteRetryDelay);
    }
  }
  if (!pasted) {
    throw new RuntimeActionError(`task body did not appear in pane after paste: ${pane}`);
  }
  for (let attempt = 0; attempt < submitAttempts; attempt += 1) {
    runner(["tmux", "send-keys", "-t", pane, "Enter"]);
    if (attempt + 1 < submitAttempts) sleepSeconds(resubmitDelay);
  }
  return body;
}

export function capturePane(
  pane: string,
  options: { start?: string; runner?: Runner } = {},
): string {
  const output = (options.runner ?? defaultRunner)(
    ["tmux", "capture-pane", "-p", "-S", options.start ?? "-2000", "-t", pane],
    { captureOutput: true },
  );
  return output.stdout;
}

export function waitForPrompt(
  pane: string,
  options: { timeout?: number; interval?: number; runner?: Runner } = {},
): boolean {
  const timeout = options.timeout ?? 20;
  const interval = options.interval ?? 0.5;
  const runner = options.runner ?? defaultRunner;
  if (timeout <= 0) return true;
  const deadline = Date.now() + timeout * 1000;
  while (Date.now() < deadline) {
    let text = "";
    try {
      text = capturePane(pane, { start: "-120", runner });
    } catch (error) {
      if (!(error instanceof CalledProcessError)) throw error;
    }
    if (hasInputPrompt(text)) return true;
    if (isWorkspaceTrustPrompt(text)) {
      runner(["tmux", "send-keys", "-t", pane, "Enter"]);
      sleepSeconds(interval);
      continue;
    }
    sleepSeconds(interval);
  }
  return false;
}

export function waitForIdle(
  pane: string,
  options: { idleSeconds: number; maxSeconds: number; interval?: number; runner?: Runner },
): boolean {
  const interval = options.interval ?? 2;
  const runner = options.runner ?? defaultRunner;
  if (options.maxSeconds <= 0) return false;
  const deadline = Date.now() + options.maxSeconds * 1000;
  let lastCompact: string | null = null;
  let lastChange = Date.now();
  while (Date.now() < deadline) {
    let text = "";
    try {
      text = capturePane(pane, { start: "-120", runner });
    } catch (error) {
      if (!(error instanceof CalledProcessError)) throw error;
    }
    const compacted = compactText(text);
    const promptVisible = hasInputPrompt(text);
    const now = Date.now();
    if (compacted !== lastCompact) {
      lastCompact = compacted;
      lastChange = now;
    } else if (promptVisible && now - lastChange >= options.idleSeconds * 1000) {
      return true;
    }
    sleepSeconds(interval);
  }
  return false;
}

export function isWorkspaceTrustPrompt(text: string): boolean {
  const claudePrompt = text.includes("Yes, I trust this folder")
    && text.includes("Enter to confirm");
  const codexPrompt = text.includes("Do you trust the contents of this directory?")
    && text.includes("Press enter to continue");
  return claudePrompt || codexPrompt;
}

export function hasInputPrompt(text: string): boolean {
  for (const line of String(text).split(/\r?\n/u)) {
    const stripped = line.trimStart();
    if (!stripped.startsWith("❯") && !stripped.startsWith("›")) continue;
    if (/^[❯›]\s+\d+\.\s/u.test(stripped)) continue;
    return true;
  }
  return false;
}

function compactText(text: string): string {
  return String(text).replace(/\s+/gu, "");
}

function bodyMarker(body: string): string {
  return takeCodePoints(compactText(body), 12);
}

function paneContainsBody(pane: string, body: string, runner: Runner): boolean {
  const marker = bodyMarker(body);
  if (!marker) return true;
  try {
    const text = capturePane(pane, { start: "-120", runner });
    return compactText(text).includes(marker) || hasCollapsedPasteMarker(text);
  } catch (error) {
    if (error instanceof CalledProcessError) return false;
    throw error;
  }
}

function hasCollapsedPasteMarker(text: string): boolean {
  return text.includes("[Pasted text") && text.includes("paste again to expand");
}
