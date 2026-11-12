// The public face of the demo: the demo instance's real webchat (unmodified, from this repository's own build), reached through a
// thin shim. The shim is the sign-in service the webchat's scope gate asks, so a visitor is a guest account with a personal scope,
// and the app's own scoping keeps every visitor to their own chats. It also:
//   - gives each new visitor their own copy of the starting chats (seed-chats.mjs) and opens the app on an empty one;
//   - checks the visitor is a person (Turnstile) in the background and lets a real turn start only after that;
//   - plays the scripted first exchange: the visitor's "so, whats ur deal ?" is answered from the cached description, stored as
//     an ordinary assistant turn in the real chat, streamed through the real event feed (no model call);
//   - counts real turns across all of a visitor's chats (demo.json visitors.turnsPerSession) and refuses past the cap;
//   - forces the cheap model on every chat action, passes only the API paths the app needs, and never exposes any file but widgets;
//   - injects one script (shim.js) that types the opener into the real composer (the opening motion is intro.css) and shows the gray-out overlay.
// It renders no chat UI. The runner behind the app is the real one, with its tools cut to memory reads (TOPHAT_RUNNER_TOOLS_ALLOW).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { OPENER_GAPS_MS, OPENER_TEXT, metaTags, openerAnswer, textPage } from './answer.mjs';
import { createFeed, pieceDelayMs, tokenPieces } from './stream.mjs';
import { COOKIE_NAME, Guests, emailOf, scopeOf, scopeSettings, verifyTurnstile } from './guests.mjs';
import { renderFallback } from '../fallback/render.mjs';
import { pinAction } from './pin.mjs';
import { graphRoute } from './graph-route.mjs';
import { OPENER_GEN_ID, OPENER_ID, SEED_RETIRED_SCOPE, forkIdOf, forkSeedChat, isSeedId, retire, loadTemplates, openStore, openerGenOf, seedGuest, seedOpener, seedRowsOf } from './seed-chats.mjs';

/** How long after the opener is sent the answer begins to stream. */
const OPENER_ANSWER_DELAY_MS = 2000;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEMO = path.resolve(HERE, '..');
const { compileMarkdown } = await import(path.join(DEMO, '../webchat/src/lib/core/markdown.js'));

export const COOKIE = COOKIE_NAME;
const OPENER_MODEL = 'claude-sonnet-5-5';
const expand = (p) => (p && p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));
const cookieOf = (req, name) => { for (const p of String(req.headers.cookie || '').split(/;\s*/)) { const i = p.indexOf('='); if (i > 0 && p.slice(0, i) === name) return p.slice(i + 1); } return null; };

// What the app may ask of its server. Everything else answers 403: files, uploads, notes, the reader, secrets, voice, rooms, docs, shares, agents.
const API_ALLOW = [
  /^\/api\/(state|events|live|actions|whoami|bootstrap|sync|search)\/?$/,
  /^\/api\/conversation\/[^/]+(\/.*)?$/,
  /^\/api\/(client-lag|lag|folder-descriptions|scopes|replies\/projection|interaction|telemetry)(\/.*)?$/
];
// The surfaces the app shows (Nav reads window.__tophatSurfaces): the chat list, search and chats; no notes, reader, docs, secrets, voice, incognito.
const SURFACES = ['chats', 'chatlist', 'search'];
// An action that starts a model turn. A fork or create carrying text is one too; `run.interrupt`, renames, folders and the rest are not.
const startsTurn = (a) => a?.op === 'message.send' || ((a?.op === 'conversation.create' || a?.op === 'conversation.fork') && String(a.payload?.text || '').trim() !== '');
// what a visitor's page may still send to a starter chat: view state only (opened, read); a message forks, everything else is refused
const SEED_VIEW_OPS = new Set(['conversation.touch', 'conversation.set_read', 'conversation.fork']);

