// Text quality for anything entering the reader.
//
// Two jobs, deliberately separate. `repairText` fixes the damage that is mechanical and
// reversible: soft hyphens and hyphen-newline breaks that split a word, running heads and page
// numbers a PDF page extractor leaves in the body, and the small set of OCR letter swaps that a
// dictionary can adjudicate ("hean" is not a word, "heart" is, and nothing else fits). `scoreText`
// then says how much damage is left, because the half that is not mechanical (a scan whose text
// layer was OCRed badly in 1979) cannot be repaired here and has to be visible instead of quietly
// stored. Every repair is gated on a dictionary lookup, so a word that is already a word is never
// touched, and names, jargon and foreign words fail the gate and survive unchanged.
//
// the two PDF imports (Simone Weil, Vaclav Havel) scored 0.030 and 0.011 with 51 and 0 soft
// hyphens respectively.

import { readFileSync } from 'node:fs';

const DICT_PATHS = ['/usr/share/dict/words', '/usr/dict/words'];

let dict = null;

/** The system word list as a Set, or null where there is none. Loaded once. */
export function dictionary() {
  if (dict !== null) return dict.size ? dict : null;
  dict = new Set();
  for (const path of DICT_PATHS) {
    try {
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        const word = line.trim().toLowerCase();
        if (word) dict.add(word);
      }
      break;
    } catch { /* try the next one */ }
  }
  return dict.size ? dict : null;
}

const BASE = () => dictionary();

/** Dictionary membership with the inflections a 1934 word list leaves out. */
export function known(word) {
  const words = BASE();
  if (!words) return true;                       // no dictionary: judge nothing
  const w = String(word || '').toLowerCase().replace(/^[^a-z]+|[^a-z]+$/gu, '');
  if (!w || w.length < 3) return true;
  if (words.has(w)) return true;
  const stems = [];
  for (const [suffix, tail] of [
    ["'s", ''], ['s', ''], ['es', ''], ['ed', ''], ['ed', 'e'], ['d', ''], ['ing', ''], ['ing', 'e'],
    ['ly', ''], ['er', ''], ['er', 'e'], ['est', ''], ['ies', 'y'], ['ied', 'y'], ['s', 'e']
  ]) {
    if (w.endsWith(suffix) && w.length - suffix.length > 2) stems.push(w.slice(0, w.length - suffix.length) + tail);
  }
  if (w.length > 5 && /(.)\1$/u.test(w)) stems.push(w.slice(0, -1));   // doubled consonant: "begged"
  return stems.some((s) => words.has(s));
}

/* ----------------------------------------------------------------- repair */

const LIGATURES = [[/\uFB00/gu, 'ff'], [/\uFB01/gu, 'fi'], [/\uFB02/gu, 'fl'], [/\uFB03/gu, 'ffi'], [/\uFB04/gu, 'ffl'], [/\uFB05|\uFB06/gu, 'st']];

// Scanner substitutions seen in book-era OCR, applied only when the result is a word and the
// original is not. "rt" and "rm" read as "n" ("hean", "Nevenheless", "effon"); "ri" as "n";
// "l" as "1"; "g" as "y" ("yod" for "God" when the capital is lost).
const SWAPS = [
  [/n/gu, 'rt'], [/n/gu, 'rm'], [/n/gu, 'ri'], [/rn/gu, 'm'], [/m/gu, 'rn'], [/1/gu, 'l'], [/0/gu, 'o']
];

function applySwap(word, [pattern, replacement]) {
  const out = new Set();
  const text = word;
  let match;
  const re = new RegExp(pattern.source, 'gu');
  while ((match = re.exec(text))) {
    out.add(text.slice(0, match.index) + replacement + text.slice(match.index + match[0].length));
    if (match.index === re.lastIndex) re.lastIndex += 1;
  }
  return [...out];
}

/**
 * The dictionary word a mis-OCRed token resolves to, or null when it is not unambiguous.
 * `context` is a word count of the rest of the document: the 1934 system word list contains
 * "efform" as well as "effort", and the document itself is the tiebreaker, because the word the
 * author used elsewhere is the word the scanner mangled here.
 */
