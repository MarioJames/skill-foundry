import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { ancestorPids, ownsPane } from "./caller-identity";

export type LaneType = "oneshot" | "service" | "coding-agent";
export type LaneScope = "same-task" | "independent";
export type Direction = "auto" | "right" | "down";
export type RouteAction = "split-pane" | "create-tab" | "create-workspace";

export interface ResourceIds {
  workspaceId: string | null;
  tabId: string | null;
  paneId: string | null;
}

export interface WorkspaceProbe {
  target: { cwd: string; gitRoot: string | null };
  match: {
    kind: "exact-cwd" | "git-root" | "ancestor-cwd" | "descendant-cwd" | null;
    score: number | null;
    workspaceId: string | null;
  };
}

export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 1,
    /** Extra top-level fields for the failure JSON, e.g. the session a failed lane left behind. */
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export async function runCli(work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (error) {
    const failure = error instanceof CliError
      ? error
      : new CliError("internal_error", error instanceof Error ? error.message : String(error));
    emit({ ok: false, error: { code: failure.code, message: failure.message }, ...failure.details });
    process.exitCode = failure.status;
  }
}

export function parseFlags(
  argv: string[],
  valueFlags: readonly string[],
  booleanFlags: readonly string[] = [],
): Map<string, string | true> {
  const values = new Set(valueFlags);
  const booleans = new Set(booleanFlags);
  const parsed = new Map<string, string | true>();

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (flag === "-h") {
      parsed.set("--help", true);
    } else if (booleans.has(flag)) {
      parsed.set(flag, true);
    } else if (values.has(flag)) {
      const value = argv[index + 1];
      if (value === undefined) throw new CliError("missing_value", `${flag} requires a value`, 2);
      parsed.set(flag, value);
      index += 1;
    } else {
      throw new CliError("unknown_option", `Unknown option: ${flag}`, 2);
    }
  }
  return parsed;
}

export function requireHerdr(): void {
  if (!Bun.which("herdr")) {
    throw new CliError("missing_dependency", "herdr is required", 127);
  }
}

let activeSession: string | null = null;

/** Route every herdr call made through this module to a named session. */
export function setHerdrSession(name: string | null): void {
  activeSession = name;
}

export function herdrCommand(...args: string[]): string[] {
  return ["herdr", ...(activeSession ? ["--session", activeSession] : []), ...args];
}

export async function capture(command: string[]): Promise<{ stdout: string; stderr: string; status: number }> {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe", env: process.env });
  const [stdout, stderr, status] = await Promise.all([
    Bun.readableStreamToText(child.stdout),
    Bun.readableStreamToText(child.stderr),
    child.exited,
  ]);
  return { stdout: stdout.trim(), stderr: stderr.trim(), status };
}

export async function herdr(...args: string[]): Promise<any> {
  const result = await capture(herdrCommand(...args));
  if (result.status !== 0) {
    throw new CliError("herdr_failed", [result.stdout, result.stderr].filter(Boolean).join("\n"), result.status);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new CliError("invalid_herdr_json", "Herdr returned non-JSON output");
  }
}

async function herdrWithoutJson(...args: string[]): Promise<void> {
  const result = await capture(herdrCommand(...args));
  if (result.status !== 0) {
    throw new CliError("herdr_failed", [result.stdout, result.stderr].filter(Boolean).join("\n"), result.status);
  }
}

export function normalizeDir(input: string): string | null {
  try {
    if (!statSync(input).isDirectory()) return null;
    return realpathSync(input);
  } catch {
    return null;
  }
}

async function gitRoot(cwd: string): Promise<string | null> {
  const result = await capture(["git", "-C", cwd, "rev-parse", "--show-toplevel"]);
  return result.status === 0 && result.stdout ? normalizeDir(result.stdout) : null;
}

