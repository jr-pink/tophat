// From a word in the draft to the seconds of audio it came out of.
//
// WHY THIS EXISTS. The composer is a plain textarea: what it holds is a string,
// and a tap in it gives a character offset and nothing more. Whisper, on the
// other side, gives times: `{word, start, end}` for every word it decoded, in
// seconds of the recording. Tapping a word and asking what else it could have
// been needs the bridge between the two, and the bridge cannot be character
// arithmetic, because the string in the draft is not the string whisper
// produced -- spoken punctuation has been applied to it ("question mark" became
// "?"), the ends of two windows have been stitched, and he may have typed in
// the middle of it.
//
// So the mapping is by word position, matched on the word itself where the two
// still agree and interpolated where they do not, and it says which of the two
// it did. Everything here is pure.

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'\u2018\u2019\u2010-]*/gu;

function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\u2018\u2019]/gu, "'")
    .replace(/[^\p{L}\p{N}']/gu, '')
    .trim();
}

/**
 * The words of a decode, with their times moved from the window they were
 * decoded in to the recording they belong to.
 */
export function wordsFromSegments(segments, fromSec = 0) {
  const base = Number.isFinite(fromSec) ? fromSec : 0;
  const out = [];
  for (const segment of Array.isArray(segments) ? segments : []) {
    for (const word of Array.isArray(segment?.words) ? segment.words : []) {
      const start = Number(word?.start);
      const end = Number(word?.end);
      const text = String(word?.word ?? '').trim();
      if (!text || !Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
      out.push({
        word: text,
        start: Number((start + base).toFixed(3)),
        end: Number((end + base).toFixed(3)),
        probability: Number.isFinite(word?.probability) ? word.probability : null
      });
    }
  }
  return out;
}

/**
 * The run's word times after one more window was decoded.
 *
 * The preview re-decodes a rolling window, so every poll returns words for
 * seconds that already had words. The newest decode of a second is the one
 * that stands: everything the run held that ends before this window began is
 * kept, and the window's own words replace the rest.
 */
export function mergeWordTimes(held, segments, fromSec = 0) {
  const base = Number.isFinite(fromSec) ? fromSec : 0;
  const fresh = wordsFromSegments(segments, base);
  const kept = (Array.isArray(held) ? held : []).filter((word) => Number(word?.end) <= base + 0.001);
  if (!fresh.length) return Array.isArray(held) ? held : [];
  return [...kept, ...fresh].sort((a, b) => a.start - b.start);
}

/**
 * The word of `text` the caret or selection is sitting in, as a character
 * range. A caret between two words takes the word to its left if it is
 * touching one, and otherwise the word to its right; a selection takes every
 * word it touches.
 */
export function wordRangeAt(text, start, end = start) {
  const body = String(text ?? '');
  const from = Math.max(0, Math.min(body.length, Number(start) || 0));
  const to = Math.max(from, Math.min(body.length, Number(end ?? start) || 0));
  const tokens = tokenize(body);
  if (!tokens.length) return null;
  const touched = tokens.filter((token) => (from === to
    ? token.start <= from && from <= token.end
    : token.start < to && token.end > from));
  if (!touched.length) {
    // A caret in whitespace: the nearest word, preferring the one it just
    // finished typing or reading.
    const before = [...tokens].reverse().find((token) => token.end <= from);
    const after = tokens.find((token) => token.start >= to);
    const pick = before || after;
    if (!pick) return null;
    return { start: pick.start, end: pick.end, text: body.slice(pick.start, pick.end) };
  }
  const first = touched[0];
  const last = touched[touched.length - 1];
  return { start: first.start, end: last.end, text: body.slice(first.start, last.end) };
}

export function tokenize(text) {
  const body = String(text ?? '');
  const out = [];
  WORD.lastIndex = 0;
  let match = WORD.exec(body);
  while (match) {
    out.push({ text: match[0], start: match.index, end: match.index + match[0].length });
    match = WORD.exec(body);
  }
  return out;
}

function nearestMatch(wanted, words, expected, reach) {
  for (let step = 0; step <= reach; step += 1) {
    for (const at of step === 0 ? [expected] : [expected - step, expected + step]) {
      if (at < 0 || at >= words.length) continue;
      if (words[at].key === wanted) return at;
    }
  }
  return -1;
}

/**
 * The seconds of audio behind a character range of dictated text.
 *
 * `text` is what the dictation put in the draft and `words` are the times
 * whisper gave for that same dictation. The answer carries `exact: true` when
 * the word in the draft is the word whisper had in that position, and
 * `exact: false` when the two had drifted and the position had to be
 * interpolated -- either way the caller gets a span it can decode, because a
 * span that is half a word out still re-decodes to a useful alternative once
 * it is padded.
 */
function usableWords(words) {
  return (Array.isArray(words) ? words : [])
    .map((word) => ({ ...word, key: normalize(word?.word) }))
    .filter((word) => word.key && Number.isFinite(word.start) && Number.isFinite(word.end));
}

export function spanForRange({ text, start, end, words } = {}) {
  const list = usableWords(words);
  if (!list.length) return null;
  const tokens = tokenize(text).filter((token) => normalize(token.text));
  if (!tokens.length) return null;
  const from = Number(start);
  const to = Number(end);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null;
  const touched = tokens
    .map((token, index) => ({ ...token, index }))
    .filter((token) => token.start < to && token.end > from);
  if (!touched.length) return null;

  const scale = (index) => (tokens.length > 1
    ? Math.round((index * (list.length - 1)) / (tokens.length - 1))
    : 0);
  const reach = Math.max(3, Math.ceil(list.length / 4));
  let exact = true;
  const place = (token) => {
    const expected = Math.max(0, Math.min(list.length - 1, scale(token.index)));
    const found = nearestMatch(normalize(token.text), list, expected, reach);
    if (found < 0) { exact = false; return expected; }
    return found;
  };
  const first = place(touched[0]);
  const last = Math.max(first, place(touched[touched.length - 1]));
  return {
    startSec: list[first].start,
    endSec: list[last].end,
    exact,
    words: list.slice(first, last + 1).map((word) => word.word).join(' ').trim()
  };
}

/** An alternative reading, fitted to the place in the draft it is replacing.
 *
 * The decoder read a second and a half of audio out of context, so it says "The
 * Sternum." where the draft has "sternum" in the middle of a sentence. The
 * words are its answer and are left alone.
 */
export function fitReplacement(original, replacement) {
  const was = String(original ?? '');
  let next = String(replacement ?? '').trim();
  if (!next) return null;
  const lead = was.match(/^\s*/u)[0];
  const trail = was.match(/\s*$/u)[0];
  const body = was.trim();
  if (!/[.,!?;:\u2026]$/u.test(body)) next = next.replace(/[.,!?;:\u2026]+$/u, '');
  if (!next) return null;
  const first = body.slice(0, 1);
  if (first && first === first.toLowerCase() && first !== first.toUpperCase()) {
    // Lower case where he had lower case, but only when the rest of that word
    // is lower case too: "NASA" is not a capital the decoder invented.
    const head = next.split(/\s/u)[0];
    if (head.slice(1) === head.slice(1).toLowerCase()) next = next.slice(0, 1).toLowerCase() + next.slice(1);
  } else if (first && first === first.toUpperCase() && first !== first.toLowerCase()) {
    next = next.slice(0, 1).toUpperCase() + next.slice(1);
  }
  return `${lead}${next}${trail}`;
}

/**
 * The phrase a tap is really about.
 *
 * A word on its own is not decodable: cut out of its neighbours, "parentheses"
 * comes back as "practices" -- measured, on a real clip of his. So the span
 * that gets decoded again is the word with about four tenths of a second of
 * speech either side of it, and what comes back is a reading of that whole
 * phrase. This says which characters of the draft that phrase is, so the
 * reading he picks replaces exactly the text the decoder was talking about
 * and not one word in the middle of it.
 */
export function phraseForRange({ text, start, end, words, padSec = 0.4 } = {}) {
  const body = String(text ?? '');
  const list = usableWords(words);
  const tokens = tokenize(body).filter((token) => normalize(token.text));
  if (!list.length || !tokens.length) return null;
  const word = spanForRange({ text: body, start, end, words });
  if (!word) return null;
  const pad = Number.isFinite(padSec) && padSec >= 0 ? padSec : 0.4;

  const from = word.startSec - pad;
  const to = word.endSec + pad;
  const mostlyIn = (w) => {
    const overlap = Math.min(w.end, to) - Math.max(w.start, from);
    if (overlap <= 0) return false;
    const length = w.end - w.start;
    return length <= 0 || overlap >= length / 2;
  };
  const inside = list.map((w, at) => (mostlyIn(w) ? at : -1)).filter((at) => at >= 0);
  const first = inside.length ? inside[0] : 0;
  const last = inside.length ? inside[inside.length - 1] : list.length - 1;

  const scale = (index) => (list.length > 1
    ? Math.round((index * (tokens.length - 1)) / (list.length - 1))
    : 0);
  const reach = Math.max(3, Math.ceil(tokens.length / 4));
  const back = (index) => {
    const expected = Math.max(0, Math.min(tokens.length - 1, scale(index)));
    const keys = tokens.map((token) => ({ key: normalize(token.text) }));
    const found = nearestMatch(list[index].key, keys, expected, reach);
    return found < 0 ? expected : found;
  };

  const touched = tokens
    .map((token, index) => ({ ...token, index }))
    .filter((token) => token.start < Number(end) && token.end > Number(start));
  const anchorFirst = touched.length ? touched[0].index : 0;
  const anchorLast = touched.length ? touched[touched.length - 1].index : tokens.length - 1;
  const lo = Math.max(0, Math.min(anchorFirst, back(first)));
  const hi = Math.min(tokens.length - 1, Math.max(anchorLast, back(last)));
  return {
    charStart: tokens[lo].start,
    charEnd: tokens[hi].end,
    phrase: body.slice(tokens[lo].start, tokens[hi].end),
    startSec: word.startSec,
    endSec: word.endSec,
    spanStartSec: Math.max(0, from),
    spanEndSec: to,
    exact: word.exact
  };
}
