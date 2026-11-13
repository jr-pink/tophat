#!/usr/bin/env node
// Builds the chat-UI figures (auto-chat, runner-qol, runner-turn, mac-apps) as static mocks of the real webchat.
//
// Nothing here is drawn by hand. The markup and the CSS are the webchat's own, captured from a running instance:
//   shell.json   the app shell (sidebar, tab strip, chat header, composer) of the public demo, captured with extract.js
//                (every stylesheet rule that matches an element of the subtree, container and layer wrappers kept);
//   frag/*.json  transcript rows, rendered by the real Transcript.svelte in a tiny vite harness (harness/) and captured the same way;
//   menu.json    the real context menu.
// This file only arranges those pieces (sidebar rows, tabs, a title, the transcript) with jsdom, and writes each widget with the
// shared caption frame and the height script. See README.md here for the capture steps.
//   node packages/demo/widgets/ui-src/build.mjs [auto-chat runner-qol runner-turn mac-apps]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WIDGETS = path.join(HERE, '..');
const load = (n) => JSON.parse(readFileSync(path.join(HERE, n), 'utf8'));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// the shared figure caption (identical in every widget; test/widgets.test.mjs holds them equal)
const CAPTION_CSS = (() => {
  const h = readFileSync(path.join(WIDGETS, 'sharing.html'), 'utf8');
  return /\/\* the one shared element[^*]*\*\/\n([\s\S]*?)\n(?=\/\* this figure)/.exec(h)[1];
})();
const HEIGHT_SCRIPT = `<script>(function(){function tell(){parent.postMessage({tophatFigure:'height',px:Math.ceil(document.body.getBoundingClientRect().height)},'*')}addEventListener('load',tell);addEventListener('resize',tell)})()</script>`;

// ---- css ------------------------------------------------------------------------------------------------------------
// What is dropped from a capture: the demo's own intro layer, the desktop shell bar, KaTeX's font files (no network in a figure),
// the off-canvas sidebar of narrow windows (the mock keeps the sidebar and hides it itself on a phone), and capture marks.
const DROP = /#demo-|#th-|html\.demo|\.demo-|\.katex|data-tophat|@font-face|@keyframes (?:demo|th-)/;
export function cssOf(...captures) {
  const seen = new Set(), out = [];
  for (const c of captures) for (const rule of c.css) {
    if (DROP.test(rule) || seen.has(rule)) continue;
    seen.add(rule); out.push(rule);
  }
  return out.join('\n');
}

// ---- the shell --------------------------------------------------------------------------------------------------------
const shell = load('shell.json');
export function shellDoc() {
  const dom = new JSDOM(`<body>${shell.html[0]}</body>`);
  const doc = dom.window.document;
  doc.querySelectorAll('[data-tophat-pick]').forEach((e) => e.removeAttribute('data-tophat-pick'));
  return doc;
}
const parse = (html) => new JSDOM(`<body>${html}</body>`).window.document.body;

