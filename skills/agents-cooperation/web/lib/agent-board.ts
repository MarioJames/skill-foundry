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
  closed_at: number | null;
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
  bucket: "in_progress" | "completed" | "closed";
  created_at: number;
  updated_at: number;
  owners: BoardOwner[];
}
export interface BoardSnapshot {
  ok: true;
  status: "ready" | "missing";
  refreshed_at: number;
  tasks: BoardTask[];
}
export interface BoardEvent {
  id: string;
  at: number;
  kind: string;
  source: "recorded" | "milestone";
  owner_id: string;
  owner_key: string;
  lane_id: string | null;
  worker_id: string | null;
  worker_name: string | null;
  engine: string;
  model: string | null;
  title: string;
  detail: string | null;
}
export interface BoardTaskDetail {
  ok: true;
  refreshed_at: number;
  task: BoardTask;
  history_incomplete: boolean;
  events: BoardEvent[];
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
  created_at: number;
  updated_at: number;
  closed_at: number | null;
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
  closed_at: number | null;
}

function byRecent<T extends { updated_at: number; id: string }>(a: T, b: T): number {
  return b.updated_at - a.updated_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
function aggregateStatus(statuses: string[]): BoardTask["status"] {
  if (statuses.includes("active")) return "active";
  if (statuses.includes("closing")) return "closing";
  return "closed";
}
/** active/closing stay in progress. Closed is completed only when every worker is closed and accepted and nothing still has an error. */
function taskBucket(status: BoardTask["status"], runs: RunRow[], workers: BoardWorker[]): BoardTask["bucket"] {
  if (status !== "closed") return "in_progress";
  const currentError = runs.some(run => run.last_error != null) || workers.some(worker => worker.last_error != null);
  if (workers.length > 0 && !currentError && workers.every(worker => worker.status === "closed" && worker.outcome === "accepted")) return "completed";
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
    const taskWorkers: BoardWorker[] = [];
    let taskCreated = taskRuns[0].created_at;
    let taskUpdated = 0;
    const taskStatuses: string[] = [];
    for (const run of taskRuns) if (run.created_at < taskCreated) taskCreated = run.created_at;
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
            closed_at: lane.closed_at,
          });
        }
      }
      taskWorkers.push(...workers);
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
    const status = aggregateStatus(taskStatuses);
    tasks.push({
      id: collabId,
      label: latestLabel(taskRuns),
      status,
      bucket: taskBucket(status, taskRuns, taskWorkers),
      created_at: taskCreated,
      updated_at: taskUpdated,
      owners,
    });
  }
  tasks.sort(byRecent);
  return tasks;
}

const RUN_COLUMNS = "run_id, collab_id, owner_id, engine, host_session_id, label, status, last_error, created_at, updated_at, closed_at";
const LANE_COLUMNS = "lane_id, run_id, worker_id, agent_name, engine, model, status, outcome, health, keep_reason, last_error, created_at, updated_at, last_progress_at, closed_at";
const PAYLOAD_FIELDS = ["status", "outcome", "keep_reason", "error", "health", "worker_id", "name", "engine", "model"] as const;

interface EventPayload {
  status?: string | null;
  outcome?: string | null;
  keep_reason?: string | null;
  error?: string | null;
  health?: string | null;
  worker_id?: string | null;
  name?: string | null;
  engine?: string | null;
  model?: string | null;
}
interface JournalEvent {
  event_id: number;
  run_id: string;
  lane_id: string | null;
  at: number;
  kind: string;
  payload: EventPayload;
}
interface Journal {
  events: JournalEvent[];
  runCreated: Set<string>;
  laneCreated: Set<string>;
  runClosed: Set<string>;
  laneClosed: Set<string>;
}
interface TimedEvent extends BoardEvent { eventId: number }

