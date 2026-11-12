// Folder right-click: Mark Read and Mute When Collapsed (owner request, 2026-11-11 22:20 PST: "lets add mark as read and
// mute-when-closed options to the right click menu"). The state is the kit's sidebar declaration, the dot is explorerRows, the
// membership is chatsUnder; the menu in Sidebar.svelte only wires them, which the last tests read from its source.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { UNFILED, chatsUnder, explorerRows, folderKey } from '../src/lib/core/workspaces.js';

const names = ['Home', 'Garden', 'Taxes'];
const layout = { order: [], parent: { [folderKey('Garden')]: folderKey('Home') } };
const chat = (id, workspace, extra = {}) => ({ id, workspace, indicator: 'idle', unread: false, ...extra });
const rows = [
  chat('p1', 'Home', { indicator: 'unread', unread: true }),
  chat('u1', 'Garden', { indicator: 'unread', unread: true }),
  chat('u2', 'Garden'),
  chat('t1', 'Taxes', { indicator: 'live' }),
  chat('i1', null, { indicator: 'unread', unread: true }),
  chat('old', 'Home', { indicator: 'unread', unread: true, archived: true })
];
const folderRow = (items, name) => items.find((it) => it.kind === 'folder' && it.name === name);
const draw = (opts) => explorerRows(rows.filter((r) => !r.archived), { names, layout, ...opts });

test('chatsUnder: the folder, its subfolders and the Inbox as it is drawn; archived chats are not in the list', () => {
  const ids = (key) => chatsUnder(rows, key, { names, layout }).map((r) => r.id).sort();
  assert.deepEqual(ids(folderKey('Home')), ['p1', 'u1', 'u2']);
  assert.deepEqual(ids(folderKey('Garden')), ['u1', 'u2']);
  assert.deepEqual(ids(folderKey('Taxes')), ['t1']);
  assert.deepEqual(ids(UNFILED), ['i1']);
});

test('a chat whose folder is unknown counts as Inbox, as explorerRows draws it', () => {
  const stray = [chat('s1', 'Gone folder', { unread: true })];
  assert.deepEqual(chatsUnder(stray, UNFILED, { names, layout }).map((r) => r.id), ['s1']);
  assert.deepEqual(chatsUnder(stray, folderKey('Home'), { names, layout }), []);
});

test('a collapsed folder shows a dot for unread inside; muting it silences that, and expanding restores it', () => {
  const closed = () => false;
  assert.equal(folderRow(draw({ isOpen: closed }), 'Taxes').live, true, 'running chat inside');
  const muted = (k) => k === folderKey('Taxes');
  assert.equal(folderRow(draw({ isOpen: closed, isMuted: muted }), 'Taxes').live, false);
  // expanded, the folder row never carries the dot (its chats show their own)
  assert.equal(folderRow(draw({ isOpen: (k) => k === folderKey('Taxes'), isMuted: muted }), 'Taxes').live, false);
  // the chat itself is unchanged by the mute: still unread/live in the rows
  const open = draw({ isOpen: (k) => k === folderKey('Taxes'), isMuted: muted }).filter((it) => it.kind === 'chat');
  assert.equal(open.find((it) => it.id === 't1').row.indicator, 'live');
});

test('a muted collapsed folder is quiet for the whole subtree, and for the dot of every collapsed ancestor', () => {
  const home = folderKey('Home'), us = folderKey('Garden');
  const openOnly = (...keys) => (k) => keys.includes(k);
  // Home open, Garden (child) collapsed with unread inside: Garden's row has the dot; muting Garden removes it.
  assert.equal(folderRow(draw({ isOpen: openOnly(home) }), 'Garden').live, true);
  assert.equal(folderRow(draw({ isOpen: openOnly(home), isMuted: (k) => k === us }), 'Garden').live, false);
  // Home collapsed holds p1 (unread) and u1 (unread, in Garden): its own dot shows; muting Garden alone still leaves p1.
  assert.equal(folderRow(draw({ isOpen: () => false }), 'Home').live, true);
  assert.equal(folderRow(draw({ isOpen: () => false, isMuted: (k) => k === us }), 'Home').live, true);
  // Muting Home silences it entirely, children included, even though Garden is unmuted.
  assert.equal(folderRow(draw({ isOpen: () => false, isMuted: (k) => k === home }), 'Home').live, false);
  // A muted folder that is open does not hide a collapsed child's own unread from its row.
  assert.equal(folderRow(draw({ isOpen: openOnly(home), isMuted: (k) => k === home }), 'Garden').live, true);
});

test('an ancestor collapsed and unmuted still counts a muted-collapsed child out, and the Inbox can be muted', () => {
  const us = folderKey('Garden');
  const onlyUs = draw({ isOpen: () => false, isMuted: (k) => k === us || k === folderKey('Taxes') });
  assert.equal(folderRow(onlyUs, 'Home').live, true, 'Home still has its own unread chat p1');
  const inbox = explorerRows(rows.filter((r) => !r.archived && r.id === 'i1'), { names, layout, isOpen: () => false, isMuted: (k) => k === UNFILED });
  assert.equal(inbox.find((it) => it.kind === 'folder' && it.key === UNFILED).live, false);
  const loud = explorerRows(rows.filter((r) => !r.archived && r.id === 'i1'), { names, layout, isOpen: () => false });
  assert.equal(loud.find((it) => it.kind === 'folder' && it.key === UNFILED).live, true);
});

const menu = readFileSync(new URL('../src/lib/ui/Sidebar.svelte', import.meta.url), 'utf8');
const body = (name) => { const at = menu.indexOf(`function ${name}(`); return menu.slice(at, menu.indexOf('\n  function ', at + 10)); };

test('the folder menu offers Mark Read (only with something unread) and a flipping Mute When Collapsed', () => {
  const src = body('folderMenuItems');
  assert.match(src, /unread\.length > 0 && \{ id: 'read', label: 'Mark Read'/);
  assert.match(src, /label: muted \? 'Unmute When Collapsed' : 'Mute When Collapsed'/);
  assert.match(src, /queueMute\(name \?\? key, !muted\)/);
  assert.match(menu, /const markAllRead = \(ids\) => \{ for \(const id of ids\) onread\(id, true, \{ mute: false \}\); \};/);
});

test('the multi-select menu has Mark Read, and the explorer is told which folders are muted', () => {
  assert.match(body('bulkMenu'), /unread\.length > 0 && \{ id: 'read', label: 'Mark Read'/);
  assert.match(menu, /isMuted: \(k\) => folderMuted\(descs, k\)/);
});
