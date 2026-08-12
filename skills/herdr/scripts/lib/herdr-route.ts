import { realpathSync, statSync } from "node:fs";

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
    emit({ ok: false, error: { code: failure.code, message: failure.message } });
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
    const flag = argv[index];
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
  if (process.env.HERDR_ENV !== "1") {
    throw new CliError("not_in_herdr", "HERDR_ENV=1 is required");
  }
  if (!Bun.which("herdr")) throw new CliError("missing_dependency", "herdr is required", 127);
}

async function capture(command: string[]): Promise<{ stdout: string; stderr: string; status: number }> {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout: stdout.trim(), stderr: stderr.trim(), status };
}

async function herdr(...args: string[]): Promise<any> {
  const result = await capture(["herdr", ...args]);
  if (result.status !== 0) {
    throw new CliError("herdr_failed", [result.stdout, result.stderr].filter(Boolean).join("\n"), result.status);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new CliError("invalid_herdr_json", "Herdr returned non-JSON output");
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

export async function probeWorkspace(input: string): Promise<WorkspaceProbe> {
  const target = normalizeDir(input);
  if (!target) throw new CliError("invalid_cwd", `Target cwd does not exist or is not a directory: ${input}`, 2);

  const targetGitRoot = await gitRoot(target);
  const home = normalizeDir(process.env.HOME ?? "/") ?? "/";
  const listed = await herdr("workspace", "list");
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
  return caller;
}

async function closeQuietly(kind: "pane" | "tab" | "workspace", id: string | null): Promise<void> {
  if (!id) return;
  const child = Bun.spawn(["herdr", kind, "close", id], { stdout: "ignore", stderr: "ignore" });
  await child.exited;
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
    const createdCwd = normalizeDir(created?.result?.pane?.cwd ?? "");
    if (
      result.workspaceId !== options.caller.workspaceId
      || result.tabId !== options.caller.tabId
      || !result.paneId
      || createdCwd !== options.cwd
    ) {
      await closeQuietly("pane", result.paneId);
      throw new CliError("verification_failed", "Created pane did not match the intended workspace, tab, and cwd");
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
    const createdCwd = normalizeDir(created?.result?.root_pane?.cwd ?? "");
    if (
      result.workspaceId !== options.matchedWorkspaceId
      || !result.tabId
      || !result.paneId
      || createdCwd !== options.cwd
    ) {
      await closeQuietly("tab", result.tabId);
      throw new CliError("verification_failed", "Created tab did not match the intended workspace and cwd");
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
  const createdCwd = normalizeDir(created?.result?.root_pane?.cwd ?? "");
  if (!result.workspaceId || !result.tabId || !result.paneId || createdCwd !== options.cwd) {
    await closeQuietly("workspace", result.workspaceId);
    throw new CliError("verification_failed", "Created workspace did not match the intended cwd");
  }
  return result;
}
