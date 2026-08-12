import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";

import * as db from "./db.ts";
import { ValidationError } from "./errors.ts";
import { jsonDumps } from "./json-utils.ts";
import { operationPath, stablePath } from "./path-utils.ts";

export type AssetType = "skill" | "plugin" | "rule" | "agent";
export type AcceptanceStatus = "draft" | "active" | "done";

export interface AssetRow extends db.SqlRow {
  id: string;
  name: string;
  type: AssetType;
  source_path: string;
  created_at: string;
}

export interface AcceptanceRow extends db.SqlRow {
  id: string;
  asset_id: string;
  goal: string;
  strategy: string | null;
  acceptance_prompt: string | null;
  acceptance_criteria: string | null;
  task_prompts: string | null;
  issues: string | null;
  fixture_path: string | null;
  ladder: string | null;
  budget_max_rounds: number | null;
  status: AcceptanceStatus;
  created_at: string;
  updated_at: string;
}

export interface AcceptanceTargetRow extends AcceptanceRow {
  asset_name: string;
  asset_type: AssetType;
  asset_source: string;
}

export type TaskPrompts = Record<string, string>;
export type LadderRung =
  | "smoke"
  | "representative"
  | "complex"
  | "failure-recovery"
  | "negative-boundary";
export type Ladder = Partial<Record<LadderRung, string[]>>;

const ACCEPTANCE_COLS = new Set([
  "goal",
  "strategy",
  "acceptance_prompt",
  "acceptance_criteria",
  "task_prompts",
  "issues",
  "fixture_path",
  "status",
  "ladder",
  "budget_max_rounds",
]);

const HASH_EXCLUDED_PARTS = new Set([".git", "node_modules", "__pycache__"]);
const LADDER_RUNGS: LadderRung[] = [
  "smoke",
  "representative",
  "complex",
  "failure-recovery",
  "negative-boundary",
];

function hasPluginManifest(source: string): boolean {
  return [
    join(source, ".claude-plugin", "plugin.json"),
    join(source, ".codex-plugin", "plugin.json"),
    join(source, "plugin.json"),
  ].some(existsSync);
}

