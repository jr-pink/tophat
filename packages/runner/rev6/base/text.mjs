// Text budgets for rev6. The rule is a correctness rule on request bytes (a
// budget landing between the halves of an emoji produces a lone surrogate, which
// the model APIs answer with 400 invalid_request_error and which then sits in the
// ledger and kills every retry), so it gets one implementation.
// tests/unicode-one-owner.test.mjs pins the three modules to one function each.
//
// What stays here is rev6's own shaping on top of it: clip (a tool-result cut
// that says how much it left), truncate (a cut that ends in an ellipsis) and
// oneLine.
//
// Never: slice a string for a budget with String.prototype.slice directly.
import { cut, cutEnd, hasLoneSurrogate, repairLoneSurrogates, toWireJSON } from '../../src/core/unicode.mjs';

export { cut, cutEnd, hasLoneSurrogate, repairLoneSurrogates, toWireJSON };

const budget = (max) => Math.max(0, Math.floor(Number(max) || 0));

/** A tool-result cut: whole characters, then a note saying how much was left out. */
export function clip(text, max = 30000) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  const kept = cut(s, max);
  return `${kept}\n[... ${s.length - kept.length} more characters not shown]`;
}

/** At most `max` code units in all, ending in `ellipsis` when anything was cut. */
export function truncate(text, max, ellipsis = '\u2026') {
  const s = String(text ?? '');
  const n = budget(max);
  if (s.length <= n) return s;
  if (n <= ellipsis.length) return cut(ellipsis, n);
  return cut(s, n - ellipsis.length) + ellipsis;
}

/** Whitespace runs collapsed to one space, trimmed. */
export const oneLine = (text) => String(text ?? '').replace(/\s+/gu, ' ').trim();