function isAncestor(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

function scorePath(
  candidate: string,
  candidateGitRoot: string | null,
  target: string,
  targetGitRoot: string | null,
  home: string,
): { score: number; kind: NonNullable<WorkspaceProbe["match"]["kind"]> } | null {
  const safe = (path: string) => path !== "/" && path !== home;
  if (candidate === target) return { score: 400_000 + candidate.length, kind: "exact-cwd" };
  if (targetGitRoot && candidateGitRoot === targetGitRoot) {
    return { score: 300_000 + targetGitRoot.length, kind: "git-root" };
  }
  if (safe(candidate) && isAncestor(candidate, target)) {
    return { score: 200_000 + candidate.length, kind: "ancestor-cwd" };
  }
  if (safe(target) && isAncestor(target, candidate)) {
    return { score: 100_000 + target.length, kind: "descendant-cwd" };
  }
  return null;
}

export async function probeWorkspace(
  input: string,
  options: { skipWorkspaces?: boolean } = {},
): Promise<WorkspaceProbe> {
  const target = normalizeDir(input);
  if (!target) throw new CliError("invalid_cwd", `Target cwd does not exist or is not a directory: ${input}`, 2);

  const targetGitRoot = await gitRoot(target);
  const home = normalizeDir(process.env.HOME ?? "/") ?? "/";
  const listed = options.skipWorkspaces ? {} : await herdr("workspace", "list");
  const ids = (listed?.result?.workspaces ?? [])
    .map((workspace: any) => workspace?.workspace_id)
    .filter((id: unknown): id is string => typeof id === "string" && id.length > 0);

  const gitRoots = new Map<string, Promise<string | null>>([[target, Promise.resolve(targetGitRoot)]]);
  const cachedGitRoot = (cwd: string) => {
    if (!gitRoots.has(cwd)) gitRoots.set(cwd, gitRoot(cwd));
    return gitRoots.get(cwd)!;
  };

  const scored = await Promise.all(ids.map(async (workspaceId: string) => {
    const listedPanes = await herdr("pane", "list", "--workspace", workspaceId);
    const paths = new Set<string>();
    for (const pane of listedPanes?.result?.panes ?? []) {
      for (const raw of [pane?.cwd, pane?.foreground_cwd]) {
        if (typeof raw === "string") {
          const normalized = normalizeDir(raw);
          if (normalized) paths.add(normalized);
        }
      }
    }

    const candidates = await Promise.all([...paths].map(async (cwd) =>
      scorePath(cwd, await cachedGitRoot(cwd), target, targetGitRoot, home)));
    const best = candidates.filter((candidate) => candidate !== null)
      .sort((left, right) => right.score - left.score)[0] ?? null;
    return { workspaceId, ...best };
  }));

  const bestScore = Math.max(-1, ...scored.map((candidate) => candidate.score ?? -1));
  const matches = scored.filter((candidate) => candidate.score === bestScore && bestScore >= 0);
  if (matches.length > 1) {
    throw new CliError(
      "ambiguous_workspace",
      `Equal directory matches found in workspaces: ${matches.map((match) => match.workspaceId).join(",")}`,
    );
  }

  const match = matches[0] ?? null;
  return {
    target: { cwd: target, gitRoot: targetGitRoot },
    match: {
      kind: match?.kind ?? null,
      score: match?.score ?? null,
      workspaceId: match?.workspaceId ?? null,
    },
  };
}

export async function resolveCaller(paneId?: string): Promise<ResourceIds> {
  const current = paneId
    ? await herdr("pane", "current", "--pane", paneId)
    : await herdr("pane", "current", "--current");
  const pane = current?.result?.pane;
  const caller = {
    workspaceId: typeof pane?.workspace_id === "string" ? pane.workspace_id : null,
    tabId: typeof pane?.tab_id === "string" ? pane.tab_id : null,
    paneId: typeof pane?.pane_id === "string" ? pane.pane_id : null,
  };
  if (!caller.workspaceId || !caller.tabId || !caller.paneId) {
    throw new CliError("invalid_caller", "Could not resolve caller pane context");
  }
  if (paneId && caller.paneId !== paneId) {
    throw new CliError("invalid_caller", "Herdr returned a different pane than explicitly requested");
  }
  // Explicit IDs are supplied by the owner/handoff. Automatic discovery must
  // prove process ownership: --current may use stale env IDs or focused panes.
  if (!paneId) {
    const info = await herdr("pane", "process-info", "--pane", caller.paneId);
    if (!ownsPane(caller.paneId, info?.result?.process_info, ancestorPids())) {
      throw new CliError("unverified_caller", "Candidate pane does not own this process; skip automatic naming/routing. Inherited IDs and focus are not ownership evidence.");
    }
  }
  return caller;
}

async function ensureTabLabel(result: ResourceIds, label: string): Promise<void> {
  if (!label) return;
  const readTab = async () => {
    const response = await herdr("tab", "get", result.tabId!);
    const tab = response?.result?.tab;
    if (tab?.tab_id !== result.tabId || tab?.workspace_id !== result.workspaceId) {
      throw new CliError("verification_failed", "Created tab read-back did not match its resource IDs");
    }
    return tab;
  };
  if ((await readTab()).label === label) return;
  await herdr("tab", "rename", result.tabId!, label);
  if ((await readTab()).label !== label) {
    throw new CliError("verification_failed", `Created tab ${result.tabId} did not retain the requested label`);
  }
}

const INTERACTIVE_SHELLS = new Set(["bash", "dash", "fish", "ksh", "nu", "pwsh", "sh", "zsh"]);

function shellName(process: any): string {
  const raw = typeof process?.name === "string"
    ? process.name
    : typeof process?.argv0 === "string" ? process.argv0 : "";
  const name = raw.replace(/^-+/u, "").split("/").at(-1) ?? "";
  return name.toLowerCase();
}

export async function waitForPaneShell(paneId: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastFailure = "foreground shell not reported";

  while (Date.now() < deadline) {
    try {
      const response = await herdr("pane", "process-info", "--pane", paneId);
      const processes = response?.result?.process_info?.foreground_processes;
      const shellIsIdle = Array.isArray(processes)
        && processes.length > 0
        && processes.every((process: any) => INTERACTIVE_SHELLS.has(shellName(process)));
      if (!shellIsIdle) {
        const names = Array.isArray(processes) ? processes.map(shellName).filter(Boolean) : [];
        lastFailure = names.length > 0
          ? `foreground processes still active: ${names.join(", ")}`
          : "foreground shell not reported";
        await Bun.sleep(50);
        continue;
      }

      // process-info can report zsh just before the pane starts accepting input.
      // A round-trip probe closes that race instead of handing a busy pane to an agent.
      const token = randomUUID().replaceAll("-", "");
      const marker = `HERDR_READY_${token}`;
      const payload = `printf 'HERDR_READY_%s\\n' '${token}'`;
      await herdrWithoutJson("pane", "run", paneId, payload);

      const remainingMs = Math.max(1, deadline - Date.now());
      await herdr(
        "pane", "wait-output", paneId,
        "--match", marker,
        "--source", "recent-unwrapped",
        "--timeout", String(remainingMs),
      );

      while (Date.now() < deadline) {
        const settled = await herdr("pane", "process-info", "--pane", paneId);
        const foreground = settled?.result?.process_info?.foreground_processes;
        if (Array.isArray(foreground)
          && foreground.length > 0
          && foreground.every((process: any) => INTERACTIVE_SHELLS.has(shellName(process)))) {
          return;
        }
        await Bun.sleep(50);
      }
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(50);
  }
  throw new CliError("pane_not_ready", `Created pane ${paneId} did not reach an idle shell: ${lastFailure}`);
}

function ids(pane: any): ResourceIds {
  return {
    workspaceId: typeof pane?.workspace_id === "string" ? pane.workspace_id : null,
    tabId: typeof pane?.tab_id === "string" ? pane.tab_id : null,
    paneId: typeof pane?.pane_id === "string" ? pane.pane_id : null,
  };
}

export async function createResource(options: {
  action: RouteAction;
  cwd: string;
  caller: ResourceIds;
  matchedWorkspaceId: string | null;
  direction: Direction;
  label: string;
}): Promise<ResourceIds> {
  const kind = options.action === "split-pane" ? "pane"
    : options.action === "create-tab" ? "tab" : "workspace";
  const workspaceId = options.action === "create-tab" ? options.matchedWorkspaceId : options.caller.workspaceId;
  const listed = await herdr(kind, "list", ...(kind === "workspace" ? [] : ["--workspace", workspaceId!]));
  const existing = listed?.result?.[`${kind}s`];
  if (!Array.isArray(existing)) {
    throw new CliError("verification_failed", `Could not establish existing ${kind} IDs before creation`);
  }
  const existingIds = new Set(existing.map((resource: any) => resource?.[`${kind}_id`]));
  existingIds.add(options.caller[`${kind}Id`]);
  const verifyNewId = (id: string | null) => {
    if (typeof id !== "string" || !id || existingIds.has(id)) {
      throw new CliError("verification_failed", `Herdr did not return a new ${kind} ID; existing resources were left intact`);
    }
  };
  const rollback = async (id: string, error: unknown): Promise<never> => {
    try {
      await herdrWithoutJson(kind, "close", id);
    } catch (cleanupError) {
      throw new CliError("cleanup_failed", `${error instanceof Error ? error.message : error}; rollback failed: ${cleanupError instanceof Error ? cleanupError.message : cleanupError}. Cleanup only this resource: ${herdrCommand(kind, "close", id).join(" ")}`);
    }
    throw error;
  };

  if (options.action === "split-pane") {
    let direction = options.direction;
    if (direction === "auto") {
      const layout = await herdr("pane", "layout", "--pane", options.caller.paneId!);
      const pane = (layout?.result?.layout?.panes ?? [])
        .find((candidate: any) => candidate?.pane_id === options.caller.paneId);
      const width = Number(pane?.rect?.width);
      const height = Number(pane?.rect?.height);
      if (!Number.isFinite(width) || !Number.isFinite(height)) {
        throw new CliError("missing_layout", "Could not resolve caller pane dimensions");
      }
      direction = width >= height * 2 ? "right" : "down";
    }

    const created = await herdr(
      "pane", "split", "--pane", options.caller.paneId!, "--direction", direction,
      "--ratio", "0.5", "--cwd", options.cwd, "--no-focus",
    );
    const result = ids(created?.result?.pane);
    verifyNewId(result.paneId);
    const createdCwd = normalizeDir(created?.result?.pane?.cwd ?? "");
    try {
      if (
        result.workspaceId !== options.caller.workspaceId
        || result.tabId !== options.caller.tabId
        || !result.paneId
        || createdCwd !== options.cwd
      ) {
        throw new CliError("verification_failed", "Created pane did not match the intended workspace, tab, and cwd");
      }
      await waitForPaneShell(result.paneId);
    } catch (error) {
      return rollback(result.paneId!, error);
    }
    return result;
  }

  if (options.action === "create-tab") {
    const args = ["tab", "create", "--workspace", options.matchedWorkspaceId!, "--cwd", options.cwd];
    if (options.label) args.push("--label", options.label);
    args.push("--no-focus");
    const created = await herdr(...args);
    const result = {
      workspaceId: created?.result?.tab?.workspace_id ?? null,
      tabId: created?.result?.tab?.tab_id ?? null,
      paneId: created?.result?.root_pane?.pane_id ?? null,
    } as ResourceIds;
    verifyNewId(result.tabId);
    const createdCwd = normalizeDir(created?.result?.root_pane?.cwd ?? "");
    try {
      if (
        result.workspaceId !== options.matchedWorkspaceId
        || !result.tabId
        || !result.paneId
        || createdCwd !== options.cwd
      ) {
        throw new CliError("verification_failed", "Created tab did not match the intended workspace and cwd");
      }
      await waitForPaneShell(result.paneId!);
      await ensureTabLabel(result, options.label);
    } catch (error) {
      return rollback(result.tabId!, error);
    }
    return result;
  }

  const args = ["workspace", "create", "--cwd", options.cwd];
  if (options.label) args.push("--label", options.label);
  args.push("--no-focus");
  const created = await herdr(...args);
  const result = {
    workspaceId: created?.result?.workspace?.workspace_id ?? null,
    tabId: created?.result?.tab?.tab_id ?? null,
    paneId: created?.result?.root_pane?.pane_id ?? null,
  } as ResourceIds;
  verifyNewId(result.workspaceId);
  const createdCwd = normalizeDir(created?.result?.root_pane?.cwd ?? "");
  try {
    if (!result.workspaceId || !result.tabId || !result.paneId || createdCwd !== options.cwd) {
      throw new CliError("verification_failed", "Created workspace did not match the intended cwd");
    }
    await waitForPaneShell(result.paneId);
    await ensureTabLabel(result, options.label);
  } catch (error) {
    return rollback(result.workspaceId!, error);
  }
  return result;
}


// Hidden sessions: a named, TUI-less Herdr server so background agents stay out
// of the user's main session. Only the session `herdr --session` flag differs.
const SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/u;

export function parseSessionName(raw: string, flag = "--session"): string {
  if (raw === "default") {
    throw new CliError("invalid_session", `${flag} must name a hidden session, not the default session`, 2);
  }
  if (!SESSION_NAME.test(raw)) {
    throw new CliError("invalid_session", `${flag} must match [A-Za-z0-9][A-Za-z0-9_-]* (max 63 chars)`, 2);
  }
  return raw;
}

/** Environment variable carrying the op tag to every child process (they cannot all take `--op-tag`). */
export const OP_TAG_ENV = "AGENTS_COOPERATION_OP_TAG";

const OP_TAG = /^[A-Za-z0-9][A-Za-z0-9._:=@+-]{0,127}$/u;

/** An opaque caller-chosen token kept verbatim in process argv so in-flight calls can be found in /proc. */
export function parseOpTag(raw: string): string {
  if (!OP_TAG.test(raw)) {
    throw new CliError("invalid_op_tag", "--op-tag must match [A-Za-z0-9][A-Za-z0-9._:=@+-]* (max 128 chars)", 2);
  }
  return raw;
}

export function sessionUnit(name: string): string {
  return `herdr-session-${name}`;
}

/** Workspaces of a hidden session, or null when its server is not running. */
export async function listSessionWorkspaces(name: string): Promise<unknown[] | null> {
  const result = await capture(["herdr", "--session", name, "workspace", "list"]);
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  if (result.status !== 0) {
    if (output.includes("server_not_running")) return null;
    throw new CliError("herdr_failed", output, result.status);
  }
  let workspaces: unknown;
  try {
    workspaces = JSON.parse(result.stdout)?.result?.workspaces;
  } catch {
    throw new CliError("invalid_herdr_json", "Herdr returned non-JSON output");
  }
  if (!Array.isArray(workspaces)) {
    throw new CliError("verification_failed", `Could not list workspaces in session ${name}`);
  }
  return workspaces;
}

export async function sessionRunning(name: string): Promise<boolean> {
  return (await listSessionWorkspaces(name)) !== null;
}

export interface SessionState {
  name: string;
  created: false;
  running_before: boolean;
  started: boolean;
  unit: string | null;
}

/** Reuse a live session without ever starting or replacing its server. */
export async function requireRunningSession(name: string): Promise<SessionState> {
  if (!(await sessionRunning(name))) {
    throw new CliError("session_not_running", `Hidden session ${name} is not running; --require-running forbids starting it`);
  }
  return { name, created: false, running_before: true, started: false, unit: null };
}

export async function ensureSession(name: string, timeoutMs = 10_000): Promise<SessionState> {
  if (await sessionRunning(name)) {
    return { name, created: false, running_before: true, started: false, unit: null };
  }
  if (!Bun.which("systemd-run")) {
    throw new CliError("missing_dependency", "systemd-run is required to start a hidden session; not falling back to a bare server", 127);
  }

  const unit = sessionUnit(name);
  // systemd-run and its start-up keep the op tag in their environment; only the long-lived server
  // command drops it, at the exec boundary.
  const child = Bun.spawn([
    "systemd-run", "--user", "--scope", "--collect", `--unit=${unit}`,
    "-p", "MemoryHigh=8G", "-p", "MemoryMax=10G",
    "--", "env", "-u", OP_TAG_ENV, "herdr", "--session", name, "server",
  ], { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true, env: process.env });
  child.unref();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null && child.exitCode !== 0) break;
    if (await sessionRunning(name)) {
      return { name, created: false, running_before: false, started: true, unit: `${unit}.scope` };
    }
    await Bun.sleep(100);
  }
  throw new CliError(
    "session_start_failed",
    `Hidden session ${name} did not become available (unit ${unit}.scope). Inspect: systemctl --user status ${unit}.scope`,
  );
}

export async function stopSessionIfEmpty(
  name: string,
): Promise<{ name: string; stopped: boolean; remaining_workspaces: number }> {
  const workspaces = await listSessionWorkspaces(name);
  if (workspaces === null) return { name, stopped: false, remaining_workspaces: 0 };
  if (workspaces.length > 0) return { name, stopped: false, remaining_workspaces: workspaces.length };
  const stop = await capture(["herdr", "session", "stop", name]);
  if (stop.status !== 0) {
    throw new CliError("herdr_failed", [stop.stdout, stop.stderr].filter(Boolean).join("\n"), stop.status);
  }
  return { name, stopped: true, remaining_workspaces: 0 };
}