function supportedVersion(version: number): boolean {
  return version === 1 || version === 2 || version === STATE_VERSION;
}
/** Missing file is handled by the caller. A readable v1, v2, or current file is never migrated or created here. */
function withReadonly<T>(state: string | undefined, env: Record<string, string | undefined>, missing: () => T, read: (db: Database, version: number) => T): T {
  const path = statePath(state, env);
  try {
    if (!statSync(path).isFile()) throw new HttpError(503, "状态路径不是普通 SQLite 文件，看板数据不可用。");
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return missing();
    throw new HttpError(503, "无法读取状态文件，看板数据不可用。");
  }
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true, create: false });
    db.exec("BEGIN");
    const version = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (!supportedVersion(version)) throw new HttpError(503, `状态库版本 ${version} 不受支持，未运行迁移，看板数据不可用。`);
    const app = db.query("SELECT value FROM meta WHERE key='app'").get() as { value: string } | null;
    if (app?.value !== "agents-cooperation") throw new HttpError(503, "状态库应用标记异常，看板数据不可用。");
    return read(db, version);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, "无法读取协作任务记录，请检查状态文件后重试。");
  } finally {
    db?.close();
  }
}
function loadRuns(db: Database, taskId?: string): RunRow[] {
  if (taskId === undefined) return db.query(`SELECT ${RUN_COLUMNS} FROM runs`).all() as RunRow[];
  return db.query(`SELECT ${RUN_COLUMNS} FROM runs WHERE collab_id=?`).all(taskId) as RunRow[];
}
function loadLanes(db: Database, runIds: string[]): LaneRow[] {
  if (!runIds.length) return [];
  return db.query(`SELECT ${LANE_COLUMNS} FROM lanes WHERE run_id IN (${runIds.map(() => "?").join(",")})`).all(...runIds) as LaneRow[];
}
function readPayload(raw: string): EventPayload {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const source = parsed as Record<string, unknown>;
  const payload: EventPayload = {};
  for (const key of PAYLOAD_FIELDS) {
    const value = source[key];
    if (typeof value === "string" || value === null) payload[key] = value;
  }
  return payload;
}
function loadJournal(db: Database, runIds: string[]): Journal {
  const rows = db.query(`SELECT event_id, run_id, lane_id, at, kind, payload FROM runtime_events WHERE run_id IN (${runIds.map(() => "?").join(",")}) ORDER BY at, event_id`).all(...runIds) as Array<Omit<JournalEvent, "payload"> & { payload: string }>;
  const journal: Journal = { events: [], runCreated: new Set(), laneCreated: new Set(), runClosed: new Set(), laneClosed: new Set() };
  for (const row of rows) {
    const payload = readPayload(row.payload);
    const event = { event_id: row.event_id, run_id: row.run_id, lane_id: row.lane_id, at: row.at, kind: row.kind, payload };
    journal.events.push(event);
    if (event.kind === "run.created") journal.runCreated.add(event.run_id);
    if (event.kind === "lane.created" && event.lane_id) journal.laneCreated.add(event.lane_id);
    if (payload.status === "closed") {
      if (event.lane_id) journal.laneClosed.add(event.lane_id);
      else journal.runClosed.add(event.run_id);
    }
  }
  return journal;
}
function stored(value: string | null | undefined, fallback: string | null): string | null {
  return value === undefined ? fallback : value;
}
function statusTitle(status: string | null | undefined): string {
  if (status === "active") return "状态变为进行中";
  if (status === "closing") return "状态变为收尾中";
  if (status === "closed") return "状态变为已关闭";
  if (!status) return "状态变更";
  return `状态变为${status}`;
}
function laneStatusTitle(status: string | null | undefined): string {
  if (status === "opening") return "正在派发子 Agent";
  if (status === "open") return "已派发子 Agent";
  if (status === "unknown") return "子 Agent 状态未知";
  return statusTitle(status);
}
function describe(kind: string, payload: EventPayload): { title: string; detail: string | null } {
  if (kind === "run.created") return { title: "开始调度", detail: null };
  if (kind === "lane.created") return { title: "请求派发子 Agent", detail: null };
  if (kind === "run.status") return { title: statusTitle(payload.status), detail: null };
  if (kind === "lane.status") return { title: laneStatusTitle(payload.status), detail: null };
  if (kind === "lane.outcome") {
    if (payload.outcome === "accepted") return { title: "验收通过", detail: null };
    if (payload.outcome === "failed") return { title: "验收未通过", detail: null };
    return { title: "清除验收结果", detail: null };
  }
  if (kind === "lane.progress") return { title: "记录进展", detail: null };
  if (kind === "lane.keep_reason") return { title: payload.keep_reason ? "保留说明" : "清除保留说明", detail: payload.keep_reason ?? null };
  if (kind === "run.error" || kind === "lane.error") return { title: payload.error ? "记录错误" : "清除错误", detail: payload.error ?? null };
  if (kind === "lane.health") {
    if (payload.health === "stale") return { title: "标记为停滞", detail: null };
    if (payload.health === "ok") return { title: "恢复正常", detail: null };
    return { title: "健康状态变更", detail: null };
  }
  return { title: "调度记录", detail: null };
}
function ownerOf(run: RunRow): { owner_id: string; owner_key: string } {
  return { owner_id: run.owner_id, owner_key: ownerIdentity(run).id };
}
/** Creation and close milestones exist only when the journal has no corresponding recorded event. A closed status without closed_at adds nothing. */
function taskTimeline(runs: RunRow[], lanes: LaneRow[], journal: Journal): { history_incomplete: boolean; events: BoardEvent[] } {
  const runsById = new Map(runs.map(run => [run.run_id, run]));
  const lanesById = new Map(lanes.map(lane => [lane.lane_id, lane]));
  const events: TimedEvent[] = [];
  for (const row of journal.events) {
    const run = runsById.get(row.run_id);
    if (!run) continue;
    const lane = row.lane_id ? lanesById.get(row.lane_id) : undefined;
    const owner = ownerOf(run);
    const text = describe(row.kind, row.payload);
    events.push({
      id: String(row.event_id),
      eventId: row.event_id,
      at: row.at,
      kind: row.kind,
      source: "recorded",
      owner_id: owner.owner_id,
      owner_key: owner.owner_key,
      lane_id: row.lane_id,
      worker_id: stored(row.payload.worker_id, lane?.worker_id ?? null),
      worker_name: stored(row.payload.name, lane?.agent_name ?? null),
      engine: stored(row.payload.engine, lane?.engine ?? run.engine) ?? run.engine,
      model: stored(row.payload.model, lane?.model ?? null),
      title: text.title,
      detail: text.detail,
    });
  }
  let historyIncomplete = false;
  for (const run of runs) {
    const owner = ownerOf(run);
    if (!journal.runCreated.has(run.run_id)) {
      historyIncomplete = true;
      events.push({ id: `milestone:run:${run.run_id}:created`, eventId: 0, at: run.created_at, kind: "run.created", source: "milestone", owner_id: owner.owner_id, owner_key: owner.owner_key, lane_id: null, worker_id: null, worker_name: null, engine: run.engine, model: null, title: "开始调度", detail: null });
    }
    if (run.closed_at != null && !journal.runClosed.has(run.run_id)) {
      events.push({ id: `milestone:run:${run.run_id}:closed`, eventId: Number.MAX_SAFE_INTEGER, at: run.closed_at, kind: "run.closed", source: "milestone", owner_id: owner.owner_id, owner_key: owner.owner_key, lane_id: null, worker_id: null, worker_name: null, engine: run.engine, model: null, title: "已关闭", detail: null });
    }
  }
  for (const lane of lanes) {
    const run = runsById.get(lane.run_id);
    if (!run) continue;
    const owner = ownerOf(run);
    if (!journal.laneCreated.has(lane.lane_id)) {
      historyIncomplete = true;
      events.push({ id: `milestone:lane:${lane.lane_id}:created`, eventId: 0, at: lane.created_at, kind: "lane.created", source: "milestone", owner_id: owner.owner_id, owner_key: owner.owner_key, lane_id: lane.lane_id, worker_id: lane.worker_id, worker_name: lane.agent_name, engine: lane.engine, model: lane.model, title: "请求派发子 Agent", detail: null });
    }
    if (lane.closed_at != null && !journal.laneClosed.has(lane.lane_id)) {
      events.push({ id: `milestone:lane:${lane.lane_id}:closed`, eventId: Number.MAX_SAFE_INTEGER, at: lane.closed_at, kind: "lane.closed", source: "milestone", owner_id: owner.owner_id, owner_key: owner.owner_key, lane_id: lane.lane_id, worker_id: lane.worker_id, worker_name: lane.agent_name, engine: lane.engine, model: lane.model, title: "已关闭", detail: null });
    }
  }
  events.sort((a, b) => a.at - b.at || a.eventId - b.eventId || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    history_incomplete: historyIncomplete,
    events: events.map(({ eventId: _eventId, ...event }) => event),
  };
}
function absentTask(): never {
  throw new HttpError(404, "任务已不存在。");
}

