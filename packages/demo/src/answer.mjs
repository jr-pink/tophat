// The words of the site, from one file: content/description.md (marked with <!-- intro -->, <!-- feature:NN -->, <!-- install -->).
// The scripted first answer is those sections with a widget after each feature; the no-JavaScript / failed-captcha page is the
// same sections with no widgets. Nothing here copies the text anywhere else.
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const OPENER_TEXT = 'so whats ur deal ?';
/**
 * The visitor-side typing of the opener: the gap in ms before each character of OPENER_TEXT (the first is 0), replayed exactly.
 * Recorded from the owner's own keystrokes for this phrase (webchat typing telemetry, 2026-11-10 19:42:14.829Z).
 */
export const OPENER_GAPS_MS = [0, 68, 76, 348, 91, 16, 92, 56, 15, 62, 91, 55, 122, 59, 31, 59, 60, 136];

/** { lead, intro, features: [{ n, body }], install } from description.md. */
export function sections(file) {
  const raw = readFileSync(file, 'utf8');
  const parts = raw.split(/^<!--\s*([\w:]+)\s*-->\s*$/m);
  const lead = parts[0].replace(/^#[^\n]*\n/, '').trim();
  const out = { lead, intro: '', features: [], install: '' };
  for (let i = 1; i < parts.length; i += 2) {
    const key = parts[i], body = (parts[i + 1] || '').trim();
    if (key === 'intro') out.intro = body;
    else if (key === 'install') out.install = body;
    else if (key.startsWith('feature:')) out.features.push({ n: key.slice(8), body });
  }
  return out;
}

/** The widget for each feature, by number: file name in the widgets directory and the label the chat shows above it. */
export const WIDGETS = {
  // the title is the label the chat shows above the figure; each widget carries its own figure caption underneath (widgets/*.html)
  '01': ['memory-graph.html', 'Memory graph'],
  '02': ['runner-turn.html', 'Runner turn'],
  '03': ['mac-apps.html', 'macOS apps'],
  '04': ['connectors.html', 'Connectors'],
  '05': ['sharing.html', 'Sharing'],
  '06': ['local.html', 'What runs where']
};

/** The scripted answer in markdown: the page's words, each feature followed by its widget (an image-style line the app renders in place). */
export function openerAnswer(file, widgetsDir) {
  const s = sections(file);
  const blocks = [s.lead, s.intro];
  for (const f of s.features) {
    blocks.push(f.body);
    const w = WIDGETS[f.n];
    if (w) blocks.push(`![${w[1]}](${path.join(widgetsDir, w[0])})`);
  }
  blocks.push(s.install);
  return blocks.filter(Boolean).join('\n\n');
}

/**
 * Pieces for a model-like stream: each block cut into token-sized deltas (a word, or a few letters of a long one, with its leading space;
 * punctuation on its own), the way a model's text deltas arrive, and an image line or a code fence never split (a half-written `![`
 * would flash as text). Concatenated, the pieces are the markdown exactly.
 */
export function pieces(markdown) {
  const out = [];
  const blocks = markdown.split(/\n{2,}/);
  blocks.forEach((b, bi) => {
    const tail = bi < blocks.length - 1 ? '\n\n' : '';
    if (/^!\[|^```/.test(b)) { out.push(b + tail); return; }
    const toks = b.match(/\s*[\p{L}\p{N}']{1,6}|\s*[^\p{L}\p{N}'\s]|\s+/gu) || [b];
    toks.forEach((t, ti) => out.push(ti === toks.length - 1 ? t + tail : t));
  });
  return out;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const slug = (t, seen) => { let b = String(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'section', n = b, i = 2; while (seen.has(n)) n = `${b}-${i++}`; seen.add(n); return n; };

/** Splits markdown at its ## and ### headings (never inside a code fence): [{ level, title, body }], the text before the first heading as level 0. */
function chunks(md) {
  const out = [{ level: 0, title: '', body: [] }];
  let fence = false;
  for (const line of String(md).split('\n')) {
    if (/^```/.test(line)) fence = !fence;
    const h = !fence && /^(#{2,3})\s+(.*)$/.exec(line);
    if (h) out.push({ level: h[1].length, title: h[2].trim(), body: [] }); else out.at(-1).body.push(line);
  }
  return out.map((c) => ({ ...c, body: c.body.join('\n').trim() }));
}

/** Title, description and Open Graph / Twitter tags of the site, from the description's own lead (no claim is written here). */
export const SITE_URL = 'https://tophat.md';
export function metaTags(file) {
  const lead = sections(file).lead.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
  const [tagline, ...rest] = lead.split(/(?<=[.!?])\s+/);
  const desc = esc(lead), title = 'tophat';
  return `<meta name="description" content="${desc}"><meta property="og:type" content="website"><meta property="og:site_name" content="${title}"><meta property="og:title" content="${title}: ${esc(tagline.replace(/[.!?]$/, ''))}"><meta property="og:description" content="${esc(rest.join(' ') || lead)}"><meta property="og:url" content="${SITE_URL}/"><meta property="og:image" content="${SITE_URL}/og.png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${title}"><meta name="twitter:description" content="${desc}"><meta name="twitter:image" content="${SITE_URL}/og.png">`;
}

/**
 * The page for a visitor whose JavaScript is off or whose human check failed: the whole description and the whole technical reference as
 * server-rendered prose with a table of contents, so a person (or their own agent) reading it gets everything the live demo would.
 * With JavaScript on and a session, a visible Turnstile widget returns them to the live chat once they pass it.
 */
export function textPage({ file, contextFile, repo, markdown, why = 'check', siteKey = '', canVerify = false }) {
  const md = (t) => markdown(t).map((b) => b.html).join('');
  const seen = new Set(), toc = [], body = [];
  const s = sections(file);
  const lead = s.lead.replace(/\*\*/g, '').split(/\n\s*\n|(?<=\.)\s+/).map((x) => x.trim()).filter(Boolean);
  const add = (title, level, text, id) => { body.push((title ? `<h${level} id="${id}">${esc(title)}</h${level}>` : '') + md(text)); };
  // the description: its intro and features, then the install block
  body.push(`<h1>${esc(lead[0] || 'tophat')}</h1><p class="sub">${esc(lead.slice(1).join(' '))}</p>`);
  const description = readFileSync(file, 'utf8').replace(/^#[^\n]*\n/, '').replace(/^<!--[^>]*-->\s*$/gm, '').replace(/^Your exobrain[^\n]*\n+/, '');
  const part = (heading, md0, level) => { for (const c of chunks(md0)) { const id = c.title ? slug(c.title, seen) : ''; if (c.title) toc.push({ level: c.level, title: c.title, id }); add(c.title, c.level === 3 ? 3 : 2, c.body, id); } };
  part('description', description);
  if (contextFile) {
    const ctx = readFileSync(contextFile, 'utf8');
    const first = /^#\s+(.*)$/m.exec(ctx);
    const idc = slug(first ? first[1] : 'technical reference', seen); toc.push({ level: 1, title: first ? first[1] : 'Technical reference', id: idc });
    body.push(`<h2 id="${idc}">${esc(first ? first[1] : 'Technical reference')}</h2>`);
    part('context', ctx.replace(/^#\s+.*\n/, ''));
  }
  const install = s.install.replace(/^#+\s.*\n+/, '').replace(/```/g, '').trim();
  const reason = why === 'preview' ? '' : why === 'nojs' ? 'looks like JavaScript is off in this browser' : why === 'limit' ? 'this address has opened a lot of live demos today, so here is a textual description instead' : 'looks like you failed the captcha (or have JavaScript off)';
  const live = why === 'nojs' ? '<p>To use the live chat, turn JavaScript on and reload.</p>'
    : (why === 'check' && canVerify && siteKey) ? `<div id="back"><p><b>Click to verify and go back to the live chat.</b></p><div id="ts"></div><p id="msg" class="sub"></p></div>` : '';
  const tocHtml = `<nav aria-label="contents"><h2>Contents</h2><ol>${toc.filter((t) => t.level <= 2).map((t) => `<li><a href="#${t.id}">${esc(t.title)}</a></li>`).join('')}</ol></nav>`;
  const script = (why === 'check' && canVerify && siteKey) ? `<script>(function(){var k=${JSON.stringify(siteKey)},m=document.getElementById('msg');function go(t){fetch('/_demo/session',{method:'POST',credentials:'same-origin'}).then(function(){return fetch('/_demo/verify',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({turnstile:t})})}).then(function(r){if(r.ok){m.textContent='verified, taking you back';location.replace('/')}else{m.textContent='that did not verify; try again';window.turnstile.reset()}}).catch(function(){m.textContent='that did not go through; try again'})}
var s=document.createElement('script');s.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';s.async=true;s.onload=function(){window.turnstile.render('#ts',{sitekey:k,appearance:'always',callback:go,'error-callback':function(e){m.textContent='the check could not run ('+e+'); reload to try again';return true}})};s.onerror=function(){m.textContent='the check could not load; reload to try again'};document.head.appendChild(s)})();</script>` : '';
  const copy = `<script>(function(){var p=document.getElementById('install'),c=p&&p.parentNode;if(!c)return;var b=document.createElement('button');b.type='button';b.textContent='copy';b.onclick=function(){var t=p.textContent,d=function(){b.textContent='copied';setTimeout(function(){b.textContent='copy'},1200)};if(navigator.clipboard)navigator.clipboard.writeText(t).then(d,function(){});else{var r=document.createRange();r.selectNodeContents(p);getSelection().removeAllRanges();getSelection().addRange(r)}};c.appendChild(b)})();</script>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>tophat: description and technical reference</title>${metaTags(file)}<meta name="color-scheme" content="light dark">
<link rel="icon" type="image/svg+xml" href="/favicon.svg"><link rel="apple-touch-icon" href="/apple-touch-icon.png">
<style>:root{--bg:#f3ecd8;--ink:#1b1a18;--dim:#5d5848;--line:#cfc6aa;--box:#ebe2c8}@media (prefers-color-scheme:dark){:root{--bg:#141311;--ink:#e8e2d0;--dim:#a39d8a;--line:#34312b;--box:#1c1b18}}
*{box-sizing:border-box}html{background:var(--bg);color:var(--ink)}body{margin:0;padding:clamp(20px,6vw,64px) 18px 100px;font:15px/1.65 ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,monospace}
main{max-width:68ch;margin:0 auto}h1{font:inherit;font-weight:700;font-size:1.25em;margin:0 0 .2em}h2{font:inherit;font-weight:700;margin:2.2em 0 .6em;font-size:1.08em}h3{font:inherit;font-weight:700;margin:1.6em 0 .5em;color:var(--dim)}p{margin:0 0 1em}ul,ol{margin:0 0 1em;padding-left:2ch}li{margin:0 0 .35em}.sub{color:var(--dim)}
.note{border:1px solid var(--line);background:var(--box);padding:10px 14px;margin:0 0 2em}.code{position:relative;margin:0 0 1.4em}pre{margin:0 0 1em;padding:12px 14px;background:var(--box);border:1px solid var(--line);white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;font-size:.93em}.code pre{margin:0}code{font:inherit}
.code a{color:inherit}nav{border:1px solid var(--line);padding:6px 14px;margin:0 0 2em}nav h2{margin:.4em 0}nav ol{margin:0 0 .6em}#back{border:1px solid var(--ink);padding:10px 14px;margin:0 0 2em}#back p{margin:0 0 .6em}
table{border-collapse:collapse;max-width:100%;display:block;overflow-x:auto;margin:0 0 1em}td,th{border:1px solid var(--line);padding:3px 8px;text-align:left;vertical-align:top}</style></head>
<body><main>${reason ? `<p class="note">${reason}. Below is a textual version of what the live demo shows, and the technical reference its agent answers from. ${repo ? `The code is at <a href="${esc(repo)}">${esc(repo)}</a>.` : ''}</p>` : ''}${live}
<h2 id="install-block">Install</h2><div class="code"><pre id="install">${esc(install)}</pre></div>${tocHtml}${body.join('\n')}</main>${copy}${script}</body></html>`;
}
