// Auto model gate: picks Opus or Sonnet for one message, no model call. Families and their newest versions are in
// model-family.js (client-safe); this file carries the verb table and stays server-side.

import { FAMILY_LATEST, familyOf } from './model-family.js';
export { FAMILY_LATEST, FAMILY_EFFORT, familyOf, latestOf } from './model-family.js';

export const ROUTE_OPUS = FAMILY_LATEST.opus;
export const ROUTE_SONNET = FAMILY_LATEST.sonnet;

// The gate classifies each clause by force, then by the semantic class of its head verb. The verb class comes
// from WordNet 3.0, not from a hand-written list: verb-classes.generated.js is built by
// scripts/gen-verb-classes.py from WordNet's verb supersenses (the lexicographer files), weighted by SemCor sense
// counts. communication + cognition + perception verbs ("tell", "show", "find", "read", "explain", "check") are
// INFO and stay on Sonnet; change + contact + creation + motion + possession + competition + consumption verbs
// ("build", "fix", "add", "send", "run") are ACT and go to Opus.
//
//   1. Clause force, from closed-class function words (a small, finite, stable set):
//        - interrogative: fronted wh-word ("what was", "who is", "how do i") or subject-auxiliary inversion
//          ("is it", "did he"); asks for information, whatever verb it mentions ("how do i fix X" is an ask);
//        - indirect directive: "can/could/would/will you V", "i need you to V", "you should V", "let's V",
//          "go ahead and V", "make sure to V"
//          verb after it decides;
//        - imperative: a clause whose first word is a bare (base-form) verb: "fix the header", "also add a test".
//          Base form comes free with the table, which holds lemmas only, so "failed" and "signed" are not in it.
//   2. Noun use is not a verb: a first word followed by an auxiliary or a verb ("build failed") is skipped.
//   3. WordNet predates and under-covers technical English, so SUPPLEMENT overrides it for the verbs it gets
//      wrong or lacks: search/query are inquiry (WordNet files them as contact), rename/refactor and the
//      re- forms are ACT. Each entry is a measured miss, nothing speculative.
// A message is ACT when any clause is.

import { ACT_VERBS, INFO_VERBS, NEUTRAL_VERBS } from './verb-classes.generated.js';

export const SUPPLEMENT = Object.freeze({
  // WordNet: contact / near-tie, but these are lookups.
  search: 'info', query: 'info', grep: 'info', google: 'info', lookup: 'info',
  // WordNet: communication (rename = to name again) or absent; in a tool context these change something.
  rename: 'act', rewrite: 'act', rerun: 'act', retry: 'act', refactor: 'act', rebase: 'act', lint: 'act', compile: 'act', redeploy: 'act', deploy: 'act', debug: 'act',
  commit: 'act', revert: 'act', rollback: 'act', restart: 'act', reboot: 'act', sync: 'act', scaffold: 'act', patch: 'act',
  // WordNet: change/possession senses of "get" and "give" dominate, but "get me X" / "give me X" asks for X.
  get: 'info', give: 'info', pull: 'act'
});

