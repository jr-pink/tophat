

import { releaseWalStore, walStore } from './sqlite-checkpointer.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { EVENT_KINDS, SCHEMA_HASH, CONTRACT_VERSION, normalizeSettings } from '../core/contract.js';
import { summarize } from '../core/summary.js';
import { automatedTitle } from '../core/title.js';
import { blankRow, rowPatch, unreadOf } from '../core/rowstate.js';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { openLogStore } from './log-store.js';
import { attachShadow } from './log-shadow.js';
import { cutover, isDerivedIndex } from './chatlog-cutover.js';
import {
  RESUME_CAP, discharges, markScriptWrites, ROW_BUDGET, LOOSE_ROW_BUDGET, INDEXED_KINDS, SUBSTRING_KINDS, MIN_SUBSTRING, indexableBody,
  decodeMove, decodeConversation, rowOf, ftsQuery, longestTerm, substringExcerpt, substringQuery,
  INDEX_STOPWORDS, tokenizeForIndex, expandIndex, searchIndex
} from './store-shared.js';

export { RESUME_CAP, ftsQuery, longestTerm, substringExcerpt, substringQuery, tokenizeForIndex };




const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  cursor          INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  run_id          TEXT,
  kind            TEXT NOT NULL,
  content         TEXT NOT NULL,
  at              TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_by_conversation ON events(conversation_id, cursor);

CREATE TABLE IF NOT EXISTS applied_actions (
  action_id     TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  op            TEXT NOT NULL,
  cursor_before INTEGER NOT NULL,
  cursor_after  INTEGER NOT NULL,
  at            TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ff_messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  text            TEXT NOT NULL,
  at              TEXT NOT NULL,
  state           TEXT NOT NULL DEFAULT 'routing',
  conversation_id TEXT,
  title           TEXT,
  reason          TEXT,
  error           TEXT
);

CREATE TABLE IF NOT EXISTS reading (
  conversation_id TEXT PRIMARY KEY,
  item_id         TEXT,
  ratio           REAL NOT NULL DEFAULT 0,
  device_id       TEXT NOT NULL,
  at              TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL DEFAULT 'New chat',
  cwd           TEXT,
  settings      TEXT NOT NULL DEFAULT '{}',
  session_id    TEXT,
  parent_id     TEXT,
  forked_from   INTEGER,
  pinned        INTEGER NOT NULL DEFAULT 0,
  archived      INTEGER NOT NULL DEFAULT 0,
  opens         INTEGER NOT NULL DEFAULT 0,
  turns         INTEGER NOT NULL DEFAULT 0,
  tool_calls    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  last_opened   TEXT,
  source        TEXT NOT NULL DEFAULT 'webchat',
  title_source  TEXT NOT NULL DEFAULT 'provisional',
  preview       TEXT NOT NULL DEFAULT '',
  active_at     TEXT
);

-- One row per scope move: what moved, between which scopes, who asked (the owner or the router), and
-- each step as it completed. A move that stopped halfway is readable here and resumes by its id.
CREATE TABLE IF NOT EXISTS scope_moves (
  move_id         TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  from_scope      TEXT NOT NULL,
  to_scope        TEXT NOT NULL,
  actor           TEXT NOT NULL,
  account         TEXT,
  state           TEXT NOT NULL,
  steps           TEXT NOT NULL DEFAULT '[]',
  events_count    INTEGER,
  digest          TEXT,
  reason          TEXT,
  started_at      TEXT NOT NULL,
  finished_at     TEXT
);
CREATE INDEX IF NOT EXISTS scope_moves_by_conversation ON scope_moves(conversation_id, started_at);