/** Sidebar rows from a spec: [{ folder, open, count, unread, rows: [{ title, preview, ago, unread, active, aside }] }, ...]; `inbox: true` is the Inbox. */
export function sidebar(doc, spec, plain = null) {
  if (plain) spec.plain = plain;
  const list = doc.querySelector('[data-testid="chat-list"]');
  const q = (sel) => list.querySelector(sel);
  const closed = q('.wsgroup[data-workspace="healthhh"]').cloneNode(true);
  const open = q('.wsgroup[data-workspace="tophat"]').cloneNode(true);
  const inbox = q('[data-testid="everything-else"]').cloneNode(true);
  const rowTpl = [...list.querySelectorAll('[data-testid="chat-row"]')].find((a) => !a.classList.contains('active') && !a.classList.contains('inpane') && a.querySelector('.mark[data-indicator="idle"]')).closest('.group').cloneNode(true);
  const unreadMark = list.querySelector('.mark[data-indicator="unread"]').cloneNode(true);
  const unreadDot = closed.querySelector('.unread-dot');
  const mkRow = (r, n) => {
    const g = rowTpl.cloneNode(true);
    const a = g.querySelector('[data-testid="chat-row"]');
    a.setAttribute('href', `?chat=mock-${n}`); a.setAttribute('data-chat', `mock-${n}`);
    g.querySelector('[data-ctx-id]').setAttribute('data-ctx-id', `mock-${n}`);
    const name = a.querySelector('.name');
    name.lastChild.textContent = r.title || '';
    // the real tag (Sidebar.svelte): shown before the title of a chat an automated event opened
    if (r.auto) name.insertBefore(Object.assign(name.ownerDocument.createElement('span'), { className: 'auto svelte-1ccclju', title: 'Opened by an automated event, not by the owner', textContent: 'auto' }), name.lastChild);
    if (r.auto) name.querySelector('.auto').setAttribute('data-testid', 'automated-tag');
    a.querySelector('.preview').firstChild.textContent = r.preview || '';
    if (r.skeleton) { name.innerHTML = `<i class="sk" style="width:${r.skeleton[0]}%"></i>`; a.querySelector('.preview').innerHTML = `<i class="sk s2" style="width:${r.skeleton[1]}%"></i>`; }
    const mark = a.querySelector('.mark');
    if (r.unread) mark.replaceWith(unreadMark.cloneNode(true)); else mark.querySelector('.time').textContent = r.skeleton ? '' : r.ago || '';
    if (r.active) a.classList.add('active');
    if (r.hover) g.querySelector('.swiperow').classList.add('forcehover');
    if (r.title && !r.aside) g.querySelectorAll('.rowactions').forEach(() => {});
    return g;
  };
  list.innerHTML = '';
  let n = 0;
  for (const f of spec) {
    const head = (f.inbox ? inbox : f.open ? open : closed).cloneNode(true);
    if (!f.inbox) {
      head.setAttribute('data-workspace', f.folder);
      head.querySelector('.wshead').setAttribute('data-ctx-key', f.folder);
      head.querySelector('.wsname').textContent = f.folder;
      head.querySelector('.wsinfo')?.remove();
    }
    const toggle = head.querySelector('.wstoggle');
    const caret = head.querySelector('.caret');
    toggle.setAttribute('aria-expanded', String(!!f.open));
    head.querySelector('.wshead').setAttribute('aria-expanded', String(!!f.open));
    caret.classList.toggle('down', !!f.open);
    const count = toggle.querySelector('.count');
    if (f.count != null) { if (count) count.textContent = String(f.count); else toggle.insertAdjacentHTML('beforeend', `<span class="count ${count?.className.split(' ').pop() || ''}">${f.count}</span>`); }
    else count?.remove();
    toggle.querySelector('.unread-dot')?.remove();
    if (f.unread) toggle.appendChild(unreadDot.cloneNode(true));
    list.appendChild(head);
    if (f.open) for (const r of f.rows || []) list.appendChild(mkRow(r, ++n));
  }
  if (spec.plain) for (const r of spec.plain) { const g = mkRow(r, ++n); g.style.setProperty('--depth', '0'); list.appendChild(g); }
}

export function tabs(doc, spec, root = doc) {
  const box = root.querySelector('[data-testid="tabs"]');
  const tpl = box.querySelector('[data-testid="tab"]').cloneNode(true);
  tpl.classList.remove('active', 'preview'); tpl.removeAttribute('data-preview'); tpl.setAttribute('aria-selected', 'false');
  box.innerHTML = '';
  spec.forEach((t, i) => {
    const e = tpl.cloneNode(true);
    e.setAttribute('title', t.title); e.setAttribute('data-tab', `mock-tab-${i}`);
    e.querySelector('.label').lastChild.textContent = t.title;
    if (t.active) { e.classList.add('active'); e.setAttribute('aria-selected', 'true'); }
    box.appendChild(e);
  });
}

export function header(doc, { title, model = 'claude-sonnet-5-5', effort = 'medium' }, root = doc) {
  root.querySelector('[data-testid="chat-name"]').textContent = title;
  root.querySelector('[data-testid="chat-title"]').setAttribute('title', `${title}\nDouble-click to rename`);
  for (const [tid, val] of [['model', model], ['effort', effort]]) {
    const sel = root.querySelector(`select[data-testid="${tid}"]`);
    sel?.querySelectorAll('option').forEach((o) => { if (o.getAttribute('value') === val) o.setAttribute('selected', ''); else o.removeAttribute('selected'); });
  }
}

/** Puts a captured transcript (frag json) in place of the shell's. */
export function transcript(doc, frag, root = doc) {
  const mine = parse(frag.html[0]).querySelector('[data-testid="transcript"]');
  const old = root.querySelector('[data-testid="transcript"]');
  mine.removeAttribute('style');
  old.replaceWith(doc.importNode(mine, true));
}
/** A captured transcript as markup (for the tiles that are not a whole app). */
export const transcriptHtml = (frag) => { const t = parse(frag.html[0]).querySelector('[data-testid="transcript"]'); t.removeAttribute('style'); return t.outerHTML.replace(/<!---->/g, ''); };
/** The rows of a captured transcript, one html string per row (a .row.vrow). */
export const rowsOf = (frag) => [...parse(frag.html[0]).querySelectorAll('.column > .vrow')].map((r) => r.outerHTML.replace(/<!---->/g, ''));

