import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { active, publicUrl, remove, upload, type Config, type Deps } from '../scripts/share';

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
    const cli = (args: string[], config: string) => Bun.spawnSync({ cmd: [process.execPath, join(import.meta.dir, '../scripts/share.ts'), ...args],
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
