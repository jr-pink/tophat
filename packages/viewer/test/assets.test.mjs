// The static side: what the hub serves at /graph (and only that), the page's security headers, and the committed bundle
// (present, self-contained, no network address in it but the page's own origin).
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Hub } from '@tophat-md/linknotes';
import { tmp, SECRET } from '@tophat-md/linknotes/testing';
import { hubView, viewerAssets, ASSETS } from '../src/index.mjs';

test('the bundle is built and self-contained', () => {
  const a = viewerAssets();
  for (const p of ['/graph', '/graph/app.js', '/graph/libs.js', '/graph/sim.js']) assert.ok(a[p] && a[p].body.length > 1000, p);
  const app = readFileSync(path.join(ASSETS, 'app.js'), 'utf8');
  assert.match(app, /memcloud-wrap-v1\|/, 'the cipher is in the app bundle');
  assert.doesNotMatch(app, /require\(|from"node:|import\("node:/, 'no Node module in the browser bundle');
  for (const f of ['app.js', 'libs.js', 'sim.js', 'index.html']) {
    const urls = (readFileSync(path.join(ASSETS, f), 'utf8').match(/https?:\/\/[A-Za-z0-9.-]+/g) || []).filter((u) => !/^http:\/\/www\.w3\.org$/.test(u));
    assert.deepEqual(urls, [], `${f} names no network address`);
  }
  const html = readFileSync(path.join(ASSETS, 'index.html'), 'utf8');
  assert.match(html, /<meta name="th-hub" content="">/);
  assert.match(html, /<script src="\/graph\/libs\.js"><\/script>\s*<script src="\/graph\/app\.js"><\/script>/);
});

test('the hub serves the app at /graph, /graph/<asset> and /e/<id>, with a strict CSP, and nothing else there', async () => {
  const hub = new Hub(path.join(tmp('viewer-assets-'), 'hub.sqlite'), { secret: SECRET, view: hubView() });
  const server = await hub.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(`${base}/graph`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    const csp = page.headers.get('content-security-policy');
    assert.match(csp, /default-src 'none'/); assert.match(csp, /connect-src 'self'(;|$)/); assert.match(csp, /script-src 'self'(;|$)/);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.match(await page.text(), /id="th-lock"/);
    const deep = await fetch(`${base}/e/e_0123456789`);
    assert.equal(deep.status, 200); assert.match(await deep.text(), /id="th-lock"/);
    const js = await fetch(`${base}/graph/app.js`);
    assert.equal(js.status, 200); assert.match(js.headers.get('content-type'), /javascript/); assert.ok(js.headers.get('etag'));
    assert.equal((await fetch(`${base}/graph/data.json`)).status, 404, 'no data route: the hub serves no graph data');
    assert.notEqual((await fetch(`${base}/graph/%2e%2e/hub.sqlite`)).status, 200, 'no file outside the bundle');
    assert.equal((await fetch(`${base}/graph`, { method: 'POST', body: '{}' })).status, 405);
    assert.equal((await fetch(`${base}/healthz`)).status, 200, 'the hub protocol is untouched');
    assert.equal((await fetch(`${base}/v1/pull?after=0`)).status, 401);
    const other = hubView({ hubUrl: 'https://hub.example.org/' });
    const [, html, hdrs] = await other.handle('GET', new URL('http://x/graph'));
    assert.match(hdrs['content-security-policy'], /connect-src 'self' https:\/\/hub\.example\.org;/);
    assert.match(html, /<meta name="th-hub" content="https:\/\/hub\.example\.org">/);
  } finally { await new Promise((r) => server.close(r)); hub.close(); }
});
