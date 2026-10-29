#!/usr/bin/env bun

import {
  CliError,
  createResource,
  emit,
  ensureSession,
  normalizeDir,
  OP_TAG_ENV,
  parseFlags,
  parseOpTag,
  parseSessionName,
  probeWorkspace,
  requireHerdr,
  requireRunningSession,
  resolveCaller,
  runCli,
  sessionRunning,
  setHerdrSession,
  stopSessionIfEmpty,
  type SessionState,
  type Direction,
  type LaneScope,
  type LaneType,
  type ResourceIds,
  type RouteAction,
} from "./lib/herdr-route";
import { createSession, type CreatedSession } from "./lib/session-create";

const usage = `Usage:
  route-lane.ts --type oneshot|service|coding-agent --cwd PATH [options]

Options:
  --scope same-task|independent  Override the type default.
  --caller-pane PANE_ID          Anchor routing to an explicit caller pane.
  --direction auto|right|down    Split direction; default: auto.
  --label TEXT                   Set and verify a new tab's task label (also names a new workspace).
                                 Split panes keep their parent tab's label.
  --session NAME                 Build the lane in a hidden headless Herdr session (started on demand).
                                 For background agents; implies independent scope, create-tab or
                                 create-workspace only; excludes --caller-pane and --scope same-task.
  --require-running              With --session NAME only: reuse a running session without starting it.
                                 A stopped or absent server fails with session_not_running before resource
                                 creation, including --dry-run; later native failures never trigger a restart.
                                 Success reports created:false, started:false. Excludes --create-session
                                 and --stop-if-empty. Used for later lanes bound to a runtime's existing proof.
  --create-session NAME          Create a brand-new hidden session NAME for the first lane and return its
                                 proof ({unit, invocation_id, server_pid, server_starttime, boot_id}) and
                                 dir_id. Never reuses or restores an existing session (running or stopped):
                                 session_exists. The directory is claimed with an atomic mkdir; if it is
                                 written to before the server starts, or the session comes up with restored
                                 workspaces or a socket served by another process: session_foreign
                                 (reported only, nothing is stopped or deleted).
                                 Mutually exclusive with --session; same exclusions as --session; no --dry-run.
                                 Requires --op-tag.
  --op-tag TAG                   Opaque token kept verbatim in this process's argv (and the session launcher's)
                                 and exported as HERDR_LANE_OP_TAG to every child process (herdr,
                                 systemd-run, systemctl, launcher), so a supervisor can find in-flight calls
                                 in /proc. The long-lived Herdr server does not carry it.
  --stop-if-empty                With --session only: stop that session if it has no workspaces left.
  --dry-run                      Probe and report without creating anything or starting a session.
  -h, --help                     Show this help.

Defaults:
  oneshot/service -> same-task; coding-agent -> independent.

Hidden session cleanup: run lane.cleanup_command, then
  route-lane.ts --session NAME --stop-if-empty
View a hidden session with: herdr session attach NAME`;

const allowedTypes: LaneType[] = ["oneshot", "service", "coding-agent"];
const allowedScopes: LaneScope[] = ["same-task", "independent"];
const allowedDirections: Direction[] = ["auto", "right", "down"];

