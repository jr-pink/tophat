// A conversation's row, derived from its events: the pure form of store.js applyToConversation.
//
// The legacy store folds each event into the `conversations` row with SQL UPDATEs, reading the row
// first. The log-first store keeps the row in memory (so a read of your own write costs nothing) and
// in the derived index (so a restart or a rebuild reaches the same row), and both must come out of
// the same function. This is it: (record, event) -> record, no I/O. conv-projection.test.js feeds
// random event streams to this and to the legacy SQL path and requires identical rows.
//
// A record uses the table's own column names and value shapes (settings is a JSON string, flags are
// 0/1), so store.js decodeConversation reads either.

import { normalizeSettings } from '../core/contract.js';
import { summarize } from '../core/summary.js';
import { automatedTitle } from '../core/title.js';
import { blankRow, rowPatch } from '../core/rowstate.js';

/** Column defaults of a conversation row (the schema's), for the columns a creation does not name. */
export function blankConversation(id, init = {}) {
  const at = init.at ?? new Date().toISOString();
  return {
    id,
    title: init.title ?? 'New chat',
    cwd: init.cwd ?? null,
    settings: JSON.stringify(normalizeSettings(init.settings ?? {})),
    session_id: null,
    parent_id: init.parentId ?? null,
    forked_from: init.forkedFrom ?? null,
    pinned: 0,
    archived: 0,
    opens: 0,
    turns: 0,
    tool_calls: 0,
    created_at: at,
    updated_at: at,
    last_opened: at,
    source: init.source ?? 'webchat',
    title_source: 'provisional',
    preview: '',
    active_at: null,
    automated: 0,
    sidechat: init.sidechat ? JSON.stringify(init.sidechat) : null,
    spliced_through: 0,
    scope: init.scope ?? null,
    run_state: 'idle',
    awaiting_first_token: 0,
    note: null,
    note_at: null,
    maintenance: 0,
    notable_cursor: 0,
    read_cursor: 0,
    forced_unread: 0,
    muted_run: 0,
    run_since: null,
    resting_since: null,
    session_provider: null,
    aside: 0,
    workspace: null,
    host: null,
    defer_until: null,
    defer_condition: null,
    deferred_at: null
  };
}

export const CONVERSATION_COLUMNS = Object.keys(blankConversation('x'));

function rowOf(record) {
  return {
    runState: record.run_state || 'idle',
    awaitingFirstToken: Boolean(record.awaiting_first_token),
    note: record.note ?? null,
    noteAt: record.note_at ?? null,
    maintenance: Boolean(record.maintenance),
    notableCursor: record.notable_cursor || 0,
    readCursor: record.read_cursor || 0,
    forcedUnread: Boolean(record.forced_unread),
    mutedRun: Boolean(record.muted_run),
    runSince: record.run_since ?? null,
    restingSince: record.resting_since ?? null
  };
}

/**
 * Fold one event into a conversation record. Returns the record unchanged (same object) when the
 * event moves nothing, else a new object. `record` may be undefined: an event for a conversation
 * with no row moves nothing (the legacy UPDATE matched no row), exactly.
 */
