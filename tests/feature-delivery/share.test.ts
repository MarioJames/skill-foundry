import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { active, publicUrl, remove, upload, type Config, type Deps } from '../../skills/feature-delivery/scripts/share';

const CLI = join(import.meta.dir, '../../skills/feature-delivery/scripts/share.ts');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const ACCOUNT = 'acc123';
// 2026-11-07T20:00Z 在上海已是 11-08
const NOW = new Date('2026-11-07T20:00:00Z');

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'feature-delivery-share-')); dirs.push(root);
  mkdirSync(join(root, 'reports/orders-1108'), { recursive: true }); mkdirSync(join(root, 'evidence/orders'), { recursive: true });
  const config: Config = { profile: 'p', account: ACCOUNT, bucket: 'b', domain: 'share.example', ledger: join(root, 'state/ledger.jsonl') };
  return { root, config };
}

// 内存中的桶：cf 命令和公网读取都落在它上面
function fakeCloud(config: Config, opts: { planAccount?: string; failUpload?: boolean; dropUpload?: boolean } = {}) {
  const bucket = new Map<string, { body: Uint8Array; type: string }>();
  const calls: string[][] = [];
  const flag = (cmd: string[], name: string) => cmd[cmd.indexOf(name) + 1];
  const exec = (cmd: string[]) => {
    calls.push(cmd);
    const [, , , , op, key] = cmd, dry = cmd.includes('--dry-run');
    if (op === 'list') {
      const prefix = flag(cmd, '--prefix');
      const items = [...bucket].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => ({ key: k, etag: new Bun.CryptoHasher('md5').update(v.body).digest('hex'), size: v.body.length }));
      return { code: 0, out: JSON.stringify(items), err: '' };
    }
    if (dry) {
      const url = `https://api.cloudflare.com/client/v4/accounts/${opts.planAccount ?? ACCOUNT}/r2/buckets/${flag(cmd, '--bucket-name')}/objects/${encodeURIComponent(key)}`;
      return { code: 0, out: JSON.stringify({ url, pathParams: { 'bucket-name': flag(cmd, '--bucket-name'), 'object-key': key } }), err: '' };
    }
    if (op === 'upload') {
      if (opts.failUpload) return { code: 1, out: '', err: 'HTTP 500' };
      if (opts.dropUpload) return { code: 0, out: '{}', err: '' };
      bucket.set(key, { body: readFileSync(flag(cmd, '--file')), type: flag(cmd, '--content-type') });
    }
    // 与真实 cf 一致：非交互删除缺 --force 时放弃，但退出码仍为 0
    if (op === 'delete' && !cmd.includes('--force')) return { code: 0, out: 'Aborted.', err: '' };
    if (op === 'delete') bucket.delete(key);
    return { code: 0, out: '{}', err: '' };
  };
  const fetch = async (url: string) => {
    const u = new URL(url);
    const key = u.pathname.slice(1).split('/').map(decodeURIComponent).join('/');
    const hit = bucket.get(key);
    return hit ? new Response(hit.body, { status: 200, headers: { 'content-type': hit.type } }) : new Response('not found', { status: 404 });
  };
  const deps: Deps = { config, exec, fetch, now: () => NOW };
  const writes = () => calls.filter(c => (c[4] === 'upload' || c[4] === 'delete') && !c.includes('--dry-run'));
  return { bucket, calls, deps, writes };
}