await runCli(async () => {
  const flags = parseFlags(
    process.argv.slice(2),
    ["--type", "--cwd", "--scope", "--caller-pane", "--direction", "--label", "--session", "--create-session", "--op-tag"],
    ["--dry-run", "--stop-if-empty", "--require-running", "--help"],
  );
  if (flags.has("--help")) {
    process.stdout.write(`${usage}\n`);
    return;
  }

  requireHerdr();
  const rawSession = flags.get("--session");
  const rawCreate = flags.get("--create-session");
  if (rawSession !== undefined && rawCreate !== undefined) {
    throw new CliError("conflicting_options", "--create-session and --session are mutually exclusive", 2);
  }
  const requireRunning = flags.has("--require-running");
  if (requireRunning) {
    if (rawCreate !== undefined || flags.has("--stop-if-empty")) {
      throw new CliError("conflicting_options", "--require-running cannot be combined with --create-session or --stop-if-empty", 2);
    }
    if (rawSession === undefined) {
      throw new CliError("missing_argument", "--require-running requires --session", 2);
    }
  }
  const createName = rawCreate === undefined ? null : parseSessionName(String(rawCreate), "--create-session");
  const sessionName = createName
    ?? (rawSession === undefined ? null : parseSessionName(String(rawSession)));
  const rawOpTag = flags.get("--op-tag");
  const opTag = rawOpTag === undefined ? null : parseOpTag(String(rawOpTag));
  // Every herdr/systemd/launcher child inherits the tag, so a call outliving this process stays discoverable.
  if (opTag) process.env[OP_TAG_ENV] = opTag;
  else delete process.env[OP_TAG_ENV];
  if (createName && !opTag) throw new CliError("missing_argument", "--create-session requires --op-tag", 2);
  if (flags.has("--stop-if-empty")) {
    if (!rawSession) throw new CliError("missing_argument", "--stop-if-empty requires --session", 2);
    const others = [...flags.keys()].filter((flag) => !["--session", "--stop-if-empty", "--op-tag"].includes(flag));
    if (others.length > 0) {
      throw new CliError("conflicting_options", `--stop-if-empty cannot be combined with ${others.join(", ")}`, 2);
    }
    emit({ ok: true, session: await stopSessionIfEmpty(sessionName!) });
    return;
  }

  const laneType = flags.get("--type");
  const inputCwd = flags.get("--cwd");
  if (typeof laneType !== "string") throw new CliError("missing_argument", "--type is required", 2);
  if (typeof inputCwd !== "string") throw new CliError("missing_argument", "--cwd is required", 2);
  if (!allowedTypes.includes(laneType as LaneType)) {
    throw new CliError("invalid_type", "--type must be oneshot, service, or coding-agent", 2);
  }

  if (sessionName) {
    const flag = createName ? "--create-session" : "--session";
    if (flags.has("--caller-pane")) {
      throw new CliError("conflicting_options", `--caller-pane cannot be combined with ${flag}`, 2);
    }
    if (flags.get("--scope") === "same-task") {
      throw new CliError("invalid_scope", `${flag} lanes are always independent; --scope same-task is unavailable`, 2);
    }
    if (createName && flags.has("--dry-run")) {
      throw new CliError("conflicting_options", "--create-session cannot be combined with --dry-run", 2);
    }
  }
  const scope = (sessionName
    ? "independent"
    : flags.get("--scope") ?? (laneType === "coding-agent" ? "independent" : "same-task")) as LaneScope;
  const direction = (flags.get("--direction") ?? "auto") as Direction;
  if (!allowedScopes.includes(scope)) {
    throw new CliError("invalid_scope", "--scope must be same-task or independent", 2);
  }
  if (!allowedDirections.includes(direction)) {
    throw new CliError("invalid_direction", "--direction must be auto, right, or down", 2);
  }

  const dryRun = flags.has("--dry-run");
  // A failure after the session was created must still tell the caller which session it left behind.
  const afterCreate = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof CliError) || !createName || !session) throw error;
      throw new CliError(error.code, error.message, error.status, { ...error.details, session });
    }
  };
  let session: SessionState | CreatedSession | null = null;
  let sessionIsRunning = true;
  if (sessionName) {
    // Fail on a bad cwd before a session is started for it.
    if (!normalizeDir(inputCwd)) {
      throw new CliError("invalid_cwd", `Target cwd does not exist or is not a directory: ${inputCwd}`, 2);
    }
    if (createName) {
      session = await createSession(createName, opTag!);
      sessionIsRunning = false; // brand new: no workspaces to probe
    } else if (requireRunning) {
      session = await requireRunningSession(sessionName);
    } else if (dryRun) {
      sessionIsRunning = await sessionRunning(sessionName);
      session = { name: sessionName, created: false, running_before: sessionIsRunning, started: false, unit: null };
    } else {
      session = await ensureSession(sessionName);
    }
    setHerdrSession(sessionName);
  }

  // The caller lives in the user's main server; hidden sessions have none.
  const caller = sessionName ? null : await resolveCaller(flags.get("--caller-pane") as string | undefined);
  const probe = await afterCreate(() => probeWorkspace(inputCwd, { skipWorkspaces: !sessionIsRunning }));
  let action: RouteAction;
  let reason: string;
  if (caller && scope === "same-task" && probe.match.workspaceId === caller.workspaceId) {
    action = "split-pane";
    reason = "same-task lane matches the caller workspace";
  } else if (probe.match.workspaceId) {
    action = "create-tab";
    reason = "target directory matches an existing workspace";
  } else {
    action = "create-workspace";
    reason = "no existing workspace safely matches the target directory";
  }

  const cleanup = {
    oneshot: "close-after-result",
    service: "close-after-dependents",
    "coding-agent": "keep-while-useful",
  }[laneType as LaneType];
  const cleanupResource = {
    "split-pane": "pane",
    "create-tab": "tab",
    "create-workspace": "workspace",
  }[action];
  let result: ResourceIds = { workspaceId: null, tabId: null, paneId: null };
  if (dryRun) {
    if (action === "split-pane" && caller) result = { ...caller, paneId: null };
    if (action === "create-tab") result.workspaceId = probe.match.workspaceId;
  } else {
    result = await afterCreate(() => createResource({
      action,
      cwd: probe.target.cwd,
      caller: caller ?? { workspaceId: null, tabId: null, paneId: null },
      matchedWorkspaceId: probe.match.workspaceId,
      direction,
      label: (flags.get("--label") as string | undefined) ?? "",
    }));
  }
  const cleanupTargetId = {
    pane: result.paneId,
    tab: result.tabId,
    workspace: result.workspaceId,
  }[cleanupResource];
  const cleanupCommand = dryRun || !cleanupTargetId
    ? null
    : sessionName
      ? ["herdr", "--session", sessionName, cleanupResource, "close", cleanupTargetId]
      : ["herdr", cleanupResource, "close", cleanupTargetId];

  emit({
    ok: true,
    dry_run: dryRun,
    action,
    reason,
    lane: {
      type: laneType,
      scope,
      cleanup,
      cleanup_resource: cleanupResource,
      cleanup_target_id: cleanupTargetId,
      cleanup_command: cleanupCommand,
    },
    target: { cwd: probe.target.cwd, git_root: probe.target.gitRoot },
    session,
    caller: caller && {
      workspace_id: caller.workspaceId,
      tab_id: caller.tabId,
      pane_id: caller.paneId,
    },
    match: {
      kind: probe.match.kind,
      score: probe.match.score,
      workspace_id: probe.match.workspaceId,
    },
    result: {
      workspace_id: result.workspaceId,
      tab_id: result.tabId,
      pane_id: result.paneId,
    },
  });
});
