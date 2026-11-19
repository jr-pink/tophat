

import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { app, DEFAULT_CWD, pinnedDefaults } from './app.js';
import { route } from './route-message.js';
import { newId, normalizeSettings } from '../core/contract.js';
import { arrivalTitle, cleanTitle } from '../core/arrival-title.js';
import { withInboxRule } from '../../../../runner/rev6/base/inbox-rule.mjs';

export async function router() {
  if (process.env.WEBCHAT_ROUTER === 'stub') return stubRouter;
  if (process.env.WEBCHAT_ROUTER_MODULE) {
    const module = await import(pathToFileURL(process.env.WEBCHAT_ROUTER_MODULE).href);
    return module.completeJson;
  }
  // Safe fallback: preserve every message in a new conversation when no model router is configured.
  return async () => ({ data: { conversationId: null, reason: 'No model router configured' } });
}

export async function stubRouter({ prompt }) {
  const message = (prompt.match(/"""\n([\s\S]*?)\n"""/u) || [, ''])[1].toLowerCase();
  const words = new Set(message.split(/\W+/u).filter((w) => w.length > 4));
  for (const [, id, title] of prompt.matchAll(/- id: (\S+)\n  title: (.*)/gu)) {
    if (title.toLowerCase().split(/\W+/u).some((w) => w.length > 4 && words.has(w))) {
      return { data: { conversationId: id, reason: 'stub: title overlap' } };
    }
  }
  return { data: { conversationId: null, title: message.slice(0, 40), reason: 'stub: no overlap' } };
}

/** An explicitly named chat, by conversation id or by its runner session id (what chat-owned work
 * and the goal ledger carry). Null when neither matches: the caller must refuse, never fall back
 * to a new chat.
 */
export function resolveConversation(store, id) {
  if (!id) return null;
  return store.conversation(id)?.id || store.conversationBySession?.(id)?.id || null;
}

// `automated` is true for everything from outside the app (push wakes, projects-watch, goal retry timers, Discord and
// other /api/inbound callers) and false only for the owner's own fire-and-forget message (routes/api/ff).
export async function settle(ffId, { text, wire = null, context = null, cards = null, conversationId = null, title: given = null, automated = true } = {}) {
  const store = app.store;
  let title = null;
  // A chat an arrival opens is named "Who: what": the title the push plane sent, else one derived from
  // the wake text. It wins over the router's guess and over the text's first line.
  const arrival = cleanTitle(given) || arrivalTitle(text);
  let reason = 'replied in the chat it came from';

  if (conversationId) {
    const named = conversationId;
    conversationId = resolveConversation(store, named);
    if (!conversationId) throw new Error(`unknown conversation ${named}`);
  } else {
    const decision = await route(store, text, {
      recent: store.ffRecent(),
      context,
      completeJson: await router()
    });
    conversationId = decision.conversationId;
    title = decision.title;
    reason = decision.reason;
  }

  if (!conversationId || !store.conversation(conversationId)) {
    conversationId = newId();
    title = arrival || title || text.replace(/^\s*\[(?:Automated event|Relayed by Tophat)[^\]]*\]\s*/u, '').replace(/\s+/gu, ' ').trim().slice(0, 72);
    const at = new Date().toISOString();
    // A chat fire-and-forget opens is a new chat like any other, so it takes the
    // deployment's pinned default model rather than the bare built-in default.
    const settings = normalizeSettings(pinnedDefaults({}));
    store.ensureConversation(conversationId, { at, cwd: DEFAULT_CWD, settings, title });
    store.append(conversationId, 'conversation.created', { title, settings, cwd: DEFAULT_CWD, ...(arrival && title === arrival ? { titleSource: 'arrival' } : {}) }, { at });
  }

  
  
  
  // runner.send is the same path a typed message takes: into a live turn it is delivered as
  // steering (injected mid-turn), into an idle chat it starts a turn. This path carries only
  // events from outside the app (push wakes, Discord, relays); his own typing goes through
  // runner.send directly, so a parked chat he writes in stays his call.
  if (store.conversation(conversationId)?.aside) {
    store.append(conversationId, 'conversation.aside', { aside: false }, { at: new Date().toISOString() });
  }
  // An automated event leaves an archived chat archived; the turn it starts decides. Now the turn brings it back with
  // chat_archive archived=false only when the event needs the owner, and the rule saying so is appended to every automated
  // event here (rev6/base/inbox-rule.mjs), so no producer has to carry it. the owner's own fire-and-forget message still
  // brings its chat back and carries no rule. Set-aside above is his own rule and stays.
  if (!automated && store.conversation(conversationId)?.archived) {
    store.append(conversationId, 'conversation.archived', { archived: false }, { at: new Date().toISOString() });
  }
  const sent = app.runner.send(conversationId, automated ? withInboxRule(wire || text) : (wire || text), { display: text, ...(cards?.length ? { cards } : {}) }) || {};
  store.ffSettle(ffId, { state: 'sent', conversationId, title: title || store.conversation(conversationId)?.title, reason });
  return { conversationId, title, reason, injected: Boolean(sent.injected) };
}


export function settleSafely(ffId, options) {
  return settle(ffId, options).catch((cause) => {
    
    
    try {
      app.store.ffSettle(ffId, { state: 'failed', error: String(cause?.message ?? cause).slice(0, 300) });
    } catch (worse) {
      console.error(`[ff] could not record the failure of ${ffId}:`, worse, 'original:', cause);
    }
  });
}
