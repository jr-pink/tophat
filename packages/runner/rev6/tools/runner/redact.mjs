// The secret-redaction rule has ONE owner: src/agent/redact.mjs.
//
// Nothing anywhere said that copy was deliberate, unlike
// webchat/src/lib/server/kill-tree.mjs, whose twin names it in a header.
//
// The owner's own header is the argument against keeping it. its card branch lost
// the grouping guard while its comment still promised one, so it redacted the
// owner's own measurement tables, which is data loss rather than privacy. A privacy
// rule with three implementations drifts, and the half that loosens is the half
// nobody notices.
//
// The module path and every name this file exported are unchanged, so no caller
// changes: the rev6 runner still imports `redactSecrets` from here and now gets
// the one implementation. `redactWith` is carried through as well, so a caller
// that wants a different paste surface can have one without a fourth copy.
//
// tests/redact-one-owner.test.mjs pins the three importers to one function.
export { CARD_CANDIDATE, KEY_PATTERNS, cardGrouping, luhn, redactSecrets, redactWith } from '../../../src/agent/redact.mjs';
