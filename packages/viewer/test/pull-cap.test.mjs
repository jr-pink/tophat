// The viewer's pull loop against a real hub whose log holds large parts: the hub cuts a page at its byte budget
// (more=true, next at the last row it holds) and the viewer follows until the head, reading what the author's own replica
// reads. A client that ignores `more` still reaches the head by pulling again from `next`. A hub that marks a page
// `more` without advancing is an error, not a spin.
import assert from 'node:assert/strict';
import { describe, test, after, before } from 'node:test';
import { world, settle, SECRET } from '@tophat-md/linknotes/testing';
import { issueToken } from '@tophat-md/linknotes';
import { ViewState, tokenClaims } from '../src/core/state.mjs';
import { pullInto } from '../src/core/pull.mjs';
import { readKeyFile } from '../src/core/keys.mjs';
import { exportKeys } from '../src/index.mjs';

const PASS = 'viewer pull-cap passphrase', ITER = 1000;
const token = (device, user) => issueToken(SECRET, { device, user, expiresAt: Math.floor(Date.now() / 1000) + 3600 });
const HUGE = 3 * 1024 * 1024; // a note this size becomes an action of about 9 MiB (note row, search text and change image, sealed and base64)
const BIG = 300 * 1024, CAP = 700 * 1024; // each note is ~400 KB sealed; a page holds two of them

describe('viewer pull loop with a byte-capped hub', () => {
  let w, A, keyBox, ids;
  before(async () => {
    w = await world();
    A = w.sqlite('alice');
    await A.createScope('alice');
    ids = [];
    for (let i = 0; i < 6; i++) {
      const res = await A.apply({ entities: [{ id: '$e', name: `Thing ${i}`, type: 'topic', scopes: ['alice'] }], notes: [{ body: `BIG-${i} ` + String.fromCharCode(97 + i).repeat(BIG), entities: ['$e'], scopes: ['alice'], at: `2026-10-0${i + 1}T00:00:00Z` }] }, { scopes: ['alice'] });
      ids.push(...Object.values(res.id_map ?? {}));
    }
    await settle(A);
    keyBox = await exportKeys({ config: A.config, passphrase: PASS, iterations: ITER });
    w.hub.pullMaxBytes = CAP;
  });
  after(async () => { await w?.close(); });

  const fresh = async (device) => new ViewState({ user: 'alice', device, keys: await readKeyFile(JSON.stringify(keyBox), PASS) });
  const recording = (log) => async (url, init) => { const r = await fetch(url, init); if (!String(url).includes('/v1/pull')) return r; const text = await r.clone().text(); const j = JSON.parse(text); log.push({ bytes: text.length, actions: j.actions.length, next: j.next, more: j.more }); return r; };

  test('the viewer follows more/next across capped pages and reads every large note', async () => {
    const log = [], v = await fresh('alice-browser');
    const r = await pullInto(v, { hubUrl: w.hubUrl, token: token('alice-browser', 'alice'), limit: 500, fetch: recording(log) });
    assert.ok(log.length >= 3, `${log.length} pages`);
    assert.ok(log.slice(0, -1).every((p) => p.more === true) && log.at(-1).more === false);
    assert.ok(log.every((p) => p.actions >= 1), 'no empty page: every page holds a row');
    assert.ok(log.every((p) => p.bytes < CAP * 3), `no page runs past the cap by more than a row: ${log.map((p) => p.bytes)}`);
    assert.equal(r.cursor, r.head);
    const bodies = v.visibleNotes().map((n) => n.body);
    for (let i = 0; i < 6; i++) assert.ok(bodies.some((b) => b.startsWith(`BIG-${i} `) && b.length > BIG), `BIG-${i} read in full`);
  });

  test('a client that ignores `more` reaches the head by pulling again from `next`', async () => {
    const t = token('naive', 'alice'), seen = [];
    let after = 0;
    for (let i = 0; i < 100; i++) {
      const r = await fetch(`${w.hubUrl}/v1/pull?after=${after}&limit=500`, { headers: { authorization: `Bearer ${t}` } });
      const page = await r.json();
      for (const a of page.actions) seen.push(a.seq);
      if (page.next === after) break;
      after = page.next;
    }
    assert.equal(after, Number(w.hub.one('SELECT MAX(seq) AS n FROM actions').n));
    assert.deepEqual(seen, [...seen].sort((a, b) => a - b));
    assert.equal(new Set(seen).size, seen.length, 'no action twice');
    assert.ok(seen.length >= 7, 'the whole log');
  });

  test('a hub that marks a page more without advancing is an error, never a spin', async () => {
    const v = await fresh('alice-stuck'), calls = [];
    const stuck = async (url) => {
      calls.push(url);
      if (String(url).endsWith('/healthz')) return new Response(JSON.stringify({ head: 9 }), { status: 200 });
      return new Response(JSON.stringify({ actions: [], next: v.cursor, more: true }), { status: 200 });
    };
    await assert.rejects(pullInto(v, { hubUrl: w.hubUrl, token: 'x', fetch: stuck, maxPages: 50 }), /page_without_progress/);
    assert.ok(calls.length <= 3);
  });

  test('default 16 MiB cut end to end: three notes of about 9 MiB each arrive as two pages', { timeout: 120000 }, async () => {
    const w2 = await world();
    try {
      const S = w2.sqlite('alice');
      await S.createScope('alice');
      for (let i = 0; i < 3; i++) await S.apply({ entities: [{ id: '$e', name: `Thing ${i}`, type: 'topic', scopes: ['alice'] }], notes: [{ body: `HUGE-${i} ` + 'z'.repeat(HUGE), entities: ['$e'], scopes: ['alice'], at: `2026-10-0${i + 1}T00:00:00Z` }] }, { scopes: ['alice'] });
      await settle(S);
      const sizes = w2.hub.all('SELECT seq, length(parts) AS n FROM actions WHERE length(parts) > 100000 ORDER BY seq').map((r) => r.n);
      assert.ok(sizes.reduce((a, b) => a + b, 0) > 40 * 1024 * 1024, 'the whole log is well over one page');
      const box = await exportKeys({ config: S.config, passphrase: PASS, iterations: ITER });
      const v = new ViewState({ user: 'alice', device: 'alice-browser', keys: await readKeyFile(JSON.stringify(box), PASS) });
      const log = [];
      const r = await pullInto(v, { hubUrl: w2.hubUrl, token: token('alice-browser', 'alice'), limit: 500, fetch: recording(log) });
      assert.ok(log.length >= 2 && log.every((p) => p.bytes < 28 * 1024 * 1024), JSON.stringify(log));
      assert.ok(log.slice(0, -1).every((p) => p.more));
      assert.equal(r.cursor, r.head);
      assert.equal(v.visibleNotes().filter((n) => n.body.startsWith('HUGE-')).length, 3);
    } finally { await w2.close(); }
  });
});