/** Read the startup state path only. Never creates, migrates, or writes the database. */
export function readAgentBoard(state?: string, env: Record<string, string | undefined> = process.env, now = Date.now()): BoardSnapshot {
  return withReadonly<BoardSnapshot>(state, env, () => ({ ok: true, status: "missing", refreshed_at: now, tasks: [] }), (db, version) => {
    if (version === 1) return { ok: true, status: "ready", refreshed_at: now, tasks: [] };
    const runs = loadRuns(db);
    return { ok: true, status: "ready", refreshed_at: now, tasks: group(runs, loadLanes(db, runs.map(run => run.run_id))) };
  });
}
/** Detail for one collaboration. v2 is read in place. Old rows become milestones only when their creation event is absent. */
export function readAgentTask(taskId: string, state?: string, env: Record<string, string | undefined> = process.env, now = Date.now()): BoardTaskDetail {
  return withReadonly<BoardTaskDetail>(state, env, absentTask, (db, version) => {
    if (version === 1) absentTask();
    const runs = loadRuns(db, taskId);
    if (!runs.length) absentTask();
    const lanes = loadLanes(db, runs.map(run => run.run_id));
    const task = group(runs, lanes).find(item => item.id === taskId);
    if (!task) absentTask();
    const journal = version >= 3 ? loadJournal(db, runs.map(run => run.run_id)) : { events: [], runCreated: new Set<string>(), laneCreated: new Set<string>(), runClosed: new Set<string>(), laneClosed: new Set<string>() };
    const timeline = taskTimeline(runs, lanes, journal);
    return { ok: true, refreshed_at: now, task, history_incomplete: timeline.history_incomplete, events: timeline.events };
  });
}