function pyString(value: unknown): string {
  if (typeof value !== "string") {
    if (value === null) return "None";
    if (value === true) return "True";
    if (value === false) return "False";
    return String(value);
  }
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function pyList(values: unknown[]): string {
  return `[${values.map(pyString).join(", ")}]`;
}

export function addAsset(
  connection: db.Connection,
  name: string,
  type: AssetType,
  sourcePath: string,
): string {
  const id = db.newId("asset");
  db.run(
    connection,
    "INSERT INTO asset (id, name, type, source_path, created_at) VALUES (?,?,?,?,?)",
    [id, name, type, stablePath(sourcePath) as string, db.now()],
  );
  return id;
}

function shapeWarning(type: AssetType, sourcePath: string): string | null {
  const source = operationPath(sourcePath);
  if (!existsSync(source)) {
    return `source path does not exist yet: ${source}`;
  }
  const sourceStats = statSync(source);
  const sourceIsDirectory = sourceStats.isDirectory();
  if (type === "skill" && sourceIsDirectory && !existsSync(join(source, "SKILL.md"))) {
    return "declared type=skill but source has no SKILL.md";
  }
  if (type === "plugin" && sourceIsDirectory && !hasPluginManifest(source)) {
    return "declared type=plugin but source has no host plugin manifest";
  }
  if (type === "agent") {
    if (sourceStats.isFile() && !source.endsWith(".md")) {
      return "declared type=agent but source is not a .md file";
    }
    if (sourceIsDirectory) {
      const hasMarkdown = readdirSync(source).some((name) => name.endsWith(".md"));
      if (!existsSync(join(source, "agents")) && !hasMarkdown) {
        return "declared type=agent but source has no agents/ dir or *.md";
      }
    }
  }
  return null;
}

export interface AssetRegistration {
  id: string;
  created: boolean;
  warning: string | null;
}

export function registerAsset(
  connection: db.Connection,
  name: string,
  type: AssetType,
  sourcePath: string,
): AssetRegistration {
  const source = stablePath(sourcePath) as string;
  const existing = getAssetByName(connection, name);
  if (existing) {
    if (existing.type === type && existing.source_path === source) {
      return {
        id: existing.id,
        created: false,
        warning: shapeWarning(type, source),
      };
    }
    throw new ValidationError(
      `asset ${pyString(name)} already registered as type=${existing.type} `
      + `source=${existing.source_path}; use a new name or matching type/source`,
    );
  }
  return {
    id: addAsset(connection, name, type, sourcePath),
    created: true,
    warning: shapeWarning(type, source),
  };
}

export function getAssetByName(connection: db.Connection, name: string): AssetRow | null {
  return db.get<AssetRow>(connection, "SELECT * FROM asset WHERE name=?", [name]);
}

export function getAsset(connection: db.Connection, value: string): AssetRow | null {
  return db.get<AssetRow>(
    connection,
    "SELECT * FROM asset WHERE id=? OR name=? "
      + "ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END LIMIT 1",
    [value, value, value],
  );
}

export function getAcceptance(
  connection: db.Connection,
  acceptanceId: string,
): AcceptanceRow | null {
  return db.get<AcceptanceRow>(
    connection,
    "SELECT * FROM acceptance WHERE id=?",
    [acceptanceId],
  );
}

export function getAcceptanceTarget(
  connection: db.Connection,
  acceptanceId: string,
): AcceptanceTargetRow | null {
  return db.get<AcceptanceTargetRow>(
    connection,
    "SELECT a.*, asset.name AS asset_name, asset.type AS asset_type, "
      + "asset.source_path AS asset_source FROM acceptance a "
      + "JOIN asset ON asset.id=a.asset_id WHERE a.id=?",
    [acceptanceId],
  );
}

export function listAssets(
  connection: db.Connection,
  filters: { type?: AssetType; name?: string } = {},
): AssetRow[] {
  let sql = "SELECT * FROM asset";
  const where: string[] = [];
  const parameters: db.SqlValue[] = [];
  if (filters.type) {
    where.push("type=?");
    parameters.push(filters.type);
  }
  if (filters.name) {
    where.push("name=?");
    parameters.push(filters.name);
  }
  if (where.length) {
    sql += ` WHERE ${where.join(" AND ")}`;
  }
  return db.all<AssetRow>(connection, `${sql} ORDER BY created_at`, parameters);
}

export function validateTaskPrompts(value: unknown): TaskPrompts {
  const hint = 'task-prompts must be a non-empty flat JSON object like {"t1": "body"}';
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ValidationError(hint);
  }
  const entries = Object.entries(value);
  if (!entries.length) {
    throw new ValidationError(hint);
  }
  for (const [key, body] of entries) {
    if (!key.trim()) {
      throw new ValidationError(`${hint}; keys must be non-empty strings`);
    }
    if (typeof body !== "string" || !body.trim()) {
      throw new ValidationError(
        `${hint}; task-prompts[${pyString(key)}] must be a non-empty string body`,
      );
    }
  }
  return value as TaskPrompts;
}

function dumpTaskPrompts(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch (error) {
      throw new ValidationError(`task-prompts is not valid JSON: ${String(error)}`);
    }
  }
  return jsonDumps(validateTaskPrompts(parsed));
}

export function validateLadder(value: unknown, taskPrompts: TaskPrompts): Ladder {
  if (typeof value !== "object" || value === null || Array.isArray(value)
      || Object.keys(value).length === 0) {
    throw new ValidationError(
      "ladder must be a non-empty JSON object mapping rung names to task-key lists",
    );
  }
  const ladder = value as Record<string, unknown>;
  const unknown = Object.keys(ladder)
    .filter((rung) => !LADDER_RUNGS.includes(rung as LadderRung))
    .sort();
  if (unknown.length) {
    throw new ValidationError(
      `unknown rung(s) ${pyList(unknown)}; valid rungs: ${pyList(LADDER_RUNGS)}`,
    );
  }
  const output: Ladder = {};
  for (const [rung, keys] of Object.entries(ladder)) {
    if (!Array.isArray(keys) || keys.length === 0) {
      throw new ValidationError(`ladder rung ${pyString(rung)} must be a non-empty list`);
    }
    for (const key of keys) {
      if (typeof key !== "string" || !(key in taskPrompts)) {
        throw new ValidationError(
          `ladder rung ${pyString(rung)} references task ${pyString(key)} `
          + "not in task_prompts",
        );
      }
    }
    output[rung as LadderRung] = [...keys] as string[];
  }
  return output;
}

function dumpLadder(value: unknown, taskPrompts: TaskPrompts): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch (error) {
      throw new ValidationError(`ladder is not valid JSON: ${String(error)}`);
    }
  }
  return jsonDumps(validateLadder(parsed, taskPrompts));
}

