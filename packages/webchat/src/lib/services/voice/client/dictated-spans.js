// The dictations sitting in a draft, and the seconds of audio behind them.
//
// WHY THIS EXISTS. A draft survives a reload because it is written to local
// storage; the word times that make a tap on one of its words meaningful live
// only in the component that received them, and a reload throws them away.
// They are small -- three numbers and a word each -- so they are kept beside
// the draft, keyed the same way, and expire with it.
//
// The clip they point at is on the machine, in the dictation corpus, and this
// holds nothing but its id.

import { field, set } from '../../../../../../runner/tools/quicklook-kit/lib/schema.js';
import { keyed } from '../../../../../../runner/tools/quicklook-kit/lib/recipes.js';
import { uiApp } from '$lib/client/ui-app.js';

const PREFIX = 'tophat:dictated:';

// Enough for a long dictation and a few before it; past this the oldest go.
const MAX_SPANS = 6;
const MAX_WORDS = 1_200;

function clean(span) {
  if (!span || typeof span !== 'object') return null;
  const text = typeof span.text === 'string' ? span.text : '';
  const clipId = typeof span.clipId === 'string' ? span.clipId : null;
  const token = typeof span.token === 'string' ? span.token : null;
  const start = Number(span.start);
  if (!text || !token || !Number.isFinite(start)) return null;
  const words = (Array.isArray(span.words) ? span.words : [])
    .filter((word) => word && typeof word.word === 'string'
      && Number.isFinite(word.start) && Number.isFinite(word.end))
    .slice(0, MAX_WORDS)
    .map((word) => ({ word: word.word, start: word.start, end: word.end }));
  return { token, clipId, text, start, words };
}

// One record per draft key in the kit's keyed `dictated` family (removed when empty, crossTab); the old
// `tophat:dictated:<key>` value is imported on first read, then archived.
const spans = keyed('dictated', {
  fields: { spans: field([], (v) => (Array.isArray(v) ? v : []).map(clean).filter(Boolean)) }, // capped on write, as before
  legacy: (key) => [{ key: PREFIX + key, json: true, into: 'spans', archive: true }],
  legacyPrefix: PREFIX,
  actions: { 'spans.set': set('spans', 'spans') }
});

export function readSpans(key) {
  if (!key) return [];
  try { return spans.use(uiApp(), key).get().spans; } catch { return []; }
}

export function writeSpans(key, list) {
  if (!key) return;
  try { spans.use(uiApp(), key).dispatch('spans.set', { spans: (Array.isArray(list) ? list : []).map(clean).filter(Boolean).slice(-MAX_SPANS) }); } catch { /* storage refused */ }
}

export function forgetSpans(key) {
  writeSpans(key, []);
}
