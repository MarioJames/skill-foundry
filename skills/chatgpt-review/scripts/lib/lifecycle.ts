import { existsSync, readFileSync } from 'node:fs';
import { classify, conversationId, type PageState } from './page.ts';
import { Store, privateWrite } from './store.ts';

type Tabs = (...args: string[]) => Promise<any>;
interface Binding { target: string; owned: boolean; cdp: string; closedAt?: string }
const sameConversation = (a: string, b: string) => {
  try { return conversationId(a) === conversationId(b); } catch { return false; }
};
function binding(store: Store, id: string): Binding | undefined {
  const path = store.path('tabs', id);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
}

// Durable identity lives in records; this disposable binding only tracks tab ownership.
export async function openReview(store: Store, id: string, cdp: string, tabs: Tabs) {
  const record = existsSync(store.path('records', id)) ? store.get(id) : undefined;
  const url = record?.url || store.preferences().projectUrl;
  const old = binding(store, id);
  const { tabs: available } = await tabs('list');
  if (!Array.isArray(available)) throw new Error('Cannot inspect browser targets');
  const previous = old?.cdp === cdp && !old.closedAt ? available.find((t: any) => t.targetId === old.target) : undefined;
  const suitable = (t: any) => record ? sameConversation(t.url, url) : t.url === url;
  if (previous && !suitable(previous)) throw new Error('Managed tab changed; inspect it before opening another review');
  const existing = previous || (record ? available.find(suitable) : undefined);
  if (existing) {
    await tabs(existing.targetId);
    const saved: Binding = { cdp, owned: previous ? old!.owned : false, target: existing.targetId };
    privateWrite(store.path('tabs', id), saved);
    return { ...saved, reused: true, url: existing.url };
  }
  const created = await tabs('new', url);
  if (!created.targetId) throw new Error('New browser target was not returned');
  const saved: Binding = { cdp, owned: true, target: created.targetId };
  privateWrite(store.path('tabs', id), saved);
  return { ...saved, reused: false, url };
}

export async function finishReview(store: Store, id: string, cdp: string, runId: string, tabs: Tabs,
  read: (target: string) => Promise<PageState>) {
  const record = store.get(id);
  const result = store.result(id, runId);
  if (result.state !== 'complete' || !result.reply) throw new Error('A completed, saved reply is required before closing');
  if (!record.projectVerified || !record.titleVerified || !record.organizationVerifiedAt || record.organizationError)
    throw new Error('Verify conversation title and project with organize before closing');
  if (record.status !== 'complete') throw new Error('Record the final summary and mark the review complete before closing');
  const saved = binding(store, id);
  if (!saved || !saved.owned) return { closed: false, reason: 'User-owned or untracked tab is preserved', url: record.url };
  if (saved.closedAt) return { closed: true, alreadyClosed: true, url: record.url };
  if (saved.cdp !== cdp) throw new Error('CDP endpoint differs from the managed tab binding');
  const before = await tabs('list');
  if (!Array.isArray(before.tabs)) throw new Error('Cannot inspect browser targets');
  if (before.tabs.some((t: any) => t.targetId === saved.target)) {
    const page = await read(saved.target);
    if (classify(page, record.url, result.userMessageId).state !== 'complete') throw new Error('Tab is no longer on the completed turn; leave it open');
    // Never call browser close: preserve other targets, the shared process and login.
    // agent-browser refuses to close the last tab; leave one inert blank tab instead.
    if (before.tabs.length === 1) await tabs('new', 'about:blank');
    await tabs('close', saved.target);
    const after = await tabs('list');
    if (!Array.isArray(after.tabs) || after.tabs.some((t: any) => t.targetId === saved.target)) throw new Error('Tab closure was not verified');
  }
  privateWrite(store.path('tabs', id), { ...saved, closedAt: new Date().toISOString() });
  return { closed: true, target: saved.target, url: record.url };
}
