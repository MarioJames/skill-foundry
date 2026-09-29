import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const CLI = resolve(import.meta.dir, '../scripts/accept.ts');
const dirs: string[] = [];
function project() { const p = mkdtempSync(join(tmpdir(), 'feature-acceptance-test-')); dirs.push(p); return p; }
function write(p: string, file: string, value: string) { const full = join(p, file); mkdirSync(resolve(full, '..'), { recursive: true }); writeFileSync(full, value); }
function exec(p: string, cmd: string[]) { const r = Bun.spawnSync({ cmd, cwd: p, stdout: 'pipe', stderr: 'pipe' }); return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }; }
function cli(p: string, ...args: string[]) { return exec(p, [process.execPath, CLI, ...args, '--project', p]); }
function rule(overrides = {}) { return { id: 'project-legacy-call', title: '使用统一错误入口', area: 'frontend', status: 'candidate', severity: 'error', include: ['src/**/*.tsx'], exclude: ['**/*.test.tsx'], rationale: '项目有统一错误管线', guidance: '复用当前项目入口', sources: [{ ref: 'fixture:feedback-1', summary: '重复通知' }], check: { kind: 'pattern', pattern: 'legacyError\\s*\\(' }, examples: { bad: [{ path: 'src/edit.tsx', content: 'legacyError(error);' }], good: [{ path: 'src/edit.tsx', content: 'notifyError(error);' }] }, ...overrides }; }
function learn(p: string, r = rule()) { write(p, 'feedback.json', JSON.stringify(r)); return cli(p, 'learn', '--feedback', join(p, 'feedback.json')); }
function promote(p: string) { write(p, 'review.json', JSON.stringify({ reviewer: 'test-reviewer', evidence: 'fixture:review-1', date: '2026-09-29' })); return cli(p, 'promote', '--id', 'project-legacy-call', '--review', join(p, 'review.json')); }
afterEach(() => { for (const p of dirs.splice(0)) rmSync(p, { recursive: true, force: true }); });