const FILLER = /^(?:(?:ok|okay|so|hey|hi|yo|um|uh|and|also|then|now|alright|actually|tophat|pls|plz|please|btw|oh)[,\s]+)+/;
const INTERROGATIVE = /^(?:what|who|whom|whose|when|where|which|why|how|is|are|was|were|am|do|does|did|has|have|had|isn't|aren't|wasn't|doesn't|didn't)\b/;
const MODAL_FRAME = /^(?:can|could|would|will|won't|wouldn't)\s+(?:you|u|ya)\s+(?:(?:please|pls|also|just|maybe)\s+)*([a-z'-]+)/;
const DESIRE_FRAME = /^(?:i\s+(?:need|want|'d like|would like|wanna)\s+you\s+to|you\s+(?:should|need to|have to|must|gotta)|let'?s|go ahead and|make sure (?:you |to )?|i'd like you to)\s+(?:(?:please|also|just)\s+)*([a-z'-]+)/;
const NOUN_CONTEXT = /^(?:is|was|are|were|has|have|had|failed|fails|broke|broken|keeps|looks|seems|should|will|would|can|could|did|does)$/;

/** 'act', 'info', 'neutral' or null (not a verb) for one base-form word. */
export function verbClass(word) {
  if (SUPPLEMENT[word]) return SUPPLEMENT[word];
  if (ACT_VERBS.has(word)) return 'act';
  if (INFO_VERBS.has(word)) return 'info';
  if (NEUTRAL_VERBS.has(word)) return 'neutral';
  // re- on a known verb ("redo", "rerun", "retry") keeps the verb's class
  if (word.startsWith('re') && word.length > 4) return verbClass(word.slice(2));
  return null;
}

/** 'act', 'info' or null for one clause. */
export function clauseForce(clause) {
  const s = clause.toLowerCase().replace(/^[\s"'`(]+/, '').replace(FILLER, '').trim();
  if (!s) return null;
  const frame = MODAL_FRAME.exec(s) || DESIRE_FRAME.exec(s);
  if (frame) { const c = verbClass(frame[1]); return c === 'info' ? 'info' : 'act'; }
  if (INTERROGATIVE.test(s)) return 'info';
  const [first, second] = s.split(/\s+/);
  const c = verbClass(first);
  if (c && c !== 'neutral' && !(second && NOUN_CONTEXT.test(second))) return c;
  return null;
}

export function routeModel(text) {
  const clauses = String(text || '').slice(0, 4000).split(/[.!?;,\n]+|\s+(?:and then|then|and)\s+/);
  const forces = clauses.map(clauseForce);
  if (forces.includes('act')) return { family: 'opus', model: FAMILY_LATEST.opus, reason: 'act-clause' };
  if (forces.includes('info')) return { family: 'sonnet', model: FAMILY_LATEST.sonnet, reason: 'info-clause' };
  return { family: 'sonnet', model: FAMILY_LATEST.sonnet, reason: 'default' };
}

// Prompt caches are per model, so a flip re-reads the whole context uncached. That upgrade happens only when the
// cache is cold anyway (idle past the 1-hour TTL) or the context is still small (few turns); a warm chat on Sonnet
// stays on Sonnet and he can pick Opus by hand.
export const WARM_MS = 55 * 60 * 1000; // cache TTL is 1h (rev5/model.mjs cacheTtl default), minus margin
export const SMALL_CONTEXT_TURNS = 3;

/** The settings patch for this message, or null when routing must leave the conversation alone.
 *  ctx: { idleMs, turns } of the conversation before this message. */
export function routePatch(settings = {}, text, ctx = {}) {
  if (settings.autoModel === false) return null;
  // Auto means auto wherever the gate has two models to choose between: the direct runner (full ids) and the claude
  // provider (the CLI's aliases, same families). Codex and kimi have no family gate, so they are left alone.
  const provider = settings.provider || 'direct';
  if (provider !== 'direct' && provider !== 'claude') return null;
  const claude = provider === 'claude';
  const family = claude && ['opus', 'sonnet', 'haiku'].includes(settings.model) ? settings.model : familyOf(settings.model);
  if (!family) return null;
  const target = claude
    ? (family === 'haiku' ? 'haiku' : routeModel(text).family)
    : (family === 'haiku' ? FAMILY_LATEST.haiku : routeModel(text).model);
  if (claude ? target === family : target === settings.model) return null;
  // Either direction costs the same cache miss, so either direction waits for a cold or small chat.
  if (family === 'sonnet' || family === 'opus') {
    const cold = Number(ctx.idleMs) > WARM_MS || Number(ctx.turns ?? 0) < SMALL_CONTEXT_TURNS;
    if (!cold) return null;
  }
  return { model: target };
}
