// Headless smoke test: the built bundle in a real browser against a local hub that serves it at /graph. Opt-in: set
// VIEWER_SMOKE_CDP to a Chrome DevTools endpoint (http://127.0.0.1:PORT) and VIEWER_SMOKE_TARGET to the id of a page
// target the test may drive (it attaches to that target only, never opens or closes tabs). Skipped otherwise.
// Checks: the lock form takes the key file, token and passphrase; the graph renders exactly the replica's node count;
// a reload unlocks from the sealed IndexedDB copy with the passphrase alone; every request goes to the hub's origin.
import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { Hub, issueToken, httpTransport, SqliteBackend } from '@tophat-md/linknotes';
import { tmp, SECRET, settle } from '@tophat-md/linknotes/testing';
import { hubView, exportKeys, ASSETS } from '../src/index.mjs';
import { buildGraph } from '../src/core/graph.mjs';
import { storeView } from './store-view.mjs';

const CDP = process.env.VIEWER_SMOKE_CDP, TARGET = process.env.VIEWER_SMOKE_TARGET;
const skip = !CDP || !TARGET ? 'set VIEWER_SMOKE_CDP and VIEWER_SMOKE_TARGET to run' : !existsSync(path.join(ASSETS, 'index.html')) ? 'bundle not built' : false;
const PASS = 'smoke test passphrase';
const token = (device, user) => issueToken(SECRET, { device, user, expiresAt: Math.floor(Date.now() / 1000) + 3600 });

/** A CDP session on one target. */
async function attach(endpoint, targetId) {
  const list = await (await fetch(`${endpoint}/json/list`)).json();
  const t = list.find((x) => x.id === targetId);
  if (!t) throw new Error(`no target ${targetId}`);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map(), listeners = [];
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } else for (const l of listeners) l(m); };
  const send = (method, params = {}) => new Promise((res, rej) => { const n = ++id; pending.set(n, { res, rej }); ws.send(JSON.stringify({ id: n, method, params })); });
  const evaluate = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
  const until = async (expr, ms = 30000) => { const t0 = Date.now(); for (;;) { const v = await evaluate(expr).catch(() => null); if (v) return v; if (Date.now() - t0 > ms) { const why = await evaluate("[(document.getElementById('mg-status') || {}).textContent, (document.getElementById('th-err') || {}).textContent].join(' | ')").catch((e) => e.message); throw new Error(`timed out waiting for ${expr} (page: ${why})`); } await new Promise((r) => setTimeout(r, 150)); } };
  return { send, evaluate, until, on: (f) => listeners.push(f), close: () => ws.close() };
}

