import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createFeed, pieceDelayMs, tokenPieces } from '../src/stream.mjs';

test('token pieces are small, whole figures stay whole, and they concatenate to the text', () => {
  const md = 'so whats my deal? it is a **memory** thing.\n\n![Memory graph](~/w/a.html)\n\n```js\nlet a = 1;\n```\n\nlast paragraph here, with words.';
  const out = tokenPieces(md);
  assert.equal(out.join(''), md);
  assert.ok(out.includes('![Memory graph](~/w/a.html)\n\n'));
  assert.ok(out.every((p) => /^!\[|^```/.test(p) || p.replace(/\n+$/, '').length <= 8), 'prose pieces are word-sized');
  assert.ok(out.length > 20);
});

test('about eighty pieces a second, figures a moment', () => {
  const delays = Array.from({ length: 200 }, (_, i) => pieceDelayMs(' word', () => i / 200));
  const mean = delays.reduce((a, b) => a + b, 0) / delays.length;
  assert.ok(mean > 8 && mean < 14, `mean ${mean} ms a piece`);
  assert.equal(pieceDelayMs('![x](y)'), 260);
});

test('the feed writes an event frame into the right stream, only between upstream frames', async () => {
  const feed = createFeed();
  const mine = new PassThrough(), other = new PassThrough();
  const a = feed.attach(mine, 'g1'); feed.attach(other, 'g2');
  const seen = []; mine.on('data', (d) => seen.push(d.toString()));
  const ev = { cursor: 5, conversation_id: 'c', kind: 'assistant.delta', content: { text: 'hi' } };
  feed.chunk(a, Buffer.from('data: {"hello":true,"cursor":4}\n\n'));
  feed.publish(ev, (g) => g === 'g1');
  assert.equal(seen.length, 2);
  assert.deepEqual(JSON.parse(seen[1].replace(/^data: /, '')), { events: [ev] });
  // a half upstream frame holds the event back until the frame completes
  feed.chunk(a, Buffer.from('data: {"events":[{"cur'));
  feed.publish({ ...ev, cursor: 6 }, (g) => g === 'g1');
  assert.equal(seen.length, 3);
  feed.chunk(a, Buffer.from('sor":3}]}\n\n'));
  assert.equal(seen.length, 5);
  assert.match(seen[4], /"cursor":6/);
  assert.equal(other.read(), null);
  mine.destroy();
  await new Promise((r) => setImmediate(r));
  assert.equal(feed.size(), 1);
});
