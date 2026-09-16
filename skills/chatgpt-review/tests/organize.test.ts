import { describe, expect, test } from 'bun:test';
import { conversationTitle, metadataFromResponse, organizeConversation, projectId, type OrganizationPreferences } from '../scripts/lib/organize.ts';

const url = 'https://chatgpt.com/c/review-a';
const preferences: OrganizationPreferences = { projectName: 'Agent reviews', projectUrl: 'https://chatgpt.com/g/g-p-example-agent-reviews/project', timezone: 'Asia/Shanghai', language: 'en' };
const body = () => ({ conversation_id: 'review-a', title: 'Automatic title', create_time: Date.parse('2026-09-15T17:00:00Z') / 1000,
  update_time: Date.parse('2026-10-01T00:00:00Z') / 1000, gizmo_id: null as string | null, is_archived: false, is_starred: null as boolean | null, pinned_time: null });
function fixture(options: { wrongUrl?: boolean; generating?: boolean; ignoreRename?: boolean; rejectRename?: boolean; wrongProject?: boolean; changePinned?: boolean; metadataFallback?: boolean } = {}) {
  let saved = body(), pending = '', menu = '', editing = false, sequence = 0, focused = '';
  let fallbackPending = false;
  const requests: any[] = [], snapshots = new Map<string, any>(), mutations: string[][] = [];
  requests.push({ requestId: 'initial', method: 'GET', status: 200, url: 'https://chatgpt.com/backend-api/conversations/review-a' });
  snapshots.set('initial', { ...saved });
  const item = (text: string) => ({ text, label: text, disabled: false });
  const savedRequest = (action: string, status = 200) => requests.push({ requestId: 'save' + (++sequence), method: 'POST', status,
    url: `https://chatgpt.com/backend-api/conversation/id/review-a/${action}` });
  return { mutations, saved: () => saved, session: 'organize-test', read: async () => ({ url: options.wrongUrl ? 'https://chatgpt.com/c/other' : url,
    generating: options.generating ?? false, blocked: null, hasComposer: true }),
    run: async (...args: string[]) => {
      if (args[0] === 'network' && args[1] === 'requests') {
        const latest = requests.at(-1);
        if (fallbackPending && latest?.status === 403) {
          const requestId = 'fallback' + (++sequence);
          requests.push({ requestId, method: 'GET', status: 200, url: 'https://chatgpt.com/backend-api/conversation/review-a' });
          snapshots.set(requestId, { ...saved });
          fallbackPending = false;
        }
        const observed = [...requests];
        if (options.metadataFallback && latest?.status === 403) fallbackPending = true;
        return { requests: observed };
      }
      if (args[0] === 'network' && args[1] === 'request') return { status: 200, responseBody: JSON.stringify(snapshots.get(args[2])) };
      if (args[0] === 'eval') return { result: { options: '#options', chats: null, titleInput: editing ? '#title' : null,
        items: menu === 'options' ? [item('Rename'), item('Move to project')] : menu === 'projects' ? [item('Agent reviews')] : [] } };
      if (args[0] === 'reload') {
        sequence++; const requestId = 'r' + sequence;
        requests.push({ requestId, method: 'GET', status: 200, url: 'https://chatgpt.com/backend-api/conversations/review-a?num_turns=10' });
        snapshots.set(requestId, { ...saved });
        if (options.metadataFallback) {
          requests.at(-1).status = 403;
          fallbackPending = false;
        }
        return {};
      }
      mutations.push(args);
      if (args[0] === 'focus') focused = args[1];
      else if (args[0] === 'press' && args[1] === 'Enter' && focused === '#options' && !editing) menu = 'options';
      else if (args[0] === 'find') {
        const name = args[args.indexOf('--name') + 1];
        if (name === 'Rename') { editing = true; menu = ''; }
        else if (name === 'Move to project') menu = 'projects';
        else if (name === 'Agent reviews') { saved.gizmo_id = options.wrongProject ? 'g-p-other' : 'g-p-example'; menu = ''; savedRequest('move'); }
        else throw new Error('Unexpected menu action');
      } else if (args[0] === 'fill') { pending = args[2]; focused = '#title'; }
      else if (args[0] === 'press' && args[1] === 'Enter') {
        if (!options.ignoreRename && !options.rejectRename) saved.title = pending;
        if (options.changePinned) saved.is_starred = true;
        editing = false;
        savedRequest('rename', options.rejectRename ? 403 : 200);
      } else throw new Error('Unexpected mutation: ' + args.join(' '));
      return {};
    } };
}

