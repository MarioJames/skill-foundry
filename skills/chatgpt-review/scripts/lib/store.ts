import { chmodSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { conversationId, type Message } from './page.ts';
import { validatePreferences, type OrganizationPreferences } from './organize.ts';

const now = () => new Date().toISOString();
export type WatchState = 'starting' | 'waiting' | 'complete' | 'blocked' | 'superseded' | 'timeout' | 'cancelled';
export interface WatchStatus {
  id: string; runId: string; userMessageId: string; state: WatchState;
  pid: number; checkedAt: string; intervalSeconds: number; checks: number;
  reason?: string; browserSession?: string; resultPath?: string; notification?: object;
}
export interface WatchResult extends WatchStatus { conversationUrl: string; reply?: Message }
const terminalStates = new Set<WatchState>(['complete', 'blocked', 'superseded', 'timeout', 'cancelled']);
function validateRunId(runId: string) {
  if (typeof runId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(runId)) throw new Error('Missing or invalid runId; inspect legacy state separately');
}
export interface RecordEntry {
  id: string; title: string; url: string; projectUrl: string; projectVerified: boolean;
  background: string; summary: string; status: 'open' | 'blocked' | 'complete';
  repo?: string; revision?: string; model?: string; conversationCreatedAt?: string;
  recordedAt?: string; updatedAt?: string;
  titleVerified?: boolean; organizationError?: string; organizationVerifiedAt?: string;
}
export function validateRecord(value: RecordEntry): RecordEntry {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(value.id)) throw new Error('Invalid requirement id');
  for (const k of ['title', 'background', 'summary'] as const) if (typeof value[k] !== 'string' || !value[k].trim()) throw new Error(`Missing ${k}`);
  conversationId(value.url);
  const p = new URL(value.projectUrl);
  if (p.origin !== 'https://chatgpt.com' || !/^\/g\/[^/]+\/project$/.test(p.pathname)) throw new Error('Invalid project URL');
  if (typeof value.projectVerified !== 'boolean') throw new Error('projectVerified must be explicit');
  if (!['open', 'blocked', 'complete'].includes(value.status)) throw new Error('Invalid status');
  if (value.conversationCreatedAt && !Number.isFinite(Date.parse(value.conversationCreatedAt))) throw new Error('Invalid creation timestamp');
  return value;
}
export function privateWrite(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}
export class Store {
  constructor(public root = resolve(process.env.CHATGPT_REVIEW_HOME || join(homedir(), '.local/share/chatgpt-review'))) {}
  preferences(): OrganizationPreferences {
    return validatePreferences(JSON.parse(readFileSync(join(this.root, 'preferences.json'), 'utf8')));
  }
  configure(value: OrganizationPreferences) {
    validatePreferences(value);
    privateWrite(join(this.root, 'preferences.json'), value);
    return value;
  }
  path(kind: string, id: string) {
    if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(id)) throw new Error('Invalid requirement id');
    return join(this.root, kind, id + '.json');
  }
  get(id: string): RecordEntry { return validateRecord(JSON.parse(readFileSync(this.path('records', id), 'utf8'))); }
  record(value: RecordEntry) {
    validateRecord(value);
    const p = this.path('records', value.id);
    const old = existsSync(p) ? this.get(value.id) : undefined;
    if (old && conversationId(old.url) !== conversationId(value.url)) throw new Error('Requirement already maps to another conversation; reuse it');
    const saved = { ...value, recordedAt: old?.recordedAt || now(), updatedAt: now() };
    privateWrite(p, saved);
    return saved;
  }
  list(query: string) {
    const dir = join(this.root, 'records');
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter(f => f.endsWith('.json')).map(f => this.get(f.slice(0, -5)))
      .filter(r => JSON.stringify(r).toLowerCase().includes(query.toLowerCase()));
  }
  resultPath(id: string, runId: string) {
    this.path('records', id);
    validateRunId(runId);
    return join(this.root, 'replies', id, runId + '.json');
  }
  status(id: string, expectedRunId?: string): WatchStatus {
    const status = JSON.parse(readFileSync(this.path('watch', id), 'utf8')) as WatchStatus;
    validateRunId(status.runId);
    if (status.id !== id || !status.userMessageId) throw new Error('Invalid watch identity');
    if (expectedRunId !== undefined && status.runId !== expectedRunId) throw new Error('The requested run is no longer current');
    const lockPath = this.path('locks', id);
    if (existsSync(lockPath)) {
      const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
      if (lock.runId !== status.runId) throw new Error('Current watcher is starting; retry status');
    }
    return status;
  }
  result(id: string, expectedRunId?: string): WatchResult {
    const status = this.status(id, expectedRunId);
    if (!terminalStates.has(status.state)) throw new Error(`Current run is ${status.state}; no terminal result yet`);
    const result = JSON.parse(readFileSync(this.resultPath(id, status.runId), 'utf8')) as WatchResult;
    if (result.id !== id || result.runId !== status.runId || result.userMessageId !== status.userMessageId || result.state !== status.state) throw new Error('Result does not match the current terminal run');
    // Recheck after reading so a new watcher cannot silently change the selected run.
    this.status(id, status.runId);
    return result;
  }
  cancel(id: string, expectedRunId?: string) {
    const status = this.status(id, expectedRunId);
    if (terminalStates.has(status.state)) throw new Error('Current run has already ended');
    if (!existsSync(this.path('locks', id))) throw new Error('No watcher lock for this requirement');
    privateWrite(this.path('cancel', id), { runId: status.runId, requestedAt: now() });
  }
  lock(id: string, runId: string): () => void {
    validateRunId(runId);
    const path = this.path('locks', id);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const fd = openSync(path, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify({ pid: process.pid, runId, createdAt: now() }));
    closeSync(fd);
    return () => unlinkSync(path);
  }
}
