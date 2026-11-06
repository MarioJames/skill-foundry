#!/usr/bin/env bun
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, extname, isAbsolute, resolve, basename } from 'node:path';

type Status = 'pass' | 'fail' | 'blocked' | 'skipped';
type Evidence = { path: string; description: string };
type Check = { id: string; title: string; status: Status; expected?: string; observation: string; evidence?: Evidence[] };
type Section = { title: string; items: string[] };
type Result = { title: string; summary: string; meta?: Record<string, string>; checklist?: string; checks: Check[]; sections?: Section[] };

const STATUS: Record<Status, string> = { pass: '通过', fail: '失败', blocked: '阻塞', skipped: '未执行' };
const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.avif']);
const USAGE = 'bun report.ts render --input <result.json> --out <REPORT.html>';

const text = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0;
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const href = (p: string) => p.split('/').map(encodeURIComponent).join('/');
const relative = (p: string) => !isAbsolute(p) && !/^[a-z]+:/i.test(p) && !p.includes('\\');
const isFile = (p: string) => existsSync(p) && statSync(p).isFile();

export function verdict(checks: Check[]) {
  if (checks.some(c => c.status === 'fail')) return { key: 'fail', label: '不通过' };
  if (checks.some(c => c.status !== 'pass')) return { key: 'blocked', label: '未完成' };
  return { key: 'pass', label: '通过' };
}

export function validate(data: any, outDir: string): string[] {
  const problems: string[] = [];
  if (!data || typeof data !== 'object') return ['输入不是 JSON 对象'];
  if (!text(data.title)) problems.push('title 必填');
  if (!text(data.summary)) problems.push('summary 必填：一句话写实际结论');
  if (data.meta !== undefined && (typeof data.meta !== 'object' || Array.isArray(data.meta) || !Object.values(data.meta).every(text)))
    problems.push('meta 须为「标签: 非空文本」对象');
  if (!Array.isArray(data.checks) || data.checks.length === 0) problems.push('checks 至少一项');
  const ids = new Set<string>();
  for (const [i, c] of (Array.isArray(data.checks) ? data.checks : []).entries()) {
    const at = `checks[${i}]`;
    if (!c || typeof c !== 'object') { problems.push(`${at} 不是对象`); continue; }
    if (!text(c.id)) problems.push(`${at}.id 必填`);
    else if (ids.has(c.id)) problems.push(`${at}.id 重复: ${c.id}`);
    else ids.add(c.id);
    if (!text(c.title)) problems.push(`${at}.title 必填`);
    if (!(c.status in STATUS)) problems.push(`${at}.status 须为 ${Object.keys(STATUS).join('/')}`);
    if (!text(c.observation)) problems.push(`${at}.observation 必填：写实际观察，未执行也写原因`);
    if (c.expected !== undefined && !text(c.expected)) problems.push(`${at}.expected 为空`);
    if (c.evidence !== undefined && !Array.isArray(c.evidence)) { problems.push(`${at}.evidence 须为数组`); continue; }
    for (const [j, e] of (c.evidence ?? []).entries()) {
      const ea = `${at}.evidence[${j}]`;
      if (!e || !text(e.path)) { problems.push(`${ea}.path 必填`); continue; }
      if (!text(e.description)) problems.push(`${ea}.description 必填：说明证据内容及其与检查项的关系`);
      if (!relative(e.path)) problems.push(`${ea}.path 须为相对报告文件的路径: ${e.path}`);
      else if (!isFile(resolve(outDir, e.path))) problems.push(`${ea}.path 不存在: ${e.path}`);
    }
  }
  if (data.checklist !== undefined) problems.push(...checklistProblems(data.checklist, data.checks, outDir));
  for (const [i, s] of (data.sections ?? []).entries())
    if (!s || !text(s.title) || !Array.isArray(s.items) || !s.items.every(text)) problems.push(`sections[${i}] 须有 title 和非空 items`);
  return problems;
}