export function ocrCandidate(word, context = null) {
  if (!BASE()) return null;
  const core = String(word || '');
  if (core.length < 4 || !/^[a-zA-Z][a-zA-Z]+$/u.test(core) || known(core)) return null;
  const lower = core.toLowerCase();
  const hits = new Set();
  for (const swap of SWAPS) {
    for (const candidate of applySwap(lower, swap)) {
      if (candidate !== lower && known(candidate) && BASE().has(candidate)) hits.add(candidate);
    }
  }
  if (hits.size === 0) return null;
  if (!context) return null;
  const ranked = [...hits].map((h) => [h, context.get(h) || 0]).sort((a, b) => b[1] - a[1]);
  // The fix has to be a word this document actually uses: "effort" appears sixteen times in the
  // Weil essay and "effon" five, "heart" once and "hean" twice, so both are scanner damage, while
  // "begari" and "Polarid" (what a dictionary vote proposed for "began" and "Poland" on the Havel
  // import) appear nowhere and are refused. Frequency cannot be the test, since the damaged form
  // can outnumber the good one; presence can.
  if (ranked[0][1] < 1) return null;
  if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) return null;
  const fixed = ranked[0][0];
  // Keep the original capitalisation shape.
  if (core === core.toUpperCase()) return fixed.toUpperCase();
  if (core[0] === core[0].toUpperCase()) return fixed[0].toUpperCase() + fixed.slice(1);
  return fixed;
}