export function projectEvent(record, { kind, content = {}, at, cursor = 0 }, { late = false } = {}) {
  if (!record) return record;
  const patch = {};
  const inc = {};
  // `late`: a coalesced block committed after later events; its time is the block's first fragment's, so it never moves updated_at back.
  if (kind !== 'conversation.opened') patch.updated_at = late && record.updated_at > at ? record.updated_at : at;
  if (kind === 'conversation.created' && content.title && content.title !== 'New chat') {
    patch.title = content.title;
    patch.title_source = content.titleSource === 'arrival' ? 'arrival' : 'auto';
  }
  if (kind === 'conversation.renamed' && content.title) {
    patch.title = content.title;
    patch.title_source = content.auto ? 'auto' : 'manual';
  }
  if (kind === 'conversation.created' && content.scope) patch.scope = content.scope;
  if (kind === 'conversation.meta' && content.scope) patch.scope = content.scope;
  if (kind === 'conversation.pinned') patch.pinned = content.pinned ? 1 : 0;
  if (kind === 'conversation.archived') patch.archived = content.archived ? 1 : 0;
  if (kind === 'conversation.aside') patch.aside = content.aside ? 1 : 0;
  if (kind === 'conversation.created' && content.workspace) patch.workspace = content.workspace;
  if (kind === 'conversation.workspace') patch.workspace = content.workspace || null;
  if (kind === 'conversation.host') patch.host = content.host || null;
  if (kind === 'conversation.deferred') {
    patch.defer_until = content.until || null;
    patch.defer_condition = content.condition || null;
    patch.deferred_at = content.until || content.condition ? at : null;
  }
  if (kind === 'conversation.meta') {
    if (content.sessionId) {
      patch.session_id = content.sessionId;
      if (content.sessionProvider) patch.session_provider = content.sessionProvider;
    }
    if (content.settings) {
      patch.settings = JSON.stringify(normalizeSettings(content.settings, JSON.parse(record.settings || '{}')));
    }
    // markSpliced used to UPDATE this column beside appending the event; the event now carries it.
    if (Number.isSafeInteger(content.splicedThrough) && content.splicedThrough > (record.spliced_through || 0)) {
      patch.spliced_through = content.splicedThrough;
    }
  }
  if (kind === 'conversation.opened') { inc.opens = 1; patch.last_opened = at; }
  if (kind === 'message.user') {
    inc.turns = 1;
    patch.active_at = at;
    if (!record.turns && content.text && automatedTitle(content.text).automated) patch.automated = 1;
    if (record.title_source === 'provisional' && (!record.title || record.title === 'New chat') && content.text) {
      patch.title = automatedTitle(content.text).text.replace(/\s+/gu, ' ').trim().slice(0, 72) || 'New chat';
    } else if (record.title_source !== 'manual' && / ↳$/u.test(record.title || '') && !content.lineage?.copied && content.text) {
      patch.title = String(content.text).replace(/\s+/gu, ' ').trim().slice(0, 72);
      patch.title_source = 'provisional';
    }
  }
  if (kind === 'assistant.message' && !content.agentId && content.text) patch.preview = summarize(content.text);
  if (kind === 'message.user' && content.text && !record.preview && !('preview' in patch)) patch.preview = summarize(content.text);
  if (kind === 'tool.started') inc.tool_calls = 1;

  const row = rowOf(record);
  const update = rowPatch(row, { kind, content, at, cursor });
  if (update) {
    const next = { ...row, ...update };
    if (next.runState !== row.runState) patch.run_state = next.runState;
    if (next.awaitingFirstToken !== row.awaitingFirstToken) patch.awaiting_first_token = next.awaitingFirstToken ? 1 : 0;
    if (next.note !== row.note) { patch.note = next.note; patch.note_at = next.noteAt; }
    if (next.maintenance !== row.maintenance) patch.maintenance = next.maintenance ? 1 : 0;
    if (next.notableCursor !== row.notableCursor) patch.notable_cursor = next.notableCursor;
    if (next.readCursor !== row.readCursor) patch.read_cursor = next.readCursor;
    if (next.forcedUnread !== row.forcedUnread) patch.forced_unread = next.forcedUnread ? 1 : 0;
    if (next.mutedRun !== row.mutedRun) patch.muted_run = next.mutedRun ? 1 : 0;
    if (next.runSince !== row.runSince) patch.run_since = next.runSince;
    if (next.restingSince !== row.restingSince) patch.resting_since = next.restingSince;
  }
  const next = { ...record, ...patch };
  for (const [column, by] of Object.entries(inc)) next[column] = (record[column] || 0) + by;
  return next;
}

/** Apply a `$set` control record: only the named columns, with the same merging the setters did. */
export function projectSet(record, fields) {
  if (!record) return record;
  const next = { ...record };
  if (fields.settings !== undefined) next.settings = JSON.stringify(fields.settings);
  if (fields.scope !== undefined) next.scope = fields.scope;
  if (fields.sidechat !== undefined) next.sidechat = fields.sidechat ? JSON.stringify(fields.sidechat) : null;
  if (fields.splicedThrough !== undefined) next.spliced_through = fields.splicedThrough;
  return next;
}

export { blankRow };
