// Reading the conversation back out of the event store for a provider change.
// The pure rendering is in core/handoff.js; this is the part that knows what a
// stored event looks like.

import { handoffBlock } from '../core/handoff.js';

/** How far back a switch reads. These are prose events (a turn each), not raw events. */
const WINDOW = Number(process.env.WEBCHAT_HANDOFF_WINDOW || 2000);

function proseOf(store, conversationId, window) {
  // conversationProse() is the message.user / assistant.message rows in order; a
  // raw tail of the same size would be mostly deltas, tool cards and run status
  // and would carry two or three turns out of a long chat.
  if (typeof store.conversationProse === 'function') return store.conversationProse(conversationId, { limit: window });
  return (store.conversationEvents(conversationId, { newest: true, limit: window }) || [])
    .filter((event) => event.kind === 'message.user' || event.kind === 'assistant.message');
}

/**
 * The owner's messages and the assistant's answers in this conversation, oldest
 * first. Subagent chatter (`agentId`) is left out: it belongs to a child run,
 * not to the chat, and the new process cannot act on it.
 */
export function priorTurns(store, conversationId, { window = WINDOW } = {}) {
  const turns = [];
  for (const event of proseOf(store, conversationId, window)) {
    const content = event.content || {};
    if (content.agentId) continue;
    const text = String(content.text || '').trim();
    if (!text) continue;
    if (event.kind === 'message.user') turns.push({ role: 'user', text });
    else if (event.kind === 'assistant.message') turns.push({ role: 'assistant', text });
  }
  return turns;
}

/**
 * The block to put in front of the next message after a switch, or '' when
 * there is nothing to carry. Never throws: a chat that cannot be rendered is
 * still a chat the owner wants answered, so it degrades to no block rather
 * than to no answer.
 */
export function carriedTranscript(store, conversationId, { from = null, to = null, window = WINDOW } = {}) {
  try {
    return handoffBlock(priorTurns(store, conversationId, { window }), { from, to });
  } catch (cause) {
    console.error(`[webchat] could not carry the transcript of ${conversationId}: ${cause.message}`);
    return '';
  }
}
