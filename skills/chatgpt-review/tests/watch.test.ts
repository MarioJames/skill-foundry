import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const entry = resolve(import.meta.dir, '../scripts/review.ts');
const roots: string[] = [];
const children: ReturnType<typeof Bun.spawn>[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'chatgpt-review-test-'));
  roots.push(root);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const pagePath = join(root, 'page.json');
  const callsPath = join(root, 'calls.jsonl');
  writeFileSync(join(bin, 'agent-browser'), `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs';
appendFileSync(process.env.CALLS_PATH, JSON.stringify(Bun.argv.slice(2)) + '\\n');
console.log(JSON.stringify({ success: true, data: { result: JSON.parse(readFileSync(process.env.PAGE_PATH, 'utf8')) } }));
`, { mode: 0o700 });
  writeFileSync(join(bin, 'herdr'), `#!${process.execPath}
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.CALLS_PATH, JSON.stringify(Bun.argv.slice(2)) + '\\n');
`, { mode: 0o700 });
  const stateRoot = join(root, 'state');
  const env = { ...process.env, PATH: bin, CHATGPT_REVIEW_HOME: stateRoot, PAGE_PATH: pagePath, CALLS_PATH: callsPath };
  const cli = (...args: string[]) => Bun.spawnSync([process.execPath, entry, ...args], { env, stdout: 'pipe', stderr: 'pipe' });
  const id = 'example-review';
  const url = 'https://chatgpt.com/c/example-conversation';
  const input = join(root, 'record.json');
  writeFileSync(input, JSON.stringify({ id, title: 'Example', url, projectUrl: 'https://chatgpt.com/g/example/project', projectVerified: true, background: 'Example requirement', summary: 'Awaiting review', status: 'open' }));
  expect(cli('record', '--input', input).exitCode).toBe(0);
  const page = (user: string, complete: boolean) => writeFileSync(pagePath, JSON.stringify({
    url, title: 'Example', generating: !complete, hasComposer: true, blocked: null,
    messages: [{ id: user, role: 'user', text: '', final: false }, ...(complete ? [{ id: 'answer', role: 'assistant', text: `Reply to ${user}`, final: true }] : [])],
  }));
  const watchArgs = (user: string) => ['watch', '--id', id, '--cdp', '9222', '--target', 'EXAMPLE', '--user', user, '--timeout-seconds', '1.5'];
  const watch = (user: string) => {
    const child = Bun.spawn([process.execPath, entry, ...watchArgs(user)], { env, stdout: 'pipe', stderr: 'pipe' });
    children.push(child);
    return child;
  };
  const status = () => JSON.parse(cli('status', '--id', id).stdout.toString());
  const waiting = async (user: string) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const path = join(stateRoot, 'watch', id + '.json');
      if (existsSync(path)) {
        const value = JSON.parse(readFileSync(path, 'utf8'));
        if (value.state === 'waiting' && value.userMessageId === user) return value;
      }
      await Bun.sleep(5);
    }
    throw new Error('Watcher did not enter waiting state');
  };
  return { id, cli, page, watchArgs, watch, waiting, status, stateRoot, callsPath };
}

test('result refuses an earlier reply while the current turn is pending', async () => {
  const f = fixture();
  f.page('user-old', true);
  expect(f.cli(...f.watchArgs('user-old'), '--notify-pane', 'example-origin').exitCode).toBe(0);
  const old = JSON.parse(f.cli('result', '--id', f.id).stdout.toString());
  expect(old.reply.text).toBe('Reply to user-old');
  const oldStatus = f.status();
  expect(oldStatus.notification).toMatchObject({ delivered: true, desktop: true });
  const notifications = readFileSync(f.callsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(args => args[0] === 'agent');
  expect(notifications).toHaveLength(1);
  expect(notifications[0][3]).toContain(`--run ${old.runId}`);
  expect(notifications[0][3]).toContain(oldStatus.resultPath);

  f.page('user-new', false);
  const child = f.watch('user-new');
  const current = await f.waiting('user-new');
  const pending = f.cli('result', '--id', f.id);
  expect(pending.exitCode).not.toBe(0);
  expect(pending.stdout.toString()).toBe('');
  expect(current.runId).toMatch(/^[a-f0-9-]{36}$/);
  expect(current.runId).not.toBe(old.runId);
  expect(f.cli('result', '--id', f.id, '--run', old.runId).exitCode).not.toBe(0);
  expect(f.cli(...f.watchArgs('user-new')).exitCode).not.toBe(0);
  expect(f.status().runId).toBe(current.runId);

  expect(await child.exited).toBe(2);
  const terminal = JSON.parse(f.cli('result', '--id', f.id, '--run', current.runId).stdout.toString());
  expect(terminal).toMatchObject({ runId: current.runId, userMessageId: 'user-new', state: 'timeout' });
  expect(terminal.reply).toBeUndefined();
  expect(existsSync(join(f.stateRoot, 'locks', f.id + '.json'))).toBe(false);
  expect(JSON.parse(readFileSync(oldStatus.resultPath, 'utf8')).reply.text).toBe('Reply to user-old');

  f.page('user-new', true);
  expect(f.cli(...f.watchArgs('user-new')).exitCode).toBe(0);
  const completed = JSON.parse(f.cli('result', '--id', f.id).stdout.toString());
  expect(completed).toMatchObject({ state: 'complete', userMessageId: 'user-new', reply: { text: 'Reply to user-new' } });
  expect(completed.runId).not.toBe(current.runId);
  expect(f.cli('result', '--id', f.id, '--run', current.runId).exitCode).not.toBe(0);
});

test('cancel is bound to the current run and produces its own terminal result', async () => {
  const f = fixture();
  f.page('user-old', true);
  expect(f.cli(...f.watchArgs('user-old')).exitCode).toBe(0);
  const old = f.status();
  f.page('user-new', false);
  const child = f.watch('user-new');
  const current = await f.waiting('user-new');
  expect(f.cli('status', '--id', f.id, '--run', old.runId).exitCode).not.toBe(0);
  expect(f.cli('cancel', '--id', f.id, '--run', old.runId).exitCode).not.toBe(0);
  expect(existsSync(join(f.stateRoot, 'cancel', f.id + '.json'))).toBe(false);
  expect(f.cli('cancel', '--id', f.id, '--run', current.runId).exitCode).toBe(0);
  expect(await child.exited).toBe(2);
  const result = JSON.parse(f.cli('result', '--id', f.id, '--run', current.runId).stdout.toString());
  expect(result).toMatchObject({ runId: current.runId, userMessageId: 'user-new', state: 'cancelled' });
  expect(result.reply).toBeUndefined();
  expect(existsSync(join(f.stateRoot, 'cancel', f.id + '.json'))).toBe(false);
});
