

import { rankConversations } from '../core/frecency.js';

const CANDIDATES = 10;
const FOLLOW_UPS = 6;

const DORMANT_HOURS = 48;
const DEAD_HOURS = 14 * 24;

export function ageHours(conversation, nowMs) {
  const then = Date.parse(conversation.activeAt || conversation.updatedAt || '');
  if (!Number.isFinite(then)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (nowMs - then) / 3_600_000);
}

export const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['conversationId', 'title', 'reason'],
  properties: {
    conversationId: { type: ['string', 'null'], description: 'id of the chat to send to, or null to start a new one' },
    title: { type: ['string', 'null'], description: 'short title when starting a new chat, otherwise null' },
    reason: { type: 'string', description: 'one clause on why' }
  }
};

export function candidates(store, text, { now = Date.now(), limit = CANDIDATES } = {}) {
  return pick(store, text, { now, limit }, (words) => store.search(words, { limit, mode: 'smart' }));
}

/** The same choice with the full-text search awaited on the store's worker thread (it is seconds of CPU on a big index). */
export async function candidatesAsync(store, text, { now = Date.now(), limit = CANDIDATES } = {}) {
  const words = String(text).split(/\s+/u).filter((w) => w.length > 3).slice(0, 8).join(' ');
  let hits = [];
  if (words) { try { hits = await (store.searchAsync ? store.searchAsync(words, { limit, mode: 'smart' }) : store.search(words, { limit, mode: 'smart' })); } catch {  } }
  return pick(store, text, { now, limit }, () => hits);
}

function pick(store, text, { now, limit }, search) {
  const all = store.conversations().filter((c) => ageHours(c, now) < DEAD_HOURS);
  const byId = new Map(all.map((c) => [c.id, c]));
  const frecent = rankConversations(Object.fromEntries(all.map((c) => [c.id, c])), { now }).slice(0, limit);
  const picked = new Map(frecent.map((c) => [c.id, c]));
  const words = String(text).split(/\s+/u).filter((w) => w.length > 3).slice(0, 8).join(' ');
  if (words) {
    try {
      for (const hit of search(words)) {
        const conversation = byId.get(hit.conversationId ?? hit.conversation_id);
        if (conversation && !picked.has(conversation.id)) picked.set(conversation.id, conversation);
      }
    } catch {  }
  }
  return [...picked.values()].slice(0, limit * 2);
}

export function render(conversation, nowMs) {
  const age = ageHours(conversation, nowMs);
  const said = age < 1 ? 'he wrote in it minutes ago'
    : age < DORMANT_HOURS ? `he last wrote in it ${Math.round(age)}h ago`
    : `DORMANT: he has not written in it for ${Math.round(age / 24)} days`;
  return `- id: ${conversation.id}\n  title: ${conversation.title}\n  ${said}\n  latest: ${String(conversation.preview || '').slice(0, 200)}`;
}

export async function route(store, text, { recent = [], context = null, completeJson, now = Date.now() } = {}) {
  
  
  
  
  const options = await candidatesAsync(store, [text, context?.text].filter(Boolean).join(' '), { now });
  if (!options.length) return { conversationId: null, title: null, reason: 'nothing to route to yet' };

  const history = recent.slice(-FOLLOW_UPS)
    .map((entry) => `- "${entry.text.slice(0, 160)}" went to ${entry.title || entry.conversationId}`)
    .join('\n');

  const prompt = `User sent this message from a page that shows him no replies. He is
half-asleep and will not check where it landed, so it has to reach the chat
that can act on it.

MESSAGE
"""
${String(text).slice(0, 2000)}
"""
${context?.text ? `\nHE SENT IT AS A REPLY TO THIS MESSAGE IN HIS DISCORD CHANNEL\n'''\n${String(context.text).slice(0, 1200)}\n'''\nHis reply may be meaningless on its own; route on what the quoted message is about.\n` : ''}${history ? `\nHIS LAST FEW MESSAGES AND WHERE THEY WENT\n${history}\n` : ''}
OPEN CHATS
${options.map((c) => render(c, now)).join('\n')}

Pick a chat only when this message is specifically part of that conversation:
it continues it, corrects it, answers the question it left open, or adds to the
thing that chat is actually doing. A fragment like "also ask about the deposit"
belongs to whatever it is adding to. Being about the same subject is not enough
on its own, and it is not enough at all for a chat marked DORMANT: never revive
a long-idle chat just because it is loosely related; attach only when the message
is specifically part of that conversation. Take a dormant chat only
when this message is unmistakably the next thing in that thread, and never
because it is the only place the topic has come up before.

Otherwise start a new chat, and give it a short title in his register,
lowercase. A new chat is cheap and he can see it on the page; reviving a dead
one buries what he said under a conversation that ended.

Reply with conversationId (an id from the list, or null for a new chat), title
(only when null), and reason.`;

  try {
    const { data } = await completeJson({ schema: SCHEMA, prompt, tier: 'small', maxTokens: 300 });
    const chosen = options.find((c) => c.id === data.conversationId);
    if (chosen) return { conversationId: chosen.id, title: chosen.title, reason: data.reason || '' };
    return { conversationId: null, title: (data.title || '').slice(0, 72) || null, reason: data.reason || '' };
  } catch (cause) {
    return { conversationId: null, title: null, reason: `router unavailable (${String(cause.message).slice(0, 80)})` };
  }
}
