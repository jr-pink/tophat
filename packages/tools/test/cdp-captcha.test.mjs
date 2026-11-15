// tophat-cdp captcha: config, spend caps, the 2Captcha client, page detection and injection (against jsdom), and the
// whole solve flow with a fake Chrome connection that evaluates the page scripts in jsdom and a fake provider.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { parseArgv } from '../cdp/tophat-cdp.mjs';
import { DETECT_JS, TURNSTILE_HOOK_JS, injectJs } from '../cdp/captcha-page.mjs';
import { KINDS, appendLedger, buildTask, captchaConfig, checkBudget, readLedger, solveWithProvider, spend, spendSummary } from '../cdp/captcha.mjs';
import { detect, solve } from '../cdp/captcha-run.mjs';
import { redact, resetSecrets } from '../cdp/browser/secrets.mjs';

const KEY = 'test-2captcha-key-0123456789abcdef';
const TOKEN = 'TOKEN-03AFcWeA-abcdefghijklmnopqrstuvwxyz-0123456789';
const GOOD = { provider: '2captcha', keyFile: null, apiBase: 'https://api.example.test', maxUsdPerSolve: 0.05, maxUsdPerDay: 0.02, maxUsdTotal: 0.5,
  estimateUsd: Object.fromEntries(KINDS.map((k) => [k, 0.005])), maxAttempts: 2, initialWaitSeconds: 0, pollSeconds: 0.001, timeoutSeconds: 5 };

/** A temp dir holding the key file, a config file and a ledger path; returns {env, cfg, dir, ledger}. */
function world(t, over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-captcha-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keyFile = path.join(dir, 'key'), ledger = path.join(dir, 'ledger.jsonl'), file = path.join(dir, 'config.json'), capFile = path.join(dir, 'captcha-config.json');
  fs.writeFileSync(keyFile, `${KEY}\n`, { mode: 0o600 });
  const section = over.captcha === null ? undefined : { ...GOOD, keyFile, ledgerFile: ledger, ...(over.captcha || {}) };
  fs.writeFileSync(file, '{}');
  if (section) fs.writeFileSync(capFile, JSON.stringify(section));
  const env = { HOME: dir, TOPHAT_CONFIG: file, TOPHAT_STATE_DIR: path.join(dir, 'state') };
  t.after(() => resetSecrets());
  let cfg = null;
  try { cfg = captchaConfig(env); } catch { /* a test of a bad config reads the error itself */ }
  return { dir, env, ledger, keyFile, cfg };
}

test('config: every limit must be in the file; nothing has a default in code', (t) => {
  const w = world(t);
  assert.equal(w.cfg.maxUsdPerDay, 0.02);
  assert.equal(w.cfg.ledgerFile, w.ledger);
  assert.throws(() => captchaConfig(world(t, { captcha: null }).env), /cannot read .*captcha-config\.json/);
  for (const drop of ['maxUsdPerSolve', 'maxUsdPerDay', 'maxUsdTotal', 'pollSeconds', 'timeoutSeconds', 'maxAttempts', 'estimateUsd', 'keyFile', 'apiBase']) {
    const x = world(t, { captcha: { [drop]: undefined } });
    assert.throws(() => captchaConfig(x.env), new RegExp(drop), drop);
  }
  assert.throws(() => captchaConfig(world(t, { captcha: { estimateUsd: { ...GOOD.estimateUsd, turnstile: 0 } } }).env), /estimateUsd\.turnstile/);
  assert.throws(() => captchaConfig(world(t, { captcha: { enabled: false } }).env), /switched off/);
  assert.throws(() => captchaConfig(world(t, { captcha: { apiBase: 'http://insecure.test' } }).env), /https/);
});

