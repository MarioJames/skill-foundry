import { describe, expect, test } from 'bun:test';
import { ensureModel, type ModelState } from '../scripts/lib/model.ts';

const opts = { url: 'https://chatgpt.com/', target: 'TASK-TAB' };
// Simulate only the external browser UI. The production selection algorithm runs unchanged.
function fixture(initial: { version?: string; effort?: number; disabled?: boolean; url?: string; generating?: boolean;
  latestVersion?: string; ignoreKeys?: boolean; closeFallback?: boolean; driftAfterOpen?: boolean } = {}) {
  let version = initial.version ?? '5.6';
  let effort = initial.effort ?? 1;
  let expanded = false, models = false, focused = false;
  let url = initial.url ?? opts.url;
  const mutations: string[][] = [];
  const label = () => effort === 4 ? `${version} Pro` : `${version} ${['Light', 'Standard', 'High', 'Extra High'][effort]}`;
  const state = (): ModelState => ({ url, blocked: null, generating: initial.generating ?? false, hasComposer: true,
    control: { selector: '#model', label: expanded ? 'Thinking effort' : label(), disabled: false, expanded },
    menuLabel: expanded && !models ? label() : null,
    power: expanded && !models ? { value: effort, min: 0, max: 4, disabled: initial.disabled ?? false, focused,
      description: effort === 4 ? 'Pro, 5 of 5. Use Left and Right arrow keys to adjust power.' : 'Intermediate power.' } : null,
    latest: expanded && models ? { checked: version === (initial.latestVersion ?? '6'), disabled: false } : null });
  return { mutations, state, session: 'test-session', run: async (...args: string[]) => {
    if (args[0] === 'eval') return { result: state() };
    mutations.push(args);
    if (args[0] === 'click' && args[1] === '#model') {
      expanded = true;
      if (initial.driftAfterOpen) url = 'https://chatgpt.com/c/other-requirement';
    } else if (args[0] === 'click' && args[1].includes('Select model')) models = true;
    else if (args[0] === 'find' && args.includes('Latest')) { version = initial.latestVersion ?? '6'; models = false; }
    else if (args[0] === 'focus' && args[1].includes('Power')) focused = true;
    else if (args[0] === 'press' && args[1] === 'ArrowRight') {
      if (!focused) throw new Error('Keyboard action escaped Power');
      if (!initial.ignoreKeys) effort = Math.min(4, effort + 1);
    } else if (args[0] === 'press' && args[1] === 'Escape') {
      expanded = false; models = false; focused = false;
      if (initial.closeFallback) version = '5.6';
    } else throw new Error('Unexpected browser mutation: ' + args.join(' '));
    return {};
  } };
}

describe('pre-send Pro selection', () => {
  test('switches an older model and low power, then confirms the closed control', async () => {
    const b = fixture();
    const result = await ensureModel(b, opts);
    expect(result).toMatchObject({ verified: true, before: '5.6 Standard', observedModel: '6 Pro', changed: true,
      target: 'TASK-TAB', evidence: { menuLabel: '6 Pro', power: 4 } });
    expect(b.state().control).toMatchObject({ label: '6 Pro', expanded: false });
    expect(b.mutations.filter(a => a.includes('ArrowRight'))).toHaveLength(3);
  });
  test('verifies an already correct model without changing its model or power', async () => {
    const b = fixture({ version: '6', effort: 4 });
    expect(await ensureModel(b, opts)).toMatchObject({ verified: true, changed: false, observedModel: '6 Pro' });
    expect(b.mutations).toEqual([['click', '#model'], ['press', 'Escape']]);
  });
  test('refuses a disabled Pro control instead of claiming success from the label', async () => {
    await expect(ensureModel(fixture({ version: '6', effort: 4, disabled: true }), opts)).rejects.toThrow('unavailable');
  });
  test('does not act on the wrong URL or a generating conversation', async () => {
    for (const initial of [{ url: 'https://chatgpt.com/c/unrelated' }, { generating: true }]) {
      const b = fixture(initial);
      await expect(ensureModel(b, opts)).rejects.toThrow();
      expect(b.mutations).toHaveLength(0);
    }
  });
  test('stops interacting if the page changes during selection', async () => {
    const b = fixture({ driftAfterOpen: true });
    await expect(ensureModel(b, opts)).rejects.toThrow('URL changed');
    expect(b.mutations).toEqual([['click', '#model']]);
  });
  test('does not equate Latest and maximum effort with the requested version', async () => {
    await expect(ensureModel(fixture({ latestVersion: '7' }), opts)).rejects.toThrow('expected model 6 Pro');
  });
  test('bounds retries when keyboard selection has no effect', async () => {
    const b = fixture({ version: '6', effort: 3, ignoreKeys: true });
    await expect(ensureModel(b, opts)).rejects.toThrow('did not advance');
    expect(b.mutations.filter(a => a.includes('ArrowRight'))).toHaveLength(1);
  });
  test('requires the closed control to retain the selected model', async () => {
    await expect(ensureModel(fixture({ closeFallback: true }), opts)).rejects.toThrow('did not confirm');
  });
  test('rejects unsupported requests before browser interaction', async () => {
    const b = fixture();
    await expect(ensureModel(b, { ...opts, model: '5.6 Pro' })).rejects.toThrow('supports only');
    await expect(ensureModel(b, { ...opts, url: 'https://example.com/' })).rejects.toThrow('ChatGPT URL');
    expect(b.mutations).toHaveLength(0);
  });
});
