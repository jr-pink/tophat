// The reader's own store: saved documents, their sections, the links that page a series forward
// and back, reading progress, and the notes.
//
// Notes are written twice on purpose. Every create, edit and delete is appended to a JSON-lines
// journal and fsynced before the sqlite row is touched, so the only way to lose a note is to lose
// the file itself: a corrupted database, a bad migration or a mistaken delete are all recoverable
// with rebuildFromJournal(). The journal is append-only; nothing in this module ever rewrites or
// truncates it.

import { releaseWalStore, walStore } from './sqlite-checkpointer.js';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { appendJournalLine, releaseJournal } from './journal-append.js';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { webchatStoreDir } from './paths.js';

/** An FTS snippet with \u0002/\u0003 match markers as safe HTML: text escaped, markers as <b>...</b>. */
export function snippetHtml(raw) {
  return String(raw ?? '').replace(/[&<>"']/gu, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
    .replace(/\u0002/gu, '<b>').replace(/\u0003/gu, '</b>');
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS docs (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL DEFAULT 'article',   -- article | epub | pdf
  url           TEXT,
  canonical_url TEXT,
  title         TEXT NOT NULL DEFAULT '',
  byline        TEXT NOT NULL DEFAULT '',
  site          TEXT NOT NULL DEFAULT '',
  series_key    TEXT NOT NULL DEFAULT '',
  lang          TEXT NOT NULL DEFAULT '',
  excerpt       TEXT NOT NULL DEFAULT '',
  published_at  TEXT,
  words         INTEGER NOT NULL DEFAULT 0,
  sections      INTEGER NOT NULL DEFAULT 1,
  added_at      TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  archived      INTEGER NOT NULL DEFAULT 0,
  starred       INTEGER NOT NULL DEFAULT 0,
  aside         INTEGER NOT NULL DEFAULT 0,   -- put down, no date on it
  defer_until   TEXT,                         -- back on the shelf once this instant has passed
  defer_condition TEXT,                       -- the words he typed, when a clock was not enough
  deferred_at   TEXT,
  meta          TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS docs_by_series ON docs(series_key);
CREATE UNIQUE INDEX IF NOT EXISTS docs_by_url ON docs(url) WHERE url IS NOT NULL;
-- Opening a url he already has looked it up by canonical_url too, which was a scan of the shelf.
CREATE INDEX IF NOT EXISTS docs_by_canonical ON docs(canonical_url) WHERE canonical_url IS NOT NULL;

CREATE TABLE IF NOT EXISTS sections (
  doc_id   TEXT NOT NULL,
  idx      INTEGER NOT NULL,
  href     TEXT NOT NULL DEFAULT '',
  title    TEXT NOT NULL DEFAULT '',
  html     TEXT NOT NULL DEFAULT '',
  text     TEXT NOT NULL DEFAULT '',
  words    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (doc_id, idx)
);
-- The contents rail and the progress sum read idx/href/title/words and nothing else. Without this
-- sqlite reaches through every section row, and a chapter's text lives in overflow pages, so
-- listing a 320 chapter book read the whole book off the disk to count its words.
CREATE INDEX IF NOT EXISTS sections_by_doc ON sections(doc_id, idx, words, href, title);

CREATE TABLE IF NOT EXISTS links (
  doc_id   TEXT NOT NULL,
  rel      TEXT NOT NULL,             -- next | prev | up | outbound
  href     TEXT NOT NULL,
  label    TEXT NOT NULL DEFAULT '',
  why      TEXT NOT NULL DEFAULT '',
  ord      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (doc_id, rel, href)
);

CREATE TABLE IF NOT EXISTS highlights (
  id          TEXT PRIMARY KEY,
  doc_id      TEXT NOT NULL,
  section_idx INTEGER NOT NULL DEFAULT 0,
  kind        TEXT NOT NULL DEFAULT 'highlight',  -- highlight | note
  color       TEXT NOT NULL DEFAULT 'yellow',
  quote       TEXT NOT NULL DEFAULT '',
  prefix      TEXT NOT NULL DEFAULT '',
  suffix      TEXT NOT NULL DEFAULT '',
  start_off   INTEGER NOT NULL DEFAULT 0,
  end_off     INTEGER NOT NULL DEFAULT 0,
  note        TEXT NOT NULL DEFAULT '',
  tags        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT,
  seq         INTEGER NOT NULL DEFAULT 0,
  parent_id   TEXT,                               -- null for a root note; set on a reply
  author      TEXT NOT NULL DEFAULT 'owner',     -- owner | tophat
  -- Which sub-part of the document the offsets are counted inside. A book's offsets are counted
  -- inside its section, so this is null; a chat's are counted inside ONE MESSAGE, because the
  -- transcript grows underneath a note and an offset into the whole transcript would not survive
  -- the next token. For a chat note this holds the message's item id.
  anchor_key  TEXT
);
CREATE INDEX IF NOT EXISTS highlights_by_doc ON highlights(doc_id, section_idx, start_off);
-- The library counts live notes per document and the shelf lists the newest; both had to open
-- every highlight row to see whether it was deleted.
CREATE INDEX IF NOT EXISTS highlights_live_by_doc ON highlights(doc_id, section_idx, start_off) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS highlights_live_recent ON highlights(updated_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS progress (
  doc_id      TEXT NOT NULL,
  section_idx INTEGER NOT NULL,
  ratio       REAL NOT NULL DEFAULT 0,       -- furthest point reached in this section, 0..1
  scroll_top  INTEGER NOT NULL DEFAULT 0,    -- where to put him back
  seconds     INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (doc_id, section_idx)
);
-- The shelf is ordered by when he last read a thing, which is the newest progress row for it.
-- Covering, so the maximum per document is one seek and never touches the table.
CREATE INDEX IF NOT EXISTS progress_by_doc_read ON progress(doc_id, updated_at);

CREATE TABLE IF NOT EXISTS doc_state (
  doc_id      TEXT PRIMARY KEY,
  status      TEXT NOT NULL DEFAULT 'unread', -- unread | reading | finished
  percent     REAL NOT NULL DEFAULT 0,
  section_idx INTEGER NOT NULL DEFAULT 0,
  seconds     INTEGER NOT NULL DEFAULT 0,
  opened_at   TEXT,
  last_read_at TEXT,
  finished_at TEXT,
  chat_id     TEXT                                -- the one conversation this document talks in
);

CREATE VIRTUAL TABLE IF NOT EXISTS doc_fts USING fts5(
  doc_id UNINDEXED, section_idx UNINDEXED, title, text, tokenize = 'porter unicode61'
);
CREATE VIRTUAL TABLE IF NOT EXISTS note_fts USING fts5(
  id UNINDEXED, doc_id UNINDEXED, quote, note, tokenize = 'porter unicode61'
);
`;

// Where the reader keeps its own files. This asks about reader.sqlite rather than borrowing the
// webchat's answer: webchatStoreDir falls back to the old config directory when it finds an
// events.sqlite there, and that fallback once put a book in a directory nobody was reading from.
export function readerStoreDir({ env = process.env, home = homedir() } = {}) {
  const base = env.TOPHAT_STATE_DIR
    ? join(env.TOPHAT_STATE_DIR, 'webchat')
    : webchatStoreDir({ env, home });
  const legacy = join(home, '.config', 'tophat', 'webchat');
  if (!existsSync(join(base, 'reader.sqlite')) && existsSync(join(legacy, 'reader.sqlite'))) return legacy;
  return base;
}
export const readerDbPath = (options) => join(readerStoreDir(options), 'reader.sqlite');
export const readerJournalPath = (options) => join(readerStoreDir(options), 'reader-notes.jsonl');

export const hashId = (prefix, seed) => `${prefix}_${createHash('sha256').update(String(seed)).digest('hex').slice(0, 16)}`;

// Strictly increasing within the process. A note's id hashes its instant, and a restore brings back
// exactly the replies whose deleted_at equals the root's, so two writes in one millisecond must not
// share an instant. They never did while every journal append waited for an fsync; with the fsync
// off the thread two replies in one millisecond collided.
let lastMs = 0;
const nowIso = () => { let ms = Date.now(); if (ms <= lastMs) ms = lastMs + 1; lastMs = ms; return new Date(ms).toISOString(); };

/** A caller-supplied instant, normalised to ISO UTC, or null when it is not one. Never in the future by more than a minute. */
function stampOf(value) {
  if (!value) return null;
  const ms = Date.parse(String(value));
  if (!Number.isFinite(ms)) return null;
  return new Date(Math.min(ms, Date.now() + 60_000)).toISOString();
}

/**
 * Append one record to the journal before anything else happens: written into the file at once, so
 * it precedes the SQLite row; fsynced off the event loop (journal-append.js says why and what that
 * costs).
 */
function appendJournal(path, record) {
  appendJournalLine(path, record);
}

export function readJournal(path) {
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { out.push(JSON.parse(trimmed)); } catch { /* a torn last line is skipped, never rewritten */ }
  }
  return out;
}

// Every row this process writes, told to the live feed (src/lib/server/live-feed.js) so an open
// reader on another device syncs now rather than at its next four-minute tick. Writes from another
// process are noticed by the feed through PRAGMA data_version.
const writeListeners = new Set();
export function onReaderWrite(listener) {
  writeListeners.add(listener);
  return () => writeListeners.delete(listener);
}

export function openReaderStore(path = readerDbPath(), { journal = readerJournalPath() } = {}) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = FULL');
  walStore(db, path);
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);

  // Additive migration for a database that already holds his notes: ALTER TABLE only where the
  // column is missing, never a rebuild. A live reader.sqlite keeps working, with every existing
  // note a root note written by him.
  const addColumn = (table, column, declaration) => {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    if (columns.some((c) => c.name === column)) return false;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
    return true;
  };
  addColumn('highlights', 'parent_id', 'TEXT');
  addColumn('highlights', 'anchor_key', 'TEXT');
  addColumn('highlights', 'author', "TEXT NOT NULL DEFAULT 'owner'");
  addColumn('doc_state', 'chat_id', 'TEXT');
  // Guarded ALTERs, so a live reader.sqlite keeps every document, note and reading position it
  // already has.
  addColumn('docs', 'aside', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('docs', 'defer_until', 'TEXT');
  addColumn('docs', 'defer_condition', 'TEXT');
  addColumn('docs', 'deferred_at', 'TEXT');
  // The threads of one document, and the root list, are the two reads the card makes; both would
  // otherwise scan every note of the document.
  db.exec('CREATE INDEX IF NOT EXISTS highlights_replies ON highlights(parent_id, created_at) WHERE parent_id IS NOT NULL');
  db.exec('CREATE INDEX IF NOT EXISTS highlights_roots ON highlights(doc_id, section_idx, start_off) WHERE parent_id IS NULL AND deleted_at IS NULL');

  // Every statement in here is a literal, so the cache is bounded by the source file. Preparing
  // one costs more than running it on the small reads, and an ingest prepares thousands.
  const statements = new Map();
  const stmt = (sql) => {
    let prepared = statements.get(sql);
    if (!prepared) { prepared = db.prepare(sql); statements.set(sql, prepared); }
    return prepared;
  };

  const run = (sql, ...args) => {
    const result = stmt(sql).run(...args);
    if (result?.changes) for (const listener of writeListeners) { try { listener(); } catch { /* never fails a write */ } }
    return result;
  };
  const all = (sql, ...args) => stmt(sql).all(...args);
  const one = (sql, ...args) => stmt(sql).get(...args) || null;

  function nextSeq() {
    const row = one('SELECT MAX(seq) AS seq FROM highlights');
    return Number(row?.seq || 0) + 1;
  }

  const store = {
    db,
    journalPath: journal,

    /** Insert or refresh a document. Reading state and notes are never touched by a re-save. */
    saveDoc(doc) {
      const at = nowIso();
      const id = doc.id || hashId(doc.kind === 'epub' ? 'e' : 'a', doc.canonicalUrl || doc.url || doc.title);
      const existing = one('SELECT id, added_at FROM docs WHERE id = ?', id);
      run(`INSERT INTO docs (id, kind, url, canonical_url, title, byline, site, series_key, lang, excerpt,
             published_at, words, sections, added_at, updated_at, meta)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET
             kind = excluded.kind, url = excluded.url, canonical_url = excluded.canonical_url,
             title = excluded.title, byline = excluded.byline, site = excluded.site,
             series_key = excluded.series_key, lang = excluded.lang, excerpt = excluded.excerpt,
             published_at = excluded.published_at, words = excluded.words, sections = excluded.sections,
             updated_at = excluded.updated_at, meta = excluded.meta, archived = 0`,
        id, doc.kind || 'article', doc.url || null, doc.canonicalUrl || doc.url || null,
        doc.title || '', doc.byline || '', doc.site || '', doc.seriesKey || '', doc.lang || '',
        doc.excerpt || '', doc.publishedAt || null, Number(doc.words || 0), Number(doc.sections || 1),
        existing?.added_at || at, at, JSON.stringify(doc.meta || {}));
      if (!one('SELECT doc_id FROM doc_state WHERE doc_id = ?', id)) {
        run('INSERT INTO doc_state (doc_id, status, percent, section_idx, seconds) VALUES (?,?,?,?,?)',
          id, 'unread', 0, 0, 0);
      }
      return id;
    },

    setSections(docId, sections = []) {
      run('DELETE FROM sections WHERE doc_id = ?', docId);
      run('DELETE FROM doc_fts WHERE doc_id = ?', docId);
      sections.forEach((section, idx) => {
        run('INSERT INTO sections (doc_id, idx, href, title, html, text, words) VALUES (?,?,?,?,?,?,?)',
          docId, idx, section.href || '', section.title || '', section.html || '', section.text || '',
          Number(section.words || String(section.text || '').split(/\s+/u).filter(Boolean).length));
        run('INSERT INTO doc_fts (doc_id, section_idx, title, text) VALUES (?,?,?,?)',
          docId, idx, section.title || '', section.text || '');
      });
      run('UPDATE docs SET sections = ? WHERE id = ?', sections.length || 1, docId);
    },

    /** Fill in one section's text after it has been parsed, without touching the others. */
    setSectionText(docId, idx, { title = null, text = '', words = null, html = null } = {}) {
      const existing = one('SELECT * FROM sections WHERE doc_id = ? AND idx = ?', docId, idx);
      if (!existing) return false;
      const count = words === null ? String(text || '').split(/\s+/u).filter(Boolean).length : Number(words);
      run('UPDATE sections SET title = ?, text = ?, words = ?, html = ? WHERE doc_id = ? AND idx = ?',
        title === null ? existing.title : title, text, count,
        html === null ? existing.html : html, docId, idx);
      run('DELETE FROM doc_fts WHERE doc_id = ? AND section_idx = ?', docId, idx);
      run('INSERT INTO doc_fts (doc_id, section_idx, title, text) VALUES (?,?,?,?)',
        docId, idx, title === null ? existing.title : title, text);
      return true;
    },

    /** Total words across the sections read so far. */
    countWords(docId) {
      const row = one('SELECT SUM(words) AS words FROM sections WHERE doc_id = ?', docId);
      run('UPDATE docs SET words = ? WHERE id = ?', Number(row?.words || 0), docId);
      return Number(row?.words || 0);
    },

    setLinks(docId, links = []) {
      run('DELETE FROM links WHERE doc_id = ?', docId);
      links.forEach((link, ord) => {
        if (!link?.href) return;
        run('INSERT OR REPLACE INTO links (doc_id, rel, href, label, why, ord) VALUES (?,?,?,?,?,?)',
          docId, link.rel, link.href, link.label || '', link.why || '', ord);
      });
    },

    doc(id) {
      const row = one('SELECT * FROM docs WHERE id = ?', id);
      if (!row) return null;
      return { ...row, meta: JSON.parse(row.meta || '{}'), state: one('SELECT * FROM doc_state WHERE doc_id = ?', id) };
    },

    // Two indexed lookups rather than one OR, which sqlite could only answer by scanning.
    docByUrl(url) {
      const row = one('SELECT id FROM docs WHERE url = ?', url)
        || one('SELECT id FROM docs WHERE canonical_url = ?', url);
      return row ? this.doc(row.id) : null;
    },

    section(docId, idx = 0) {
      return one('SELECT * FROM sections WHERE doc_id = ? AND idx = ?', docId, idx);
    },

    sectionList(docId) {
      return all('SELECT idx, href, title, words FROM sections WHERE doc_id = ? ORDER BY idx', docId);
    },

    links(docId) {
      return all('SELECT rel, href, label, why FROM links WHERE doc_id = ? ORDER BY ord', docId);
    },

    /**
     * The shelf, most recently read first.
     *
     * The order comes from the progress rows, not from doc_state.last_read_at: setStatus writes
     * that timestamp, so marking something unread from the shelf used to jump it to the top of a
     * list of things he had actually been reading. A document he has never opened has no progress
     * row and falls back to when it was added. read_at and order_at are in every row so the
     * client can show the same date it is being sorted by.
     */
    library({ status = null, limit = 200, series = null, starred = false, archived = false,
      aside = false, deferred = false, now = Date.now() } = {}) {
      // Archived is a shelf of its own, not a filter over the live one: asking for it asks for
      // exactly the documents the live shelf hides. Set aside and deferred are two more of the
      // same kind, which is why they stack as trays rather than filter the list.
      const where = [archived ? 'd.archived = 1' : 'd.archived = 0'];
      const args = [];
      // Deferred and not yet due. Nothing is scheduled anywhere: the clock is read here, at read
      // time, so a document whose hour has passed is simply back on the live shelf the next time
      // the shelf is drawn. ISO instants compare as strings because they are all UTC with a Z.
      const waiting = `((d.defer_until IS NOT NULL AND d.defer_until > ?)
                        OR (d.defer_until IS NULL AND COALESCE(d.defer_condition, '') <> ''))`;
      const at = new Date(now).toISOString();
      if (!archived) {
        if (aside) where.push('d.aside = 1');
        else if (deferred) { where.push('d.aside = 0', waiting); args.push(at); }
        // Starred is the personal canon and answers across the trays; the live shelf is the one
        // list that hides what he has put down.
        else if (!starred) { where.push('d.aside = 0', `NOT ${waiting}`); args.push(at); }
      }
      if (status) { where.push('s.status = ?'); args.push(status); }
      if (starred) where.push('d.starred = 1');
      if (series) { where.push('d.series_key = ?'); args.push(series); }
      return all(`SELECT d.*, s.status, s.percent, s.section_idx, s.last_read_at,
                    (SELECT MAX(p.updated_at) FROM progress p WHERE p.doc_id = d.id) AS read_at,
                    (SELECT COUNT(*) FROM highlights h
                      WHERE h.doc_id = d.id AND h.deleted_at IS NULL AND h.parent_id IS NULL) AS notes
                  FROM docs d LEFT JOIN doc_state s ON s.doc_id = d.id
                  WHERE ${where.join(' AND ')}
                  ORDER BY COALESCE(read_at, d.added_at) DESC, d.added_at DESC LIMIT ?`, ...args, limit)
        .map((row) => ({ ...row, meta: JSON.parse(row.meta || '{}'), order_at: row.read_at || row.added_at }));
    },

    search(query, { limit = 40 } = {}) {
      const q = String(query || '').trim();
      if (!q) return { docs: [], notes: [] };
      const match = `${q.replace(/["']/gu, ' ')}*`;
      let docs = [];
      let notes = [];
      try {
        docs = all(`SELECT f.doc_id AS id, f.section_idx, d.title, d.site, d.url, d.kind,
                      snippet(doc_fts, 3, char(2), char(3), '…', 18) AS snippet
                    FROM doc_fts f JOIN docs d ON d.id = f.doc_id
                    WHERE doc_fts MATCH ? ORDER BY rank LIMIT ?`, match, limit)
          // The page renders the snippet as HTML ({@html}); the indexed text is a saved page's own words, so it is
          // escaped here and only the match markers (control characters no text carries) become <b>.
          .map((row) => ({ ...row, snippet: snippetHtml(row.snippet) }));
      } catch { docs = []; }
      try {
        notes = all(`SELECT n.id, n.doc_id, d.title, h.quote, h.note, h.section_idx, h.color, h.kind
                     FROM note_fts n JOIN highlights h ON h.id = n.id JOIN docs d ON d.id = n.doc_id
                     WHERE note_fts MATCH ? AND h.deleted_at IS NULL ORDER BY rank LIMIT ?`, match, limit);
      } catch { notes = []; }
      return { docs, notes };
    },

    // --- notes: journal first, then the row ---------------------------------------------------

    /**
     * Write a note, an edit of one, or a reply to one. A reply names its parent with parentId;
     * it inherits the parent's document, section and anchor, so the thread stays pinned to the
     * same words, and a reply to a reply joins the same root because the card draws one level.
     */
    saveHighlight(input) {
      const at = nowIso();
      const parentRow = input.parentId ? one('SELECT * FROM highlights WHERE id = ?', String(input.parentId)) : null;
      if (input.parentId && !parentRow) return null;
      const root = parentRow?.parent_id
        ? (one('SELECT * FROM highlights WHERE id = ?', parentRow.parent_id) || parentRow)
        : parentRow;
      const docId = root ? root.doc_id : input.docId;
      const sectionIdx = root ? root.section_idx : Number(input.sectionIdx || 0);
      const id = input.id || hashId('h', `${docId}:${sectionIdx}:${root?.id || ''}:${input.start}:${input.quote}:${at}`);
      const existing = one('SELECT * FROM highlights WHERE id = ?', id);
      const parentId = root ? root.id : (existing?.parent_id || null);
      const record = {
        id,
        docId,
        sectionIdx,
        kind: parentId ? 'reply' : (input.note ? 'note' : (input.kind || 'highlight')),
        color: root ? root.color : (input.color || existing?.color || 'yellow'),
        quote: root ? String(root.quote) : String(input.quote ?? existing?.quote ?? ''),
        prefix: root ? String(root.prefix) : String(input.prefix ?? existing?.prefix ?? ''),
        suffix: root ? String(root.suffix) : String(input.suffix ?? existing?.suffix ?? ''),
        start: root ? Number(root.start_off) : Number(input.start ?? existing?.start_off ?? 0),
        end: root ? Number(root.end_off) : Number(input.end ?? existing?.end_off ?? 0),
        note: String(input.note ?? existing?.note ?? ''),
        tags: String(input.tags ?? existing?.tags ?? ''),
        anchorKey: root ? (root.anchor_key || null)
          : (input.anchorKey !== undefined ? (input.anchorKey ? String(input.anchorKey) : null)
            : (existing?.anchor_key || null)),
        parentId,
        author: asAuthor(input.author ?? existing?.author),
        createdAt: existing?.created_at || stampOf(input.createdAt) || at,
        // An offline write replayed later carries the instant it was made on the device, so a
        // newer edit from another device is not overwritten by an older one that synced late.
        updatedAt: stampOf(input.updatedAt) || at
      };
      const seq = nextSeq();
      appendJournal(journal, { seq, at, op: existing ? 'update' : 'create', highlight: record });
      run(`INSERT INTO highlights (id, doc_id, section_idx, kind, color, quote, prefix, suffix,
             start_off, end_off, note, tags, created_at, updated_at, deleted_at, seq, parent_id, author,
             anchor_key)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET
             kind = excluded.kind, color = excluded.color, quote = excluded.quote,
             prefix = excluded.prefix, suffix = excluded.suffix, start_off = excluded.start_off,
             end_off = excluded.end_off, note = excluded.note, tags = excluded.tags,
             updated_at = excluded.updated_at, deleted_at = NULL, seq = excluded.seq,
             parent_id = excluded.parent_id, author = excluded.author,
             anchor_key = excluded.anchor_key`,
        id, record.docId, record.sectionIdx, record.kind, record.color, record.quote, record.prefix,
        record.suffix, record.start, record.end, record.note, record.tags, record.createdAt,
        record.updatedAt, seq, record.parentId, record.author, record.anchorKey);
      run('DELETE FROM note_fts WHERE id = ?', id);
      run('INSERT INTO note_fts (id, doc_id, quote, note) VALUES (?,?,?,?)', id, record.docId, record.quote, record.note);
      return this.highlight(id);
    },

    /** The root of whatever thread this id belongs to, with its replies. */
    thread(id) {
      const row = one('SELECT * FROM highlights WHERE id = ?', id);
      if (!row) return null;
      return this.highlight(row.parent_id || row.id);
    },

    /**
     * Soft delete only: the row keeps its text, and the journal keeps the whole history. A root
     * takes its replies with it, each through the journal and all stamped with the same instant,
     * so a restore can put back exactly the replies that this delete hid.
     */
    deleteHighlight(id) {
      const existing = one('SELECT * FROM highlights WHERE id = ?', id);
      if (!existing) return false;
      const at = nowIso();
      const replies = existing.parent_id
        ? []
        : all('SELECT * FROM highlights WHERE parent_id = ? AND deleted_at IS NULL ORDER BY created_at, seq', id);
      for (const row of [...replies, existing]) {
        appendJournal(journal, { seq: nextSeq(), at, op: 'delete', highlight: journalRecord(row) });
        run('UPDATE highlights SET deleted_at = ?, updated_at = ? WHERE id = ?', at, at, row.id);
        run('DELETE FROM note_fts WHERE id = ?', row.id);
      }
      return true;
    },

    restoreHighlight(id) {
      const at = nowIso();
      const existing = one('SELECT * FROM highlights WHERE id = ?', id);
      if (!existing) return null;
      // Only the replies this note's own delete hid: a reply deleted on its own stays deleted.
      const replies = !existing.parent_id && existing.deleted_at
        ? all('SELECT * FROM highlights WHERE parent_id = ? AND deleted_at = ? ORDER BY created_at, seq', id, existing.deleted_at)
        : [];
      for (const row of [existing, ...replies]) {
        // The restore record carries the whole note, so a rebuild from the journal puts it back.
        appendJournal(journal, { seq: nextSeq(), at, op: 'restore', highlight: journalRecord(row) });
        run('UPDATE highlights SET deleted_at = NULL, updated_at = ? WHERE id = ?', at, row.id);
        run('DELETE FROM note_fts WHERE id = ?', row.id);
        run('INSERT INTO note_fts (id, doc_id, quote, note) VALUES (?,?,?,?)', row.id, row.doc_id, row.quote, row.note);
      }
      return this.highlight(id);
    },

    highlight(id) {
      const row = one('SELECT * FROM highlights WHERE id = ?', id);
      if (!row) return null;
      const replies = all('SELECT * FROM highlights WHERE parent_id = ? AND deleted_at IS NULL ORDER BY created_at, seq', row.id);
      return { ...shapeHighlight(row), replies: replies.map(shapeReply) };
    },

    /**
     * One row per anchored note: roots only, each carrying its live replies oldest first. The
     * replies are not notes of their own anywhere, which is why the shelf count does not move
     * when a thread is answered. sectionIdx narrows to one section: a book's notes need not all
     * travel to open one chapter.
     */
    highlights(docId, { includeDeleted = false, sectionIdx = null } = {}) {
      const live = includeDeleted ? '' : ' AND deleted_at IS NULL';
      const roots = sectionIdx === null
        ? all(`SELECT * FROM highlights WHERE doc_id = ? AND parent_id IS NULL${live} ORDER BY section_idx, start_off`, docId)
        : all(`SELECT * FROM highlights WHERE doc_id = ? AND section_idx = ? AND parent_id IS NULL${live} ORDER BY start_off`,
          docId, Number(sectionIdx));
      if (!roots.length) return [];
      const replies = all(`SELECT * FROM highlights WHERE doc_id = ? AND parent_id IS NOT NULL${live} ORDER BY created_at, seq`, docId);
      return attachReplies(roots, replies);
    },

    /** How many live notes the whole document has, for a client that asked for one section's. */
    countHighlights(docId) {
      return Number(one('SELECT COUNT(*) AS n FROM highlights WHERE doc_id = ? AND deleted_at IS NULL AND parent_id IS NULL', docId)?.n || 0);
    },

    /** The newest root notes across the shelf, each with its replies; replies never count here. */
    recentHighlights({ limit = 100 } = {}) {
      const roots = all(`SELECT h.*, d.title AS doc_title, d.url AS doc_url, d.kind AS doc_kind
                  FROM highlights h JOIN docs d ON d.id = h.doc_id
                  WHERE h.deleted_at IS NULL AND h.parent_id IS NULL ORDER BY h.updated_at DESC LIMIT ?`, limit);
      if (!roots.length) return [];
      const marks = roots.map(() => '?').join(',');
      const replies = db.prepare(`SELECT * FROM highlights WHERE parent_id IN (${marks})
                                  AND deleted_at IS NULL ORDER BY created_at, seq`).all(...roots.map((row) => row.id));
      return attachReplies(roots, replies)
        .map((note, i) => ({ ...note, docTitle: roots[i].doc_title, docUrl: roots[i].doc_url,
          docKind: roots[i].doc_kind }));
    },

    /** A chat, as a document. Notes on a transcript are the same object as notes on a book, so the
     * conversation gets a docs row and everything downstream (highlights(), recentHighlights(),
     * note_fts, the threading) applies to it unchanged.
     *
     * The title is refreshed on every call because a conversation is renamed after it is made,
     * and the stream shows the title; the added_at is not, so the row keeps its real age.
     */
    ensureChatDoc(conversationId, title = '') {
      const id = chatDocId(conversationId);
      if (!id) return null;
      const at = nowIso();
      const name = String(title || '').trim() || 'Chat';
      run(`INSERT INTO docs (id, kind, title, added_at, updated_at)
           VALUES (?, 'chat', ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at`,
        id, name, at, at);
      return id;
    },

    // --- the conversation a document talks in -------------------------------------------------

    /** The chat this document's notes go to, so a second note joins the first one's thread. */
    docChat(docId) {
      return one('SELECT chat_id FROM doc_state WHERE doc_id = ?', docId)?.chat_id || null;
    },

    setDocChat(docId, chatId) {
      const id = chatId ? String(chatId) : null;
      run(`INSERT INTO doc_state (doc_id, status, percent, section_idx, seconds, chat_id)
           VALUES (?,?,?,?,?,?)
           ON CONFLICT(doc_id) DO UPDATE SET chat_id = excluded.chat_id`,
        docId, 'unread', 0, 0, 0, id);
      return id;
    },

    // --- progress -----------------------------------------------------------------------------

    /** Progress only ever moves forward within a section; going back to re-read does not undo it. */
    markProgress({ docId, sectionIdx = 0, ratio = 0, scrollTop = 0, seconds = 0, at: when = null }) {
      const at = stampOf(when) || nowIso();
      const bounded = Math.max(0, Math.min(1, Number(ratio) || 0));
      const prior = one('SELECT * FROM progress WHERE doc_id = ? AND section_idx = ?', docId, sectionIdx);
      const best = Math.max(bounded, Number(prior?.ratio || 0));
      // A position replayed from an offline device is last-writer-wins by when it was read: an
      // older one still adds its seconds and can only raise the furthest point, but it does not
      // move him back to where he was before a newer read on another device.
      const stale = Boolean(when && prior?.updated_at && prior.updated_at > at);
      if (stale) {
        run('UPDATE progress SET ratio = ?, seconds = seconds + ? WHERE doc_id = ? AND section_idx = ?',
          best, Math.round(seconds), docId, sectionIdx);
        run('UPDATE doc_state SET seconds = seconds + ? WHERE doc_id = ?', Math.round(seconds), docId);
        return { percent: Number(one('SELECT percent FROM doc_state WHERE doc_id = ?', docId)?.percent || 0),
          sectionIdx, ratio: best, status: one('SELECT status FROM doc_state WHERE doc_id = ?', docId)?.status || 'reading', stale: true };
      }
      run(`INSERT INTO progress (doc_id, section_idx, ratio, scroll_top, seconds, updated_at)
           VALUES (?,?,?,?,?,?)
           ON CONFLICT(doc_id, section_idx) DO UPDATE SET
             ratio = excluded.ratio, scroll_top = excluded.scroll_top,
             seconds = progress.seconds + excluded.seconds, updated_at = excluded.updated_at`,
        docId, sectionIdx, best, Math.round(scrollTop), Math.round(seconds), at);

      // Whole-document percent, weighted by the words in each section, so a long chapter counts
      // for more than a short one.
      const sections = all('SELECT idx, words FROM sections WHERE doc_id = ? ORDER BY idx', docId);
      const ratios = new Map(all('SELECT section_idx, ratio FROM progress WHERE doc_id = ?', docId)
        .map((row) => [row.section_idx, Number(row.ratio) || 0]));
      const totalWords = sections.reduce((sum, s) => sum + Math.max(1, Number(s.words || 1)), 0) || 1;
      const done = sections.reduce((sum, s) => sum + Math.max(1, Number(s.words || 1)) * (ratios.get(s.idx) || 0), 0);
      const percent = Math.max(0, Math.min(1, done / totalWords));
      const state = one('SELECT * FROM doc_state WHERE doc_id = ?', docId);
      const finished = percent >= 0.95;
      run(`INSERT INTO doc_state (doc_id, status, percent, section_idx, seconds, opened_at, last_read_at, finished_at)
           VALUES (?,?,?,?,?,?,?,?)
           ON CONFLICT(doc_id) DO UPDATE SET
             status = excluded.status, percent = MAX(doc_state.percent, excluded.percent),
             section_idx = excluded.section_idx,
             seconds = doc_state.seconds + ?, last_read_at = excluded.last_read_at,
             finished_at = COALESCE(doc_state.finished_at, excluded.finished_at)`,
        docId, finished ? 'finished' : 'reading', percent, sectionIdx,
        Math.round(seconds), state?.opened_at || at, at, finished ? at : null, Math.round(seconds));
      return { percent, sectionIdx, ratio: best, status: finished ? 'finished' : 'reading' };
    },

    progress(docId) {
      return {
        state: one('SELECT * FROM doc_state WHERE doc_id = ?', docId),
        sections: all('SELECT * FROM progress WHERE doc_id = ? ORDER BY section_idx', docId)
      };
    },

    setStatus(docId, status) {
      const at = nowIso();
      run(`INSERT INTO doc_state (doc_id, status, percent, last_read_at, finished_at)
           VALUES (?,?,?,?,?)
           ON CONFLICT(doc_id) DO UPDATE SET status = excluded.status,
             percent = CASE WHEN excluded.status = 'finished' THEN 1.0 WHEN excluded.status = 'unread' THEN 0 ELSE doc_state.percent END,
             finished_at = CASE WHEN excluded.status = 'finished' THEN excluded.finished_at ELSE NULL END`,
        docId, status, status === 'finished' ? 1 : 0, at, status === 'finished' ? at : null);
      return this.doc(docId);
    },

    archive(docId, archived = true) {
      run('UPDATE docs SET archived = ? WHERE id = ?', archived ? 1 : 0, docId);
    },

    /** Set aside: off the shelf, into a tray, with no date on it. It is not the archive, which
     * means he is done with the thing; this means not now.
     */
    setAside(docId, aside = true) {
      run('UPDATE docs SET aside = ? WHERE id = ?', aside ? 1 : 0, docId);
      return this.doc(docId);
    },

    /** Defer until an hour, a condition, or both; the two fields come straight from parseDefer in
     * core/defer.js, so a document and a chat are deferred by the same words. Passing nothing
     * clears it, which is how a tray row is brought back.
     */
    defer(docId, { until = null, condition = null } = {}) {
      const set = Boolean(until || condition);
      run('UPDATE docs SET defer_until = ?, defer_condition = ?, deferred_at = ? WHERE id = ?',
        until || null, condition || null, set ? nowIso() : null, docId);
      return this.doc(docId);
    },

    /** Starred means worth referring back to. It is independent of reading state and of the archive,
     * so a starred document he has finished and archived is still starred.
     */
    star(docId, starred = true) {
      run('UPDATE docs SET starred = ? WHERE id = ?', starred ? 1 : 0, docId);
      return this.doc(docId);
    },

    /** Rebuild every note from the journal. Used after a restore, and by the notes test. */
    rebuildFromJournal(path = journal) {
      const records = readJournal(path);
      const live = new Map();
      for (const record of records.sort((a, b) => (a.seq || 0) - (b.seq || 0))) {
        const h = record.highlight;
        if (!h?.id) continue;
        if (record.op === 'delete') { live.delete(h.id); continue; }
        // An old restore record carried only an id and could not put the note back; a current one
        // carries the whole note, so a deleted-then-restored thread survives the rebuild.
        if (record.op === 'restore' && !h.createdAt) continue;
        live.set(h.id, h);
      }
      run('DELETE FROM highlights');
      run('DELETE FROM note_fts');
      let seq = 0;
      for (const h of live.values()) {
        seq += 1;
        run(`INSERT INTO highlights (id, doc_id, section_idx, kind, color, quote, prefix, suffix,
               start_off, end_off, note, tags, created_at, updated_at, deleted_at, seq, parent_id, author)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,?)`,
          h.id, h.docId, h.sectionIdx || 0, h.kind || 'highlight', h.color || 'yellow', h.quote || '',
          h.prefix || '', h.suffix || '', h.start || 0, h.end || 0, h.note || '', h.tags || '',
          h.createdAt || nowIso(), h.updatedAt || nowIso(), seq, h.parentId || null, asAuthor(h.author));
        run('INSERT INTO note_fts (id, doc_id, quote, note) VALUES (?,?,?,?)', h.id, h.docId, h.quote || '', h.note || '');
      }
      return live.size;
    },

    /** Everything worth keeping about one document, as markdown, for export. */
    exportMarkdown(docId) {
      const doc = this.doc(docId);
      if (!doc) return '';
      const notes = this.highlights(docId);
      const head = [`# ${doc.title || doc.url || docId}`, doc.byline && `by ${doc.byline}`, doc.url, ''].filter(Boolean);
      const body = notes.map((h) => {
        const lines = [`> ${h.quote.replace(/\n+/gu, '\n> ')}`];
        if (h.note) lines.push('', h.note);
        lines.push('', `_${h.kind} - ${h.createdAt}_`, '');
        for (const reply of h.replies || []) lines.push(`- ${reply.author}: ${reply.note}`, '');
        return lines.join('\n');
      });
      return [...head, ...body].join('\n');
    },

    /**
     * Run a batch of writes as one transaction. A book of ten thousand chapters written one
     * statement at a time costs ten thousand fsyncs (the store runs synchronous = FULL for the
     * sake of the notes), which is what made the server stop answering near the end of a long
     * ingest. Notes are unaffected: they have their own journal and are never written in here.
     */
    batch(work) {
      run('BEGIN IMMEDIATE');
      try {
        const answer = work();
        run('COMMIT');
        return answer;
      } catch (cause) {
        try { run('ROLLBACK'); } catch { /* the transaction is already gone */ }
        throw cause;
      }
    },

    /** Fold the write-ahead log back into the database, so a long ingest does not grow it forever. */
    checkpoint() {
      try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* a reader holds it; next time */ }
    },

    close() { releaseJournal(journal); releaseWalStore(path); try { db.close(); } catch { /* already closed */ } }
  };

  return store;
}

/** Only the two values a note can carry; anything else is him. */
/**
 * The document id a conversation's notes live under. One namespace, so a chat can never collide
 * with a saved article's id, and a glance at a doc_id says which kind of thing it is.
 */
export function chatDocId(conversationId) {
  const id = String(conversationId || '').trim();
  return id ? `chat:${id}` : null;
}

export function conversationOfDoc(docId) {
  const id = String(docId || '');
  return id.startsWith('chat:') ? id.slice(5) : null;
}

function asAuthor(value) {
  return value === 'tophat' ? 'tophat' : 'owner';
}

/** What goes into the journal: every column of a note, under the names the journal has used. */
function journalRecord(row) {
  return {
    id: row.id,
    docId: row.doc_id,
    sectionIdx: row.section_idx,
    kind: row.kind,
    color: row.color,
    quote: row.quote,
    prefix: row.prefix,
    suffix: row.suffix,
    start: row.start_off,
    end: row.end_off,
    note: row.note,
    tags: row.tags,
    parentId: row.parent_id || null,
    anchorKey: row.anchor_key || null,
    author: asAuthor(row.author),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/** A reply as the card shows it: who said what, and when. */
function shapeReply(row) {
  return {
    id: row.id,
    note: row.note,
    author: asAuthor(row.author),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function attachReplies(rootRows, replyRows) {
  const byParent = new Map();
  for (const row of replyRows) {
    const list = byParent.get(row.parent_id);
    if (list) list.push(shapeReply(row));
    else byParent.set(row.parent_id, [shapeReply(row)]);
  }
  return rootRows.map((row) => ({ ...shapeHighlight(row), replies: byParent.get(row.id) || [] }));
}

function shapeHighlight(row) {
  return {
    id: row.id,
    docId: row.doc_id,
    sectionIdx: row.section_idx,
    anchorKey: row.anchor_key || null,
    kind: row.kind,
    color: row.color,
    quote: row.quote,
    prefix: row.prefix,
    suffix: row.suffix,
    start: row.start_off,
    end: row.end_off,
    note: row.note,
    tags: row.tags,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at || null,
    parentId: row.parent_id || null,
    author: asAuthor(row.author),
    replies: []
  };
}

let singleton = null;
export function readerStore() {
  if (!singleton) singleton = openReaderStore();
  return singleton;
}
