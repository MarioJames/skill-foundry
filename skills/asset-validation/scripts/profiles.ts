import { basename, dirname } from "node:path";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";

import * as catalog from "./catalog.ts";
import * as cleanup from "./cleanup.ts";
import type { Connection } from "./db.ts";
import { ProfileNotImplementedError, ValidationError } from "./errors.ts";
import * as observe from "./observe.ts";
import type { PluginInstall } from "./plugin-runtime.ts";
import { redactSecrets } from "./redact.ts";
import * as rounds from "./rounds.ts";
import { textLength } from "./text-utils.ts";

export const PROFILE_CONFIGS: Record<catalog.AssetType, { implemented: boolean; summary: string }> = {
  skill: {
    implemented: true,
    summary: "staged standalone skill, real CLI task, transcript capture",
  },
  plugin: {
    implemented: true,
    summary: "sandboxed plugin staging, real CLI task, transcript capture",
  },
  rule: {
    implemented: false,
    summary: "rule trigger profile placeholder",
  },
  agent: {
    implemented: true,
    summary: "sandboxed agent staging, real CLI task, transcript capture",
  },
};

export function listProfiles(): Array<Record<string, unknown>> {
  return Object.entries(PROFILE_CONFIGS)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([assetType, config]) => ({ asset_type: assetType, ...config }));
}

export interface TargetLaunchResult extends observe.LaunchResult {
  plugin_install: PluginInstall | null;
  cli_args: string[];
}

export function launchRoundForTarget(row: rounds.LaunchTarget, cli: string): TargetLaunchResult {
  let pluginInstall: PluginInstall | null = null;
  let cliArgs = ["--add-dir", sourceAddDir(row.asset_source)];
  if (["plugin", "skill", "agent"].includes(row.asset_type)) {
    if (supportsClaudeSessionPlugins(cli)) {
      if (row.asset_type === "plugin") {
        pluginInstall = observe.installPluginSource(
          row.sandbox_path,
          row.asset_source,
          { name: row.asset_name },
        );
      } else if (row.asset_type === "skill") {
        pluginInstall = observe.installSkillSource(
          row.sandbox_path,
          row.asset_source,
          { name: row.asset_name },
        );
      } else {
        pluginInstall = observe.installAgentSource(
          row.sandbox_path,
          row.asset_source,
          { name: row.asset_name },
        );
      }
      cliArgs = [...(pluginInstall.cli_args ?? []), ...cliArgs];
    } else if (row.asset_type === "skill" && supportsCodexRepoSkills(cli)) {
      pluginInstall = observe.installCodexSkillSource(
        row.sandbox_path,
        row.asset_source,
        { name: row.asset_name },
      );
      cliArgs = [...(pluginInstall.cli_args ?? [])];
    } else {
      pluginInstall = {
        installed: false,
        reason: "session plugin staging is only supported for Claude CLI; "
          + `using add-dir fallback for ${basename(cli)}`,
        asset_type: row.asset_type,
      };
    }
  }
  const launched = observe.launchRound(
    row.round_tag,
    row.sandbox_path,
    cli,
    cliArgs,
  );
  return { plugin_install: pluginInstall, cli_args: cliArgs, ...launched };
}

export interface RunTaskOptions {
  mode: rounds.RoundMode;
  cli: string;
  waitSeconds?: number;
  captureStart?: string;
  finalizeVerdict?: Exclude<rounds.Verdict, "running">;
  nextRoundReco?: string;
}

