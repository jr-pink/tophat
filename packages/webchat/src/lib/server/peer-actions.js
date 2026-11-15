// What a message.send / conversation.fork action carries when it comes from a member's home host rather than from his own browser.
//
// A chat that runs on a peer host is answered by that host's runner, and the home server speaks to it in the host's own actions. The
// browser's send fits the host's reducer except for four things only the home server knows, so they are fields of the same action rather
// than a second operation:
//   payload.wire     what the model reads when that differs: the seed transcript of what the host has not seen, the side-thread
//                    block, upload paths rewritten to the host's. Its presence means "the home host already prepared this message";
//                    the host skips prepareSend, model routing and the folder router, which ran at home and would run on the wrong
//                    chat state here
//   payload.writer   { scope: 'member', host }: who wrote it (rev6/base/writer-scope.mjs), kept on the stored event and out of memory
//   payload.title    the title of a chat the send creates (a send to an unknown conversation creates it, as in a browser)
// A conversation.fork additionally carries parentId, settings and sidechat as it does from a browser.
// The action id is the home server's item id, minted once; a host that has applied it answers `replayed` and changes nothing.
import { normalizeWriter, tagMember } from '../../../../runner/rev6/base/writer-scope.mjs';
import { localRefusalAsync } from './local-gate.js';

/** The peer fields of an action payload, or null when this is an ordinary browser send. */
export function peerSendOf(payload = {}) {
  const writer = normalizeWriter(payload.writer);
  if (!writer || typeof payload.wire !== 'string' || !payload.wire.trim()) return null;
  return { writer, wire: tagMember(payload.wire, writer), display: String(payload.text ?? payload.wire), title: typeof payload.title === 'string' ? payload.title : null };
}

/** The actions a peer host may post: the chat's own send, fork and stop. */
export const PEER_OPS = Object.freeze(['message.send', 'conversation.fork', 'run.interrupt']);

/** The capability this build serves, advertised on /api/health so a home server picks the protocol by asking, never by guessing. */
export const PEER_CAPABILITY = Object.freeze({ actions: 1, feed: 'conversation' });

/**
 * Who is calling a chat route that a browser and a peer host both use (/api/actions, /api/sync, /api/events). A request with a bearer
 * is a peer: loopback, not through the tunnel, and the service token, exactly the machine-surface rule (local-gate.js); a bearer that
 * fails it is refused as a 404. A request with no bearer is a browser and has already passed the session gate in hooks.server.js.
 */
export async function peerCaller(event) {
  const bearer = (event.request.headers.get('authorization') || '').startsWith('Bearer ');
  if (!bearer) return { peer: false, refused: false };
  return { peer: true, refused: Boolean(await localRefusalAsync(event, { token: true })) };
}