describe('R2 分享上传与回收', () => {
  test('缺本机配置或字段无效时拒绝并给出格式，list 不需要配置', () => {
    const { root } = workspace();
    const cli = (args: string[], config: string) => Bun.spawnSync({ cmd: [process.execPath, join(import.meta.dir, '../../skills/feature-delivery/scripts/share.ts'), ...args],
      env: { ...process.env, R2_SHARE_CONFIG: config, XDG_STATE_HOME: join(root, 'state') }, stdout: 'pipe', stderr: 'pipe' });
    writeFileSync(join(root, 'reports/a.html'), '<p>a</p>');
    const missing = cli(['upload', '--file', join(root, 'reports/a.html'), '--task', 't'], join(root, 'none.json'));
    expect(missing.exitCode).toBe(2);
    expect(JSON.parse(missing.stderr.toString()).message).toContain('"account"');
    writeFileSync(join(root, 'config.json'), JSON.stringify({ account: 'a', bucket: 'b', domain: 'https://x.example' }));
    const invalid = cli(['remove', '--task', 't'], join(root, 'config.json'));
    expect(invalid.exitCode).toBe(2);
    expect(JSON.parse(invalid.stderr.toString()).message).toContain('domain（只写主机名）');
    const list = cli(['list'], join(root, 'none.json'));
    expect(list.exitCode).toBe(0);
    expect(JSON.parse(list.stdout.toString()).objects).toEqual([]);
  });

  test('单文件按上海日期分目录上传，每次写入先以相同参数预演，核对后登记', async () => {
    const { root, config } = workspace();
    writeFileSync(join(root, 'reports/1108-设计.html'), '<html><a href="https://example.com">外链</a><a href="#a">锚点</a></html>');
    const cloud = fakeCloud(config);
    const r = await upload(cloud.deps, { file: join(root, 'reports/1108-设计.html'), task: 'orders' });
    expect(r.url).toBe('https://share.example/2026-11-08/1108-%E8%AE%BE%E8%AE%A1.html');
    const [real] = cloud.writes();
    const dry = cloud.calls.find(c => c.includes('--dry-run'))!;
    expect(dry.filter(x => x !== '--dry-run')).toEqual(real);
    expect(real).toContain('--profile');
    expect([...cloud.bucket.keys()]).toEqual(['2026-11-08/1108-设计.html']);
    const [rec] = active(config.ledger);
    expect(rec).toMatchObject({ task: 'orders', key: '2026-11-08/1108-设计.html', url: r.url, source: join(root, 'reports/1108-设计.html'), contentType: 'text/html; charset=utf-8' });
  });

  test('报告引用的设计文档和证据一起发布，线上相对路径保持可用', async () => {
    const { root, config } = workspace();
    writeFileSync(join(root, 'evidence/orders/空 态.png'), 'png');
    writeFileSync(join(root, 'reports/1108-orders.html'), '<table><tr data-check-id="A1"></tr></table>');
    writeFileSync(join(root, 'reports/orders-1108/REPORT.html'),
      `<a href="../1108-orders.html">清单</a><a class="ev" href="../../evidence/orders/${encodeURIComponent('空 态.png')}"><img src="../../evidence/orders/${encodeURIComponent('空 态.png')}"></a>`);
    const cloud = fakeCloud(config);
    const r = await upload(cloud.deps, { file: join(root, 'reports/orders-1108/REPORT.html'), task: 'orders' });
    expect([...cloud.bucket.keys()].sort()).toEqual([
      '2026-11-08/orders-1108/evidence/orders/空 态.png',
      '2026-11-08/orders-1108/reports/1108-orders.html',
      '2026-11-08/orders-1108/reports/orders-1108/REPORT.html',
    ]);
    expect(r.url).toBe(publicUrl(config, '2026-11-08/orders-1108/reports/orders-1108/REPORT.html'));
    expect(new URL('../../evidence/orders/%E7%A9%BA%20%E6%80%81.png', r.url).href).toBe(publicUrl(config, '2026-11-08/orders-1108/evidence/orders/空 态.png'));
    expect(cloud.bucket.get('2026-11-08/orders-1108/evidence/orders/空 态.png')!.type).toBe('image/png');
  });

  test('引用越出发布根、指向隐藏文件或不存在时拒绝，不发起任何 cf 调用', async () => {
    const { root, config } = workspace();
    const outside = mkdtempSync(join(tmpdir(), 'feature-delivery-share-out-')); dirs.push(outside);
    writeFileSync(join(outside, 'secret.txt'), 'x'); symlinkSync(join(outside, 'secret.txt'), join(root, 'reports/link.txt'));
    writeFileSync(join(root, 'reports/bad.html'), '<a href="../../outside.txt"></a><img src="../.env"><img src="missing.png"><img src="/etc/hosts"><img src="link.txt">');
    const cloud = fakeCloud(config);
    const err = await upload(cloud.deps, { file: join(root, 'reports/bad.html'), task: 't' }).catch(e => e);
    expect(err.message).toContain('超出发布根');
    expect(err.message).toContain('隐藏路径');
    expect(err.message).toContain('不存在');
    expect(err.message).toContain('绝对路径');
    expect(err.message).toContain('符号链接');
    expect(cloud.calls).toEqual([]);
  });

  test('同名对象已存在时不覆盖', async () => {
    const { root, config } = workspace();
    writeFileSync(join(root, 'reports/a.html'), '<p>new</p>');
    const cloud = fakeCloud(config);
    cloud.bucket.set('2026-11-08/a.html', { body: new TextEncoder().encode('old'), type: 'text/html' });
    const err = await upload(cloud.deps, { file: join(root, 'reports/a.html'), task: 't' }).catch(e => e);
    expect(err.message).toContain('不覆盖');
    expect(cloud.writes()).toEqual([]);
    expect(new TextDecoder().decode(cloud.bucket.get('2026-11-08/a.html')!.body)).toBe('old');
  });

  test('预演指向其他账户时不执行；执行失败不重试，未实际写入时不登记', async () => {
    const { root, config } = workspace();
    writeFileSync(join(root, 'reports/a.html'), '<p>a</p>');
    const wrong = fakeCloud(config, { planAccount: 'other' });
    expect((await upload(wrong.deps, { file: join(root, 'reports/a.html'), task: 't' }).catch(e => e)).message).toContain('预演目标与预期不符');
    expect(wrong.writes()).toEqual([]);
    const failing = fakeCloud(config, { failUpload: true });
    expect((await upload(failing.deps, { file: join(root, 'reports/a.html'), task: 't' }).catch(e => e)).message).toContain('未重试');
    expect(failing.writes().length).toBe(1);
    const dropped = fakeCloud(config, { dropUpload: true });
    expect((await upload(dropped.deps, { file: join(root, 'reports/a.html'), task: 't' }).catch(e => e)).message).toContain('桶内没有该对象');
    expect(active(config.ledger)).toEqual([]);
  });

  test('回收只删本任务登记且未被改写的对象，删除后核对 404 并更新登记', async () => {
    const { root, config } = workspace();
    writeFileSync(join(root, 'reports/a.html'), '<p>a</p>'); writeFileSync(join(root, 'reports/b.html'), '<p>b</p>');
    writeFileSync(join(root, 'reports/c.html'), '<p>c</p>');
    const cloud = fakeCloud(config);
    await upload(cloud.deps, { file: join(root, 'reports/a.html'), task: 'mine' });
    await upload(cloud.deps, { file: join(root, 'reports/c.html'), task: 'mine' });
    await upload(cloud.deps, { file: join(root, 'reports/b.html'), task: 'other' });
    cloud.bucket.set('2026-11-08/c.html', { body: new TextEncoder().encode('rewritten'), type: 'text/html' });
    cloud.bucket.set('2026-11-08/unregistered.html', { body: new TextEncoder().encode('x'), type: 'text/html' });

    expect((await remove(cloud.deps, { task: 'mine', keys: ['2026-11-08/b.html'] }).catch(e => e)).message).toContain('未登记在任务 mine');
    const r = await remove(cloud.deps, { task: 'mine', keys: [] });
    expect(r.removed).toEqual(['2026-11-08/a.html']);
    expect(r.refused.map(x => x.key)).toEqual(['2026-11-08/c.html']);
    expect(cloud.writes().filter(c => c[4] === 'delete').map(c => c[5])).toEqual(['2026-11-08/a.html']);
    expect([...cloud.bucket.keys()].sort()).toEqual(['2026-11-08/b.html', '2026-11-08/c.html', '2026-11-08/unregistered.html']);
    expect(active(config.ledger).map(x => x.key).sort()).toEqual(['2026-11-08/b.html', '2026-11-08/c.html']);
  });

  test('登记的对象已不在桶里时记为 absent，不发删除', async () => {
    const { root, config } = workspace();
    writeFileSync(join(root, 'reports/a.html'), '<p>a</p>');
    const cloud = fakeCloud(config);
    await upload(cloud.deps, { file: join(root, 'reports/a.html'), task: 'mine' });
    cloud.bucket.clear();
    const r = await remove(cloud.deps, { task: 'mine', keys: [] });
    expect(r.absent).toEqual(['2026-11-08/a.html']);
    expect(cloud.writes().filter(c => c[4] === 'delete')).toEqual([]);
    expect(active(config.ledger)).toEqual([]);
  });
});

