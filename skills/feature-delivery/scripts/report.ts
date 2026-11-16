#!/usr/bin/env bun
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, extname, isAbsolute, resolve, basename } from 'node:path';

type Status = 'pass' | 'fail' | 'blocked' | 'skipped';
type Evidence = { path: string; description: string };
type Check = { id: string; title: string; status: Status; expected?: string; observation: string; evidence?: Evidence[] };
type Section = { title: string; items: string[] };
type Result = { title: string; summary: string; scope?: string; meta?: Record<string, string>; checklist?: string; checks: Check[]; sections?: Section[] };
type Group = { label: string; ids: string[] };
type Checklist = { ids: string[]; groups: Group[]; edge: Set<string> };

const STATUS: Record<Status, string> = { pass: '通过', fail: '失败', blocked: '阻塞', skipped: '未执行' };
const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.avif']);
const USAGE = 'bun report.ts render --input <result.json> --out <REPORT.html>';
const OUTSIDE = '清单外发现';

const text = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0;
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const unesc = (s: string) => s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' })[e]!);
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
  if (data.scope !== undefined && !text(data.scope)) problems.push('scope 为空');
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

// 设计文档的验收清单：每项一行 data-check-id，场景分组行为 <tr class="group">，异常场景在行内带 class="edge"
export function readChecklist(file: string): Checklist {
  const html = readFileSync(file, 'utf8');
  const ids = [...new Set([...html.matchAll(/\bdata-check-id="([^"]+)"/g)].map(m => m[1]))];
  const groups: Group[] = [], edge = new Set<string>();
  let grouped = false;
  for (const [, attrs, body] of html.matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/g)) {
    const id = attrs.match(/\bdata-check-id="([^"]+)"/)?.[1];
    if (id) {
      if (!groups.length) groups.push({ label: '验收清单', ids: [] });
      groups.at(-1)!.ids.push(id);
      if (/\bclass="[^"]*\bedge\b/.test(body)) edge.add(id);
    } else if (/\bclass="[^"]*\bgroup\b/.test(attrs)) {
      grouped = true;
      groups.push({ label: unesc(body.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim(), ids: [] });
    }
  }
  return { ids, groups: grouped ? groups : [], edge };
}

// 清单中每一项都须作为带预期的检查项出现
function checklistProblems(path: unknown, checks: unknown, outDir: string): string[] {
  if (!text(path) || !relative(path)) return [`checklist 须为设计文档相对报告文件的路径: ${String(path)}`];
  const file = resolve(outDir, path);
  if (!isFile(file)) return [`checklist 不存在: ${path}`];
  const { ids } = readChecklist(file);
  if (ids.length === 0) return [`checklist 中没有 data-check-id 标记的清单项: ${path}`];
  const byId = new Map((Array.isArray(checks) ? checks : []).filter(c => c && typeof c === 'object').map(c => [c.id, c]));
  return ids.flatMap(id => !byId.has(id) ? [`验收清单 ${id} 没有对应检查项，未执行也须列出并写原因`]
    : text(byId.get(id).expected) ? [] : [`验收清单 ${id} 的检查项缺 expected：照抄清单预期`]);
}

// 「01 · 场景标题 · 3 项」拆成编号与标题，项数以报告实际结果为准
function groupTitle(label: string) {
  const parts = label.split(/\s*·\s*/).filter(Boolean);
  if (parts.length > 1 && /^\d+\s*项$/.test(parts.at(-1)!)) parts.pop();
  const no = parts.length > 1 && /^[0-9A-Za-z]{1,3}$/.test(parts[0]) ? parts.shift()! : '✓';
  return { no, title: parts.join(' · ') };
}

function blocks(checks: Check[], list?: Checklist) {
  if (!list?.groups.length) return [{ no: '✓', title: '检查项', checks }];
  const placed = new Set(list.groups.flatMap(g => g.ids));
  const out = list.groups.map(g => ({ ...groupTitle(g.label), checks: checks.filter(c => g.ids.includes(c.id)) }));
  out.push({ no: 'X', title: OUTSIDE, checks: checks.filter(c => !placed.has(c.id)) });
  return out.filter(b => b.checks.length);
}

const chip = (s: Status, label = STATUS[s]) => `<span class="st ${s}">${label}</span>`;

