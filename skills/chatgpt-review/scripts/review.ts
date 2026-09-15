#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { Store } from './lib/store.ts';
import { conversationId } from './lib/page.ts';
import { browser } from './lib/browser.ts';
import { required } from './lib/command.ts';
import { watch } from './lib/watch.ts';

function args(raw: string[]) {
  const opts: Record<string, string> = {};
  for (let i = 0; i < raw.length; i += 2) {
    if (!raw[i].startsWith('--') || raw[i + 1] === undefined) throw new Error('Expected --option value');
    opts[raw[i].slice(2)] = raw[i + 1];
  }
  return opts;
}
export async function main(raw = process.argv.slice(2)) {
  const [cmd, ...rest] = raw;
  const store = new Store();
  if (!cmd || cmd === '--help') {
    console.log('review.ts record --input FILE | list [QUERY] | show --id ID | status/result/cancel --id ID [--run RUN_ID] | capture --id ID --cdp PORT --target TARGET | watch --id ID --cdp PORT --target TARGET --user MESSAGE_ID [--notify-pane PANE] [--timeout-seconds 1800]');
    return 0;
  }
  if (cmd === 'list') { console.log(JSON.stringify(store.list(rest.join(' ')), null, 2)); return 0; }
  const opts = args(rest);
  if (cmd === 'record') { console.log(JSON.stringify(store.record(JSON.parse(readFileSync(required(opts, 'input'), 'utf8'))), null, 2)); return 0; }
  const id = required(opts, 'id');
  if (cmd === 'show') console.log(JSON.stringify(store.get(id), null, 2));
  else if (cmd === 'status') console.log(JSON.stringify(store.status(id, opts.run), null, 2));
  else if (cmd === 'result') console.log(JSON.stringify(store.result(id, opts.run), null, 2));
  else if (cmd === 'cancel') {
    store.cancel(id, opts.run);
    console.log('Monitor cancellation requested; browser and remote response are preserved');
  } else if (cmd === 'capture') {
    const record = store.get(id);
    const b = await browser(id, opts);
    const page = await b.read();
    if (conversationId(page.url) !== conversationId(record.url)) throw new Error('Wrong conversation');
    console.log(JSON.stringify({ session: b.session, url: page.url, generating: page.generating, blocked: page.blocked, messages: page.messages.map(({ text, ...m }) => m) }, null, 2));
  } else if (cmd === 'watch') return await watch(store, opts);
  else throw new Error('Unknown command');
  return 0;
}
if (import.meta.main) {
  try { process.exitCode = await main(); }
  catch (error) { console.error(String(error)); process.exitCode = 1; }
}