test('ledger: a solve costs its reported cost once done, else its estimate; spend is per local day and lifetime', () => {
  const now = Date.now(), old = now - 3 * 86400_000;
  const entries = [
    { event: 'submit', id: 'a', at: old, estimateUsd: 0.005 }, { event: 'done', id: 'a', ok: true, costUsd: 0.003 },
    { event: 'submit', id: 'b', at: now, estimateUsd: 0.005 }, { event: 'done', id: 'b', ok: true, costUsd: 0.00299 },
    { event: 'submit', id: 'c', at: now, estimateUsd: 0.005 },                                    // in flight or crashed: its estimate
    { event: 'submit', id: 'd', at: now, estimateUsd: 0.005 }, { event: 'done', id: 'd', ok: false, costUsd: 0 },   // refused: free
  ];
  const s = spendSummary(entries, now);
  assert.equal(s.todayUsd, 0.00799);
  assert.equal(s.totalUsd, 0.01099);
  assert.equal(s.todaySolves, 3);
});

test('budget: refused before anything is bought, per solve, per day and lifetime', (t) => {
  const w = world(t), now = Date.now();
  assert.ok(checkBudget(w.cfg, 'turnstile', [], now));
  assert.throws(() => checkBudget({ ...w.cfg, maxUsdPerSolve: 0.004 }, 'turnstile', [], now), (e) => e.code === 5 && /maxUsdPerSolve/.test(e.message));
  const spent = (usd) => [{ event: 'submit', id: 'x', at: now, estimateUsd: usd }, { event: 'done', id: 'x', costUsd: usd }];
  assert.throws(() => checkBudget(w.cfg, 'turnstile', spent(0.016), now), (e) => e.code === 5 && /maxUsdPerDay/.test(e.message));
  assert.ok(checkBudget(w.cfg, 'turnstile', spent(0.015), now));
  assert.throws(() => checkBudget({ ...w.cfg, maxUsdPerDay: 9 }, 'turnstile', spent(0.499), now), (e) => e.code === 5 && /maxUsdTotal/.test(e.message));
});

test('provider: createTask, poll until ready, the cost the provider reports; the key never appears in an error', async (t) => {
  const w = world(t), calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body), method = new URL(url).pathname.slice(1);
    calls.push({ method, body });
    assert.equal(body.clientKey, KEY);
    if (method === 'createTask') return new Response(JSON.stringify({ errorId: 0, taskId: 77 }));
    const polls = calls.filter((c) => c.method === 'getTaskResult').length;
    return new Response(JSON.stringify(polls < 3 ? { errorId: 0, status: 'processing' } : { errorId: 0, status: 'ready', solution: { gRecaptchaResponse: TOKEN }, cost: '0.00299' }));
  };
  const task = buildTask({ kind: 'recaptcha_v2', sitekey: 'K1' }, 'https://x.test/p');
  const r = await solveWithProvider(w.cfg, KEY, task, { fetchImpl, sleep: async () => {} });
  assert.equal(r.token, TOKEN); assert.equal(r.costUsd, 0.00299); assert.equal(r.taskId, 77);
  assert.equal(calls.filter((c) => c.method === 'getTaskResult').length, 3);
  assert.deepEqual(calls[0].body.task, { type: 'RecaptchaV2TaskProxyless', websiteURL: 'https://x.test/p', websiteKey: 'K1' });
  assert.ok(!redact(`leak ${TOKEN}`).includes(TOKEN), 'a token is taught to the redactor');

  const refused = async () => new Response(JSON.stringify({ errorId: 2, errorCode: 'ERROR_ZERO_BALANCE', errorDescription: `no money for ${KEY}` }));
  await assert.rejects(solveWithProvider(w.cfg, KEY, task, { fetchImpl: refused }), /ERROR_ZERO_BALANCE/);
  const down = async () => { throw new Error(`connect failed with key ${KEY}`); };
  await assert.rejects(solveWithProvider(w.cfg, KEY, task, { fetchImpl: down }), (e) => !e.message.includes(KEY) && /NETWORK/.test(e.message));
  const never = async (url) => new Response(JSON.stringify(new URL(url).pathname.endsWith('createTask') ? { errorId: 0, taskId: 5 } : { errorId: 0, status: 'processing' }));
  await assert.rejects(solveWithProvider({ ...w.cfg, timeoutSeconds: 0.01 }, KEY, task, { fetchImpl: never, sleep: (ms) => new Promise((r2) => setTimeout(r2, 20)) }), (e) => e.code === 4 && e.taskId === 5);
});

