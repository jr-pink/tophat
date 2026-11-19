// The visitor's first minute against a scratch demo instance (the real webchat build, the real shim server, a headless Chrome with its own
// profile) and a fake human check: whatever the check does, the intro ends sent-with-the-first-answer or on the failed-check page, never as
// a blank chat. Skipped where Chrome or the webchat build is missing. The check is faked by answering Cloudflare's script request in the
// browser (a stand-in `window.turnstile`), and the server's verify is the config's `turnstile.stub`.
// Speed: one webchat, one demo server and one Chrome serve the whole file, the visitors (each its own browser context and guest) run at the same time,
// the answer's stream runs at TEST_SPEED times its real pace (demo.json `streamSpeed`; sessionStorage `demo-tune` speeds only the tuner's overlay intro, the zoom load-in types in real time),
// and nothing waits for a clock that a condition can be waited on instead. What stays real time: the server's 2 s beat before the answer (asserted by
// its own test), the shim's retry back-offs, and the page's 2.5 s poll that ends the opener's pending rules.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openerAnswer } from '../src/answer.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// the webchat build under test: the package's own, or TOPHAT_TEST_WEBCHAT_BUILD (a fresh build in another directory)
const BUILD = process.env.TOPHAT_TEST_WEBCHAT_BUILD || path.join(REPO, 'packages/webchat/build');
const skip = !existsSync(CHROME) ? 'no Google Chrome' : !existsSync(path.join(BUILD, 'handler.js')) ? 'no webchat build' : false;
const TEST_SPEED = Number(process.env.TOPHAT_TEST_SPEED) || 10;
// what the opener's answer holds: figures in all, and how many of them are widget frames (the rest are pictures)
const ANSWER = openerAnswer(path.join(REPO, 'packages/demo/content/description.md'), path.join(REPO, 'packages/demo/widgets'));
const FIGURES = (ANSWER.match(/!\[/g) || []).length, FRAMES = (ANSWER.match(/\.html\)/g) || []).length;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const until = async (fn, ms, what) => { const end = Date.now() + ms; let last; while (Date.now() < end) { try { last = await fn(); if (last) return last; } catch (e) { last = e; } await sleep(50); } throw new Error(`timed out waiting for ${what}: ${last && last.message || JSON.stringify(last)}`); };

// stand-in for Cloudflare's api.js: what the page's `window.turnstile` does is chosen by `window.__demoFake`
const FAKE_TURNSTILE = `window.turnstile={render(el,o){window.__ts=o;const m=window.__demoFake;if(m==='pass')setTimeout(()=>o.callback('tok'),window.__demoFakeDelay||300);if(m==='error')setTimeout(()=>o['error-callback']('300010'),200);return 'w1'},reset(){const o=window.__ts,m=window.__demoFake;if(m==='error')setTimeout(()=>o['error-callback']('300010'),200)},remove(){}};`;
// the composer rebuilt under the typing: the app's draft is reset once, a few characters in (an untrusted event, like the app's own)
const WIPE = `(()=>{let done=false;document.addEventListener('input',(e)=>{const f=e.target;if(done||!f||!f.matches||!f.matches('[data-testid="composer"]')||f.value.length<5)return;done=true;setTimeout(()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(f,'');f.dispatchEvent(new Event('input',{bubbles:true}))},0)},true)})();`;
// what the screen shows at each character the opener types into the composer (the zoom load-in, shim.js zoomIntro): page classes, the body's zoom,
// the message bar and send button where they are drawn, the connection dot's visibility
const INTRO_RECORD = `window.__introSeen=[];document.addEventListener('input',(e)=>{const f=e.target;if(!f||!f.matches||!f.matches('[data-testid="composer"]'))return;const R=(el)=>{if(!el)return null;const r=el.getBoundingClientRect();return{left:r.left,right:r.right,cx:r.left+r.width/2,cy:r.top+r.height/2}};const t=getComputedStyle(document.body).transform,m=/^matrix\\(([^,]+),([^,]+)/.exec(t),c=document.querySelector('[data-testid=conn]');window.__introSeen.push({value:f.value,cls:document.documentElement.className,scale:m?Math.hypot(+m[1],+m[2]):1,bar:R(f.closest('form')||f.parentElement||f),send:R(document.querySelector('[data-testid="send"]')),conn:c?getComputedStyle(c).visibility:'hidden',vw:innerWidth,vh:innerHeight})},true);`;
// a send button that never enables
const NO_SEND = `setInterval(()=>{const b=document.querySelector('[data-testid="send"]');if(b)b.disabled=true},15);`;

