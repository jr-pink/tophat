// A replica syncing from a hub that cuts pages at a byte budget: it follows more/next and ends with every large note.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { world, settle } from './kit.mjs';

test('a second device of the same user syncs a log of large notes across capped pages', async () => {
  const w = await world();
  try {
    const A = w.sqlite('alice');
    await A.createScope('alice');
    for (let i = 0; i < 6; i++) await A.apply({ entities: [{ id: '$e', name: `Thing ${i}`, type: 'topic', scopes: ['alice'] }], notes: [{ body: `BIG-${i} ` + 'q'.repeat(300 * 1024), entities: ['$e'], scopes: ['alice'], at: `2026-10-0${i + 1}T00:00:00Z` }] }, { scopes: ['alice'] });
    await settle(A);
    w.hub.pullMaxBytes = 700 * 1024;
    const pages = [], realPull = w.hub.pull.bind(w.hub);
    w.hub.pull = (...a) => { const p = realPull(...a); pages.push({ actions: p.actions.length, more: p.more }); return p; };
    const B = w.replica(A);
    await settle(A, B); // A wraps the scope key to the new device, then B reads the log
    assert.ok(pages.length >= 4 && pages.some((p) => p.more), `pulled in ${pages.length} pages`);
    const count = (s) => s.store.all("SELECT id FROM notes WHERE body LIKE 'BIG-%'").length;
    assert.equal(count(A), 6);
    assert.equal(count(B), 6);
    assert.equal(count(B), count(A));
  } finally { await w.close(); }
});