function evidenceHtml(c: Check) {
  const ev = c.evidence ?? [];
  const images = ev.filter(e => IMAGE.has(extname(e.path).toLowerCase()));
  const files = ev.filter(e => !images.includes(e));
  const figs = images.map(e => `<figure><a class="ev" href="${href(e.path)}" data-check="${esc(c.id)}"><img loading="lazy" src="${href(e.path)}" alt="${esc(e.description)}"></a><figcaption>${esc(e.description)}</figcaption></figure>`).join('');
  const list = files.map(e => `<li><a href="${href(e.path)}">${esc(basename(e.path))}</a>：${esc(e.description)}</li>`).join('');
  return (figs ? `<div class="figs">${figs}</div>` : '') + (list ? `<ul class="files">${list}</ul>` : '');
}

function checkHtml(c: Check, edge: boolean) {
  return `
<article class="check" id="check-${esc(c.id)}" data-title="${esc(c.title)}" data-status="${c.status}">
  <div class="side"><span class="cid">${esc(c.id)}</span>${chip(c.status)}</div>
  <div class="body">
    <h3>${esc(c.title)}${edge ? ' <span class="edge">异常场景</span>' : ''}</h3>
    <div class="pair${c.expected ? '' : ' solo'}">
      ${c.expected ? `<div class="exp"><div class="col-label">预期</div><p>${esc(c.expected)}</p></div>` : ''}
      <div class="act"><div class="col-label">实际</div><p>${esc(c.observation)}</p>${evidenceHtml(c)}</div>
    </div>
  </div>
</article>`;
}

export function render(data: Result, list?: Checklist) {
  const v = verdict(data.checks), total = data.checks.length;
  const count = (cs: Check[]) => (Object.keys(STATUS) as Status[]).map(s => [s, cs.filter(c => c.status === s).length] as const).filter(([, n]) => n > 0);
  const counts = count(data.checks);
  const open = data.checks.filter(c => c.status !== 'pass');
  const groups = blocks(data.checks, list);
  const meta = Object.entries(data.meta ?? {}).map(([k, val]) => `<div><dt>${esc(k)}</dt><dd>${esc(val)}</dd></div>`).join('');
  const extras = data.sections ?? [];
  const toc = [
    ...groups.map((g, i) => `<a href="#g${i + 1}"><b>${esc(g.no)}</b>${esc(g.title)}</a>`),
    ...extras.map((s, i) => `<a href="#s${i + 1}"><b>§</b>${esc(s.title)}</a>`),
  ].join('');
  const body = groups.map((g, i) => {
    const passed = g.checks.filter(c => c.status === 'pass').length;
    const tally = passed === g.checks.length ? chip('pass', `${passed}/${passed} 通过`)
      : count(g.checks).filter(([s]) => s !== 'pass').map(([s, n]) => chip(s, `${STATUS[s]} ${n}`)).join('') + `<span class="of">共 ${g.checks.length} 项</span>`;
    return `
<section class="block" id="g${i + 1}">
  <div class="sec-head"><span class="sec-no">${esc(g.no)}</span><h2>${esc(g.title)}</h2><span class="tally">${tally}</span></div>
  <div class="checks">${g.checks.map(c => checkHtml(c, !!list?.edge.has(c.id))).join('')}
  </div>
</section>`;
  }).join('');
  const sections = extras.map((s, i) => `
<section class="block" id="s${i + 1}">
  <div class="sec-head"><span class="sec-no">§</span><h2>${esc(s.title)}</h2></div>
  <ul class="extra">${s.items.map(x => `<li>${esc(x)}</li>`).join('')}</ul>
</section>`).join('');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(data.title)}</title>
<style>${CSS}</style>
</head>
<body>
<header class="hero wrap">
  <div class="hero-top">
    <div>
      <div class="kicker">Acceptance${data.scope ? ` · ${esc(data.scope)}` : ''}</div>
      <h1>${esc(data.title)}</h1>
      <p class="lead">${esc(data.summary)}</p>
    </div>
    <div class="stamp ${v.key}" role="img" aria-label="验收结论：${v.label}"><b>${v.label}</b><span>${total - open.length} / ${total} 项通过</span></div>
  </div>
  ${counts.length > 1 ? `<p class="counts">${counts.map(([s, n]) => chip(s, `${STATUS[s]} ${n}`)).join('')}</p>` : ''}
  ${data.checklist ? `<div class="notice">▣ 按设计文档 <a href="${href(data.checklist)}">${esc(basename(data.checklist))}</a> 的验收清单逐项验收，编号与清单一致。</div>` : ''}
  ${meta ? `<dl class="meta">${meta}</dl>` : ''}
  ${open.length ? `<nav id="attention" class="attention" aria-label="未通过的检查项">
    <div class="att-head">需关注 · ${open.length} 项未通过</div>
    ${open.map(c => `<a href="#check-${esc(c.id)}">${chip(c.status)}<span class="cid">${esc(c.id)}</span><span>${esc(c.title)}</span></a>`).join('\n    ')}
  </nav>` : ''}
