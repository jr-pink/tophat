// The starter chats are one frozen set for every visitor: seeding is idempotent, a release replaces old versions (and the client is told to drop
// them), a visitor's own chats are never touched, and a message to a starter chat forks instead of writing to it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEED_RETIRED_SCOPE, forkIdOf, forkSeedChat, isSeedId, loadTemplates, openStore, plannedSeed, seedGuest, seedOpener, seedRowsOf } from '../src/seed-chats.mjs';

const DEMO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(DEMO, 'seed/chats.json');
const GUEST = 'a'.repeat(32), OTHER = 'b'.repeat(32);
const scopeOf = (g) => `p-g${g}`;

function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'seed-chats-'));
  const cache = path.join(dir, 'cache'); 
  return { dir, cache, store: null };
}
function templates(dir, weekly = 'the first weekly answer') {
  const cache = path.join(dir, 'cache');
  writeFileSync(path.join(dir, 'weekly.json'), JSON.stringify({ answer: weekly, prompt: 'x' }));
  // loadTemplates reads `<cacheDir>/<slot>.json`
  return loadTemplates({ file: FILE, cacheDir: dir, slots: [] });
}
/** The chats a guest sees in the sidebar: in their scope, not a side chat, not the opener, with their folder. */
function listed(store, guest) {
  return store.conversationIdsInScope(scopeOf(guest)).map((id) => {
    const c = store.conversation(id);
    const created = store.conversationEvents(id).find((e) => e.kind === 'conversation.created')?.content || {};
    return { id, title: c.title, workspace: created.workspace || null, side: Boolean(c.parentId) };
  });
}
const folders = (rows) => rows.filter((r) => !r.side && !r.id.startsWith('opener-')).reduce((m, r) => ({ ...m, [r.workspace]: (m[r.workspace] || 0) + 1 }), {});
const noDuplicateTitles = (rows) => {
  const seen = new Set();
  for (const r of rows.filter((x) => !x.side)) { const k = `${r.workspace}|${r.title}`; assert.ok(!seen.has(k), `duplicate ${k}`); seen.add(k); }
};
const seed = (store, guest, tpls, now) => seedGuest(store, { guest, scope: scopeOf(guest), templates: tpls, model: 'claude-haiku-5-5', now });

