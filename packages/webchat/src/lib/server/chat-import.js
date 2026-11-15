// Chat import: put a chat that was written on another host into a group scope of THIS store, whole and checked.
//
// The machine door is /api/agent op `import-conversation` (loopback and the service token, like every op there). It exists because
// the peer-chat host mechanism (remote-runtime.js) never copies a transcript across: it seeds the receiving runner with text, and
// the chat stays one host's. A scope move (scopes.js `move`) copies a chat between scopes of one registry, but only for an
// account's own browser session. This is the path for "put these turns of my chat into the team's group scope on that host".
//
// What it does, in order, all or nothing:
//   validate    the bundle's shape, every event kind known to the contract, the scope a GROUP scope of this host's registry
//               (never a personal scope: a machine caller has no account to authorize against)
//   fingerprint the sender's digest, recomputed here over the events as received (same formula as store.conversationDigest)
//   import      store.importConversation under that scope; the row starts fresh here: no runner session, no parent, not
//               archived, not pinned, and a working directory of this host's choosing, because the sender's path means nothing here
//   verify      the store's own digest of what landed equals the fingerprint; a mismatch deletes the copy and refuses
//   mark        a conversation.meta scopeMove marker (left out of digests, as for a move) so the log says where it came from
// A conversation id that already exists here is a duplicate when its digest matches (answered ok, nothing written) and a conflict
// when it does not (refused; nothing is replaced or deleted).

import { createHash } from 'node:crypto';
import { EVENT_KINDS } from '../core/contract.js';
import { ScopeError } from './scopes.js';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const MAX_EVENTS = 200_000;

/** The same fingerprint store.conversationDigest returns: count and sha256 over kind, content, time and run id, in order. */
export function digestOf(events) {
  const hash = createHash('sha256');
  let count = 0;
  for (const event of events) {
    if (event.kind === 'conversation.meta' && event.content?.scopeMove) continue;
    hash.update(JSON.stringify([event.kind, event.content, event.at, event.run_id ?? null]));
    hash.update('\n');
    count += 1;
  }
  return { count, hash: hash.digest('hex') };
}

const refuse = (code, message, status = 400, extra = {}) => new ScopeError(code, message, status, extra);

/**
 * @param store   this host's store (legacy or log store: both have importConversation and conversationDigest)
 * @param scopes  the scope service (server/scopes.js scopeServiceFor)
 * @param body    { conversation: { id, title, settings, cwd?, created_at, updated_at, source?, title_source?, preview?, turns?, tool_calls? },
 *                  events: [{ kind, content, at, run_id? }], scope, digest?: { count, hash }, origin?: string, cwd?: string }
 * @returns       { ok, duplicate?, id, scope, count, hash }
 */
export function importChat({ store, scopes, body, defaultCwd = null, now = () => new Date().toISOString(), moveId = null }) {
  if (!scopes?.enabled) throw refuse('scopes-disabled', 'This host has scopes off, so there is no scope to import into.', 409);
  const scope = String(body?.scope || '');
  const entry = scopes.scopeEntry(scope);
  if (!entry) throw refuse('unknown-scope', `This host's registry has no scope "${scope}".`, 404);
  if (entry.kind !== 'group') throw refuse('not-a-group', 'A machine import goes into a group scope, never a personal one.', 403);

  const row = body?.conversation;
  const id = String(row?.id || '');
  if (!ID.test(id)) throw refuse('bad-bundle', 'The bundle needs a conversation with a uuid id.');
  const events = body?.events;
  if (!Array.isArray(events) || !events.length) throw refuse('bad-bundle', 'The bundle has no events.');
  if (events.length > MAX_EVENTS) throw refuse('bad-bundle', `More than ${MAX_EVENTS} events.`, 413);
  for (const event of events) {
    if (!event || !EVENT_KINDS.includes(event.kind) || typeof event.at !== 'string' || typeof event.content !== 'object' || event.content === null) {
      throw refuse('bad-bundle', `An event is malformed or has an unknown kind${event?.kind ? ` (${event.kind})` : ''}.`);
    }
  }

  const got = digestOf(events);
  if (body.digest && (body.digest.hash !== got.hash || body.digest.count !== got.count)) {
    throw refuse('digest-mismatch', 'The events arrived different from what the sender fingerprinted; nothing was imported.', 422);
  }

  if (store.conversation(id)) {
    const have = store.conversationDigest(id);
    if (have.hash === got.hash && have.count === got.count) return { ok: true, duplicate: true, id, scope: store.conversation(id).scope ?? null, ...got };
    throw refuse('exists', `Conversation ${id} already exists here with different history; nothing was replaced.`, 409);
  }

  const at = now();
  const clean = {
    id,
    title: String(row.title || 'Imported chat').slice(0, 200),
    cwd: body.cwd || defaultCwd || null,
    settings: JSON.stringify(row.settings && typeof row.settings === 'object' ? row.settings : {}),
    session_id: null,
    parent_id: null,
    forked_from: null,
    pinned: 0,
    archived: 0,
    opens: 0,
    turns: Number.isSafeInteger(row.turns) ? row.turns : 0,
    tool_calls: Number.isSafeInteger(row.tool_calls) ? row.tool_calls : 0,
    created_at: String(row.created_at || events[0].at),
    updated_at: String(row.updated_at || events[events.length - 1].at),
    last_opened: null,
    source: 'import',
    title_source: String(row.title_source || 'provisional'),
    preview: String(row.preview || '').slice(0, 400),
    active_at: null
  };
  const landed = store.importConversation({ row: clean, events: events.map((e) => ({ kind: e.kind, content: e.content, at: e.at, run_id: e.run_id ?? null })) }, { scope });
  const check = store.conversationDigest(id);
  if (check.hash !== got.hash || check.count !== got.count || landed.hash !== got.hash) {
    store.deleteConversation(id);
    throw refuse('verify-failed', 'The copy did not match what was sent, so it was removed.', 500);
  }
  store.append(id, 'conversation.meta', { scope, scopeMove: { id: moveId || `import:${id}`, from: String(body.origin || 'another host'), to: scope, actor: 'import' } }, { at });
  return { ok: true, id, scope, ...check };
}
