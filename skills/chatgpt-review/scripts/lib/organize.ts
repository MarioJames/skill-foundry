import { conversationId } from './page.ts';

export interface OrganizationPreferences {
  projectName: string;
  projectUrl: string;
  timezone: string;
  language: 'en' | 'zh';
}
interface Browser { session: string; run: (...args: string[]) => Promise<any>; read: () => Promise<any> }
export interface ConversationMetadata {
  id: string; title: string; createdAt: string; projectId: string | null;
  archived: boolean; starred: boolean | null; pinnedTime: unknown;
}
const types: Record<string, string> = { FEA: '功能', DES: '设计', FIX: '修复', OPT: '优化', REL: '发布', EXP: '探索', DOC: '文档', RES: '研究' };
export function projectId(value: string) {
  const url = new URL(value);
  const match = url.pathname.match(/^\/g\/(g-p-[a-z0-9]+)(?:-[^/]+)?\/project$/i);
  if (url.origin !== 'https://chatgpt.com' || url.username || url.password || !match || url.search || url.hash) throw new Error('Expected an observed ChatGPT project URL');
  return match[1];
}
export function validatePreferences(value: OrganizationPreferences) {
  projectId(value.projectUrl);
  if (!value.projectName?.trim() || !['en', 'zh'].includes(value.language)) throw new Error('Project name and title language are required');
  if (!value.timezone) throw new Error('Title timezone is required');
  new Intl.DateTimeFormat('en', { timeZone: value.timezone });
  return value;
}
export function conversationTitle(createdAt: string, type: string, topic: string, preferences: OrganizationPreferences) {
  if (!Object.hasOwn(types, type)) throw new Error('Use a title type: FEA, DES, FIX, OPT, REL, EXP, DOC or RES');
  if (!topic?.trim() || /[\r\n｜]/.test(topic) || topic.trim().length > 100) throw new Error('Provide a short, single-line topic without a title separator');
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error('Actual conversation creation time is required');
  const parts = new Intl.DateTimeFormat('en', { timeZone: preferences.timezone, month: '2-digit', day: '2-digit' }).formatToParts(new Date(createdAt));
  const date = ['month', 'day'].map(type => parts.find(part => part.type === type)!.value).join('');
  return `${date}｜${preferences.language === 'zh' ? types[type] : type}｜${topic.trim()}`;
}
export function metadataFromResponse(data: any, id: string): ConversationMetadata {
  const body = typeof data.responseBody === 'string' ? JSON.parse(data.responseBody) : data.responseBody;
  if (data.status !== 200 || body?.conversation_id !== id || typeof body.title !== 'string'
    || typeof body.create_time !== 'number' || !Number.isFinite(body.create_time) || body.create_time <= 0
    || typeof body.is_archived !== 'boolean' || !(body.is_starred === null || typeof body.is_starred === 'boolean')
    || !(body.gizmo_id === null || typeof body.gizmo_id === 'string')) throw new Error('Conversation metadata is missing or does not match the target');
  return { id, title: body.title, createdAt: new Date(body.create_time * 1000).toISOString(),
    projectId: body.gizmo_id, archived: body.is_archived, starred: body.is_starred, pinnedTime: body.pinned_time ?? null };
}

// Only inspect this conversation's visible controls. Selectors are returned, never prompts/account data.
export function organizationUiScript(id: string) {
  return `(() => {
    const visible = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
    const links = Array.from(document.querySelectorAll('a[data-sidebar-item]')).filter(e => {
      try { return new URL(e.href).pathname.endsWith('/c/' + ${JSON.stringify(id)}); } catch { return false; }
    });
    const buttons = links.flatMap(e => Array.from(e.querySelectorAll('button[aria-haspopup="menu"]'))).filter(visible);
    const button = buttons.length === 1 ? buttons[0] : null;
    const chats = Array.from(document.querySelectorAll('button')).find(e => visible(e) && /^(Chats|聊天)$/.test(e.innerText.trim()));
    const input = Array.from(document.querySelectorAll('input[aria-label="Chat title"],input[aria-label="聊天标题"]')).find(visible);
    const items = Array.from(document.querySelectorAll('[role="menuitem"]')).filter(visible).map(e => ({
      label: e.getAttribute('aria-label') || e.innerText.trim(), text: e.innerText.trim(), disabled: e.getAttribute('aria-disabled') === 'true'
    }));
    return { options: button ? 'a[data-sidebar-item][href$="/c/' + ${JSON.stringify(id)} + '"] button[aria-haspopup="menu"]' : null,
      chats: chats ? { label: chats.innerText.trim(), expanded: chats.getAttribute('aria-expanded') === 'true' } : null,
      titleInput: input ? 'input[aria-label=' + JSON.stringify(input.getAttribute('aria-label')) + ']' : null, items };
  })()`;
}

