// The scope router: after a chat's first message, a cheap model reads the message against the
// account's own sending rules and says which scope the chat belongs in.
//
// It does what the dropdown does: the chosen scope goes through scopes.move, so the history moves,
// the move is logged (actor "router"), and the dropdown shows the new value. It may choose any
// scope the account can open, wider or narrower, and never one it cannot: the answer is checked
// against the account's own list before anything moves. The owner can always move the chat back.
//
// Behind its own flag (scopes.router.enabled / WEBCHAT_SCOPE_ROUTER=1), default off. No model is
// called and nothing moves with it off.

import { readSecret } from './auth.js';
import { ScopeError } from './scopes.js';

const ENDPOINT = process.env.WEBCHAT_SCOPE_ROUTER_ENDPOINT || '' + (process.env.TOPHAT_FAST_MODEL_ENDPOINT || '');
const MODEL = process.env.WEBCHAT_SCOPE_ROUTER_MODEL || 'gpt-oss-120b';

export const ROUTER_SYSTEM = `You file a new chat into one of the scopes its author may use.
You are given the author's own sending rules, the scopes available, and the chat's first message.
Reply with ONLY a JSON object: {"scope": "<one id from the list>", "reason": "<a short clause>"}.
Choose only an id from the list. Follow the rules; where they do not decide it, keep the chat in its current scope.`;

/** The prompt the model sees. */
export function routerPrompt({ rules, scopes, current, firstMessage }) {
  const list = scopes.map((s) => `- ${s.id}: ${s.label || s.id}${s.id === current ? ' (current)' : ''}`).join('\n');
  return `Sending rules:\n${rules}\n\nScopes available:\n${list}\n\nFirst message:\n${String(firstMessage).slice(0, 4000)}`;
}

/** The scope the model named, if it is one the account may use; otherwise null. Exported for tests. */
export function parseChoice(text, scopes) {
  const raw = String(text || '');
  const match = raw.match(/\{[\s\S]*\}/u);
  let id = null;
  let reason = '';
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      id = typeof parsed.scope === 'string' ? parsed.scope.trim() : null;
      reason = typeof parsed.reason === 'string' ? parsed.reason.slice(0, 200) : '';
    } catch { /* fall through to a bare id */ }
  }
  if (!id) id = raw.trim().replace(/^["'`]+|["'`.]+$/gu, '');
  const allowed = scopes.find((s) => s.id === id);
  return allowed ? { scope: allowed.id, reason } : null;
}

/** The default cheap-model call; `complete({ system, user })` returns the reply text, or null. */
export async function cheapComplete({ system, user }, { fetchImpl = fetch, apiKey = readSecret('fast-model-api-key', 'TOPHAT_FAST_MODEL_API_KEY') } = {}) {
  if (!apiKey) return null;
  const response = await fetchImpl(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: MODEL, max_completion_tokens: 600, temperature: 0,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
    })
  });
  if (!response.ok) return null;
  const body = await response.json();
  return String(body.choices?.[0]?.message?.content || '');
}

/**
 * Which scope should this first message go to? Returns { scope, reason } or null (no change). The
 * scopes offered are the account's own, so a denied scope cannot be chosen; the current scope is a
 * null, because that is no move.
 */
export async function proposeScope({ firstMessage, scopes, current, rules, complete = cheapComplete }) {
  if (!String(firstMessage || '').trim() || !scopes?.length) return null;
  let reply = null;
  try { reply = await complete({ system: ROUTER_SYSTEM, user: routerPrompt({ rules, scopes, current, firstMessage }) }); }
  catch { return null; }
  const choice = parseChoice(reply, scopes);
  if (!choice || choice.scope === current) return null;
  return choice;
}

/**
 * After the first message: ask, and move through the same operation the dropdown uses. Skips a chat
 * the owner already placed by hand, and any chat once it has more than its first turn. Never throws;
 * a failed route leaves the chat where it is.
 */
export async function routeFirstMessage({ service, identity, conversationId, text, store, complete, log = console.warn }) {
  if (!service.enabled || !service.config.router?.enabled) return { routed: false, why: 'off' };
  try {
    const created = store.conversationEvents(conversationId, { limit: 1 })[0];
    if (created?.content?.scopeChosen || store.scopeMoves(conversationId).some((m) => m.actor === 'owner')) return { routed: false, why: 'owner-placed' };
    const ctx = service.contextFor(identity);
    if (!ctx?.account) return { routed: false, why: 'no-account' };
    const conversation = store.conversation(conversationId);
    if (!conversation) return { routed: false, why: 'no-chat' };
    const current = service.scopeOf(conversation);
    const choice = await proposeScope({
      firstMessage: text, scopes: ctx.scopes, current, rules: service.rulesFor(identity).prompt, ...(complete ? { complete } : {})
    });
    if (!choice) return { routed: false, why: 'no-change' };
    const result = await service.move({ identity, conversationId, to: choice.scope, actor: 'router', reason: choice.reason || null });
    return { routed: Boolean(result.moved), ...result };
  } catch (cause) {
    if (!(cause instanceof ScopeError)) log(`[scopes] router failed for ${conversationId}: ${cause?.message || cause}`);
    return { routed: false, why: 'error', error: String(cause?.message || cause) };
  }
}
