// Cutting a string is cutting UTF-16, and UTF-16 is not characters.
//
// THIS MODULE IS THE OWNER OF THE RULE. rev5/unicode.mjs and rev6/base/text.mjs
// re-export it and neither carries a second copy; tests/unicode-one-owner.test.mjs
// pins the three to one function each. It lives in src/core rather than in
// either runner tree because rev5 is the documented rollback and must not
// depend on rev6, while rev6 supersedes rev5 and must not depend on it; src is
// the one tree both already import (rev5/context.mjs takes four modules from
// src/core, rev5/tasks.mjs takes src/vault/scrub-store.mjs, rev6/pull/bridge.mjs
// takes src/vault/trace-write.mjs, rev6/tools/runner/redact.mjs takes
// src/agent/redact.mjs).
//
// Why the rule exists. Every budget in the runner (tool results at 30000, retrieval
// at 8000, a mail body at 20000, a page at 20000, a ledger tool record at 1500)
// ends in String.prototype.slice, which counts code units. A character outside the
// Basic Multilingual Plane -- an emoji, a rarer CJK ideograph, a musical symbol --
// is two of them, so a budget landing between the halves keeps one lone surrogate.
// JavaScript carries it happily; JSON.stringify escapes it as \ud83d, which is
// legal ECMAScript JSON and illegal to a strict parser, and the Anthropic API
// answers the whole request with 400 invalid_request_error: "The request body is
// not valid JSON: no low surrogate in string". The half character is by then in the
// conversation ledger, so every retry and every fallback model re-sends it and the
// turn dies on a smiley.
//
// Two defences, because either alone is thin: cut/cutEnd keep whole characters at
// the sources, and toWireJSON guarantees a body with no lone surrogate in it
// whatever upstream did, including data that arrived already broken (a database
// column, a Python \udXXX, a truncating third party).
//
// Never: slice a string for a budget with String.prototype.slice directly.

const HIGH_START = 0xd800, HIGH_END = 0xdbff, LOW_START = 0xdc00, LOW_END = 0xdfff;

const isHigh = (code) => code >= HIGH_START && code <= HIGH_END;
const isLow = (code) => code >= LOW_START && code <= LOW_END;

/** A lone surrogate: a high one with no low after it, or a low one with no high before it. */
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const LONE_ALL = new RegExp(LONE.source, 'g');

/** Does this string hold half a character? */
export function hasLoneSurrogate(text) {
  return typeof text === 'string' && LONE.test(text);
}

export function repairLoneSurrogates(text) {
  const s = String(text ?? '');
  return LONE.test(s) ? s.replace(LONE_ALL, '\ufffd') : s;
}

const budget = (max) => Math.max(0, Math.floor(Number(max) || 0));

/**
 * The first `max` code units of `text`, never splitting a surrogate pair: if the budget would land
 * between the halves the pair is dropped, so the result is at most `max` units and always whole
 * characters. Callers that report how much they left should measure against `result.length`.
 */
export function cut(text, max) {
  const s = String(text ?? '');
  const n = budget(max);
  if (n <= 0) return '';
  if (s.length <= n) return s;
  const end = isHigh(s.charCodeAt(n - 1)) && isLow(s.charCodeAt(n)) ? n - 1 : n;
  return s.slice(0, end);
}

/** `cut` from the other end: the last `max` code units, never starting on the low half of a pair. */
export function cutEnd(text, max) {
  const s = String(text ?? '');
  const n = budget(max);
  if (n <= 0) return '';
  if (s.length <= n) return s;
  const from = s.length - n;
  return s.slice(isLow(s.charCodeAt(from)) && isHigh(s.charCodeAt(from - 1)) ? from + 1 : from);
}

/** Every string in a structure repaired, keys included; used only when a key itself is broken. */
function repairDeep(value) {
  if (typeof value === 'string') return repairLoneSurrogates(value);
  if (Array.isArray(value)) return value.map(repairDeep);
  if (value && typeof value === 'object') {
    const out = {};
    // `out[key] = ...` is not assignment when the key is `__proto__`: it sets the clone's prototype
    // and the field disappears from the body, which is how a model-authored `{"__proto__": ...}` in
    // a tool input (JSON.parse makes it an own key; the runner echoes the call back) was dropped on
    // the wire while plain JSON.stringify kept it. defineProperty writes a field either way.
    for (const [key, v] of Object.entries(value)) {
      Object.defineProperty(out, repairLoneSurrogates(key), {
        value: repairDeep(v), writable: true, enumerable: true, configurable: true
      });
    }
    return out;
  }
  return value;
}

/**
 * `JSON.stringify` for something about to become request bytes: identical output, except that no
 * lone surrogate can survive into it. Values are repaired through the replacer, which costs one
 * pass and no copy of the body; a broken key (only ever model-authored JSON, in a tool call the
 * runner echoes back) is rare enough to pay for a repaired clone when one is seen.
 */
export function toWireJSON(value) {
  let brokenKey = false;
  const json = JSON.stringify(value, function replace(key, v) {
    if (!brokenKey && key && hasLoneSurrogate(key)) brokenKey = true;
    return typeof v === 'string' ? repairLoneSurrogates(v) : v;
  });
  if (!brokenKey || json === undefined) return json;
  // The repair for a broken key runs over `json` parsed back, not over the original value: that
  // pass has already dropped the keys JSON drops (`undefined`, a function, a symbol) and already
  // called every `toJSON`. Two distinct broken keys still collapse into one.
  return JSON.stringify(repairDeep(JSON.parse(json)));
}