test('task bodies for every kind', () => {
  const u = 'https://x.test/';
  assert.equal(buildTask({ kind: 'recaptcha_v2', sitekey: 'k', invisible: true, dataS: 's1' }, u).isInvisible, true);
  assert.equal(buildTask({ kind: 'recaptcha_v2_enterprise', sitekey: 'k' }, u).type, 'RecaptchaV2EnterpriseTaskProxyless');
  assert.deepEqual(buildTask({ kind: 'recaptcha_v3', sitekey: 'k', enterprise: true }, u, { minScore: 0.7, action: 'login' }), { type: 'RecaptchaV3TaskProxyless', websiteURL: u, websiteKey: 'k', minScore: 0.7, pageAction: 'login', isEnterprise: true });
  assert.equal(buildTask({ kind: 'hcaptcha', sitekey: 'k' }, u).type, 'HCaptchaTaskProxyless');
  assert.deepEqual(buildTask({ kind: 'turnstile', sitekey: 'k', action: 'managed', cData: 'cd', chlPageData: 'pd' }, u), { type: 'TurnstileTaskProxyless', websiteURL: u, websiteKey: 'k', action: 'managed', data: 'cd', pagedata: 'pd' });
});

const page = (html, url = 'https://example.test/form') => {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
  return dom;
};
const plain = (v) => JSON.parse(JSON.stringify(v));   // jsdom objects come from another realm
const detectIn = (dom) => plain(dom.window.eval(DETECT_JS));

test('detect: reCAPTCHA v2 widget, v2 iframe anchor, v3 render key, hCaptcha, Turnstile, challenge and unsupported pages', () => {
  const v2 = detectIn(page('<form><div class="g-recaptcha" data-sitekey="V2KEY" data-callback="onOk" data-size="invisible"></div></form>'));
  assert.deepEqual(v2.widgets.map((w) => [w.kind, w.sitekey, w.callbackName, w.invisible]), [['recaptcha_v2', 'V2KEY', 'onOk', true]]);
  const anchor = detectIn(page('<iframe src="https://www.google.com/recaptcha/api2/anchor?ar=1&k=ANCHORKEY&size=normal"></iframe>'));
  assert.deepEqual(anchor.widgets.map((w) => [w.kind, w.sitekey]), [['recaptcha_v2', 'ANCHORKEY']]);
  const v3 = detectIn(page('<script src="https://www.google.com/recaptcha/api.js?render=V3KEY"></script><iframe src="https://www.google.com/recaptcha/api2/anchor?k=V3KEY&size=invisible"></iframe>'));
  assert.deepEqual(v3.widgets.map((w) => [w.kind, w.sitekey]), [['recaptcha_v3', 'V3KEY']]);
  const ent = detectIn(page('<script src="https://www.google.com/recaptcha/enterprise.js?render=ENTKEY"></script>'));
  assert.equal(ent.widgets[0].enterprise, true);
  const h = detectIn(page('<div class="h-captcha" data-sitekey="HKEY"></div><iframe src="https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html#frame=checkbox&sitekey=HKEY2"></iframe>'));
  assert.deepEqual(h.widgets.map((w) => [w.kind, w.sitekey]), [['hcaptcha', 'HKEY'], ['hcaptcha', 'HKEY2']]);
  const ts = detectIn(page('<div class="cf-turnstile" data-sitekey="0x4AAAAAAAtest00000000" data-action="login"></div>'));
  assert.deepEqual(ts.widgets.map((w) => [w.kind, w.sitekey, w.action]), [['turnstile', '0x4AAAAAAAtest00000000', 'login']]);
  const frame = detectIn(page('<iframe src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv/abc/0x4AAAAAAAframe0000000/light/fbE/new/normal/auto/"></iframe>'));
  assert.equal(frame.widgets[0].sitekey, '0x4AAAAAAAframe0000000');
  const empty = detectIn(page('<h1>hello</h1>'));
  assert.deepEqual([empty.widgets.length, empty.challenge, empty.unsupported.length], [0, false, 0]);
  assert.equal(detectIn(page('<title>Just a moment...</title><div id="challenge-running"></div>')).challenge, true);
  assert.match(detectIn(page('<title>Attention Required! | Cloudflare</title><h1>Sorry, you have been blocked</h1>')).unsupported[0], /block page/);
  assert.match(detectIn(page('<div id="px-captcha"></div>')).unsupported[0], /perimeterx/);
  const hooked = page('<title>Just a moment...</title>');
  hooked.window.__tophatTs = { sitekey: '0x4AAAAAAAhook', action: 'managed', cData: 'cd', chlPageData: 'pd' };
  assert.deepEqual(detectIn(hooked).widgets.map((w) => [w.sitekey, w.intercepted, w.cData]), [['0x4AAAAAAAhook', true, 'cd']]);
});