export interface NewAcceptanceOptions {
  strategy?: string | null;
  acceptancePrompt?: string | null;
  acceptanceCriteria?: string | null;
  taskPrompts?: unknown;
  fixturePath?: string | null;
}

export function newAcceptance(
  connection: db.Connection,
  assetId: string,
  goal: string,
  options: NewAcceptanceOptions = {},
): string {
  const id = db.newId("acc");
  const timestamp = db.now();
  db.run(
    connection,
    "INSERT INTO acceptance (id, asset_id, goal, strategy, acceptance_prompt, "
      + "acceptance_criteria, task_prompts, fixture_path, status, created_at, updated_at) "
      + "VALUES (?,?,?,?,?,?,?,?, 'draft', ?, ?)",
    [
      id,
      assetId,
      goal,
      options.strategy ?? null,
      options.acceptancePrompt ?? null,
      options.acceptanceCriteria ?? null,
      dumpTaskPrompts(options.taskPrompts),
      stablePath(options.fixturePath) ?? null,
      timestamp,
      timestamp,
    ],
  );
  return id;
}

export interface AcceptanceUpdates {
  goal?: string;
  strategy?: string | null;
  acceptance_prompt?: string | null;
  acceptance_criteria?: string | null;
  task_prompts?: unknown;
  issues?: string | null;
  fixture_path?: string | null;
  status?: AcceptanceStatus;
  ladder?: unknown;
  budget_max_rounds?: number | null;
}

export function updateAcceptance(
  connection: db.Connection,
  acceptanceId: string,
  fields: AcceptanceUpdates,
): void {
  const columns: Record<string, db.SqlValue> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (ACCEPTANCE_COLS.has(key) && value !== undefined) {
      columns[key] = value as db.SqlValue;
    }
  }
  if ("task_prompts" in columns) {
    columns.task_prompts = dumpTaskPrompts(fields.task_prompts);
  }
  if ("ladder" in columns && fields.ladder !== null) {
    let taskPromptsRaw = columns.task_prompts;
    if (taskPromptsRaw === undefined) {
      const row = db.get<{ task_prompts: string | null }>(
        connection,
        "SELECT task_prompts FROM acceptance WHERE id=?",
        [acceptanceId],
      );
      taskPromptsRaw = row?.task_prompts ?? null;
    }
    const taskPrompts = taskPromptsRaw ? JSON.parse(String(taskPromptsRaw)) as TaskPrompts : {};
    columns.ladder = dumpLadder(fields.ladder, taskPrompts);
  }
  columns.updated_at = db.now();
  const assignments = Object.keys(columns).map((key) => `${key}=?`).join(", ");
  db.run(
    connection,
    `UPDATE acceptance SET ${assignments} WHERE id=?`,
    [...Object.values(columns), acceptanceId],
  );
}

export function listAcceptances(
  connection: db.Connection,
  filters: { assetId?: string; status?: string } = {},
): AcceptanceRow[] {
  let sql = "SELECT * FROM acceptance";
  const where: string[] = [];
  const parameters: db.SqlValue[] = [];
  if (filters.assetId) {
    where.push("asset_id=?");
    parameters.push(filters.assetId);
  }
  if (filters.status) {
    where.push("status=?");
    parameters.push(filters.status);
  }
  if (where.length) {
    sql += ` WHERE ${where.join(" AND ")}`;
  }
  return db.all<AcceptanceRow>(connection, `${sql} ORDER BY created_at`, parameters);
}

export function getTaskPrompts(
  connection: db.Connection,
  acceptanceId: string,
): TaskPrompts {
  const row = db.get<{ task_prompts: string | null }>(
    connection,
    "SELECT task_prompts FROM acceptance WHERE id=?",
    [acceptanceId],
  );
  return row?.task_prompts ? JSON.parse(row.task_prompts) as TaskPrompts : {};
}

export function getLadder(connection: db.Connection, acceptanceId: string): Ladder {
  const row = db.get<{ ladder: string | null }>(
    connection,
    "SELECT ladder FROM acceptance WHERE id=?",
    [acceptanceId],
  );
  return row?.ladder ? JSON.parse(row.ladder) as Ladder : {};
}

export function getAcceptanceBody(
  connection: db.Connection,
  acceptanceId: string,
  kind: "prompt" | "criteria",
): string | null {
  const column = kind === "prompt" ? "acceptance_prompt" : "acceptance_criteria";
  const row = db.get<{ body: string | null }>(
    connection,
    `SELECT ${column} AS body FROM acceptance WHERE id=?`,
    [acceptanceId],
  );
  return row?.body ?? null;
}