export async function organizeConversation(b: Browser, url: string, preferences: OrganizationPreferences, type: string, topic: string) {
  validatePreferences(preferences);
  const id = conversationId(url);
  const expectedProject = projectId(preferences.projectUrl);
  // Validate naming inputs before any external mutation, using an arbitrary valid date only for validation.
  conversationTitle('2000-01-01T00:00:00Z', type, topic, preferences);
  const guard = async () => {
    const page = await b.read();
    if (conversationId(page.url) !== id) throw new Error('Conversation changed; refusing organization');
    if (page.blocked) throw new Error(page.blocked);
    if (page.generating) throw new Error('Response is generating; finish monitoring before organizing');
    return page;
  };
  const act = async (...args: string[]) => { await guard(); return b.run(...args); };
  const ui = async () => { await guard(); return (await b.run('eval', organizationUiScript(id))).result; };
  const waitUi = async (accept: (state: any) => boolean, reason: string) => {
    for (let attempt = 0; attempt < 30; attempt++) {
      const state = await ui();
      if (accept(state)) return state;
      await Bun.sleep(100);
    }
    throw new Error(reason);
  };
  const requests = async () => {
    // agent-browser returns headers and bodies internally. Never log or persist this response.
    const data = await b.run('network', 'requests');
    if (!Array.isArray(data.requests)) throw new Error('Network observation unavailable');
    return data.requests;
  };
  const waitForSave = async (previous: Set<string>, action: string) => {
    for (let attempt = 0; attempt < 40; attempt++) {
      await guard();
      const writes = (await requests()).filter((r: any) => {
        if (previous.has(r.requestId) || !['POST', 'PATCH', 'PUT'].includes(r.method)) return false;
        try { const u = new URL(r.url); return u.origin === 'https://chatgpt.com'
          && u.pathname.startsWith('/backend-api/') && u.pathname.split('/').includes(id); } catch { return false; }
      });
      const rejected = writes.find((r: any) => r.status >= 400);
      if (rejected) throw new Error(`${action} save rejected (HTTP ${rejected.status}); organization not verified`);
      if (writes.some((r: any) => r.status >= 200 && r.status < 300)) return;
      await Bun.sleep(250);
    }
    throw new Error(`${action} save was not acknowledged; leave the page intact and inspect before retrying`);
  };
  const freshMetadata = async (reload = true) => {
    await guard();
    const isMetadata = (r: any) => {
      if (r.method !== 'GET') return false;
      try { const u = new URL(r.url); return u.origin === 'https://chatgpt.com' &&
        [`/backend-api/conversations/${id}`, `/backend-api/conversation/${id}`].includes(u.pathname); } catch { return false; }
    };
    const observed = await requests();
    // A newly attached browser session may not have captured the initial page load.
    reload ||= !observed.some((r: any) => isMetadata(r) && r.status === 200);
    const previous = new Set(reload ? observed.map((r: any) => r.requestId) : []);
    if (reload) await act('reload');
    let rejection: number | undefined;
    for (let attempt = 0; attempt < 40; attempt++) {
      // Metadata can arrive before hydration creates the composer and sidebar.
      await guard();
      const observed = (await requests()).filter((r: any) => !previous.has(r.requestId) && isMetadata(r));
      const latest = observed.at(-1);
      // The UI can fall back from the plural endpoint to the singular endpoint.
      // Observe its normal recovery without issuing another request ourselves.
      if (latest?.status >= 400) rejection = latest.status;
      if (latest?.status === 200) {
        await Bun.sleep(250);
        await guard();
        return metadataFromResponse(await b.run('network', 'request', latest.requestId), id);
      }
      await Bun.sleep(250);
    }
    if (rejection) throw new Error(`Conversation metadata request rejected (HTTP ${rejection}); organization not verified`);
    throw new Error('Fresh conversation metadata unavailable after reload; organization not verified');
  };
  const openOptions = async () => {
    let state = await ui();
    if (!state.options && state.chats && !state.chats.expanded) {
      await act('find', 'role', 'button', 'click', '--name', state.chats.label, '--exact');
      state = await waitUi(s => !!s.options, 'Target conversation not visible in sidebar; open its project/history before retrying');
    }
    if (!state.options) throw new Error('Target conversation not visible in sidebar; open its project/history before retrying');
    // Sidebar hydration can replace Radix ids; anchor the control to this conversation.
    // Keyboard activation also avoids clicking moving sidebar coordinates during expansion.
    await act('focus', state.options);
    await act('press', 'Enter');
  };
  const menuItem = async (names: string[]) => {
    const state = await waitUi(s => s.items.some((i: any) => names.includes(i.text)), 'Conversation menu action unavailable');
    const matches = state.items.filter((i: any) => names.includes(i.text));
    if (matches.length !== 1 || matches[0].disabled) throw new Error('Conversation menu action unavailable or ambiguous');
    await act('find', 'role', 'menuitem', 'click', '--name', matches[0].label, '--exact');
  };
  const before = await freshMetadata(false);
  if (before.archived) throw new Error('Conversation is archived; refusing to change its archive status');
  const title = conversationTitle(before.createdAt, type, topic, preferences);
  let current = before;
  if (current.title !== title) {
    await openOptions();
    await menuItem(['Rename', '重命名']);
    const state = await waitUi(s => !!s.titleInput, 'Chat title input unavailable');
    await act('fill', state.titleInput, title);
    const previous = new Set<string>((await requests()).map((r: any) => r.requestId));
    await act('press', 'Enter');
    await waitUi(s => !s.titleInput, 'Chat title edit did not finish');
    await waitForSave(previous, 'Title');
    current = await freshMetadata();
    if (current.title !== title) throw new Error('Renamed title did not persist; organization not verified');
  }
  if (current.projectId !== expectedProject) {
    await openOptions();
    await menuItem(['Move to project', '移至项目', '移动到项目']);
    // Text is the project name; its accessible label can also contain icon/color descriptions.
    const state = await waitUi(s => s.items.some((i: any) => i.text === preferences.projectName), 'Requested project is not available in the menu');
    const matches = state.items.filter((i: any) => i.text === preferences.projectName);
    if (matches.length !== 1 || matches[0].disabled) throw new Error('Requested project is unavailable or ambiguous');
    const previous = new Set<string>((await requests()).map((r: any) => r.requestId));
    await act('find', 'role', 'menuitem', 'click', '--name', matches[0].label, '--exact');
    await waitUi(s => !s.items.length, 'Project selection did not finish');
    await waitForSave(previous, 'Project');
    current = await freshMetadata();
  }
  if (before.title === title && before.projectId === expectedProject) current = await freshMetadata();
  if (current.title !== title || current.projectId !== expectedProject) throw new Error('Title/project did not persist after reload; organization not verified');
  if (current.createdAt !== before.createdAt || current.archived !== before.archived
    || current.starred !== before.starred || current.pinnedTime !== before.pinnedTime) throw new Error('Unrelated conversation metadata changed; inspect before continuing');
  return { verified: true, changed: before.title !== title || before.projectId !== expectedProject,
    title, conversationCreatedAt: current.createdAt, projectId: current.projectId, projectUrl: preferences.projectUrl,
    projectName: preferences.projectName, url: (await b.read()).url, session: b.session, verifiedAt: new Date().toISOString() };
}