// ---- the page -----------------------------------------------------------------------------------------------------------
const MOCK_CSS = `
/* the frame around the real app: a window-sized box; the app's own height (100dvh), fixed sidebar and fab are set to fit it */
.mock{position:relative;transform:translateZ(0);margin:10px 12px;border:1px solid var(--line);border-radius:8px;overflow:hidden;height:var(--mock-h,540px);background:var(--bg)}
.mock .app{height:100%!important}
:is(.mock,.win) .sidebar{position:relative!important;inset:auto!important;transform:none!important;box-shadow:none!important;width:var(--sw,244px)!important;height:100%!important;padding-bottom:0!important}
.forcehover .rowactions{opacity:1!important;pointer-events:auto}
.win .column{padding-bottom:12px!important}
.mock .sidebar-resize{display:none!important}
.mock .chat-launcher{position:absolute!important;left:14px!important;bottom:14px!important}
.mock .background-notice{display:none}
.mock .sidebar>header>.icon-btn{display:none}
.mock .column{padding-bottom:24px!important}
.mock [data-testid=nav-pill]{border-color:transparent!important;background:transparent!important;padding:0!important}
.mock [data-testid=nav-pill] a.tab,.mock [data-testid=nav-pill] .sep{display:none!important}
@media (max-width:560px){.mock{margin:8px 6px;height:calc(var(--mock-h,540px) + 120px)}.mock .sidebar,.mock .chat-launcher{display:none!important}}
html,body{height:auto}body{overflow:visible}figure{flex:none}
.hl{outline:1.5px solid var(--accent);outline-offset:3px;border-radius:9px}
.vrow{content-visibility:visible!important;contain:none!important}
`;

