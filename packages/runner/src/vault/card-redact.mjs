// Formatted-number redaction, the part of the secret net that exact matching
// misses. The exact matcher (secret-index.mjs, rev6/base/redact.mjs) looked for the
// stored digit run and found none, because the page had put spaces in it.
//
// So, beside the exact forms:
// - any indexed value that is mostly digits (>= 12 digits) also matches as its
//   digit sequence with up to three separators (space, dash, dot, slash,
//   underscore, a JSON-escaped newline) between digits;
// - a card entry (a JSON secret with a number leaf, plus exp/cvc leaves) also
//   scrubs its expiry ("MM/YY", "MM / YY", "MM-YYYY") and its CVC, but only
//   where they cannot be ordinary numbers: in a text that also carried the card
//   number (in any form), or right after an expiry / CVC label.
// Nothing here prints, logs or returns a value; callers get text and vault ids.

const SEP = String.raw`(?:[\s\-./_]|\\[nrt]){0,3}`;
const MIN_DIGITS = 12;

/** A value that is a number in disguise: >= 12 digits, and digits are >= 80% of its non-space characters. */
export function mostlyDigits(value) {
  const text = String(value ?? '');
  const digits = text.replace(/\D/g, '');
  const dense = text.replace(/\s/g, '');
  return digits.length >= MIN_DIGITS && digits.length / Math.max(1, dense.length) >= 0.8;
}

/** A regex (global) matching `digits` with separators allowed between any two digits, never inside a longer digit run. */
export function digitPattern(digits) {
  return new RegExp(String.raw`(?<!\d)` + digits.split('').join(SEP) + String.raw`(?!\d)`, 'g');
}

function parseExp(text) {
  const m = /^\s*(\d{1,2})\s*[/\-.]\s*(\d{2}|\d{4})\s*$/.exec(String(text ?? ''));
  if (!m) return null;
  const mm = Number(m[1]);
  if (mm < 1 || mm > 12) return null;
  return { mm, yy: m[2].slice(-2) };
}

/** The card fields of one vault value, or null: {number, exp, cvc} as digit strings / {mm, yy}. Accepts the value or its JSON text. */
export function cardFields(value) {
  let parsed = value;
  if (typeof value === 'string') {
    const t = value.trim();
    if (!t.startsWith('{')) return null;
    try { parsed = JSON.parse(t); } catch { return null; }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  let number = null, exp = null, cvc = null;
  for (const [key, v] of Object.entries(parsed)) {
    if (typeof v !== 'string' && typeof v !== 'number') continue;
    const s = String(v);
    if (!number && /number|^pan$|card_?no/i.test(key) && mostlyDigits(s)) number = s.replace(/\D/g, '');
    else if (!exp && /^exp|expir|valid/i.test(key)) exp = parseExp(s);
    else if (!cvc && /cvc|cvv|cvn|cid|security/i.test(key) && /^\s*\d{3,4}\s*$/.test(s)) cvc = s.trim();
  }
  return number ? { number, exp, cvc } : null;
}

function expBody({ mm, yy }) {
  const month = mm < 10 ? `0?${mm}` : String(mm);
  return `${month}\\s*[/\\-.]\\s*(?:20)?${yy}`;
}

const EXP_LABEL = String.raw`(?:exp(?:iry|iration|ires)?(?:\s*date)?|mm\s*/\s*yy|valid\s*thr(?:u|ough))`;
const CVC_LABEL = String.raw`(?:cvc2?|cvv2?|cvn|cid|security\s*code|card\s*code)`;

/**
 * Compile the numeric matchers for an index. `numbers` is [[id, value]] of every indexed value;
 * `cards` is [[id, {number, exp, cvc}]]. Returns a redactor `(text) => {text, hits}` to run on the
 * ORIGINAL text before exact matching (exact matching would erase the card-number context).
 */
export function compileNumeric(numbers, cards) {
  const matchers = [];
  const seen = new Set();
  for (const [id, card] of cards) {
    if (!card?.number || seen.has(card.number)) continue;
    seen.add(card.number);
    const m = { id, number: digitPattern(card.number) };
    if (card.exp) {
      m.exp = new RegExp(String.raw`(?<![\d/])` + expBody(card.exp) + String.raw`(?![\d/])`, 'g');
      m.expLabeled = new RegExp(`(${EXP_LABEL}[^\\d\\n]{0,16})` + expBody(card.exp) + String.raw`(?![\d/])`, 'gi');
    }
    if (card.cvc) {
      m.cvc = new RegExp(String.raw`(?<!\d)${card.cvc}(?!\d)`, 'g');
      m.cvcLabeled = new RegExp(`(${CVC_LABEL}[^\\d\\n]{0,16})${card.cvc}(?!\\d)`, 'gi');
    }
    matchers.push(m);
  }
  for (const [id, value] of numbers) {
    if (!mostlyDigits(value)) continue;
    const digits = String(value).replace(/\D/g, '');
    if (seen.has(digits)) continue;
    seen.add(digits);
    matchers.push({ id, number: digitPattern(digits) });
  }
  matchers.sort((a, b) => b.number.source.length - a.number.source.length);

  return function redactNumeric(text) {
    if (typeof text !== 'string' || !text || !matchers.length || !/\d/.test(text)) return { text, hits: [] };
    let out = text;
    const hits = [];
    const hit = (id) => { if (!hits.includes(id)) hits.push(id); };
    for (const m of matchers) {
      m.number.lastIndex = 0;
      const inContext = m.number.test(out);
      if (inContext) { out = out.replace(m.number, `[redacted:${m.id}]`); hit(m.id); }
      // The card number in this text (any form, or already scrubbed upstream to its id) makes exp/cvc secret here.
      const context = inContext || out.includes(`[redacted:${m.id}]`);
      for (const [all, labeled, tag] of [[m.exp, m.expLabeled, 'exp'], [m.cvc, m.cvcLabeled, 'cvc']]) {
        if (!all) continue;
        if (context) {
          all.lastIndex = 0;
          if (all.test(out)) { out = out.replace(all, `[redacted:${m.id}:${tag}]`); hit(m.id); }
        } else {
          labeled.lastIndex = 0;
          if (labeled.test(out)) { out = out.replace(labeled, `$1[redacted:${m.id}:${tag}]`); hit(m.id); }
        }
      }
    }
    return { text: out, hits };
  };
}
