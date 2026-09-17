import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { finishReview, openReview } from '../scripts/lib/lifecycle.ts';
import { privateWrite, Store, type RecordEntry } from '../scripts/lib/store.ts';
import type { PageState } from '../scripts/lib/page.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'review-lifecycle-')); dirs.push(root);
  const store = new Store(root), id = 'example-review', runId = randomUUID();
  const record: RecordEntry = { id, url: 'https://chatgpt.com/c/example', title: '0916｜FIX｜Example',
    projectUrl: 'https://chatgpt.com/g/g-p-example/project', projectVerified: true, titleVerified: true,
    organizationVerifiedAt: new Date().toISOString(), status: 'complete', summary: 'Reviewed decision', background: 'Example' };
  store.record(record);
  store.configure({ projectName: 'Reviews', projectUrl: record.projectUrl, language: 'en', timezone: 'Asia/Shanghai' });
  const status = { id, runId, userMessageId: 'u1', state: 'complete', pid: 1, checkedAt: '', intervalSeconds: 60, checks: 1 };
  const reply = { id: 'a1', role: 'assistant', text: 'Done', final: true };
  privateWrite(store.path('watch', id), status);
  privateWrite(store.resultPath(id, runId), { ...status, conversationUrl: record.url, reply });
  let available = [{ targetId: 'user-tab', url: 'https://example.com' }];
  const calls: string[][] = [];
  const tabs = async (...args: string[]) => {
    calls.push(args);
    if (args[0] === 'list') return { tabs: available };
    if (args[0] === 'new') { const t = { targetId: 'created-' + calls.length, url: args[1] }; available.push(t); return t; }
    if (args[0] === 'close') { available = available.filter(t => t.targetId !== args[1]); return {}; }
    return {};
  };
  let page: PageState = { url: record.url, title: record.title, blocked: null, generating: false, hasComposer: true,
    messages: [{ id: 'u1', role: 'user', text: '', final: false }, reply] };
  return { store, id, record, runId, tabs, calls, available: () => available,
    read: async () => page, patch: (value: Partial<PageState>) => { page = { ...page, ...value }; } };
}

test('opens the bound URL, reuses its tab, closes only its own tab and resumes after closure', async () => {
  const f = fixture();
  const first = await openReview(f.store, f.id, '9222', f.tabs);
  expect(first).toMatchObject({ owned: true, reused: false, url: f.record.url });
  expect(await openReview(f.store, f.id, '9222', f.tabs)).toMatchObject({ target: first.target, reused: true });
  expect(await finishReview(f.store, f.id, '9222', f.runId, f.tabs, f.read)).toMatchObject({ closed: true });
  expect(f.available()).toEqual([{ targetId: 'user-tab', url: 'https://example.com' }]);
  expect(f.store.get(f.id).url).toBe(f.record.url);
  expect(await finishReview(f.store, f.id, '9222', f.runId, f.tabs, f.read)).toMatchObject({ alreadyClosed: true });
  expect(await openReview(f.store, f.id, '9222', f.tabs)).toMatchObject({ reused: false, url: f.record.url });
});
test('reuses an existing user tab without claiming ownership or closing it', async () => {
  const f = fixture(); f.available().push({ targetId: 'existing', url: f.record.url });
  expect(await openReview(f.store, f.id, '9222', f.tabs)).toMatchObject({ owned: false, target: 'existing' });
  expect(await finishReview(f.store, f.id, '9222', f.runId, f.tabs, f.read)).toMatchObject({ closed: false });
  expect(f.calls.some(c => c[0] === 'close')).toBe(false);
});
test('leaves active, changed and superseded pages open', async () => {
  for (const patch of [{ generating: true }, { url: 'https://chatgpt.com/c/other' }, { messages: [{ id: 'u2', role: 'user', text: '', final: false }] }]) {
    const f = fixture(); await openReview(f.store, f.id, '9222', f.tabs); f.patch(patch);
    await expect(finishReview(f.store, f.id, '9222', f.runId, f.tabs, f.read)).rejects.toThrow('completed turn');
    expect(f.calls.some(c => c[0] === 'close')).toBe(false);
  }
});
test('refuses stale runs but releases completed replies with pending organization', async () => {
  const f = fixture(); await openReview(f.store, f.id, '9222', f.tabs);
  await expect(finishReview(f.store, f.id, '9222', randomUUID(), f.tabs, f.read)).rejects.toThrow('no longer current');
  f.store.record({ ...f.record, projectVerified: false });
  expect(await finishReview(f.store, f.id, '9222', f.runId, f.tabs, f.read)).toMatchObject({ closed: true, organizationPending: true });
  expect(f.store.get(f.id)).toMatchObject({ projectVerified: false, status: 'blocked' });
});
test('new requirements open the configured project once without inventing a conversation URL', async () => {
  const f = fixture();
  const first = await openReview(f.store, 'new-review', '9222', f.tabs);
  expect(first.url).toBe(f.record.projectUrl);
  expect(await openReview(f.store, 'new-review', '9222', f.tabs)).toMatchObject({ reused: true, target: first.target });
  expect(() => f.store.get('new-review')).toThrow();
});

test('closes the final review tab while leaving an inert tab for the shared browser', async () => {
  const f = fixture(); f.available().splice(0);
  await openReview(f.store, f.id, '9222', f.tabs);
  expect(await finishReview(f.store, f.id, '9222', f.runId, f.tabs, f.read)).toMatchObject({ closed: true });
  expect(f.available().map(t => t.url)).toEqual(['about:blank']);
});

test('organization failure remains blocked after closing its completed conversation', async () => {
  const f = fixture(); await openReview(f.store, f.id, '9222', f.tabs);
  f.store.record({ ...f.record, status: 'blocked', titleVerified: false, organizationError: 'Save rejected' });
  expect(await finishReview(f.store, f.id, '9222', f.runId, f.tabs, f.read)).toMatchObject({ closed: true, organizationPending: true });
  expect(f.store.get(f.id)).toMatchObject({ status: 'blocked', organizationError: 'Save rejected' });
});

test('does not close when a successor starts during the page check', async () => {
  const f = fixture(); await openReview(f.store, f.id, '9222', f.tabs);
  await expect(finishReview(f.store, f.id, '9222', f.runId, f.tabs, async () => {
    privateWrite(f.store.path('watch', f.id), { ...f.store.status(f.id), runId: randomUUID(), state: 'waiting' });
    return f.read();
  })).rejects.toThrow('no longer current');
  expect(f.calls.some(c => c[0] === 'close')).toBe(false);
});