-- The scope sending rules an account has written for the router: free text, one row per account.
CREATE TABLE IF NOT EXISTS scope_rules (
  account    TEXT PRIMARY KEY,
  prompt     TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS event_fts USING fts5(
  body, conversation_id UNINDEXED, cursor UNINDEXED, kind UNINDEXED, tokenize = 'porter unicode61'
);

CREATE VIRTUAL TABLE IF NOT EXISTS event_sub USING fts5(
  body, conversation_id UNINDEXED, cursor UNINDEXED, kind UNINDEXED, tokenize = 'trigram'
);
`;

export const BUSY_TIMEOUT_MS = 5_000;

export function busyTimeoutMs(env = process.env) {
  const raw = Number(env.WEBCHAT_BUSY_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : BUSY_TIMEOUT_MS;
}

export function openLegacyStore(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  // Checkpoints run on a worker, never inside a commit on this thread (sqlite-checkpointer.js), and
  // the hot b-tree pages (events, event_fts, event_sub, conversations) stay in this connection's own
  // 128 MB cache instead of the default 2 MB, so an append does not go back to a saturated disk for
  // index pages the OS evicted under memory pressure.
  walStore(db, path);
  db.exec('PRAGMA cache_size = -131072');
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs()}`);
  db.exec(SCHEMA);
  
  
  
  const columns = db.prepare('PRAGMA table_info(conversations)').all().map((c) => c.name);
  if (!columns.includes('title_source')) db.exec("ALTER TABLE conversations ADD COLUMN title_source TEXT NOT NULL DEFAULT 'provisional'");
  if (!columns.includes('preview')) db.exec("ALTER TABLE conversations ADD COLUMN preview TEXT NOT NULL DEFAULT ''");
  
  
  if (!columns.includes('automated')) db.exec('ALTER TABLE conversations ADD COLUMN automated INTEGER NOT NULL DEFAULT 0');
  if (!columns.includes('sidechat')) db.exec('ALTER TABLE conversations ADD COLUMN sidechat TEXT');
  if (!columns.includes('spliced_through')) db.exec('ALTER TABLE conversations ADD COLUMN spliced_through INTEGER NOT NULL DEFAULT 0');
  // Which scope the chat is bound to (core/scopes.js). Null is a chat from before scopes existed; the
  // service backfills it to the deployment's default scope when scopes are switched on.
  if (!columns.includes('scope')) db.exec('ALTER TABLE conversations ADD COLUMN scope TEXT');
  if (!columns.includes('active_at')) {
    db.exec('ALTER TABLE conversations ADD COLUMN active_at TEXT');
    
    
    
    db.exec(`UPDATE conversations SET active_at = COALESCE(
      (SELECT MAX(at) FROM events WHERE events.conversation_id = conversations.id AND kind = 'message.user'),
      created_at)`);
  }

  
  
  
  
  const ROW_COLUMNS = [
    ['run_state', "TEXT NOT NULL DEFAULT 'idle'"],
    ['awaiting_first_token', 'INTEGER NOT NULL DEFAULT 0'],
    ['note', 'TEXT'],
    ['note_at', 'TEXT'],
    
    
    
    
    ['maintenance', 'INTEGER NOT NULL DEFAULT 0'],
    ['notable_cursor', 'INTEGER NOT NULL DEFAULT 0'],
    ['read_cursor', 'INTEGER NOT NULL DEFAULT 0'],
    ['forced_unread', 'INTEGER NOT NULL DEFAULT 0'],
    ['muted_run', 'INTEGER NOT NULL DEFAULT 0'],
    // When the current stretch of work began, and when the row last went quiet.
    // Persisted because the browser's own anchor dies with the component: a tab
    // reloaded mid-turn would otherwise date the activity clock from the newest
    // tool call instead of from the start of the turn. core/rowstate.js keeps both.
    ['run_since', 'TEXT'],
    ['resting_since', 'TEXT'],
    // Which provider's store the conversation's session_id lives in. Session ids are
    // not portable: codex refuses one it did not mint, and rev 5 opens an empty
    // session under it, so a switch has to start a new session and carry the
    // transcript itself (server/handoff.js). Null means a chat from before this
    // column existed, which is read as "the provider it is set to now".
    ['session_provider', 'TEXT'],
    // Set aside, and deferred until an hour or a condition: the two quiet trays above the
    // archive in the sidebar (core/defer.js).
    ['aside', 'INTEGER NOT NULL DEFAULT 0'],
    // The named workspace the chat is filed under (core/workspaces.js); null is unfiled.
    ['workspace', 'TEXT'],
    // The peer that runs the chat (hosts.js); null is this host.
    ['host', 'TEXT'],
    ['defer_until', 'TEXT'],
    ['defer_condition', 'TEXT'],
    ['deferred_at', 'TEXT']
  ];
  const sessionProviderIsNew = !columns.includes('session_provider');
  for (const [name, type] of ROW_COLUMNS) {
    if (!columns.includes(name)) db.exec(`ALTER TABLE conversations ADD COLUMN ${name} ${type}`);
  }
  // Every chat that existed before the column was added has a session id and no record of who
  // minted it, and an unknown owner is read as "this provider", which is what loses the transcript
  // on the next switch. The provider a conversation is set to now is the one that minted its id in
  // every case but a switch already made, and there the id is already unresumable, so naming it
  // costs nothing. Runs once, when the column appears.
  if (sessionProviderIsNew) {
    db.exec("UPDATE conversations SET session_provider = COALESCE(json_extract(settings, '$.provider'), 'claude')"
      + ' WHERE session_id IS NOT NULL AND session_provider IS NULL');
  }

  
  
  
  
  
  const subKinds = [...SUBSTRING_KINDS];
  if (!db.prepare('SELECT count(*) AS n FROM event_sub').get().n) {
    const holes = subKinds.map(() => '?').join(',');
    db.prepare(`INSERT INTO event_sub (body, conversation_id, cursor, kind)
      SELECT body, conversation_id, cursor, kind FROM event_fts WHERE kind IN (${holes})`).run(...subKinds);
  }

  const insertEvent = db.prepare('INSERT INTO events (conversation_id, run_id, kind, content, at) VALUES (?, ?, ?, ?, ?)');
  const insertFts = db.prepare('INSERT INTO event_fts (body, conversation_id, cursor, kind) VALUES (?, ?, ?, ?)');
  const insertSub = db.prepare('INSERT INTO event_sub (body, conversation_id, cursor, kind) VALUES (?, ?, ?, ?)');
  const upsertConversation = db.prepare(`
    INSERT INTO conversations (id, created_at, updated_at, last_opened, cwd, settings, parent_id, forked_from, title, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING`);
  const selectSince = db.prepare('SELECT * FROM events WHERE cursor > ? ORDER BY cursor LIMIT ?');
  const selectConversationEvents = db.prepare('SELECT * FROM events WHERE conversation_id = ? AND cursor > ? ORDER BY cursor LIMIT ?');
  
  
  
  
  
  const selectConversationTail = db.prepare(
    'SELECT * FROM (SELECT * FROM events WHERE conversation_id = ? AND cursor > ? AND cursor < ? ORDER BY cursor DESC LIMIT ?) ORDER BY cursor');
  const selectConversationProse = db.prepare(
    "SELECT * FROM events WHERE conversation_id = ? AND kind IN ('message.user', 'assistant.message') ORDER BY cursor LIMIT ?");
  const selectAcceptedMessage = db.prepare("SELECT * FROM events WHERE conversation_id = ? AND kind = 'message.user' AND json_extract(content, '$.itemId') = ? ORDER BY cursor DESC LIMIT 1");
  const selectEvaluationStatus = db.prepare("SELECT * FROM events WHERE conversation_id = ? AND kind = 'evaluation.snapshot' AND json_extract(content, '$.messageId') = ? ORDER BY cursor DESC LIMIT 1");
  // Resume reads the newest end of a conversation, never the oldest. conversationEvents() returns
  // the first `limit` rows in cursor order, so a long conversation handed unfinished() a window
  // that stopped hours before the run.completed at the end, and the 22:53 restart re-asked all
  // five of that evening's messages, including one the owner had only pasted. These two walk
  // backwards from the end instead: the newest discharging ending, then the message.user rows
  // after it.
  const selectEndingsBefore = db.prepare(
    "SELECT * FROM events WHERE conversation_id = ? AND cursor < ?"
    + " AND kind IN ('run.completed', 'run.error', 'run.cancelled') ORDER BY cursor DESC LIMIT ?");
  const countUserSince = db.prepare(
    "SELECT COUNT(*) AS n FROM events WHERE conversation_id = ? AND cursor > ? AND kind = 'message.user'"
    + " AND json_extract(content, '$.writtenBy') IS NOT 'script'");
  const selectUserSince = db.prepare(
    "SELECT * FROM (SELECT * FROM events WHERE conversation_id = ? AND cursor > ? AND kind = 'message.user'"
    + " AND json_extract(content, '$.writtenBy') IS NOT 'script'"
    + ' ORDER BY cursor DESC LIMIT ?) ORDER BY cursor');
  const selectConversation = db.prepare('SELECT * FROM conversations WHERE id = ?');
  const selectConversationBySession = db.prepare('SELECT * FROM conversations WHERE session_id = ? ORDER BY updated_at DESC LIMIT 1');
  
  
  
  
  
  
  
  
  
  
  
  
  const selectRunMarkers = db.prepare(`
    SELECT conversation_id,
           COUNT(*) AS runs,
           MAX(CASE WHEN kind IN ('run.completed', 'run.cancelled', 'run.error') THEN cursor END) AS ended
    FROM events
    WHERE kind IN ('run.status', 'run.completed', 'run.cancelled', 'run.error')
    GROUP BY conversation_id
  `);
  const maxCursor = db.prepare('SELECT COALESCE(MAX(cursor), 0) AS cursor FROM events');

  function row(record) {
    return {
      contract_version: CONTRACT_VERSION,
      schema_hash: SCHEMA_HASH,
      event_id: `${record.conversation_id}:${record.cursor}`,
      conversation_id: record.conversation_id,
      run_id: record.run_id,
      cursor: record.cursor,
      kind: record.kind,
      content: readContent(record),
      at: record.at
    };
  }

  
  
  
  
  
  
  
  function readContent(record) {
    try {
      return JSON.parse(record.content);
    } catch (error) {
      console.error(`[store] unreadable content at ${record.conversation_id}:${record.cursor}`
        + ` (kind ${record.kind}): ${error.message}`);
      return { unreadable: true, kind: record.kind, bytes: String(record.content ?? '').length };
    }
  }

  const insertFf = db.prepare('INSERT INTO ff_messages (text, at, state) VALUES (?, ?, ?)');
  const settleFf = db.prepare('UPDATE ff_messages SET state = ?, conversation_id = ?, title = ?, reason = ?, error = ? WHERE id = ?');
  const listFf = db.prepare('SELECT * FROM ff_messages WHERE at >= ? ORDER BY id');
  const putReading = db.prepare(`
    INSERT INTO reading (conversation_id, item_id, ratio, device_id, at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(conversation_id) DO UPDATE SET
      item_id = excluded.item_id, ratio = excluded.ratio,
      device_id = excluded.device_id, at = excluded.at
    WHERE excluded.at > reading.at`);
  const allReading = db.prepare('SELECT * FROM reading ORDER BY at DESC LIMIT ?');
  const recentFf = db.prepare("SELECT * FROM ff_messages WHERE state = 'sent' ORDER BY id DESC LIMIT ?");

  // The newest cursor at which a run discharged the conversation, 0 if it never did. Pages
  // backwards through the ending events so a long tail of run.cancelled with a reason (a restart,
  // an abandoned stream: none of them an answer) cannot hide the real ending above them.
  function lastDischarge(id) {
    let before = Number.MAX_SAFE_INTEGER;
    for (;;) {
      const page = selectEndingsBefore.all(id, before, 200).map(row);
      for (const event of page) {
        if (discharges(event.kind, event.content)) return event.cursor;
        before = event.cursor;
      }
      if (page.length < 200) return 0;
    }
  }

  const listeners = new Set();

  const findApplied = db.prepare('SELECT * FROM applied_actions WHERE action_id = ?');
  const recordApplied = db.prepare(
    'INSERT OR IGNORE INTO applied_actions (action_id, conversation_id, op, cursor_before, cursor_after, at) VALUES (?, ?, ?, ?, ?, ?)'
  );

  let conversationColumns = null;
  function columns_of_conversations() {
    conversationColumns ||= db.prepare('PRAGMA table_info(conversations)').all().map((c) => c.name);
    return conversationColumns;
  }

  return {
    db,

    close() { releaseWalStore(path); db.close(); },

    
    appliedAction(actionId) { return findApplied.get(actionId); },

    markApplied({ actionId, conversationId, op, cursorBefore, cursorAfter }) {
      recordApplied.run(actionId, conversationId, op, cursorBefore, cursorAfter, new Date().toISOString());
    },

    
    between(cursorBefore, cursorAfter) {
      return db.prepare('SELECT * FROM events WHERE cursor > ? AND cursor <= ? ORDER BY cursor')
        .all(cursorBefore, cursorAfter).map(row);
    },

    cursor() { return maxCursor.get().cursor; },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    ensureConversation(id, { at, cwd = null, settings = {}, parentId = null, forkedFrom = null, title = 'New chat', source = 'webchat', sidechat = null, scope = null } = {}) {
      upsertConversation.run(id, at, at, at, cwd, JSON.stringify(normalizeSettings(settings)), parentId, forkedFrom, title, source);
      if (scope) db.prepare('UPDATE conversations SET scope = ? WHERE id = ? AND scope IS NULL').run(scope, id);
      if (sidechat) db.prepare('UPDATE conversations SET sidechat = ? WHERE id = ? AND sidechat IS NULL').run(JSON.stringify(sidechat), id);
      return selectConversation.get(id);
    },

    

    sidechatsOf(parentId) {
      return db.prepare('SELECT * FROM conversations WHERE parent_id = ? AND sidechat IS NOT NULL ORDER BY created_at')
        .all(parentId).map(decodeConversation);
    },

    

    markSpliced(id, cursor, { at = new Date().toISOString() } = {}) {
      db.prepare('UPDATE conversations SET spliced_through = ? WHERE id = ? AND spliced_through < ?').run(cursor, id, cursor);
      return this.append(id, 'conversation.meta', { splicedThrough: cursor }, { at });
    },

    
    
    append(conversationId, kind, content = {}, { runId = null, at = new Date().toISOString() } = {}) {
      if (!EVENT_KINDS.includes(kind)) throw new TypeError(`Unsupported event kind: ${kind}`);
      // One commit per event, not four: the row, its two search indexes and the conversation patch
      // were separate autocommits, each a WAL append and a lock cycle on the HTTP thread. A savepoint
      // nests inside a caller's own transaction.
      db.exec('SAVEPOINT append_event');
      let cursor;
      try {
        const result = insertEvent.run(conversationId, runId, kind, JSON.stringify(content), at);
        cursor = Number(result.lastInsertRowid);
        if (INDEXED_KINDS.has(kind)) {
          const body = indexableBody(kind, content);
          if (body.trim()) insertFts.run(body, conversationId, cursor, kind);
          if (body.trim() && SUBSTRING_KINDS.has(kind)) insertSub.run(body, conversationId, cursor, kind);
        }
        this.applyToConversation(conversationId, kind, content, at, cursor);
        db.exec('RELEASE append_event');
      } catch (error) {
        try { db.exec('ROLLBACK TO append_event; RELEASE append_event'); } catch { /* already gone */ }
        throw error;
      }
      const event = row({ conversation_id: conversationId, run_id: runId, cursor, kind, content: JSON.stringify(content), at });
      
      
      
      
      
      
      
      for (const listener of listeners) {
        try {
          listener(event);
        } catch (cause) {
          console.error(`[store] subscriber threw on ${kind} for ${conversationId}:`, cause);
        }
      }
      return event;
    },

    
    
    applyToConversation(id, kind, content, at, cursor = 0) {
      const patch = [];
      const values = [];
      const set = (column, value) => { patch.push(`${column} = ?`); values.push(value); };
      
      
      if (kind !== 'conversation.opened') set('updated_at', at);
      
      
      
      
      
      
      
      if (kind === 'conversation.created' && content.title && content.title !== 'New chat') {
        set('title', content.title);
        // An arrival's "Who: what" title (src/lib/core/arrival-title.js) is kept apart from 'auto' so
        // the titler never reflows it; a rename (his, or the chat's own agent through /api/agent
        // op rename) makes it 'manual' like any other.
        set('title_source', content.titleSource === 'arrival' ? 'arrival' : 'auto');
      }
      if (kind === 'conversation.renamed' && content.title) {
        set('title', content.title);
        set('title_source', content.auto ? 'auto' : 'manual');
      }
      if (kind === 'conversation.created' && content.scope) set('scope', content.scope);
      if (kind === 'conversation.meta' && content.scope) set('scope', content.scope);
      if (kind === 'conversation.pinned') set('pinned', content.pinned ? 1 : 0);
      if (kind === 'conversation.archived') set('archived', content.archived ? 1 : 0);
      if (kind === 'conversation.aside') set('aside', content.aside ? 1 : 0);
      if (kind === 'conversation.created' && content.workspace) set('workspace', content.workspace);
      if (kind === 'conversation.workspace') set('workspace', content.workspace || null);
      if (kind === 'conversation.host') set('host', content.host || null);
      if (kind === 'conversation.deferred') {
        set('defer_until', content.until || null);
        set('defer_condition', content.condition || null);
        set('deferred_at', content.until || content.condition ? at : null);
      }
      if (kind === 'conversation.meta') {
        if (content.sessionId) {
          set('session_id', content.sessionId);
          // Written by the runner beside the id, never by a provider's own init event.
          if (content.sessionProvider) set('session_provider', content.sessionProvider);
        }
        if (content.settings) {
          const current = selectConversation.get(id);
          set('settings', JSON.stringify(normalizeSettings(content.settings, JSON.parse(current?.settings || '{}'))));
        }
      }
      if (kind === 'conversation.opened') { patch.push('opens = opens + 1'); set('last_opened', at); }
      if (kind === 'message.user') {
        patch.push('turns = turns + 1');
        
        
        
        set('active_at', at);
        const current = selectConversation.get(id);
        
        
        
        if (current && !current.turns && content.text && automatedTitle(content.text).automated) set('automated', 1);
        if (current && current.title_source === 'provisional' && (!current.title || current.title === 'New chat') && content.text) {
          set('title', automatedTitle(content.text).text.replace(/\s+/gu, ' ').trim().slice(0, 72) || 'New chat');
        } else if (current && current.title_source !== 'manual' && / ↳$/u.test(current.title || '') && !content.lineage?.copied && content.text) {
          // A fork's placeholder name gives way to the first message he sends in it. Left
          // provisional so the titler names it from the fork's own turns (autotitle.js).
          set('title', String(content.text).replace(/\s+/gu, ' ').trim().slice(0, 72));
          set('title_source', 'provisional');
        }
      }
      
      
      
      if (kind === 'assistant.message' && !content.agentId && content.text) set('preview', summarize(content.text));
      if (kind === 'message.user' && content.text) {
        const current = selectConversation.get(id);
        if (!current?.preview) set('preview', summarize(content.text));
      }
      if (kind === 'tool.started') patch.push('tool_calls = tool_calls + 1');

      
      
      
      const before = selectConversation.get(id);
      const row = before ? rowOf(before) : blankRow();
      const rowUpdate = rowPatch(row, { kind, content, at, cursor });
      if (rowUpdate) {
        const next = { ...row, ...rowUpdate };
        if (next.runState !== row.runState) set('run_state', next.runState);
        if (next.awaitingFirstToken !== row.awaitingFirstToken) set('awaiting_first_token', next.awaitingFirstToken ? 1 : 0);
        if (next.note !== row.note) { set('note', next.note); set('note_at', next.noteAt); }
        if (next.maintenance !== row.maintenance) set('maintenance', next.maintenance ? 1 : 0);
        if (next.notableCursor !== row.notableCursor) set('notable_cursor', next.notableCursor);
        if (next.readCursor !== row.readCursor) set('read_cursor', next.readCursor);
        if (next.forcedUnread !== row.forcedUnread) set('forced_unread', next.forcedUnread ? 1 : 0);
        if (next.mutedRun !== row.mutedRun) set('muted_run', next.mutedRun ? 1 : 0);
        if (next.runSince !== row.runSince) set('run_since', next.runSince);
        if (next.restingSince !== row.restingSince) set('resting_since', next.restingSince);
      }

      if (!patch.length) return;
      db.prepare(`UPDATE conversations SET ${patch.join(', ')} WHERE id = ?`).run(...values, id);
    },

    // -- scopes (core/scopes.js; the move itself is server/scopes.js) --------------------------------

    /** Chats with no scope yet (from before scopes) take `scope`. Idempotent; returns how many. */
    backfillScope(scope) {
      return Number(db.prepare('UPDATE conversations SET scope = ? WHERE scope IS NULL').run(scope).changes);
    },

    /** The ids of every chat bound to `scope`. */
    conversationIdsInScope(scope) {
      return db.prepare('SELECT id FROM conversations WHERE scope = ?').all(scope).map((r) => r.id);
    },

    /**
     * A fingerprint of a conversation's history: how many events and a hash over their kind, content
     * and time, in order. The scope markers a move writes are left out, so the same history reads the
     * same before a move and after it, and a copy that lost or changed an event reads differently.
     */
    conversationDigest(id) {
      const hash = createHash('sha256');
      let count = 0;
      for (const event of this.allConversationEvents(id)) {
        if (event.kind === 'conversation.meta' && event.content?.scopeMove) continue;
        hash.update(JSON.stringify([event.kind, event.content, event.at, event.run_id ?? null]));
        hash.update('\n');
        count += 1;
      }
      return { count, hash: hash.digest('hex') };
    },

    /** Everything needed to rebuild a conversation in another store: its row and its events, in order. */
    exportConversation(id) {
      const record = selectConversation.get(id);
      if (!record) return null;
      const events = [];
      for (const event of this.allConversationEvents(id)) {
        if (event.kind === 'conversation.meta' && event.content?.scopeMove) continue;
        events.push({ kind: event.kind, content: event.content, at: event.at, run_id: event.run_id ?? null });
      }
      return { row: { ...record }, events, digest: this.conversationDigest(id) };
    },

    /**
     * Rebuild an exported conversation here under `scope`. The row keeps everything it had (title,
     * pins, read marks); events are written verbatim and indexed for search, then announced to this
     * store's subscribers like any other write. Refuses a conversation that already exists here.
     */
    importConversation(bundle, { scope }) {
      const id = bundle?.row?.id;
      if (!id) throw new TypeError('A bundle needs a conversation row');
      if (selectConversation.get(id)) throw new Error(`conversation ${id} already exists in this store`);
      const columns = Object.keys(bundle.row).filter((name) => columns_of_conversations().includes(name));
      const values = columns.map((name) => (name === 'scope' ? scope : bundle.row[name]));
      db.exec('BEGIN');
      try {
        db.prepare(`INSERT INTO conversations (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...values);
        for (const event of bundle.events) {
          const result = insertEvent.run(id, event.run_id ?? null, event.kind, JSON.stringify(event.content), event.at);
          const cursor = Number(result.lastInsertRowid);
          if (INDEXED_KINDS.has(event.kind)) {
            const body = indexableBody(event.kind, event.content);
            if (body.trim()) insertFts.run(body, id, cursor, event.kind);
            if (body.trim() && SUBSTRING_KINDS.has(event.kind)) insertSub.run(body, id, cursor, event.kind);
          }
        }
        db.exec('COMMIT');
      } catch (cause) {
        db.exec('ROLLBACK');
        throw cause;
      }
      return this.conversationDigest(id);
    },

    /** Remove a conversation and its history, search rows included. Action ids stay (replays must still dedupe). */
    deleteConversation(id) {
      db.exec('BEGIN');
      try {
        db.prepare('DELETE FROM event_fts WHERE conversation_id = ?').run(id);
        db.prepare('DELETE FROM event_sub WHERE conversation_id = ?').run(id);
        db.prepare('DELETE FROM events WHERE conversation_id = ?').run(id);
        db.prepare('DELETE FROM reading WHERE conversation_id = ?').run(id);
        db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
        db.exec('COMMIT');
      } catch (cause) {
        db.exec('ROLLBACK');
        throw cause;
      }
    },

    /** The move log. `begin` writes the row, `step` appends a completed step, `finish` closes it. */
    beginScopeMove({ moveId, conversationId, from, to, actor, account = null, reason = null, at = new Date().toISOString() }) {
      db.prepare(`INSERT OR IGNORE INTO scope_moves (move_id, conversation_id, from_scope, to_scope, actor, account, state, reason, started_at)
        VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)`).run(moveId, conversationId, from, to, actor, account, reason, at);
      return this.scopeMove(moveId);
    },
    scopeMoveStep(moveId, step, detail = null, at = new Date().toISOString()) {
      const current = db.prepare('SELECT steps FROM scope_moves WHERE move_id = ?').get(moveId);
      if (!current) return;
      const steps = JSON.parse(current.steps);
      steps.push({ step, at, ...(detail ? { detail } : {}) });
      db.prepare('UPDATE scope_moves SET steps = ? WHERE move_id = ?').run(JSON.stringify(steps), moveId);
    },
    finishScopeMove(moveId, { state, count = null, digest = null, at = new Date().toISOString() }) {
      db.prepare('UPDATE scope_moves SET state = ?, events_count = ?, digest = ?, finished_at = ? WHERE move_id = ?')
        .run(state, count, digest, at, moveId);
    },
    scopeMove(moveId) {
      const r = db.prepare('SELECT * FROM scope_moves WHERE move_id = ?').get(moveId);
      return r ? decodeMove(r) : null;
    },
    scopeMoves(conversationId = null) {
      const rows = conversationId
        ? db.prepare('SELECT * FROM scope_moves WHERE conversation_id = ? ORDER BY started_at, rowid').all(conversationId)
        : db.prepare('SELECT * FROM scope_moves ORDER BY started_at, rowid').all();
      return rows.map(decodeMove);
    },

    /** An account's scope sending rules, or null while it has written none. */
    scopeRules(account) {
      return db.prepare('SELECT prompt FROM scope_rules WHERE account = ?').get(account)?.prompt ?? null;
    },
    setScopeRules(account, prompt, at = new Date().toISOString()) {
      if (!prompt) { db.prepare('DELETE FROM scope_rules WHERE account = ?').run(account); return; }
      db.prepare(`INSERT INTO scope_rules (account, prompt, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(account) DO UPDATE SET prompt = excluded.prompt, updated_at = excluded.updated_at`).run(account, prompt, at);
    },

    setSettings(id, settings) {
      const current = selectConversation.get(id);
      const merged = normalizeSettings(settings, JSON.parse(current?.settings || '{}'));
      db.prepare('UPDATE conversations SET settings = ? WHERE id = ?').run(JSON.stringify(merged), id);
      return merged;
    },

    
    
    ffAccept(text, at = new Date().toISOString()) {
      return Number(insertFf.run(text, at, 'routing').lastInsertRowid);
    },

    ffSettle(id, { state, conversationId = null, title = null, reason = null, error = null }) {
      settleFf.run(state, conversationId, title, reason, error, id);
    },

    
    
    
    markReading({ conversationId, itemId = null, ratio = 0, deviceId, at }) {
      if (!conversationId || !deviceId) return;
      putReading.run(conversationId, itemId, Number(ratio) || 0, deviceId, at);
    },

    
    reading(limit = 200) {
      return allReading.all(limit).map((row) => ({
        conversationId: row.conversation_id,
        itemId: row.item_id,
        ratio: row.ratio,
        deviceId: row.device_id,
        at: row.at
      }));
    },

    ffSince(at = '') {
      return listFf.all(at).map((row) => ({
        id: row.id, text: row.text, at: row.at, state: row.state,
        conversationId: row.conversation_id, title: row.title, reason: row.reason, error: row.error
      }));
    },

    ffRecent(limit = 6) {
      return recentFf.all(limit).reverse().map((row) => ({
        text: row.text, conversationId: row.conversation_id, title: row.title
      }));
    },

    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    unfinished({ within = 24 * 3_600_000, now = Date.now(), cap = RESUME_CAP, includeIds = false } = {}) {
      // A caller that wants every unanswered message passes Infinity, and this
      // cap is bound straight into a SQL LIMIT, where node:sqlite refuses a
      // non-integer with "datatype mismatch". -1 is SQLite's own "no limit".
      const limit = Number.isFinite(cap) ? Math.trunc(cap) : -1;
      const out = [];
      for (const conversation of this.conversations()) {
        if (now - Date.parse(conversation.updatedAt || 0) > within) continue;
        const floor = lastDischarge(conversation.id);
        const owed = countUserSince.get(conversation.id, floor)?.n || 0;
        if (!owed) continue;
        if (owed > cap) {
          console.error(`[store] ${conversation.id} has ${owed} unanswered messages and no ending;`
            + ` re-asking the newest ${cap}. A log with no terminal event reads this way.`);
        }
        const texts = selectUserSince.all(conversation.id, floor, limit)
          .map(row)
          .map(({ content }) => (includeIds ? { text: content.text, itemId: content.itemId } : content.text));
        for (const text of texts) out.push(includeIds ? { id: conversation.id, ...text } : { id: conversation.id, text });
      }
      return out;
    },

    runMarkers() {
      const out = new Map();
      for (const record of selectRunMarkers.all()) {
        out.set(record.conversation_id, { runs: record.runs, ended: record.ended || 0 });
      }
      return out;
    },

    conversation(id) {
      const record = selectConversation.get(id);
      return record ? decodeConversation(record) : null;
    },

    /** The chat a runner session belongs to. Work owned by a chat and the goal ledger are keyed by
     *  the runner's session id (rev5 direct runner), which is not the conversation id. */
    conversationBySession(sessionId) {
      if (!sessionId) return null;
      const record = selectConversationBySession.get(String(sessionId));
      return record ? decodeConversation(record) : null;
    },

    conversations({ since = null } = {}) {
      const sql = since
        ? 'SELECT * FROM conversations WHERE updated_at >= ? ORDER BY updated_at DESC'
        : 'SELECT * FROM conversations ORDER BY updated_at DESC';
      const records = since ? db.prepare(sql).all(since) : db.prepare(sql).all();
      return records.map(decodeConversation);
    },

    since(cursor, limit = 2000) {
      return selectSince.all(cursor, limit).map(row);
    },

    
    
    
    
    
    *allConversationEvents(id, { after = 0, page = 20000 } = {}) {
      let cursor = after;
      for (;;) {
        const batch = this.conversationEvents(id, { after: cursor, limit: page });
        for (const event of batch) yield event;
        if (batch.length < page) return;
        cursor = batch[batch.length - 1].cursor;
      }
    },

    conversationEvents(id, { after = 0, before = null, limit = 20000, newest = false } = {}) {
      const ceiling = before == null ? Number.MAX_SAFE_INTEGER : before;
      if (!newest && before == null) return selectConversationEvents.all(id, after, limit).map(row);
      return selectConversationTail.all(id, after, ceiling, limit).map(row);
    },

    
    
    
    
    
    
    
    acceptedMessage(id, itemId) { const found = selectAcceptedMessage.get(id, itemId); return found ? row(found) : null; },
    evaluationStatus(id, itemId) { const found = selectEvaluationStatus.get(id, itemId); return found ? row(found) : null; },

    conversationProse(id, { limit = 4000 } = {}) {
      return selectConversationProse.all(id, limit).map(row);
    },

    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    

    /** The newest `limit` events of the named kinds, newest first (what files.js asked the events table directly). */
    recentOfKinds(id, kinds, limit) {
      const holes = kinds.map(() => '?').join(',');
      return db.prepare(`SELECT * FROM events WHERE conversation_id = ? AND kind IN (${holes}) ORDER BY cursor DESC LIMIT ?`).all(id, ...kinds, limit).map(row);
    },

    /** Every session id a conversation's meta events ever recorded. */
    sessionIdsOf(id) {
      const ids = new Set();
      for (const record of db.prepare("SELECT content FROM events WHERE conversation_id = ? AND kind = 'conversation.meta' AND content LIKE '%sessionId%'").all(id)) {
        try { const sid = JSON.parse(record.content)?.sessionId; if (sid) ids.add(String(sid)); } catch { /* not JSON */ }
      }
      return [...ids];
    },

    conversationIdsWithPrefix(prefix) {
      return db.prepare('SELECT id FROM conversations WHERE id LIKE ?').all(`${prefix}%`).map((row) => row.id);
    },

    recent({ since, hydrate = 8, tail = 100, bytesPerConversation = 150_000 }) {
      const conversations = this.conversations({ since });
      const events = [];
      for (const conversation of conversations.slice(0, hydrate)) {
        
        
        const settled = this.conversationEvents(conversation.id, { newest: true })
          .filter((event) => event.kind !== 'tool.input_delta');

        
        
        
        
        
        const taken = [];
        let bytes = 0;
        for (let at = settled.length - 1; at >= 0 && taken.length < tail; at -= 1) {
          const size = JSON.stringify(settled[at]).length;
          if (bytes + size > bytesPerConversation && taken.length) break;
          taken.push(settled[at]);
          bytes += size;
        }
        events.push(...taken.reverse());
      }
      events.sort((a, b) => a.cursor - b.cursor);
      return { conversations, events, cursor: this.cursor() };
    },

    
    
    
    
    expand(query, options) { return expandIndex(db, query, options); },
    searchAsync(query, options) { return Promise.resolve().then(() => searchIndex(db, query, options)); },
    expandAsync(query, options) { return Promise.resolve().then(() => expandIndex(db, query, options)); },

    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    search(query, options) { return searchIndex(db, query, options); }
  };
}

/**
 * Which store a path is served by: 'off' (the legacy SQLite store, the default), 'shadow' (legacy serves,
 * the log mirrors and is checked) or 'on' (the log serves; the legacy file has been archived and the file
 * at `path` is the derived index). The flag is WEBCHAT_LOG_MODE, else the word in `chatlog.mode` beside
 * the store, so a rollback is one word and a restart. Only a real events.sqlite takes part; ':memory:'
 * stores (incognito, tests) are always legacy.
 */
export function logMode(path, env = process.env) {
  if (!path || path === ':memory:' || !String(path).endsWith('events.sqlite')) return 'off';
  let word = env.WEBCHAT_LOG_MODE;
  if (!word) {
    try { word = readFileSync(join(dirname(path), 'chatlog.mode'), 'utf8').trim(); } catch { word = ''; }
  }
  return word === 'shadow' || word === 'on' ? word : 'off';
}

export function openStore(path, options = {}) {
  const mode = options.mode || logMode(path);
  if (mode === 'on') {
    const dir = dirname(path);
    // The first boot with the flag on finds the legacy file at `path` and switches over (chatlog-cutover.js: catch up,
    // verify, archive the legacy file untouched, put the derived index at `path`). It refuses rather than guesses:
    // opening the legacy file as an index would add tables to the only copy of the old data.
    if (!isDerivedIndex(path)) cutover(dir);
    if (!isDerivedIndex(path)) throw new Error(`log mode is on but ${path} is not a derived chat index (no log_pos table): refusing to open it`);
    return openLogStore(dir, { indexPath: path, ...options.log });
  }
  // Not `on`, yet the file is the derived index: the flag was changed without rolling the store back (or a build that
  // predates the flag is deployed over a log-first directory). Opening it as the legacy store would write rows the log
  // does not hold; say what to do instead of guessing.
  if (path !== ':memory:' && isDerivedIndex(path)) {
    throw new Error(`${path} is the derived chat index of the log-first store, but chatlog.mode says "${mode}". Set it back to "on", `
      + 'or roll the store back first: node webchat/scripts/chatlog-cutover.mjs rollback --dir <state dir> (server stopped). Nothing was opened.');
  }
  const legacy = openLegacyStore(path);
  if (mode === 'shadow') return attachShadow(legacy, dirname(path), options.shadow);
  return legacy;
}

/**
 * The store for a maintenance script that appends events itself (retitle, import-sessions, close-imported-runs).
 * With the log-first store serving (`on`) the server is the log's one writer and these scripts write the legacy table
 * directly, which no longer exists as the truth: they refuse, and say what to do. In `off` and `shadow` they write the
 * legacy store, as before (the shadow's next boot catches those events up into the log); they never attach a shadow
 * of their own, because a second writer on the log is exactly what the log refuses.
 */
export function openStoreForScript(path) {
  const mode = logMode(path);
  if (mode === 'on' || isDerivedIndex(path)) {
    throw new Error(`the webchat chat store is log-first (${path} is the derived index, and the running server is the log's only writer): `
      + 'this script writes events directly, so it cannot run against it. Make the change through the server (POST /api/actions), '
      + 'or stop the server and use the log tools in scripts/chatlog-*.mjs. Nothing was changed.');
  }
  return markScriptWrites(openLegacyStore(path));
}