test('the built viewer renders the graph from the ciphertext log in a real browser', { skip, timeout: 180000 }, async () => {
  const dir = tmp('viewer-smoke-');
  const hub = new Hub(path.join(dir, 'hub.sqlite'), { secret: SECRET, view: hubView() });
  const server = await hub.listen(0);
  const hubUrl = `http://127.0.0.1:${server.address().port}`;
  const mk = (user, device) => new SqliteBackend({ file: path.join(dir, `${device}.sqlite`), keyFile: path.join(dir, `${device}.key.json`), user, device, writeScopes: [user] }, { transport: httpTransport(hubUrl, token(device, user)) });
  const A = mk('alex', 'alex-laptop'), D = mk('dana', 'dana-laptop');
  let cdp = null; const extra = [];
  try {
    await A.createScope('alex'); await D.createScope('dana'); await A.createScope('shop');
    await settle(A, D); await A.addMember('shop', 'dana', 'write'); await settle(A, D);
    const ids = [];
    for (let i = 0; i < 24; i++) {
      const scopes = i % 3 === 0 ? ['alex'] : ['shop'];
      const ents = [{ id: '$a', name: `Bench Item ${i}`, type: ['person', 'project', 'place', 'artifact'][i % 4], scopes }];
      const refs = ['$a'];
      if (ids.length) refs.push(ids[(i * 7) % ids.length].id);
      if (ids.length > 3) refs.push(ids[(i * 5) % ids.length].id);
      const s = i % 3 === 0 ? A : (i % 2 ? D : A);
      const usable = refs.filter((r) => r === '$a' || ids.find((x) => x.id === r && (scopes[0] === 'shop' ? x.scope === 'shop' : true)));
      const r = await s.apply({ entities: ents, notes: [{ body: `NOTE-${i}: smoke note`, entities: [...new Set(usable)], scopes, at: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString() }] }, { scopes });
      ids.push({ id: r.id_map.$a, scope: scopes[0] });
      await settle(A, D);
    }
    await settle(A, D);
    const A2 = mk('alex', 'alex-phone'); extra.push(A2); await settle(A, A2, D);
    const expected = buildGraph(storeView(A2, 'alex')).nodes.length;
    assert.ok(expected > 10, `the replica's graph has ${expected} nodes`);
    const keyFile = path.join(dir, 'alex.viewer-keys.json');
    writeFileSync(keyFile, JSON.stringify(await exportKeys({ config: A.config, passphrase: PASS, iterations: 2000 })));

    cdp = await attach(CDP, TARGET);
    const requests = [];
    cdp.on((m) => { if (m.method === 'Network.requestWillBeSent') requests.push(m.params.request.url); });
    await cdp.send('Network.enable'); await cdp.send('Page.enable'); await cdp.send('DOM.enable'); await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: `${hubUrl}/graph` });
    await cdp.until("document.readyState === 'complete' && !!document.getElementById('th-lock') && !document.getElementById('th-lock').hidden");
    const doc = await cdp.send('DOM.getDocument', { depth: -1 });
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#th-file' });
    await cdp.send('DOM.setFileInputFiles', { nodeId, files: [keyFile] });
    await cdp.evaluate(`document.getElementById('th-token').value = ${JSON.stringify(token('alex-browser', 'alex'))}; document.getElementById('th-pass').value = ${JSON.stringify(PASS)}; document.getElementById('th-form').requestSubmit(); true`);
    const n = await cdp.until('window.__mg && window.__mg.ents.length > 0 && window.__mg.ents.length');
    assert.equal(n, expected, 'the browser graph has the replica\'s node count');
    const drawn = await cdp.evaluate("(() => { const c = document.querySelectorAll('#mg-canvas canvas'); return c.length; })()");
    assert.ok(drawn >= 2, `sigma drew its canvases (${drawn})`);
    if (process.env.VIEWER_SMOKE_SHOT) { await new Promise((r) => setTimeout(r, 1500)); const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(process.env.VIEWER_SMOKE_SHOT, Buffer.from(shot.data, 'base64')); }
    const sess = await cdp.evaluate('window.__mg.session');
    assert.equal(sess.user, 'alex'); assert.ok(sess.kept);
    await cdp.until('window.__trace.saveStateMs != null', 15000);
    // a page opens from the local model
    await cdp.evaluate('window.__mg.openPage(window.__mg.ents[0].id)');
    await cdp.until("document.querySelector('#mg-mbody h1') && document.querySelectorAll('#mg-mbody .nt div').length > 0");
    // reload: the passphrase alone opens the sealed copy, and the graph is the same
    await cdp.send('Page.navigate', { url: `${hubUrl}/graph` });
    await cdp.until("document.readyState === 'complete' && !document.getElementById('th-lock').hidden && document.getElementById('th-new').hidden");
    await cdp.evaluate(`document.getElementById('th-pass').value = ${JSON.stringify(PASS)}; document.getElementById('th-form').requestSubmit(); true`);
    const n2 = await cdp.until('window.__mg && window.__mg.ents.length');
    assert.equal(n2, expected);
    assert.equal(await cdp.evaluate('window.__trace.source'), 'cache');
    // the sealed copy holds no plaintext
    const raw = await cdp.evaluate("new Promise((res) => { const r = indexedDB.open('tophat-viewer', 1); r.onsuccess = () => { const q = r.result.transaction('kv').objectStore('kv').getAll(); q.onsuccess = () => res(JSON.stringify(q.result)); }; })");
    assert.ok(raw.length > 1000 && !raw.includes('NOTE-') && !raw.includes('Bench Item'), 'IndexedDB holds ciphertext only');
    const origin = new URL(hubUrl).origin;
    const foreign = requests.filter((u) => !u.startsWith(origin) && !u.startsWith('data:') && !u.startsWith('blob:'));
    assert.deepEqual(foreign, [], 'no request leaves the hub origin');
    await cdp.evaluate("new Promise((res) => { const r = indexedDB.deleteDatabase('tophat-viewer'); r.onsuccess = r.onerror = r.onblocked = () => res(true); })");
    await cdp.send('Page.navigate', { url: 'about:blank' });
  } finally {
    cdp?.close();
    await new Promise((r) => server.close(r)); hub.close();
    for (const s of [A, D, ...extra]) await s.close();
  }
});
