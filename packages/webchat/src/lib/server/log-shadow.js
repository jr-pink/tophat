// The shadow phase: the legacy store still serves everything; the log-first store mirrors every write.
//
// Each write goes to the legacy store first (it assigns the cursor and answers the caller exactly as
// before), then to a log store that takes the same event under the same cursor. The log store is the
// real one (same code, same writer thread, same index), so what it produces here is what it will
// produce when it serves; scripts/chatlog-verify.mjs compares the two while both run. Nothing the
// shadow does can change an answer: its failures are counted and logged, never thrown into a request.
//
// At open the shadow first catches up on whatever the legacy store holds above the log's highest
// cursor (a restart, a script that wrote events.sqlite directly), in order, before any request.

import path from 'node:path';
import { openLogStore } from './log-store.js';

const LOG_EVERY_MS = 60_000;

export function attachShadow(legacy, dir, options = {}) {
  const logger = options.log || console;
  const shadow = openLogStore(dir, {
    // The shadow serves nothing, so its memory is small: a short ring and tails.
    ringEvents: 2_000, ringBytes: 8 * 1024 * 1024, tailBytes: 1024 * 1024, tailTotalBytes: 24 * 1024 * 1024,
    // The catch-up below can hand the writer a restart's worth of events at once; the live bound still applies after it.
    queueMaxRecords: 500_000, queueMaxBytes: 512 * 1024 * 1024,
    ...options.shadow
  });
  const status = { mirrored: 0, errors: 0, lastError: null, caughtUp: null, lastCursor: 0 };
  let lastLogged = 0;
  const guard = (what, fn) => {
    try { return fn(); } catch (error) {
      status.errors += 1; status.lastError = `${what}: ${error?.message || error}`;
      if (Date.now() - lastLogged > LOG_EVERY_MS) { lastLogged = Date.now(); logger.error?.(`[chatlog-shadow] ${status.lastError}`); }
      return undefined;
    }
  };

  // ---- catch up -----------------------------------------------------------------------------------------------
  const from = shadow.ingestedThrough;
  const started = performance.now();
  let ingested = 0;
  const known = (id) => Boolean(shadow.conversation(id));
  const rowFor = legacy.db.prepare('SELECT * FROM conversations WHERE id = ?');
  const missing = legacy.db.prepare('SELECT * FROM events WHERE cursor > ? ORDER BY cursor');
  for (const record of missing.iterate(from)) {
    guard('catch-up', () => {
      if (!known(record.conversation_id)) {
        const row = rowFor.get(record.conversation_id);
        if (row) shadow.ensureConversation(record.conversation_id, {
          at: row.created_at, cwd: row.cwd, settings: JSON.parse(row.settings || '{}'), parentId: row.parent_id, forkedFrom: row.forked_from,
          source: row.source, sidechat: row.sidechat ? JSON.parse(row.sidechat) : null, title: 'New chat'
        });
      }
      let content;
      try { content = JSON.parse(record.content); } catch { content = { unreadable: true }; }
      shadow.append(record.conversation_id, record.kind, content, { runId: record.run_id, at: record.at, cursor: record.cursor });
      ingested += 1; status.lastCursor = record.cursor;
    });
  }
  for (const a of legacy.db.prepare('SELECT * FROM applied_actions').all()) {
    if (!shadow.appliedAction(a.action_id)) guard('catch-up applied', () => shadow.markApplied({ actionId: a.action_id, conversationId: a.conversation_id, op: a.op, cursorBefore: a.cursor_before, cursorAfter: a.cursor_after }));
  }
  status.caughtUp = { from, events: ingested, ms: Math.round(performance.now() - started) };
  if (ingested) logger.log?.(`[chatlog-shadow] caught up ${ingested} event(s) above cursor ${from} in ${status.caughtUp.ms} ms`);

  // ---- mirror -------------------------------------------------------------------------------------------------
  const wrapped = { ...legacy };
  const original = legacy;

  wrapped.append = function append(conversationId, kind, content = {}, opts = {}) {
    const event = original.append.call(this, conversationId, kind, content, opts);
    guard('append', () => {
      shadow.append(conversationId, kind, content, { runId: event.run_id, at: event.at, cursor: event.cursor });
      status.mirrored += 1; status.lastCursor = event.cursor;
    });
    return event;
  };
  wrapped.ensureConversation = function ensureConversation(id, opts) {
    const row = original.ensureConversation.call(this, id, opts);
    guard('ensureConversation', () => shadow.ensureConversation(id, opts));
    return row;
  };
  wrapped.setSettings = function setSettings(id, settings) {
    const merged = original.setSettings.call(this, id, settings);
    guard('setSettings', () => shadow.setSettings(id, settings));
    return merged;
  };
  wrapped.markApplied = function markApplied(args) {
    original.markApplied.call(this, args);
    guard('markApplied', () => shadow.markApplied(args));
  };
  wrapped.backfillScope = function backfillScope(scope) {
    const n = original.backfillScope.call(this, scope);
    guard('backfillScope', () => shadow.backfillScope(scope));
    return n;
  };
  wrapped.importConversation = function importConversation(bundle, opts) {
    const digest = original.importConversation.call(this, bundle, opts);
    guard('importConversation', () => {
      const id = bundle.row.id;
      shadow.mirrorConversation({ ...original.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) }, [...original.allConversationEvents(id)]);
    });
    return digest;
  };
  wrapped.deleteConversation = function deleteConversation(id) {
    original.deleteConversation.call(this, id);
    guard('deleteConversation', () => shadow.deleteConversation(id));
  };
  wrapped.close = function close() {
    guard('close', () => { shadow.close().catch(() => {}); });
    original.close.call(this);
  };

  wrapped.mode = 'shadow';
  wrapped.shadow = shadow;
  wrapped.shadowStatus = () => ({ ...status, ...shadow.health(), legacyHead: original.cursor() });
  wrapped.flushShadow = () => shadow.flush();
  wrapped.drain = () => shadow.drain();
  wrapped.health = () => ({ ...wrapped.shadowStatus(), mode: 'shadow' });
  wrapped.probe = () => shadow.probe();
  return wrapped;
}

export { path };
