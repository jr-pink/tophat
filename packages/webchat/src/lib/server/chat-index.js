// The derived index of the chat log: SQLite tables that hold nothing the log does not.
//
// events / event_fts / event_sub / conversations / applied_actions have the legacy events.sqlite's
// own columns, so every reader of that file (rev5 chats.py, retrieval, the memory ingest) reads this
// one unchanged. `log_pos` records, per conversation, how far into the log this index has read; it
// moves in the same transaction as the rows it covers, so after a crash the index is exactly a prefix
// of the log and catching up is replaying what lies after each log_pos. Rebuilding is deleting the
// file and replaying everything (rebuildIndex).
//
// One ChatIndex is opened read-write by one writer (the log writer thread, or a CLI) and any number of
// readers open the same file read-only (openReadOnly): WAL lets them read while the writer commits.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { INDEXED_KINDS, SUBSTRING_KINDS, indexableBody } from './store-shared.js';
import { blankConversation, CONVERSATION_COLUMNS, projectEvent, projectSet } from './conv-projection.js';
import { isControl } from './chatlog.js';

export const INDEX_SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  cursor          INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  run_id          TEXT,
  kind            TEXT NOT NULL,
  content         TEXT NOT NULL,
  at              TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_by_conversation ON events(conversation_id, cursor);
CREATE INDEX IF NOT EXISTS events_by_kind ON events(kind, conversation_id, cursor);
CREATE INDEX IF NOT EXISTS events_user_item ON events(conversation_id, json_extract(content, '$.itemId')) WHERE kind = 'message.user';

