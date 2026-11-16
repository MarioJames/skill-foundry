import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve(import.meta.dir, '../../skills/feature-delivery/scripts/report.ts');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'feature-delivery-report-')); dirs.push(root);
  mkdirSync(join(root, 'evidence/task'), { recursive: true }); mkdirSync(join(root, 'reports/task'), { recursive: true });
  writeFileSync(join(root, 'evidence/task/list empty.png'), 'png');
  writeFileSync(join(root, 'evidence/task/network.json'), '{}');
  return root;
}
function run(root: string, data: unknown) {
  const input = join(root, 'result.json'), out = join(root, 'reports/task/REPORT.html');
  writeFileSync(input, JSON.stringify(data));
  const r = Bun.spawnSync({ cmd: [process.execPath, CLI, 'render', '--input', input, '--out', out], stdout: 'pipe', stderr: 'pipe' });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString(), html: existsSync(out) ? readFileSync(out, 'utf8') : '' };
}
const check = (over = {}) => ({ id: '1', title: '空列表', status: 'pass', observation: '显示空态与新建入口', evidence: [{ path: '../../evidence/task/list empty.png', description: '列表为空时的页面' }], ...over });
const result = (checks: unknown[]) => ({ title: '验收', summary: '主路径可用', meta: { 被测版本: 'abc123' }, checks });

