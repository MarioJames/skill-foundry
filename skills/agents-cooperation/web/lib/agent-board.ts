/** Read-only agent board. Browser code must import these types only, so SQLite stays out of the bundle. */
import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { STATE_VERSION, statePath } from "../../scripts/lib/state-db.ts";
import { HttpError } from "./errors.ts";

export interface BoardWorker {
  id: string;
  worker_id: string;
  name: string;
  engine: string;
  model: string;
  status: string;
  outcome: string | null;
  health: string;
  keep_reason: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  last_progress_at: number;
}
export interface BoardOwner {
  id: string;
  owner_id: string;
  engine: string;
  status: "active" | "closing" | "closed";
  updated_at: number;
  last_error: string | null;
  workers: BoardWorker[];
}
export interface BoardTask {
  id: string;
  label: string;
  status: "active" | "closing" | "closed";
  updated_at: number;
  owners: BoardOwner[];
}
export interface BoardSnapshot {
  ok: true;
  status: "ready" | "missing";
  refreshed_at: number;
  tasks: BoardTask[];
}

interface RunRow {
  run_id: string;
  collab_id: string;
  owner_id: string;
  engine: string;
  host_session_id: string | null;
  label: string;
  status: string;
  last_error: string | null;
  updated_at: number;
}
interface LaneRow {
  lane_id: string;
  run_id: string;
  worker_id: string;
  agent_name: string;
  engine: string;
  model: string;
  status: string;
  outcome: string | null;
  health: string;
  keep_reason: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  last_progress_at: number;
}

function byRecent<T extends { updated_at: number; id: string }>(a: T, b: T): number {
  return b.updated_at - a.updated_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
function aggregateStatus(statuses: string[]): BoardTask["status"] {
  if (statuses.includes("active")) return "active";
  if (statuses.includes("closing")) return "closing";
  return "closed";
}
/** Newest non-empty run label. Equal timestamps keep the smaller run id. */
function latestLabel(runs: RunRow[]): string {
  let best: RunRow | undefined;
  for (const run of runs) {
    if (!run.label) continue;
    if (!best || run.updated_at > best.updated_at || (run.updated_at === best.updated_at && run.run_id < best.run_id)) best = run;
  }
  return best?.label ?? "";
}
function latestRun(runs: RunRow[]): RunRow {
  return runs.reduce((best, run) =>
    run.updated_at > best.updated_at || (run.updated_at === best.updated_at && run.run_id < best.run_id) ? run : best
  );
}
/** Same owner, engine and non-empty host merge. A missing host stays one owner per run. */
function ownerIdentity(run: RunRow): { key: string; id: string } {
  if (run.host_session_id) return {
    key: `${run.owner_id}\0${run.engine}\0${run.host_session_id}`,
    id: `${run.owner_id}:${run.engine}:${run.host_session_id}`,
  };
  return { key: `run\0${run.run_id}`, id: run.run_id };
}

function group(runs: RunRow[], lanes: LaneRow[]): BoardTask[] {
  const lanesByRun = new Map<string, LaneRow[]>();
  for (const lane of lanes) {
    const list = lanesByRun.get(lane.run_id);
    if (list) list.push(lane);
    else lanesByRun.set(lane.run_id, [lane]);
  }
  const runsByTask = new Map<string, RunRow[]>();
  for (const run of runs) {
    const list = runsByTask.get(run.collab_id);
    if (list) list.push(run);
    else runsByTask.set(run.collab_id, [run]);
  }
  const tasks: BoardTask[] = [];
  for (const [collabId, taskRuns] of runsByTask) {
    const grouped = new Map<string, { id: string; owner_id: string; engine: string; runs: RunRow[] }>();
    for (const run of taskRuns) {
      const identity = ownerIdentity(run);
      const existing = grouped.get(identity.key);
      if (existing) existing.runs.push(run);
      else grouped.set(identity.key, { id: identity.id, owner_id: run.owner_id, engine: run.engine, runs: [run] });
    }
    const owners: BoardOwner[] = [];
    let taskUpdated = 0;
    const taskStatuses: string[] = [];
    for (const owner of grouped.values()) {
      const workers: BoardWorker[] = [];
      let ownerUpdated = 0;
      const statuses: string[] = [];
      for (const run of owner.runs) {
        statuses.push(run.status);
        taskStatuses.push(run.status);
        if (run.updated_at > ownerUpdated) ownerUpdated = run.updated_at;
        for (const lane of lanesByRun.get(run.run_id) ?? []) {
          if (lane.updated_at > ownerUpdated) ownerUpdated = lane.updated_at;
          workers.push({
            id: lane.lane_id,
            worker_id: lane.worker_id,
            name: lane.agent_name,
            engine: lane.engine,
            model: lane.model,
            status: lane.status,
            outcome: lane.outcome,
            health: lane.health,
            keep_reason: lane.keep_reason,
            last_error: lane.last_error,
            created_at: lane.created_at,
            updated_at: lane.updated_at,
            last_progress_at: lane.last_progress_at,
          });
        }
      }
      if (ownerUpdated > taskUpdated) taskUpdated = ownerUpdated;
      workers.sort(byRecent);
      owners.push({
        id: owner.id,
        owner_id: owner.owner_id,
        engine: owner.engine,
        status: aggregateStatus(statuses),
        updated_at: ownerUpdated,
        last_error: latestRun(owner.runs).last_error,
        workers,
      });
    }
    owners.sort(byRecent);
    tasks.push({
      id: collabId,
      label: latestLabel(taskRuns),
      status: aggregateStatus(taskStatuses),
      updated_at: taskUpdated,
      owners,
    });
  }
  tasks.sort(byRecent);
  return tasks;
}

/** Read the startup state path only. Never creates, migrates, or writes the database. */
export function readAgentBoard(state?: string, env: Record<string, string | undefined> = process.env, now = Date.now()): BoardSnapshot {
  const path = statePath(state, env);
  try {
    if (!statSync(path).isFile()) throw new HttpError(503, "状态路径不是普通 SQLite 文件，看板数据不可用。");
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, status: "missing", refreshed_at: now, tasks: [] };
    throw new HttpError(503, "无法读取状态文件，看板数据不可用。");
  }
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true, create: false });
    db.exec("BEGIN");
    const version = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (version !== 1 && version !== STATE_VERSION) throw new HttpError(503, `状态库版本 ${version} 不受支持，未运行迁移，看板数据不可用。`);
    const app = db.query("SELECT value FROM meta WHERE key='app'").get() as { value: string } | null;
    if (app?.value !== "agents-cooperation") throw new HttpError(503, "状态库应用标记异常，看板数据不可用。");
    if (version === 1) return { ok: true, status: "ready", refreshed_at: now, tasks: [] };
    const runs = db.query("SELECT run_id, collab_id, owner_id, engine, host_session_id, label, status, last_error, updated_at FROM runs").all() as RunRow[];
    const lanes = db.query("SELECT lane_id, run_id, worker_id, agent_name, engine, model, status, outcome, health, keep_reason, last_error, created_at, updated_at, last_progress_at FROM lanes").all() as LaneRow[];
    return { ok: true, status: "ready", refreshed_at: now, tasks: group(runs, lanes) };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, "无法读取协作任务记录，请检查状态文件后重试。");
  } finally {
    db?.close();
  }
}
