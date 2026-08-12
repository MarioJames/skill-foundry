import * as catalog from "./catalog.ts";
import * as db from "./db.ts";
import { BudgetExceeded } from "./errors.ts";
import { jsonDumps } from "./json-utils.ts";
import { redactSecrets } from "./redact.ts";

export { BudgetExceeded } from "./errors.ts";

export type RoundMode = "stop-loss" | "collect-first" | "hybrid";
export type Verdict = "PASS" | "CONDITIONAL" | "FAIL" | "blocked" | "running";

export interface RoundRow extends db.SqlRow {
  id: string;
  acceptance_id: string;
  round_tag: string;
  mode: RoundMode | null;
  verdict: Verdict;
  report: string | null;
  transcript: string | null;
  next_round_reco: string | null;
  sandbox_path: string | null;
  asset_hash: string | null;
  task_keys: string | null;
  started_at: string;
  ended_at: string | null;
}

export interface RoundTarget extends db.SqlRow {
  id: string;
  acceptance_id: string;
  round_tag: string;
  sandbox_path: string | null;
}

export interface LaunchTarget extends db.SqlRow {
  id: string;
  round_tag: string;
  sandbox_path: string;
  asset_name: string;
  asset_type: catalog.AssetType;
  asset_source: string;
}

export interface CleanupTarget extends LaunchTarget {
  acceptance_id: string;
}

function append(
  connection: db.Connection,
  table: "round" | "acceptance",
  column: "report" | "issues",
  rowId: string,
  text: string,
): void {
  const sanitized = redactSecrets(text);
  const current = db.get<Record<string, string | null>>(
    connection,
    `SELECT ${column} FROM ${table} WHERE id=?`,
    [rowId],
  );
  const existing = current?.[column] || "";
  const joined = `${existing}${existing ? "\n" : ""}${sanitized}`;
  db.run(connection, `UPDATE ${table} SET ${column}=? WHERE id=?`, [joined, rowId]);
}

export function startRound(
  connection: db.Connection,
  acceptanceId: string,
  options: { mode: RoundMode; n: number; sandboxPath?: string | null },
): string {
  const budgetRow = db.get<{ budget_max_rounds: number | null }>(
    connection,
    "SELECT budget_max_rounds FROM acceptance WHERE id=?",
    [acceptanceId],
  );
  const budget = budgetRow?.budget_max_rounds ?? null;
  if (budget !== null) {
    const usedRow = db.get<{ count: number }>(
      connection,
      "SELECT COUNT(*) AS count FROM round WHERE acceptance_id=? AND verdict != 'blocked'",
      [acceptanceId],
    );
    const used = usedRow?.count ?? 0;
    if (used >= budget) {
      throw new BudgetExceeded(
        `budget-exhausted: ${used}/${budget} non-blocked rounds used `
          + `for acceptance ${acceptanceId}`,
        acceptanceId,
        budget,
        used,
      );
    }
  }
  const source = db.get<{ source_path: string }>(
    connection,
    "SELECT asset.source_path AS source_path FROM acceptance "
      + "JOIN asset ON asset.id=acceptance.asset_id WHERE acceptance.id=?",
    [acceptanceId],
  );
  const assetHash = source ? catalog.sourceHash(source.source_path) : null;
  const id = db.newId("round");
  const insertRound = connection.transaction(() => {
    db.run(
      connection,
      "INSERT INTO round (id, acceptance_id, round_tag, mode, verdict, "
        + "sandbox_path, asset_hash, started_at) VALUES (?,?,?,?, 'running', ?, ?, ?)",
      [
        id,
        acceptanceId,
        db.roundTag(options.n),
        options.mode,
        options.sandboxPath ?? null,
        assetHash,
        db.now(),
      ],
    );
    db.run(
      connection,
      "UPDATE acceptance SET status='active', updated_at=? WHERE id=?",
      [db.now(), acceptanceId],
    );
  });
  insertRound();
  return id;
}

export function getRoundTarget(connection: db.Connection, roundId: string): RoundTarget | null {
  return db.get<RoundTarget>(
    connection,
    "SELECT id, acceptance_id, round_tag, sandbox_path FROM round WHERE id=?",
    [roundId],
  );
}

export function getLaunchTarget(connection: db.Connection, roundId: string): LaunchTarget | null {
  return db.get<LaunchTarget>(
    connection,
    "SELECT r.id, r.round_tag, r.sandbox_path, asset.name AS asset_name, "
      + "asset.type AS asset_type, asset.source_path AS asset_source FROM round r "
      + "JOIN acceptance a ON a.id=r.acceptance_id "
      + "JOIN asset ON asset.id=a.asset_id WHERE r.id=?",
    [roundId],
  );
}

export function getCleanupTarget(
  connection: db.Connection,
  roundId: string,
): CleanupTarget | null {
  return db.get<CleanupTarget>(
    connection,
    "SELECT r.id, r.acceptance_id, r.round_tag, r.sandbox_path, "
      + "asset.name AS asset_name, asset.type AS asset_type, "
      + "asset.source_path AS asset_source FROM round r "
      + "JOIN acceptance a ON a.id=r.acceptance_id "
      + "JOIN asset ON asset.id=a.asset_id WHERE r.id=?",
    [roundId],
  );
}