function collectHashFiles(root: string): string[] {
  const output: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (HASH_EXCLUDED_PARTS.has(entry.name)) {
        continue;
      }
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile()) {
        output.push(path);
      } else if (entry.isSymbolicLink()) {
        try {
          if (statSync(path).isFile()) {
            output.push(path);
          }
        } catch {
          // A broken symlink is not a file, matching Path.is_file().
        }
      }
    }
  };
  visit(root);
  return output.sort();
}

export function sourceHash(sourcePath: string): string | null {
  const source = resolve(operationPath(sourcePath));
  if (!existsSync(source)) {
    return null;
  }
  const digest = createHash("sha256");
  const sourceStats = statSync(source);
  const sourceParts = source.split(sep).filter(Boolean);
  const files = sourceStats.isFile()
    ? [source]
    : sourceParts.some((part) => HASH_EXCLUDED_PARTS.has(part))
      ? []
      : collectHashFiles(source);
  for (const path of files) {
    const rel = sourceStats.isFile() ? basename(path) : relative(source, path);
    digest.update(rel, "utf8");
    digest.update("\0");
    try {
      digest.update(readFileSync(path));
    } catch {
      digest.update("<unreadable>", "utf8");
    }
    digest.update("\0");
  }
  return digest.digest("hex");
}

interface PassGateRound extends db.SqlRow {
  id: string;
  verdict: string;
  asset_hash: string | null;
  task_keys: string | null;
}

export function canFinalizePass(
  connection: db.Connection,
  roundId: string,
): [boolean, string | null] {
  const row = db.get<{
    id: string;
    acceptance_id: string;
    verdict: string;
    source_path: string;
  }>(
    connection,
    "SELECT r.id, r.acceptance_id, r.verdict, asset.source_path "
      + "FROM round r JOIN acceptance a ON a.id=r.acceptance_id "
      + "JOIN asset ON asset.id=a.asset_id WHERE r.id=?",
    [roundId],
  );
  if (!row) {
    return [false, "round not found"];
  }
  const ladder = getLadder(connection, row.acceptance_id);
  if (!Object.keys(ladder).length) {
    return [true, null];
  }
  const current = sourceHash(row.source_path);
  const acceptanceRounds = db.all<PassGateRound>(
    connection,
    "SELECT id, verdict, asset_hash, task_keys FROM round "
      + "WHERE acceptance_id=? ORDER BY started_at",
    [row.acceptance_id],
  );
  const covered = new Set<string>();
  let stalePassSeen = false;
  for (const candidate of acceptanceRounds) {
    const prospective = candidate.id === roundId && row.verdict === "running";
    if (candidate.verdict !== "PASS" && !prospective) {
      continue;
    }
    if (candidate.asset_hash && current && candidate.asset_hash === current) {
      const taskKeys = candidate.task_keys
        ? JSON.parse(candidate.task_keys) as string[]
        : [];
      for (const key of taskKeys) covered.add(key);
    } else {
      stalePassSeen = true;
    }
  }
  for (const [rung, keys] of Object.entries(ladder)) {
    const missing = (keys ?? []).filter((key) => !covered.has(key)).sort();
    if (missing.length) {
      const suffix = stalePassSeen ? " (stale PASS rounds do not count)" : "";
      return [
        false,
        `ladder rung ${pyString(rung)} lacks a non-stale PASS round covering `
          + `task(s) ${pyList(missing)}${suffix}; record coverage via `
          + "`feed-task --round` or `profile run-task`, or use "
          + "--allow-partial <reason> to override",
      ];
    }
  }
  return [true, null];
}

interface HistoryRound extends db.SqlRow {
  id: string;
  acceptance_id: string;
  asset_hash: string | null;
}

export function history(connection: db.Connection, assetName: string): Record<string, unknown> {
  const asset = getAsset(connection, assetName);
  if (!asset) {
    return { asset: null, acceptances: [] };
  }
  const current = sourceHash(asset.source_path);
  const acceptances = listAcceptances(connection, { assetId: asset.id }).map((acceptance) => {
    const acceptanceRounds = db.all<HistoryRound>(
      connection,
      "SELECT * FROM round WHERE acceptance_id=? ORDER BY started_at",
      [acceptance.id],
    ).map((round) => ({
      ...round,
      stale: round.asset_hash && current ? round.asset_hash !== current : null,
    }));
    return { ...acceptance, rounds: acceptanceRounds };
  });
  return { asset, current_asset_hash: current, acceptances };
}