export function runTask(
  connection: Connection,
  acceptanceId: string,
  taskKey: string,
  options: RunTaskOptions,
): Record<string, unknown> {
  const target = catalog.getAcceptanceTarget(connection, acceptanceId);
  if (!target) throw new ValidationError(`acceptance not found: ${acceptanceId}`);
  const config = PROFILE_CONFIGS[target.asset_type];
  if (!config) throw new ValidationError(`unknown asset type: ${target.asset_type}`);
  if (!config.implemented) {
    throw new ProfileNotImplementedError(
      `profile for asset type '${target.asset_type}' is not implemented`,
    );
  }
  if (target.fixture_path && !existsSync(target.fixture_path)) {
    throw new ValidationError(`fixture not found: ${target.fixture_path}`);
  }
  validateTaskKey(connection, acceptanceId, taskKey);
  const roundId = rounds.startRound(connection, acceptanceId, { mode: options.mode, n: 1 });
  const round = rounds.getRoundTarget(connection, roundId) as rounds.RoundTarget;
  const sandbox = observe.makeSandbox(round.round_tag);
  const fixtureCopy = observe.rsyncFixture(target.fixture_path, sandbox);
  rounds.setSandboxPath(connection, roundId, sandbox);
  const launchRow = rounds.getLaunchTarget(connection, roundId) as rounds.LaunchTarget;
  const launch = launchRoundForTarget(launchRow, options.cli);
  const body = observe.feedTask(connection, acceptanceId, taskKey, launch.pane);
  rounds.addTaskKey(connection, roundId, taskKey);
  const waitSeconds = options.waitSeconds ?? 60;
  const idleSeconds = Math.max(8, Math.floor(waitSeconds / 4));
  observe.waitForIdle(launch.pane, { idleSeconds, maxSeconds: waitSeconds });
  const promptReturned = observe.waitForPrompt(launch.pane, { timeout: 10 });
  const transcript = redactSecrets(
    observe.capturePane(launch.pane, { start: options.captureStart ?? "-2000" }),
  );
  const evidenceDirectory = `${sandbox}/.tmp/profile-run`;
  mkdirSync(evidenceDirectory, { recursive: true });
  const transcriptPath = `${evidenceDirectory}/${taskKey}.transcript.txt`;
  writeFileSync(transcriptPath, transcript, "utf8");
  const report = `Profile run (${target.asset_type}) executed task ${taskKey}: `
    + "start/launch/feed/capture via scripted spine; "
    + `prompt_returned=${promptReturned ? "True" : "False"}; chars=${textLength(transcript)}.`;
  rounds.record(connection, roundId, { transcript, reportAppend: report });
  const result: Record<string, unknown> = {
    profile: target.asset_type,
    round: roundId,
    round_tag: round.round_tag,
    sandbox,
    fixture: fixtureCopy,
    task: taskKey,
    task_chars: textLength(body),
    prompt_returned: promptReturned,
    transcript_chars: textLength(transcript),
    transcript_file: transcriptPath,
    launch: {
      session: launch.session,
      pane: launch.pane,
      existing: launch.existing,
      plugin_install: launch.plugin_install,
    },
  };
  if (options.finalizeVerdict) {
    rounds.finalize(connection, roundId, {
      verdict: options.finalizeVerdict,
      nextRoundReco: options.nextRoundReco,
    });
    result.verdict = options.finalizeVerdict;
    result.cleanup = cleanup.cleanupRound(connection, roundId);
  }
  return result;
}

function sourceAddDir(sourcePath: string): string {
  return existsSync(sourcePath) && statSync(sourcePath).isDirectory()
    ? sourcePath
    : dirname(sourcePath);
}

function supportsClaudeSessionPlugins(cli: string): boolean {
  return basename(cli).startsWith("claude");
}

function supportsCodexRepoSkills(cli: string): boolean {
  return basename(cli).startsWith("codex");
}

function validateTaskKey(connection: Connection, acceptanceId: string, taskKey: string): void {
  const prompts = catalog.getTaskPrompts(connection, acceptanceId);
  if (!(taskKey in prompts)) {
    throw new ValidationError(`task '${taskKey}' not found for acceptance ${acceptanceId}`);
  }
}

export function preflight(cli = "claude"): Record<string, unknown> {
  const found = Bun.which(cli);
  if (!found) {
    return { ok: false, reason: `selected CLI '${cli}' not on PATH`, cli };
  }
  return { ok: true, cli, resolved: found };
}
