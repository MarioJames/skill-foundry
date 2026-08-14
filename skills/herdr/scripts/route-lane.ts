#!/usr/bin/env bun

import {
  CliError,
  createResource,
  emit,
  parseFlags,
  probeWorkspace,
  requireHerdr,
  resolveCaller,
  runCli,
  type Direction,
  type LaneScope,
  type LaneType,
  type ResourceIds,
  type RouteAction,
} from "./lib/herdr-route";

const usage = `Usage:
  route-lane.ts --type oneshot|service|coding-agent --cwd PATH [options]

Options:
  --scope same-task|independent  Override the type default.
  --caller-pane PANE_ID          Anchor routing to an explicit caller pane.
  --direction auto|right|down    Split direction; default: auto.
  --label TEXT                   Label a created tab or workspace.
  --dry-run                      Probe and report without creating anything.
  -h, --help                     Show this help.

Defaults:
  oneshot/service -> same-task; coding-agent -> independent.`;

const allowedTypes: LaneType[] = ["oneshot", "service", "coding-agent"];
const allowedScopes: LaneScope[] = ["same-task", "independent"];
const allowedDirections: Direction[] = ["auto", "right", "down"];

await runCli(async () => {
  const flags = parseFlags(
    process.argv.slice(2),
    ["--type", "--cwd", "--scope", "--caller-pane", "--direction", "--label"],
    ["--dry-run", "--help"],
  );
  if (flags.has("--help")) {
    process.stdout.write(`${usage}\n`);
    return;
  }

  requireHerdr();
  const laneType = flags.get("--type");
  const inputCwd = flags.get("--cwd");
  if (typeof laneType !== "string") throw new CliError("missing_argument", "--type is required", 2);
  if (typeof inputCwd !== "string") throw new CliError("missing_argument", "--cwd is required", 2);
  if (!allowedTypes.includes(laneType as LaneType)) {
    throw new CliError("invalid_type", "--type must be oneshot, service, or coding-agent", 2);
  }

  const scope = (flags.get("--scope")
    ?? (laneType === "coding-agent" ? "independent" : "same-task")) as LaneScope;
  const direction = (flags.get("--direction") ?? "auto") as Direction;
  if (!allowedScopes.includes(scope)) {
    throw new CliError("invalid_scope", "--scope must be same-task or independent", 2);
  }
  if (!allowedDirections.includes(direction)) {
    throw new CliError("invalid_direction", "--direction must be auto, right, or down", 2);
  }

  const caller = await resolveCaller(flags.get("--caller-pane") as string | undefined);
  const probe = await probeWorkspace(inputCwd);
  let action: RouteAction;
  let reason: string;
  if (scope === "same-task" && probe.match.workspaceId === caller.workspaceId) {
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
  const dryRun = flags.has("--dry-run");
  let result: ResourceIds = { workspaceId: null, tabId: null, paneId: null };
  if (dryRun) {
    if (action === "split-pane") result = { ...caller, paneId: null };
    if (action === "create-tab") result.workspaceId = probe.match.workspaceId;
  } else {
    result = await createResource({
      action,
      cwd: probe.target.cwd,
      caller,
      matchedWorkspaceId: probe.match.workspaceId,
      direction,
      label: (flags.get("--label") as string | undefined) ?? "",
    });
  }
  const cleanupTargetId = {
    pane: result.paneId,
    tab: result.tabId,
    workspace: result.workspaceId,
  }[cleanupResource];
  const cleanupCommand = dryRun || !cleanupTargetId
    ? null
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
    caller: {
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