describe('conversation organization', () => {
  test('uses actual creation time in the configured timezone and language', () => {
    const meta = metadataFromResponse({ status: 200, responseBody: JSON.stringify(body()) }, 'review-a');
    expect(conversationTitle(meta.createdAt, 'FIX', '迁移衔接', preferences)).toBe('0916｜FIX｜迁移衔接');
    expect(conversationTitle(meta.createdAt, 'FIX', '迁移衔接', { ...preferences, timezone: 'UTC', language: 'zh' })).toBe('0915｜修复｜迁移衔接');
    expect(projectId(preferences.projectUrl)).toBe('g-p-example');
  });
  test('does not replace missing creation metadata with update time or another conversation', () => {
    for (const patch of [{ create_time: undefined }, { conversation_id: 'other' }, { create_time: '2026-09-15' }]) {
      expect(() => metadataFromResponse({ status: 200, responseBody: { ...body(), ...patch } }, 'review-a')).toThrow('metadata');
    }
  });
  test('renames and moves the exact conversation, verifies persisted metadata, then reruns without mutations', async () => {
    const b = fixture();
    expect(await organizeConversation(b, url, preferences, 'FIX', '迁移衔接')).toMatchObject({ verified: true, changed: true,
      title: '0916｜FIX｜迁移衔接', projectId: 'g-p-example', conversationCreatedAt: '2026-09-15T17:00:00.000Z' });
    const count = b.mutations.length;
    expect(await organizeConversation(b, url, preferences, 'FIX', '迁移衔接')).toMatchObject({ verified: true, changed: false });
    expect(b.mutations.length).toBe(count);
    expect(b.saved()).toMatchObject({ is_archived: false, is_starred: null, pinned_time: null });
  });
  test('waits for the UI metadata fallback after a rejected endpoint without reloading again', async () => {
    expect(await organizeConversation(fixture({ metadataFallback: true }), url, preferences, 'FIX', 'Topic'))
      .toMatchObject({ verified: true, projectId: 'g-p-example' });
  });
  test('refuses navigation drift and active generation before mutation', async () => {
    for (const opts of [{ wrongUrl: true }, { generating: true }]) {
      const b = fixture(opts);
      await expect(organizeConversation(b, url, preferences, 'FIX', 'Topic')).rejects.toThrow();
      expect(b.mutations).toHaveLength(0);
    }
  });
  test('fails when a clicked rename was not persisted', async () => {
    await expect(organizeConversation(fixture({ ignoreRename: true }), url, preferences, 'FIX', 'Topic')).rejects.toThrow('title did not persist');
  });
  test('reports a rejected save and does not attempt to move the conversation', async () => {
    const b = fixture({ rejectRename: true });
    await expect(organizeConversation(b, url, preferences, 'FIX', 'Topic')).rejects.toThrow('Title save rejected (HTTP 403)');
    expect(b.saved().gizmo_id).toBeNull();
    expect(b.saved().title).toBe('Automatic title');
  });
  test('checks project identity rather than trusting menu closure or display name', async () => {
    await expect(organizeConversation(fixture({ wrongProject: true }), url, preferences, 'FIX', 'Topic')).rejects.toThrow('Title/project did not persist');
  });
  test('detects unrelated archive or pin changes', async () => {
    await expect(organizeConversation(fixture({ changePinned: true }), url, preferences, 'FIX', 'Topic')).rejects.toThrow('Unrelated');
  });
  test('rejects invalid naming input before changing the conversation', async () => {
    const b = fixture();
    await expect(organizeConversation(b, url, preferences, 'UNKNOWN', 'Topic')).rejects.toThrow('title type');
    expect(b.mutations).toHaveLength(0);
  });
});
