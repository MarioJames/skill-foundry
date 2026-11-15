// 测试用 cf 替身：在 FAKE_BUCKET 目录里模拟 R2 对象，支持 list/upload/delete 与 --dry-run。
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const argv = process.argv.slice(2);
const root = process.env.FAKE_BUCKET!;
const account = process.env.FAKE_ACCOUNT!;
const flag = (name: string) => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1]; };
const op = argv[3];
const key = argv[4] && !argv[4].startsWith('--') ? argv[4] : undefined;
const fileOf = (k: string) => join(root, ...k.split('/'));
const walk = (dir: string): string[] => existsSync(dir)
  ? readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])
  : [];
const md5 = (path: string) => new Bun.CryptoHasher('md5').update(readFileSync(path)).digest('hex');

if (op === 'list') {
  const prefix = flag('--prefix') ?? '';
  const items = walk(root).map(path => ({ key: relative(root, path).split('\\').join('/'), etag: md5(path), size: statSync(path).size }));
  console.log(JSON.stringify(items.filter(item => item.key.startsWith(prefix))));
} else if (argv.includes('--dry-run')) {
  const bucket = flag('--bucket-name');
  console.log(JSON.stringify({
    url: `https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/${bucket}/objects/${encodeURIComponent(key!)}`,
    pathParams: { 'bucket-name': bucket, 'object-key': key },
  }));
} else if (op === 'upload') {
  mkdirSync(dirname(fileOf(key!)), { recursive: true });
  writeFileSync(fileOf(key!), readFileSync(flag('--file')!));
} else if (op === 'delete') {
  // 与真实 cf 一致：非交互删除缺 --force 时放弃，但退出码仍为 0
  if (!argv.includes('--force')) console.log('Aborted.');
  else rmSync(fileOf(key!), { force: true });
}