export function page({ css, body, caption, cssExtra = '', script = '', htmlExtra = '', note = '' }) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark">
<style>
/* the one shared element: the figure caption (identical in all six widgets) */
${CAPTION_CSS}
/* this figure: ${note}. The markup and the rules below are the webchat's own (captured by widgets/ui-src/build.mjs); only the frame after them is the figure's */
${css}
${MOCK_CSS}${cssExtra}</style></head><body>
<figure>
${body}
<figcaption>${caption}</figcaption>
</figure>
${script}${HEIGHT_SCRIPT}
</body></html>
`;
}

const appHtml = (doc) => doc.querySelector('.app').outerHTML.replace(/<!---->/g, '').replace(/>\s+</g, '> <');

// ---- skeleton parts ---------------------------------------------------------------------------------------------------------
// The figures are skeletons of the app: real pieces (the markup and rules the app ships) for the one feature a figure is about, bars
// and plain boxes for everything around them. A real piece the caption talks about carries a ring.
const sk = (w, cls = '') => `<i class="sk ${cls}" style="width:${w}%"></i>`;
const skLines = (...ws) => `<div class="skt">${ws.map((w) => sk(w)).join('')}</div>`;
const skUser = (w = 52) => `<div class="skuser" style="width:${w}%"></div>`;
const clean = (h) => h.replace(/<!---->/g, '');
const ring = (h) => `<div class="hlbox">${h}</div>`;
/** Adds the ring class to the elements `sel` matches in an html string. */
const mark = (html, sel) => { const b = parse(html); b.querySelectorAll(sel).forEach((e) => e.classList.add('hl')); return b.innerHTML; };
/** The captured row (a .vrow) of a fragment whose html holds `needle`. */
const rowWith = (frag, needle) => rowsOf(frag).find((r) => r.includes(needle));
const SK_CSS = `
.sk{display:block;height:8px;border-radius:4px;background:var(--line)}
.sk.s2{height:6px;margin-top:5px;opacity:.7}
.sk.hlbar{background:color-mix(in srgb,var(--accent) 35%,var(--line))}
.skt{display:flex;flex-direction:column;gap:8px;padding:6px 0}
.skuser{height:30px;margin:6px 0 6px auto;border-radius:14px 14px 4px 14px;background:var(--accent-soft);border:1px solid color-mix(in srgb,var(--accent) 30%,transparent)}
.skcol{padding:10px 16px;display:flex;flex-direction:column;gap:6px;min-width:0}
.hlbox,.hl{outline:1.5px solid var(--accent);outline-offset:3px;border-radius:12px}
.auto.hl{border-radius:4px;outline-offset:2px}
.win{position:relative;border:1px solid var(--line);border-radius:8px;background:var(--bg);overflow:hidden;min-width:0}
.win .transcript{overflow:visible;flex:none;padding:0}
.win .column{padding:6px 16px 8px!important;margin:0!important;max-width:none!important}
.win .vrow{content-visibility:visible}
.sbw{background:var(--bg-sunken);border-right:1px solid var(--line-soft);padding:10px 8px 12px;min-width:0}
.sbw .sidebar{width:100%!important;border:0!important;background:none!important;position:static!important;transform:none!important;box-shadow:none!important;height:auto!important;padding:0!important;z-index:auto!important;display:block}
.sbw .sksearch{height:30px;margin:0 2px 8px;border:1px solid var(--line);border-radius:8px;background:var(--bg);display:flex;align-items:center;padding:0 10px}
.sbw .list{overflow:visible!important;height:auto!important;flex:none!important;min-height:0!important;padding-bottom:6px!important}
.sbw{align-self:stretch}
.sbw .group{padding:0 !important}
.sbw .name .sk{display:inline-block;vertical-align:middle}
`;
const AUTO_TAG = load('auto-tag.json');

// callouts: numbered notes with thin leader lines; below 600 px the notes are a numbered list under the mock and the targets carry the numbers
const CALLOUT_CSS = `
.stage{position:relative;padding:12px}
.stage.wide{padding:44px 206px 14px 14px}
.notes{display:flex;flex-direction:column;gap:6px;margin-top:10px}
.note{font:11.5px/1.35 ui-monospace,"SF Mono",Menlo,monospace;color:var(--ink-dim)}
.note b{display:inline-grid;place-items:center;width:16px;height:16px;margin-right:6px;border-radius:50%;background:var(--accent);color:var(--bg);font:600 10px/1 var(--sans);vertical-align:1px}
.stage.wide .note{position:absolute;width:184px;margin:0}
.stage.wide .note[data-side=top]{width:auto;white-space:nowrap}
.stage.wide .notes{margin:0}
.lead{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible;color:var(--accent)}
.lead *{vector-effect:non-scaling-stroke}
.bdg{position:absolute;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:50%;background:var(--accent);color:var(--bg);font:600 10px/16px var(--sans);text-align:center;pointer-events:none}
`;
const CALLOUT_JS = `<script>(function(){
var st=document.querySelector('.stage'),svg=st.querySelector('svg.lead'),mock=st.querySelector('.mock2'),notes=[].slice.call(st.querySelectorAll('.note'));
function el(n,a){var e=document.createElementNS('http://www.w3.org/2000/svg',n);for(var k in a)e.setAttribute(k,a[k]);return e}
function lay(){
 [].slice.call(st.querySelectorAll('.bdg')).forEach(function(b){b.remove()});svg.innerHTML='';
 var wide=st.clientWidth>=600;st.classList.toggle('wide',wide);
 var S=st.getBoundingClientRect(),M=mock.getBoundingClientRect(),taken=[],ink=getComputedStyle(document.documentElement).getPropertyValue('--accent')||'#b45c6e';
 notes.forEach(function(n,i){
  var t=st.querySelector('[data-co="'+n.getAttribute('data-for')+'"]');if(!t)return;var T=t.getBoundingClientRect();
  if(!wide){var b=document.createElement('span');b.className='bdg';b.textContent=i+1;b.style.left=(T.left-S.left)+'px';b.style.top=(T.top-S.top)+'px';st.appendChild(b);n.style.cssText='';return}
  var w=n.offsetWidth,h=n.offsetHeight;
  if(n.getAttribute('data-side')==='top'){
   var cx=T.left+T.width/2-S.left,l=Math.max(4,Math.min(cx-10,S.width-w-4));n.style.left=l+'px';n.style.top='6px';
   svg.appendChild(el('line',{x1:cx,y1:6+h+2,x2:cx,y2:T.top-S.top-1,stroke:'currentColor','stroke-width':1}));svg.appendChild(el('circle',{cx:cx,cy:T.top-S.top-1,r:2.5,fill:'currentColor'}));
  }else{
   var y=T.top+T.height/2-S.top,top=Math.max(44,y-h/2);taken.forEach(function(p){if(top<p+0&&top+h>p-0){}});
   for(var k=0;k<taken.length;k++){if(top<taken[k].b+8&&top+h>taken[k].t-8)top=taken[k].b+8}
   taken.push({t:top,b:top+h});var nl=M.right-S.left+22;n.style.left=nl+'px';n.style.top=top+'px';
   var x1=T.right-S.left+3;
   svg.appendChild(el('path',{d:'M'+x1+' '+y+' L'+(M.right-S.left+8)+' '+y+' L'+(nl-4)+' '+(top+h/2),fill:'none',stroke:'currentColor','stroke-width':1}));svg.appendChild(el('circle',{cx:x1,cy:y,r:2.5,fill:'currentColor'}));
  }
 });
 if(window.parent!==window)parent.postMessage({tophatFigure:'height',px:Math.ceil(document.body.getBoundingClientRect().height)},'*');
}
addEventListener('load',lay);addEventListener('resize',lay);if(document.readyState==='complete')lay();
})()</script>`;

// ---- figures ----------------------------------------------------------------------------------------------------------------
const figures = {
  'auto-chat'() {
    const frag = load('frag/auto-chat.json');
    const doc = shellDoc();
    sidebar(doc, [], [
      { skeleton: [58, 40] },
      { title: 'Dana: walk the bathroom Thursday', preview: 'Dana wants Thursday at 2 and the latest plans (v3). I left a draft reply…', unread: true, auto: true },
      { skeleton: [46, 62] },
      { skeleton: [64, 34] }
    ]);
    const sb = doc.querySelector('aside.sidebar');
    sb.querySelector('header')?.remove(); sb.querySelector('.tools')?.remove();
    sb.querySelector('.auto').setAttribute('data-co', 'tag');
    sb.insertAdjacentHTML('afterbegin', '<div class="sksearch"><i class="sk" style="width:42%"></i></div>');
    const t = parse(transcriptHtml(frag));
    const eh = t.querySelector('.event-head'); eh.setAttribute('data-co', 'event'); eh.classList.add('hl');
    const reply = t.querySelector('.row.assistant'); reply.setAttribute('data-co', 'draft'); reply.classList.add('hl');
    const body = `<div class="stage">
