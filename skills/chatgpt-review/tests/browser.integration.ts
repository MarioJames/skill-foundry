// Run explicitly: bun tests/browser.integration.ts --chrome /path/to/installed/chrome
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browser, browserTabs } from '../scripts/lib/browser.ts';
import { command } from '../scripts/lib/command.ts';

const chromePath = process.argv[process.argv.indexOf('--chrome') + 1];
if (!process.argv.includes('--chrome') || !chromePath) throw new Error('Pass --chrome with an installed Chrome executable');
const root = mkdtempSync(join(tmpdir(), 'review-browser-'));
const namespace = `rt-${process.pid}-${Date.now().toString(36).slice(-4)}`;
const previous = { config: process.env.AGENT_BROWSER_CONFIG, namespace: process.env.AGENT_BROWSER_NAMESPACE };
writeFileSync(join(root, 'config.json'), '{}');
process.env.AGENT_BROWSER_CONFIG = join(root, 'config.json');
process.env.AGENT_BROWSER_NAMESPACE = namespace;
const chrome = Bun.spawn([chromePath, '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=0', `--user-data-dir=${join(root, 'profile')}`, 'about:blank'], { stdout: 'ignore', stderr: 'ignore' });
let cdp: string | undefined;
try {
  const portFile = join(root, 'profile', 'DevToolsActivePort');
  for (let i = 0; !existsSync(portFile) && i < 100; i++) {
    if (chrome.exitCode !== null) throw new Error(`Chrome exited: ${chrome.exitCode}`);
    await Bun.sleep(50);
  }
  cdp = readFileSync(portFile, 'utf8').split('\n')[0];
  const list = async () => (await (await fetch(`http://127.0.0.1:${cdp}/json/list`)).json())
    .filter((p: any) => p.type === 'page') as { id: string; url: string }[];
  const initial = await list();
  assert.equal(initial.length, 1);
  const tabs = browserTabs('integration', { cdp });
  await tabs('list');
  assert.equal((await list()).length, 1, 'listing must not create a blank tab');
  const html = '<main><div data-message-author-role="user" data-message-id="u1">Review</div>' +
    '<div data-turn="assistant"><div data-message-author-role="assistant" data-message-id="a1">Done</div>' +
    '<button aria-label="Copy response">Copy</button></div><textarea id="prompt-textarea"></textarea></main>';
  const url = 'data:text/html,' + encodeURIComponent(html);
  const created = await tabs('new', url);
  assert.equal((await list()).length, 2, 'one requested tab, no implicit extra tab');
  const b = await browser('integration', { cdp, target: created.targetId });
  const page = await b.read();
  assert.equal(page.url, url);
  assert.equal(page.messages.at(-1)?.text, 'Done');
  assert.equal(page.messages.at(-1)?.final, true);
  await (await browser('integration', { cdp, target: created.targetId })).read();
  assert.equal((await list()).length, 2, 'binding and rebinding must not create blank tabs');
  await tabs('close', created.targetId);
  await assert.rejects(b.read(), /tab_gone|closed/i, 'closed pinned target must not fall back to the user tab');
  await assert.rejects(browser('integration', { cdp, target: created.targetId }), /not found|no tab|closed|tab_gone/i);
  assert.deepEqual((await list()).map(p => p.id), initial.map(p => p.id));
  console.log(JSON.stringify({ passed: true, initialTabs: 1, peakTabs: 2, remainingTabs: 1,
    checks: ['list', 'create', 'read', 'rebind', 'close', 'pin protection', 'missing target'], cdp }));
} finally {
  try {
    // This namespace and browser belong only to this test. Never use close --all on shared sessions.
    await command(['agent-browser', '--namespace', namespace, 'close', '--all', '--json']);
  } finally {
    if (chrome.exitCode === null) chrome.kill();
    await chrome.exited;
    if (cdp) {
      const reachable = await fetch(`http://127.0.0.1:${cdp}/json/version`).then(() => true, () => false);
      assert.equal(reachable, false, 'test Chrome must be released');
    }
    if (previous.config === undefined) delete process.env.AGENT_BROWSER_CONFIG;
    else process.env.AGENT_BROWSER_CONFIG = previous.config;
    if (previous.namespace === undefined) delete process.env.AGENT_BROWSER_NAMESPACE;
    else process.env.AGENT_BROWSER_NAMESPACE = previous.namespace;
    rmSync(root, { recursive: true, force: true });
  }
}
