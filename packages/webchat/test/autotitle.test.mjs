// The titler's two styles: subjects (the default, as before) and actions, what each chat is doing now. Offline: the fast
// model is a stub, timers are driven by hand and the style file lives in a temp dir.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ACTION_INTERVAL_MS, ACTION_SETTLE_MS, DEBOUNCE_MS, PROMPTS, activityFor, askForTopic, createTitler, readTitleStyle, setTitleStyle
} from '../src/lib/server/autotitle.js';
import { queueStyle, readStyle, sync } from '../src/lib/core/title-style.js';

const ID = '11111111-1111-4111-8111-111111111111';
const ev = (kind, content = {}) => ({ conversation_id: ID, kind, content });

/** One conversation and its log, renamed the way app.js renames: an auto title. */
function harness({ style = 'subjects', title = 'New chat', titleSource = 'provisional', events = [], ask } = {}) {
  const conversation = { id: ID, title, titleSource, turns: 1, runState: 'running', parentId: null, sidechat: null };
  const log = [...events];
  const asks = [];
  const timers = [];
  const renames = [];
  let clock = 1_000_000;
  const box = { style };
  const store = {
    conversation: () => ({ ...conversation }),
    conversationProse: () => log.filter((e) => e.kind === 'message.user' || e.kind === 'assistant.message'),
    conversationEvents: () => log
  };
  const titler = createTitler({
    store,
    style: () => box.style,
    intervalMs: ACTION_INTERVAL_MS,
    now: () => clock,
    rename: (id, next) => { renames.push(next); conversation.title = next; conversation.titleSource = 'auto'; },
    ask: async (transcript, shown, options) => { asks.push({ transcript, shown, ...options }); return ask ? ask(asks.length, conversation) : null; },
    setTimeoutImpl: (fn, delay) => { const timer = { fn, delay }; timers.push(timer); return timer; }
  });
  // Each new timer replaces (clears) the one before it, so the newest is the one that would fire.
  const fire = async () => { const timer = timers.pop(); timers.length = 0; assert.ok(timer, 'a title is scheduled'); await timer.fn(); await new Promise((r) => setImmediate(r)); };
  return { conversation, log, asks, timers, renames, titler, fire, box, tick: (ms) => { clock += ms; } };
}

test('the subject prompt by default, the action prompt and the run state with actions on', async () => {
  const bodies = [];
  const fetchImpl = async (_url, init) => { bodies.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ choices: [{ message: { content: 'Fixing the sidebar search.' } }] }) }; };
  assert.equal(await askForTopic('User: fix the search', 'sidebar search', { fetchImpl, apiKey: 'k' }), 'Fixing the sidebar search');
  await askForTopic('User: fix the search', 'sidebar search', { style: 'actions', runState: 'running', fetchImpl, apiKey: 'k' });
  assert.equal(bodies[0].messages[0].content, PROMPTS.subjects);
  assert.match(bodies[0].messages[1].content, /^Current name: sidebar search\n\nConversation:\nUser: fix the search$/);
  assert.equal(bodies[1].messages[0].content, PROMPTS.actions);
  assert.match(bodies[1].messages[1].content, /^Run state: running\nCurrent name: sidebar search\n\nLatest activity:\nUser: fix the search$/);
  // the two prompts ask for opposite things: subjects without verbs, actions led by one
  assert.match(PROMPTS.subjects, /no verbs/);
  assert.match(PROMPTS.actions, /a verb and its specific object/);
});

