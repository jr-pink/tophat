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

// The composition the browser reaches: the runner the app sends through is wrap(local). A message after a host pick while a turn runs
// must reach the picked host, never the busy runner of the old one (where it would be steered into the running turn).
function wrapped(t, { host = null, twin = null, localBusy = false } = {}) {
  const { rr, conv } = setup(t, { host, twin });
  const calls = [];
  const local = {
    isBusy: () => localBusy, phase: () => (localBusy ? 'running' : 'idle'), interrupt: () => false, warm: () => false,
    send: (id, text, options) => { calls.push({ id, text, options }); return { queued: false, injected: localBusy }; }
  };
  return { runner: rr.wrap(local), rr, conv, calls };
}

test('wrap.send: local turn running, host switched to the peer: the message does not reach the local runner', (t) => {
  const { runner, conv, calls, rr } = wrapped(t, { host: null, localBusy: true });
  conv.host = 'peer'; // the browser's set_host landed first
  runner.send('c1', 'hello', { itemId: 'm1' });
  assert.equal(calls.length, 0, 'steered into the busy local turn instead of going to the peer');
  assert.equal(rr.twin('c1')?.runtime, 'peer');
  assert.equal(rr.twin('c1').pending.length, 1);
});

test('wrap.send: peer turn running, host switched to this host: the message reaches the local runner as a new turn', (t) => {
  const { runner, conv, calls } = wrapped(t, { host: 'peer', twin: busyTwin('peer'), localBusy: false });
  conv.host = null;
  const out = runner.send('c1', 'hello', { itemId: 'm1' });
  assert.equal(calls.length, 1);
  assert.equal(out.injected, false);
});

test('wrap.send: a send to a second peer while the first peer\'s message is still unforwarded does not drop the first', (t) => {
  const first = { ...busyTwin('peer'), remoteId: null, pending: [{ itemId: 'm0', text: 'first', display: 'first', at: 0 }] };
  const { runner, conv, rr } = wrapped(t, { host: 'peer', twin: first });
  conv.host = 'other';
  runner.send('c1', 'second', { itemId: 'm1' });
  const all = Object.values(rr.twins()).flatMap((x) => x.pending.map((p) => p.itemId));
  assert.deepEqual(all.sort(), ['m0', 'm1'], 'the unforwarded first message was lost with its twin');
});
