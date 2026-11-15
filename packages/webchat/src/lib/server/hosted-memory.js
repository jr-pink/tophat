// Memory ownership for a chat hosted on a peer.
//
// The team host never records a member's words as its memory (rev6/base/writer-scope.mjs). Nothing else writes them, because no local run
// happened here. Each turn end appends the new rows of the hosted chat to the outbox (append-only, one JSON line per row, ids keyed by chat
// and cursor so a replay is a no-op) and, when an ingest is configured, hands them to his store; the per-chat cursor moves only after the
// outbox write, so a failed write is retried at the next turn end.
//
// A row is raw memory, which the store files under this instance's own group (his personal scope); the group it is shared to by
// default (the host's `group` in hosts.json) rides in the row's locator as `share_to`, where the consolidation step that derives notes
// reads it and applies `groups`. A message someone else typed on the host is stored here with writer scope `peer` (an older build gave it an
// `rt:` item id); either way it is not his and is not written.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { isAutomatedEvent, unseeded } from '../core/automated-event.js';
import { webchatStorePath } from './paths.js';

const OUTBOX = () => webchatStorePath('hosted-memory-outbox.jsonl');
export const MAX_ROW_CHARS = 20_000;

/** The raw memory rows for the events of a hosted chat after `after`: { records, last }. Pure. */
export function hostedRecords(events, { chatId, hostId, hostLabel = hostId, group = null, after = 0 }) {
  const records = [];
  let last = after;
  for (const e of events) {
    if (e.cursor <= after) continue;
    last = Math.max(last, e.cursor);
    const c = e.content || {};
    let role = null, text = '', scope = null;
    if (e.kind === 'message.user' && c.text) {
      const own = unseeded(c.text);
      // Only his own messages sent through the bridge carry the member tag; a local run's rows were recorded by that run.
      if (c.writer?.scope !== 'member' || String(c.itemId || '').startsWith('rt:') || isAutomatedEvent(own)) continue;
      role = 'owner'; text = own; scope = 'member';
    } else if (e.kind === 'assistant.message' && c.text && !c.agentId && c.writer?.scope === 'group') {
      role = 'assistant'; text = String(c.text).trim(); scope = 'group';
    }
    if (!role || !text) continue;
    const native = `hosted/${chatId}/${e.cursor}`;
    records.push({
      id: `webchat/${native}`, source: 'webchat', account: '', native_id: native, revision: '1', role,
      author: role === 'owner' ? 'owner' : `host:${hostLabel}`, participants: role === 'owner' ? ['owner', `host:${hostLabel}`] : [`host:${hostLabel}`, 'owner'],
      thread: chatId, text: text.slice(0, MAX_ROW_CHARS), occurred_at: e.at, available_at: e.at, policy: { model: 'allow', publish: 'none' },
      locator: { source: 'webchat', account: '', native_id: native, revision: '1', thread: chatId, field: 'text', writer_scope: scope, host: hostId, ...(group ? { share_to: [group] } : {}) }
    });
  }
  return { records, last };
}

/**
 * The writer. `ingest(records)` (optional) hands rows to his store and resolves { ok }; the outbox is written first either way.
 * flush(id, twin) writes what the chat has gained since `twin.memoryCursor` and moves the cursor; it never throws.
 */
export function createHostedMemory({ store, outboxPath = OUTBOX(), ingest = null, log = () => {} } = {}) {
  const busy = new Set();
  async function flush(id, twin, { hostLabel = twin.runtime, group = null } = {}) {
    if (busy.has(id)) return { written: 0, busy: true };
    busy.add(id);
    try {
      const after = Number.isSafeInteger(twin.memoryCursor) ? twin.memoryCursor : 0;
      const { records, last } = hostedRecords(store.allConversationEvents(id, { after }), { chatId: id, hostId: twin.runtime, hostLabel, group, after });
      if (records.length) {
        mkdirSync(dirname(outboxPath), { recursive: true });
        appendFileSync(outboxPath, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
        if (ingest) { const out = await ingest(records); if (out && out.ok === false) log(`[hosted-memory] ingest refused for ${id}: ${JSON.stringify(out).slice(0, 200)}`); }
      }
      twin.memoryCursor = last;
      return { written: records.length, last };
    } catch (cause) {
      log(`[hosted-memory] ${id}: ${cause?.message || cause}`);
      return { written: 0, error: String(cause?.message || cause) };
    } finally { busy.delete(id); }
  }
  return { flush };
}