</header>
<nav class="toc" aria-label="目录"><div class="wrap">${toc}</div></nav>
<main class="wrap">
${body}
${sections}
</main>
<footer class="wrap">验收报告 · 结论由检查项结果推出 · 证据路径相对本文件 · 不入仓库</footer>
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

// 视觉语言与 assets/design-template.html 同一套：纸面网格底、墨色细线框、衬线标题、等宽注记；改色板或字体时两处一起改
const CSS = `
:root{color-scheme:light;
  --paper:#f4f2ec;--ink:#1f1f1c;--ink2:#55534c;--ink3:#8b887e;--line:#c9c5b9;--line2:#e3e0d6;--card:#fffefb;
  --accent:#d9480f;--issue:#c92a2a;--issue-soft:#fff5f5;--change:#2b8a3e;--change-soft:#ebfbee;--warn:#a8610a;--warn-soft:#fff6e0;--idle-soft:#f0eee6;
  --mono:ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,monospace;
  --serif:"Noto Serif SC","Source Han Serif SC","Songti SC","STSong",serif;
  --sans:-apple-system,BlinkMacSystemFont,"PingFang SC","Noto Sans SC","Microsoft YaHei",sans-serif}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.65 var(--sans);overflow-wrap:anywhere;
  background-image:linear-gradient(var(--line2) 1px,transparent 1px),linear-gradient(90deg,var(--line2) 1px,transparent 1px);
  background-size:28px 28px;background-attachment:fixed}
.wrap{max-width:1160px;margin:0 auto;padding:0 20px}
a{color:inherit}

header.hero{padding-top:52px;padding-bottom:24px}
.hero-top{display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:36px;align-items:center}
.kicker{font:12px/1 var(--mono);letter-spacing:.14em;color:var(--accent);text-transform:uppercase}
h1{font:700 32px/1.25 var(--serif);margin:12px 0}
h2{font:700 23px/1.3 var(--serif);margin:0}
h3{font:600 15px/1.5 var(--sans);margin:0 0 8px}
.lead{font-size:15.5px;color:var(--ink2);max-width:800px;margin:0}
.stamp{transform:rotate(-4deg);border:3px double currentColor;border-radius:6px;padding:10px 20px 9px;text-align:center;background:var(--card);margin-right:6px}
.stamp b{display:block;font:700 30px/1.2 var(--serif);letter-spacing:.14em;margin-right:-.14em;white-space:nowrap}
.stamp span{display:block;margin-top:5px;padding-top:6px;border-top:1px solid currentColor;font:11.5px/1 var(--mono);letter-spacing:.04em;white-space:nowrap}
.pass{color:var(--change)}.fail{color:var(--issue)}.blocked{color:var(--warn)}.skipped{color:var(--ink2)}
.st{display:inline-block;font:600 11.5px/1 var(--sans);padding:4px 7px;border-radius:3px;border:1px solid currentColor;white-space:nowrap}
.st.pass{background:var(--change-soft)}.st.fail{background:var(--issue-soft)}.st.blocked{background:var(--warn-soft)}.st.skipped{background:var(--idle-soft)}
.counts{display:flex;flex-wrap:wrap;gap:6px;margin:16px 0 0}
.notice{display:inline-block;margin-top:16px;padding:6px 12px;border:1.5px dashed var(--ink3);border-radius:4px;font:12px/1.5 var(--mono);color:var(--ink2);background:var(--card)}
.meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));margin:16px 0 0;background:var(--card);border:1.5px solid var(--ink);border-radius:4px;overflow:hidden}
.meta div{min-width:0;padding:9px 14px;border-right:1px dashed var(--line);border-bottom:1px dashed var(--line);margin:0 -1px -1px 0}
.meta dt{font:11px/1.5 var(--mono);letter-spacing:.08em;color:var(--ink3)}
.meta dd{margin:1px 0 0;font-size:13.5px}
.attention{margin-top:16px;border:2px dashed var(--issue);border-radius:4px;background:var(--card)}
.att-head{padding:8px 14px;font:700 12px/1.4 var(--mono);letter-spacing:.08em;color:var(--issue);border-bottom:1px dashed var(--line)}
.attention a{display:grid;grid-template-columns:58px 40px minmax(0,1fr);gap:10px;align-items:baseline;padding:8px 14px;border-bottom:1px dashed var(--line);text-decoration:none;font-size:13.5px}
.attention a:last-child{border-bottom:0}
.attention a:hover{background:var(--idle-soft)}
.attention .st{justify-self:start}

nav.toc{position:sticky;top:0;z-index:30;background:rgba(244,242,236,.94);backdrop-filter:blur(6px);border-bottom:1.5px solid var(--ink)}
nav.toc .wrap{display:flex;gap:4px;overflow-x:auto;padding-top:8px;padding-bottom:8px}
nav.toc a{flex:none;text-decoration:none;font-size:13px;padding:7px 12px;border-radius:999px;color:var(--ink2)}
nav.toc a:hover{background:var(--card);color:var(--ink)}
nav.toc a b{font-family:var(--mono);color:var(--accent);margin-right:6px}

section.block{padding:40px 0 4px;scroll-margin-top:44px}
.sec-head{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:baseline;margin-bottom:14px}
.sec-no{font:700 13px/1 var(--mono);color:#fff;background:var(--ink);padding:5px 8px;border-radius:3px}
.tally{display:inline-flex;gap:6px;align-items:center;margin-left:auto}
.tally .of{font:12px/1 var(--mono);color:var(--ink3)}

.checks{background:var(--card);border:1.5px solid var(--ink);border-radius:4px;overflow:hidden}
.check{display:grid;grid-template-columns:64px minmax(0,1fr);gap:6px 14px;padding:14px 16px 16px;border-bottom:1px dashed var(--line);scroll-margin-top:52px}
.check:last-child{border-bottom:0}
.check[data-status=fail]{background:var(--issue-soft);box-shadow:inset 4px 0 0 var(--issue)}
.check[data-status=blocked]{background:var(--warn-soft);box-shadow:inset 4px 0 0 var(--warn)}
.check[data-status=skipped]{background:#faf9f5;box-shadow:inset 4px 0 0 var(--ink3)}
.check:target{outline:2px dashed var(--accent);outline-offset:-4px}
.side{display:flex;flex-direction:column;gap:6px;align-items:flex-start}
.cid{font:700 13px/1.6 var(--mono);color:var(--accent);font-variant-numeric:tabular-nums}
.body{min-width:0}
.edge{display:inline-block;margin-left:4px;font:600 10.5px/1 var(--sans);padding:3px 5px;border-radius:3px;color:var(--issue);border:1px solid var(--issue);vertical-align:2px;white-space:nowrap}
.pair{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr)}
.pair.solo{grid-template-columns:minmax(0,1fr)}
.pair>div{min-width:0}
.pair>.exp{padding-right:18px}
.pair>.exp+.act{padding-left:18px;border-left:1px dashed var(--line)}
.pair p{margin:0;font-size:13.5px}
.exp p{color:var(--ink2)}
.col-label{font:700 11px/1 var(--mono);letter-spacing:.1em;color:var(--ink3);margin-bottom:6px}
.check[data-status=pass] .act .col-label{color:var(--change)}
.check[data-status=fail] .act .col-label{color:var(--issue)}
.check[data-status=blocked] .act .col-label{color:var(--warn)}

.figs{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:16px;margin-top:14px;counter-reset:fig}
.pair.solo .figs{grid-template-columns:repeat(auto-fill,minmax(230px,1fr))}
figure{margin:0;min-width:0;counter-increment:fig}
figure a{display:block;border:1.5px solid var(--ink);border-radius:6px;overflow:hidden;background:#fff;cursor:zoom-in;box-shadow:4px 4px 0 rgba(31,31,28,.12);transition:transform .12s,box-shadow .12s}
figure a:hover,figure a:focus-visible{transform:translate(-1px,-1px);box-shadow:6px 6px 0 rgba(31,31,28,.2)}
figure img{display:block;width:100%;height:140px;object-fit:cover;object-position:top}
figcaption{display:grid;grid-template-columns:20px minmax(0,1fr);gap:8px;margin-top:10px;font-size:12.5px;line-height:1.55;color:var(--ink2)}
figcaption::before{content:counter(fig);display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;color:#fff;background:var(--ink);font:700 11px/1 var(--mono)}
.files{list-style:none;margin:12px 0 0;padding:0;font-size:12.5px;color:var(--ink2)}
.files li{padding-left:18px;position:relative}
.files li::before{content:"▤";position:absolute;left:0;color:var(--ink3)}
.files a{font-family:var(--mono);font-size:12px;color:var(--ink)}

.extra{list-style:none;margin:0;padding:0;background:var(--card);border:1.5px solid var(--ink);border-radius:4px}
.extra li{padding:9px 14px 9px 34px;border-bottom:1px dashed var(--line);position:relative;font-size:13.5px}
.extra li:last-child{border-bottom:0}
.extra li::before{content:"—";position:absolute;left:14px;color:var(--ink3);font-family:var(--mono)}

footer{padding-top:36px;padding-bottom:56px;color:var(--ink3);font:12px/1.6 var(--mono)}

dialog{border:0;padding:0;width:100vw;height:100vh;max-width:none;max-height:none;background:var(--paper);color:var(--ink)}
dialog[open]{display:grid;grid-template-columns:60vw minmax(0,1fr);grid-template-rows:minmax(0,1fr);overflow:hidden}dialog::backdrop{background:rgba(31,31,28,.6)}
.stage{overflow:auto;outline:none;display:flex;flex-direction:column;background:#1f1f1c;min-height:0}
.stage img{display:block;width:100%;height:auto;margin:auto 0;cursor:zoom-in}.stage.zoomed img{width:auto;max-width:none;align-self:flex-start;cursor:zoom-out}
aside{padding:22px 20px;border-left:1.5px solid var(--ink);overflow:auto}
.pos,.hint{color:var(--ink3);font:12px/1.6 var(--mono);margin:0}
.lb-title{font-size:20px;margin:10px 0}.lb-desc{white-space:pre-wrap;color:var(--ink2);margin:0 0 16px}
.lb-tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:0 0 14px}
.lb-tools button,.lb-raw{font:12.5px/1 var(--sans);border:1.5px solid var(--ink);background:#fff;color:var(--ink);padding:7px 11px;border-radius:4px;cursor:pointer;text-decoration:none}
.lb-tools button:disabled{opacity:.35;cursor:default}

@media (max-width:760px){
  .pair{grid-template-columns:minmax(0,1fr)}
  .pair>.exp{padding:0 0 10px}
  .pair>.exp+.act{padding:10px 0 0;border-left:0;border-top:1px dashed var(--line)}
  dialog[open]{grid-template-columns:1fr;grid-template-rows:minmax(0,1fr) auto}
  aside{border-left:0;border-top:1.5px solid var(--ink);max-height:45vh}
}
@media (max-width:600px){
  h1{font-size:25px}
  .wrap{padding:0 12px}
  .hero-top{grid-template-columns:minmax(0,1fr)}
  .stamp{justify-self:start;margin:16px 0 4px 4px;transform:rotate(-2deg);padding:7px 14px 6px}
  .stamp b{font-size:22px}
  .check{grid-template-columns:minmax(0,1fr);padding:12px}
  .side{flex-direction:row;align-items:center;gap:10px}
  .attention a{grid-template-columns:auto auto minmax(0,1fr)}
  .tally{margin-left:0}
}
@media print{
  body{background:#fff}nav.toc{position:static}dialog{display:none!important}
  .check,figure{break-inside:avoid}figure img{height:auto;max-height:420px;object-fit:contain}
}
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
    lb.querySelector('.pos').textContent = check.querySelector('.st').textContent + ' · 检查项 ' + check.querySelector('.cid').textContent + ' · ' + (i + 1) + '/' + group.length;
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
  writeFileSync(outPath, render(data, data.checklist ? readChecklist(resolve(dirname(outPath), data.checklist)) : undefined));
  const checks = data.checks as Check[];
  console.log(JSON.stringify({
    out: outPath, verdict: verdict(checks).key,
    counts: Object.fromEntries((Object.keys(STATUS) as Status[]).map(s => [s, checks.filter(c => c.status === s).length])),
    evidence: checks.reduce((n, c) => n + (c.evidence?.length ?? 0), 0),
  }));
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
