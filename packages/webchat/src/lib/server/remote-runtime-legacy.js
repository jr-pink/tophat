// LEGACY HOST BRANCH. Used only for a peer host whose /api/health does not advertise `peer.actions`. It exists so that rolling the
// home server out before the host does not strand a chat; it is selected by the capability handshake in remote-runtime.js, never by
// guessing, and it is deleted once every host runs the actions build.
//
// Why a text match is needed here and nowhere else: the old host's row for his message carries `display`, the home row carries the
// same words, and nothing but the words says they are one message (an id was only added to send/spawn in the last legacy build).
import { unseeded } from '../core/automated-event.js';

/** Remember the wire and display texts the host will echo back; returns withdraw() for a send the host did not take. */
export function registerEcho(twin, wire, item) {
  const echoKey = wire.text.trim();
  const ownKey = String(wire.display ?? '').trim();
  const keys = ownKey && ownKey !== echoKey ? [echoKey, ownKey] : [echoKey];
  for (const k of keys) twin.echo.push(k);
  if (keys.length > 1) { twin.echoAlt = twin.echoAlt || {}; twin.echoAlt[echoKey] = ownKey; twin.echoAlt[ownKey] = echoKey; }
  if (twin.echo.length > 50) twin.echo.splice(0, twin.echo.length - 50);
  if (!twin.sentIds.includes(item.itemId)) twin.sentIds.push(item.itemId);
  return () => {
    const i = twin.sentIds.lastIndexOf(item.itemId); if (i >= 0) twin.sentIds.splice(i, 1);
    for (const k of keys) { const at = twin.echo.indexOf(k); if (at >= 0) twin.echo.splice(at, 1); }
  };
}

/** The host's message.user row: true when it is the echo of one sent from here (consumed), false when someone typed it on the host. */
export function consumeEcho(twin, c) {
  if (c.itemId && twin.sentIds.includes(c.itemId)) return true;
  const text = String(c.text || '').trim();
  let at = twin.echo.indexOf(text);
  if (at < 0) at = twin.echo.findIndex((sent) => unseeded(sent) === unseeded(text));
  if (at < 0) return false;
  const [hit] = twin.echo.splice(at, 1);
  const other = twin.echoAlt?.[hit];
  if (other != null) { const j = twin.echo.indexOf(other); if (j >= 0) twin.echo.splice(j, 1); delete twin.echoAlt[hit]; delete twin.echoAlt[other]; }
  return true;
}

/** Forward one message over the old machine surface: spawn for the first, send after. Sets twin.remoteId and twin.cursor on spawn. */
export async function forward({ call, twin, item, wire, writer, title, forkOf }) {
  if (!twin.remoteId) {
    const out = await call(twin.runtime, { op: 'spawn', prompt: wire.text, display: wire.display, itemId: item.itemId, writer, title, ...forkOf });
    twin.remoteId = out.id;
    twin.cursor = Number(out.cursor) || 0; // the host's cursor before it ran the prompt: the stream starts there
  } else {
    await call(twin.runtime, { op: 'send', conversationId: twin.remoteId, text: wire.text, display: wire.display, itemId: item.itemId, writer });
  }
}