test('the Turnstile hook captures render parameters and the callback, and survives a frozen-late assignment', () => {
  const dom = page('<p></p>');
  dom.window.eval(TURNSTILE_HOOK_JS);
  dom.window.turnstile = { render() { throw new Error('the real render must not run'); } };
  return new Promise((resolve) => setTimeout(() => {
    const cb = () => 'cb';
    assert.equal(dom.window.turnstile.render('#x', { sitekey: 'SK', action: 'managed', cData: 'cd', chlPageData: 'pd', callback: cb }), 'tophat-ts');
    assert.deepEqual(JSON.parse(JSON.stringify(dom.window.__tophatTs)), { sitekey: 'SK', action: 'managed', cData: 'cd', chlPageData: 'pd' });
    assert.equal(dom.window.__tophatTsCb, cb);
    dom.window.close();   // the hook's 90 s give-up timer would otherwise hold the process open
    resolve();
  }, 30));
});

test('inject: response fields set, the data-callback fired with the token, optional submit; the result never carries the token', () => {
  const dom = page('<form id="f"><textarea name="g-recaptcha-response"></textarea><div class="g-recaptcha" data-sitekey="K" data-callback="onOk"></div></form>');
  dom.window.eval(`window.got = null; window.onOk = (t) => { window.got = t; }; document.getElementById('f').addEventListener('submit', (e) => { window.sent = true; e.preventDefault(); })`);
  const widget = { kind: 'recaptcha_v2', sitekey: 'K', callbackName: 'onOk' };
  const out = plain(dom.window.eval(injectJs(TOKEN, widget, { submit: true })));
  assert.deepEqual([out.fields, out.callback, out.submitted], [1, 'data-callback onOk', false], 'a page that gave a callback submits itself');
  assert.equal(dom.window.got, TOKEN);
  assert.equal(dom.window.document.querySelector('textarea').value, TOKEN);
  assert.equal(dom.window.sent, undefined);
  const bare = page('<form id="f"><textarea name="g-recaptcha-response"></textarea></form>');
  bare.window.eval(`document.getElementById('f').addEventListener('submit', (e) => { window.sent = true; e.preventDefault(); })`);
  assert.deepEqual(plain(bare.window.eval(injectJs(TOKEN, widget, { submit: true }))), { fields: 1, callback: null, callbackError: null, submitted: true });
  assert.equal(bare.window.sent, true);
  assert.ok(!JSON.stringify(out).includes(TOKEN));

  const cfg = page('<textarea name="g-recaptcha-response"></textarea>');
  cfg.window.eval('window.___grecaptcha_cfg = { clients: { 0: { aa: { l: { callback: (t) => { window.viaCfg = t; } } } } } }');
  assert.equal(plain(cfg.window.eval(injectJs(TOKEN, { kind: 'recaptcha_v2', sitekey: 'K' }))).callback, 'grecaptcha client callback');
  assert.equal(cfg.window.viaCfg, TOKEN);

  const tsPage = page('<form><input type="hidden" name="cf-turnstile-response"></form><iframe data-hcaptcha-widget-id="x"></iframe>');
  tsPage.window.__tophatTsCb = (t) => { tsPage.window.tsGot = t; };
  assert.equal(tsPage.window.eval(injectJs(TOKEN, { kind: 'turnstile', sitekey: 'K' })).callback, 'intercepted turnstile.render callback');
  assert.equal(tsPage.window.document.querySelector('input').value, TOKEN);

  const h = page('<textarea name="h-captcha-response"></textarea><textarea name="g-recaptcha-response"></textarea><iframe data-hcaptcha-widget-id="x"></iframe>');
  assert.equal(h.window.eval(injectJs(TOKEN, { kind: 'hcaptcha', sitekey: 'K' })).fields, 2);
  assert.equal(h.window.document.querySelector('iframe').getAttribute('data-hcaptcha-response'), TOKEN);
  assert.equal(page('<p>nothing here</p>').window.eval(injectJs(TOKEN, widget)).fields, 0);
});

