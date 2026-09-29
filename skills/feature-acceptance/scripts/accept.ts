#!/usr/bin/env bun
import { existsSync, readFileSync, lstatSync, mkdirSync, writeFileSync, renameSync, unlinkSync, realpathSync } from 'node:fs';
import { resolve, relative, dirname, isAbsolute, join } from 'node:path';

type Source = { ref: string; summary: string };
type Example = { path: string; content: string };
type Review = { reviewer: string; evidence: string; date: string };
export type Rule = {
  id: string; title: string; area: 'frontend' | 'backend' | 'shared';
  status: 'candidate' | 'active' | 'retired'; severity: 'warning' | 'error';
  include: string[]; exclude: string[]; rationale: string; guidance: string;
  sources: Source[]; check: { kind: 'pattern'; pattern: string } | { kind: 'review'; prompt: string } | { kind: 'path-case' };
  examples?: { bad: Example[]; good: Example[] }; review?: Review;
  exceptions?: { glob: string; reason: string; until: string }[];
};
type Store = { version: 1; rules: Rule[] };
const DEFAULT_RULES = '.agents/feature-acceptance/rules.json';
const SEEDS = resolve(import.meta.dir, 'rules.json');
const SOURCE_GLOBS = ['**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts,vue,svelte,css,scss,html,py,go,rs,java,kt,rb,php,cs}', '**/package.json'];
const SKIP_PARTS = new Set(['.git', 'node_modules', 'vendor', 'dist', 'build', '.next', 'coverage', '.turbo', '.cache', '.agents', '.acceptance', '__pycache__']);
const MAX_FILE = 1024 * 1024;
function fail(message: string): never { throw new Error(message); }
function nonempty(x: unknown): x is string { return typeof x === 'string' && x.trim().length > 0; }
function record(x: unknown): x is Record<string, any> { return !!x && typeof x === 'object' && !Array.isArray(x); }
function safeRel(p: string) { return nonempty(p) && !isAbsolute(p) && !p.split(/[\\/]/).includes('..') && !p.includes('\0') && !p.includes('\\'); }
function globs(x: unknown, required = false): x is string[] {
  return Array.isArray(x) && (!required || x.length > 0) && x.every(p => typeof p === 'string' && safeRel(p) && !p.startsWith('!'));
}
function matches(path: string, patterns: string[]) { return patterns.some(p => new Bun.Glob(p).match(path)); }
function applies(rule: Rule, path: string) { return matches(path, rule.include) && !matches(path, rule.exclude); }
function date(x: unknown) { return typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x) && new Date(x).toISOString().slice(0, 10) === x; }
function run(cmd: string[], cwd?: string, input?: string) {
  if (cmd[0] === 'git') cmd = ['git', '-c', 'core.fsmonitor=false', ...cmd.slice(1)];
  const r = Bun.spawnSync({ cmd, cwd, stdin: input === undefined ? 'ignore' : Buffer.from(input), stdout: 'pipe', stderr: 'pipe', env: { ...process.env, RIPGREP_CONFIG_PATH: '' } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}
// Rust regex through ripgrep: no project code, JS regex, shell, or downloaded parser executes.
function patternLines(pattern: string, content: string): number[] {
  const r = run(['rg', '--no-config', '--json', '--text', '--regexp', pattern, '-'], undefined, content);
  if (r.code !== 0 && r.code !== 1) fail(`pattern 检查失败: ${r.err.trim()}`);
  return r.out.split('\n').filter(Boolean).map(s => JSON.parse(s)).filter(x => x.type === 'match').map(x => x.data.line_number);
}
function validateRule(r: any): asserts r is Rule {
  if (!record(r) || !/^[a-z][a-z0-9-]{2,79}$/.test(r.id ?? '')) fail('rule.id 必须为 3–80 位小写标识');
  for (const key of ['title', 'rationale', 'guidance']) if (!nonempty(r[key])) fail(`${r.id}.${key} 必填`);
  if (!['frontend', 'backend', 'shared'].includes(r.area) || !['candidate', 'active', 'retired'].includes(r.status) || !['warning', 'error'].includes(r.severity)) fail(`${r.id}: area/status/severity 无效`);
  if (!globs(r.include, true) || !globs(r.exclude)) fail(`${r.id}: include/exclude 必须为项目内正向 glob`);
  if (!Array.isArray(r.sources) || !r.sources.length || r.sources.some((s: any) => !record(s) || !nonempty(s.ref) || !nonempty(s.summary))) fail(`${r.id}: sources 需要出处和脱敏摘要`);
  if (!record(r.check) || !['pattern', 'review', 'path-case'].includes(r.check.kind)) fail(`${r.id}: check.kind 无效`);
  if (r.check.kind === 'pattern') {
    if (!nonempty(r.check.pattern) || r.check.pattern.length > 4096) fail(`${r.id}: pattern 长度无效`);
    patternLines(r.check.pattern, '');
  } else if (r.check.kind === 'review' && (!nonempty(r.check.prompt) || r.severity === 'error')) fail(`${r.id}: review 规则需要 prompt，且不能自动阻断`);
  if (r.review !== undefined && (!record(r.review) || !nonempty(r.review.reviewer) || !nonempty(r.review.evidence) || !date(r.review.date))) fail(`${r.id}: review 需要 reviewer/evidence/date`);
  if (r.examples !== undefined) {
    if (!record(r.examples) || !Array.isArray(r.examples.bad) || !Array.isArray(r.examples.good)) fail(`${r.id}: examples 需要 bad/good 数组`);
    for (const e of [...r.examples.bad, ...r.examples.good]) if (!record(e) || !safeRel(e.path) || typeof e.content !== 'string' || !applies(r, e.path)) fail(`${r.id}: example 必须落在规则范围且含 path/content`);
  }
  if (r.exceptions !== undefined && (!Array.isArray(r.exceptions) || r.exceptions.some((e: any) => !record(e) || !globs([e.glob], true) || !nonempty(e.reason) || !date(e.until)))) fail(`${r.id}: exception 需要 glob/reason/until`);
  if (r.status === 'active') validatePromotion(r);
}
function validatePromotion(r: Rule) {
  if (!r.review) fail(`${r.id}: 晋升需要 Agent review 证据`);
  if (r.check.kind !== 'pattern') return;
  if (!r.examples?.bad.length || !r.examples.good.length) fail(`${r.id}: 晋升需要能命中的 bad 和不命中的 good 反例`);
  for (const e of r.examples.bad) if (!patternLines(r.check.pattern, e.content).length) fail(`${r.id}: bad 未命中 ${e.path}`);
  for (const e of r.examples.good) if (patternLines(r.check.pattern, e.content).length) fail(`${r.id}: good 误报 ${e.path}`);
}
function load(path: string, optional = false): Store {
  if (optional && !existsSync(path)) return { version: 1, rules: [] };
  const v = JSON.parse(readFileSync(path, 'utf8'));
  if (!record(v) || v.version !== 1 || !Array.isArray(v.rules)) fail(`规则文件格式无效: ${path}`);
  const ids = new Set();
  for (const r of v.rules) { validateRule(r); if (ids.has(r.id)) fail(`重复 rule.id: ${r.id}`); ids.add(r.id); }
  return v as Store;
}
function within(root: string, target: string) {
  const rel = relative(root, target);
  if (rel.startsWith('..' + '/') || rel === '..' || isAbsolute(rel)) fail('路径必须位于项目内');
  let current = root;
  for (const part of rel.split('/').filter(Boolean)) {
    current = join(current, part);
    try { if (lstatSync(current).isSymbolicLink()) fail(`不访问符号链接: ${relative(root, current)}`); }
    catch (e: any) { if (e.code !== 'ENOENT') throw e; }
  }
  return target;
}
function mutate(root: string, path: string, fn: (store: Store) => void) {
  within(root, path);
  mkdirSync(dirname(path), { recursive: true });
  const lock = path + '.lock';
  writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
  const temp = path + `.${process.pid}.${crypto.randomUUID()}.tmp`;
  let created = false;
  try {
    const data = load(path, true); fn(data);
    for (const r of data.rules) validateRule(r);
    writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    created = true;
    renameSync(temp, path);
  } finally { if (created && existsSync(temp)) unlinkSync(temp); unlinkSync(lock); }
}
function listFiles(root: string, base?: string) {
  const git = run(['git', 'rev-parse', '--show-toplevel'], root);
  if (git.code === 0 && realpathSync(git.out.trim()) !== root) fail('--project 必须为 Git 根目录，避免混入相邻项目');
  if (base && git.code !== 0) fail('--base 仅支持 Git 项目');
  const outputs: string[] = [];
  if (git.code === 0) {
    if (base) {
      const ref = run(['git', 'rev-parse', '--verify', '--end-of-options', `${base}^{commit}`], root);
      if (ref.code !== 0) fail('无效 --base commit');
      const diff = run(['git', 'diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', '--diff-filter=ACMR', ref.out.trim(), '--'], root);
      if (diff.code) fail('git diff 失败'); outputs.push(diff.out);
      const untracked = run(['git', 'ls-files', '--others', '--exclude-standard', '-z'], root);
      if (untracked.code) fail('git ls-files 失败'); outputs.push(untracked.out);
    } else {
      const files = run(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], root);
      if (files.code) fail('git ls-files 失败'); outputs.push(files.out);
    }
  } else {
    const files = run(['rg', '--no-config', '--files', '--hidden', '-0', '.'], root);
    if (files.code > 1) fail(`文件发现失败: ${files.err}`); outputs.push(files.out);
  }
  return { git: git.code === 0, files: [...new Set(outputs.join('\0').split('\0').filter(Boolean).map(p => p.replace(/^\.\//, '')))].sort() };
}
function eligible(path: string) {
  const parts = path.split('/');
  return safeRel(path) && !parts.some(p => SKIP_PARTS.has(p) || p.startsWith('.env')) &&
    !/(^|\/)(credentials|secrets?)(\.|\/|$)/i.test(path) && !/\.(min\.(js|css)|generated\.[^.]+|d\.ts)$/.test(path);
}
function combinedRules(project: Store) {
  const seeds = load(SEEDS); const rules = [...seeds.rules, ...project.rules];
  if (new Set(rules.map(r => r.id)).size !== rules.length) fail('项目 rule.id 不得覆盖 seed id');
  return rules;
}
export function scan(root: string, project: Store, base?: string) {
  const rules = combinedRules(project);
  const discovered = listFiles(root, base);
  const pathRules = rules.filter(r => r.status !== 'retired' && r.check.kind === 'path-case');
  const contentSelected = (path: string) => matches(path, SOURCE_GLOBS) || project.rules.some(r => r.status !== 'retired' && r.check.kind !== 'path-case' && applies(r, path));
  const pathGroups = new Map<string, string[]>();
  const pathInventory: string[] = [];
  if (pathRules.length) {
    // A changed file can conflict with an unchanged tracked file.
    for (const path of (base ? listFiles(root).files : discovered.files)) {
      if (!eligible(path) || !pathRules.some(r => applies(r, path))) continue;
      try { within(root, resolve(root, path)); if (!lstatSync(resolve(root, path)).isFile()) continue; }
      catch (e: any) { if (e.code && e.code !== 'ENOENT') throw e; continue; }
      pathInventory.push(path);
      const key = path.normalize('NFC').toLowerCase();
      const group = pathGroups.get(key) ?? []; group.push(path); pathGroups.set(key, group);
    }
  }
  const findings: any[] = [], suppressed: any[] = [], skipped: any[] = [], files: string[] = [], pathFiles: string[] = [];
  const digest = new Bun.CryptoHasher('sha256');
  let excluded = 0;
  const today = new Date().toISOString().slice(0, 10);
  const applicable = new Map<string, string[]>();
  for (const path of discovered.files) {
    if (!eligible(path)) { excluded++; continue; }
    const absolute = resolve(root, path);
    try { within(root, absolute); }
    catch { skipped.push({ path, reason: 'symlink-or-outside-root' }); continue; }
    let st;
    try { st = lstatSync(absolute); } catch (e: any) { if (e.code === 'ENOENT') { skipped.push({ path, reason: 'deleted' }); continue; } throw e; }
    if (!st.isFile()) { skipped.push({ path, reason: 'not-regular-file' }); continue; }
    for (const rule of pathRules.filter(r => applies(r, path))) {
      const paths = applicable.get(rule.id) ?? []; paths.push(path); applicable.set(rule.id, paths);
      if (!pathFiles.includes(path)) pathFiles.push(path);
      const conflicts = (pathGroups.get(path.normalize('NFC').toLowerCase()) ?? []).filter(p => p !== path && applies(rule, p));
      if (conflicts.length) {
        const item = { rule: rule.id, path, conflicts, title: rule.title, severity: rule.status === 'active' ? rule.severity : 'warning', status: rule.status, guidance: rule.guidance };
        const exception = rule.exceptions?.find(e => e.until >= today && matches(path, [e.glob]));
        if (exception) suppressed.push({ ...item, reason: exception.reason, until: exception.until }); else findings.push(item);
      }
    }
    if (!contentSelected(path)) { if (!pathRules.some(r => applies(r, path))) excluded++; continue; }
    if (st.size > MAX_FILE) { skipped.push({ path, reason: 'over-1MiB' }); continue; }
    const bytes = readFileSync(absolute);
    let content: string;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { skipped.push({ path, reason: 'non-utf8' }); continue; }
    if (content.includes('\0')) { skipped.push({ path, reason: 'binary' }); continue; }
    files.push(path); digest.update(path + '\0'); digest.update(bytes); digest.update('\0');
    for (const rule of rules) {
      if (rule.status === 'retired' || rule.check.kind === 'path-case' || !applies(rule, path)) continue;
      const paths = applicable.get(rule.id) ?? []; paths.push(path); applicable.set(rule.id, paths);
      const exception = rule.exceptions?.find(e => e.until >= today && matches(path, [e.glob]));
      if (rule.check.kind === 'review') {
        if (exception) suppressed.push({ rule: rule.id, path, kind: 'review', reason: exception.reason, until: exception.until });
        continue;
      }
      for (const line of patternLines(rule.check.pattern, content)) {
        const item = { rule: rule.id, path, line, title: rule.title, severity: rule.status === 'active' ? rule.severity : 'warning', status: rule.status, guidance: rule.guidance };
        if (exception) suppressed.push({ ...item, reason: exception.reason, until: exception.until }); else findings.push(item);
      }
    }
  }
  const reviewQueue = rules.filter(r => r.status !== 'retired' && r.check.kind === 'review' && applicable.has(r.id)).map(r => ({ rule: r.id, title: r.title, prompt: r.check.kind === 'review' ? r.check.prompt : '', files: applicable.get(r.id)!.filter(path => !r.exceptions?.some(e => e.until >= today && matches(path, [e.glob]))) })).filter(r => r.files.length > 0);
  const blocking = findings.filter(f => f.severity === 'error').length;
  const incomplete = skipped.some(s => s.reason !== 'deleted');
  const checks: string[] = [];
  const packagePath = join(root, 'package.json');
  if (existsSync(packagePath)) {
    within(root, packagePath);
    const p = JSON.parse(readFileSync(packagePath, 'utf8'));
    for (const [name, command] of Object.entries(p.scripts ?? {})) if (/^(lint|test|typecheck|type-check|check)(:|$)/.test(name) && typeof command === 'string') checks.push(name);
  }
  return {
    version: 1, project: root, scope: base ? { mode: 'changed', base } : { mode: 'all' },
    source_digest: digest.digest('hex'), rules_digest: new Bun.CryptoHasher('sha256').update(JSON.stringify(rules)).digest('hex'),
    path_digest: new Bun.CryptoHasher('sha256').update(JSON.stringify(pathInventory)).digest('hex'),
    verdict: incomplete ? 'incomplete' : blocking ? 'blocking-findings' : 'needs-review',
    files, path_files: pathFiles, excluded_count: excluded, skipped, findings, suppressed, review_queue: reviewQueue,
    unmatched_rules: rules.filter(r => r.status !== 'retired' && !applicable.has(r.id)).map(r => r.id),
    project_checks: checks, project_checks_executed: false,
    limits: ['pattern 是逐行文本匹配，不解析 AST、别名或控制流；注释和字符串也可能命中', 'scan 不运行项目 lint/test，不证明布局、业务或权限通过', 'changed 模式只限制文件，需另查关联调用点与规则全量存量'],
    exit_code: incomplete ? 2 : blocking ? 1 : 0,
  };
}
export function main(args: string[]) {
  const command = args.shift();
  if (!command || command === '--help') {
    console.log('Usage: bun accept.ts scan|check-rules|learn|promote --project DIR [--rules PROJECT_PATH] [--base COMMIT]\nlearn --feedback JSON_FILE: 记录脱敏候选规则；promote --id ID --review JSON_FILE: 验证并激活\nscan: 0=扫描完成仍需审查，1=项目门禁命中，2=错误或覆盖不完整。输出 JSON；不执行项目代码。'); return 0;
  }
  if (!['scan', 'check-rules', 'learn', 'promote'].includes(command)) fail(`未知命令: ${command}`);
  const options: Record<string, string> = {};
  const allowed: Record<string, string[]> = { scan: ['project','rules','base'], 'check-rules': ['project','rules'], learn: ['project','rules','feedback'], promote: ['project','rules','id','review'] };
  while (args.length) {
    const key = args.shift()!;
    if (!key.startsWith('--') || !allowed[command].includes(key.slice(2)) || options[key.slice(2)] !== undefined || !args.length || args[0].startsWith('--')) fail(`无效或重复参数: ${key}`);
    options[key.slice(2)] = args.shift()!;
  }
  if (!options.project) fail('--project 必填');
  const root = realpathSync(resolve(options.project));
  if (!lstatSync(root).isDirectory()) fail('--project 必须为目录');
  const path = within(root, resolve(root, options.rules ?? DEFAULT_RULES));
  // Explicit paths must exist for read operations; a typo must not silently disable project gates.
  const optional = !options.rules;
  if (command === 'scan') { const result = scan(root, load(path, optional), options.base); console.log(JSON.stringify(result, null, 2)); return result.exit_code; }
  if (command === 'check-rules') { const store = load(path, optional); combinedRules(store); console.log(JSON.stringify({ ok: true, path, rules: store.rules.length })); return 0; }
  if (command === 'learn') {
    if (!options.feedback) fail('--feedback 必填');
    const rule = JSON.parse(readFileSync(resolve(options.feedback), 'utf8'));
    rule.status = 'candidate'; delete rule.review;
    validateRule(rule);
    if (load(SEEDS).rules.some(r => r.id === rule.id)) fail('不得覆盖 seed id');
    mutate(root, path, store => {
      if (store.rules.some(r => r.id === rule.id)) fail(`规则 ${rule.id} 已存在：先审查现有规则，合并出处或明确修订，不自动覆盖`);
      store.rules.push(rule);
    });
    console.log(JSON.stringify({ ok: true, path, id: rule.id, status: 'candidate' })); return 0;
  }
  if (!options.id || !options.review) fail('--id 和 --review 必填');
  const review = JSON.parse(readFileSync(resolve(options.review), 'utf8'));
  mutate(root, path, store => {
    const rule = store.rules.find(r => r.id === options.id) ?? fail('rule.id 不存在');
    if (rule.status !== 'candidate') fail('仅 candidate 可晋升');
    rule.review = review; rule.status = 'active'; validateRule(rule);
  });
  console.log(JSON.stringify({ ok: true, path, id: options.id, status: 'active' })); return 0;
}
if (import.meta.main) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (e) { console.error(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) })); process.exitCode = 2; }
}
