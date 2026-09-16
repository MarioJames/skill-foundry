import { createHash } from 'node:crypto';
import { command, required } from './command.ts';
import { PAGE_SCRIPT, type PageState } from './page.ts';

function endpoint(value: string) {
  if (/^\d+$/.test(value) && +value > 0 && +value < 65536) return value;
  const u = new URL(value);
  if (!['http:', 'ws:'].includes(u.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || u.username || u.password) throw new Error('CDP must use an unauthenticated loopback endpoint');
  return value;
}
export async function browser(id: string, opts: Record<string, string>) {
  const cdp = endpoint(required(opts, 'cdp'));
  const target = required(opts, 'target');
  if (!/^[a-zA-Z0-9-]+$/.test(target)) throw new Error('Invalid CDP target id');
  // The session key includes the target: a restarted browser must not reuse an old pin.
  const session = 'review-' + createHash('sha256').update(id + ':' + target).digest('hex').slice(0, 16);
  const prefix = ['agent-browser', '--session', session, '--cdp', cdp, '--pin-tab', '--idle-timeout', '5m', '--json'];
  const run = async (...a: string[]) => {
    const result = JSON.parse(await command([...prefix, ...a]));
    if (!result.success) throw new Error(JSON.stringify(result.error || result.data).slice(0, 800));
    return result.data;
  };
  await run('tab', target);
  return { session, run, read: async (): Promise<PageState> => {
    const data = await run('eval', PAGE_SCRIPT);
    const value = data.result;
    if (!value || !Array.isArray(value.messages) || typeof value.url !== 'string') throw new Error('Unexpected agent-browser eval response');
    return value;
  } };
}
