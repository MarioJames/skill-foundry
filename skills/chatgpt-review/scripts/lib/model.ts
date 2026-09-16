import { required } from './command.ts';

interface Control { selector: string; label: string; disabled: boolean; expanded: boolean }
interface Power { value: number; min: number; max: number; disabled: boolean; description: string; focused: boolean }
export interface ModelState {
  url: string; blocked: string | null; generating: boolean; hasComposer: boolean;
  control: Control | null; menuLabel: string | null; power: Power | null;
  latest: { checked: boolean; disabled: boolean } | null;
}
interface Browser { session: string; run: (...args: string[]) => Promise<any> }
const POWER = '[role="menuitem"][aria-label="Power"]';
const SELECT = '[role="menuitem"][aria-label="Select model"]';

// Read only UI state. Never expose prompts, account data, tokens or request headers.
export const MODEL_SCRIPT = `(() => {
  const visible = e => !!e && e.getClientRects().length > 0
    && !e.closest('[aria-hidden="true"]') && getComputedStyle(e).visibility !== 'hidden';
  const label = e => (e?.innerText || '').replace(/\\s+/g, ' ').trim();
  const disabled = e => !!e && (e.disabled || e.getAttribute('aria-disabled') === 'true'
    || !!e.querySelector('[aria-disabled="true"], [data-locked="true"]'));
  const composer = document.querySelector('#prompt-textarea');
  const form = composer?.closest('form');
  const controls = Array.from(form?.querySelectorAll('button[aria-haspopup="menu"]') || [])
    .filter(e => visible(e) && e.getAttribute('data-testid') !== 'composer-plus-btn');
  const control = controls.length === 1 && controls[0].id ? controls[0] : null;
  const menus = Array.from(document.querySelectorAll('[role="menu"]'))
    .filter(e => visible(e) && control && e.getAttribute('aria-labelledby') === control.id);
  const menu = menus.length === 1 ? menus[0] : null;
  const select = menu && Array.from(menu.querySelectorAll('${SELECT}')).find(visible);
  const power = menu && Array.from(menu.querySelectorAll('${POWER}')).find(visible);
  const slider = power?.querySelector('[role="slider"]');
  const latest = menu && Array.from(menu.querySelectorAll('[role="menuitemradio"]'))
    .find(e => visible(e) && label(e) === 'Latest');
  const buttons = Array.from(document.querySelectorAll('button')).filter(visible);
  const buttonLabel = e => e.getAttribute('aria-label') || label(e);
  const login = location.hostname === 'auth.openai.com' || buttons.some(e => /^(Log in|登录)$/.test(buttonLabel(e)));
  const challenge = /^(Just a moment|Security Verification)/i.test(document.title)
    || Array.from(document.querySelectorAll('iframe')).some(e => /cloudflare security challenge/i.test(e.title));
  return { url: location.href, blocked: challenge ? 'Human verification required' : login ? 'Login required' : null,
    generating: buttons.some(e => /^(Stop answering|Stop generating|停止回答|停止生成)$/.test(buttonLabel(e))),
    hasComposer: visible(composer),
    control: control ? { selector: '#' + CSS.escape(control.id), label: label(control),
      disabled: disabled(control), expanded: control.getAttribute('aria-expanded') === 'true' } : null,
    menuLabel: select ? label(select) : null,
    power: slider ? { value: Number(slider.getAttribute('aria-valuenow')), min: Number(slider.getAttribute('aria-valuemin')),
      max: Number(slider.getAttribute('aria-valuemax')), disabled: disabled(power),
      focused: document.activeElement === power,
      description: (power.getAttribute('aria-describedby') || '').split(/\\s+/).map(id => label(document.getElementById(id))).join(' ') } : null,
    latest: latest ? { checked: latest.getAttribute('aria-checked') === 'true', disabled: disabled(latest) } : null };
})()`;

export function modelUrl(value: string) {
  const url = new URL(value);
  if (url.origin !== 'https://chatgpt.com' || url.username || url.password) throw new Error('Expected a ChatGPT URL');
  url.hash = '';
  return url.href;
}

export async function ensureModel(b: Browser, opts: Record<string, string>) {
  const expectedUrl = modelUrl(required(opts, 'url'));
  const expectedModel = opts.model || '6 Pro';
  if (expectedModel !== '6 Pro') throw new Error('Automated selection currently supports only --model "6 Pro"');
  const read = async (): Promise<ModelState> => {
    const state: ModelState = (await b.run('eval', MODEL_SCRIPT)).result;
    if (!state || typeof state.url !== 'string') throw new Error('Unrecognized model UI response');
    if (modelUrl(state.url) !== expectedUrl) throw new Error('Page URL changed; refusing model interaction');
    if (state.blocked) throw new Error(state.blocked);
    if (state.generating) throw new Error('Response is generating; refusing model interaction');
    if (!state.hasComposer || !state.control || state.control.disabled) throw new Error('Model control unavailable or ambiguous');
    return state;
  };
  // Recheck the bound page before every action, including keyboard actions.
  const act = async (...args: string[]) => { await read(); await b.run(...args); };
  const wait = async (accept: (state: ModelState) => boolean, reason: string) => {
    for (let i = 0; i < 12; i++) {
      const state = await read();
      if (accept(state)) return state;
      await Bun.sleep(100);
    }
    throw new Error(reason);
  };
  let state = await read();
  const before = state.control!.label;
  let changed = false;
  if (state.control!.expanded) {
    await act('press', 'Escape');
    state = await wait(s => !s.control!.expanded, 'Model menu did not close');
  }
  await act('click', state.control!.selector);
  state = await wait(s => !!s.power && s.menuLabel !== null, 'Power menu unavailable');
  if (state.menuLabel !== expectedModel) {
    await act('click', SELECT);
    state = await wait(s => !!s.latest, 'Latest model option unavailable');
    if (state.latest!.disabled) throw new Error('Latest model option disabled');
    changed = !state.latest!.checked;
    await act('find', 'role', 'menuitemradio', 'click', '--name', 'Latest', '--exact');
    state = await wait(s => !!s.power && s.menuLabel !== null, 'Power menu unavailable after model selection');
  }
  for (let step = 0; step < 5; step++) {
    const power = state.power;
    if (!power || power.disabled || power.min !== 0 || power.max !== 4
      || !Number.isInteger(power.value) || power.value < 0 || power.value > 4) throw new Error('Pro power control unavailable or changed');
    if (power.value === 4) break;
    await act('focus', POWER);
    state = await read();
    if (!state.power?.focused) throw new Error('Power control did not receive keyboard focus');
    const previous = state.power.value;
    await act('press', 'ArrowRight');
    changed = true;
    state = await wait(s => !!s.power && s.power.value > previous, 'Power selection did not advance');
  }
  if (state.menuLabel !== expectedModel || state.power?.value !== 4
    || !/\bPro, 5 of 5\./.test(state.power.description)) throw new Error('Pro selection did not match expected model 6 Pro');
  const evidence = { menuLabel: state.menuLabel, power: state.power.value, description: state.power.description };
  await act('press', 'Escape');
  state = await wait(s => !s.control!.expanded && s.control!.label === expectedModel, 'Closed model control did not confirm 6 Pro');
  // A second read prevents a transient label from being treated as final confirmation.
  state = await read();
  if (state.control!.expanded || state.control!.label !== expectedModel) throw new Error('Model selection did not persist');
  return { verified: true, expectedModel, observedModel: state.control!.label, before, changed,
    url: state.url, target: required(opts, 'target'), session: b.session, verifiedAt: new Date().toISOString(), evidence };
}