<div class="win mock2"><div class="sbw">${clean(sb.outerHTML)}</div><div class="tcol">${clean(t.innerHTML)}</div></div>
<div class="notes">
<div class="note" data-for="tag" data-side="top"><b>1</b>auto tag: opened by an automated event</div>
<div class="note" data-for="event"><b>2</b>the event, one muted line; click to read it</div>
<div class="note" data-for="draft"><b>3</b>the draft waits unsent in the contact's own thread</div>
</div><svg class="lead" aria-hidden="true"></svg></div>`;
    const cssExtra = `
.mock2{display:grid;grid-template-columns:212px minmax(0,1fr);min-height:215px}
.tcol{min-width:0;padding:6px 0}
.tcol .row.assistant{margin:8px 0 6px;padding:2px 10px}
@media (max-width:600px){.mock2{grid-template-columns:1fr}.sbw{border-right:0;border-bottom:1px solid var(--line-soft)}}
${CALLOUT_CSS}`;
    return page({
      css: cssOf(shell, frag, AUTO_TAG),
      cssExtra: SK_CSS + cssExtra, script: CALLOUT_JS,
      body,
      note: 'the sidebar mark and the transcript lines that tell an automated chat, on skeleton surroundings',
      caption: '<b>Fig. 3</b>An auto chat. The sidebar tags a chat an automated event opened with a small auto tag and an unread dot. Inside, the event is one muted line, closed until you click it; the agent&#39;s tool calls fold into one line; its reply says the draft is waiting, unsent, in your thread with the contact. Everything else is left out. Names are made up.'
    });
  },
  'runner-qol'() {
    const F = (n) => load(`frag/${n}.json`);
    const a = F('qol-a'), b = F('qol-b'), c = F('qol-c'), f = F('qol-f'), h = F('qol-h'), side = F('side');
    const running = load('shell-running.json'), split = load('shell-split.json'), rich = load('shell-rich.json'), menu = load('menu.json');
    const chrome = mark(clean(new JSDOM(`<body>${running.html[0]}</body>`).window.document.querySelector('.chrome').outerHTML), '.interrupt');
    const slice = (rows, extra = '') => {
      const d = shellDoc();
      sidebar(d, [], rows);
      d.querySelectorAll('.sbw-x');
      const sb = d.querySelector('aside.sidebar');
      sb.querySelector('header')?.remove(); sb.querySelector('.tools')?.remove();
      sb.insertAdjacentHTML('afterbegin', '<div class="sksearch"><i class="sk" style="width:42%"></i></div>');
      return `<div class="sbw ${extra}">${clean(sb.outerHTML)}</div>`;
    };
    // d: one real row under the pointer (its row actions showing) and the real context menu, other rows skeleton
    const m = parse(menu.html[0]).querySelector('.qk-menu'); m.removeAttribute('style');
    // e: the real tab strips of a split, bodies skeleton
    const sd = new JSDOM(`<body>${split.html[0]}</body>`).window.document;
    sd.querySelectorAll('.pane-slot').forEach((slot, i) => {
      tabs(sd, i === 0 ? [{ title: 'invoice to Home', active: true }, { title: 'Plumbing' }] : [{ title: 'Plumbing', active: true }], slot);
      slot.querySelector('.group-body').innerHTML = `<div class="skcol">${skUser(46)}${skLines(78, 60)}${skLines(70)}</div>`;
    });
    // g: a widget frame, the body a small made-up widget
    const fig = parse(rich.html[0]).querySelector('figure');
    fig.querySelector('.title').textContent = 'Spend by month'; fig.querySelector('.title').setAttribute('title', 'Spend by month');
    fig.querySelector('a[aria-label="Download"]')?.removeAttribute('href');
    const wbody = fig.ownerDocument.createElement('div'); wbody.className = 'wbody';
    wbody.innerHTML = `<div class="bars" role="group" aria-label="spend by month"><button type="button" data-v="$180"><i style="height:38%"></i><span>Aug</span></button><button type="button" data-v="$240"><i style="height:52%"></i><span>Sep</span></button><button type="button" data-v="$410" class="on"><i style="height:88%"></i><span>Oct</span></button><button type="button" data-v="$95"><i style="height:20%"></i><span>Nov</span></button></div><p class="rd"><b>Oct</b> $410, plumbing and permits</p>`;
    fig.querySelector('iframe').replaceWith(wbody);
    const sideCard = parse(side.html[0]).querySelector('[data-testid="sidechat"]');
    const tile = (key, label, inner, extra = '') => `<div class="tile ${extra}-t"><p class="tl"><b>${key}</b>${label}</p><div class="win ${extra}">${inner}</div></div>`;
    const body = `<div class="qol">
