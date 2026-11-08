#!/usr/bin/env bun
// 把本地 HTML（含其引用的本地资源）发布到 R2 公网链接，并登记供收尾回收。对象读写一律经 cf CLI。
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const env = process.env;
const LEDGER = join(env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'r2-share/ledger.jsonl');
// 唯一的配置：本机文件，不随技能分发，不含凭据；R2_SHARE_CONFIG 可指定其他文件
const CONFIG_FILE = env.R2_SHARE_CONFIG || join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'r2-share/config.json');
const CONFIG_FORMAT = '{"account": "<Cloudflare 账户 ID>", "bucket": "<桶名>", "domain": "<桶已启用的自定义域名>", "profile": "<cf 登录 profile，可省略，默认 default>"}';
export type Config = { profile: string; account: string; bucket: string; domain: string; ledger: string };
export type Exec = (cmd: string[]) => { code: number; out: string; err: string };
export type Deps = { config: Config; exec: Exec; fetch: (url: string, init?: RequestInit) => Promise<Response>; now: () => Date };
export type UploadRecord = {
  op: 'upload'; at: string; task: string; releaseWhen: string; account: string; bucket: string;
  key: string; url: string; entry: string; source: string; md5: string; size: number; contentType: string;
};
type DeleteRecord = { op: 'delete'; at: string; task: string; account: string; bucket: string; key: string; result: 'deleted' | 'absent' };

class UsageError extends Error {}
class OpError extends Error {}

const USAGE = [
  'bun share.ts upload --file <html> --task <任务> [--name <名称>] [--release-when <释放条件>]',
  'bun share.ts list [--task <任务>]',
  'bun share.ts remove --task <任务> [--key <对象 key>]...',
].join('\n');
const DEFAULT_RELEASE = '用户不再需要该链接';
const MAX_SIZE = 300 * 1024 * 1024; // cf upload 端点上限
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.har': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.avif': 'image/avif', '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm',
};

const text = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0;

