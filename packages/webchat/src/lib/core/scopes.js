// Scopes: every chat is bound to exactly one scope, and a scope decides who can read it.
//
// Pure rules, shared by the server (access, moves, the router) and the browser (the dropdown, the
// confirm screen, which scope a new chat or a fork is created in). Nothing here touches storage.
//
// A scope id is `personal:<account>` for one account's own scope, or the id of a group scope
// (`friends`: every employee; `personal`: the founders). `legacy` is the single scope a deployment has
// while scopes are switched off, so a chat always has a scope to name and nothing needs a null case.

export const LEGACY_SCOPE = 'legacy';
export const PERSONAL_PREFIX = 'personal:';

// How open a scope is: more people can read what is in it. A move toward a higher number widens
// who can see the chat and needs the owner's confirmation when he does it by hand; a move toward
// a lower number narrows it. Group scopes the registry does not rank sit between personal and the
// widest known scope, so an unknown group is never treated as private.
const RANK = Object.freeze({ [LEGACY_SCOPE]: 0, personal: 1, friends: 2 });
const UNKNOWN_GROUP_RANK = 1;

export const personalScopeOf = (account) => `${PERSONAL_PREFIX}${account}`;

export function isPersonalScope(scope) {
  return typeof scope === 'string' && scope.startsWith(PERSONAL_PREFIX) && scope.length > PERSONAL_PREFIX.length;
}

export const accountOfPersonal = (scope) => (isPersonalScope(scope) ? scope.slice(PERSONAL_PREFIX.length) : null);

export function scopeKind(scope) {
  if (scope === LEGACY_SCOPE) return 'legacy';
  return isPersonalScope(scope) ? 'personal' : 'group';
}

/** The openness of a scope; `listed` is the registry's own entry for it when it states one. */
export function opennessOf(scope, listed = null) {
  if (Number.isFinite(listed?.openness)) return listed.openness;
  if (isPersonalScope(scope)) return 0;
  return RANK[scope] ?? UNKNOWN_GROUP_RANK;
}

/** Whether moving a chat from `from` to `to` lets more people read it. */
export function isWidening(from, to, scopes = []) {
  const find = (id) => scopes.find((entry) => entry?.id === id) || null;
  return opennessOf(to, find(to)) > opennessOf(from, find(from));
}

/** A conversation's scope, with the default for a row that has none yet. */
export function scopeOfConversation(conversation, fallback = LEGACY_SCOPE) {
  return conversation?.scope || fallback;
}

export function scopeLabel(scope, listed = null) {
  if (listed?.label) return listed.label;
  if (isPersonalScope(scope)) return 'personal';
  return scope === LEGACY_SCOPE ? 'this deployment' : String(scope || '');
}

/** The sentence the confirm screen shows before a chat is opened to more people. */
export function wideningWarning({ from, to, scopes = [] }) {
  const named = (id) => scopeLabel(id, scopes.find((entry) => entry?.id === id));
  return `Move this chat from ${named(from)} to ${named(to)}? The whole history moves with it, and everyone in ${named(to)} will be able to read it.`;
}

// -- the move: one operation whether the owner picks it or the router does ------------------------

export const MOVE_ACTORS = Object.freeze(['owner', 'router']);

/** The steps a move runs, in order. The log records each as it completes, so a half-finished move is readable. */
export const MOVE_STEPS = Object.freeze(['authorize', 'snapshot', 'copy', 'verify', 'delete-source', 'revoke-shares', 'derived-memory', 'log']);

// -- the router's rules prompt ---------------------------------------------------------------------

/** What an account's routing rules say until it writes its own. Plain text, edited from the scope settings. */
export const DEFAULT_SCOPE_RULES = [
  'Pick the scope this chat belongs in from the first message.',
  'When unsure, choose the more private scope: your personal scope.',
  'Send a chat to friends only when it is clearly organisation engineering work: the product, its code, its infrastructure, the building, suppliers or customers that the whole team works on.',
  'Anything about one person (health, money, family, private accounts, personal plans) stays personal.',
  'Choose personal only for founder-level matters, and only when the account may use it.'
].join('\n');

export const MAX_RULES_CHARS = 4000;

export function normalizeRules(text) {
  const value = String(text ?? '').replace(/\r\n/gu, '\n').trim();
  return value.slice(0, MAX_RULES_CHARS);
}
