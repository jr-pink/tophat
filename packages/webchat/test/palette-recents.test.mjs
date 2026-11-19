// Cmd-K with nothing typed lists the chats he was last in (the owner, 2026-11-18). Rows are the real store shape: the server's
// decodeConversation over a conversations record, then the palette's own ranking (core/recency.js).
import assert from 'node:assert/strict';
import test from 'node:test';
import { recentChats } from '../src/lib/core/search.js';
import { rankConversations } from '../src/lib/core/recency.js';
import { decodeConversation } from '../src/lib/server/store-shared.js';

const NOW = Date.parse('2026-11-18T22:00:00Z');
const at = (minutesAgo) => new Date(NOW - minutesAgo * 60_000).toISOString();
const record = (id, minutesAgo, extra = {}) => ({
  id, title: id, settings: '{}', pinned: 0, archived: 0, aside: 0, opens: 1, turns: 1, tool_calls: 0,
  created_at: at(minutesAgo + 5), updated_at: at(minutesAgo), active_at: at(minutesAgo), run_state: 'idle', ...extra
});
const store = (...records) => Object.fromEntries(records.map((r) => { const c = decodeConversation(r); return [c.id, c]; }));
const ids = (conversations) => recentChats(conversations, { now: NOW, rank: rankConversations }).map((r) => r.conversationId);

test('newest activity first; pinned chats do not take the slots', () => {
  const conversations = store(
    ...Array.from({ length: 10 }, (_, i) => record(`pin${i}`, 600 + i, { pinned: 1 })),
    record('new', 1), record('mid', 30), record('old', 120));
  assert.deepEqual(ids(conversations).slice(0, 3), ['new', 'mid', 'old']);
});

test('archived chats he was just in are listed, tagged archived', () => {
  const conversations = store(record('auto', 50), record('done', 5, { archived: 1 }));
  const rows = recentChats(conversations, { now: NOW, rank: rankConversations });
  assert.deepEqual(rows.map((r) => r.conversationId), ['done', 'auto']);
  assert.equal(rows[0].archived, true);
});

test('set-aside, deferred and side-thread chats stay out', () => {
  const conversations = store(
    record('ok', 10), record('aside', 1, { aside: 1 }),
    record('later', 2, { defer_until: new Date(NOW + 3_600_000).toISOString() }),
    record('side', 3, { sidechat: JSON.stringify({ itemId: 'x', start: 0, end: 1, quote: 'q' }) }));
  assert.deepEqual(ids(conversations), ['ok']);
});

test('a running chat counts as active now, ahead of a later user message elsewhere', () => {
  const conversations = store(
    record('working', 90, { run_state: 'thinking', updated_at: at(0) }),
    record('typed', 4));
  assert.deepEqual(ids(conversations), ['working', 'typed']);
});

test('at most nine', () => {
  const conversations = store(...Array.from({ length: 14 }, (_, i) => record(`c${i}`, i)));
  assert.equal(ids(conversations).length, 9);
});