/** A fake Chrome connection: Runtime.evaluate runs in the jsdom page; everything else is a no-op. */
function fakeChrome(dom) {
  const sent = [];
  const conn = { async send(method, params) {
    sent.push(method);
    if (method !== 'Runtime.evaluate') return {};
    const v = dom.window.eval(params.expression);
    return { result: { value: v === undefined ? undefined : JSON.parse(JSON.stringify(v)) } };
  } };
  return { sent, deps: { withTarget: async (ep, target, fn) => fn(conn), sleep: async () => {} } };
}
const provider = (token = TOKEN, cost = '0.00299') => {
  const seen = [];
  return { seen, fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body), method = new URL(url).pathname.slice(1);
    seen.push({ method, body });
    if (method === 'createTask') return new Response(JSON.stringify({ errorId: 0, taskId: 9 }));
    return new Response(JSON.stringify({ errorId: 0, status: 'ready', solution: { gRecaptchaResponse: token, token }, cost }));
  } };
};
const DEMO = '<form id="f"><div class="g-recaptcha" data-sitekey="DEMOKEY" data-callback="onSuccess"></div><textarea name="g-recaptcha-response"></textarea></form>';

test('solve end to end: detect, buy, inject, fire the callback; ledger and result carry the cost and never the token', async (t) => {
  const w = world(t), dom = page(DEMO), chrome = fakeChrome(dom), p = provider();
  dom.window.eval(`window.onSuccess = (t) => { window.verified = t; }; document.getElementById('f').addEventListener('submit', (e) => { window.sent = true; e.preventDefault(); })`);
  const r = await solve('http://x', { id: 'T', url: 'https://example.test/form' }, { submit: true, settle: 0 }, { ...chrome.deps, env: w.env, fetchImpl: p.fetchImpl });
  assert.equal(r.solved, true); assert.equal(r.kind, 'recaptcha_v2'); assert.equal(r.costUsd, 0.00299); assert.equal(r.callback, 'data-callback onSuccess'); assert.equal(r.submitted, true, 'the page stayed put after its callback, so the form was submitted');
  assert.equal(dom.window.verified, TOKEN); assert.equal(dom.window.sent, true);
  assert.equal(p.seen[0].body.task.websiteKey, 'DEMOKEY'); assert.equal(p.seen[0].body.task.websiteURL, 'https://example.test/form');
  assert.ok(!JSON.stringify(r).includes(TOKEN) && !JSON.stringify(r).includes(KEY));
  const led = readLedger(w.ledger);
  assert.deepEqual(led.map((e) => e.event), ['submit', 'done']);
  assert.equal(led[1].costUsd, 0.00299);
  assert.ok(!JSON.stringify(led).includes(TOKEN) && !JSON.stringify(led).includes(KEY));
  assert.equal(spend(w.env).todayUsd, 0.00299);
  assert.ok(!JSON.stringify(await detect('http://x', { id: 'T' }, chrome.deps)).includes(TOKEN));
});

