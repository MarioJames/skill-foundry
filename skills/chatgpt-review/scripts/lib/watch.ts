import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { browser } from './browser.ts';
import { command, required } from './command.ts';
import { classify, type Outcome } from './page.ts';
import { Store, privateWrite, type WatchStatus, type WatchState } from './store.ts';

export const POLL_MS = 60_000;
const now = () => new Date().toISOString();
async function notify(opts: Record<string, string>, id: string, runId: string, status: string, path: string) {
  if (!opts['notify-pane']) return { delivered: false, reason: 'No originating pane supplied' };
  const note = `ChatGPT 后台任务 ${id}（runId=${runId}）已结束，状态 ${status}。结果文件：${path}。请用 result --id ${id} --run ${runId} 核对当前轮次后继续原需求；不要重新发送原提示。`;
  const results = await Promise.allSettled([
    command(['herdr', 'agent', 'prompt', opts['notify-pane'], note]),
    command(['herdr', 'notification', 'show', `ChatGPT: ${id}`, '--body', status, '--sound', 'done']),
  ]);
  return { delivered: results[0].status === 'fulfilled', desktop: results[1].status === 'fulfilled', errors: results.filter(r => r.status === 'rejected').map(r => String((r as PromiseRejectedResult).reason)) };
}
export async function watch(store: Store, opts: Record<string, string>) {
  const id = required(opts, 'id');
  const record = store.get(id);
  const userId = required(opts, 'user');
  const seconds = Number(opts['timeout-seconds'] || 1800);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('Invalid timeout');
  const runId = randomUUID();
  const release = store.lock(id, runId);
  const cancelPath = store.path('cancel', id);
  const started = Date.now();
  const statusPath = store.path('watch', id);
  let stopped = false;
  const stop = () => { stopped = true; };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  let attached: Awaited<ReturnType<typeof browser>> | undefined;
  let failures = 0;
  let checks = 0;
  const dataFor = (state: WatchState, extra: Partial<WatchStatus> = {}): WatchStatus =>
    ({ id, runId, userMessageId: userId, state, pid: process.pid, checkedAt: now(), intervalSeconds: 60, checks, ...extra });
  const emit = (data: WatchStatus) => {
    privateWrite(statusPath, data);
    console.log(JSON.stringify(data));
    return data;
  };
  const cancelled = () => existsSync(cancelPath) && JSON.parse(readFileSync(cancelPath, 'utf8')).runId === runId;
  try {
    emit(dataFor('starting'));
    while (true) {
      let outcome: Outcome | { state: 'timeout' | 'cancelled'; reason: string };
      if (stopped || cancelled()) outcome = { state: 'cancelled', reason: 'Monitor cancelled; remote generation was not stopped' };
      else if (Date.now() - started >= seconds * 1000) outcome = { state: 'timeout', reason: 'Monitoring deadline elapsed; remote generation may continue' };
      else {
        try {
          attached ||= await browser(id, opts);
          checks++;
          outcome = classify(await attached.read(), record.url, userId);
          failures = 0;
        } catch (error) {
          failures++;
          const reason = String(error).slice(0, 1000);
          outcome = { state: failures >= 3 || /tab_gone|closed|Conversation changed/i.test(reason) ? 'blocked' : 'waiting', reason };
        }
      }
      const data = dataFor(outcome.state, { reason: outcome.reason, browserSession: attached?.session });
      if (outcome.state !== 'waiting') {
        const resultPath = store.resultPath(id, runId);
        privateWrite(resultPath, { ...data, conversationUrl: record.url, ...(outcome.state === 'complete' ? { reply: outcome.reply } : {}) });
        // Publish terminal status only after its own result exists.
        emit({ ...data, resultPath });
        const notification = await notify(opts, id, runId, outcome.state, resultPath);
        privateWrite(statusPath, { ...data, resultPath, notification });
        return outcome.state === 'complete' ? 0 : 2;
      }
      emit(data);
      await Bun.sleep(Math.min(POLL_MS, Math.max(1, seconds * 1000 - (Date.now() - started))));
    }
  } finally {
    process.off('SIGTERM', stop); process.off('SIGINT', stop);
    try { if (cancelled()) unlinkSync(cancelPath); }
    finally { release(); }
  }
}
