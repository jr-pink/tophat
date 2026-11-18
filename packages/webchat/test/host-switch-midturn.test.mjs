// Switching a chat's host takes effect on the next send, also mid-turn (remote-runtime.js route): the send goes to the host he picked and
// the turn already running on the old host runs on in the background, its output still landing in the chat.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRemoteRuntimes } from '../src/lib/server/remote-runtime.js';

function setup(t, { host = null, twin = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'host-switch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const twinsPath = join(dir, 'twins.json');
  if (twin) writeFileSync(twinsPath, JSON.stringify({ c1: twin }));
  const conv = { id: 'c1', host, turns: 3 };
  const events = [];
  const store = {
    conversation: (id) => (id === 'c1' ? conv : null),
    allConversationEvents: () => events,
    append: (id, kind, content) => { events.push({ kind, content }); return { cursor: events.length }; },
    cursor: () => events.length
  };
  const rr = createRemoteRuntimes({
    store, twinsPath, decisionsPath: join(dir, 'decisions.jsonl'), hostedMemory: null, log: () => {},
    runtimes: { peer: { id: 'peer', label: 'team-host', url: 'http://127.0.0.1:1', tokenFile: join(dir, 'none') }, other: { id: 'other', label: 'other', url: 'http://127.0.0.1:1', tokenFile: join(dir, 'none') } }
  });
  return { rr, conv };
}
const busyTwin = (runtime = 'peer') => ({ runtime, remoteId: 'c1', cursor: 0, pending: [], echo: [], sentIds: [], busy: true, running: true, remoteSeen: 0, localSeen: 5, sentAt: 0, conversationId: 'c1', uploads: {} });

test('a turn running on the peer: switched to this host, the next send runs here', (t) => {
  const { rr } = setup(t, { host: null, twin: busyTwin() });
  const r = rr.route('c1');
  assert.equal(r.runtime, null);
  assert.match(r.reason, /mid-turn.*background/);
});

test('a turn running on the peer, host unchanged: the send joins it', (t) => {
  const { rr } = setup(t, { host: 'peer', twin: busyTwin() });
  assert.equal(rr.route('c1').runtime, 'peer');
});

test('a local turn running: switched to the peer, the next send goes to the peer', (t) => {
  const { rr } = setup(t, { host: 'peer' });
  const r = rr.route('c1', { localBusy: true });
  assert.equal(r.runtime, 'peer');
  assert.match(r.reason, /mid-turn.*background/);
});

test('a local turn running, host unchanged: the send joins it here', (t) => {
  const { rr } = setup(t, { host: null });
  assert.equal(rr.route('c1', { localBusy: true }).runtime, null);
});

test('a turn on one peer while another peer is picked: the send goes to the picked peer, the running turn keeps its own twin', (t) => {
  const { rr } = setup(t, { host: 'other', twin: busyTwin('peer') });
  assert.equal(rr.route('c1').runtime, 'other');
});