describe('扫描和反馈闭环的真实 CLI 契约', () => {
  test('候选不阻断，晋升后阻断，修复后清除门禁且从不签发功能通过', () => {
    const p = project(); write(p, 'src/edit.tsx', 'legacyError(error);\n');
    expect(learn(p).code).toBe(0);
    let r = cli(p, 'scan'); expect(r.code).toBe(0);
    expect(JSON.parse(r.out).findings.find((f: any) => f.rule === 'project-legacy-call').severity).toBe('warning');
    expect(promote(p).code).toBe(0);
    r = cli(p, 'scan'); expect(r.code).toBe(1); expect(JSON.parse(r.out).verdict).toBe('blocking-findings');
    write(p, 'src/edit.tsx', 'notifyError(error);\n');
    r = cli(p, 'scan'); expect(r.code).toBe(0); expect(JSON.parse(r.out).verdict).toBe('needs-review');
  });
  test('正反例不满足时拒绝晋升，保留原候选', () => {
    const p = project(); expect(learn(p, rule({ examples: { bad: [{ path: 'src/a.tsx', content: 'legacyError(x)' }], good: [{ path: 'src/a.tsx', content: 'legacyError(ok)' }] } })).code).toBe(0);
    expect(promote(p).code).toBe(2);
    const store = JSON.parse(readFileSync(join(p, '.agents/feature-acceptance/rules.json'), 'utf8'));
    expect(store.rules[0].status).toBe('candidate'); expect(store.rules[0].review).toBeUndefined();
  });
  test('拒绝重复规则、非法 regex、无证据 active 和语义 error', () => {
    const p = project(); expect(learn(p).code).toBe(0); expect(learn(p).code).toBe(2);
    expect(learn(p, rule({ id: 'invalid-pattern', check: { kind: 'pattern', pattern: '[' } })).code).toBe(2);
    expect(learn(p, rule({ id: 'semantic-error', check: { kind: 'review', prompt: '核对权限' } })).code).toBe(2);
    write(p, 'active.json', JSON.stringify({ version: 1, rules: [rule({ status: 'active' })] }));
    expect(cli(p, 'scan', '--rules', 'active.json').code).toBe(2);
  });
  test('review 进入队列，未匹配范围可观察；发现脚本但不执行它', () => {
    const p = project(); write(p, 'src/edit.tsx', 'submit();');
    write(p, 'package.json', JSON.stringify({ scripts: { test: 'touch executed', lint: 'API_KEY=not-for-report lint' } }));
    expect(learn(p, rule({ severity: 'warning', check: { kind: 'review', prompt: '失败时弹窗应保留输入' } })).code).toBe(0);
    const r = JSON.parse(cli(p, 'scan').out);
    expect(r.review_queue.map((x: any) => x.rule)).toEqual(['project-legacy-call']);
    expect(r.project_checks_executed).toBe(false); expect(existsSync(join(p, 'executed'))).toBe(false);
    expect(r.project_checks).toEqual(['test', 'lint']); expect(JSON.stringify(r)).not.toContain('not-for-report');
  });
  test('内置启发只提供有行号的候选线索，不输出源码或阻断', () => {
    const p = project(); write(p, 'src/edit.tsx', "const s = { color: '#ffffff' };\nmessage.error(privateText);\nimport thing from '../../../private';\n");
    const result = cli(p, 'scan'); expect(result.code).toBe(0); const r = JSON.parse(result.out);
    expect(r.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: 'seed-inline-theme', line: 1, status: 'candidate', severity: 'warning' }),
      expect.objectContaining({ rule: 'seed-local-error', line: 2 }),
      expect.objectContaining({ rule: 'seed-deep-import', line: 3 }),
    ]));
    expect(result.out).not.toContain('privateText');
  });
  test('新增路径与存量路径的大小写冲突可定位，不误报不同目录下的同名文件', () => {
    const p = project(); exec(p, ['git', 'init', '-q']);
    write(p, 'src/Download.ts', 'export const a = 1;');
    exec(p, ['git', 'add', '.']);
    exec(p, ['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'base']);
    const base = exec(p, ['git', 'rev-parse', 'HEAD']).out.trim();
    write(p, 'src/download.ts', 'export const b = 2;');
    write(p, 'other/download.ts', 'export const c = 3;');
    const r = cli(p, 'scan', '--base', base); expect(r.code).toBe(0);
    const collisions = JSON.parse(r.out).findings.filter((f: any) => f.rule === 'seed-path-case');
    expect(collisions).toEqual([expect.objectContaining({ path: 'src/download.ts', conflicts: ['src/Download.ts'], severity: 'warning' })]);
  });
  test('项目显式指定的配置文件参与检查，私密路径仍排除', () => {
    const p = project();
    write(p, 'deploy/app.yaml', 'image: service:latest\n');
    write(p, 'secrets/deploy.yaml', 'image: service:latest\n');
    expect(learn(p, rule({ include: ['**/*.yaml'], exclude: [], check: { kind: 'pattern', pattern: ':latest' }, examples: {
      bad: [{ path: 'deploy/app.yaml', content: 'image: service:latest' }],
      good: [{ path: 'deploy/app.yaml', content: 'image: service:v1' }],
    } })).code).toBe(0);
    expect(promote(p).code).toBe(0);
    const r = cli(p, 'scan'); expect(r.code).toBe(1);
    expect(JSON.parse(r.out).findings.filter((f: any) => f.rule === 'project-legacy-call')).toEqual([
      expect.objectContaining({ path: 'deploy/app.yaml', line: 1, severity: 'error' }),
    ]);
    expect(JSON.parse(r.out).files).toEqual(['deploy/app.yaml']);
  });
  test('路径检查覆盖非源码与二进制资源，差异扫描比较未改动路径且不读取资源正文', () => {
    const p = project(); exec(p, ['git', 'init', '-q']);
    write(p, 'public/Logo.png', '\0binary-one');
    exec(p, ['git', 'add', '.']); exec(p, ['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'base']);
    const base = exec(p, ['git', 'rev-parse', 'HEAD']).out.trim();
    write(p, 'public/logo.png', '\0binary-two');
    const r = cli(p, 'scan', '--base', base); expect(r.code).toBe(0);
    const out = JSON.parse(r.out);
    expect(out.findings).toEqual([expect.objectContaining({ rule: 'seed-path-case', path: 'public/logo.png', conflicts: ['public/Logo.png'] })]);
    expect(out.files).toEqual([]); expect(out.path_files).toEqual(['public/logo.png']);
    expect(r.out).not.toContain('binary-one'); expect(r.out).not.toContain('binary-two');
  });
  test('语义规则的窄例外也有可见记录，不继续进入审查队列', () => {
    const p = project(); write(p, 'src/a.tsx', 'display();');
    expect(learn(p, rule({ severity: 'warning', check: { kind: 'review', prompt: '核对可编辑表单' }, exceptions: [{ glob: 'src/a.tsx', reason: '只读展示', until: '2999-01-01' }] })).code).toBe(0);
    const r = JSON.parse(cli(p, 'scan').out);
    expect(r.review_queue.some((x: any) => x.rule === 'project-legacy-call')).toBe(false);
    expect(r.suppressed).toEqual(expect.arrayContaining([expect.objectContaining({ rule: 'project-legacy-call', kind: 'review', reason: '只读展示' })]));
  });
  test('例外有期限、保留理由，过期重新报告；exclude 不误扫测试', () => {
    const p = project(); write(p, 'src/edit.tsx', 'legacyError(x)'); write(p, 'src/edit.test.tsx', 'legacyError(x)');
    expect(learn(p, rule({ exceptions: [{ glob: 'src/edit.tsx', reason: '旧页面迁移中', until: '2999-01-01' }] })).code).toBe(0);
    expect(promote(p).code).toBe(0); let r = cli(p, 'scan'); expect(r.code).toBe(0);
    expect(JSON.parse(r.out).suppressed).toEqual([expect.objectContaining({ rule: 'project-legacy-call', reason: '旧页面迁移中' })]);
    const file = join(p, '.agents/feature-acceptance/rules.json'), store = JSON.parse(readFileSync(file, 'utf8'));
    store.rules[0].exceptions[0].until = '2000-01-01'; writeFileSync(file, JSON.stringify(store));
    r = cli(p, 'scan'); expect(r.code).toBe(1); expect(JSON.parse(r.out).findings.filter((f: any) => f.rule === 'project-legacy-call')).toHaveLength(1);
  });
  test('Git 差异覆盖已提交变更、暂存、工作树和未跟踪文件，含空格路径', () => {
    const p = project(); expect(exec(p, ['git', 'init', '-q']).code).toBe(0);
    write(p, 'src/old.tsx', 'before'); write(p, 'src/unchanged.tsx', 'same');
    exec(p, ['git', 'add', '.']); expect(exec(p, ['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'base']).code).toBe(0);
    const base = exec(p, ['git', 'rev-parse', 'HEAD']).out.trim();
    write(p, 'src/old.tsx', 'after'); write(p, 'src/staged.tsx', 'stage'); exec(p, ['git', 'add', '.']);
    exec(p, ['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'change']);
    write(p, 'src/old.tsx', 'working'); write(p, 'src/new space.tsx', 'new');
    const r = cli(p, 'scan', '--base', base); expect(r.code).toBe(0);
    expect(JSON.parse(r.out).files).toEqual(['src/new space.tsx', 'src/old.tsx', 'src/staged.tsx']);
    expect(cli(p, 'scan', '--base', 'not-a-ref').code).toBe(2);
  });
  test('明显私密和依赖目录被排除，符号链接与大文件使覆盖不完整', () => {
    const p = project(), outside = project(); write(outside, 'private.tsx', 'DO_NOT_READ');
    write(p, '.env.ts', 'SECRET'); write(p, 'secrets.ts', 'SECRET'); write(p, 'node_modules/a.ts', 'IGNORE');
    write(p, 'src/large.ts', 'x'.repeat(1024 * 1024 + 1)); symlinkSync(join(outside, 'private.tsx'), join(p, 'linked.tsx'));
    // Git inventory includes symlinks so the scanner can report the omitted input explicitly.
    exec(p, ['git', 'init', '-q']); exec(p, ['git', 'add', '.']);
    const r = cli(p, 'scan'); expect(r.code).toBe(2);
    expect(r.out).not.toContain('DO_NOT_READ'); expect(r.out).not.toContain('SECRET');
    expect(JSON.parse(r.out).skipped).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'over-1MiB' }), expect.objectContaining({ reason: 'symlink-or-outside-root' })]));
  });
  test('项目规则不越界，不穿透 symlink，也不静默忽略显式路径拼错', () => {
    const p = project(), other = project(); write(p, 'feedback.json', JSON.stringify(rule())); symlinkSync(other, join(p, '.agents'));
    expect(cli(p, 'learn', '--feedback', join(p, 'feedback.json')).code).toBe(2);
    expect(existsSync(join(other, 'feature-acceptance/rules.json'))).toBe(false);
    expect(cli(p, 'scan', '--rules', '../outside.json').code).toBe(2);
    expect(cli(other, 'scan', '--rules', 'missing.json').code).toBe(2);
  });
  test('retired 规则不执行，未知参数报错，非 Git base 不回退全量', () => {
    const p = project(); write(p, 'src/a.tsx', 'legacyError(x)');
    write(p, 'rules.json', JSON.stringify({ version: 1, rules: [rule({ status: 'retired' })] }));
    const r = cli(p, 'scan', '--rules', 'rules.json'); expect(r.code).toBe(0);
    expect(JSON.parse(r.out).findings.some((f: any) => f.rule === 'project-legacy-call')).toBe(false);
    expect(cli(p, 'scan', '--base', 'HEAD').code).toBe(2); expect(cli(p, 'scan', '--typo', 'value').code).toBe(2);
  });
  test('手工配置不能通过 check-rules 静默覆盖内置规则身份', () => {
    const p = project(); write(p, 'rules.json', JSON.stringify({ version: 1, rules: [rule({ id: 'seed-inline-theme' })] }));
    expect(cli(p, 'check-rules', '--rules', 'rules.json').code).toBe(2);
    expect(cli(p, 'scan', '--rules', 'rules.json').code).toBe(2);
  });
});
