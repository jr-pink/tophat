// The scripted opener: the text, its recorded typing cadence, the model-like stream of its answer and the site's meta tags.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OPENER_GAPS_MS, OPENER_TEXT, metaTags, openerAnswer, pieces } from '../src/answer.mjs';

const DEMO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const description = path.join(DEMO, 'content/description.md');

test('the opener is the owner\'s own phrase and has one recorded gap per character', () => {
  assert.equal(OPENER_TEXT, 'so, whats ur deal ?');
  assert.equal(OPENER_GAPS_MS.length, OPENER_TEXT.length);
  assert.equal(OPENER_GAPS_MS[0], 0);
  assert.ok(OPENER_GAPS_MS.every((n) => Number.isInteger(n) && n >= 0 && n < 1000));
});

test('the stream is modest deltas that rebuild the answer exactly, with images and fences whole', () => {
  const answer = openerAnswer(description, path.join(DEMO, 'widgets'));
  const out = pieces(answer);
  assert.equal(out.join(''), answer);
  // a link's target is one piece (a half-written `](` would flash as text), so a piece that carries one may be longer
  assert.ok(out.filter((p) => !/^!\[|^```|\]\(/.test(p)).every((p) => p.length <= 90), 'prose in modest chunks');
  assert.ok(out.some((p) => /^!\[/.test(p) && p.trim().endsWith(')')), 'an image line arrives whole');
});

test('the meta tags come from the description and name the og image', () => {
  const m = metaTags(description);
  for (const k of ['name="description"', 'og:title', 'og:description', 'og:image', 'twitter:card']) assert.ok(m.includes(k), k);
  assert.ok(!m.includes('\u2014'), 'no em dash');
});
