// 测试用 jinnang 替身：记录收到的参数，并按 __probe 的 URL 从 FAKE_BUCKET 返回核对结果。
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
appendFileSync(process.env.FAKE_JINNANG_LOG!, JSON.stringify(argv) + '\n');
if (argv[0] !== 'run' || !argv.includes('--')) {
  console.error('fake jinnang: expected run ... -- <command>');
  process.exit(2);
}
const cmd = argv.slice(argv.indexOf('--') + 1);
const url = new URL(cmd.at(-1)!);
const key = url.pathname.slice(1).split('/').map(decodeURIComponent).join('/');
const file = join(process.env.FAKE_BUCKET!, ...key.split('/'));
const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.png': 'image/png' };
if (!existsSync(file)) {
  console.log(JSON.stringify({ status: 404, type: null, md5: '' }));
} else {
  const ext = key.slice(key.lastIndexOf('.'));
  console.log(JSON.stringify({ status: 200, type: types[ext] ?? 'application/octet-stream', md5: new Bun.CryptoHasher('md5').update(readFileSync(file)).digest('hex') }));
}
