import { CliError, parseReleaseAt } from "../../scripts/agents-config.ts";
import type { Issue } from "../../scripts/lib/json-schema.ts";
import { listBlocks, openConfiguredState, removeBlock, transaction, upsertBlock } from "../../scripts/lib/state-db.ts";

export interface AvailabilityUpdate { engine: string; release_at: string | null }

const ABSOLUTE_RELEASE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Disk config is not trusted; a missing or non-object engines table stays a validation issue. */
export function enginesOf(config: unknown): unknown {
  if (!isRecord(config) || !Object.hasOwn(config, "engines")) return undefined;
  return config.engines;
}

/** Date.parse rolls impossible days forward, so the calendar is checked before that parse. */
function isActualTimestamp(value: string): boolean {
  const match = ABSOLUTE_RELEASE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const zone = match[8]!;
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  if (zone !== "Z") {
    const offsetHour = Number(zone.slice(1, 3));
    const offsetMinute = Number(zone.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return false;
  }
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  return day >= 1 && day <= days;
}

/** Relative values are valid for the CLI, but this API only accepts an absolute timestamp. */
export function planAvailability(body: Record<string, unknown>, engines: unknown, now: number): { updates: AvailabilityUpdate[]; issues: Issue[] } {
  if (!Array.isArray(body.updates)) return { updates: [], issues: [{ path: "$.updates", message: "updates 必须是数组。" }] };
  const issues: Issue[] = [];
  const updates: AvailabilityUpdate[] = [];
  const seen = new Set<string>();
  const table = isRecord(engines) ? engines : undefined;
  if (body.updates.length > 0 && !table) issues.push({ path: "$.updates", message: "当前磁盘配置没有可用的引擎表。" });
  body.updates.forEach((item, index) => {
    const at = `$.updates[${index}]`;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      issues.push({ path: at, message: "每一项必须是对象。" });
      return;
    }
    const record = item as Record<string, unknown>;
    let engine: string | undefined;
    if (typeof record.engine !== "string") issues.push({ path: `${at}.engine`, message: "引擎必须是字符串。" });
    else {
      engine = record.engine;
      if (seen.has(engine)) issues.push({ path: `${at}.engine`, message: "同一引擎不能重复提交。" });
      seen.add(engine);
      if (table && !Object.hasOwn(table, engine)) issues.push({ path: `${at}.engine`, message: "引擎必须是当前磁盘配置中的引擎。" });
    }
    let release: string | null | undefined;
    if (record.release_at === null) release = null;
    else if (typeof record.release_at !== "string") issues.push({ path: `${at}.release_at`, message: "恢复时间必须是带时区的 ISO 8601 或 null。" });
    else if (!ABSOLUTE_RELEASE.test(record.release_at)) issues.push({ path: `${at}.release_at`, message: "恢复时间必须是带时区的 ISO 8601，不接受相对时间。" });
    else if (!isActualTimestamp(record.release_at)) issues.push({ path: `${at}.release_at`, message: "恢复时间无效。" });
    else {
      try {
        const parsed = parseReleaseAt(record.release_at, now);
        if (!(Date.parse(parsed) > now)) issues.push({ path: `${at}.release_at`, message: "恢复时间必须晚于当前时间。" });
        else release = parsed;
      } catch (error) {
        if (error instanceof CliError) issues.push({ path: `${at}.release_at`, message: "恢复时间无效。" });
        else throw error;
      }
    }
    if (engine !== undefined && release !== undefined && !issues.some(issue => issue.path === at || issue.path.startsWith(`${at}.`))) updates.push({ engine, release_at: release });
  });
  return { updates, issues };
}

export function writeAvailability(flag: string | undefined, env: Record<string, string | undefined>, updates: AvailabilityUpdate[], now: number) {
  const db = openConfiguredState(flag, env);
  try {
    transaction(db, () => {
      const existing = listBlocks(db);
      for (const update of updates) {
        if (update.release_at === null) {
          removeBlock(db, update.engine);
          continue;
        }
        const current = existing.find(block => block.engine === update.engine && block.model === undefined);
        if (current) upsertBlock(db, { ...current, release_at: update.release_at });
        else upsertBlock(db, { engine: update.engine, reason: "用户设置额度恢复时间", since: new Date(now).toISOString(), release_at: update.release_at, by: "web" });
      }
    });
  } finally { db.close(); }
}
