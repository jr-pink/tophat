// Mute When Collapsed is shared folder state, beside a folder's place and archive flag: a client outbox (core/folder-descs.js)
// that applies at once and replays, and a server record (server/folder-descriptions.js) where the newest stamp per folder wins.
// Two devices that edit the same folder converge, a replay changes nothing, and a false is the tombstone.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isMuted, queueArchive, queueEdit, queueMute, queueParent, readCached, readOutbox, sync } from '../src/lib/core/folder-descs.js';
import { readAll, setArchived, setManual, setMuted, setParent } from '../src/lib/server/folder-descriptions.js';

const store = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) }; };
const file = () => path.join(mkdtempSync(path.join(tmpdir(), 'folder-mute-')), 'folder-descriptions.json');
const T = (n) => `2026-11-12T12:00:${String(n).padStart(2, '0')}.000Z`;

// A fake server over the real server module, so the client replays against the real merge rule.
const serverFor = (p) => async (url, init) => {
  if (!init) return { ok: true, json: async () => readAll(p) };
  const b = JSON.parse(init.body);
  if ('muted' in b) setMuted(b.name, b.muted, p, { at: b.at });
  else if ('archived' in b) setArchived(b.name, b.archived, p, { at: b.at });
  else if ('parent' in b) setParent(b.name, b.parent, p, { at: b.at });
  else setManual(b.name, b.text, p, { at: b.at });
  return { ok: true, json: async () => readAll(p) };
};

test('a mute is applied at once from the outbox, with no network', () => {
  const s = store();
  assert.equal(isMuted(readCached(s), 'taxes'), false);
  const after = queueMute('Taxes', true, { storage: s, now: () => T(1) });
  assert.equal(isMuted(after, 'taxes'), true);
  assert.equal(after.taxes.pending, true);
  assert.equal(isMuted(readCached(s), 'taxes'), true, 'a reload still shows it');
  assert.equal(isMuted(queueMute('Taxes', false, { storage: s, now: () => T(2) }), 'taxes'), false);
});

test('the flag rides beside text, place and archive without disturbing them', () => {
  const s = store();
  queueMute('Taxes', true, { storage: s, now: () => T(1) });
  queueParent('Taxes', 'home', { storage: s, now: () => T(2) });
  queueArchive('Taxes', true, { storage: s, now: () => T(3) });
  const d = queueEdit('Taxes', 'Returns and receipts', { storage: s, now: () => T(4) }).taxes;
  assert.deepEqual([d.muted, d.parent, d.archived, d.text], [true, 'home', true, 'Returns and receipts']);
});

test('server: newest stamp wins, a replay changes nothing, a false is the tombstone', () => {
  const p = file();
  setMuted('Taxes', true, p, { at: T(5) });
  setMuted('Taxes', false, p, { at: T(3) });
  assert.equal(readAll(p).taxes.muted, true, 'an older unmute does not undo a newer mute');
  setMuted('Taxes', true, p, { at: T(5) });
  assert.deepEqual(readAll(p).taxes, { name: 'Taxes', muted: true, mutedAt: T(5) }, 'replaying is the same record');
  setMuted('Taxes', false, p, { at: T(9) });
  assert.deepEqual([readAll(p).taxes.muted, readAll(p).taxes.mutedAt], [false, T(9)]);
});

test('server: a mute-only record survives a text clear and is never taken for a described folder', () => {
  const p = file();
  setMuted('Taxes', true, p, { at: T(1) });
  setManual('Taxes', 'Returns', p, { at: T(2) });
  setManual('Taxes', '', p, { at: T(3) });
  assert.equal(readAll(p).taxes.muted, true);
  assert.equal(readAll(p).taxes.text, undefined);
});