// 替身 cf / jinnang / weaver 放进 PATH，验证真实子进程参数，不访问 Cloudflare 或 Weaver
function fakeTools(root: string) {
  const bin = join(root, 'bin'), bucket = join(root, 'bucket');
  for (const d of [bin, bucket]) mkdirSync(d, { recursive: true });
  for (const name of ['cf', 'jinnang', 'weaver']) {
    const shim = join(bin, name);
    writeFileSync(shim, `#!/bin/sh\nexec '${process.execPath}' '${join(import.meta.dir, 'fakes', `${name}.ts`)}' "$@"\n`);
    chmodSync(shim, 0o755);
  }
  return { bin, bucket, jinnangLog: join(root, 'jinnang.log'), weaverLog: join(root, 'weaver.log') };
}

function cliEnv(root: string, t: ReturnType<typeof fakeTools>, extra: Record<string, string> = {}) {
  return {
    ...process.env,
    PATH: [t.bin, dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(':'),
    R2_SHARE_CONFIG: join(root, 'config.json'),
    XDG_STATE_HOME: join(root, 'state'),
    FAKE_BUCKET: t.bucket,
    FAKE_ACCOUNT: ACCOUNT,
    FAKE_JINNANG_LOG: t.jinnangLog,
    FAKE_WEAVER_LOG: t.weaverLog,
    ...extra,
  };
}

function runShare(args: string[], env: Record<string, string | undefined>) {
  const r = Bun.spawnSync({ cmd: [process.execPath, CLI, ...args], env, stdout: 'pipe', stderr: 'pipe' });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

// 需要本地 HTTP 服务时用异步启动，避免 spawnSync 阻塞事件循环
async function runShareAsync(args: string[], env: Record<string, string | undefined>) {
  const proc = Bun.spawn({ cmd: [process.execPath, CLI, ...args], env, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out, err };
}

function shareWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'feature-delivery-share-cli-')); dirs.push(root);
  mkdirSync(join(root, 'reports'), { recursive: true });
  writeFileSync(join(root, 'config.json'), JSON.stringify({ account: ACCOUNT, bucket: 'b', domain: 'share.example', accessToken: 'jn://cloudflare/r2-share' }));
  return { root, t: fakeTools(root), file: join(root, 'reports/展示.html') };
}