test('solve --submit: a callback that leaves the page where it was is followed by a form submit; one that navigates is not', async (t) => {
  const w = world(t), p = provider();
  const stay = page(DEMO);
  stay.window.eval(`window.onSuccess = () => {}; window.sent = 0; document.getElementById('f').addEventListener('submit', (e) => { window.sent += 1; e.preventDefault(); })`);
  const r = await solve('http://x', { id: 'T', url: 'https://example.test/form' }, { submit: true, settle: 0 }, { ...fakeChrome(stay).deps, env: w.env, fetchImpl: p.fetchImpl });
  assert.equal(r.callback, 'data-callback onSuccess'); assert.equal(r.submitted, true); assert.equal(stay.window.sent, 1);
  const goes = page(DEMO);
  goes.window.eval(`window.onSuccess = () => { history.pushState({}, '', '/after'); document.querySelector('.g-recaptcha').remove(); }; window.sent = 0; document.getElementById('f').addEventListener('submit', (e) => { window.sent += 1; e.preventDefault(); })`);
  const r2 = await solve('http://x', { id: 'T', url: 'https://example.test/form' }, { submit: true, settle: 0 }, { ...fakeChrome(goes).deps, env: w.env, fetchImpl: p.fetchImpl });
  assert.equal(r2.submitted, false); assert.equal(goes.window.sent, 0); assert.equal(r2.after.urlChanged, true);
});

test('solve: a cap refuses before anything is bought; no captcha buys nothing; --no-inject buys and keeps the token out', async (t) => {
  const w = world(t, { captcha: { maxUsdPerDay: 0.006 } }), p = provider();
  const run = (dom, a, env = w.env) => solve('http://x', { id: 'T', url: 'https://example.test/' }, { settle: 0, ...a }, { ...fakeChrome(dom).deps, env, fetchImpl: p.fetchImpl });
  await assert.rejects(run(page('<h1>no captcha</h1>'), {}), (e) => e.code === 3 && /no solvable captcha/.test(e.message));
  assert.equal(p.seen.length, 0);
  const r = await run(page(DEMO), { no_inject: true });
  assert.equal(r.injected, false); assert.ok(!JSON.stringify(r).includes(TOKEN));
  // 0.00299 spent of 0.006 a day: another 0.005 estimate would pass 0.006, so the second solve is refused up front
  await assert.rejects(run(page(DEMO), {}), (e) => e.code === 5 && /maxUsdPerDay/.test(e.message));
  assert.equal(p.seen.filter((c) => c.method === 'createTask').length, 1);
  await assert.rejects(run(page(DEMO), {}, { ...w.env, TOPHAT_CONFIG: path.join(w.dir, 'missing', 'config.json') }), /cannot read .*captcha-config\.json/);
});

test('solve: a timeout stays on the books at its estimate; an unsolvable task is free and retried up to maxAttempts', async (t) => {
  const w = world(t, { captcha: { maxUsdPerDay: 1, maxAttempts: 2 } });
  let n = 0;
  const unsolvable = async (url) => (new URL(url).pathname.endsWith('createTask') ? new Response(JSON.stringify({ errorId: 0, taskId: ++n })) : new Response(JSON.stringify({ errorId: 12, errorCode: 'ERROR_CAPTCHA_UNSOLVABLE', errorDescription: 'x' })));
  await assert.rejects(solve('http://x', { id: 'T', url: 'https://example.test/' }, { settle: 0 }, { ...fakeChrome(page(DEMO)).deps, env: w.env, fetchImpl: unsolvable }), /not solved after 2 attempt/);
  assert.equal(n, 2);
  assert.equal(spend(w.env).todayUsd, 0);
  const slow = async (url) => new Response(JSON.stringify(new URL(url).pathname.endsWith('createTask') ? { errorId: 0, taskId: 3 } : { errorId: 0, status: 'processing' }));
  const w2 = world(t, { captcha: { maxUsdPerDay: 1, timeoutSeconds: 0.01 } });
  await assert.rejects(solve('http://x', { id: 'T', url: 'https://example.test/' }, { settle: 0 }, { ...fakeChrome(page(DEMO)).deps, env: w2.env, fetchImpl: slow, sleep: (ms) => new Promise((r) => setTimeout(r, 15)) }), (e) => e.code === 4);
  assert.equal(spend(w2.env).todayUsd, 0.005);
});