// 设计文档的验收清单每行带 data-check-id，清单中每一项都须作为带预期的检查项出现
function checklistProblems(path: unknown, checks: unknown, outDir: string): string[] {
  if (!text(path) || !relative(path)) return [`checklist 须为设计文档相对报告文件的路径: ${String(path)}`];
  const file = resolve(outDir, path);
  if (!isFile(file)) return [`checklist 不存在: ${path}`];
  const ids = [...new Set([...readFileSync(file, 'utf8').matchAll(/\bdata-check-id="([^"]+)"/g)].map(m => m[1]))];
  if (ids.length === 0) return [`checklist 中没有 data-check-id 标记的清单项: ${path}`];
  const byId = new Map((Array.isArray(checks) ? checks : []).filter(c => c && typeof c === 'object').map(c => [c.id, c]));
  return ids.flatMap(id => !byId.has(id) ? [`验收清单 ${id} 没有对应检查项，未执行也须列出并写原因`]
    : text(byId.get(id).expected) ? [] : [`验收清单 ${id} 的检查项缺 expected：照抄清单预期`]);
}

function evidenceHtml(c: Check) {
  const ev = c.evidence ?? [];
  const images = ev.filter(e => IMAGE.has(extname(e.path).toLowerCase()));
  const files = ev.filter(e => !images.includes(e));
  const figs = images.map(e => `<figure><a class="ev" href="${href(e.path)}" data-check="${esc(c.id)}"><img loading="lazy" src="${href(e.path)}" alt="${esc(e.description)}"></a><figcaption>${esc(e.description)}</figcaption></figure>`).join('');
  const list = files.map(e => `<li><a href="${href(e.path)}">${esc(basename(e.path))}</a>：${esc(e.description)}</li>`).join('');
  return (figs ? `<div class="figs">${figs}</div>` : '') + (list ? `<ul class="files">${list}</ul>` : '');
}

export function render(data: Result) {
  const v = verdict(data.checks);
  const counts = (Object.keys(STATUS) as Status[]).map(s => [s, data.checks.filter(c => c.status === s).length] as const).filter(([, n]) => n > 0);
  const meta = Object.entries(data.meta ?? {}).map(([k, val]) => `<div><dt>${esc(k)}</dt><dd>${esc(val)}</dd></div>`).join('')
    + (data.checklist ? `<div><dt>验收清单</dt><dd><a href="${href(data.checklist)}">${esc(basename(data.checklist))}</a></dd></div>` : '');
  const checks = data.checks.map(c => `
<section class="check" id="check-${esc(c.id)}" data-title="${esc(c.title)}" data-status="${c.status}">
  <h3><span class="chip ${c.status}">${STATUS[c.status]}</span><span class="cid">${esc(c.id)}</span>${esc(c.title)}</h3>
  ${c.expected ? `<p class="expected"><b>预期</b>${esc(c.expected)}</p>` : ''}
  <p class="obs"><b>实际</b>${esc(c.observation)}</p>
  ${evidenceHtml(c)}
</section>`).join('');
  const sections = (data.sections ?? []).map(s => `<section class="extra"><h2>${esc(s.title)}</h2><ul>${s.items.map(i => `<li>${esc(i)}</li>`).join('')}</ul></section>`).join('');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(data.title)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
<header class="top">
  <h1>${esc(data.title)}</h1>
  <p class="verdict"><span class="chip big ${v.key}">${v.label}</span>${esc(data.summary)}</p>
  <p class="counts">${counts.map(([s, n]) => `<span class="chip ${s}">${STATUS[s]} ${n}</span>`).join('')}</p>
  ${meta ? `<dl class="meta">${meta}</dl>` : ''}
</header>
<h2>检查项</h2>
${checks}
${sections}
</main>
<dialog id="lb" aria-label="证据查看">
  <div class="stage" tabindex="0" aria-label="图片，可上下滚动"><img alt=""></div>
  <aside>
    <p class="pos"></p>
    <h2 class="lb-title"></h2>
    <p class="lb-desc"></p>
    <p class="lb-tools"><button type="button" data-act="prev" aria-label="上一张">←</button><button type="button" data-act="next" aria-label="下一张">→</button><a class="lb-raw" target="_blank" rel="noopener">原图</a><button type="button" data-act="close">关闭</button></p>
    <p class="hint">←/→ 切换 · ↑/↓ 或滚轮浏览长图 · 点图切换原始尺寸 · Esc 关闭</p>
  </aside>
</dialog>
<script>${JS}</script>
</body>
</html>
`;
}

const CSS = `
:root{color-scheme:light dark;--bg:#fff;--fg:#1f2329;--muted:#646a73;--line:#e4e6eb;--soft:#f5f6f7;--pass:#1a7f37;--fail:#cf222e;--blocked:#9a6700;--skipped:#57606a}
@media (prefers-color-scheme:dark){:root{--bg:#16181c;--fg:#e6e8eb;--muted:#9aa0a8;--line:#2c3037;--soft:#1f2227;--pass:#3fb950;--fail:#f85149;--blocked:#d29922;--skipped:#8b949e}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Noto Sans CJK SC",sans-serif;overflow-wrap:anywhere}
main{max-width:1080px;margin:0 auto;padding:32px 20px 64px}h1{font-size:24px;margin:0 0 12px}h2{font-size:17px;margin:32px 0 12px}
.verdict{font-size:16px;display:flex;gap:10px;align-items:baseline;margin:0 0 8px}.counts{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 12px}
.chip{display:inline-block;border:1px solid currentColor;border-radius:4px;padding:0 6px;font-size:12px;font-weight:600;line-height:20px;white-space:nowrap}
.chip.big{font-size:14px;padding:2px 10px}.pass{color:var(--pass)}.fail{color:var(--fail)}.blocked{color:var(--blocked)}.skipped{color:var(--skipped)}
.meta{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:4px 20px;margin:0;padding:12px 0;border-top:1px solid var(--line)}
.meta div{min-width:0}.meta dt{color:var(--muted);font-size:12px}.meta dd{margin:0;overflow-wrap:anywhere}
.check{border-top:1px solid var(--line);padding:14px 0}.check h3{font-size:15px;margin:0 0 6px;display:flex;gap:8px;align-items:baseline}
.cid{color:var(--muted);font-weight:400;font-variant-numeric:tabular-nums}.check p{margin:4px 0;overflow-wrap:anywhere}.check p b{color:var(--muted);font-weight:500;margin-right:8px}
.figs{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;margin-top:10px}figure{margin:0}
figure a{display:block;border:1px solid var(--line);border-radius:6px;overflow:hidden;background:var(--soft);cursor:zoom-in}
figure img{display:block;width:100%;height:150px;object-fit:cover;object-position:top}
figcaption{font-size:13px;color:var(--muted);margin-top:4px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.files{font-size:13px;margin:8px 0 0;padding-left:18px}.files a,.meta a{color:inherit}.extra ul{padding-left:18px}
dialog{border:0;padding:0;width:100vw;height:100vh;max-width:none;max-height:none;background:var(--bg);color:var(--fg)}
dialog[open]{display:grid;grid-template-columns:60vw minmax(0,1fr);grid-template-rows:minmax(0,1fr);overflow:hidden}dialog::backdrop{background:rgba(0,0,0,.6)}
.stage{overflow:auto;outline:none;display:flex;flex-direction:column;background:#0d0f12;min-height:0}
.stage img{display:block;width:100%;height:auto;margin:auto 0;cursor:zoom-in}.stage.zoomed img{width:auto;max-width:none;align-self:flex-start;cursor:zoom-out}
aside{padding:20px;border-left:1px solid var(--line);overflow:auto}.pos,.hint{color:var(--muted);font-size:12px;margin:0}
.lb-title{margin:8px 0}.lb-desc{white-space:pre-wrap;overflow-wrap:anywhere}.lb-tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.lb-tools button,.lb-raw{font:inherit;font-size:13px;color:inherit;background:var(--soft);border:1px solid var(--line);border-radius:6px;padding:4px 10px;cursor:pointer;text-decoration:none}
.lb-tools button:disabled{opacity:.4;cursor:default}
@media (max-width:760px){dialog[open]{grid-template-columns:1fr;grid-template-rows:minmax(0,1fr) auto}aside{border-left:0;border-top:1px solid var(--line);max-height:45vh}.check h3{flex-wrap:wrap}}
@media print{dialog{display:none!important}figure{break-inside:avoid}figure img{height:auto;max-height:420px;object-fit:contain}figcaption{display:block}}
`;

const JS = `
(() => {
  const lb = document.getElementById('lb'), stage = lb.querySelector('.stage'), img = stage.querySelector('img');
  const links = [...document.querySelectorAll('a.ev')];
  let group = [], i = 0;
  const show = () => {
    const a = group[i], check = a.closest('.check'), desc = a.parentElement.querySelector('figcaption').textContent;
    stage.classList.remove('zoomed'); stage.scrollTo(0, 0);
    img.src = a.getAttribute('href'); img.alt = desc;
    lb.querySelector('.pos').textContent = check.querySelector('.chip').textContent + ' · 检查项 ' + check.querySelector('.cid').textContent + ' · ' + (i + 1) + '/' + group.length;
    lb.querySelector('.lb-title').textContent = check.dataset.title;
    lb.querySelector('.lb-desc').textContent = desc;
    lb.querySelector('.lb-raw').href = a.getAttribute('href');
    lb.querySelector('[data-act=prev]').disabled = i === 0;
    lb.querySelector('[data-act=next]').disabled = i === group.length - 1;
    if (document.activeElement?.disabled) stage.focus();
  };
  const go = d => { const n = i + d; if (n >= 0 && n < group.length) { i = n; show(); } };
  links.forEach(a => a.addEventListener('click', e => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    group = links.filter(x => x.dataset.check === a.dataset.check); i = group.indexOf(a);
    show(); lb.showModal(); stage.focus();
  }));
  img.addEventListener('click', () => stage.classList.toggle('zoomed'));
  lb.addEventListener('click', e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'prev') go(-1); else if (act === 'next') go(1); else if (act === 'close') lb.close();
  });
  document.addEventListener('keydown', e => {
    if (!lb.open) return;
    if (e.key === 'ArrowLeft') go(-1);
    if (e.key === 'ArrowRight') go(1);
  });
  lb.addEventListener('close', () => { img.removeAttribute('src'); group[i]?.focus(); });
})();
`;

function arg(args: string[], name: string) {
  const i = args.indexOf(name);
  return i >= 0 && text(args[i + 1]) ? args[i + 1] : undefined;
}

function main(args: string[]) {
  const input = arg(args, '--input'), out = arg(args, '--out');
  if (args[0] !== 'render' || !input || !out) {
    console.error(JSON.stringify({ error: 'usage', usage: USAGE }));
    return 2;
  }
  let data: any;
  try { data = JSON.parse(readFileSync(resolve(input), 'utf8')); }
  catch (e) { console.error(JSON.stringify({ error: 'input', message: (e as Error).message })); return 2; }
  const outPath = resolve(out), problems = validate(data, dirname(outPath));
  if (problems.length) { console.error(JSON.stringify({ error: 'invalid', problems })); return 2; }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, render(data));
  const checks = data.checks as Check[];
  console.log(JSON.stringify({
    out: outPath, verdict: verdict(checks).key,
    counts: Object.fromEntries((Object.keys(STATUS) as Status[]).map(s => [s, checks.filter(c => c.status === s).length])),
    evidence: checks.reduce((n, c) => n + (c.evidence?.length ?? 0), 0),
  }));
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