describe('公开目录、Weaver 登记与 Access 服务令牌', () => {
  test('--public 带资源时整组放在 public/<日期>/ 下', async () => {
    const { root, config } = workspace();
    mkdirSync(join(root, 'evidence/demo'), { recursive: true });
    mkdirSync(join(root, 'reports/demo'), { recursive: true });
    writeFileSync(join(root, 'evidence/demo/首页.png'), 'png');
    writeFileSync(join(root, 'reports/demo/REPORT.html'), `<img src="../../evidence/demo/${encodeURIComponent('首页.png')}">`);
    const cloud = fakeCloud(config);
    const r = await upload(cloud.deps, { file: join(root, 'reports/demo/REPORT.html'), task: 'demo', public: true });
    expect([...cloud.bucket.keys()].sort()).toEqual([
      'public/2026-11-08/demo/evidence/demo/首页.png',
      'public/2026-11-08/demo/reports/demo/REPORT.html',
    ]);
    expect(r.url).toBe('https://share.example/public/2026-11-08/demo/reports/demo/REPORT.html');
    expect(active(config.ledger).every(rec => rec.public === true && rec.key.startsWith('public/'))).toBe(true);
  });

  test('--public 与 --mission：核对经 jinnang 服务令牌，成功后登记入口页', () => {
    const { root, t, file } = shareWorkspace();
    writeFileSync(file, '<p>展示</p>');
    const r = runShare(['upload', '--file', file, '--task', 'task-1', '--mission', 'mis-1', '--public'], cliEnv(root, t));
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out);
    expect(out.url).toMatch(/^https:\/\/share\.example\/public\/\d{4}-\d{2}-\d{2}\/%E5%B1%95%E7%A4%BA\.html$/);
    expect(out.artifact).toEqual({ mission: 'mis-1', file, url: out.url });

    const [record] = readFileSync(join(root, 'state/r2-share/ledger.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(record).toMatchObject({
      task: 'task-1', mission: 'mis-1', public: true, releaseWhen: '永久保留',
      url: out.url, source: file,
    });
    expect(record.key).toMatch(/^public\/\d{4}-\d{2}-\d{2}\/展示\.html$/);
    expect(record.entry).toBe(record.key);

    const weaverArgs = JSON.parse(readFileSync(t.weaverLog, 'utf8').trim());
    expect(weaverArgs).toEqual(['artifact', 'add', '--mission', 'mis-1', '--file', file, '--url', out.url]);

    // 核对请求经 jinnang 子进程，令牌字段名固定，值不在参数里
    const jinnangArgs = JSON.parse(readFileSync(t.jinnangLog, 'utf8').trim());
    expect(jinnangArgs.slice(0, 7)).toEqual(['run', 'jn://cloudflare/r2-share', '--env', 'CF_ACCESS_CLIENT_ID=client_id', '--env', 'CF_ACCESS_CLIENT_SECRET=client_secret', '--']);
    expect(jinnangArgs[7]).toBe(process.execPath);
    expect(jinnangArgs[8]).toMatch(/skills\/feature-delivery\/scripts\/share\.ts$/);
    expect(jinnangArgs[9]).toBe('__probe');
    expect(jinnangArgs[10].startsWith(`${out.url}?verify=`)).toBe(true);
    expect(JSON.stringify(jinnangArgs)).not.toContain('secret-value');
  });

  test('Weaver 登记失败时上传照常返回，并给出补登命令', () => {
    const { root, t, file } = shareWorkspace();
    writeFileSync(file, '<p>展示</p>');
    const r = runShare(['upload', '--file', file, '--task', 'task-2', '--mission', 'mis-2'], cliEnv(root, t, { FAKE_WEAVER_EXIT: '8' }));
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out);
    expect(out.url).toBeTruthy();
    expect(out.artifact).toBeUndefined();
    expect(out.artifactError).toContain('登记到 Weaver 主任务 mis-2 失败');
    expect(out.artifactError).toContain('链接可用');
    expect(out.artifactCommand).toBe(`weaver artifact add --mission 'mis-2' --file '${file}' --url '${out.url}'`);
    expect(active(join(root, 'state/r2-share/ledger.jsonl')).map(rec => rec.mission)).toEqual(['mis-2']);
  });

  test('PATH 里没有 weaver 时同样保留上传结果并给出补登命令', () => {
    const { root, t, file } = shareWorkspace();
    writeFileSync(file, '<p>展示</p>');
    rmSync(join(t.bin, 'weaver'));
    const r = runShare(['upload', '--file', file, '--task', 'task-3', '--mission', 'mis-3'], cliEnv(root, t));
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out);
    expect(out.url).toBeTruthy();
    expect(out.artifactError).toContain('登记到 Weaver 主任务 mis-3 失败');
    expect(out.artifactCommand).toContain(`--mission 'mis-3'`);
  });

  test('删除后的 404 核对同样经过 jinnang', () => {
    const { root, t, file } = shareWorkspace();
    writeFileSync(file, '<p>展示</p>');
    const env = cliEnv(root, t);
    expect(runShare(['upload', '--file', file, '--task', 'task-del'], env).code).toBe(0);
    const before = readFileSync(t.jinnangLog, 'utf8').trim().split('\n').length;
    const r = runShare(['remove', '--task', 'task-del'], env);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).removed).toHaveLength(1);
    const probes = readFileSync(t.jinnangLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(probes).toHaveLength(before + 1);
    expect(probes.at(-1)[9]).toBe('__probe');
  });

  test('未配置 accessToken 时直接请求，不带 Access 头也不调用 jinnang', async () => {
    const { root, config } = workspace();
    writeFileSync(join(root, 'reports/a.html'), '<p>a</p>');
    const cloud = fakeCloud(config);
    const seen: (RequestInit | undefined)[] = [];
    const deps = { ...cloud.deps, fetch: (url: string, init?: RequestInit) => { seen.push(init); return cloud.deps.fetch(url, init); } };
    await upload(deps, { file: join(root, 'reports/a.html'), task: 't' });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers).toBeUndefined();
    expect(cloud.calls.some(call => call[0] === 'jinnang')).toBe(false);
  });

  test('内部核对子命令从环境带 Access 服务令牌，未设置时不带令牌头', async () => {
    const seen: { id: string | null; secret: string | null }[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        seen.push({ id: req.headers.get('cf-access-client-id'), secret: req.headers.get('cf-access-client-secret') });
        return new Response('ok', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
      },
    });
    try {
      const url = `http://127.0.0.1:${server.port}/x.txt`;
      const base = { ...process.env };
      delete base.CF_ACCESS_CLIENT_ID; delete base.CF_ACCESS_CLIENT_SECRET;
      const withToken = await runShareAsync(['__probe', url], { ...base, CF_ACCESS_CLIENT_ID: 'id-value', CF_ACCESS_CLIENT_SECRET: 'secret-value' });
      expect(withToken.code).toBe(0);
      expect(JSON.parse(withToken.out)).toEqual({ status: 200, type: 'text/plain; charset=utf-8', md5: new Bun.CryptoHasher('md5').update('ok').digest('hex') });
      expect(seen[0]).toEqual({ id: 'id-value', secret: 'secret-value' });

      const without = await runShareAsync(['__probe', url], base);
      expect(without.code).toBe(0);
      expect(seen[1]).toEqual({ id: null, secret: null });
    } finally { server.stop(true); }
  });

  test('--help 显示 --mission 与 --public', () => {
    const r = runShare(['--help'], { ...process.env });
    expect(r.code).toBe(0);
    expect(r.out).toContain('--mission <主任务>');
    expect(r.out).toContain('--public');
  });
});