${tile('a', 'compaction in the background', `<div class="skcol">${skUser(50)}${skLines(82, 64)}${ring(rowWith(a, 'compaction-card'))}${skLines(72, 40)}</div>`)}
${tile('b', 'sending while a turn runs', `<div class="skcol">${skLines(70, 52)}</div>${mark(transcriptHtml(b), '.bubble.queued')}${chrome}`, 'pane')}
${tile('c', 'an arrival opens its own chat', `${slice([{ skeleton: [58, 40] }, { title: 'Dana: walk the bathroom Thursday', preview: 'Dana wants Thursday at 2 and the latest plans…', unread: true, auto: true }])}<div class="skcol">${ring(rowWith(c, 'event-head'))}${skLines(86, 60)}</div>`.replace('class="auto', 'class="hl auto'), 'ctile')}
${tile('d', 'inbox tools', `${slice([{ title: 'Dana: walk the bathroom Thursday', preview: 'Dana wants Thursday at 2…', ago: '2m', hover: true }, { skeleton: [48, 66] }, { skeleton: [66, 36] }, { skeleton: [56, 44] }])}${clean(m.outerHTML)}`, 'sbtile')}
${tile('e', 'panes side by side', clean(sd.querySelector('.stage').outerHTML), 'split')}
${tile('f', 'a stop hook', `<div class="skcol">${skUser(44)}${skLines(78, 56)}${ring(rowWith(f, 'hook-card'))}${skLines(66, 34)}</div>`)}
${tile('g', 'a widget in the chat', `<div class="skcol">${skLines(80, 58)}${ring(clean(fig.outerHTML))}</div>`, 'gtile')}
${tile('h', 'a side chat on a passage', `<div class="skcol hleft"><div class="skt">${sk(92)}${sk(74, 'hlbar')}${sk(86)}${sk(60)}${sk(80)}</div></div><div class="sidewrap">${clean(sideCard.outerHTML)}</div>`, 'htile')}
</div>`;
    const cssExtra = `
.qol{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;padding:12px}
.tile{min-width:0;display:flex;flex-direction:column}
.split-t,.htile-t{grid-column:1/-1}
.tl{margin:0 0 5px;font:600 10.5px/1.2 ui-monospace,"SF Mono",Menlo,monospace;letter-spacing:.04em;color:var(--ink-faint)}
.tl b{color:var(--accent);margin-right:8px}
.win{flex:1 1 auto;display:flex;flex-direction:column;min-height:150px}
.win.pane .reading,.win.pane .transcript{flex:none}
.win.pane .chrome{flex:none}
.win.pane .run-row{position:absolute!important;right:16px;left:auto!important;bottom:62px;padding:0!important;height:auto!important;min-height:0!important;pointer-events:none}
.win.pane .run-row .right{transform:none!important;pointer-events:auto}
.win.pane .transcript{padding-bottom:34px}
.ctile{flex-direction:column}
.ctile .sbw{border-right:0;border-bottom:1px solid var(--line-soft)}
.sbtile{flex-direction:row;align-items:stretch}
.sbtile .sbw{flex:1 1 auto;border:0;min-height:190px}
.sbtile .qk-menu{position:absolute!important;left:44%!important;top:104px!important;max-height:none;z-index:60!important;transform:scale(.92);transform-origin:top left}
.split .stage{flex:1 1 0;min-width:0;display:flex;flex-direction:row;height:150px}
.split .stage>main{display:flex;flex:1 1 0;min-width:0}
.split .pane-slot{flex:1 1 0;min-width:0}
.split .group-body{background:var(--bg);display:block!important}
.split .group-body .skcol{padding:14px 16px}
.wbody{background:var(--bg-raised);padding:12px 14px;height:136px;box-sizing:border-box;font:12.5px/1.4 var(--sans);color:var(--ink)}
.wbody .bars{display:flex;gap:10px;align-items:flex-end;height:80px}
.wbody .bars button{flex:1;height:100%;display:flex;flex-direction:column;justify-content:flex-end;align-items:stretch;gap:4px;font:11px var(--sans);color:var(--ink-faint);cursor:pointer}
.wbody .bars i{display:block;border-radius:4px 4px 0 0;background:color-mix(in srgb,var(--accent) 35%,var(--bg-sunken))}
.wbody .bars .on i{background:var(--accent)}
.wbody .bars span{text-align:center}
.wbody .rd{margin:8px 0 0;font:12px var(--mono);color:var(--ink-dim)}
.gtile .skcol figure{margin:.4rem 0}
.htile{flex-direction:row;background:var(--bg)}
.hleft{flex:1 1 0;justify-content:center}
.sidewrap{flex:0 0 min(46%,320px);padding:10px;align-self:flex-start}
.sidewrap .card{box-shadow:0 2px 10px rgb(0 0 0 / .1)}
@media (max-width:600px){.qol{grid-template-columns:1fr;padding:8px}.htile{flex-direction:column}.sidewrap{flex:none}}
`;
    const script = `<script>(function(){var bars=document.querySelectorAll('.wbody .bars button'),rd=document.querySelector('.wbody .rd');bars.forEach(function(b){b.addEventListener('click',function(){bars.forEach(function(x){x.classList.remove('on')});b.classList.add('on');rd.innerHTML='<b>'+b.querySelector('span').textContent+'</b> '+b.dataset.v})})})()</script>`;
    return page({
      css: cssOf(shell, a, b, c, f, h, side, running, split, rich, menu, AUTO_TAG),
      cssExtra: SK_CSS + cssExtra, script,
      body: `<div class="art">${body}</div>`,
      note: 'eight chat features, each the app\'s real piece (ringed) on skeleton surroundings',
      caption: '<b>Fig. 2</b>The chat interface, one feature at a time. The ringed part of each tile is the app&#39;s own; the grey bars stand for everything else. a. A background compaction is one quiet line. b. A message sent mid-run shows as queued, with the stop button and a long command backgrounded. c. An arrival opens its own chat, tagged auto. d. Hover a row for its actions; the right-click menu files, sets aside, defers or archives. e. Panes side by side (⌘⇧↵ opens a new chat in a second pane). f. A stop hook card. g. A widget in a frame with source, expand and download. h. A side chat on a passage.'
    });
  },
  'runner-turn'() {
    const done = rowsOf(load('frag/turn.json')), live = rowsOf(load('frag/turn-run.json'));
    const frag = load('frag/turn.json'), running = load('shell-running.json'), shellDoc2 = new JSDOM(`<body>${running.html[0]}</body>`).window.document;
    const chromeRun = shellDoc2.querySelector('.chrome').outerHTML.replace(/<!---->/g, '');
    const idle = shellDoc();
    const chromeIdle = idle.querySelector('.chrome').outerHTML.replace(/<!---->/g, '');
    const t = parse(frag.html[0]).querySelector('[data-testid="transcript"]');
    t.removeAttribute('style');
    t.querySelector('.column').innerHTML = '';
    const script = `<script>