export async function serve(c) {
  const { inst, registryFile, orgDomain } = scopeSettings(c);
  const stateDir = expand(inst.paths.state);
  const workspace = expand(inst.paths.workspace || path.join(stateDir, 'workspace'));
  const webchat = `http://127.0.0.1:${inst.ports.webchat}`;
  const dbPath = path.join(stateDir, 'webchat', 'events.sqlite');
  const scopes = { orgDomain };
  const model = c.visitors?.model || 'claude-haiku-5-5';
  const widgetsDir = path.join(DEMO, 'widgets');
  const graph = graphRoute({ assets: c.viewerAssets || path.join(DEMO, '../viewer/assets'), snapshot: c.snapshot });
  const description = path.join(DEMO, 'content/description.md');
  const contextFile = path.join(DEMO, 'content/agent-context.md');
  const repo = c.downloadUrl || 'https://github.com/tophat-md/tophat';
  const edgeSecret = c.edgeSecretFile ? readFileSync(c.edgeSecretFile, 'utf8').trim() : null;
  const turnstileSecret = c.turnstile?.secretFile ? readFileSync(c.turnstile.secretFile, 'utf8').trim() : null;
  const siteKey = c.turnstile?.siteKey || '';
  // `streamSpeed` (config, default 1) divides the pause between streamed pieces: the scratch-instance tests set it so a 10 s answer takes about a second; unset, the stream is unchanged
  const pieceWait = (piece) => pieceDelayMs(piece) / (Number(c.streamSpeed) > 0 ? Number(c.streamSpeed) : 1);

  // what the day has really cost: the runner's own cost on each completed run, cached for 30 s
  const ro = new DatabaseSync(dbPath, { readOnly: true });
  let costMemo = { at: 0, usd: 0 };
  const costToday = () => {
    if (Date.now() - costMemo.at < 30_000) return costMemo.usd;
    let usd = 0;
    try { for (const r of ro.prepare("SELECT content FROM events WHERE kind='run.completed' AND at >= ?").all(new Date().toISOString().slice(0, 10))) { try { usd += Number(JSON.parse(r.content).costUsd) || 0; } catch { /* skip */ } } } catch { /* busy: keep last */ usd = costMemo.usd; }
    costMemo = { at: Date.now(), usd }; return usd;
  };
  const guests = new Guests(c, { registryFile, orgDomain, costToday });
  const store = openStore(dbPath);
  const md = (t) => compileMarkdown(String(t || '')).map((b) => ({ html: b.html }));
  const opener = { text: OPENER_TEXT, answer: () => openerAnswer(description, widgetsDir) };

  // A guest's starter chats: written when the guest is made (seed-chats.mjs: stable ids per definition, so seeding again writes nothing).
  const fresh = (guest) => {
    const templates = loadTemplates({ file: path.join(DEMO, 'seed/chats.json'), cacheDir: c.cache, slots: c.slots, widgetsDir });
    seedGuest(store, { guest, scope: scopeOf(guest), templates, model, cwd: workspace });
  };
  // Starter rows nobody can see any more: retired versions, and the whole seed of a guest whose session has expired (their own chats stay).
  const sweepSeeds = () => {
    try {
      const cutoff = new Date(Date.now() - (guests.sessionHours + 2) * 3600_000).toISOString();
      const drop = new Set(store.db.prepare('SELECT id FROM conversations WHERE scope = ? AND updated_at < ?').all(SEED_RETIRED_SCOPE, cutoff).map((r) => r.id));
      for (const { id: guest } of guests.db.prepare('SELECT id FROM sessions WHERE created_at < ?').all(cutoff)) for (const id of seedRowsOf(store, { scope: scopeOf(guest), guest })) drop.add(id);
      let n = 0;
      for (const id of drop) { try { store.deleteConversation(id); n++; } catch { /* busy: the next sweep */ } }
      if (n) console.log(`[seed] swept ${n} starter chats of expired guests and retired versions`);
    } catch (e) { console.error('[seed] sweep failed', e.message); }
  };
  setTimeout(sweepSeeds, 30_000).unref();
  setInterval(sweepSeeds, 3600_000).unref();

  const headers = (type, extra = {}) => ({ 'content-type': type, 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin', ...extra });
  const json = (res, status, obj, extra = {}) => { res.writeHead(status, headers('application/json', { 'cache-control': 'no-store', ...extra })); res.end(JSON.stringify(obj)); };
  const clientIp = (req) => (edgeSecret && req.headers['x-tophat-edge'] === edgeSecret && req.headers['x-tophat-client-ip']) || String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '');
  const readBody = (req, max = 1_000_000) => new Promise((resolve, reject) => {
    let n = 0; const parts = [];
    req.on('data', (d) => { n += d.length; if (n > max) { reject(new Error('too large')); req.destroy(); } else parts.push(d); });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
  // The demo's own scripts and styles are fetched whole on every load: Cloudflare's browser-cache TTL rewrites `no-cache` to `max-age=14400`,
  // so a revalidated asset sat in browsers for four hours (a reload ran the old shim and caret); only `no-store` passes through unchanged.
  const NO_STORE_ASSET = 'no-store';
  const assetVersion = (body) => createHash('sha256').update(body).digest('hex').slice(0, 10);
  const shimJs = () => readFileSync(path.join(HERE, 'shim.js'), 'utf8');
  const guestReset = () => { const src = readFileSync(path.join(HERE, 'guest-reset.js'), 'utf8'); const v = createHash('sha256').update(src).update(readFileSync(path.join(DEMO, 'seed/chats.json'))).digest('hex').slice(0, 10); return src.replace('__SEED_V__', v); }; // the client resets its sidebar whenever the seed or this layout changes
  const prefetchJs = () => readFileSync(path.join(HERE, 'prefetch.js'), 'utf8'); // warms the opener answer's figures during the intro
  const introCss = () => readFileSync(path.join(HERE, 'intro.css'), 'utf8');
  // the theme trial and the desktop frame of very large screens, served after intro.css as /_demo/page.css
  const THEME_CSS = "/* trial: the warm pastel rose as the chat accent, in place of the orange */html:root{--accent:#e6a0a6;--accent-soft:#e6a0a622}@media (prefers-color-scheme:light){html:root{--accent:#b45c6e;--accent-soft:#b45c6e1a}}";
  // the demo has one surface, so the section pill (notes / chats / fnf) is not shown; the menu button inside it stays (chat list, search), and
  // it keeps the pill's place in the sidebar header and in the corner tab the collapsed list leaves. A CSS rule, not a change to the app.
  const NAV_CSS = "[data-testid=nav-pill]{border-color:transparent!important;background:transparent!important;padding:0!important}[data-testid=nav-pill] a.tab,[data-testid=nav-pill] .sep{display:none!important}";
  const BIGSCREEN_CSS = "@media (min-width:1900px) and (min-height:950px){:root[data-th-full]{--th-tb:0px}:root{--th-ww:min(108rem,calc(100vw - 160px));--th-wh:min(calc(var(--th-ww) * 0.62),calc(100vh - 140px));--th-tb:30px;--th-desk:#ece6d8;--th-chrome:#dcd6c8;--th-ink:#5a554c}@media (prefers-color-scheme:dark){:root{--th-desk:#0d0d0d;--th-chrome:#262626;--th-ink:#9a9a9a}}:root[data-theme=light]{--th-desk:#ece6d8;--th-chrome:#dcd6c8;--th-ink:#5a554c}:root[data-theme=dark]{--th-desk:#0d0d0d;--th-chrome:#262626;--th-ink:#9a9a9a}html,body{height:100%;background:var(--th-desk)!important}body{margin:0;display:grid;place-items:center;overflow:hidden}body>div[style*=\"contents\"]{display:block!important;width:var(--th-ww);height:calc(var(--th-wh) - var(--th-tb));margin-top:var(--th-tb);position:relative;overflow:hidden;transform:translateZ(0);border-radius:0 0 10px 10px;box-shadow:0 0 0 1px rgba(0,0,0,.14),0 30px 90px rgba(0,0,0,.30),0 8px 24px rgba(0,0,0,.12);background:var(--bg,#fff)}body>div[style*=\"contents\"] .app{height:100%!important}}";
  const windowCss = () => readFileSync(path.join(HERE, 'window.css'), 'utf8'); // the desktop window's bar, traffic lights, dock chip and closed screen (window.js drives them)
  const windowJs = () => readFileSync(path.join(HERE, 'window.js'), 'utf8');
  const pageCss = () => introCss() + '\n' + THEME_CSS + '\n' + NAV_CSS + '\n' + BIGSCREEN_CSS + '\n' + windowCss();
  // the head's first script: the guest's local reset, the caret drawn at the first paint and the intro state request, then the figure prefetch
  const CARET_JS = "(function(){var q=new URLSearchParams(location.search),c=q.get('chat');var i=!c||/^opener-/.test(c);if(i&&q.get('fresh')==='1')document.documentElement.classList.add('demo-intro');if(i&&q.get('fresh')!=='1'){var h=document.documentElement;h.classList.add('demo-intro');window.__demoCaretAt=performance.now();setTimeout(function(){if(!window.__demoIntroOwned){h.classList.remove('demo-intro')}},9000)}if(q.get('fresh')==='1')return;window.__demoBoot=fetch(i?'/_demo/intro':'/_demo/state',{method:i?'POST':'GET',credentials:'same-origin',cache:'no-store'}).then(function(r){return r.status===401?{gone:true}:r.ok?r.json():null},function(){return null})})();";
  const earlyJs = () => `(function(){${guestReset()}})();\n${CARET_JS}\n${prefetchJs()}`;

  // ---- the intro chat ----
  // A guest's intro chat is the empty chat the scripted exchange plays in. Every plain page load
  // plays it again from empty: every earlier intro chat is retired out of the guest's scope and a fresh one (`<id>-<n>`) takes its place. The chat lists are the record.
  const hasUserMessage = (id) => Boolean(ro.prepare("SELECT 1 FROM events WHERE conversation_id=? AND kind='message.user' LIMIT 1").get(id));
  const openerOf = (session) => {
    const live = ro.prepare('SELECT id FROM conversations WHERE scope=? AND archived=0 AND id LIKE ?').all(scopeOf(session.id), `${OPENER_ID(session.id)}%`)
      .map((r) => ({ id: r.id, n: openerGenOf(session.id, r.id) })).filter((r) => r.n !== null).sort((a, b) => b.n - a.n);
    return live[0]?.id || OPENER_ID(session.id);
  };
  /**
   * The intro chat's row, in the guest's scope and the opener's folder. The seed no longer writes the first one, and events appended to a chat
   * that has no row are invisible to the app's sync and live feed (they are scoped through the row): the page would hold its own message and
   * "working" for ever. Idempotent.
   */
  const ensureOpener = (session, id) => {
    if (ro.prepare('SELECT 1 FROM conversations WHERE id=?').get(id)) return;
    const template = loadTemplates({ file: path.join(DEMO, 'seed/chats.json'), cacheDir: c.cache, slots: c.slots, widgetsDir }).find((t) => t.opener);
    seedOpener(store, { id, template, scope: scopeOf(session.id), model: OPENER_MODEL, autoModel: true, cwd: expand(inst.paths.workspace || path.join(stateDir, 'workspace')) });
  };
  /** Idempotent and uncounted: a played intro is replaced by a new empty one, and every other intro chat of the guest is retired from their list. Returns the live intro chat's id. */
  const replayIntro = (session) => {
    try { fresh(session.id); } catch (e) { console.error('[seed] reseed failed', e.message); } // a returning guest gets the current seed too: missing chats written, old versions retired
    const cur = openerOf(session);
    const next = hasUserMessage(cur) ? OPENER_GEN_ID(session.id, (openerGenOf(session.id, cur) || 0) + 1) : cur;
    ensureOpener(session, next);
    pruneIntros(session, next);
    return next;
  };
  /** The intro chat is not kept: replaying it drops every earlier one from the guest's list with the app's own drop marker, so the sidebar only ever holds the live one. */
  const pruneIntros = (session, keep) => {
    const at = new Date().toISOString();
    for (const r of ro.prepare('SELECT id FROM conversations WHERE scope=? AND id LIKE ?').all(scopeOf(session.id), `${OPENER_ID(session.id)}%`))
      if (r.id !== keep && openerGenOf(session.id, r.id) !== null) retire(store, r.id, at);
  };

  // The files the opener answer shows, as the app asks for them (RichContent: /api/file?path=<path>&raw=1&conversation=<chat>), in answer order.
  // prefetch.js warms these during the intro; the answer is read from the same description it streams, so the two cannot drift.
  const answerFiles = () => [...opener.answer().matchAll(/^!\[[^\]]*\]\(([^)\n]+)\)$/gm)].map((m) => m[1]);
  const warmUrls = (chat) => answerFiles().map((f) => `/api/file?path=${encodeURIComponent(f)}&raw=1&conversation=${encodeURIComponent(chat)}`);
  // A figure is the same bytes for every guest, so the browser may keep it (the webchat sends no-store): this is what lets the intro's prefetch be used.
  const widgetCacheable = (url) => { try { const f = path.resolve(expand(url.searchParams.get('path') || '')); return f.startsWith(widgetsDir + path.sep) && /\.(html|jpe?g|png)$/.test(f); } catch { return false; } };

  /** Everything a visitor's page needs to know that the app does not: how many turns, whether the check passed, whether a run is in progress. */
  const stateOf = (session) => {
    const running = ro.prepare("SELECT 1 FROM conversations WHERE scope=? AND run_state != 'idle' LIMIT 1").get(scopeOf(session.id));
    const opener = openerOf(session);
    const intro = !hasUserMessage(opener);
    // forks: the chat a message to each starter chat continues in (forkIdOf), so the page can follow the visitor there after the send
    const forks = Object.fromEntries(seedRowsOf(store, { scope: scopeOf(session.id), guest: session.id }).map((id) => [id, forkIdOf(id, session.id)]));
    return { turns: session.turns, cap: guests.cap, verified: Boolean(session.verified), resting: guests.resting(), running: Boolean(running), opener, intro, warm: intro ? warmUrls(opener) : [], openerText: OPENER_TEXT, openerGaps: OPENER_GAPS_MS, siteKey, repo, forks };
  };
  const openerDone = new Set(); // intro chats whose scripted exchange has played (the stored events are the record; this stops a double play)

  /** The scripted exchange: the user's message and the cached answer, written into the real chat and streamed through the real feed. */
  async function playOpener(session, action) {
    const id = action.conversation_id;
    ensureOpener(session, id);
    const before = store.cursor();
    const at = () => new Date().toISOString();
    store.append(id, 'message.user', { itemId: action.action_id, text: OPENER_TEXT, writtenBy: 'script' }, { at: at() });
    store.append(id, 'run.status', { state: 'running' }, { at: at() });
    const itemId = `${id}-answer`;
    const answer = opener.answer();
    store.markApplied({ actionId: action.action_id, conversationId: id, op: action.op, cursorBefore: before, cursorAfter: store.cursor() });
    const events = store.since(before);
    (async () => {
      // a beat of "working" (the send-off motion lands about a second after the click: shim.js FLIGHT_MS), then like a model's stream:
      // token-sized deltas at about 80 a second
      await new Promise((r) => setTimeout(r, OPENER_ANSWER_DELAY_MS));
      for (const piece of tokenPieces(answer)) {
        store.append(id, 'assistant.delta', { itemId, text: piece }, { at: at() });
        await new Promise((r) => setTimeout(r, pieceWait(piece)));
      }
      store.append(id, 'assistant.message', { itemId, text: answer }, { at: at() });
      store.append(id, 'run.completed', { costUsd: 0 }, { at: at() });
    })().catch((e) => console.error('opener', e));
    return { events, cursor: store.cursor() };
  }

  /** A fixed reply once the visitor's turns are used up: the visitor's message and the answer, written into the chat and streamed like the opener. */
  const LIMIT_ANSWER = "Ok that's the demo. Give it a spin:\n\n```\nScan this repo for privacy, security, and malintent; then help me install it:\n" + repo + "\n```";
  function playScripted(action, text, answer) {
    const id = action.conversation_id;
    const before = store.cursor();
    const at = () => new Date().toISOString();
    store.append(id, 'message.user', { itemId: action.action_id, text }, { at: at() });
    store.append(id, 'run.status', { state: 'running' }, { at: at() });
    const itemId = `${id}-limit-${action.action_id}`;
    store.markApplied({ actionId: action.action_id, conversationId: id, op: action.op, cursorBefore: before, cursorAfter: store.cursor() });
    const events = store.since(before);
    (async () => {
      await new Promise((r) => setTimeout(r, 400));
      for (const piece of tokenPieces(answer)) {
        store.append(id, 'assistant.delta', { itemId, text: piece }, { at: at() });
        await new Promise((r) => setTimeout(r, pieceWait(piece)));
      }
      store.append(id, 'assistant.message', { itemId, text: answer }, { at: at() });
      store.append(id, 'run.completed', { costUsd: 0 }, { at: at() });
    })().catch((e) => console.error('limit reply', e));
    return { events, cursor: store.cursor() };
  }

  // The events the shim appends reach a page's open /api/events stream here (stream.mjs says why): to the guest whose scope owns the chat.
  const feed = createFeed();
  const scopeOfChat = new Map();
  store.subscribe((event) => {
    if (!feed.size()) return;
    let scope = scopeOfChat.get(event.conversation_id);
    if (scope === undefined) { scope = ro.prepare('SELECT scope FROM conversations WHERE id=?').get(event.conversation_id)?.scope ?? null; if (scope !== null) scopeOfChat.set(event.conversation_id, scope); }
    feed.publish(event, (guestId) => scope !== null && scope === scopeOf(guestId));
  });
  const pinModel = (a) => pinAction(a, { model, cwd: workspace });

  function proxy(req, res, { body, cookie, inject, session, countedTurn }) {
    const url = new URL(req.url, 'http://x');
    const liveFeed = Boolean(session) && url.pathname === '/api/events' && req.method === 'GET';
    const h = { ...req.headers, host: new URL(webchat).host, cookie, 'accept-encoding': inject || liveFeed ? 'identity' : req.headers['accept-encoding'] || 'identity' };
    for (const k of ['x-tophat-edge', 'x-tophat-client-ip', 'cf-connecting-ip', 'x-forwarded-for']) delete h[k];
    if (body) h['content-length'] = String(body.length);
    delete h.origin; delete h.referer;
    const up = http.request(webchat + url.pathname + url.search, { method: req.method, headers: h }, (r) => {
      const out = { ...r.headers };
      delete out['content-security-policy'];
      if (r.statusCode === 200 && req.method === 'GET' && url.pathname === '/api/file' && widgetCacheable(url)) { out['cache-control'] = 'private, max-age=600'; delete out.vary; }
      if (inject && /text\/html/.test(String(r.headers['content-type'] || ''))) {
        const chunks = [];
        r.on('data', (d) => chunks.push(d));
        r.on('end', () => {
          let html = Buffer.concat(chunks).toString('utf8');
          const tag = `<script>window.__tophatSurfaces=${JSON.stringify(SURFACES)};</script>${metaTags(description)}<link rel="stylesheet" id="demo-css" href="/_demo/page.css?v=${assetVersion(pageCss())}"><link rel="icon" type="image/svg+xml" href="/favicon.svg"><link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><noscript><meta http-equiv="refresh" content="0;url=/_demo/text?why=nojs"></noscript><script src="/_demo/shim.js?v=${shimVersion()}" defer></script><script src="/_demo/window.js?v=${assetVersion(windowJs())}" defer></script>`;
          // First thing in the head, before any stylesheet: the visitor's state request starts while the page parses, not after the shim has loaded.
          // The shim reads `window.__demoBoot` (same rule as its own `bootState`). Everything the demo adds that changes between releases (early.js,
          // page.css, shim.js) is a revalidated URL, never inline: the app's service worker answers a returning visitor's navigation from the page it
          // stored on the last visit (a previous release), and inline demo code in it would run stale beside the current shim.
          const early = `<script src="/_demo/early.js?v=${assetVersion(earlyJs())}"></script>`; // the version only names the bytes (a copy a browser kept from before no-store is never reused); the route ignores it
          html = html.replace(/<link[^>]*rel="(?:icon|apple-touch-icon|shortcut icon)"[^>]*>/g, '').replace(/<head[^>]*>/, (m) => m + early).replace('</head>', `${tag}</head>`);
          const buf = Buffer.from(html);
          delete out['content-length']; delete out['content-encoding']; delete out.etag;
          out['content-length'] = String(buf.length); out['cache-control'] = 'no-store';
          if (session) out['x-demo-turns'] = String(session.turns);
          res.writeHead(r.statusCode, out); res.end(buf);
        });
        return;
      }
      if (session) { out['x-demo-turns'] = String(guests.turnsOf(session.id)); out['access-control-expose-headers'] = 'x-demo-turns'; }
      res.writeHead(r.statusCode, out);
      if (liveFeed && r.statusCode === 200) { const s = feed.attach(res, session.id); r.on('data', (d) => feed.chunk(s, d)); r.on('end', () => res.end()); r.on('error', () => res.destroy()); } else r.pipe(res);
      if (countedTurn && r.statusCode >= 500) guests.refundTurn(session);
    });
    up.on('error', () => { if (countedTurn) guests.refundTurn(session); if (!res.headersSent) { res.writeHead(502, { 'content-type': 'text/plain' }); res.end('the demo is starting up'); } else res.destroy(); });
    res.on('close', () => { if (!res.writableEnded) up.destroy(); });
    if (body) up.end(body); else if (req.method === 'GET' || req.method === 'HEAD') up.end(); else req.pipe(up);
  }
  const shimVersion = () => createHash('sha256').update(shimJs()).digest('hex').slice(0, 10);

  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, 'http://x');
      const p = u.pathname;
      const external = Boolean(req.headers['x-tophat-edge'] || req.headers['cf-connecting-ip']);

      // ---- the identity service the webchat's scope gate asks (loopback only) ----
      if (p === '/_auth/api/session') {
        if (external) { res.writeHead(404); return res.end(); }
        const s = guests.verify(cookieOf({ headers: { cookie: req.headers.cookie } }, COOKIE));
        if (!s) return json(res, 401, { error: 'no session' });
        return json(res, 200, { email: emailOf(s.id, scopes.orgDomain), org: true });
      }
      if (p === '/_auth' || p.startsWith('/_auth/')) { res.writeHead(404); return res.end(); }

      if (p === '/healthz') return json(res, 200, { ok: true, resting: guests.resting(), spentUsd: Number(guests.spentToday().toFixed(4)), capUsd: guests.dailyUsd, build: (() => { try { return readFileSync(path.join(DEMO, '../../.demo-sha'), 'utf8').trim(); } catch { return null; } })() });

      // ---- the shim's own surface ----
      if (p === '/_demo/shim.js') {
        // revalidated every load: the app's service worker keeps old pages (and their script tags) for returning visitors, and they must still get this script
        const etag = `"${shimVersion()}"`;
        if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag, 'cache-control': NO_STORE_ASSET }); return res.end(); }
        res.writeHead(200, headers('text/javascript; charset=utf-8', { 'cache-control': NO_STORE_ASSET, etag })); return res.end(shimJs());
      }
      if (p === '/_demo/window.js') { const body = windowJs(), etag = `"${assetVersion(body)}"`; if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag, 'cache-control': NO_STORE_ASSET }); return res.end(); } res.writeHead(200, headers('text/javascript; charset=utf-8', { 'cache-control': NO_STORE_ASSET, etag })); return res.end(body); }
      if (p === '/_demo/text') { res.writeHead(200, headers('text/html; charset=utf-8', { 'cache-control': 'no-store' })); return res.end(textPage({ file: description, contextFile, repo, markdown: md, why: u.searchParams.get('why') === 'nojs' ? 'nojs' : 'check', siteKey, canVerify: true })); }
      // early.js and page.css: revalidated on every load like shim.js (see the page injection above)
      if (p === '/_demo/early.js' || p === '/_demo/page.css') {
        const js = p.endsWith('.js'), body = js ? earlyJs() : pageCss(), etag = `"${createHash('sha256').update(body).digest('hex').slice(0, 16)}"`;
        if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag, 'cache-control': NO_STORE_ASSET }); return res.end(); }
        res.writeHead(200, headers(js ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8', { 'cache-control': NO_STORE_ASSET, etag })); return res.end(body);
      }
      if (p === '/_demo/intro.css') { res.writeHead(200, headers('text/css; charset=utf-8', { 'cache-control': NO_STORE_ASSET })); return res.end(introCss()); }
      if (/^\/(favicon\.svg|favicon\.ico|favicon-(16|32|192|512)\.png|apple-touch-icon\.png|og\.png|dock-icon-rose\.png)$/.test(p)) {
        const f = path.join(DEMO, 'public', p.slice(1));
        if (existsSync(f)) { res.writeHead(200, headers(p.endsWith('.svg') ? 'image/svg+xml' : p.endsWith('.ico') ? 'image/x-icon' : 'image/png', { 'cache-control': 'public, max-age=86400' })); return res.end(readFileSync(f)); }
      }

      // the memory viewer over the demo's own snapshot: public, read-only, no session
      if (graph(req, res, p)) return;

      // ---- who is asking ----
      let session = guests.verify(cookieOf(req, COOKIE));
      let setCookie = null;
      const isPage = req.method === 'GET' && (req.headers.accept || '').includes('text/html');
      const begin = () => {
        const made = guests.create(clientIp(req));
        if (!made) return false;
        fresh(made.id);
        session = guests.verify(made.token);
        // beside the session cookie, a readable one naming this guest (a hash of its id, no secret): the page's first script (guest-reset.js) compares it with
        // what this browser last showed, so a new guest clears the old one's leftovers even on a page the app's service worker served from its cache
        setCookie = [`${COOKIE}=${made.token}; Path=/; Max-Age=${guests.sessionHours * 3600}; HttpOnly; Secure; SameSite=Lax`,
          `demo_guest=${createHash('sha256').update(made.id).digest('hex').slice(0, 12)}; Path=/; Max-Age=${guests.sessionHours * 3600}; Secure; SameSite=Lax`];
        req.headers.cookie = `${COOKIE}=${made.token}`;
        return true;
      }
      const freshPage = isPage && p === '/' && u.searchParams.get('fresh') === '1';
      if ((!session || freshPage) && isPage && p === '/') {
        session = null;
        if (!begin()) { res.writeHead(429, headers('text/html; charset=utf-8')); return res.end(textPage({ file: description, contextFile, repo, markdown: md, why: 'limit' })); }
      }
      // The app's service worker can serve the page from its cache to a browser whose session cookie is gone (expired, cleared): the page
      // then asks for a new session here, which a cached page cannot answer, and reloads into it. `?fresh=1` starts a brand-new guest the same way.
      if (p === '/_demo/session' && req.method === 'POST') {
        if ((!session || u.searchParams.get('fresh') === '1') && !begin()) return json(res, 429, { error: 'limit' });
        return json(res, 200, { ...stateOf(session) }, setCookie ? { 'set-cookie': setCookie } : {});
      }
      // The intro, again, when the visitor has sent nothing: what a page served from the app's own cache asks for (idempotent, uncounted).
      if (p === '/_demo/intro' && req.method === 'POST') {
        if (!session) return json(res, 401, { error: 'no session' });
        replayIntro(session);
        return json(res, 200, stateOf(guests.verify(cookieOf(req, COOKIE))));
      }

      if (p === '/_fallback') { res.writeHead(200, headers('text/html; charset=utf-8', { 'cache-control': 'no-store' })); return res.end(renderFallback()); }
      // A visitor who has sent nothing opens on a fresh intro: a bare address, or a link to one of their own (played) intro chats, goes to the live one.
      if (p === '/' && isPage && session) {
        const chat = u.searchParams.get('chat');
        if (!chat || openerGenOf(session.id, chat) !== null) {
          const live = replayIntro(session);
          if (chat !== live) { res.writeHead(302, { location: `/?chat=${live}`, ...(setCookie ? { 'set-cookie': setCookie } : {}), 'cache-control': 'no-store' }); return res.end(); }
        }
      }
      if (p === '/_demo/state') { if (!session) return json(res, 401, { error: 'no session' }); return json(res, 200, stateOf(session)); }
      if (p === '/_demo/fail' && req.method === 'POST') {
        const b = JSON.parse((await readBody(req, 2048)).toString('utf8') || '{}');
        console.log(`[check] ${new Date().toISOString()} session=${session ? session.id.slice(0, 8) : 'none'} why=${String(b.why || '').slice(0, String(b.why || '').startsWith('diag:') ? 300 : 80)} visible=${b.visible || ''} ua=${String(req.headers['user-agent'] || '').slice(0, 90)}`);
        res.writeHead(204); return res.end();
      }
      if (p === '/_demo/verify' && req.method === 'POST') {
        if (!session) return json(res, 401, { error: 'no session' });
        if (guests.resting()) return json(res, 503, { error: 'resting' });
        const { turnstile } = JSON.parse((await readBody(req, 8192)).toString('utf8') || '{}');
        const ok = turnstileSecret ? await verifyTurnstile(turnstileSecret, turnstile).catch((e) => ({ ok: false, codes: [String(e.message).slice(0, 60)] })) : { ok: c.turnstile?.stub === true, codes: [] };
        console.log(`[check] ${new Date().toISOString()} verify session=${session.id.slice(0, 8)} ok=${ok.ok} codes=${(ok.codes || []).join(',')} host=${ok.hostname || ''} edge=${Boolean(edgeSecret && req.headers['x-tophat-edge'] === edgeSecret)} ip=${guests.ipKey(clientIp(req)).slice(0, 6)} tokenLen=${String(turnstile || '').length}`);
        if (!ok.ok) return json(res, 403, { error: 'captcha' });
        guests.markVerified(session.id);
        return json(res, 200, stateOf(guests.verify(cookieOf(req, COOKIE))));
      }

      // ---- the app's API ----
      if (p.startsWith('/api/')) {
        if (!session) return json(res, 401, { error: 'no session' });
        // scopes do the isolating on the server; the page is told they are off so it draws no scope picker or sending rules
        if (p === '/api/scopes' && req.method === 'GET') return json(res, 200, { enabled: false, account: null, personalScope: null, scopes: [], router: { enabled: false }, rules: null });
        if (p === '/api/file') {
          // the webchat masks the host's home as `~` in everything it sends (home-mask.js), so the page asks for `~/...`: resolve it here, as the webchat does
          const f = path.resolve(expand(u.searchParams.get('path') || ''));
          if (!f.startsWith(widgetsDir + path.sep) || !/\.(html|jpe?g|png)$/.test(f)) return json(res, 403, { error: 'not available' });
        } else if (!API_ALLOW.some((re) => re.test(p))) return json(res, 403, { error: 'not available' });
        let body = null, countedTurn = false;
        if (req.method !== 'GET' && req.method !== 'HEAD') body = await readBody(req);
        if (p === '/api/actions' && req.method === 'POST') {
          let action; try { action = JSON.parse(body.toString('utf8')); } catch { return json(res, 400, { error: 'bad body' }); }
          action = pinModel(action);
          // the intro chat runs as auto with Sonnet 5.5; the seeded chats keep the visitor model
          if (action.payload?.settings && openerGenOf(session.id, String(action.conversation_id || '')) !== null) action.payload.settings = { ...action.payload.settings, model: OPENER_MODEL, autoModel: true };
          // the intro chat is created by the page with no folder: file it in the folder seed/chats.json gives the opener (personal assistant project), not the Inbox
          if (action.op === 'conversation.create' && openerGenOf(session.id, String(action.conversation_id || '')) !== null && !action.payload?.workspace) {
            const workspace = loadTemplates({ file: path.join(DEMO, 'seed/chats.json'), cacheDir: c.cache, slots: c.slots, widgetsDir }).find((t) => t.opener)?.workspace;
            if (workspace) action = { ...action, payload: { ...action.payload, workspace } };
          }
          const own = action.conversation_id ? ro.prepare('SELECT scope FROM conversations WHERE id=?').get(action.conversation_id) : null;
          if (own && own.scope !== scopeOf(session.id)) return json(res, 404, { error: 'Unknown conversation' });
          // A starter chat is the same for every visitor and is never written to: a message to one continues in a fork of it that the visitor owns;
          // view state (opened, read) passes; anything else that would change the row is refused.
          const seedTarget = String(action.conversation_id || '');
          if (seedTarget && isSeedId(seedTarget, session.id)) {
            if (action.op === 'message.send') {
              const forkId = forkIdOf(seedTarget, session.id);
              forkSeedChat(store, { sourceId: seedTarget, forkId, scope: scopeOf(session.id) });
              action = { ...action, conversation_id: forkId };
            } else if (!SEED_VIEW_OPS.has(action.op)) return json(res, 403, { error: 'This starter chat is read-only: send a message to carry on in your own copy.' });
          }
          // a redelivery of the played opener (the page's engine re-posts an action whose answer it never heard, as on a slow or dropped connection) gets the same answer
          // again: never a second chat turn, never a second play
          const played = action.op === 'message.send' && openerGenOf(session.id, String(action.conversation_id || '')) !== null ? store.appliedAction(action.action_id) : null;
          if (played) return json(res, 200, { events: store.since(played.cursor_before).filter((e) => e.cursor <= played.cursor_after), cursor: store.cursor() }, { 'x-demo-turns': String(session.turns) });
          if (action.op === 'message.send' && openerGenOf(session.id, String(action.conversation_id || '')) !== null && String(action.payload?.text || '').trim().toLowerCase() === OPENER_TEXT && !openerDone.has(action.conversation_id)
              && !hasUserMessage(action.conversation_id)) {
            openerDone.add(action.conversation_id);
            return json(res, 200, await playOpener(session, action), { 'x-demo-turns': String(session.turns) });
          }
          if (startsTurn(action)) {
            const claim = guests.claimTurn(session);
            // out of turns (or the daily spend is used up): no end screen; the agent answers with a fixed reply and the page stays usable
            if (!claim.ok && (claim.error === 'limit' || claim.error === 'resting') && action.op === 'message.send') {
              const again = store.appliedAction(action.action_id);
              if (again) return json(res, 200, { events: store.since(again.cursor_before).filter((e) => e.cursor <= again.cursor_after), cursor: store.cursor() }, { 'x-demo-turns': String(session.turns) });
              return json(res, 200, playScripted(action, String(action.payload?.text || ''), LIMIT_ANSWER), { 'x-demo-turns': String(session.turns) });
            }
            if (!claim.ok) return json(res, claim.status, { error: claim.error, turns: session.turns, cap: guests.cap });
            countedTurn = true;
          }
          body = Buffer.from(JSON.stringify(action));
        }
        return proxy(req, res, { body, cookie: req.headers.cookie, inject: false, session, countedTurn });
      }

      // ---- pages and assets of the app ----
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
      const asset = p.startsWith('/_app/') || (/\.[a-z0-9]+$/i.test(p) && !/__data\.json$/.test(p));
      if (!asset && p !== '/') { res.writeHead(302, { location: '/' }); return res.end(); }
      // A link preview or crawler asks for the page without an html Accept and without a session: it gets the description as a plain page (title,
      // description and og: tags), and no guest is made for it. A page request that does accept html gets a guest and the app above.
      if (!session && !asset) {
        res.writeHead(200, headers('text/html; charset=utf-8', { 'cache-control': 'no-store' }));
        return res.end(req.method === 'HEAD' ? undefined : textPage({ file: description, contextFile, repo, markdown: md, why: 'preview' }));
      }
      if (setCookie) res.setHeader('set-cookie', setCookie);
      return proxy(req, res, { body: null, cookie: req.headers.cookie || '', inject: !asset, session: session || null, countedTurn: false });
    } catch (e) { console.error(e); if (!res.headersSent) { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('error'); } }
  });
  await new Promise((r) => server.listen(c.port || 4472, c.bind || '127.0.0.1', r));
  console.log(`tophat-demo on http://${c.bind || '127.0.0.1'}:${c.port || 4472} -> ${webchat}`);
}