test('solve: a Cloudflare challenge page is reloaded with the hook, the intercepted parameters are what is bought', async (t) => {
  const w = world(t), dom = page('<title>Just a moment...</title><div id="challenge-running"></div>', 'https://blocked.example/x'), p = provider();
  const chrome = fakeChrome(dom);
  const withTarget = async (ep, target, fn) => fn({ async send(method, params) {
    if (method === 'Page.reload') dom.window.__tophatTs = { sitekey: '0x4AAAAAAAchal', action: 'managed', cData: 'CD', chlPageData: 'PD' };   // what the hook records after the reload
    if (method === 'Page.reload') dom.window.__tophatTsCb = (tok) => { dom.window.verified = tok; };
    chrome.sent.push(method);
    if (method !== 'Runtime.evaluate') return {};
    const v = dom.window.eval(params.expression);
    return { result: { value: v === undefined ? undefined : JSON.parse(JSON.stringify(v)) } };
  } });
  const r = await solve('http://x', { id: 'T', url: 'https://blocked.example/x' }, { settle: 0 }, { withTarget, sleep: async () => {}, env: w.env, fetchImpl: p.fetchImpl });
  assert.ok(chrome.sent.includes('Page.reload'));
  assert.equal(r.intercepted, true); assert.equal(r.callback, 'intercepted turnstile.render callback');
  assert.deepEqual(p.seen[0].body.task, { type: 'TurnstileTaskProxyless', websiteURL: 'https://blocked.example/x', websiteKey: '0x4AAAAAAAchal', action: 'managed', data: 'CD', pagedata: 'PD' });
  assert.equal(dom.window.verified, TOKEN);
  // --no-hook: nothing is reloaded and nothing is bought
  const dom2 = page('<title>Just a moment...</title><div id="challenge-running"></div>'), c2 = fakeChrome(dom2);
  await assert.rejects(solve('http://x', { id: 'T', url: 'https://blocked.example/x' }, { settle: 0, no_hook: true }, { ...c2.deps, env: w.env, fetchImpl: p.fetchImpl }), /--no-hook/);
  assert.ok(!c2.sent.includes('Page.reload'));
});

test('command line: captcha parses with a job, balance and spend need no tab, bad kinds are refused', () => {
  const ok = parseArgv(['--job', 'j1', 'captcha', 'solve', '--submit', '--kind', 'turnstile', '--index', '1']);
  assert.ok(ok.ns, JSON.stringify(ok.error));
  assert.deepEqual([ok.ns.command, ok.ns.what, ok.ns.submit, ok.ns.kind, ok.ns.index, ok.ns.target], ['captcha', 'solve', true, 'turnstile', 1, 'job=j1']);
  assert.equal(parseArgv(['captcha', 'balance']).ns.what, 'balance');
  assert.equal(parseArgv(['--job', 'j1', 'captcha', 'spend']).ns.what, 'spend');
  assert.match(parseArgv(['--job', 'j1', 'captcha', 'solve', '--kind', 'funcaptcha']).error, /invalid choice/);
  assert.match(parseArgv(['--job', 'j1', 'captcha', 'buy']).error, /invalid choice/);
});
