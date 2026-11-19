// The rendered card of an automated event (owner request, 2026-11-18 14:51 PST: "make the automated events have a rendered
// thing ... highlight which items were in the event . and which are included as just context. or for mail, it should render
// the mail threads ... keep the current automated event fold-down"). Unit tests for the payload sanitizer and helpers, then
// the real components server-rendered through vite: a chat arrival (WeChat), an iMessage with tapbacks, an image and read
// receipts, and a mail thread, and the raw fold under the card still opening from the fold store.
import assert from 'node:assert/strict';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { acceptCards, dayLabel, shortName, statusLabel, stripQuoted, systemText, withDays } from '../src/lib/core/event-cards.js';

const root = path.resolve(import.meta.dirname, '..');
const NOW = Date.parse('2026-11-18T23:30:00Z');

const wechat = {
  v: 1, kind: 'chat', source: 'wechat', thread: 'wechat:fc5c', title: 'Project Alpha SF 2026', group: true,
  messages: [
    { id: 'w1', at: '2026-11-18T18:40:10.000Z', from: '郭超凡 Chaofan', text: '[system] "郭超凡 Chaofan" recalled a message', system: true, recalled: true, in_event: false },
    { id: 'w2', at: '2026-11-18T20:37:27.000Z', from: '郭超凡 Chaofan', text: 'Maybe tomorrow works better as my flight is delayed', in_event: false },
    { id: 'w3', at: '2026-11-18T20:38:10.000Z', from: 'the owner', self: true, text: 'Hows 7pm tomorrow?', in_event: false },
    { id: 'w4', at: '2026-11-18T20:42:03.000Z', from: '郭超凡 Chaofan', text: 'Should work. Let me send a calendar for all first.', in_event: true }
  ]
};
const imessage = {
  v: 1, kind: 'chat', source: 'imessage', thread: 'imessage:+17035550100', title: 'Miina Anvelt',
  messages: [
    { id: 'i1', at: '2026-11-18T19:14:44.947Z', from: 'the owner', self: true, text: 'lmk when u send !', in_event: false, status: { state: 'read', delivered_at: '2026-11-18T19:14:46.000Z', read_at: '2026-11-18T19:20:00.000Z' }, reactions: [{ emoji: '👍', from: 'Miina Anvelt', self: false }] },
    { id: 'i2', at: '2026-11-18T22:08:00.000Z', from: 'Miina Anvelt', text: 'here is the receipt', in_event: false, attachments: [{ name: 'IMG_1.heic', mime: 'image/heic', size: 1200000, kind: 'image', url: '/api/file?path=%2Ftmp%2Fcard-media%2Fa.jpg' }, { name: 'lease.pdf', mime: 'application/pdf', size: 88000, kind: 'file' }] },
    { id: 'i3', at: '2026-11-18T22:09:25.149Z', from: 'Miina Anvelt', text: 'Ok is it ok if I pay by sat?', in_event: true, edited: true, reply_to: { from: 'the owner', text: 'lmk when u send !' }, reactions: [{ emoji: '❤️', from: 'the owner', self: true }] },
    { id: 'i4', at: '2026-11-18T22:11:00.000Z', from: 'the owner', self: true, text: 'ya nw', in_event: false, status: { state: 'delivered' } }
  ]
};
const mail = {
  v: 1, kind: 'mail', source: 'gmail-personal', account: 'user@example.test', thread: 't1', subject: 'Re: RUV Next Steps',
  messages: [
    { id: 'm1', at: '2026-11-17T19:59:21.000Z', from: 'user@example.test', to: 'Vish <rollups@angellist.com>', subject: 'Re: RUV Next Steps', text: 'Sure, wire details attached.\n\nthe owner\n\nOn Nov 9, 2026 at 11:19 AM, Vish wrote:\n> older quoted text', in_event: false, self: true, attachments: [{ name: 'wire.pdf', size: 52000, kind: 'file' }] },
    { id: 'm2', at: '2026-11-18T01:25:32.000Z', from: 'Vish Khamamkar <rollups@angellist.com>', to: 'the owner, Dana', cc: 'Sam', subject: 'Re: RUV Next Steps', text: 'Sounds great. Thanks, Dana and the owner and congrats!', in_event: true }
  ]
};

