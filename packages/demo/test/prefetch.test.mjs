// prefetch.js: during the intro the figures of the opener answer are fetched, low priority and one at a time, after the page's own load,
// from the `warm` list the intro's state carries; a missing or failed boot does nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const SRC = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/prefetch.js'), 'utf8');
const tick = () => new Promise((r) => setTimeout(r, 5));

function page({ boot, readyState = 'loading' }) {
  const calls = []; let inflight = 0, maxInflight = 0, loadFn = null;
  const window = {
    __demoBoot: boot, addEventListener: (ev, f) => { if (ev === 'load') loadFn = f; },
    requestIdleCallback: (f) => setTimeout(f, 0)
  };
  const fetch = async (url, opts) => { calls.push({ url, opts }); inflight++; maxInflight = Math.max(maxInflight, inflight); await tick(); inflight--; return { ok: true, arrayBuffer: async () => new ArrayBuffer(1) }; };
  vm.runInNewContext(SRC, { window, document: { readyState }, fetch, Promise, setTimeout, Array });
  return { calls, load: () => loadFn && loadFn(), maxInflight: () => maxInflight };
}

test('warms the listed urls in order, low priority, one at a time, and only after the page has loaded', async () => {
  const warm = ['/api/file?path=%2Fa.html&raw=1&conversation=c', '/api/file?path=%2Fb.html&raw=1&conversation=c', '/api/file?path=%2Fc.jpg&raw=1&conversation=c'];
  const p = page({ boot: Promise.resolve({ warm }) });
  await tick(); await tick();
  assert.equal(p.calls.length, 0, 'nothing before load');
  p.load();
  for (let i = 0; i < 20 && p.calls.length < 3; i++) await tick();
  assert.deepEqual(p.calls.map((c) => c.url), warm);
  assert.ok(p.calls.every((c) => c.opts.priority === 'low' && c.opts.credentials === 'same-origin'));
  assert.equal(p.maxInflight(), 1);
});

test('a page already loaded starts at once; no boot, a gone session or no list does nothing', async () => {
  const p = page({ boot: Promise.resolve({ warm: ['/x'] }), readyState: 'complete' });
  for (let i = 0; i < 10 && !p.calls.length; i++) await tick();
  assert.equal(p.calls.length, 1);
  for (const boot of [undefined, Promise.resolve(null), Promise.resolve({ gone: true }), Promise.resolve({ warm: [] })]) {
    const q = page({ boot, readyState: 'complete' }); await tick(); await tick(); await tick();
    assert.equal(q.calls.length, 0);
  }
});