CREATE TABLE IF NOT EXISTS applied_actions (
  action_id       TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  op              TEXT NOT NULL,
  cursor_before   INTEGER NOT NULL,
  cursor_after    INTEGER NOT NULL,
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
  active_at     TEXT,
  automated     INTEGER NOT NULL DEFAULT 0,
  sidechat      TEXT,
  spliced_through INTEGER NOT NULL DEFAULT 0,
  scope         TEXT,
  run_state     TEXT NOT NULL DEFAULT 'idle',
  awaiting_first_token INTEGER NOT NULL DEFAULT 0,
  note          TEXT,
  note_at       TEXT,
  maintenance   INTEGER NOT NULL DEFAULT 0,
  notable_cursor INTEGER NOT NULL DEFAULT 0,
  read_cursor   INTEGER NOT NULL DEFAULT 0,
  forced_unread INTEGER NOT NULL DEFAULT 0,
  muted_run     INTEGER NOT NULL DEFAULT 0,
  run_since     TEXT,
  resting_since TEXT,
  session_provider TEXT,
  aside         INTEGER NOT NULL DEFAULT 0,
  workspace     TEXT,
  host          TEXT,
  defer_until   TEXT,
  defer_condition TEXT,
  deferred_at   TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS event_fts USING fts5(
  body, conversation_id UNINDEXED, cursor UNINDEXED, kind UNINDEXED, tokenize = 'porter unicode61'
);
CREATE VIRTUAL TABLE IF NOT EXISTS event_sub USING fts5(
  body, conversation_id UNINDEXED, cursor UNINDEXED, kind UNINDEXED, tokenize = 'trigram'
);

CREATE TABLE IF NOT EXISTS log_pos (
  conversation_id TEXT PRIMARY KEY,
  n               INTEGER NOT NULL,
  segment         TEXT,
  offset          INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS index_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);

-- The index is derived: only a connection that registered chat_writer() (a ChatIndex opened read-write) may change
-- these tables. Any other writer (a build from before the log-first store, a script, sqlite3 by hand) fails loudly on
-- its first INSERT with "no such function: chat_writer" instead of silently putting rows here the log does not hold.
CREATE TRIGGER IF NOT EXISTS events_derived_insert BEFORE INSERT ON events WHEN chat_writer() IS NOT 1 BEGIN SELECT RAISE(ABORT, 'derived chat index: written only by the chat log writer'); END;
CREATE TRIGGER IF NOT EXISTS events_derived_update BEFORE UPDATE ON events WHEN chat_writer() IS NOT 1 BEGIN SELECT RAISE(ABORT, 'derived chat index: written only by the chat log writer'); END;
CREATE TRIGGER IF NOT EXISTS events_derived_delete BEFORE DELETE ON events WHEN chat_writer() IS NOT 1 BEGIN SELECT RAISE(ABORT, 'derived chat index: written only by the chat log writer'); END;
CREATE TRIGGER IF NOT EXISTS conversations_derived_insert BEFORE INSERT ON conversations WHEN chat_writer() IS NOT 1 BEGIN SELECT RAISE(ABORT, 'derived chat index: written only by the chat log writer'); END;
CREATE TRIGGER IF NOT EXISTS conversations_derived_update BEFORE UPDATE ON conversations WHEN chat_writer() IS NOT 1 BEGIN SELECT RAISE(ABORT, 'derived chat index: written only by the chat log writer'); END;
CREATE TRIGGER IF NOT EXISTS conversations_derived_delete BEFORE DELETE ON conversations WHEN chat_writer() IS NOT 1 BEGIN SELECT RAISE(ABORT, 'derived chat index: written only by the chat log writer'); END;
CREATE TRIGGER IF NOT EXISTS applied_derived_insert BEFORE INSERT ON applied_actions WHEN chat_writer() IS NOT 1 BEGIN SELECT RAISE(ABORT, 'derived chat index: written only by the chat log writer'); END;
`;

// Columns the table gained after its first version (the CREATE statement above has them for a new file): the peer that runs the chat.
const ADDED_COLUMNS = [{ name: 'host', type: 'TEXT' }];

const UPSERT_COLUMNS = CONVERSATION_COLUMNS.join(', ');
const UPSERT_HOLES = CONVERSATION_COLUMNS.map(() => '?').join(', ');

export class ChatIndex {
  constructor(file, { readOnly = false, cacheKb = 131072 } = {}) {
    this.file = file;
    this.readOnly = readOnly;
    if (!readOnly) fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file, readOnly ? { readOnly: true } : {});
    this.db.exec('PRAGMA busy_timeout = 5000');
    if (!readOnly) {
      this.db.function('chat_writer', () => 1);
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA synchronous = NORMAL');
      this.db.exec(`PRAGMA cache_size = -${cacheKb}`);
      this.db.exec(INDEX_SCHEMA);
      // A column added to the conversation record after an index was first built: the CREATE above skips an existing table.
      const have = new Set(this.db.prepare('PRAGMA table_info(conversations)').all().map((c) => c.name));
      for (const column of ADDED_COLUMNS) if (!have.has(column.name)) this.db.exec(`ALTER TABLE conversations ADD COLUMN ${column.name} ${column.type}`);
      this.rows = new Map();          // conversation id -> record (cache of the table, this writer's)
      this.pos = new Map();           // conversation id -> { n, segment, offset }
      this.statements();
    }
  }

  static openReadOnly(file) { return new ChatIndex(file, { readOnly: true }); }

  statements() {
    const db = this.db;
    this.insertEvent = db.prepare('INSERT OR IGNORE INTO events (cursor, conversation_id, run_id, kind, content, at) VALUES (?, ?, ?, ?, ?, ?)');
    this.insertFts = db.prepare('INSERT INTO event_fts (body, conversation_id, cursor, kind) VALUES (?, ?, ?, ?)');
    this.insertSub = db.prepare('INSERT INTO event_sub (body, conversation_id, cursor, kind) VALUES (?, ?, ?, ?)');
    this.selectRow = db.prepare('SELECT * FROM conversations WHERE id = ?');
    this.upsertRow = db.prepare(`INSERT OR REPLACE INTO conversations (${UPSERT_COLUMNS}) VALUES (${UPSERT_HOLES})`);
    this.selectPos = db.prepare('SELECT n, segment, offset FROM log_pos WHERE conversation_id = ?');
    this.upsertPos = db.prepare(`INSERT INTO log_pos (conversation_id, n, segment, offset) VALUES (?, ?, ?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET n = excluded.n, segment = excluded.segment, offset = excluded.offset`);
    this.insertApplied = db.prepare('INSERT OR IGNORE INTO applied_actions (action_id, conversation_id, op, cursor_before, cursor_after, at) VALUES (?, ?, ?, ?, ?, ?)');
  }

  position(id) {
    let pos = this.pos.get(id);
    if (!pos) { pos = this.selectPos.get(id) || { n: 0, segment: null, offset: 0 }; pos = { ...pos }; this.pos.set(id, pos); }
    return pos;
  }

  row(id) {
    if (this.rows.has(id)) return this.rows.get(id);
    const found = this.selectRow.get(id);
    const row = found ? { ...found } : undefined;
    this.rows.set(id, row);
    return row;
  }

  /**
   * Fold log records into the index in one transaction. `records` are in append order; a record whose
   * sequence number the index already holds (log_pos) is skipped, so replay is idempotent. `ends` maps
   * a conversation id to { segment, size } as of the end of its last record in this batch.
   * Returns { events, controls, skipped, rows } (rows: how many conversation rows were rewritten).
   */
  applyBatch(records, ends = new Map()) {
    const touched = new Set();
    const moved = new Set();
    let through = 0;
    let events = 0; let controls = 0; let skipped = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const rec of records) {
        const pos = this.position(rec.i);
        if (rec.n <= pos.n) { skipped += 1; continue; }
        if (isControl(rec.k)) {
          controls += 1;
          this.applyControl(rec, touched);
        } else {
          events += 1;
          const content = rec.x !== undefined ? rec.x : JSON.stringify(rec.d);
          const result = this.insertEvent.run(rec.c, rec.i, rec.r ?? null, rec.k, content, rec.t);
          if (Number(result.changes) && INDEXED_KINDS.has(rec.k)) {
            const body = indexableBody(rec.k, rec.d ?? {});
            if (body.trim()) {
              this.insertFts.run(body, rec.i, rec.c, rec.k);
              if (SUBSTRING_KINDS.has(rec.k)) this.insertSub.run(body, rec.i, rec.c, rec.k);
            }
          }
          const before = this.row(rec.i);
          if (before && !rec.np) {
            const after = projectEvent(before, { kind: rec.k, content: rec.d ?? {}, at: rec.t, cursor: rec.c }, { late: rec.co === 1 });
            if (after !== before) { this.rows.set(rec.i, after); touched.add(rec.i); }
          }
        }
        pos.n = rec.n;
        moved.add(rec.i);
        // How far into the cursor sequence this index has taken in: events by their cursor, a coalesced block by
        // the last fragment it holds (`cl`). A catch-up from the legacy store starts above it.
        if (rec.c > through) through = rec.c;
        if (rec.cl > through) through = rec.cl;
      }
      for (const id of touched) {
        const row = this.rows.get(id);
        if (row) this.upsertRow.run(...CONVERSATION_COLUMNS.map((column) => row[column] ?? null));
      }
      if (through) {
        const held = Number(this.meta('ingested_through') || 0);
        if (through > held) this.setMeta('ingested_through', through);
      }
      for (const id of moved) {
        const pos = this.pos.get(id);
        const end = ends.get(id);
        if (end) { pos.segment = end.segment; pos.offset = end.size; }
        this.upsertPos.run(id, pos.n, pos.segment ?? null, pos.offset ?? 0);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* none open */ }
      // The caches may hold rows the rolled-back transaction never wrote.
      this.rows.clear(); this.pos.clear();
      throw error;
    }
    return { events, controls, skipped, rows: touched.size };
  }

  applyControl(rec, touched) {
    const d = rec.d || {};
    if (rec.k === '$conv') {
      if (!this.row(rec.i)) { this.rows.set(rec.i, blankConversation(rec.i, d)); touched.add(rec.i); }
    } else if (rec.k === '$set') {
      const before = this.row(rec.i);
      if (before) { this.rows.set(rec.i, projectSet(before, d)); touched.add(rec.i); }
    } else if (rec.k === '$snapshot') {
      const row = { ...blankConversation(rec.i), ...d.row, id: rec.i };
      this.rows.set(rec.i, row); touched.add(rec.i);
    } else if (rec.k === '$applied') {
      this.insertApplied.run(d.actionId, rec.i, d.op, d.cursorBefore, d.cursorAfter, d.at ?? rec.t);
    }
  }

  /** Remove everything the index holds for a conversation (the log dropped it). */
  dropConversation(id) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM event_fts WHERE conversation_id = ?').run(id);
      this.db.prepare('DELETE FROM event_sub WHERE conversation_id = ?').run(id);
      this.db.prepare('DELETE FROM events WHERE conversation_id = ?').run(id);
      this.db.prepare('DELETE FROM applied_actions WHERE conversation_id = ?').run(id);
      this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
      this.db.prepare('DELETE FROM log_pos WHERE conversation_id = ?').run(id);
      this.db.exec('COMMIT');
    } catch (error) { try { this.db.exec('ROLLBACK'); } catch { /* none */ } throw error; }
    this.rows.delete(id); this.pos.delete(id);
  }

  allPositions() { return new Map(this.db.prepare('SELECT conversation_id, n, segment, offset FROM log_pos').all().map((r) => [r.conversation_id, r])); }
  /** The highest legacy cursor taken in, fragments included (see applyBatch); 0 for an index that was never fed from one. */
  ingestedThrough() { return Math.max(Number(this.meta('ingested_through') || 0), this.maxCursor()); }
  maxCursor() { return Number(this.db.prepare('SELECT COALESCE(MAX(cursor), 0) AS c FROM events').get().c); }
  meta(key) { return this.db.prepare('SELECT v FROM index_meta WHERE k = ?').get(key)?.v ?? null; }
  setMeta(key, value) { this.db.prepare('INSERT INTO index_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(key, String(value)); }
  checkpoint(mode = 'PASSIVE') { try { return this.db.prepare(`PRAGMA wal_checkpoint(${mode})`).get(); } catch { return null; } }
  close() { try { this.db.close(); } catch { /* closed */ } }
}

/**
 * Bring an index level with its log: every record after each conversation's log_pos is applied. Used
 * at boot (a crash can leave the log ahead of the index by one batch) and by rebuildIndex (from zero).
 * Returns { conversations, events, controls, corrupt: [...] }.
 */
export function catchUp(index, log, { batch = 2000, only = null } = {}) {
  const positions = index.allPositions();
  const out = { conversations: 0, events: 0, controls: 0, corrupt: [] };
  let pending = []; let ends = new Map();
  const flush = () => {
    if (!pending.length) return;
    const result = index.applyBatch(pending, ends);
    out.events += result.events; out.controls += result.controls;
    pending = []; ends = new Map();
  };
  for (const id of only || log.conversationIds()) {
    const pos = positions.get(id);
    log.recover(id);
    let touched = false;
    const items = pos?.segment ? log.scanFrom(id, { segment: pos.segment, offset: pos.offset }) : log.scan(id);
    for (const item of items) {
      if (item.corrupt) { out.corrupt.push({ id, ...item }); continue; }
      if (item.record.n <= (pos?.n ?? 0)) continue;
      pending.push(item.record);
      ends.set(id, { segment: item.segment, size: item.end });
      touched = true;
      if (pending.length >= batch) flush();
    }
    if (touched) out.conversations += 1;
  }
  flush();
  return out;
}

/** Build a complete index from the log into `file` (replacing it atomically). Returns catchUp's counts. */
export function rebuildIndex(log, file, options = {}) {
  const tmp = `${file}.rebuild-${process.pid}-${Date.now()}`;
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${tmp}${suffix}`, { force: true });
  const index = new ChatIndex(tmp);
  let result;
  try {
    result = catchUp(index, log, options);
    index.setMeta('rebuilt_at', new Date().toISOString());
    index.checkpoint('TRUNCATE');
  } finally { index.close(); }
  for (const suffix of ['-wal', '-shm']) fs.rmSync(`${file}${suffix}`, { force: true });
  fs.renameSync(tmp, file);
  for (const suffix of ['-wal', '-shm']) fs.rmSync(`${tmp}${suffix}`, { force: true });
  return result;
}

/** Hash an index's content (events, conversations, applied_actions) in a fixed order: equal indexes read equal. */
export function indexDigest(file) {
  const index = ChatIndex.openReadOnly(file);
  try {
    const out = {};
    const hash = (sql, shape) => {
      const h = createHash('sha256'); let n = 0;
      for (const row of index.db.prepare(sql).iterate()) { h.update(shape(row)); h.update('\n'); n += 1; }
      return { n, sha256: h.digest('hex') };
    };
    out.events = hash('SELECT cursor, conversation_id, run_id, kind, content, at FROM events ORDER BY cursor',
      (r) => JSON.stringify([r.cursor, r.conversation_id, r.run_id, r.kind, r.content, r.at]));
    out.conversations = hash('SELECT * FROM conversations ORDER BY id', (r) => JSON.stringify(CONVERSATION_COLUMNS.map((c) => r[c] ?? null)));
    out.applied = hash('SELECT * FROM applied_actions ORDER BY action_id', (r) => JSON.stringify(Object.values(r)));
    out.fts = index.db.prepare('SELECT count(*) AS n FROM event_fts').get().n;
    out.sub = index.db.prepare('SELECT count(*) AS n FROM event_sub').get().n;
    return out;
  } finally { index.close(); }
}
