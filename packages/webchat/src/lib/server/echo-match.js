/**
 * Pairs a message the webchat handed the runner with the runner's echo of it (the isReplay user event), so the
 * "your message reached the model after Ns" figure measures that message and no other.
 *
 * It was a FIFO shift: one pending entry per delivery, one shift per echo. A delivery that never echoes (the
 * /compact command, a message the child died before reading) left an entry at the head, and every later echo was
 * timed against the delivery before it, so the figure drifted by one message for the rest of the session.
 *
 * Echoes come back in delivery order, so the echo matches the first pending entry whose text it carries; the
 * entries in front of that one were never going to echo and are dropped. The runner may redact a secret out of the
 * echoed text, so when no entry matches exactly, the oldest entry that is not a slash command is taken.
 */

/** The first text block of an echoed user event, or ''. */
export function echoText(message) {
  const content = message?.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const first = content.find((part) => part?.type === 'text');
  return String(first?.text ?? '');
}

const isCommand = (text) => /^\/[a-z][\w-]*\s*$/i.test(String(text ?? '').trim());

/**
 * Takes the pending delivery this echo answers out of `pending` (mutated in place: it and every entry before it are
 * removed) and returns it, or null when nothing pending can be this echo.
 */
export function takeEcho(pending, message) {
  if (!Array.isArray(pending) || !pending.length) return null;
  const said = echoText(message).trim();
  let at = said ? pending.findIndex((p) => typeof p?.text === 'string' && p.text.trim() === said) : -1;
  // An entry delivered with a prefix (a provider change carries the old transcript in front of the message): the
  // echo ends with what was typed.
  if (at < 0 && said) at = pending.findIndex((p) => typeof p?.text === 'string' && p.text.trim() && said.endsWith(p.text.trim()));
  if (at < 0) at = pending.findIndex((p) => !isCommand(p?.text));
  if (at < 0) return null;
  const [hit] = pending.splice(0, at + 1).slice(-1);
  return hit;
}