test('acceptCards keeps real cards, drops junk, caps sizes and refuses any image url that is not the authed file route', () => {
  assert.deepEqual(acceptCards(null), []);
  assert.deepEqual(acceptCards('x'), []);
  assert.deepEqual(acceptCards([{ kind: 'weird', messages: [{ id: 1 }] }, { kind: 'chat', messages: [] }, 7]), []);
  const out = acceptCards([{ ...imessage, messages: [...imessage.messages, { id: 'bad', at: 'not a date', from: 'X', text: 'y', attachments: [{ name: 'a.jpg', kind: 'image', url: 'https://evil.example/a.jpg' }, { name: 'b.jpg', kind: 'image', url: 'javascript:alert(1)' }] }] }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].messages.length, 5);
  const bad = out[0].messages[4];
  assert.equal(bad.at, '');
  assert.ok(bad.attachments.every((a) => !('url' in a)), 'foreign urls are dropped');
  assert.equal(out[0].messages[1].attachments[0].url, '/api/file?path=%2Ftmp%2Fcard-media%2Fa.jpg');
  assert.equal(out[0].messages[2].in_event, true);
  assert.equal(out[0].messages[0].status.state, 'read');
  const many = acceptCards([{ kind: 'chat', messages: Array.from({ length: 80 }, (_, i) => ({ id: `${i}`, text: 'x'.repeat(20000), in_event: i === 79 })) }]);
  assert.equal(many[0].messages.length, 30);
  assert.equal(many[0].messages[29].in_event, true, 'the newest messages survive the cap');
  assert.ok(many[0].messages[0].text.length <= 8000);
});

test('helpers: status wording, day labels, names, quoted tails, system lines', () => {
  assert.equal(statusLabel({ state: 'read', read_at: '2026-11-18T22:05:00Z' }, { tz: 'America/Los_Angeles' }), 'Read 2:05 PM');
  assert.equal(statusLabel({ state: 'read', read_at: '2026-11-18T22:05:00Z', read_by: 3 }, { time: false }), 'Read by 3');
  assert.equal(statusLabel({ state: 'delivered' }), 'Delivered');
  assert.equal(statusLabel({ state: 'failed' }), 'Not delivered');
  assert.equal(statusLabel(undefined), '');
  assert.equal(dayLabel('2026-11-18T20:00:00Z', NOW, 'America/Los_Angeles'), 'Today');
  assert.equal(dayLabel('2026-11-17T20:00:00Z', NOW, 'America/Los_Angeles'), 'Yesterday');
  assert.match(dayLabel('2026-11-10T20:00:00Z', NOW, 'America/Los_Angeles'), /Tue, Nov 10/);
  assert.equal(shortName('Vish Khamamkar <rollups@angellist.com>'), 'Vish Khamamkar');
  assert.equal(shortName('Contact +14157347497'), '+14157347497');
  assert.deepEqual(withDays(imessage.messages, 'America/Los_Angeles').filter((r) => r.divider).length, 1);
  const q = stripQuoted(mail.messages[0].text);
  assert.equal(q.text, 'Sure, wire details attached.\n\nthe owner');
  assert.equal(q.trimmed, true);
  assert.equal(systemText(wechat.messages[0]), '"郭超凡 Chaofan" recalled a message');
  assert.equal(systemText({ from: 'Ana', recalled: true, text: '' }), 'Ana unsent a message');
});

let server, render, cardMod, messageMod, folds;
before(async () => {
  const { createServer } = await import('vite');
  const { svelte } = await import('@sveltejs/vite-plugin-svelte');
  server = await createServer({ root, configFile: false, logLevel: 'error', appType: 'custom', server: { middlewareMode: true, hmr: false, watch: null }, resolve: { alias: { $lib: path.join(root, 'src/lib') } }, plugins: [svelte({ compilerOptions: { generate: 'server' } })] });
  ({ render } = await server.ssrLoadModule('svelte/server'));
  cardMod = (await server.ssrLoadModule('/src/lib/ui/EventCard.svelte')).default;
  messageMod = (await server.ssrLoadModule('/src/lib/ui/Message.svelte')).default;
  folds = await server.ssrLoadModule('/src/lib/ui/disclosure.svelte.js');
});
after(async () => { await server?.close(); });

const html = (component, props) => render(component, { props }).body;
const count = (s, re) => (s.match(re) || []).length;