function loadConfig(): Config {
  let raw: any;
  try { raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')); }
  catch (e) { throw new UsageError(`读取本机配置失败: ${CONFIG_FILE}（${(e as Error).message}）。按此格式写入，不含凭据: ${CONFIG_FORMAT}`); }
  const bad = ['account', 'bucket', 'domain'].filter(k => !text(raw?.[k]));
  if (raw?.profile !== undefined && !text(raw.profile)) bad.push('profile');
  if (text(raw?.domain) && /[\/:]/.test(raw.domain)) bad.push('domain（只写主机名）');
  if (bad.length) throw new UsageError(`本机配置 ${CONFIG_FILE} 缺少或无效字段: ${bad.join(', ')}。格式: ${CONFIG_FORMAT}`);
  return { profile: raw.profile ?? 'default', account: raw.account, bucket: raw.bucket, domain: raw.domain, ledger: LEDGER };
}
const isFile = (p: string) => existsSync(p) && statSync(p).isFile();
const isHtml = (p: string) => /\.html?$/i.test(p);
const md5 = (data: ArrayBuffer | Uint8Array) => new Bun.CryptoHasher('md5').update(data).digest('hex');
const sameType = (a: string | null, b: string) => (a ?? '').replace(/\s+/g, '').toLowerCase() === b.replace(/\s+/g, '').toLowerCase();
const typeOf = (p: string) => TYPES[extname(p).toLowerCase()] ?? 'application/octet-stream';
const shanghaiDate = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
export const publicUrl = (c: Config, key: string) => `https://${c.domain}/${key.split('/').map(encodeURIComponent).join('/')}`;

// 页面在 <工作区根>/reports/ 下时，以工作区根为根，报告对 evidence/ 的相对引用在线上保持可用；否则以页面所在目录为根
function rootOf(html: string) {
  for (let d = dirname(html); dirname(d) !== d; d = dirname(d)) if (basename(d) === 'reports') return dirname(d);
  return dirname(html);
}

// 收集页面及其递归引用的本地文件；引用只能落在根内，且不含隐藏路径段
function collect(html: string, root: string): string[] {
  const files = [html], problems: string[] = [];
  for (let i = 0; i < files.length; i++) {
    if (!isHtml(files[i])) continue;
    const page = files[i], source = readFileSync(page, 'utf8');
    for (const m of source.matchAll(/\b(?:src|href|poster)\s*=\s*(["'])(.*?)\1/gis)) {
      const raw = m[2].trim().replace(/&amp;/g, '&');
      if (!raw || raw.startsWith('#') || raw.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(raw)) continue;
      const at = `${relative(root, page) || basename(page)} 引用 ${raw}`;
      if (raw.startsWith('/')) { problems.push(`${at}：绝对路径无法随页面发布`); continue; }
      let path: string;
      try { path = resolve(dirname(page), decodeURIComponent(raw.replace(/[?#].*$/s, ''))); }
      catch { problems.push(`${at}：无法解码`); continue; }
      const rel = relative(root, path);
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) { problems.push(`${at}：超出发布根 ${root}`); continue; }
      if (rel.split(sep).some(s => s.startsWith('.'))) { problems.push(`${at}：不发布隐藏路径`); continue; }
      if (!isFile(path)) { problems.push(`${at}：文件不存在`); continue; }
      const real = relative(realpathSync(root), realpathSync(path));
      if (real.startsWith('..') || isAbsolute(real)) { problems.push(`${at}：经符号链接指向发布根之外`); continue; }
      if (!files.includes(path)) files.push(path);
    }
  }
  if (problems.length) throw new UsageError(problems.join('\n'));
  return files;
}

// 单文件放在 <日期>/<文件名>；带资源时放在 <日期>/<名称>/ 下并保留相对根的目录结构
function plan(file: string, date: string, name?: string) {
  const html = resolve(file);
  if (!isFile(html) || !isHtml(html)) throw new UsageError(`--file 须为存在的 .html 文件: ${file}`);
  if (name !== undefined && (!text(name) || /[\/\\\x00-\x1f]/.test(name) || name.startsWith('.'))) throw new UsageError(`--name 须为不含斜杠、不以 . 开头的名称: ${name}`);
  const root = rootOf(html), files = collect(html, root);
  if (files.length === 1) return [{ file: html, key: `${date}/${name ?? basename(html)}` }];
  const stem = basename(html, extname(html));
  const prefix = `${date}/${name ?? (/^(report|index)$/i.test(stem) ? basename(dirname(html)) : stem)}`;
  return files.map(f => ({ file: f, key: `${prefix}/${relative(root, f).split(sep).join('/')}` }));
}

function readLedger(ledger: string): (UploadRecord | DeleteRecord)[] {
  if (!existsSync(ledger)) return [];
  return readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((line, i) => {
    try { return JSON.parse(line); } catch { throw new OpError(`登记文件第 ${i + 1} 行无法解析: ${ledger}`); }
  });
}
// 追加写：并行任务各自追加一行，不读改写整个文件
function appendLedger(c: Config, record: UploadRecord | DeleteRecord) {
  mkdirSync(dirname(c.ledger), { recursive: true });
  appendFileSync(c.ledger, JSON.stringify(record) + '\n');
}
// 已上传且尚未删除的对象
export function active(ledger: string): UploadRecord[] {
  const live = new Map<string, UploadRecord>();
  for (const r of readLedger(ledger)) {
    const id = `${r.account}/${r.bucket}/${r.key}`;
    if (r.op === 'upload') live.set(id, r); else live.delete(id);
  }
  return [...live.values()];
}

const cfArgs = (c: Config, op: string, key: string | undefined, extra: string[]) =>
  ['cf', 'r2', 'buckets', 'objects', op, ...(key === undefined ? [] : [key]), '--bucket-name', c.bucket, '--profile', c.profile, ...extra];

function remote(d: Deps, key: string): { etag: string; size: number } | null {
  const r = d.exec(cfArgs(d.config, 'list', undefined, ['--prefix', key]));
  if (r.code !== 0) throw new OpError(`cf 列出对象失败: ${r.err.trim() || r.out.trim()}`);
  let items: any;
  try { items = JSON.parse(r.out); } catch { throw new OpError(`cf 列出对象的输出无法解析: ${r.out.slice(0, 200)}`); }
  if (!Array.isArray(items)) throw new OpError('cf 列出对象的输出不是数组');
  return items.find(o => o?.key === key) ?? null;
}

// 写操作：完整参数 --dry-run 核对账户、桶和 key，原样去掉 --dry-run 执行一次；失败不重试。
// cf 退出码 0 不代表已生效（如删除缺 --force 时打印 Aborted 仍返回 0），结果由调用方重新列出对象确认
function write(d: Deps, op: 'upload' | 'delete', key: string, extra: string[]) {
  const c = d.config, args = cfArgs(c, op, key, extra);
  const dry = d.exec([...args, '--dry-run']);
  if (dry.code !== 0) throw new OpError(`cf ${op} 预演失败: ${dry.err.trim() || dry.out.trim()}`);
  let plan: any;
  try { plan = JSON.parse(dry.out); } catch { throw new OpError(`cf ${op} 预演输出无法解析: ${dry.out.slice(0, 200)}`); }
  const base = `https://api.cloudflare.com/client/v4/accounts/${c.account}/r2/buckets/${c.bucket}/objects/`;
  const url = String(plan?.url ?? '');
  let target = '';
  try { target = url.startsWith(base) ? decodeURIComponent(url.slice(base.length)) : ''; } catch {}
  if (target !== key || plan?.pathParams?.['bucket-name'] !== c.bucket || plan?.pathParams?.['object-key'] !== key)
    throw new OpError(`cf ${op} 预演目标与预期不符，未执行。预期账户 ${c.account}、桶 ${c.bucket}、key ${key}，实际 ${url}`);
  const real = d.exec(args);
  if (real.code !== 0) throw new OpError(`cf ${op} 执行失败（未重试）: ${key}: ${real.err.trim() || real.out.trim()}`);
}

// 带一次性查询参数绕过边缘缓存，读到的是对象当前状态
async function probe(d: Deps, url: string) {
  const res = await d.fetch(`${url}?verify=${crypto.randomUUID()}`, { redirect: 'manual' });
  return { status: res.status, type: res.headers.get('content-type'), md5: md5(await res.arrayBuffer()) };
}

export async function upload(d: Deps, o: { file: string; task: string; name?: string; releaseWhen?: string }) {
  const c = d.config;
  if (!text(o.task)) throw new UsageError('--task 必填：写本任务名，收尾按它回收');
  const items = plan(o.file, shanghaiDate(d.now()), o.name).map(p => ({ ...p, size: statSync(p.file).size, type: typeOf(p.file) }));
  for (const it of items) if (it.size > MAX_SIZE) throw new UsageError(`文件超过 300 MB 上传上限: ${it.file}`);
  const taken = items.filter(it => remote(d, it.key));
  if (taken.length) throw new UsageError(`对象已存在，不覆盖：${taken.map(t => t.key).join(', ')}；用 --name 换一个名称`);
  const entry = items[0].key, uploaded: { key: string; url: string; size: number }[] = [];
  // 先传资源后传页面，页面可访问时资源已就位
  for (const it of [...items.slice(1), items[0]]) {
    const url = publicUrl(c, it.key), sum = md5(readFileSync(it.file));
    try {
      write(d, 'upload', it.key, ['--file', it.file, '--content-type', it.type]);
    } catch (e) {
      throw new OpError(`${(e as Error).message}${uploaded.length ? `\n已上传并登记 ${uploaded.length} 个对象，用 remove --task ${o.task} 回收` : ''}`);
    }
    const stored = remote(d, it.key);
    if (!stored) throw new OpError(`cf upload 返回成功，但桶内没有该对象，未登记: ${it.key}`);
    // 登记桶内实际 etag，回收时按它确认对象仍是本次上传的
    appendLedger(c, { op: 'upload', at: d.now().toISOString(), task: o.task, releaseWhen: text(o.releaseWhen) ? o.releaseWhen : DEFAULT_RELEASE,
      account: c.account, bucket: c.bucket, key: it.key, url, entry, source: it.file, md5: stored.etag, size: it.size, contentType: it.type });
    uploaded.push({ key: it.key, url, size: it.size });
    const got = await probe(d, url);
    if (stored.etag !== sum || got.status !== 200 || !sameType(got.type, it.type) || got.md5 !== sum)
      throw new OpError(`上传后核对失败（对象已登记）: ${url} etag ${stored.etag}、状态 ${got.status}、类型 ${got.type}、MD5 ${got.md5}，预期 ${sum}、200、${it.type}、${sum}`);
  }
  return { url: publicUrl(c, entry), task: o.task, objects: uploaded, ledger: c.ledger };
}

export async function remove(d: Deps, o: { task: string; keys: string[] }) {
  const c = d.config;
  if (!text(o.task)) throw new UsageError('--task 必填：只回收登记在该任务名下的对象');
  const mine = active(c.ledger).filter(r => r.account === c.account && r.bucket === c.bucket && r.task === o.task);
  const unknown = o.keys.filter(k => !mine.some(r => r.key === k || r.entry === k));
  if (unknown.length) throw new UsageError(`未登记在任务 ${o.task} 名下或已删除，不处理：${unknown.join(', ')}`);
  const targets = mine.filter(r => !o.keys.length || o.keys.includes(r.key) || o.keys.includes(r.entry))
    .sort((a, b) => Number(b.key === b.entry) - Number(a.key === a.entry)); // 先删页面
  const removed: string[] = [], absent: string[] = [], refused: { key: string; reason: string }[] = [];
  for (const r of targets) {
    const now = remote(d, r.key);
    const done = (result: DeleteRecord['result']) => appendLedger(c, { op: 'delete', at: d.now().toISOString(), task: o.task, account: c.account, bucket: c.bucket, key: r.key, result });
    if (!now) { done('absent'); absent.push(r.key); continue; }
    if (now.etag !== r.md5) { refused.push({ key: r.key, reason: `远端 etag ${now.etag} 与登记 MD5 ${r.md5} 不同，对象已被改写，归属不明` }); continue; }
    write(d, 'delete', r.key, ['--force']); // 非交互下不加 --force，cf 会放弃删除
    if (remote(d, r.key)) throw new OpError(`cf delete 返回成功，但对象仍在桶内，未更新登记: ${r.key}`);
    done('deleted');
    removed.push(r.key);
    const got = await probe(d, r.url);
    if (got.status !== 404) throw new OpError(`删除后核对失败: ${r.url} 返回 ${got.status}，预期 404`);
  }
  return { task: o.task, removed, absent, refused, ledger: c.ledger };
}

function args(argv: string[]) {
  const named = new Map<string, string[]>();
  for (let i = 1; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) throw new UsageError(`参数无效: ${argv[i]}`);
    named.set(argv[i], [...(named.get(argv[i]) ?? []), argv[i + 1]]);
  }
  return { one: (k: string) => named.get(k)?.at(-1), all: (k: string) => named.get(k) ?? [] };
}

// cf 会在工作目录写 .cloudflare/ 缓存并读取项目配置，固定在登记目录下运行，不落进仓库或受项目配置影响
const defaultExec: Exec = cmd => {
  try {
    mkdirSync(dirname(LEDGER), { recursive: true });
    const r = Bun.spawnSync({ cmd, cwd: dirname(LEDGER), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  } catch (e) { return { code: 127, out: '', err: (e as Error).message }; }
};

async function main(argv: string[]) {
  const deps = (): Deps => ({ config: loadConfig(), exec: defaultExec, fetch: (u, i) => fetch(u, i), now: () => new Date() });
  try {
    const a = args(argv);
    let result: unknown, code = 0;
    if (argv[0] === 'upload') result = await upload(deps(), { file: a.one('--file') ?? '', task: a.one('--task') ?? '', name: a.one('--name'), releaseWhen: a.one('--release-when') });
    else if (argv[0] === 'remove') {
      const r = await remove(deps(), { task: a.one('--task') ?? '', keys: a.all('--key') });
      result = r; code = r.refused.length ? 1 : 0;
    } else if (argv[0] === 'list') {
      const task = a.one('--task');
      result = { ledger: LEDGER, objects: active(LEDGER).filter(r => !task || r.task === task) };
    } else throw new UsageError('未知子命令');
    console.log(JSON.stringify(result, null, 2));
    return code;
  } catch (e) {
    const usage = e instanceof UsageError;
    console.error(JSON.stringify({ error: usage ? 'usage' : 'failed', message: (e as Error).message, ...(usage ? { usage: USAGE } : {}) }));
    return usage ? 2 : 1;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