test('the seed definition is 12 chats in four folders plus the intro chat, the intro chat in the personal assistant project folder', () => {
  const { dir } = fixture();
  try {
    const t = templates(dir);
    assert.equal(t.filter((x) => !x.opener).length, 12);
    const by = {};
    for (const x of t.filter((y) => !y.opener)) by[x.workspace] = (by[x.workspace] || 0) + 1;
    assert.deepEqual(by, { healthhh: 2, tophat: 4, faqs: 4, 'curiosity / collection': 2 });
    assert.equal(t.find((x) => x.opener).workspace, 'personal assistant project', 'the intro chat is in the personal assistant project folder, not the Inbox');
    assert.deepEqual(t.filter((x) => x.workspace === 'tophat').map((x) => x.title).sort(),
      ['current memory graph', 'how does the memory bench work', 'how sharing works', 'whats new this week']);
    // frozen: every chat but the live one carries its own transcript in the definition
    assert.deepEqual(JSON.parse(JSON.stringify(t)).filter((x) => !x.opener && !x.messages?.length), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('seeding twice writes nothing the second time: 12 chats, no duplicate titles in a folder, identical ids', () => {
  const { dir } = fixture(); const store = openStore(path.join(dir, 'events.sqlite'));
  try {
    const t = templates(dir), now = Date.parse('2026-11-10T12:00:00Z');
    const first = seed(store, GUEST, t, now);
    assert.equal(first.created, 12);
    const before = listed(store, GUEST), cursor = store.cursor();
    const second = seed(store, GUEST, t, now + 3_600_000);
    assert.deepEqual(second, { created: 0, retired: 0, kept: 12 });
    assert.equal(store.cursor(), cursor, 'no event written');
    const after = listed(store, GUEST);
    assert.deepEqual(after.map((r) => r.id).sort(), before.map((r) => r.id).sort());
    assert.deepEqual(folders(after), { healthhh: 2, tophat: 4, faqs: 4, 'curiosity / collection': 2 });
    assert.equal(after.filter((r) => !r.side).length, 12);
    noDuplicateTitles(after);
  } finally { store.close?.(); rmSync(dir, { recursive: true, force: true }); }
});

test('a release: old versions and dropped chats are retired with the drop marker, the set is the new set, still no duplicates', () => {
  const { dir } = fixture(); const store = openStore(path.join(dir, 'events.sqlite'));
  try {
    const t = templates(dir), now = Date.parse('2026-11-10T12:00:00Z');
    // an older release's rows: ids without a fingerprint, a chat the seed has since dropped, and a side chat of it
    const short = GUEST.slice(0, 10);
    for (const [id, title, parent] of [[`split-${short}`, 'workout split', null], [`rrf-${short}`, 'rank fusion explained', null], [`rrf-${short}-s1`, '↳ why 60?', `rrf-${short}`]]) {
      store.ensureConversation(id, { at: new Date(now - 1e6).toISOString(), title, scope: scopeOf(GUEST), parentId: parent });
      store.append(id, 'conversation.created', { title, workspace: 'tophat', scope: scopeOf(GUEST) }, { at: new Date(now - 1e6).toISOString() });
    }
    seed(store, GUEST, t, now);
    const mid = listed(store, GUEST);
    assert.equal(mid.filter((r) => !r.side).length, 12, 'the old rows are out of the guest\'s scope');
    assert.ok(!mid.some((r) => r.id.startsWith('rrf-') && !/-[0-9a-f]{8}-/.test(r.id)), 'old side chat gone too');
    assert.equal(store.conversation(`rrf-${short}`).scope, SEED_RETIRED_SCOPE);
    const marker = store.conversationEvents(`rrf-${short}`).find((e) => e.kind === 'conversation.meta' && e.content.scopeMove);
    assert.ok(marker, 'the webchat\'s own "left your scope" marker is what tells a page holding it to drop it');
    // then a later release edits one chat and the live chat's answer changes
    const t2 = templates(dir, 'a newer weekly answer').map((x) => (x.id === 'bench' ? { ...x, title: 'mem bench, new numbers' } : x));
    const r = seed(store, GUEST, t2, now + 86_400_000);
    assert.deepEqual([r.created, r.retired, r.kept], [2, 2, 10]);
    const after = listed(store, GUEST);
    assert.equal(after.filter((x) => !x.side).length, 12);
    assert.deepEqual(folders(after), { healthhh: 2, tophat: 4, faqs: 4, 'curiosity / collection': 2 });
    noDuplicateTitles(after);
    assert.ok(!after.some((x) => x.title === 'how does the memory bench work'));
    // and a third pass on the same release changes nothing
    assert.deepEqual(seed(store, GUEST, t2, now + 2 * 86_400_000), { created: 0, retired: 0, kept: 12 });
  } finally { store.close?.(); rmSync(dir, { recursive: true, force: true }); }
});

test('a visitor\'s own chats and another guest\'s seed are never touched by a re-seed or a release', () => {
  const { dir } = fixture(); const store = openStore(path.join(dir, 'events.sqlite'));
  try {
    const t = templates(dir), now = Date.parse('2026-11-10T12:00:00Z');
    seed(store, GUEST, t, now); seed(store, OTHER, t, now);
    store.ensureConversation('c0ffee-visitor-chat', { at: new Date(now).toISOString(), title: 'my own chat', scope: scopeOf(GUEST) });
    store.append('c0ffee-visitor-chat', 'conversation.created', { title: 'my own chat', scope: scopeOf(GUEST) }, { at: new Date(now).toISOString() });
    store.append('c0ffee-visitor-chat', 'message.user', { itemId: 'u1', text: 'hello' }, { at: new Date(now).toISOString() });
    const mine = store.conversationEvents('c0ffee-visitor-chat').length, theirs = listed(store, OTHER).map((r) => r.id).sort();
    seed(store, GUEST, templates(dir, 'newer').map((x) => ({ ...x, title: x.title + '!' })), now + 1e9);
    assert.equal(store.conversationEvents('c0ffee-visitor-chat').length, mine);
    assert.equal(store.conversation('c0ffee-visitor-chat').scope, scopeOf(GUEST));
    assert.deepEqual(listed(store, OTHER).map((r) => r.id).sort(), theirs);
    assert.ok(!isSeedId('c0ffee-visitor-chat', GUEST) && !isSeedId(`opener-${GUEST.slice(0, 10)}`, GUEST) && !isSeedId(forkIdOf('x', GUEST), GUEST));
  } finally { store.close?.(); rmSync(dir, { recursive: true, force: true }); }
});

test('a message to a starter chat forks it: the seed row is not written to, the fork is the visitor\'s copy; the intro chat is filed in personal assistant project', () => {
  const { dir } = fixture(); const store = openStore(path.join(dir, 'events.sqlite'));
  try {
    const t = templates(dir), now = Date.parse('2026-11-10T12:00:00Z');
    seed(store, GUEST, t, now);
    seedOpener(store, { id: `opener-${GUEST.slice(0, 10)}`, template: t.find((x) => x.opener), scope: scopeOf(GUEST), model: 'claude-haiku-5-5', now });
    const rows = listed(store, GUEST);
    assert.equal(rows.find((r) => r.id.startsWith('opener-')).workspace, 'personal assistant project');
    assert.deepEqual(folders(rows), { healthhh: 2, tophat: 4, faqs: 4, 'curiosity / collection': 2 });
    const src = seedRowsOf(store, { scope: scopeOf(GUEST), guest: GUEST }).find((id) => id.startsWith('bench-'));
    const before = store.conversationEvents(src).map((e) => e.cursor);
    const forkId = forkIdOf(src, GUEST);
    forkSeedChat(store, { sourceId: src, forkId, scope: scopeOf(GUEST) });
    store.append(forkId, 'message.user', { itemId: 'u-new', text: 'and now?' });
    forkSeedChat(store, { sourceId: src, forkId, scope: scopeOf(GUEST) }); // a retried message lands in the same fork
    assert.deepEqual(store.conversationEvents(src).map((e) => e.cursor), before, 'the seed chat is unchanged');
    assert.equal(store.conversation(forkId).title, 'how does the memory bench work');
    const copied = store.conversationEvents(forkId).filter((e) => e.kind === 'message.user' || e.kind === 'assistant.message');
    assert.equal(copied.length, store.conversationEvents(src).filter((e) => e.kind === 'message.user' || e.kind === 'assistant.message').length + 1);
    const created = store.conversationEvents(forkId).find((e) => e.kind === 'conversation.created').content;
    assert.equal(created.workspace, 'tophat');
    // a re-seed and a release leave the fork alone, and it is not a starter chat
    seed(store, GUEST, t, now + 1e6);
    assert.ok(store.conversation(forkId) && store.conversation(forkId).scope === scopeOf(GUEST) && !isSeedId(forkId, GUEST));
    assert.equal(plannedSeed(t, GUEST).size, 12);
  } finally { store.close?.(); rmSync(dir, { recursive: true, force: true }); }
});

test('read state: a chat marked read is read through its last message, the rest start unread (the dot)', async () => {
  const { unreadOf } = await import('../../webchat/src/lib/core/rowstate.js');
  const { dir } = fixture(); const store = openStore(path.join(dir, 'events.sqlite'));
  try {
    seed(store, GUEST, templates(dir), Date.parse('2026-11-10T12:00:00Z'));
    const state = {};
    for (const id of store.conversationIdsInScope(scopeOf(GUEST))) state[store.conversation(id).title] = unreadOf(store.conversation(id)) ? 'unread' : 'read';
    assert.deepEqual(state, {
      'switch to dumbbell bench?': 'unread', 'pistol squat progression': 'read',
      'values study': 'unread',
      'whats new this week': 'unread', 'how does the memory bench work': 'unread', 'how sharing works': 'read', 'current memory graph': 'read',
      'encyclopedia cave, what was that place': 'read',
      'how is this different from other assistants': 'read', 'how do you make money': 'read', 'where does my data go': 'read', 'what do i need to run it': 'read'
    });
  } finally { store.close?.(); rmSync(dir, { recursive: true, force: true }); }
});

test('the guest-reset script lays the folders out in the seed\'s order, health and curiosity folded, assistant and tophat open', () => {
  const src = readFileSync(path.join(DEMO, 'src/guest-reset.js'), 'utf8');
  const ls = new Map();
  const doc = { cookie: 'demo_guest=abc123' };
  const storage = { get length() { return ls.size; }, key: (i) => [...ls.keys()][i], getItem: (k) => ls.get(k) ?? null, setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k), clear: () => ls.clear() };
  ls.set('qk:old-chat-cache', 'x');
  new Function('localStorage', 'document', 'indexedDB', 'window', 'navigator', src)(storage, doc, { deleteDatabase() {} }, {}, {});
  assert.equal(ls.get('qk:old-chat-cache'), undefined, 'every load starts from nothing');
  const rec = JSON.parse(ls.get('tophat-workspaces:chats'));
  assert.deepEqual(rec.names, ['healthhh', 'personal assistant project', 'tophat', 'faqs', 'curiosity / collection']);
  assert.deepEqual(rec.layout.order.slice(0, 5), rec.names);
  assert.deepEqual(rec.layout.parent, { faqs: 'tophat' });
  assert.deepEqual(rec.open, ['personal assistant project', 'tophat']);
  assert.equal(ls.get('tophat-workspaces:chats:main-folded'), '1');
  const seedFolders = new Set(JSON.parse(readFileSync(FILE, 'utf8')).chats.map((c) => c.workspace).filter(Boolean));
  assert.deepEqual([...seedFolders].sort(), [...rec.names].sort(), 'the folders the chats name are the folders the page lays out');
});

test('the guest-reset script drops the window\'s pane layout and sends a reload of a non-opener chat back to the opener', () => {
  const src = readFileSync(path.join(DEMO, 'src/guest-reset.js'), 'utf8');
  const run = (search, type) => {
    const ss = new Map([['qk:panes', '{"layout":{"tabs":[["weekly-1","opener-1"]]}}'], ['qk:landed', 'x'], ['sveltekit:scroll', '{}'], ['demo-tune', '{}'], ['tophat.window-seen', '1']]);
    const sessionStorage = { getItem: (k) => ss.get(k) ?? null, setItem: (k, v) => ss.set(k, String(v)), removeItem: (k) => ss.delete(k), ...{ keys: () => [...ss.keys()] } };
    Object.defineProperty(sessionStorage, 'keys', { enumerable: false, value: sessionStorage.keys });
    const proxy = new Proxy(sessionStorage, { ownKeys: () => [...ss.keys()], getOwnPropertyDescriptor: (t, k) => (ss.has(k) ? { enumerable: true, configurable: true, value: ss.get(k) } : Reflect.getOwnPropertyDescriptor(t, k)) });
    const to = []; const location = { search, replace: (u) => to.push(u) };
    const performance = { getEntriesByType: () => [{ type }] };
    const ls = new Map();
    const storage = { clear: () => ls.clear(), setItem: (k, v) => ls.set(k, v), getItem: (k) => ls.get(k) ?? null, removeItem: (k) => ls.delete(k) };
    new Function('sessionStorage', 'location', 'performance', 'localStorage', 'document', 'indexedDB', 'window', 'navigator', src)(proxy, location, performance, storage, { cookie: 'demo_guest=a' }, { deleteDatabase() {} }, {}, {});
    return { ss, to };
  };
  const a = run('?chat=weekly-ac6fb532-5bbfc5e24a', 'reload');
  assert.deepEqual(a.to, ['/'], 'a reload on another chat goes to the opener');
  assert.match(readFileSync(path.join(DEMO, 'src/shim.js'), 'utf8'), /const fail = \(why\) => \{ if \(failed \|\| window\.__demoBounce\) return;/, 'the page that is leaving does not report its aborted requests as a failed check');
  assert.deepEqual([...a.ss.keys()].sort(), ['demo-tune', 'tophat.window-seen'], 'the pane layout and landing record are gone; the demo\'s own keys stay');
  assert.deepEqual(run('?chat=weekly-ac6fb532-5bbfc5e24a', 'navigate').to, [], 'a followed link to a chat is left alone');
  assert.deepEqual(run('?chat=opener-5bbfc5e24a-1', 'reload').to, [], 'a reload on the opener stays');
  assert.deepEqual(run('', 'reload').to, []);
});
