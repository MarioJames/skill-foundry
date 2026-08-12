import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import * as catalog from "./catalog.ts";
import type { ParsedCommand } from "./cli.ts";
import * as cleanup from "./cleanup.ts";
import type { Connection } from "./db.ts";
import {
  BudgetExceeded,
  LookupError,
  ProfileNotImplementedError,
  RuntimeActionError,
  TaskNotFoundError,
  ValidationError,
} from "./errors.ts";
import * as observe from "./observe.ts";
import { parsePythonInteger } from "./number-utils.ts";
import { stablePath } from "./path-utils.ts";
import * as profiles from "./profiles.ts";
import { redactSecrets } from "./redact.ts";
import * as rounds from "./rounds.ts";
import { textLength } from "./text-utils.ts";

export interface CommandResult {
  payload: Record<string, unknown>;
  exitCode?: number;
}

type Options = ParsedCommand["options"];

function text(options: Options, key: string): string | undefined {
  const value = options[key];
  return value === undefined || value === null ? undefined : String(value);
}

function number(options: Options, key: string): number | undefined {
  const value = options[key];
  return typeof value === "number" ? value : undefined;
}

function bool(options: Options, key: string): boolean {
  return options[key] === true;
}

function read(path: string | undefined): string | undefined {
  return path ? readFileSync(path, "utf8") : undefined;
}

function readJson(path: string | undefined): unknown {
  return path ? JSON.parse(readFileSync(path, "utf8")) : undefined;
}

function chooseInlineOrFile(
  inline: string | undefined,
  filePath: string | undefined,
  label: string,
): string {
  if (inline && filePath) {
    throw new ValidationError(`use only one of --${label} or --${label}-file`);
  }
  const value = inline !== undefined ? inline : read(filePath);
  if (value === undefined) {
    throw new ValidationError(`missing required --${label} or --${label}-file`);
  }
  return value;
}

interface Preflight {
  ok: boolean;
  cli: string;
  resolved?: string;
  skipped?: boolean;
  reason?: string;
}

function preflight(cli = "claude"): Preflight {
  if (process.env.ACCEPTANCE_SKIP_PREFLIGHT) {
    return { ok: true, cli, resolved: cli, skipped: true };
  }
  const found = Bun.which(cli);
  if (!found) {
    return { ok: false, reason: `selected CLI '${cli}' not on PATH`, cli };
  }
  return { ok: true, cli, resolved: found };
}

function fail(message: string, extra: Record<string, unknown> = {}): CommandResult {
  return { payload: { error: message, ...extra }, exitCode: 2 };
}

function isInputError(error: unknown): boolean {
  return error instanceof ValidationError || error instanceof SyntaxError;
}

function parseDepth(): number {
  const raw = process.env.ACCEPTANCE_DEPTH ?? "0";
  return parsePythonInteger(raw) ?? 0;
}