test('a chat card: context faded, event messages outlined, owner on the right, day separator, system line', () => {
  const out = html(cardMod, { cards: acceptCards([wechat]), itemId: 'e1', now: NOW });
  assert.equal(count(out, /data-testid="event-card"/g), 1);
  assert.match(out, /Project Alpha SF 2026/);
  assert.equal(count(out, /data-in-event="true"/g), 1, 'one message arrived in the event');
  assert.equal(count(out, /data-in-event="false"/g), 3, 'the other three are context');
  assert.equal(count(out, /data-self="true"/g), 1, 'the owner message is the right-hand one');
  assert.match(out, /class="msg svelte-[\w-]+ self ctx"/);
  assert.match(out, /class="msg svelte-[\w-]+ ev"/);
  assert.match(out, /recalled a message/);
  assert.match(out, /role="separator"/);
  assert.match(out, /Outlined: arrived in this event/);
});

test('an iMessage card shows read and delivered state, tapbacks beside their message, the image, the file chip, the reply and Edited', () => {
  const out = html(cardMod, { cards: acceptCards([imessage]), itemId: 'e2', now: NOW });
  assert.match(out, /Read \d{1,2}:\d\d [AP]M/);
  assert.match(out, /Delivered/);
  assert.equal(count(out, /data-testid="card-reactions"/g), 2, 'tapbacks ride on their own bubbles');
  assert.match(out, /👍/); assert.match(out, /❤️/);
  assert.match(out, /<img src="\/api\/file\?path=%2Ftmp%2Fcard-media%2Fa\.jpg"/);
  assert.match(out, /lease\.pdf · 88 KB/);
  assert.match(out, /class="reply[^"]*"><b[^>]*>the owner<\/b> lmk when u send !/);
  assert.match(out, /Edited/);
  assert.equal(count(out, /data-in-event="true"/g), 1);
});

test('a mail card: the thread, the event message open and outlined, context collapsed to a snippet, quoted tail hidden', () => {
  const out = html(cardMod, { cards: acceptCards([mail]), itemId: 'e3', now: NOW });
  assert.match(out, /data-kind="mail"/);
  assert.match(out, /Re: RUV Next Steps/);
  assert.equal(count(out, /data-in-event="true"/g), 1);
  assert.equal(count(out, /data-in-event="false"/g), 1);
  assert.equal(count(out, /data-testid="mail-body"/g), 1, 'only the event message body is open');
  assert.match(out, /Sounds great\. Thanks, Dana and the owner/);
  assert.match(out, /Vish Khamamkar/);
  assert.match(out, /cc Sam/);
  assert.doesNotMatch(out, /older quoted text/);
  assert.match(out, /wire\.pdf · 52 KB/);
  assert.match(out, /Sure, wire details attached/, 'the context message shows as a snippet');
});

test('Message: an event with cards draws the card above the fold line, and the raw fold still opens from the store; no cards means today\'s line alone', () => {
  const text = '[Automated event from the push plane; this is not a message from the owner.]\n1 new arrival looks like someone has to act:\n\n1. Source: wechat, thread wechat:fc5c; raw record r_x\n   Excerpt: "Should work."';
  const item = { id: 'ev-card-1', type: 'user', text, at: '2026-11-18T20:42:03Z', cards: [wechat] };
  const closed = html(messageMod, { item });
  assert.match(closed, /data-testid="event-card"/);
  assert.match(closed, /data-testid="event-toggle"/);
  assert.match(closed, /aria-expanded="false"/);
  assert.doesNotMatch(closed, /data-testid="event-text"/);
  assert.ok(closed.indexOf('event-card') < closed.indexOf('event-toggle'), 'the card sits above the fold line');
  folds.toggleOpen(null, 'event', 'ev-card-1');
  const open = html(messageMod, { item });
  assert.match(open, /data-testid="event-text"/);
  assert.match(open, /Source: wechat, thread wechat:fc5c; raw record r_x/);
  assert.match(open, /data-testid="event-card"/, 'the card stays when the raw text is open');
  const plain = html(messageMod, { item: { id: 'ev-plain', type: 'user', text, at: '2026-11-18T20:42:03Z' } });
  assert.doesNotMatch(plain, /data-testid="event-card"/);
  assert.match(plain, /data-testid="event-toggle"/);
  const junk = html(messageMod, { item: { id: 'ev-junk', type: 'user', text, at: '2026-11-18T20:42:03Z', cards: [{ kind: 'nope' }] } });
  assert.doesNotMatch(junk, /data-testid="event-card"/);
});
