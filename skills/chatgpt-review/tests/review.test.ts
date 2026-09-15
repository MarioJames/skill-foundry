import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { classify, conversationId, type PageState } from '../scripts/lib/page.ts';
import { Store, privateWrite, type RecordEntry, type WatchStatus } from '../scripts/lib/store.ts';

const url = 'https://chatgpt.com/c/conversation-a';
const base: RecordEntry = { id: 'example-review', title: 'Example review', url,
  projectUrl: 'https://chatgpt.com/g/example-project/project', projectVerified: true,
  background: 'An authorized example requirement', summary: 'Awaiting independent review', status: 'open' };
const page = (patch: Partial<PageState> = {}): PageState => ({ url, title: 'ChatGPT', generating: false, blocked: null, hasComposer: true,
  messages: [{ id: 'u1', role: 'user', text: '', final: false }, { id: 'a1', role: 'assistant', text: 'Finished review', final: true }], ...patch });
const dirs: string[] = [];
function store() { const dir = mkdtempSync(join(tmpdir(), 'chatgpt-review-test-')); dirs.push(dir); return new Store(dir); }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('response identity and completion', () => {
  test('accepts the completed response to the exact submitted message', () => {
    expect(classify(page(), url, 'u1')).toMatchObject({ state: 'complete', reply: { id: 'a1', text: 'Finished review' } });
  });
  test('old answers cannot complete a newly submitted turn', () => {
    const p = page(); p.messages.push({ id: 'u2', role: 'user', text: '', final: false });
    expect(classify(p, url, 'u2').state).toBe('waiting');
    expect(classify(p, url, 'u1').state).toBe('superseded');
  });
  test('requires both end of generation and final reply actions', () => {
    expect(classify(page({ generating: true }), url, 'u1').state).toBe('waiting');
    const p = page(); p.messages[1].final = false;
    expect(classify(p, url, 'u1').state).toBe('waiting');
    p.messages[1].final = true; p.messages[1].text = ' ';
    expect(classify(p, url, 'u1').state).toBe('waiting');
  });
  test('blocks changed URL, missing message, and human verification', () => {
    expect(classify(page({ url: 'https://chatgpt.com/c/other' }), url, 'u1').state).toBe('blocked');
    expect(classify(page(), url, 'missing').state).toBe('blocked');
    expect(classify(page({ blocked: 'Human verification required' }), url, 'u1').state).toBe('blocked');
  });
  test('project moves preserve conversation identity', () => {
    const moved = 'https://chatgpt.com/g/example/c/conversation-a';
    expect(conversationId(moved)).toBe(conversationId(url));
    expect(classify(page({ url: moved }), url, 'u1').state).toBe('complete');
    expect(() => conversationId('https://example.com/c/conversation-a')).toThrow();
    expect(() => conversationId('https://chatgpt.com/')).toThrow();
  });
});
describe('private requirement registry', () => {
  test('updates context while preserving the original requirement conversation', () => {
    const s = store(); const first = s.record(base);
    s.record({ ...base, summary: 'Reviewed', url: 'https://chatgpt.com/g/example/c/conversation-a' });
    expect(s.get(base.id).recordedAt).toBe(first.recordedAt);
    expect(s.list('Reviewed')).toHaveLength(1);
    expect(() => s.record({ ...base, url: 'https://chatgpt.com/c/another' })).toThrow('reuse');
    expect(statSync(s.path('records', base.id)).mode & 0o777).toBe(0o600);
    expect(statSync(join(s.root, 'records')).mode & 0o777).toBe(0o700);
  });
  test('rejects traversal and missing project confirmation state', () => {
    const s = store();
    expect(() => s.record({ ...base, id: '../escape' })).toThrow();
    expect(() => s.record({ ...base, projectVerified: undefined as never })).toThrow();
  });
  test('duplicate monitor cannot steal or remove the first lock', () => {
    const s = store(); const release = s.lock(base.id, randomUUID());
    expect(() => s.lock(base.id, randomUUID())).toThrow();
    release();
    const again = s.lock(base.id, randomUUID()); again();
  });
  test('result validates current terminal identity and refuses legacy state', () => {
    const s = store();
    const current: WatchStatus = { id: base.id, runId: randomUUID(), userMessageId: 'u1', state: 'complete', pid: process.pid, checkedAt: new Date().toISOString(), intervalSeconds: 60, checks: 1 };
    const result = { ...current, conversationUrl: url, reply: { id: 'a1', role: 'assistant', text: 'Example answer', final: true } };
    privateWrite(s.path('watch', base.id), current);
    privateWrite(s.resultPath(base.id, current.runId), result);
    expect(s.result(base.id, current.runId)).toEqual(result);
    for (const state of ['starting', 'waiting']) {
      privateWrite(s.path('watch', base.id), { ...current, state });
      expect(() => s.result(base.id)).toThrow('no terminal result');
    }
    privateWrite(s.path('watch', base.id), current);
    for (const patch of [{ runId: randomUUID() }, { userMessageId: 'u2' }, { id: 'other-review' }, { state: 'timeout' }]) {
      privateWrite(s.resultPath(base.id, current.runId), { ...result, ...patch });
      expect(() => s.result(base.id)).toThrow('does not match');
    }
    privateWrite(s.resultPath(base.id, current.runId), result);
    const release = s.lock(base.id, randomUUID());
    expect(() => s.result(base.id)).toThrow('starting');
    release();
    const { runId, ...legacy } = current;
    privateWrite(s.path('watch', base.id), legacy);
    expect(() => s.result(base.id)).toThrow('runId');
  });
});