var DONE=${JSON.stringify(done)},LIVE=${JSON.stringify(live)},CH=[${JSON.stringify(chromeRun)},${JSON.stringify(chromeIdle)}];
/* [ms after the previous step, row index, shows the running frame first] the rows are the app's own, in the order the turn produced them */
var S=[[300,0,0],[650,1,0],[500,2,1],[800,3,1],[750,4,1],[650,5,1],[750,6,1],[600,7,0]];
var col=document.querySelector('.column'),ch=document.getElementById('chrome'),reduce=matchMedia('(prefers-reduced-motion:reduce)').matches,run=0,timers=[];
function play(){run++;var me=run;timers.forEach(clearTimeout);timers=[];col.innerHTML='';ch.innerHTML=CH[0];var at=0;
 S.forEach(function(s,i){at+=reduce?0:s[0];timers.push(setTimeout(function(){if(me!==run)return;var d=document.createElement('div');d.innerHTML=s[2]?LIVE[s[1]]:DONE[s[1]];var el=d.firstElementChild;el.classList.add('fadein');col.appendChild(el);
  if(s[2])timers.push(setTimeout(function(){if(me!==run)return;var n=document.createElement('div');n.innerHTML=DONE[s[1]];el.replaceWith(n.firstElementChild)},reduce?0:600));
  if(i===S.length-1)timers.push(setTimeout(function(){if(me===run)ch.innerHTML=CH[1]},reduce?0:700));
  var sc=document.querySelector('.transcript');sc.scrollTop=sc.scrollHeight},at))});}
document.getElementById('re').onclick=play;play();
</script>`;
    const cssExtra = `
.mock{--mock-h:520px;display:flex;flex-direction:column}
.mock .transcript{flex:1 1 0;min-height:0;overflow:hidden;display:flex;flex-direction:column;justify-content:flex-end}
.mock .chrome{flex:none}
.fadein{animation:rise var(--panel) var(--ease) both}
#re{position:absolute;right:10px;top:8px;font:11px var(--mono);color:var(--ink-faint);border-bottom:1px solid var(--line);z-index:3;cursor:pointer}
@media (prefers-reduced-motion:reduce){.fadein{animation:none}}
`;
    return page({
      css: cssOf(shell, frag, load('frag/turn-run.json'), running),
      cssExtra, script,
      body: `<div class="mock"><button id="re" type="button">replay</button>${t.outerHTML.replace(/<!---->/g, '')}<div id="chrome"></div></div>`,
      note: 'one turn as the chat draws it, replayed from the app\'s own rows',
      caption: '<b>Fig. 2</b>One turn in the chat, replayed row by row. While it runs the composer reads Correct it mid-run… and shows a stop button; a message sent meanwhile is marked queued until the turn takes it. A subagent appears as one card inside the turn. Names and files are made up.'
    });
  },
  'mac-apps'() {
    const APPS = [['contacts', 'Contacts', 1], ['calendar', 'Calendar', 1], ['notes', 'Notes', 1], ['messages', 'iMessage', 1], ['browser', 'Browser', 0], ['findmy', 'Find My', 0], ['shortcuts', 'Shortcuts', 0], ['home', 'Apple Home', 0]];
    const frags = Object.fromEntries(APPS.map(([k]) => [k, load(`frag/app-${k}.json`)]));
    const icons = load('mac-icons.json');   // the dock's app icons, as the figure always drew them (SVG inner markup)
    const html = Object.fromEntries(APPS.map(([k]) => [k, transcriptHtml(frags[k])]));
    const script = `<script>