export function runCommand(connection: Connection, command: ParsedCommand): CommandResult {
  const { path, options } = command;
  if (path === "bootstrap") {
    try {
      const registration = catalog.registerAsset(
        connection,
        text(options, "name") as string,
        text(options, "type") as catalog.AssetType,
        text(options, "source") as string,
      );
      const goal = chooseInlineOrFile(
        text(options, "goal"),
        text(options, "goalFile"),
        "goal",
      );
      let strategy = text(options, "strategy");
      const strategyFile = text(options, "strategyFile");
      if (strategyFile) {
        if (strategy) throw new ValidationError("use only one of --strategy or --strategy-file");
        strategy = read(strategyFile);
      }
      const acceptanceId = catalog.newAcceptance(connection, registration.id, goal, {
        strategy,
        fixturePath: text(options, "fixture"),
        taskPrompts: readJson(text(options, "taskPromptsFile")),
      });
      return {
        payload: {
          asset_id: registration.id,
          asset_created: registration.created,
          warning: registration.warning,
          acceptance_id: acceptanceId,
        },
      };
    } catch (error) {
      if (isInputError(error)) return fail((error as Error).message);
      throw error;
    }
  }

  if (path === "asset add") {
    try {
      return {
        payload: {
          ...catalog.registerAsset(
            connection,
            text(options, "name") as string,
            text(options, "type") as catalog.AssetType,
            text(options, "source") as string,
          ),
        },
      };
    } catch (error) {
      if (error instanceof ValidationError) return fail(error.message);
      throw error;
    }
  }

  if (path === "asset list") {
    return {
      payload: {
        assets: catalog.listAssets(connection, {
          type: text(options, "type") as catalog.AssetType | undefined,
          name: text(options, "name"),
        }),
      },
    };
  }

  if (path === "accept new") {
    const assetValue = text(options, "asset") as string;
    const asset = catalog.getAsset(connection, assetValue);
    if (!asset) return fail(`asset not found: ${assetValue}`);
    let goal: string;
    try {
      goal = chooseInlineOrFile(text(options, "goal"), text(options, "goalFile"), "goal");
    } catch (error) {
      if (error instanceof ValidationError) return fail(error.message);
      throw error;
    }
    let strategy = text(options, "strategy");
    const strategyFile = text(options, "strategyFile");
    if (strategyFile) {
      if (strategy) return fail("use only one of --strategy or --strategy-file");
      strategy = read(strategyFile);
    }
    try {
      const acceptanceId = catalog.newAcceptance(connection, asset.id, goal, {
        strategy,
        fixturePath: text(options, "fixture"),
        taskPrompts: readJson(text(options, "taskPromptsFile")),
      });
      return { payload: { id: acceptanceId } };
    } catch (error) {
      if (isInputError(error)) return fail((error as Error).message);
      throw error;
    }
  }

  if (path === "accept update") {
    const acceptanceId = text(options, "id") || text(options, "acceptance");
    if (!acceptanceId) return fail("accept update requires --id or --acceptance");
    let strategy = text(options, "strategy");
    const strategyFile = text(options, "strategyFile");
    if (strategyFile) {
      if (strategy) return fail("use only one of --strategy or --strategy-file");
      strategy = read(strategyFile);
    }
    try {
      const updates: catalog.AcceptanceUpdates = {};
      const status = text(options, "status");
      const promptFile = text(options, "promptFile");
      const criteriaFile = text(options, "criteriaFile");
      const taskPromptsFile = text(options, "taskPromptsFile");
      const ladderFile = text(options, "ladderFile");
      const fixture = text(options, "fixture");
      const budget = number(options, "budgetMaxRounds");
      if (status !== undefined) updates.status = status as catalog.AcceptanceStatus;
      if (strategy !== undefined) updates.strategy = strategy;
      if (promptFile !== undefined) updates.acceptance_prompt = read(promptFile);
      if (criteriaFile !== undefined) updates.acceptance_criteria = read(criteriaFile);
      if (taskPromptsFile !== undefined) updates.task_prompts = readJson(taskPromptsFile);
      if (ladderFile !== undefined) updates.ladder = readJson(ladderFile);
      if (fixture !== undefined) updates.fixture_path = stablePath(fixture) ?? null;
      if (budget !== undefined) updates.budget_max_rounds = budget;
      catalog.updateAcceptance(connection, acceptanceId, updates);
      return { payload: { id: acceptanceId, updated: true } };
    } catch (error) {
      if (isInputError(error)) return fail((error as Error).message);
      throw error;
    }
  }

  if (path === "accept list") {
    let assetId: string | undefined;
    const assetValue = text(options, "asset");
    if (assetValue) {
      assetId = catalog.getAsset(connection, assetValue)?.id ?? "__none__";
    }
    return {
      payload: {
        acceptances: catalog.listAcceptances(connection, {
          assetId,
          status: text(options, "status"),
        }),
      },
    };
  }

  if (path === "start") {
    const selectedCli = text(options, "cli") as string;
    const checked = preflight(selectedCli);
    if (!checked.ok) return { payload: { preflight: "fail", ...checked }, exitCode: 2 };
    const depth = parseDepth();
    if (depth >= 2) {
      return fail(`acceptance recursion depth exceeded: ${depth + 1}`, {
        blocked: "depth-exceeded",
      });
    }
    const acceptanceId = text(options, "acceptance") as string;
    const acceptance = catalog.getAcceptance(connection, acceptanceId);
    if (!acceptance) return fail(`acceptance not found: ${acceptanceId}`);
    if (acceptance.fixture_path && !existsSync(acceptance.fixture_path)) {
      return fail(`fixture not found: ${acceptance.fixture_path}`);
    }
    let roundId: string;
    try {
      roundId = rounds.startRound(connection, acceptanceId, {
        mode: text(options, "mode") as rounds.RoundMode,
        n: number(options, "n") as number,
      });
    } catch (error) {
      if (error instanceof BudgetExceeded) {
        return fail(error.message, { blocked: "budget-exhausted" });
      }
      throw error;
    }
    const round = rounds.getRoundTarget(connection, roundId) as rounds.RoundTarget;
    const sandbox = observe.makeSandbox(round.round_tag);
    const fixtureCopy = observe.rsyncFixture(acceptance.fixture_path, sandbox);
    rounds.setSandboxPath(connection, roundId, sandbox);
    return {
      payload: {
        id: roundId,
        round_tag: round.round_tag,
        preflight: "ok",
        cli: checked.cli,
        resolved: checked.resolved,
        sandbox,
        fixture: fixtureCopy,
        isolation_env: observe.isolationEnv(sandbox),
      },
    };
  }

  if (path === "launch") {
    const selectedCli = text(options, "cli") as string;
    const checked = preflight(selectedCli);
    if (!checked.ok) return { payload: { preflight: "fail", ...checked }, exitCode: 2 };
    const roundId = text(options, "round") as string;
    const row = rounds.getLaunchTarget(connection, roundId);
    if (!row) return fail(`round not found: ${roundId}`);
    if (!row.sandbox_path) return fail(`round has no sandbox_path: ${roundId}`);
    if (!existsSync(row.sandbox_path)) {
      return fail(`round sandbox not found: ${row.sandbox_path}`);
    }
    const cli = checked.resolved || checked.cli;
    const launch = profiles.launchRoundForTarget(row, cli);
    return {
      payload: {
        round: roundId,
        round_tag: row.round_tag,
        sandbox: row.sandbox_path,
        cli,
        plugin_install: launch.plugin_install,
        session: launch.session,
        pane: launch.pane,
        existing: launch.existing,
      },
    };
  }

  if (path === "round list") {
    return {
      payload: {
        rounds: rounds.listRounds(connection, {
          acceptanceId: text(options, "acceptance"),
          verdict: text(options, "verdict") as rounds.Verdict | undefined,
        }),
      },
    };
  }

  if (path === "show") {
    const kind = command.positionals[0] as "prompt" | "criteria";
    return {
      payload: {
        kind,
        body: catalog.getAcceptanceBody(
          connection,
          text(options, "acceptance") as string,
          kind,
        ),
      },
    };
  }

  if (path === "feed-task") {
    let acceptanceId = text(options, "acceptance");
    let pane = text(options, "pane");
    const roundId = text(options, "round");
    if (roundId) {
      const row = rounds.getRoundTarget(connection, roundId);
      if (!row) return fail(`round not found: ${roundId}`);
      acceptanceId = acceptanceId || row.acceptance_id;
      pane = pane || `${observe.sessionName(row.round_tag)}:0.0`;
    }
    if (!acceptanceId || !pane) {
      return fail("feed-task requires --acceptance/--pane or --round");
    }
    const task = text(options, "task") as string;
    let body: string;
    try {
      body = observe.feedTask(connection, acceptanceId, task, pane);
    } catch (error) {
      if (error instanceof TaskNotFoundError) {
        return fail(
          `task '${task}' not found for acceptance ${acceptanceId} `
          + "(set via --task-prompts-file)",
        );
      }
      if (error instanceof RuntimeActionError) return fail(error.message);
      throw error;
    }
    if (roundId) rounds.addTaskKey(connection, roundId, task);
    return { payload: { fed: true, task, chars: textLength(body), pane } };
  }

  if (path === "capture") {
    let pane = text(options, "pane");
    const roundId = text(options, "round");
    if (roundId) {
      const row = rounds.getRoundTarget(connection, roundId);
      if (!row) return fail(`round not found: ${roundId}`);
      pane = pane || `${observe.sessionName(row.round_tag)}:0.0`;
    }
    if (!pane) return fail("capture requires --pane or --round");
    const transcript = redactSecrets(
      observe.capturePane(pane, { start: text(options, "start") as string }),
    );
    const outputPath = text(options, "out");
    if (outputPath) {
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, transcript, "utf8");
    }
    return {
      payload: { pane, chars: textLength(transcript), out: outputPath ?? null },
    };
  }

  if (path === "wait") {
    let pane = text(options, "pane");
    const roundId = text(options, "round");
    if (roundId) {
      const row = rounds.getRoundTarget(connection, roundId);
      if (!row) return fail(`round not found: ${roundId}`);
      pane = pane || `${observe.sessionName(row.round_tag)}:0.0`;
    }
    if (!pane) return fail("wait requires --pane or --round");
    const idle = observe.waitForIdle(pane, {
      idleSeconds: number(options, "idleSeconds") as number,
      maxSeconds: number(options, "maxSeconds") as number,
    });
    return { payload: { pane, idle } };
  }

  if (path === "record") {
    let transcript = read(text(options, "transcriptFile"));
    if (transcript !== undefined) transcript = redactSecrets(transcript);
    const roundId = text(options, "round") as string;
    rounds.record(connection, roundId, {
      transcript,
      reportAppend: text(options, "report"),
    });
    return { payload: { round: roundId, recorded: true } };
  }

  if (path === "finding list") {
    return {
      payload: {
        findings: rounds.listFindings(connection, text(options, "round") as string),
      },
    };
  }

  if (path === "finding" || path === "finding add") {
    const required = ["round", "severity", "status", "summary"];
    const missing = required.filter((key) => !text(options, key));
    if (missing.length) return fail(`finding add missing: ${missing.join(", ")}`);
    const roundId = text(options, "round") as string;
    const findingId = rounds.addFinding(connection, roundId, {
      severity: text(options, "severity") as string,
      status: text(options, "status") as string,
      summary: text(options, "summary") as string,
      key: text(options, "key"),
    });
    return { payload: { round: roundId, finding: true, id: findingId } };
  }

  if (path === "finalize") {
    const roundId = text(options, "round") as string;
    const verdict = text(options, "verdict") as Exclude<rounds.Verdict, "running">;
    const allowPartial = text(options, "allowPartial");
    if (verdict === "PASS" && !allowPartial) {
      const [ok, reason] = catalog.canFinalizePass(connection, roundId);
      if (!ok) return fail(reason as string);
    }
    rounds.finalize(connection, roundId, {
      verdict,
      nextRoundReco: text(options, "nextRoundReco"),
    });
    if (allowPartial && verdict === "PASS") {
      rounds.addFinding(connection, roundId, {
        severity: "P2",
        status: "waived",
        summary: `ladder coverage overridden: ${allowPartial}`,
        key: "allow-partial",
      });
    }
    let cleanupResult: Record<string, unknown> | null = null;
    let cleanupSkipped: string | null = null;
    if (bool(options, "keepSandbox")) {
      cleanupSkipped = "keep-sandbox";
    } else {
      try {
        cleanupResult = cleanup.cleanupRound(connection, roundId);
      } catch (error) {
        if (error instanceof LookupError || error instanceof ValidationError) {
          return fail(error.message);
        }
        throw error;
      }
    }
    return {
      payload: {
        round: roundId,
        verdict,
        cleanup: cleanupResult,
        cleanup_skipped: cleanupSkipped,
      },
    };
  }

  if (path === "cleanup") {
    const sandbox = text(options, "sandbox");
    const roundId = text(options, "round");
    if (roundId) {
      try {
        return { payload: cleanup.cleanupRound(connection, roundId, { sandbox }) };
      } catch (error) {
        if (error instanceof LookupError || error instanceof ValidationError) {
          return fail(error.message);
        }
        throw error;
      }
    }
    if (!sandbox) return fail("cleanup requires --sandbox or --round");
    return { payload: observe.cleanup(sandbox) };
  }

  if (path === "profile list") {
    return { payload: { profiles: profiles.listProfiles() } };
  }

  if (path === "profile run-task") {
    const selectedCli = text(options, "cli") as string;
    const checked = preflight(selectedCli);
    if (!checked.ok) return { payload: { preflight: "fail", ...checked }, exitCode: 2 };
    try {
      const output = profiles.runTask(
        connection,
        text(options, "acceptance") as string,
        text(options, "task") as string,
        {
          mode: text(options, "mode") as rounds.RoundMode,
          cli: checked.resolved || checked.cli,
          waitSeconds: number(options, "waitSeconds"),
          captureStart: text(options, "captureStart"),
          finalizeVerdict: text(options, "finalizeVerdict") as Exclude<rounds.Verdict, "running"> | undefined,
          nextRoundReco: text(options, "nextRoundReco"),
        },
      );
      return { payload: { preflight: "ok", cli: checked.cli, ...output } };
    } catch (error) {
      if (error instanceof ValidationError
          || error instanceof ProfileNotImplementedError
          || error instanceof RuntimeActionError
          || error instanceof TaskNotFoundError
          || error instanceof SyntaxError
          || error instanceof BudgetExceeded) {
        return fail(error.message, error instanceof BudgetExceeded
          ? { blocked: "budget-exhausted" }
          : {});
      }
      throw error;
    }
  }

  if (path === "history") {
    return { payload: catalog.history(connection, text(options, "asset") as string) };
  }

  throw new Error(`unhandled command path: ${path}`);
}