describe('the first minute, against a scratch demo', { skip, concurrency: 6 }, () => {
  let dir, demoPort, webchatPort, children = [], chrome, ws, seq = 0;
  const pending = new Map(), listeners = [];
  const base = () => `http://127.0.0.1:${demoPort}`;
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params, sessionId })); });

  before(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'demo-flow-'));
    webchatPort = await freePort(); demoPort = await freePort();
    // Chrome starts at once, beside the webchat and the demo server coming up
    const chromeUp = (async () => {
      const port = await freePort();
      chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(dir, 'profile')}`, '--no-first-run', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
      // never leak the browser if the run is killed before after() (SIGTERM from `timeout`, Ctrl-C)
      process.once('exit', () => { try { chrome.kill('SIGKILL'); } catch { /* gone */ } });
      for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(sig, () => { try { chrome.kill('SIGKILL'); } catch { /* gone */ } process.kill(process.pid, sig); });
      return until(async () => (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl, 20_000, 'chrome');
    })();
    const cfg = path.join(dir, 'cfg'), state = path.join(dir, 'state'), ws0 = path.join(dir, 'ws');
    for (const d of [path.join(cfg, 'secrets'), path.join(state, 'demo'), ws0]) mkdirSync(d, { recursive: true });
    const put = (f, v) => writeFileSync(path.join(cfg, f), typeof v === 'string' ? v : JSON.stringify(v, null, 1));
    for (const f of ['secrets/key', 'secrets/ws', 'secrets/edge']) put(f, 'x');
    put('secrets/session', 'a'.repeat(64));
    put('instance.json', {
      name: 'demo-flow-scratch', owner: { label: 'scratch' }, scope: { default: 'tophat-dev', groups: [] }, components: ['linknotes', 'runner', 'webchat', 'deploy'],
      hosts: { public: null, bind: '127.0.0.1' }, ports: { webchat: webchatPort },
      paths: { state, config: cfg, workspace: ws0, secrets: path.join(cfg, 'secrets'), fileRoots: [path.join(REPO, 'packages/demo/widgets')] },
      models: { chat: { model: 'claude-haiku-5-5', baseUrl: 'http://127.0.0.1:9', credential: { file: path.join(cfg, 'secrets/key') }, workspace: { file: path.join(cfg, 'secrets/ws') } } },
      deploy: { labelPrefix: 'md.tophat' }, webchat: { build: BUILD },
      runner: { env: { TOPHAT_RUNNER_TOOLS_ALLOW: 'memory_search,memory_read', TOPHAT_RUNNER_AGENTS: '0', TOPHAT_RUNNER_CHAT_TOOLS: '0', TOPHAT_RUNNER_GOAL_HOOK: '0', TOPHAT_CONFIG: path.join(cfg, 'scopes-config.json'), TOPHAT_RUNNER_PROMPT_MODE: 'public', TOPHAT_RUNNER_TRANSCRIPTS: '0' } }
    });
    put('scopes-config.json', { version: 1, scopes: { enabled: true, registryFile: path.join(state, 'demo/scope-registry.json'), authBase: `http://127.0.0.1:${demoPort}/_auth`, orgDomain: 'guest.tophat.invalid', defaultScope: 'legacy' } });
    put('demo.json', {
      instance: './instance.json', db: path.join(state, 'runner/memory.sqlite'), scope: 'tophat-dev', records: path.join(dir, 'r.jsonl'), manifest: path.join(dir, 'm.json'), snapshot: path.join(state, 'demo/snap.json'),
      cache: path.join(state, 'demo/cache'), port: demoPort, bind: '127.0.0.1', frameAncestors: [], slots: [], visitorDb: path.join(state, 'demo/visitors.sqlite'), sessionSecretFile: './secrets/session', edgeSecretFile: './secrets/edge',
      turnstile: { siteKey: 'scratch-key', stub: true }, downloadUrl: 'https://github.com/tophat-md/tophat',
      streamSpeed: TEST_SPEED, visitors: { turnsPerSession: 5, dailyUsd: 3, model: 'claude-haiku-5-5', usdPerTurn: 0.03, sessionHours: 24 }
    });
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_NO_WARNINGS: '1' };
    const log = (name) => openSync(path.join(dir, `${name}.log`), 'a');
    const run = (args, name) => { const c = spawn(process.execPath, args, { cwd: REPO, env, stdio: ['ignore', log(name), log(name)] }); children.push(c); return c; };
    const logs = (name) => { try { return readFileSync(path.join(dir, `${name}.log`), 'utf8').slice(-600); } catch { return ''; } };
    run([path.join(REPO, 'packages/deploy/bin/tophat-deploy.mjs'), 'start', '--config', path.join(cfg, 'instance.json')], 'webchat');
    await until(() => existsSync(path.join(state, 'webchat/events.sqlite')), 40_000, 'the webchat store').catch((e) => { throw new Error(`${e.message}\n${logs('webchat')}`); });
    await until(() => new Promise((r) => net.connect(webchatPort, '127.0.0.1').on('connect', function () { this.destroy(); r(true); }).on('error', () => r(false))), 40_000, 'the webchat port');
    run([path.join(REPO, 'packages/demo/bin/tophat-demo.mjs'), 'serve', '--config', path.join(cfg, 'demo.json')], 'demo');
    await until(async () => (await fetch(`${base()}/healthz`)).ok, 30_000, 'the demo server');

    const url = await chromeUp;
    ws = new WebSocket(url);
    await new Promise((r) => ws.addEventListener('open', r));
    ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } else listeners.forEach((f) => f(m)); });
  });

  after(async () => {
    try { ws?.close(); } catch { /* gone */ }
    for (const c of [chrome, ...children]) { try { c?.kill('SIGKILL'); } catch { /* gone */ } }
    await sleep(300);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  // one visitor: a fresh browser context (own cookies), a fake check, optional page scripts; returns helpers to look at the page
  async function visitor({ fake, delay = 300, scripts = [], checkMs = 4000, introMs = 40_000, url = '/?fresh=1' }) {
    const { browserContextId } = await send('Target.createBrowserContext');
    const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const S = (m, p) => send(m, p, sessionId);
    await S('Page.enable'); await S('Runtime.enable');
    await S('Fetch.enable', { patterns: [{ urlPattern: 'https://challenges.cloudflare.com/*' }] });
    listeners.push((m) => {
      if (m.sessionId !== sessionId || m.method !== 'Fetch.requestPaused') return;
      const id = m.params.requestId;
      if (fake === 'blocked') S('Fetch.failRequest', { requestId: id, errorReason: 'Failed' }).catch(() => {});
      else S('Fetch.fulfillRequest', { requestId: id, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'text/javascript' }, { name: 'access-control-allow-origin', value: '*' }], body: Buffer.from(FAKE_TURNSTILE).toString('base64') }).catch(() => {});
    });
    const boot = `window.__demoFake=${JSON.stringify(fake)};window.__demoFakeDelay=${delay};window.__demoCheckTimeoutMs=${checkMs};window.__demoIntroDeadlineMs=${introMs};try{sessionStorage.setItem('demo-tune',JSON.stringify({speed:${TEST_SPEED}}))}catch(e){}`;
    await S('Page.addScriptToEvaluateOnNewDocument', { source: boot + scripts.join('\n') });
    await S('Page.navigate', { url: base() + url });
    const ev = async (expr) => (await S('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.value;
    return {
      ev,
      where: () => ev('location.pathname + location.search'),
      state: () => ev("fetch('/_demo/state',{credentials:'same-origin'}).then(r=>r.json()).catch(()=>null)"),
      figures: () => ev("document.querySelectorAll('figure').length"),
      composer: () => ev("(document.querySelector('[data-testid=composer]')||{}).value"),
      alerts: () => ev("[...document.querySelectorAll('figure [role=alert]')].map(a=>a.textContent).join('|')"),
      key: (k) => S('Input.dispatchKeyEvent', { type: 'keyDown', key: k, text: k }).then(() => S('Input.dispatchKeyEvent', { type: 'keyUp', key: k })),
      close: () => send('Target.disposeBrowserContext', { browserContextId }).catch(() => {})
    };
  }
  const onFailPage = async (v) => (await v.where()).startsWith('/_demo/text');
  // the outcome is one of two, and a blank chat is neither
  const settled = async (v, ms = 45_000) => until(async () => {
    if (await onFailPage(v)) return 'failed-check page';
    const st = await v.state();
    return st && !st.intro && (await v.figures()) >= FIGURES ? 'first answer' : false;
  }, ms, 'the first answer or the failed-check page');

  test('a check that passes after the answer began: typed intro, the widgets that load, no overlay, no bounce', { timeout: 90_000 }, async () => {
    // the fake check holds its answer until the test gives it (after the answer has begun), instead of guessing a delay
    const v = await visitor({ fake: 'pass', delay: 600_000, checkMs: 30_000 });
    try {
      await until(async () => { const st = await v.state(); return st && !st.intro && st.running; }, 40_000, 'the answer to begin');
      assert.equal((await v.state()).verified, false, 'the check has not passed yet');
      await until(() => v.ev('Boolean(window.__ts)'), 10_000, 'the check widget');
      await v.ev("window.__ts.callback('tok')");
      assert.equal(await settled(v), 'first answer');
      await until(async () => (await v.state()).verified, 15_000, 'the check to pass');
      await until(async () => (await v.ev("document.querySelectorAll('figure iframe').length")) >= FRAMES, 30_000, `${FRAMES} widget frames`);
      assert.equal(await v.alerts(), '', 'no widget failed to load');
      assert.equal((await v.where()).startsWith('/_demo/text'), false);
      assert.equal(await v.ev("Boolean(document.getElementById('demo-limit'))"), false);
    } finally { await v.close(); }
  });

  for (const fake of ['hang', 'error', 'blocked']) {
    test(`a check that ${fake === 'hang' ? 'never answers' : fake === 'error' ? 'errors' : 'cannot load its script'} ends on the failed-check page, with the intro sent first or not at all`, { timeout: 90_000 }, async () => {
      const v = await visitor({ fake, checkMs: fake === 'hang' ? 1000 : 10_000 }); // (the others end by their own retries: two, backed off)
      try {
        assert.equal(await until(async () => ((await onFailPage(v)) ? 'failed-check page' : false), 40_000, 'the failed-check page'), 'failed-check page');
        const st = await v.state();
        assert.equal(st.verified, false);
        assert.ok(await v.ev("document.body.innerText.includes('Click to verify')"), 'the page carries the click-check back');
      } finally { await v.close(); }
    });
  }

  test('the sent opener is answered from its own chat row after about two seconds, then streamed', { timeout: 90_000 }, async () => {
    const v = await visitor({ fake: 'pass' });
    try {
      assert.equal(await settled(v), 'first answer');
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(path.join(dir, 'state/webchat/events.sqlite'), { readOnly: true });
      const id = (await v.state()).opener;
      // without a row for the chat, the app's sync and live feed never carry the answer and the page shows "working" for ever
      assert.ok(db.prepare('SELECT 1 FROM conversations WHERE id=?').get(id), 'the intro chat has a row');
      const at = (kind) => Date.parse(db.prepare('SELECT at FROM events WHERE conversation_id=? AND kind=? ORDER BY cursor LIMIT 1').get(id, kind).at);
      const wait = at('assistant.delta') - at('message.user');
      assert.ok(wait >= 1900 && wait < 2600, `the first words come about 2 s after the send (${wait} ms)`);
      assert.ok(db.prepare("SELECT COUNT(*) n FROM events WHERE conversation_id=? AND kind='assistant.delta'").get(id).n > 100, 'streamed in many chunks');
      await until(() => db.prepare("SELECT 1 FROM events WHERE conversation_id=? AND kind='assistant.message'").get(id), 30_000, 'the answer to complete');
      // the page's engine re-posts an action whose answer it never heard (a dropped connection): the same answer again, and no chat turn
      const itemId = db.prepare("SELECT content FROM events WHERE conversation_id=? AND kind='message.user'").get(id).content;
      const again = await v.ev(`fetch('/api/actions',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({id:'dup',action_id:${JSON.stringify(JSON.parse(itemId).itemId)},op:'message.send',conversation_id:${JSON.stringify(id)},payload:{text:'so, whats ur deal ?',uploads:[]}})}).then(async r=>({status:r.status,body:await r.json()}))`);
      assert.equal(again.status, 200);
      assert.ok(again.body.events.some((e) => e.kind === 'message.user'), 'the redelivery is answered with the stored events');
      assert.equal((await v.state()).turns, 0, 'and no turn is counted');
      db.close();
    } finally { await v.close(); }
  });

  test('the app resets the composer under the typing: the intro is typed again and sent', { timeout: 90_000 }, async () => {
    const v = await visitor({ fake: 'pass', scripts: [WIPE] });
    try { assert.equal(await settled(v), 'first answer'); } finally { await v.close(); }
  });

  test('a send button that never enables: the failed-check page, not a blank chat', { timeout: 90_000 }, async () => {
    const v = await visitor({ fake: 'pass', scripts: [NO_SEND], introMs: 1500 });
    try {
      assert.equal(await settled(v, 30_000), 'failed-check page');
      assert.equal((await v.state()).intro, true, 'nothing was sent');
    } finally { await v.close(); }
  });

  test('a reload after a played intro opens a fresh empty one and types into it', { timeout: 120_000 }, async () => {
    const v = await visitor({ fake: 'pass' });
    try {
      assert.equal(await settled(v), 'first answer');
      const first = (await v.state()).opener;
      await v.ev("location.href='/'");
      await until(async () => (await v.state()).opener !== first, 20_000, 'a fresh intro chat');
      assert.equal(await settled(v), 'first answer');
    } finally { await v.close(); }
  });
  test('the opening load-in: the real app zoomed onto its message bar, the opener typed into the real composer, then the normal app, and the cleanup leaves no trace', { timeout: 90_000 }, async () => {
    // The page records what the screen shows at each typed character (INTRO_RECORD, from the composer's own input events), so the test reads
    // the whole typing after the fact instead of racing a poll against it.
    const v = await visitor({ fake: 'pass', scripts: [INTRO_RECORD] });
    try {
      assert.equal(await settled(v), 'first answer');
      const text = (await v.state()).openerText;
      const seen = await v.ev('window.__introSeen || []');
      const typing = seen.filter((s) => s.value.length > 0 && s.value.length < text.length);
      assert.ok(typing.length >= Math.min(5, text.length - 1), `the opener was seen mid typing (${typing.length} frames)`);
      for (const [i, s] of typing.entries()) {
        assert.ok(text.startsWith(s.value), `what is typed is the opener so far (${JSON.stringify(s.value)})`);
        if (i) assert.ok(s.value.length >= typing[i - 1].value.length, 'typed forward');
        assert.match(s.cls, /\bdemo-intro\b/); assert.match(s.cls, /\bdemo-zoomed\b/);
        assert.ok(s.scale > 1.05, `the app is zoomed in while it types (scale ${s.scale})`);
        // the camera: the bar centred vertically; centred horizontally, or slid left so its right end (the send button) stays 12 px inside the edge
        assert.ok(Math.abs(s.bar.cy - s.vh / 2) <= 6, `the message bar is at the middle of the screen (${s.bar.cy} of ${s.vh})`);
        assert.ok(Math.abs(s.bar.cx - s.vw / 2) <= 6 || Math.abs(s.bar.right - (s.vw - 12)) <= 6, `the bar is centred or its right end is 12 px inside the edge (${JSON.stringify(s.bar)} in ${s.vw})`);
        assert.ok(s.send && s.send.left >= 0 && s.send.right <= s.vw, `the send button is on screen (${JSON.stringify(s.send)})`);
        // the connection coming up is never shown during the opening, whatever the stream is doing
        assert.equal(s.conn, 'hidden', 'no connection dot in the opening');
      }
      // (the page's own poll, every 2.5 s, ends the opener's pending-state rules once the activity line has left queued/starting)
      await until(async () => v.ev("!/demo-/.test(document.documentElement.className)"), 9000, 'the opening cleaned up').catch(async (e) => { throw new Error(e.message + ' cls=' + await v.ev('document.documentElement.className')); });
      assert.equal(await v.ev('document.body.style.transform'), '', 'the zoom is gone');
      assert.equal(await v.ev("document.querySelectorAll('#demo-intro').length"), 0);
    } finally { await v.close(); }
  });

  test('a visitor pressing a key drops the opening at once', { timeout: 60_000 }, async () => {
    const v = await visitor({ fake: 'pass' });
    try {
      await until(async () => v.ev("Boolean(window.__demoIntroOwned) && document.documentElement.classList.contains('demo-intro')"), 20_000, 'the opening');
      await v.key('x');
      await until(async () => v.ev("!/demo-(intro|ready)/.test(document.documentElement.className)"), 2000, 'the opening dropped');
    } finally { await v.close(); }
  });

  test('a link preview (no html Accept, no session) gets a plain 200 page with og tags and makes no guest', async () => {
    const r = await fetch(`${base()}/`, { headers: { 'user-agent': 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)', accept: '*/*' } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('set-cookie'), null);
    const html = await r.text();
    for (const k of ['og:title', 'og:description', 'og:image', 'twitter:card']) assert.ok(html.includes(k), k);
    assert.ok(html.includes('<title>'));
    assert.equal((await fetch(`${base()}/og.png`)).status, 200);
  });
  test('every load starts from nothing: old qk:* keys and engine databases are gone, the Inbox folded', { timeout: 120_000 }, async () => {
    const v = await visitor({ fake: 'pass', url: '/?fresh=1' });
    try {
      await until(async () => (await v.where()).startsWith('/?chat=opener') && v.ev("Boolean(window.__chatEngineWorker) && localStorage.getItem('tophat-workspaces:chats:main-folded')"), 20_000, 'the first load');
      const w1 = await v.ev('window.__chatEngineWorker');
      await v.ev("localStorage.setItem('qk:marker','old');localStorage.setItem('tophat-workspaces:chats:main-folded','0');new Promise((r)=>{const q=indexedDB.open('tophat-engine-old-guest',1);q.onupgradeneeded=()=>{};q.onsuccess=()=>{q.result.close();r(1)}})");
      await v.ev("location.href='/?fresh=1'");
      await until(async () => { const w = await v.ev('window.__chatEngineWorker'); return w && w !== w1; }, 20_000, 'the next load, with its own engine worker');
      assert.equal(await v.ev("localStorage.getItem('qk:marker')"), null, 'the old load\'s device state is gone');
      assert.equal(await v.ev("localStorage.getItem('tophat-workspaces:chats:main-folded')"), '1');
      await until(async () => !(await v.ev("indexedDB.databases().then((l)=>l.some((d)=>d.name==='tophat-engine-old-guest'))")), 10_000, 'the old database deleted');
    } finally { await v.close(); }
  });
});
