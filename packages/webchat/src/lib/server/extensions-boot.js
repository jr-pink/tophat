// The live dependencies of the extensions host (extensions.js): the chat store, the one action path, the inbound path
// /api/inbound uses, and speech recognition. Kept apart from extensions.js so that file stays testable without a server.
import { app, applyAction } from './app.js';
import { resolveConversation, settle, settleSafely } from './ff.js';
import { contextFor, extensionsHost, routeFor, startExtensions } from './extensions.js';

/** core.chat.inbound: the same steps as POST /api/inbound (idempotent by the intent id; a named chat is settled now). */
async function inbound({ text, wire = null, title = null, conversationId = null, context = null, actionId }) {
  const body = String(text || '').trim();
  if (!body) return { ok: false, code: 'EMPTY' };
  const seen = app.store.appliedAction(actionId);
  if (seen) return { ok: true, duplicate: true, id: seen.conversation_id };
  let target = null;
  if (conversationId) {
    target = resolveConversation(app.store, String(conversationId));
    if (!target) return { ok: false, code: 'unknown-conversation' };
  }
  const id = app.store.ffAccept(body);
  const cursor = app.store.cursor();
  app.store.markApplied({ actionId, conversationId: id, op: 'extension.inbound', cursorBefore: cursor, cursorAfter: cursor });
  const options = { text: body, wire: String(wire || '') || body, context, conversationId: target, title: typeof title === 'string' ? title : null };
  if (target) { const sent = await settle(id, options); return { ok: true, id, conversationId: sent.conversationId }; }
  settleSafely(id, options);
  return { ok: true, id };
}

async function transcribe({ bytes, mime = 'audio/mp4' }) {
  const { transcribe: run } = await import('$lib/services/voice/server/voice.js');
  // The kit's core surface answers {text}; the recognizer returns the text itself.
  const heard = await run(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []), { mime });
  return { text: typeof heard === 'string' ? heard : String(heard?.text ?? '') };
}

export function liveDeps(env = process.env) {
  return { store: app.store, applyAction, inbound, transcribe, secretsDir: env.TOPHAT_SECRETS_DIR || null, stateDir: env.TOPHAT_STATE_DIR || null };
}

/** The host, started on first use. */
export async function extensions() {
  return extensionsHost() ?? startExtensions({ deps: liveDeps() });
}

/** hooks.server.js: an extension route at this method and path, with the context its handler gets; null when none. */
export async function extensionRoute(method, pathname) {
  if (!process.env.TOPHAT_EXTENSIONS_FILE) return null;
  const host = await extensions();
  const hit = routeFor(host, method, pathname);
  return hit ? { auth: hit.route.auth, run: (event) => hit.route.handler(event, contextFor(host, hit.reg)) } : null;
}