test('the style is subjects until it is set; the newest change wins and an unknown style is refused', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'title-style-'));
  try {
    const file = path.join(dir, 'title-style.json');
    assert.deepEqual(readTitleStyle(file), { style: 'subjects', at: null, intervalMs: ACTION_INTERVAL_MS });
    assert.equal(setTitleStyle('actions', { at: '2026-01-02T00:00:00.000Z' }, file).style, 'actions');
    assert.equal(setTitleStyle('subjects', { at: '2026-01-01T00:00:00.000Z' }, file).style, 'actions', 'an older replay changes nothing');
    assert.equal(readTitleStyle(file).style, 'actions');
    assert.equal(setTitleStyle('verbs', {}, file), null);
    assert.equal(setTitleStyle('subjects', { at: '2026-01-03T00:00:00.000Z' }, file).style, 'subjects');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('subjects: named at the end of a turn after the debounce, subjects merged, activity ignored', async () => {
  const h = harness({ title: 'sidebar search', titleSource: 'auto', events: [ev('message.user', { text: 'now the release notes' }), ev('tool.started', { itemId: 't1', tool: 'Bash', input: { command: 'git log' } })], ask: () => 'release notes' });
  h.titler.observe(ev('tool.started', { itemId: 't1', tool: 'Bash' }));
  assert.equal(h.timers.length, 0, 'activity does not ask in subject mode');
  h.titler.schedule(ID);
  assert.equal(h.timers[0].delay, DEBOUNCE_MS);
  await h.fire();
  assert.equal(h.asks[0].style, 'subjects');
  assert.equal(h.asks[0].shown, 'sidebar search');
  assert.doesNotMatch(h.asks[0].transcript, /Tool/);
  assert.deepEqual(h.renames, ['sidebar search, release notes']);
});

test('actions: activity asks at most once per interval, the end of a run soon, and the action replaces the name', async () => {
  const answers = ['fixing the sidebar search', 'fixed the sidebar search'];
  const h = harness({ style: 'actions', title: 'sidebar search', titleSource: 'auto', ask: (n) => answers[n - 1],
    events: [ev('message.user', { text: 'fix the sidebar search' }), ev('tool.started', { itemId: 't1', tool: 'Edit', input: { file_path: 'src/Sidebar.svelte' } })] });
  h.titler.observe(ev('tool.started', { itemId: 't1', tool: 'Edit' }));
  assert.equal(h.timers[0].delay, ACTION_SETTLE_MS);
  await h.fire();
  assert.equal(h.asks[0].style, 'actions');
  assert.equal(h.asks[0].runState, 'running');
  assert.match(h.asks[0].transcript, /^User: fix the sidebar search\nTool running: Edit .*Sidebar\.svelte/u);
  assert.deepEqual(h.renames, ['fixing the sidebar search'], 'replaced, not merged with the old subject');

  h.tick(5_000);
  h.log.push(ev('tool.completed', { itemId: 't1' }));
  h.titler.observe(ev('tool.completed', { itemId: 't1' }));
  h.titler.observe(ev('assistant.message', { text: 'still going' }));
  assert.equal(h.timers.length, 1, 'one ask covers a burst of activity');
  assert.equal(h.timers[0].delay, ACTION_INTERVAL_MS - 5_000);
  // the end of the run does not wait out the interval
  h.conversation.runState = 'completed';
  h.log.push(ev('assistant.message', { text: 'Fixed: the search now matches folder names.' }));
  h.titler.observe(ev('run.completed'));
  assert.equal(h.timers.at(-1).delay, ACTION_SETTLE_MS);
  await h.fire();
  assert.equal(h.asks[1].runState, 'completed');
  assert.equal(h.asks[1].shown, 'fixing the sidebar search');
  assert.deepEqual(h.renames, ['fixing the sidebar search', 'fixed the sidebar search']);

  // nothing new since the last ask: no call at all
  h.titler.schedule(ID);
  await h.fire();
  assert.equal(h.asks.length, 2);
  // a subagent's activity is its parent's to describe
  h.titler.observe(ev('tool.started', { itemId: 't9', tool: 'Bash', agentId: 'a1' }));
  assert.equal(h.timers.length, 0);
});

test('actions: what happens while the model answers is asked about right after', async () => {
  const h = harness({ style: 'actions', events: [ev('message.user', { text: 'fix the sidebar search' })],
    ask: (n, conversation) => {
      if (n === 1) { conversation.runState = 'completed'; h.log.push(ev('run.completed')); h.titler.observe(ev('run.completed')); }
      return n === 1 ? 'fixing the sidebar search' : 'fixed the sidebar search';
    } });
  h.titler.schedule(ID);
  await h.fire();
  assert.equal(h.timers.length, 1, 'the run ended during the ask: one more is queued');
  assert.equal(h.timers[0].delay, ACTION_SETTLE_MS);
  await h.fire();
  assert.deepEqual(h.renames, ['fixing the sidebar search', 'fixed the sidebar search']);
});

for (const style of ['subjects', 'actions']) {
  test(`${style}: a name he gave the chat stands, also when he gives it while the model is answering`, async () => {
    const kept = harness({ style, title: 'my own name', titleSource: 'manual', events: [ev('message.user', { text: 'fix it' })], ask: () => 'fixing it' });
    kept.titler.schedule(ID);
    await kept.fire();
    assert.equal(kept.asks.length, 0, 'a manual name is never sent to be renamed');

    const racing = harness({ style, events: [ev('message.user', { text: 'fix it' })],
      ask: (_n, conversation) => { conversation.title = 'typed meanwhile'; conversation.titleSource = 'manual'; return 'fixing it'; } });
    racing.titler.schedule(ID);
    await racing.fire();
    assert.equal(racing.asks.length, 1);
    assert.deepEqual(racing.renames, []);
    assert.equal(racing.conversation.title, 'typed meanwhile');
  });
}

test('back on subjects, the action name is not kept as a subject', async () => {
  const h = harness({ style: 'actions', events: [ev('message.user', { text: 'fix the sidebar search' })], ask: (n) => (n === 1 ? 'fixing the sidebar search' : 'sidebar search') });
  h.titler.schedule(ID);
  await h.fire();
  h.box.style = 'subjects';
  h.titler.schedule(ID);
  assert.equal(h.timers[0].delay, DEBOUNCE_MS);
  await h.fire();
  assert.equal(h.asks[1].shown, '', 'the subject titler starts from no name');
  assert.deepEqual(h.renames, ['fixing the sidebar search', 'sidebar search']);
});

test('activityFor: tool calls with their state, the last request always in, subagents left out', () => {
  const events = [
    ev('message.user', { text: 'migrate the invoices table' }),
    ...Array.from({ length: 20 }, (_, i) => ev('tool.started', { itemId: `r${i}`, tool: 'Read', input: { file_path: `db/${i}.sql` } })),
    ev('tool.started', { itemId: 'x', tool: 'Bash', input: { command: 'npm run migrate' } }),
    ev('tool.completed', { itemId: 'x', isError: true }),
    ev('tool.started', { itemId: 'sub', tool: 'Bash', agentId: 'a1', input: { command: 'echo hidden' } })
  ];
  const lines = activityFor(events).split('\n');
  assert.equal(lines[0], 'User: migrate the invoices table');
  assert.match(lines.at(-1), /^Tool failed: Bash .*npm run migrate/u);
  assert.equal(lines.length, 19, 'the newest 18 rows and the request');
  assert.ok(!lines.some((line) => line.includes('hidden')));
});

test('the menu change shows at once and waits in the outbox until the server takes it', async () => {
  const items = new Map();
  const storage = { getItem: (k) => items.get(k) ?? null, setItem: (k, v) => items.set(k, v), removeItem: (k) => items.delete(k) };
  assert.equal(readStyle(storage), 'subjects');
  assert.equal(queueStyle('actions', { storage, now: () => '2026-01-01T00:00:00.000Z' }), 'actions');
  assert.equal(await sync({ storage, fetchImpl: async () => { throw new Error('offline'); } }), 'actions');
  assert.ok(items.has('tophat-title-style:outbox'), 'kept for the next try');
  const sent = [];
  let saved = { style: 'subjects', at: null };
  const fetchImpl = async (url, init) => {
    if (init?.method === 'POST') { sent.push(JSON.parse(init.body)); saved = JSON.parse(init.body); }
    return { ok: true, status: 200, json: async () => saved };
  };
  assert.equal(await sync({ storage, fetchImpl }), 'actions');
  assert.deepEqual(sent, [{ style: 'actions', at: '2026-01-01T00:00:00.000Z' }]);
  assert.ok(!items.has('tophat-title-style:outbox'));
  assert.equal(readStyle(storage), 'actions', 'from the cached server answer');
});

test('intervalMs in the style file is the one throttle knob; a write of the style keeps it; a bad value falls back', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'title-style-'));
  try {
    const file = path.join(dir, 'title-style.json');
    writeFileSync(file, JSON.stringify({ style: 'actions', at: '2026-01-01T00:00:00.000Z', intervalMs: 120000 }));
    assert.equal(readTitleStyle(file).intervalMs, 120000);
    setTitleStyle('subjects', { at: '2026-01-02T00:00:00.000Z' }, file);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).intervalMs, 120000);
    const bad = path.join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify({ style: 'actions', intervalMs: 5 }));
    assert.equal(readTitleStyle(bad).intervalMs, ACTION_INTERVAL_MS);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the titler reads the interval from the knob: a second ask waits out intervalMs after the first', async () => {
  const h = harness({ style: 'actions', title: 'x', titleSource: 'auto', events: [ev('message.user', { text: 'fix it' })], ask: (n) => `fixing it ${n}` });
  h.titler.schedule(ID);
  await h.fire();
  h.tick(1_000);
  h.log.push(ev('assistant.message', { text: 'looking' }));
  h.titler.observe(ev('assistant.message', { text: 'looking' }));
  assert.equal(h.timers.at(-1).delay, ACTION_INTERVAL_MS - 1_000);
});

test('actions: an arrival chat\'s "Who: what" title and a title set by chat_rename (manual) are never replaced, also mid-call', async () => {
  for (const titleSource of ['arrival', 'manual']) {
    const h = harness({ style: 'actions', title: 'Vercel: domains misconfigured', titleSource, events: [ev('message.user', { text: 'fix it' })], ask: () => 'fixing it' });
    h.titler.observe(ev('tool.started', { itemId: 't1', tool: 'Bash' }));
    h.titler.schedule(ID);
    await h.fire();
    assert.equal(h.asks.length, 0);
    assert.deepEqual(h.renames, []);
  }
  const mid = harness({ style: 'actions', title: 'chat', titleSource: 'auto', events: [ev('message.user', { text: 'fix it' })], ask: (_n, c) => { c.title = 'Who: what'; c.titleSource = 'arrival'; return 'fixing it'; } });
  mid.titler.schedule(ID);
  await mid.fire();
  assert.deepEqual(mid.renames, []);
});
