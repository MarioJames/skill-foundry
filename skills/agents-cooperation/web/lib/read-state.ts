import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { statePath, defaultStatePath, STATE_VERSION, listBlocks, validateLegacy, type Block } from "../../scripts/lib/state-db.ts";

export interface ReadState { path: string; status: "missing" | "ready" | "uncertain"; warnings: string[]; blocks: Block[] }

const LEGACY_NAME = "availability.json";
const IMPORT_PREFIX = `${LEGACY_NAME}.importing-`;
interface ImportRecord { snapshot: string; sha256: string; source: string }

function legacyNames(directory: string): string[] | "absent" | "unreadable" {
  try { return readdirSync(directory); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable"; }
}
const hasLegacy = (names: string[]) => names.some(name => name === LEGACY_NAME || name.startsWith(IMPORT_PREFIX));

function importRecords(db: Database): ImportRecord[] | undefined {
  const raw = db.query("SELECT value FROM meta WHERE key='availability_imports'").get() as { value: string } | null;
  if (!raw) return [];
  let records: unknown;
  try { records = JSON.parse(raw.value); }
  catch { return undefined; }
  if (!Array.isArray(records) || records.some(record => {
    if (!record || typeof record !== "object") return true;
    const item = record as Record<string, unknown>;
    return typeof item.snapshot !== "string" || typeof item.sha256 !== "string" || typeof item.source !== "string";
  })) return undefined;
  return records as ImportRecord[];
}

/** Read-only view of the CLI's automatic import: a recorded source is not imported again. */
function classifyLegacy(directory: string, source: string, names: string[], records: ImportRecord[]): { uncertain?: string; warnings: string[] } {
  const recorded = new Set(records.map(record => resolve(record.snapshot)));
  if (names.some(name => name.startsWith(IMPORT_PREFIX) && !recorded.has(resolve(join(directory, name))))) return { uncertain: "发现未记录的导入恢复文件，无法只读确认完整状态。", warnings: [] };
  for (const record of records) {
    if (!existsSync(record.snapshot)) continue;
    try {
      if (createHash("sha256").update(readFileSync(record.snapshot)).digest("hex") !== record.sha256) return { uncertain: "已记录的导入快照内容已变化，无法只读确认完整状态。", warnings: [] };
    } catch { return { uncertain: "无法读取已记录的导入快照，额度状态不可确定。", warnings: [] }; }
  }
  if (!names.includes(LEGACY_NAME)) return { warnings: [] };
  if (!records.some(record => resolve(record.source) === source)) return { uncertain: "发现尚未导入的旧 availability 文件，无法只读确认完整状态。", warnings: [] };
  return { warnings: ["旧 availability 文件在成功导入后仍保留，额度状态以 SQLite 为准，不会自动再次导入。"] };
}

/** Never opens the CLI write/migration path, including its legacy recovery path. */
export function readState(flag?: string, env: Record<string, string | undefined> = process.env): ReadState {
  const path = statePath(flag, env);
  const uncertain = (message: string): ReadState => ({ path, status: "uncertain", warnings: [message], blocks: [] });
  const isDefault = path === defaultStatePath(env);
  try { if (!statSync(path).isFile()) return uncertain("状态路径不是普通 SQLite 文件，额度状态不可确定。"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return uncertain("无法读取状态文件，额度状态不可确定。");
    if (isDefault) {
      const names = legacyNames(dirname(path));
      if (names === "unreadable") return uncertain("无法检查旧状态和导入恢复证据，额度状态不可确定。");
      if (names !== "absent" && hasLegacy(names)) return uncertain("发现尚未导入的旧 availability 或导入恢复文件，无法只读确认完整状态。");
    }
    return { path, status: "missing", blocks: [], warnings: [] };
  }
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true, create: false });
    db.exec("BEGIN");
    const version = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (version < 1 || version > STATE_VERSION) return uncertain("状态库版本不受支持；未运行任何迁移，额度状态不可确定。");
    const app = db.query("SELECT value FROM meta WHERE key='app'").get() as { value: string } | null;
    if (app?.value !== "agents-cooperation") return uncertain("状态库应用标记异常，额度状态不可确定。");
    const blocks = listBlocks(db);
    validateLegacy({ version: 1, blocks });
    if (!isDefault) return { path, status: "ready", blocks, warnings: [] };
    const names = legacyNames(dirname(path));
    if (names === "unreadable") return uncertain("无法检查旧状态和导入恢复证据，额度状态不可确定。");
    const records = importRecords(db);
    if (!records) return uncertain("导入记录无法只读解释，额度状态不可确定。");
    const finding = classifyLegacy(dirname(path), resolve(join(dirname(path), LEGACY_NAME)), names === "absent" ? [] : names, records);
    if (finding.uncertain) return uncertain(finding.uncertain);
    return { path, status: "ready", blocks, warnings: finding.warnings };
  } catch { return uncertain("状态库无法只读解释，额度状态不可确定；未创建、迁移或清理状态。"); }
  finally { db?.close(); }
}
