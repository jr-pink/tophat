// web_open's real-browser route: a captcha wall is handed to `tophat-cdp captcha solve` and the page is read again;
// only a failed or refused solve is reported as an owner blocker, with the solver's reason in the message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cdpBrowser, openPage, webConfig } from '../rev6/tools/runner/web.mjs';

const WALL = '<html><head><title>Just a moment...</title></head><body><div id="challenge-running"></div><script>window._cf_chl_opt={cvId:"3"}</script>Checking your browser before accessing</body></html>';
const RECAPTCHA = '<html><body><h1>Unusual traffic</h1><div class="g-recaptcha" data-sitekey="K"></div></body></html>';
const ARTICLE = `<html><head><title>A real article</title></head><body><article><h1>A real article</h1>${'<p>Solved pages read like this one. </p>'.repeat(120)}</article></body></html>`;

/** A fake tophat-cdp: records every call, answers claim/wait-for/info/html/release, and `captcha solve` by `solver`. */
function fakeCdp({ pages, solver }) {
  const calls = [];
  let solved = false;
  const exec = async (args) => {
    calls.push(args.join(' '));
    const verb = args[0] === '--job' ? args[2] : args[0];
    if (verb === 'job') return JSON.stringify({ job: args[2] });
    if (verb === 'wait-for') return 'ok';
    if (verb === 'info') return JSON.stringify({ live: { ready: 'complete', url: 'https://walled.example/page' } });
    if (verb === 'html') return solved ? pages.after : pages.before;
    if (verb === 'captcha') { const out = await solver(args); solved = true; return out; }
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  return { exec, calls };
}
const failure = (message) => Object.assign(new Error(`tophat-cdp captcha failed (exit 5): tophat-cdp: ${message}`), { code: 5 });

test('a Cloudflare challenge wall: the solver runs in the same tab and the page is read again', async () => {
  const cdp = fakeCdp({ pages: { before: WALL, after: ARTICLE }, solver: async () => JSON.stringify({ solved: true, kind: 'turnstile', costUsd: 0.00145, attempts: 1 }) });
  const got = await cdpBrowser({ bin: 'x', timeoutMs: 30_000, captchaMs: 5000, execImpl: cdp.exec })('https://walled.example/page');
  assert.match(got.html, /A real article/);
  assert.deepEqual(got.captcha, { solved: true, kind: 'turnstile', costUsd: 0.00145, attempts: 1 });
  assert.ok(cdp.calls.some((c) => /^--job web-open-\S+ captcha solve --submit --settle 6$/.test(c)), cdp.calls.join('\n'));
  assert.match(cdp.calls.at(-1), /^job release web-open-\S+ --close$/);
});

test('a page that is not a wall never calls the solver; a wall it cannot read (PerimeterX) is not sent to it', async () => {
  const plain = fakeCdp({ pages: { before: ARTICLE }, solver: async () => { throw new Error('unreached'); } });
  await cdpBrowser({ bin: 'x', captchaMs: 5000, execImpl: plain.exec })('https://ok.example/');
  assert.ok(!plain.calls.some((c) => c.includes('captcha')));
  const px = fakeCdp({ pages: { before: '<html><body><div id="px-captcha"></div>Press &amp; Hold</body></html>' }, solver: async () => { throw new Error('unreached'); } });
  const got = await cdpBrowser({ bin: 'x', captchaMs: 5000, execImpl: px.exec })('https://px.example/');
  assert.equal(got.captcha, undefined);
  assert.ok(!px.calls.some((c) => c.includes('captcha solve')));
});

test('a failed or refused solve keeps the wall and carries the solver reason; with the solver off it says so', async () => {
  const refused = fakeCdp({ pages: { before: RECAPTCHA }, solver: async () => { throw failure("captcha budget: today's spend $1.99 plus this solve ($0.005) exceeds maxUsdPerDay $2; nothing bought"); } });
  const got = await cdpBrowser({ bin: 'x', captchaMs: 5000, execImpl: refused.exec })('https://walled.example/page');
  assert.match(got.captcha.error, /^captcha budget: .*maxUsdPerDay/);
  assert.match(got.html, /g-recaptcha/);
  const off = fakeCdp({ pages: { before: RECAPTCHA }, solver: async () => { throw new Error('unreached'); } });
  const skipped = await cdpBrowser({ bin: 'x', captchaMs: 0, execImpl: off.exec })('https://walled.example/page');
  assert.match(skipped.captcha.skipped, /TOPHAT_RUNNER_WEB_CAPTCHA=0/);
  assert.ok(!off.calls.some((c) => c.includes('captcha solve')));
});

const wallFetch = async () => new Response('<html><title>Just a moment...</title><body>Checking your browser before accessing</body></html>', { status: 403, headers: { 'content-type': 'text/html' } });
const env = { TOPHAT_RUNNER_WEB_ALLOW_LOCAL: '1', TOPHAT_RUNNER_WEB_OPEN_FALLBACK: 'browser', TOPHAT_RUNNER_WEB_JINA: '0' };

test('openPage: solved wall returns the page and says what was bought; unsolved reports the owner blocker with the reason', async () => {
  assert.equal(webConfig({}).captcha, true);
  assert.equal(webConfig({ TOPHAT_RUNNER_WEB_CAPTCHA: '0' }).captcha, false);
  const solved = await openPage('http://127.0.0.1:9/walled', { env, fetchImpl: wallFetch, browserImpl: async (url) => ({ url, html: ARTICLE, captcha: { solved: true, kind: 'turnstile', costUsd: 0.00145 } }) });
  assert.equal(solved.route, 'browser');
  assert.equal(solved.captcha_solved.costUsd, 0.00145);
  assert.match(solved.text, /Solved pages read like this one/);

  const stuck = await openPage('http://127.0.0.1:9/walled', { env, fetchImpl: wallFetch, browserImpl: async (url) => ({ url, html: WALL, captcha: { error: 'no solvable captcha on https://x/ (a Cloudflare challenge page whose turnstile.render call was not seen)' } }) });
  assert.match(stuck.blocker, /^captcha: owner blocker \(cloudflare challenge in the real browser; solver failed: no solvable captcha/);
  assert.doesNotMatch(stuck.blocker, /not bypassed/);
  const off = await openPage('http://127.0.0.1:9/walled', { env, fetchImpl: wallFetch, browserImpl: async (url) => ({ url, html: WALL, captcha: { skipped: 'solver off (TOPHAT_RUNNER_WEB_CAPTCHA=0)' } }) });
  assert.match(off.blocker, /solver off/);
});