function joinBrokenWords(text) {
  // soft hyphen, with or without the line break that followed it
  let out = text.replace(/\u00AD[ \t]*\r?\n?[ \t]*/gu, '');

  // Everything else is a decision about one pair of adjacent letter runs, so walk the tokens
  // rather than running regex replacements: a regex consumes the pair it examined, and the pair
  // after it ("he acqu" then "acqu ires") would never be looked at.
  const parts = out.split(/([A-Za-z]+)/u);        // odd indexes are the words
  for (let i = 1; i < parts.length - 2; i += 2) {
    const a = parts[i];
    const gap = parts[i + 1];
    const b = parts[i + 2];
    if (!a || !b) continue;
    if (!/^-?[ \t]*\n?[ \t]*\n?[ \t]*$/u.test(gap)) continue;   // a space, one or two line breaks, or a hyphenated break
    if (gap === '') continue;                                      // adjacent runs, nothing to join
    const hyphenated = gap.startsWith('-');
    const breaks = (gap.match(/\n/gu) || []).length;
    const broke = breaks > 0;
    // Two line breaks is a paragraph boundary, which only a word plainly cut in half crosses:
    // that is what a dropped page number or running head leaves between the halves.
    // ("at" is a word, "tention" is not, "attention" is: that pair is a cut word, not two words.)
    if (breaks > 1 && !(known(a + b) && !known(b) && !/[.,;:!?"\u2019)]$/u.test(parts[i - 1] || ''))) continue;
    if (!hyphenated && !broke && gap !== ' ') continue;
    if (b !== b.toLowerCase()) continue;                       // a capital starts a new word
    if (hyphenated) {
      // A hyphen at a line end is either a broken word ("realiza-/tion") or a real compound
      // ("three-/quarters"). Join only when the joined form is a word; otherwise keep the hyphen
      // and lose the line break, which is what the compound wanted anyway.
      parts[i] = '';
      parts[i + 1] = broke ? '\n'.repeat(breaks) : '';
      parts[i + 2] = known(a + b) ? a + b : `${a}-${b}`;
      continue;
    }
    if (!(!known(a) && known(a + b) && (b.length <= 4 || !known(b)))) continue;
    parts[i] = '';
    parts[i + 1] = broke ? '\n'.repeat(breaks) : '';
    parts[i + 2] = a + b;
  }
  return parts.join('');
}

function stripPageFurniture(text) {
  const lines = text.split('\n');
  const counts = new Map();
  for (const line of lines) {
    const key = line.trim().replace(/\s+/gu, ' ');
    if (!key || key.split(' ').length > 8) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const heads = new Set();
  for (const [key, n] of counts) {
    const letters = key.replace(/[^A-Za-z]/gu, '');
    const shouty = letters.length > 2 && letters === letters.toUpperCase();
    // A line that is only a roman numeral is a section number, which the reader turns into a
    // chapter; dropping it as a repeated running head cost the Havel essay 6 of its 21 sections.
    if (/^[IVXLC]{1,6}\.?$/u.test(key)) continue;
    if (n >= 3 && (shouty || /^\d+$/u.test(key))) heads.add(key);
  }
  return lines
    .filter((line) => {
      const key = line.trim().replace(/\s+/gu, ' ');
      if (!key) return true;
      if (heads.has(key)) return false;
      if (/^\d{1,4}$/u.test(key)) return false;                 // a bare page number
      if (/^\d{1,3} ?\d{1,3}$/u.test(key)) return false;        // "10 6", a split page number
      // a page number the scanner read as letters: "ws" for 105, alone on its line
      if (/^[IVXLC]{1,6}\.?$/u.test(key)) return true;          // a roman section number, not a page number
      // `known` waves through anything under three letters, so ask the word list directly here.
      if (/^[A-Za-z0-9]{1,3}$/u.test(key) && !['I', 'A', 'a', 'O'].includes(key)
        && !(BASE()?.has(key.toLowerCase()) ?? true)) return false;
      return true;
    })
    .join('\n');
}

/**
 * Mechanical repairs, safe to run on any extracted text.
 * Returns the repaired text and what was changed.
 */
export function repairText(raw, { ocr = true } = {}) {
  const before = String(raw || '');
  const changes = { unwelded: 0, softHyphens: (before.match(/\u00AD/gu) || []).length, joined: 0, dropped: 0, ocrFixed: 0, examples: [] };

  let text = before.replace(/\r\n?/gu, '\n').replace(/\u00A0/gu, ' ');
  for (const [pattern, replacement] of LIGATURES) text = text.replace(pattern, replacement);

  // Furniture first: a page number or a running head sitting between the two halves of a word
  // broken across the page break is what stops the halves being rejoined.
  // Dropping a running head and a page number leaves three or four blank lines where a word was
  // cut in half; collapse them now, or the two halves are too far apart to be rejoined below.
  const strippedText = stripPageFurniture(text).replace(/\n{3,}/gu, '\n\n');
  changes.dropped = text.split('\n').length - strippedText.split('\n').length;
  text = strippedText;

  const unwelded = unweld(text);
  changes.unwelded = unwelded.count;
  text = unwelded.text;

  const joinedText = joinBrokenWords(text);
  changes.joined = countTokens(text) - countTokens(joinedText);
  text = joinedText;

  if (ocr) {
    const context = new Map();
    for (const token of text.match(/[A-Za-z]{3,}/gu) || []) {
      const w = token.toLowerCase();
      context.set(w, (context.get(w) || 0) + 1);
    }
    text = text.replace(/[A-Za-z]{4,}/gu, (word) => {
      const fixed = ocrCandidate(word, context);
      if (!fixed) return word;
      changes.ocrFixed += 1;
      if (changes.examples.length < 20) changes.examples.push(`${word} -> ${fixed}`);
      return fixed;
    });
  }

  // Page-break form feeds become paragraph breaks, and the space a page extractor leaves before
  // punctuation ("the falsity .") goes.
  text = text.replace(/\f/gu, '\n\n');
  if (ocr) text = text.replace(/([A-Za-z\u2019'"\)])[ \t]+([.,;:!?])(?=\s|$)/gu, '$1$2');
  text = text.replace(/[ \t]+\n/gu, '\n').replace(/\n{3,}/gu, '\n\n');
  return { text, changes };
}

function countTokens(text) {
  return (text.match(/[A-Za-z]+/gu) || []).length;
}


/* ------------------------------------------------------- welded words */

// `pdftotext -layout` drops the spaces on some lines, so a whole clause arrives as one token
// ("cannolongerbaseitself"). Segmentation is a dictionary decision and is only accepted when the
// whole token splits into words, longest-first, with nothing left over.
const SEG_CACHE = new Map();

export function segmentWord(token) {
  const words = BASE();
  if (!words) return null;
  const lower = String(token || '').toLowerCase();
  if (lower.length < 12 || !/^[a-z]+$/u.test(lower) || known(lower)) return null;
  if (SEG_CACHE.has(lower)) return SEG_CACHE.get(lower);
  const n = lower.length;
  const best = new Array(n + 1).fill(null);
  best[0] = { pieces: [], cost: 0 };
  for (let i = 1; i <= n; i += 1) {
    for (let j = Math.max(0, i - 18); j < i; j += 1) {
      if (!best[j]) continue;
      const piece = lower.slice(j, i);
      if (piece.length < 2 && piece !== 'a' && piece !== 'i') continue;
      if (!words.has(piece)) continue;
      // Prefer few, long pieces: the cost of a piece falls with its length.
      const cost = best[j].cost + 1 / piece.length;
      if (!best[i] || cost < best[i].cost) best[i] = { pieces: [...best[j].pieces, piece], cost };
    }
  }
  const out = best[n] && best[n].pieces.length > 1 && best[n].pieces.length <= Math.ceil(n / 2.5)
    ? best[n].pieces
    : null;
  SEG_CACHE.set(lower, out);
  return out;
}

/** Restore the spaces, keeping the original letters and their case. */
function unweld(text) {
  let count = 0;
  const out = text.replace(/[A-Za-z]{12,}/gu, (token) => {
    const pieces = segmentWord(token);
    if (!pieces) return token;
    count += pieces.length - 1;
    let at = 0;
    return pieces.map((piece) => { const slice = token.slice(at, at + piece.length); at += piece.length; return slice; }).join(' ');
  });
  return { text: out, count };
}

/* ------------------------------------------------------------------ score */

/**
 * How mangled a body of text is. `unknownRatio` is over lower-case words of four letters or more,
 * `fragmentRate` counts adjacent token pairs that are not words apart and are a word together,
 * which is what a page-break hyphenation leaves behind.
 */
export function scoreText(raw) {
  const text = String(raw || '');
  const tokens = (text.match(/[A-Za-z][A-Za-z'\u2019]*/gu) || []);
  const judged = tokens.filter((w) => w.length >= 4 && w === w.toLowerCase());
  const unknown = judged.filter((w) => !known(w));
  const samples = [...new Set(unknown)].slice(0, 20);

  let fragments = 0;
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const a = tokens[i];
    const b = tokens[i + 1];
    if (a.length >= 2 && b.length >= 2 && !known(a) && !known(b) && known(a + b)) fragments += 1;
  }

  const softHyphens = (text.match(/\u00AD/gu) || []).length;
  const words = tokens.length;
  const unknownRatio = judged.length ? unknown.length / judged.length : 0;
  const fragmentRate = words ? fragments / words : 0;

  const reasons = [];
  if (softHyphens > 5) reasons.push(`${softHyphens} soft hyphens left in the text`);
  if (fragmentRate > 0.004) reasons.push(`${(fragmentRate * 1000).toFixed(1)} broken words per 1000`);
  if (unknownRatio > 0.06) reasons.push(`${(unknownRatio * 100).toFixed(1)}% of words are not words`);
  const verdict = reasons.length === 0 ? 'ok'
    : (unknownRatio > 0.09 || fragmentRate > 0.012 || softHyphens > 40) ? 'mangled' : 'suspect';

  return { words, unknownRatio: round(unknownRatio), fragmentRate: round(fragmentRate), softHyphens, fragments, verdict, reasons, samples };
}

const round = (n) => Math.round(n * 10000) / 10000;

/**
 * The one call the ingest paths make: repair, score, and say whether it is fit to store.
 * `ocr` off for text that came from HTML, where letter swaps are not the failure mode.
 */
export function cleanForReader(raw, { ocr = false } = {}) {
  const { text, changes } = repairText(raw, { ocr });
  const quality = scoreText(text);
  return { text, changes, quality };
}

/* --------------------------------------------------------------- layout */

/** Paragraphs out of `pdftotext -layout` output. The layout mode keeps the typesetter's indent, so
 * a line starting two or more columns in is a new paragraph and everything else is a continuation.
 * Internal runs of spaces, which layout mode uses to hold the column, collapse to one.
 */
export function paragraphsFromLayout(raw) {
  const out = [];
  let open = false;
  for (const line of String(raw || '').replace(/\r/gu, '').split('\n')) {
    if (!line.trim()) { open = false; out.push(''); continue; }
    const indented = /^\s{2,}\S/u.test(line);
    const body = line.replace(/^\s+/u, '').replace(/[ \t]{2,}/gu, ' ').replace(/\s+$/u, '');
    if (indented && open) out.push('');
    out.push(body);
    open = true;
  }
  return out.join('\n').replace(/\n{3,}/gu, '\n\n').trim();
}