var ICON=${JSON.stringify(icons)};
var A=${JSON.stringify(APPS)},T=${JSON.stringify(html)};
var dock=document.getElementById('dock'),pane=document.getElementById('pane'),where=document.getElementById('where'),nm=document.getElementById('app');
A.forEach(function(a,i){var b=document.createElement('button');b.type='button';b.className='ic';b.id='k-'+a[0];b.setAttribute('aria-label',a[1]);b.setAttribute('aria-pressed','false');
 b.innerHTML='<svg viewBox="0 0 48 48" aria-hidden="true">'+ICON[a[0]]+'</svg><u class="'+(a[2]?'pub':'')+'"></u>';
 b.addEventListener('click',function(){show(i,true)});dock.appendChild(b)});
var cur=-1,auto=true,timer=null;
function show(i,manual){if(manual){auto=false;clearTimeout(timer)}cur=i;var a=A[i];
 dock.querySelectorAll('.ic').forEach(function(b,j){b.setAttribute('aria-pressed',j===i)});
 nm.textContent=a[1];where.innerHTML='<i class="'+(a[2]?'pub':'')+'"></i>'+(a[2]?'in the public repo':'full system only');pane.innerHTML=T[a[0]];var tc=pane.querySelector('[data-testid=tool-card]');if(tc)tc.classList.add('hl');}
function tick(){if(!auto)return;show((cur+1)%A.length);timer=setTimeout(tick,3200)}
show(0);if(!matchMedia('(prefers-reduced-motion:reduce)').matches)timer=setTimeout(tick,3200);
</script>`;
    const cssExtra = `
body{font:13px/1.45 var(--sans)}
.art{padding:14px 16px 12px;display:flex;flex-direction:column;gap:10px}
.head2{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
.appname{font-size:22px;font-weight:300;letter-spacing:-.01em;line-height:1.1;color:var(--ink)}
.where{color:var(--ink-faint);font-size:12px;display:flex;align-items:center;gap:7px}
.where i{width:7px;height:7px;border-radius:50%;border:1.5px solid var(--ink-faint);display:inline-block}
.where i.pub{background:var(--ink);border-color:var(--ink)}
.win{border:1px solid var(--line);border-radius:8px;background:var(--bg);height:215px;overflow:hidden;display:flex;flex-direction:column}
.win .transcript{flex:1 1 0;min-height:0;overflow:hidden}
.win .column{padding-bottom:8px!important}
.dock{align-self:center;display:flex;align-items:flex-end;gap:9px;padding:8px 10px 6px;background:var(--bg-sunken);border:1px solid var(--line);border-radius:18px;max-width:100%;flex-wrap:wrap;justify-content:center}
.ic{position:relative;display:flex;flex-direction:column;align-items:center;gap:5px;border:0;background:none;padding:0;cursor:pointer}
.ic svg{width:44px;height:44px;display:block;transition:transform .16s var(--ease);transform-origin:50% 100%}
.ic:hover svg,.ic:focus-visible svg,.ic[aria-pressed=true] svg{transform:translateY(-5px) scale(1.1)}
.ic:focus-visible{outline:2px solid var(--accent);outline-offset:3px;border-radius:12px}
.ic u{width:5px;height:5px;border-radius:50%;border:1.3px solid var(--ink-faint);display:block;text-decoration:none}
.ic u.pub{background:var(--ink);border-color:var(--ink)}
@media (max-width:560px){.ic svg{width:32px;height:32px}.dock{gap:5px;padding:6px 6px 5px}.win{height:240px}}
@media (prefers-reduced-motion:reduce){.ic svg{transition:none}}
`;
    return page({
      css: cssOf(shell, ...Object.values(frags)),
      cssExtra, script,
      body: `<div class="art"><div class="head2"><div class="appname" id="app"></div><div class="where" id="where"></div></div><div class="win"><div id="pane"></div></div><div class="dock" id="dock" role="group" aria-label="apps the agent can reach"></div></div>`,
      note: 'a dock of Mac apps; each opens one chat exchange drawn with the app\'s own components',
      caption: '<b>Fig. 3</b>The apps the agent can reach on a Mac. Pick one to see a chat exchange that uses it, drawn with the chat&#39;s own message and tool-call rows. The ringed row is the tool call the app shows. A filled dot marks what ships in the public repo; a hollow dot is in the full system only. Names and data are made up.'
    });
  }
};

const want = process.argv.slice(2);
for (const [name, make] of Object.entries(figures)) {
  if (want.length && !want.includes(name)) continue;
  writeFileSync(path.join(WIDGETS, `${name}.html`), make());
  console.log('wrote', `${name}.html`);
}
