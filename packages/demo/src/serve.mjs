// The public surface of the demo: one page with the sample chats on the left, the open chat in the middle and, in the
// split pane, the chat "show me the current memory graph" over the live memory graph (the viewer, reading the published
// snapshot of the instance's memory). Everything is GET: answers are the cached results of real turns (ask.mjs), the
// graph is the snapshot seed.mjs publishes, so a visitor spends no model budget and writes nothing. The instance's
// webchat itself stays on loopback and is never proxied.
//
// Embeddable: frame-ancestors from the config (`frameAncestors`), no cookies, no auth wall. The page is server-rendered
// with every chat in it, so the first paint needs one request; the graph frame loads beside it.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEBCHAT = path.resolve(HERE, '../../webchat/src');
const { compileMarkdown, escapeHtml: esc } = await import(path.join(WEBCHAT, 'lib/core/markdown.js'));

const TYPES = { '.js': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.css': 'text/css; charset=utf-8' };
const etagOf = (b) => `"${createHash('sha256').update(b).digest('hex').slice(0, 20)}"`;

/** The product's own message styles: the webchat's app.css without the utility-framework import. */
function productCss() {
  try { return readFileSync(path.join(WEBCHAT, 'app.css'), 'utf8').replace(/@import[^;]*;/g, ''); } catch { return ''; }
}

const REPO = 'https://github.com/tophat-md/tophat';
export const ONBOARD = (repo) => `${repo}\nThis repo is a fully local agent memory system and runner (except model providers). Scan the repo for privacy, security, and malintent, then help me install it and fully set it up.`;
const md = (text) => compileMarkdown(String(text || '')).map((b) => `<div>${b.html}</div>`).join('');
const day = (iso) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Los_Angeles' }) : '');
const toolLine = (t) => {
  let what = '';
  try { const i = JSON.parse(t.input || '{}'); what = i.query || i.q || i.path || i.file || i.id || i.pattern || ''; } catch { what = ''; }
  return `<li>${esc(t.tool || 'tool')}${what ? ` <span>${esc(String(what).slice(0, 80))}</span>` : ''}</li>`;
};

export function loadCache(c) {
  const out = {};
  for (const s of c.slots) { const f = path.join(c.cache, `${s.id}.json`); if (existsSync(f)) { try { out[s.id] = JSON.parse(readFileSync(f, 'utf8')); } catch { /* torn: skip */ } } }
  return out;
}

const seedOf = (c, cache, s) => {
  const e = cache[s.id];
  return { id: s.id, title: s.title, pinned: s.id === c.pinned, daily: Boolean(s.daily), at: e?.at || null, model: e?.model || null, prompt: e?.prompt || s.prompt, answer: e?.answer || '', html: e ? md(e.answer) : '', tools: (e?.tools || []).map((t) => t.tool) };
};

/** The whole page, server-rendered with the seeded chats in it; the script makes it interactive. */
export function page(c, cache, selected) {
  const listed = [...c.slots.filter((s) => s.id === c.pinned), ...c.slots.filter((s) => s.id !== c.pinned)];
  const seeds = listed.map((s) => seedOf(c, cache, s));
  const sel = seeds.find((s) => s.id === selected) || seeds[0];
  const graph = seeds.find((s) => s.id === c.graphSlot);
  const v = c.visitors || {};
  const boot = { seeds, selected: sel.id, graph: c.graphSlot, cap: v.turnsPerSession ?? 5, siteKey: c.turnstile?.siteKey || '', download: c.downloadUrl || REPO };
  const seedView = (s) => `<header><h1>${esc(s.title)}</h1><p class="meta">${s.daily ? 'refreshed daily · ' : ''}${s.at ? `answered ${esc(day(s.at))}${s.model ? ` by ${esc(s.model)}` : ''}` : 'not answered yet'}</p></header><div class="turn user"><div class="bubble">${esc(s.prompt)}</div></div><div class="turn assistant"><div class="prose">${s.html}</div></div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>tophat · live demo</title><meta name="color-scheme" content="light dark">
<link rel="preload" href="graph/snapshot.json" as="fetch" crossorigin="anonymous">
<style>${productCss()}
body{margin:0;height:100%;overflow:hidden}
.demo{display:grid;grid-template-columns:232px minmax(0,1fr) minmax(0,44%);height:100vh;height:100dvh}
nav.side{border-right:1px solid var(--line);background:var(--bg-sunken);display:flex;flex-direction:column;min-height:0}
.brand{padding:14px 14px 10px;font:600 15px/1.2 var(--sans);display:flex;align-items:baseline;gap:8px}
.brand small{font:500 10.5px/1 var(--mono);color:var(--ink-faint);text-transform:uppercase;letter-spacing:.08em}
.newchat{margin:0 10px 8px;padding:7px 10px;border:1px solid var(--line);border-radius:8px;font:14px var(--sans);text-align:left;background:var(--bg-raised)}
.list{overflow:auto;padding:0 6px 10px;flex:1}
.list h2{font:600 10.5px/1 var(--mono);color:var(--ink-faint);text-transform:uppercase;letter-spacing:.08em;margin:12px 9px 6px}
.list a{display:block;padding:7px 9px;border-radius:8px;color:var(--ink);text-decoration:none;font:14px/1.3 var(--sans);margin-bottom:2px;cursor:pointer}
.list a:hover{background:var(--line-soft)}.list a.on{background:var(--bg-raised);box-shadow:0 0 0 1px var(--line)}
.list .pin{display:block;font:10.5px/1.4 var(--mono);color:var(--accent);text-transform:uppercase;letter-spacing:.06em}
.list .d{display:block;font:11.5px/1.4 var(--sans);color:var(--ink-faint)}
.foot{padding:10px 14px;font:11.5px/1.45 var(--sans);color:var(--ink-faint);border-top:1px solid var(--line-soft)}
main.center{display:flex;flex-direction:column;min-width:0;min-height:0;position:relative}
.scroll{overflow:auto;flex:1;min-height:0}
.chat{padding:22px var(--column-gutter) 30px;max-width:var(--column);margin:0 auto}
.chat header h1{font:600 17px/1.3 var(--sans);margin:0}.meta{margin:3px 0 0;font:12px/1.4 var(--sans);color:var(--ink-faint)}
.turn{margin-top:18px}.turn.user{display:flex;justify-content:flex-end}
.bubble{background:var(--bg-raised);border:1px solid var(--line);border-radius:14px;padding:8px 13px;max-width:85%;font:15px/1.45 var(--sans);white-space:pre-wrap}
.steps{font:12px/1.45 var(--mono);color:var(--ink-faint);margin-bottom:8px}
.thinking{color:var(--ink-faint);font:14px var(--sans)}
.composer{flex:none;padding:10px var(--column-gutter) 14px;max-width:var(--column);width:100%;margin:0 auto;position:relative}
.composer form{display:flex;gap:8px;align-items:flex-end;border:1px solid var(--line);border-radius:14px;background:var(--bg-raised);padding:6px 6px 6px 12px}
.composer textarea{flex:1;border:0;background:none;color:var(--ink);font:15px/1.45 var(--sans);resize:none;outline:none;min-height:24px;max-height:160px;padding:4px 0}
.composer button{background:var(--ink);color:var(--bg);border-radius:10px;padding:6px 12px;font:600 13.5px var(--sans)}
.composer button:disabled{opacity:.4;cursor:default}
.left{font:11.5px var(--sans);color:var(--ink-faint);margin:5px 4px 0;display:flex;justify-content:space-between}
#ts{position:absolute;bottom:100%;left:var(--column-gutter)}
.limit{position:absolute;inset:0;display:none;align-items:center;justify-content:center;background:color-mix(in srgb,var(--bg) 62%,transparent);backdrop-filter:grayscale(1);-webkit-backdrop-filter:grayscale(1);z-index:5}
.limit .card{background:var(--bg-raised);border:1px solid var(--line);border-radius:12px;padding:16px 18px;box-shadow:0 6px 30px #0002;max-width:min(560px,92%);max-height:92%;overflow:auto}
.limit .line{display:block;font:600 17px/1.4 var(--sans);color:var(--ink);text-decoration:none}
.limit .code{margin-top:12px}
.limit .code{position:relative;background:var(--bg-sunken);border:1px solid var(--line);border-radius:8px}
.limit pre{margin:0;padding:10px 12px;padding-right:64px;font:12.5px/1.5 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere;color:var(--ink)}
.limit #copy{position:absolute;top:6px;right:6px;font:600 12px var(--sans);border:1px solid var(--line);border-radius:6px;padding:3px 8px;background:var(--bg-raised)}
.done .limit{display:flex}.done .scroll,.done .composer{filter:grayscale(1);opacity:.45;pointer-events:none}
aside.split{border-left:1px solid var(--line);display:flex;flex-direction:column;min-width:0;min-height:0}
.gchat{padding:8px 14px 10px;border-bottom:1px solid var(--line);max-height:36%;overflow:auto;flex:none}
.gchat .turn{margin-top:6px}.gchat .prose{font-size:14px;margin-top:6px}.gchat a{font:12px var(--sans);color:var(--accent);cursor:pointer}
.gframe{flex:1;min-height:0;position:relative;background:#efe6cc}.gframe iframe{position:absolute;inset:0;width:100%;height:100%;border:0}
.tabs{display:none}
@media (max-width:760px){
 .demo{grid-template-columns:1fr;grid-template-rows:auto minmax(0,1fr)}
 .tabs{display:flex;border-bottom:1px solid var(--line);background:var(--bg-sunken)}
 .tabs button{flex:1;padding:10px 0;font:600 13.5px var(--sans);color:var(--ink-dim);border-bottom:2px solid transparent}
 .tabs button.on{color:var(--ink);border-bottom-color:var(--accent)}
 nav.side,main.center,aside.split{display:none!important;border:0}
 .demo[data-tab=chats] nav.side,.demo[data-tab=chat] main.center,.demo[data-tab=graph] aside.split{display:flex!important}
 .chat{padding-top:14px}.prose{font-size:15.5px}
}
</style></head><body>
<div class="demo" data-tab="chat">
<div class="tabs"><button data-tab="chats">Chats</button><button data-tab="chat" class="on">Chat</button><button data-tab="graph">Memory graph</button></div>
<nav class="side"><div class="brand">tophat <small>live demo</small></div><button class="newchat" id="new">+ New chat</button><div class="list" id="list"></div>
<div class="foot">A running tophat instance for its dev group. Ask it about tophat; it answers from the group's memory. ${boot.cap} turns per visitor.</div></nav>
<main class="center" id="center"><div class="scroll" id="scroll"><article class="chat" id="chat">${seedView(sel)}</article></div>
<div class="composer"><div id="ts"></div><form id="form"><textarea id="text" rows="1" placeholder="Ask about tophat" aria-label="message"></textarea><button id="send" type="submit">Send</button></form><div class="left"><span id="left">${boot.cap} turns left</span><span id="note"></span></div></div>
<div class="limit"><div class="card"><a class="line" href="${esc(boot.download)}" target="_blank" rel="noopener">ok you'll have to download yourself to try it</a><div class="code"><pre id="onboard">${esc(ONBOARD(boot.download))}</pre><button type="button" id="copy">Copy</button></div></div></div></main>
<aside class="split"><div class="gchat" id="gchat">${graph ? `<div class="turn user"><div class="bubble">${esc(graph.title)}</div></div><div class="prose">${graph.html}</div><a data-open="${esc(graph.id)}">continue this chat</a>` : ''}</div><div class="gframe"><iframe id="graph" src="graph" title="memory graph" loading="eager"></iframe></div></aside>
</div>
<script>window.__DEMO=${JSON.stringify(boot).replace(/</g, '\\u003c')}</script>
<script src="demo.js" defer></script>
${boot.siteKey ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit" async defer></script>' : ''}
</body></html>`;
}

const readBody = (req, max = 16384) => new Promise((resolve, reject) => {
  let n = 0; const parts = [];
  req.on('data', (d) => { n += d.length; if (n > max) { reject(new Error('too large')); req.destroy(); } else parts.push(d); });
  req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')); } catch { reject(new Error('bad json')); } });
  req.on('error', reject);
});
const cookieOf = (req, name) => { for (const p of String(req.headers.cookie || '').split(/;\s*/)) { const i = p.indexOf('='); if (i > 0 && p.slice(0, i) === name) return decodeURIComponent(p.slice(i + 1)); } return null; };
const COOKIE = 'tophat_demo';

export async function serve(c) {
  const { Visitors, verifyTurnstile } = await import('./visitor.mjs');
  const visitors = new Visitors(c);
  const turnstileSecret = c.turnstile?.secretFile ? readFileSync(c.turnstile.secretFile, 'utf8').trim() : null;
  const ancestors = ["'self'", ...(c.frameAncestors || [])].join(' ');
  const headers = (type, extra = {}) => ({ 'content-type': type, 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin', 'content-security-policy': `frame-ancestors ${ancestors}`, ...extra });
  const TS = 'https://challenges.cloudflare.com';
  const pageCsp = `default-src 'none'; script-src 'self' 'unsafe-inline' ${TS}; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' ${TS}; frame-src 'self' ${TS}; form-action 'none'; base-uri 'none'; frame-ancestors ${ancestors}`;
  const memo = new Map();
  const fileBody = (file, transform = null) => {
    const st = statSync(file);
    const hit = memo.get(file);
    if (hit && hit.mtime === st.mtimeMs && !transform) return hit;
    let body = readFileSync(file); if (transform) body = Buffer.from(transform(body.toString('utf8')));
    const v = { mtime: st.mtimeMs, body, gz: gzipSync(body), etag: etagOf(body) }; memo.set(file, v); return v;
  };
  let pageMemo = { key: '', v: null };
  const cacheKey = () => c.slots.map((s) => { try { return statSync(path.join(c.cache, `${s.id}.json`)).mtimeMs; } catch { return 0; } }).join(',');
  const send = (req, res, status, v, type, extra = {}) => {
    const h = headers(type, { etag: v.etag, vary: 'accept-encoding', ...extra });
    if (req.headers['if-none-match'] === v.etag) { res.writeHead(304, h); return res.end(); }
    const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '') && v.gz;
    res.writeHead(status, gz ? { ...h, 'content-encoding': 'gzip' } : h);
    res.end(req.method === 'HEAD' ? undefined : gz ? v.gz : v.body);
  };
  const json = (res, status, obj, extra = {}) => { res.writeHead(status, headers('application/json', { 'cache-control': 'no-store', ...extra })); res.end(JSON.stringify(obj)); };
  const ipOf = (req) => String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '');
  const sessionOf = (req) => visitors.verify(req.headers['x-demo-session'] || cookieOf(req, COOKIE));
  const rendered = (chat) => ({ ...chat, messages: chat.messages.map((m) => (m.role === 'assistant' ? { ...m, html: md(m.text) } : m)) });

  async function apiRoute(req, res, p) {
    if (p === '/api/state' && req.method === 'GET') {
      const st = visitors.state(sessionOf(req));
      return json(res, 200, { ...st, chats: st.chats.map(rendered) });
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'method' });
    // JSON only: a cross-site form cannot send it, and a cross-site fetch with it needs a preflight this server never grants
    if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'json only' });
    const body = await readBody(req).catch(() => null);
    if (!body) return json(res, 400, { error: 'bad body' });
    if (p === '/api/session') {
      if (visitors.resting()) return json(res, 503, { error: 'resting' });
      const ok = turnstileSecret ? await verifyTurnstile(turnstileSecret, body.turnstile, ipOf(req)).catch(() => false) : c.turnstile?.stub === true;
      if (!ok) return json(res, 403, { error: 'captcha' });
      const s = visitors.newSession(ipOf(req));
      return json(res, 200, { token: s.token }, { 'set-cookie': `${COOKIE}=${encodeURIComponent(s.token)}; Path=/; Max-Age=86400; HttpOnly; Secure; SameSite=None; Partitioned` });
    }
    if (p === '/api/turn') {
      const session = sessionOf(req);
      if (!session) return json(res, 401, { error: 'captcha' });
      const slot = body.slot ? c.slots.find((x) => x.id === body.slot) : null;
      const seeded = slot ? loadCache(c)[slot.id] : null;
      const history = seeded ? [{ role: 'user', text: seeded.prompt }, { role: 'assistant', text: seeded.answer }] : [];
      const r = await visitors.turn(session, ipOf(req), { chatId: body.chatId || null, slot: slot?.id || null, title: slot?.title, history, text: body.text });
      const { status, ...rest } = r;
      return json(res, status, rest.answer ? { ...rest, html: md(rest.answer) } : rest);
    }
    return json(res, 404, { error: 'not found' });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, 'http://x');
      const p = u.pathname;
      if (p.startsWith('/api/')) return await apiRoute(req, res, p);
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { allow: 'GET, HEAD' }); return res.end(); }
      if (p === '/healthz') return json(res, 200, { ok: true, chats: Object.keys(loadCache(c)).length, snapshot: existsSync(c.snapshot), resting: visitors.resting() });
      if (p === '/' || p === '/index.html') {
        const key = cacheKey() + '|' + (u.searchParams.get('c') || '');
        if (pageMemo.key !== key) { const body = Buffer.from(page(c, loadCache(c), u.searchParams.get('c'))); pageMemo = { key, v: { body, gz: gzipSync(body), etag: etagOf(body) } }; }
        return send(req, res, 200, pageMemo.v, TYPES['.html'], { 'cache-control': 'no-cache', 'content-security-policy': pageCsp });
      }
      if (p === '/demo.js') return send(req, res, 200, fileBody(path.join(HERE, 'client.js')), TYPES['.js'], { 'cache-control': 'public, max-age=300' });
      if (p === '/graph' || p === '/graph/') {
        // asset URLs carry their content hash, so an edge cache never serves a stale bundle after an update
        const ver = (f) => fileBody(path.join(c.viewerAssets, f)).etag.replace(/"/g, '').slice(0, 12);
        const v = fileBody(path.join(c.viewerAssets, 'index.html'), (html) => html.replace('<meta name="th-hub" content="">', '<meta name="th-hub" content=""><meta name="th-public" content="snapshot.json"><base href="/graph/">')
          .replace('src="/graph/libs.js"', `src="/graph/libs.js?v=${ver('libs.js')}"`).replace('src="/graph/app.js"', `src="/graph/app.js?v=${ver('app.js')}"`));
        return send(req, res, 200, v, TYPES['.html'], { 'cache-control': 'no-cache', 'content-security-policy': `default-src 'none'; script-src 'self'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'none'; base-uri 'self'; frame-ancestors ${ancestors}` });
      }
      if (p === '/graph/snapshot.json') {
        if (!existsSync(c.snapshot)) { res.writeHead(404); return res.end(); }
        return send(req, res, 200, fileBody(c.snapshot), TYPES['.json'], { 'cache-control': 'public, max-age=300, stale-while-revalidate=3600' });
      }
      const m = /^\/graph\/([a-z]+\.js)$/.exec(p);
      if (m && readdirSync(c.viewerAssets).includes(m[1])) return send(req, res, 200, fileBody(path.join(c.viewerAssets, m[1])), TYPES['.js'], { 'cache-control': 'public, max-age=3600, stale-while-revalidate=86400' });
      res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found');
    } catch (e) { console.error(e); if (!res.headersSent) { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('error'); } }
  });
  await new Promise((r) => server.listen(c.port || 4472, c.bind || '127.0.0.1', r));
  console.log(`tophat-demo on http://${c.bind || '127.0.0.1'}:${c.port || 4472}`);
}
