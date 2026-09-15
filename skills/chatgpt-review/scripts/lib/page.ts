export interface Message { id: string; role: string; text: string; final: boolean; model?: string }
export interface PageState { url: string; title: string; messages: Message[]; generating: boolean; blocked: string | null; hasComposer: boolean }
export type Outcome = { state: 'waiting' | 'complete' | 'blocked' | 'superseded'; reason?: string; reply?: Message };

export function conversationId(url: string): string {
  const u = new URL(url);
  if (u.origin !== 'https://chatgpt.com') throw new Error('Expected a ChatGPT conversation URL');
  const match = u.pathname.match(/(?:^|\/)c\/([a-zA-Z0-9-]+)$/);
  if (!match) throw new Error('Expected a persisted conversation URL, not a draft');
  return match[1];
}
export function classify(page: PageState, url: string, userId: string): Outcome {
  if (page.blocked) return { state: 'blocked', reason: page.blocked };
  try { if (conversationId(page.url) !== conversationId(url)) return { state: 'blocked', reason: 'Conversation changed' }; }
  catch { return { state: 'blocked', reason: 'Not on the registered conversation' }; }
  const index = page.messages.findIndex(m => m.role === 'user' && m.id === userId);
  if (index < 0) return { state: 'blocked', reason: 'Submitted user message is absent; inspect the page' };
  const after = page.messages.slice(index + 1);
  if (after.some(m => m.role === 'user')) return { state: 'superseded', reason: 'A later user message is present' };
  const reply = after.filter(m => m.role === 'assistant').at(-1);
  if (!page.generating && reply?.final && reply.text.trim()) return { state: 'complete', reply };
  if (!page.hasComposer) return { state: 'blocked', reason: 'Unrecognized conversation UI' };
  return { state: 'waiting' };
}
export const PAGE_SCRIPT = `(() => {
  const main = document.querySelector('main');
  const visible = e => !!e && e.getClientRects().length > 0;
  const buttons = Array.from(document.querySelectorAll('button')).filter(visible);
  const label = e => e.getAttribute('aria-label') || e.textContent || '';
  const messages = Array.from(document.querySelectorAll('[data-message-author-role]')).map(e => {
    const turn = e.closest('[data-turn="assistant"], [data-testid^="conversation-turn-"]');
    const actions = turn ? Array.from(turn.querySelectorAll('button')) : [];
    return { id: e.getAttribute('data-message-id') || '', role: e.getAttribute('data-message-author-role'),
      text: e.getAttribute('data-message-author-role') === 'assistant' ? e.innerText : '',
      model: e.getAttribute('data-message-model-slug') || undefined,
      final: actions.some(b => /^(Copy response|复制回复)$/.test(label(b))) };
  });
  const challenge = /^(Just a moment|Security Verification)/i.test(document.title)
    || Array.from(document.querySelectorAll('iframe')).some(e => /cloudflare security challenge/i.test(e.title));
  const login = location.hostname === 'auth.openai.com' || buttons.some(e => /^(Log in|登录)$/.test(label(e)));
  const alerts = Array.from(document.querySelectorAll('[role="alert"]')).filter(visible).map(e => e.innerText).join(' ');
  const error = /something went wrong|unable to load conversation|出了点问题|无法加载对话/i.test(alerts);
  return { url:location.href, title:document.title, messages,
    generating:buttons.some(e => /^(Stop answering|Stop generating|停止回答|停止生成)$/.test(label(e))),
    hasComposer:!!document.querySelector('[contenteditable="true"][role="textbox"], #prompt-textarea'),
    blocked:challenge ? 'Human verification required' : login ? 'Login required' : error ? 'Conversation UI reported an error' : null };
})()`;