export function setSandboxPath(
  connection: db.Connection,
  roundId: string,
  sandboxPath: string,
): void {
  db.run(connection, "UPDATE round SET sandbox_path=? WHERE id=?", [sandboxPath, roundId]);
}

export function listRounds(
  connection: db.Connection,
  filters: { acceptanceId?: string; verdict?: Verdict } = {},
): RoundRow[] {
  let sql = "SELECT * FROM round";
  const where: string[] = [];
  const parameters: db.SqlValue[] = [];
  if (filters.acceptanceId) {
    where.push("acceptance_id=?");
    parameters.push(filters.acceptanceId);
  }
  if (filters.verdict) {
    where.push("verdict=?");
    parameters.push(filters.verdict);
  }
  if (where.length) {
    sql += ` WHERE ${where.join(" AND ")}`;
  }
  return db.all<RoundRow>(connection, `${sql} ORDER BY started_at`, parameters);
}

export function addTaskKey(
  connection: db.Connection,
  roundId: string,
  taskKey: string,
): void {
  const row = db.get<{ task_keys: string | null }>(
    connection,
    "SELECT task_keys FROM round WHERE id=?",
    [roundId],
  );
  const keys = row?.task_keys ? JSON.parse(row.task_keys) as string[] : [];
  if (keys.includes(taskKey)) {
    return;
  }
  keys.push(taskKey);
  db.run(
    connection,
    "UPDATE round SET task_keys=? WHERE id=?",
    [jsonDumps(keys), roundId],
  );
}

export function record(
  connection: db.Connection,
  roundId: string,
  options: { transcript?: string | null; reportAppend?: string | null },
): void {
  if (options.transcript !== null && options.transcript !== undefined) {
    db.run(
      connection,
      "UPDATE round SET transcript=? WHERE id=?",
      [redactSecrets(options.transcript), roundId],
    );
  }
  if (options.reportAppend) {
    append(connection, "round", "report", roundId, options.reportAppend);
  }
}

export function redactPersistedEvidence(connection: db.Connection): number {
  let changed = 0;
  const targets: Array<{
    table: "round" | "acceptance" | "finding";
    columns: string[];
  }> = [
    { table: "round", columns: ["transcript", "report", "next_round_reco"] },
    { table: "acceptance", columns: ["issues"] },
    { table: "finding", columns: ["summary"] },
  ];
  const sanitize = connection.transaction(() => {
    for (const { table, columns } of targets) {
      const rows = db.all<Record<string, string | null>>(
        connection,
        `SELECT id, ${columns.join(", ")} FROM ${table}`,
      );
      for (const row of rows) {
        const updates: Record<string, string> = {};
        for (const column of columns) {
          const value = row[column];
          if (value === null || value === undefined) continue;
          const sanitized = redactSecrets(value);
          if (sanitized !== value) updates[column] = sanitized;
        }
        if (!Object.keys(updates).length) continue;
        const assignments = Object.keys(updates).map((column) => `${column}=?`).join(", ");
        db.run(
          connection,
          `UPDATE ${table} SET ${assignments} WHERE id=?`,
          [...Object.values(updates), String(row.id)],
        );
        changed += 1;
      }
    }
  });
  sanitize();
  return changed;
}

export interface FindingRow extends db.SqlRow {
  id: string;
  round_id: string;
  key: string | null;
  severity: string;
  status: string;
  summary: string;
  created_at: string;
}

export function addFinding(
  connection: db.Connection,
  roundId: string,
  options: { severity: string; status: string; summary: string; key?: string | null },
): string {
  const id = db.newId("find");
  db.run(
    connection,
    "INSERT INTO finding (id, round_id, key, severity, status, summary, created_at) "
      + "VALUES (?,?,?,?,?,?,?)",
    [
      id,
      roundId,
      options.key ?? null,
      options.severity,
      options.status,
      options.summary,
      db.now(),
    ],
  );
  let line = `- [${options.severity}/${options.status}] ${options.summary}`;
  if (options.key) {
    line = `- [${options.severity}/${options.status}] (${options.key}) ${options.summary}`;
  }
  append(connection, "round", "report", roundId, line);
  const round = db.get<{ acceptance_id: string }>(
    connection,
    "SELECT acceptance_id FROM round WHERE id=?",
    [roundId],
  );
  if (!round) {
    throw new Error(`round not found after finding insert: ${roundId}`);
  }
  append(connection, "acceptance", "issues", round.acceptance_id, line);
  return id;
}

export function listFindings(connection: db.Connection, roundId: string): FindingRow[] {
  return db.all<FindingRow>(
    connection,
    "SELECT * FROM finding WHERE round_id=? ORDER BY created_at",
    [roundId],
  );
}

export function finalize(
  connection: db.Connection,
  roundId: string,
  options: { verdict: Exclude<Verdict, "running">; nextRoundReco?: string | null; reportAppend?: string | null },
): void {
  if (options.reportAppend) {
    append(connection, "round", "report", roundId, options.reportAppend);
  }
  db.run(
    connection,
    "UPDATE round SET verdict=?, next_round_reco=?, ended_at=? WHERE id=?",
    [options.verdict, options.nextRoundReco ?? null, db.now(), roundId],
  );
}

export function openIssues(connection: db.Connection, acceptanceId: string): string {
  const row = db.get<{ issues: string | null }>(
    connection,
    "SELECT issues FROM acceptance WHERE id=?",
    [acceptanceId],
  );
  return row?.issues || "";
}