describe('HTML 验收报告渲染', () => {
  test('结论由检查项推出：失败优先于阻塞，全部通过才是通过', () => {
    const root = workspace();
    expect(JSON.parse(run(root, result([check(), check({ id: '2', status: 'blocked' }), check({ id: '3', status: 'fail' })])).out).verdict).toBe('fail');
    expect(JSON.parse(run(root, result([check(), check({ id: '2', status: 'skipped' })])).out).verdict).toBe('blocked');
    const ok = run(root, result([check()]));
    expect(ok.code).toBe(0); expect(JSON.parse(ok.out).verdict).toBe('pass'); expect(ok.html).toContain('通过');
  });

  test('图片进入放大查看，其他证据为链接，路径按 URL 编码', () => {
    const root = workspace();
    const r = run(root, result([check({ evidence: [
      { path: '../../evidence/task/list empty.png', description: '列表为空时的页面' },
      { path: '../../evidence/task/network.json', description: '空列表请求返回 200' },
    ] })]));
    expect(r.code).toBe(0);
    expect(r.html).toContain('<a class="ev" href="../../evidence/task/list%20empty.png" data-check="1">');
    expect(r.html).toContain('<figcaption>列表为空时的页面</figcaption>');
    expect(r.html).toContain('<a href="../../evidence/task/network.json">network.json</a>：空列表请求返回 200');
    expect(r.html).toContain('<dialog id="lb"');
  });

  test('输入文本按 HTML 转义，不能注入标签', () => {
    const root = workspace();
    const r = run(root, result([check({ title: '<script>alert(1)</script>', observation: '"><img onerror=x>' })]));
    expect(r.code).toBe(0);
    expect(r.html).not.toContain('<script>alert(1)</script>');
    expect(r.html).not.toContain('<img onerror');
    expect(r.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  test('证据缺文件、缺描述或用绝对路径时拒绝生成，不写出报告', () => {
    const root = workspace();
    const r = run(root, result([check({ evidence: [
      { path: '../../evidence/task/missing.png', description: '不存在' },
      { path: '../../evidence/task/list empty.png', description: '' },
      { path: join(root, 'evidence/task/network.json'), description: '绝对路径' },
    ] })]));
    expect(r.code).toBe(2); expect(r.html).toBe('');
    const problems: string[] = JSON.parse(r.err).problems;
    expect(problems.some(p => p.includes('不存在'))).toBe(true);
    expect(problems.some(p => p.includes('description'))).toBe(true);
    expect(problems.some(p => p.includes('相对'))).toBe(true);
  });

  test('验收清单的每一项都须作为带预期的检查项出现，清单外问题可追加', () => {
    const root = workspace();
    writeFileSync(join(root, 'reports/1105-orders.html'), '<table><tr data-check-id="A1"><td>空态</td></tr><tr data-check-id="A2"><td>失败重试</td></tr></table>');
    const withList = (checks: unknown[]) => ({ ...result(checks), checklist: '../1105-orders.html' });

    const missing = run(root, withList([check({ id: 'A1', expected: '显示空态' }), check({ id: 'X1' })]));
    expect(missing.code).toBe(2); expect(missing.html).toBe('');
    expect(JSON.parse(missing.err).problems.some((p: string) => p.includes('A2'))).toBe(true);

    const noExpected = run(root, withList([check({ id: 'A1', expected: '显示空态' }), check({ id: 'A2' })]));
    expect(noExpected.code).toBe(2);
    expect(JSON.parse(noExpected.err).problems.some((p: string) => p.includes('A2') && p.includes('expected'))).toBe(true);

    const ok = run(root, withList([check({ id: 'A1', expected: '显示空态' }), check({ id: 'A2', expected: '失败后可重试' }), check({ id: 'X1' })]));
    expect(ok.code).toBe(0);
    expect(ok.html).toContain('<a href="../1105-orders.html">1105-orders.html</a>');
  });

  test('检查项按设计文档的场景分组，清单外问题单独成组；没有分组行时不分组', () => {
    const root = workspace();
    writeFileSync(join(root, 'reports/1105-orders.html'), `<table class="checklist"><tbody>
      <tr class="group"><td colspan="4">01 · 筛出退款失败的订单 · 2 项</td></tr>
      <tr data-check-id="A1"><td>筛选</td></tr>
      <tr data-check-id="A2"><td class="id">A2 <span class="edge">异常场景</span></td></tr>
      <tr class="group"><td colspan="4">不变行为 &amp; 导出 · 1 项</td></tr>
      <tr data-check-id="A3"><td>导出</td></tr>
    </tbody></table>`);
    const checks = [check({ id: 'A1', expected: 'e1' }), check({ id: 'X1', title: '清单外的问题' }), check({ id: 'A3', expected: 'e3' }), check({ id: 'A2', expected: 'e2', status: 'fail' })];
    const r = run(root, { ...result(checks), checklist: '../1105-orders.html' });
    expect(r.code).toBe(0);
    const at = (s: string) => { const i = r.html.indexOf(s); expect(i).toBeGreaterThan(-1); expect(r.html.indexOf(s, i + 1)).toBe(-1); return i; };
    const order = ['>筛出退款失败的订单</h2>', 'id="check-A1"', 'id="check-A2"', '>不变行为 &amp; 导出</h2>', 'id="check-A3"', '>清单外发现</h2>', 'id="check-X1"'].map(at);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    const a2 = r.html.slice(at('id="check-A2"'), at('id="check-A3"'));
    expect(a2).toContain('异常场景');
    expect(r.html.slice(at('id="check-A1"'), at('id="check-A2"'))).not.toContain('异常场景');

    writeFileSync(join(root, 'reports/flat.html'), '<ul><li data-check-id="A1">筛选</li></ul>');
    const flat = run(root, { ...result([check({ id: 'A1', expected: 'e1' }), check({ id: 'X1' })]), checklist: '../flat.html' });
    expect(flat.code).toBe(0);
    expect(flat.html).not.toContain('清单外发现');
    expect(flat.html.indexOf('id="check-A1"')).toBeLessThan(flat.html.indexOf('id="check-X1"'));
  });

  test('首屏列出未通过的检查项并链接到对应位置，全部通过时不出现', () => {
    const root = workspace();
    const mixed = run(root, result([check(), check({ id: '2', title: '失败后重试', status: 'fail' }), check({ id: '3', title: '无权限提示', status: 'skipped' })]));
    const attention = mixed.html.slice(mixed.html.indexOf('id="attention"'), mixed.html.indexOf('</nav>'));
    expect(attention).toContain('href="#check-2"'); expect(attention).toContain('失败后重试');
    expect(attention).toContain('href="#check-3"'); expect(attention).toContain('无权限提示');
    expect(attention).not.toContain('href="#check-1"');
    expect(run(root, result([check()])).html).not.toContain('id="attention"');
  });

  test('验收清单路径不存在或其中没有编号时拒绝生成', () => {
    const root = workspace();
    writeFileSync(join(root, 'reports/empty.html'), '<p>没有清单</p>');
    for (const checklist of ['../missing.html', '../empty.html']) {
      const r = run(root, { ...result([check()]), checklist });
      expect(r.code).toBe(2);
      expect(JSON.parse(r.err).problems.some((p: string) => p.includes('checklist'))).toBe(true);
    }
  });

  test('报告与设计文档模板共用的色板和字体取值一致', () => {
    const tokens = (css: string) => new Map([...css.matchAll(/(--[a-z0-9-]+):([^;}]+)/g)].map(m => [m[1], m[2].trim()]));
    const template = tokens(readFileSync(resolve(import.meta.dir, '../../skills/feature-delivery/assets/design-template.html'), 'utf8').match(/:root\{([\s\S]*?)\n\}/)![1]);
    const report = tokens(run(workspace(), result([check()])).html.match(/:root\{([\s\S]*?)\}/)![1]);
    const shared = [...report.keys()].filter(k => template.has(k));
    expect(shared).toEqual(expect.arrayContaining(['--paper', '--ink', '--line', '--card', '--accent', '--issue', '--change', '--mono', '--serif', '--sans']));
    for (const k of shared) expect([k, report.get(k)]).toEqual([k, template.get(k)]);
  });

  test('检查项缺实际观察或 id 重复时拒绝生成', () => {
    const root = workspace();
    const r = run(root, result([check({ observation: '' }), check()]));
    expect(r.code).toBe(2);
    const problems: string[] = JSON.parse(r.err).problems;
    expect(problems.some(p => p.includes('observation'))).toBe(true);
    expect(problems.some(p => p.includes('重复'))).toBe(true);
  });
});