test('two devices merge: each edits offline, both sync, both end with the later edit', async () => {
  const p = file(), serverFetch = serverFor(p);
  const a = store(), b = store();
  queueMute('Taxes', true, { storage: a, now: () => T(10) });    // device A mutes first
  queueMute('Taxes', false, { storage: b, now: () => T(20) });   // device B, later, unmutes
  assert.equal(isMuted(readCached(a), 'taxes'), true);
  assert.equal(isMuted(readCached(b), 'taxes'), false);
  // B reaches the server first, then A replays its older edit: the server keeps B's.
  await sync({ storage: b, fetchImpl: serverFetch });
  const seenByA = await sync({ storage: a, fetchImpl: serverFetch });
  assert.equal(isMuted(seenByA, 'taxes'), false, 'A converges on B');
  assert.deepEqual(readOutbox(a), {}, 'A replay was accepted and cleared');
  assert.equal(isMuted(await sync({ storage: b, fetchImpl: serverFetch }), 'taxes'), false);
  // Different folders never collide.
  queueMute('Garden', true, { storage: a, now: () => T(30) });
  await sync({ storage: a, fetchImpl: serverFetch });
  const seenByB = await sync({ storage: b, fetchImpl: serverFetch });
  assert.deepEqual([isMuted(seenByB, 'garden'), isMuted(seenByB, 'taxes')], [true, false]);
});

test('offline: the edit stays queued through a failed send and a replay is idempotent', async () => {
  const p = file(), s = store();
  queueMute('Taxes', true, { storage: s, now: () => T(1) });
  const down = async () => { throw new Error('offline'); };
  assert.equal(isMuted(await sync({ storage: s, fetchImpl: down }), 'taxes'), true, 'still shown while the server is unreachable');
  assert.equal(Object.keys(readOutbox(s)).length, 1);
  const flaky = async (url, init) => (init ? { ok: false } : serverFor(p)(url, init));
  await sync({ storage: s, fetchImpl: flaky });
  assert.equal(Object.keys(readOutbox(s)).length, 1, 'a 5xx leaves it queued');
  const server = serverFor(p);
  await sync({ storage: s, fetchImpl: server });
  assert.deepEqual(readOutbox(s), {});
  const once = readAll(p).taxes;
  // The same edit sent again (the first answer was lost) is the same record.
  setMuted('Taxes', true, p, { at: T(1) });
  assert.deepEqual(readAll(p).taxes, once);
});

test('rename moves the flag: set under the new name, tombstone under the old; remove clears it', async () => {
  const p = file(), s = store(), server = serverFor(p);
  queueMute('Taxes', true, { storage: s, now: () => T(1) });
  await sync({ storage: s, fetchImpl: server });
  // What Sidebar.renameWorkspace does:
  queueMute('Returns', true, { storage: s, now: () => T(2) });
  queueMute('Taxes', false, { storage: s, now: () => T(2) });
  const d = await sync({ storage: s, fetchImpl: server });
  assert.deepEqual([isMuted(d, 'returns'), isMuted(d, 'taxes')], [true, false]);
  // What Sidebar.deleteWorkspace does:
  queueMute('Returns', false, { storage: s, now: () => T(3) });
  assert.equal(isMuted(await sync({ storage: s, fetchImpl: server }), 'returns'), false);
});

test('the Inbox can be muted, and its record is no folder to the router', async () => {
  const { UNFILED } = await import('../src/lib/core/workspaces.js');
  const { foldersOf } = await import('../src/lib/server/autoroute.js');
  const s = store();
  assert.equal(isMuted(queueMute(UNFILED, true, { storage: s, now: () => T(1) }), UNFILED), true);
  assert.deepEqual(foldersOf([], readCached(s)), [], 'a flag-only record is not a folder');
});

test('the menu and rename/remove call queueMute, and the sidebar kit no longer holds the flag', async () => {
  const { readFileSync } = await import('node:fs');
  const menu = readFileSync(new URL('../src/lib/ui/Sidebar.svelte', import.meta.url), 'utf8');
  assert.match(menu, /if \(folderMuted\(descs, k\)\) \{ queueMute\(clean, true\); queueMute\(from, false\); \}/);
  assert.match(menu, /if \(folderMuted\(descs, k\)\) queueMute\(name, false\);/);
  const decl = readFileSync(new URL('../src/lib/core/sidebar-state.js', import.meta.url), 'utf8');
  assert.doesNotMatch(decl, /muteCollapsed|folder\.mute/);
});
