// Who is writing in a hosted chat, and what the host's memory may keep of it.
//
// A chat hosted on a team host (webchat/src/lib/server/remote-runtime.js) has two writers.
//   member  The owner, acting as part of the group: his own messages, and the memories his home runner supplies mid-turn. These
//           words belong to his home store (shared to the group by default there); the team host shows them in its chat log but
//           never records them as team memory.
//   group   The team host's own runner: its replies and tool work. The group owns these.
// The tag travels where the text goes. The home host names the writer on /api/agent spawn and send; the team host writes it on the
// message.user event (display) and appends a label to the model-visible text. The runner's memory intake (rev6/pull/pushq.mjs
// transcriptRecords, which feeds both the per-turn ingest in pull.mjs and the turn-end push) drops an owner row that carries either label.
// A label rather than a ledger column: it survives seeds, replays, compaction and a restart, and needs no schema change.

export const WRITER_SCOPES = Object.freeze(['member', 'group']);

const MEMBER_OPEN = '[Member message:';
const INJECT_OPEN = "[Automated event from a member's home host;";

/** A writer the wire may carry: { scope, host } or null. Anything else is dropped, never guessed. */
export function normalizeWriter(w) {
  if (!w || typeof w !== 'object' || !WRITER_SCOPES.includes(w.scope)) return null;
  const host = typeof w.host === 'string' ? w.host.replace(/[^A-Za-z0-9._ -]/gu, '').trim().slice(0, 64) : '';
  return { scope: w.scope, ...(host ? { host } : {}) };
}

/** The label that ends a member's message on the wire to the team host's model. */
export function memberLabel(writer) {
  const from = normalizeWriter(writer)?.host;
  return `${MEMBER_OPEN} written by a member of the group${from ? ` from host ${from}` : ''}, acting as a member and not as the group. The words are the member's own and are not kept as the group's memory.]`;
}

/** The text as the team host's model reads it: a member's message with its label after it (the words themselves are untouched). */
export function tagMember(text, writer) {
  const t = String(text ?? '');
  return writer?.scope === 'member' && !isMemberText(t) ? `${t.replace(/\s+$/u, '')}\n\n${memberLabel(writer)}` : t;
}

export const isMemberText = (text) => String(text ?? '').includes(`\n${MEMBER_OPEN} written by a member of the group`) || String(text ?? '').startsWith(`${MEMBER_OPEN} written by a member of the group`);

/** Context a member's home host supplies to a running host turn (op inject): an automated event, never a message, never memory. */
export function injectedContext(text, { host = '', note = '' } = {}) {
  const from = normalizeWriter({ scope: 'member', host })?.host;
  const why = String(note || '').replace(/\s+/gu, ' ').trim().slice(0, 120);
  return `${INJECT_OPEN} not a message from the owner, and not kept as memory by this host. These are the member's own memories${from ? ` (host ${from})` : ''}, supplied for this turn only${why ? `: ${why}` : ''}.]\n${String(text ?? '').trim()}`;
}

export const isInjectedContext = (text) => String(text ?? '').trimStart().startsWith(INJECT_OPEN);

/** True for an owner row the host's memory intake must not record: a member's own words, or context injected from a home host. */
export const keptOutOfGroupMemory = (text) => isMemberText(text) || isInjectedContext(text);
