// Public documents ("docs"): the webnotes editor over a store of their own, one per document,
// editable by anyone holding the link.... for now just clone the webnotes thing (bes ure to use the
// same code in backend!) and make it so i can like create google docs. people should have names,
// they can set names on launch...
//
// The bargain is the minted multiplayer room's (src/lib/server/mp.js): the token in the URL is the
// whole credential, 128 random bits, and a token that was never minted is a 404 before anything is
// opened, so a guessed URL can neither read a document nor create one. Minting and the list are
// his alone (the owner session); hooks.server.js keeps them behind it and the handlers check again.
//
// Each document is the notes store (notes-store.js, the same lines model, journal-first fsync,
// Automerge merge, soft delete and history) opened over docs/<token>/notes.sqlite with its journal
// beside it and `notify: false`, so a document's write never reaches his own notes feed. Nothing in
// this module, and nothing a /api/docs/<token> route imports, opens his notes store, his chats or
// anything else of his: a document route is handed the one store its token names.
//
// What the notes store has no column for lives in the registry beside the documents: the title,
// who last wrote each line, and the comment threads. Comments are journalled the same way the lines
// are (append, fsync, then the row), so the journal alone can put them back.
//
// Transclusion (one document, or a block of one, shown live inside another) is the next thing he
// named ("maybe we include a transclusion feature too, eventually"). Not built. The seam is the
// block id: a transcluded block would be a line whose body names `docs:<token>#<line id>`, resolved
// at read time by this module through `docStore(token)`, never by giving one document's route
// another document's store. TODO(transclusion).

import { releaseWalStore, walStore } from './sqlite-checkpointer.js';
import { owner } from '../../../../runner/owner.mjs';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { appendJournalLine } from './journal-append.js';
import { dirname, join } from 'node:path';
import { openNotesStore } from './notes-store.js';
import { webchatStoreDir } from './paths.js';

// New ids are `<10-char ULID timestamp>-<16-char random code>` (Crockford base32, 80 random bits, so the
// link is unguessable; the timestamp is not secret). The 22-char ids minted earlier stay valid.
export const TOKEN_RE = /^(?:[0-9A-HJKMNP-TV-Z]{10}-[0-9A-HJKMNP-TV-Z]{16}|[A-Za-z0-9_-]{22})$/u;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function mintDocId(now = Date.now(), rand = randomBytes) {
  let t = '';
  let n = Math.floor(now);
  for (let i = 0; i < 10; i += 1) { t = CROCKFORD[n % 32] + t; n = Math.floor(n / 32); }
  const r = rand(16);
  let c = '';
  for (let i = 0; i < 16; i += 1) c += CROCKFORD[r[i] % 32];
  return `${t}-${c}`;
}
export const OWNER_NAME = owner();
const MAX_OPEN = 24;
const PRESENCE_TTL_MS = 45_000;
export const LIMITS = Object.freeze({
  bodyBytes: 512 * 1024,       // one write
  lineChars: 20_000,           // one line of a block
  blocksPerWrite: 400,
  linesPerDoc: 50_000,
  commentChars: 8_000,
  quoteChars: 600,
  titleChars: 200,
  nameChars: 40
});

export function docsDir({ env = process.env } = {}) {
  if (env.TOPHAT_DOCS_DIR) return env.TOPHAT_DOCS_DIR;
  return env.TOPHAT_STATE_DIR ? join(env.TOPHAT_STATE_DIR, 'webchat', 'docs') : join(webchatStoreDir({ env }), 'docs');
}

const nowIso = () => new Date().toISOString();

function appendJournal(path, record) {
  // Written before the row, fsynced off the event loop (journal-append.js).
  appendJournalLine(path, record);
}

const REGISTRY_SCHEMA = `
CREATE TABLE IF NOT EXISTS docs (
  token       TEXT PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
);
CREATE TABLE IF NOT EXISTS line_authors (
  token       TEXT NOT NULL,
  line_id     TEXT NOT NULL,
  author      TEXT NOT NULL,
  owner       INTEGER NOT NULL DEFAULT 0,
  at          TEXT NOT NULL,
  PRIMARY KEY (token, line_id)
);
CREATE TABLE IF NOT EXISTS threads (
  id          TEXT PRIMARY KEY,
  token       TEXT NOT NULL,
  line_id     TEXT NOT NULL,
  quote       TEXT NOT NULL DEFAULT '',
  anchor_start INTEGER NOT NULL DEFAULT 0,
  anchor_end   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  author      TEXT NOT NULL,
  owner       INTEGER NOT NULL DEFAULT 0,
  resolved_at TEXT,
  resolved_by TEXT,
  deleted_at  TEXT
);
CREATE INDEX IF NOT EXISTS threads_by_doc ON threads(token, created_at);
CREATE TABLE IF NOT EXISTS comments (
  id          TEXT PRIMARY KEY,
  thread_id   TEXT NOT NULL,
  token       TEXT NOT NULL,
  body        TEXT NOT NULL,
  author      TEXT NOT NULL,
  owner       INTEGER NOT NULL DEFAULT 0,
  client      TEXT,
  created_at  TEXT NOT NULL,
  edited_at   TEXT,
  deleted_at  TEXT
);
CREATE INDEX IF NOT EXISTS comments_by_thread ON comments(thread_id, created_at);
`;

/** A display name as typed: control characters out, whitespace folded, bounded. Never empty. */
export function cleanName(raw) {
  const name = String(raw ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/gu, '')
    .replace(/\s+/gu, ' ').trim().slice(0, LIMITS.nameChars);
  return name || 'anonymous';
}

export function cleanTitle(raw) {
  return String(raw ?? '').replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, LIMITS.titleChars);
}

/**
 * The documents in one directory. Exported as a factory for the tests; the server uses `docs()`.
 */
export function openDocs({ dir = docsDir() } = {}) {
  mkdirSync(dir, { recursive: true });
  const registryPath = join(dir, 'registry.sqlite');
  const registryJournal = join(dir, 'registry-journal.jsonl');
  const db = new DatabaseSync(registryPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  walStore(db, registryPath);
  db.exec(REGISTRY_SCHEMA);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const one = (sql, ...args) => db.prepare(sql).get(...args);

  const open = new Map();           // token -> store, least recently used first
  const readers = new Map();        // token -> Set of send(payload)
  const presence = new Map();       // token -> Map client -> { name, owner, at, line }

  const docDir = (token) => join(dir, token);
  const exists = (token) => TOKEN_RE.test(String(token || '')) && Boolean(one('SELECT 1 AS x FROM docs WHERE token = ? AND deleted_at IS NULL', token));

  function journal(token, record) {
    appendJournal(token ? join(docDir(token), 'meta-journal.jsonl') : registryJournal, { ...record, at: record.at || nowIso() });
  }

  const docShape = (row) => row && ({ token: row.token, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at });

  const api = {
    dir,
    exists,

    /** Mint a document. Only the owner's handler calls this. */
    create({ title = '' } = {}) {
      const token = mintDocId();
      const at = nowIso();
      const clean = cleanTitle(title) || 'Untitled';
      mkdirSync(docDir(token), { recursive: true });
      journal(null, { op: 'doc-create', token, title: clean, at });
      run('INSERT INTO docs (token, title, created_at, updated_at) VALUES (?,?,?,?)', token, clean, at, at);
      // Open the store now, so the files exist and a first visit is a read, not a create.
      api.store(token);
      return docShape(one('SELECT * FROM docs WHERE token = ?', token));
    },

    list() {
      return all('SELECT * FROM docs WHERE deleted_at IS NULL ORDER BY updated_at DESC').map(docShape);
    },

    info(token) {
      if (!exists(token)) return null;
      return docShape(one('SELECT * FROM docs WHERE token = ?', token));
    },

    rename(token, title) {
      if (!exists(token)) return null;
      const clean = cleanTitle(title) || 'Untitled';
      const at = nowIso();
      journal(token, { op: 'doc-title', token, title: clean, at });
      run('UPDATE docs SET title = ?, updated_at = ? WHERE token = ?', clean, at, token);
      return api.info(token);
    },

    /** Soft delete; the files stay. Owner only. */
    remove(token) {
      if (!exists(token)) return false;
      const at = nowIso();
      journal(null, { op: 'doc-delete', token, at });
      run('UPDATE docs SET deleted_at = ? WHERE token = ?', at, token);
      api.closeStore(token);
      return true;
    },

    touch(token) { run('UPDATE docs SET updated_at = ? WHERE token = ?', nowIso(), token); },

    /**
     * The one notes store a token names, or null. This is the only way a document route reaches a
     * store, and it can only ever produce a store under this directory.
     */
    store(token) {
      if (!exists(token)) return null;
      const cached = open.get(token);
      if (cached) { open.delete(token); open.set(token, cached); return cached; }
      const base = docDir(token);
      const store = openNotesStore(join(base, 'notes.sqlite'), { journal: join(base, 'notes-journal.jsonl'), notify: false });
      open.set(token, store);
      while (open.size > MAX_OPEN) {
        const [oldest, stale] = open.entries().next().value;
        open.delete(oldest);
        try { stale.close(); } catch { /* already closed */ }
      }
      return store;
    },

    closeStore(token) {
      const store = open.get(token);
      open.delete(token);
      try { store?.close(); } catch { /* already closed */ }
    },

    // --- who wrote what ------------------------------------------------------------------------

    /** Record the author of every line a write touched (the lines whose updatedAt is from it). */
    attribute(token, lines, who, since) {
      const at = nowIso();
      const touched = (lines || []).filter((line) => line?.id && (!since || String(line.updatedAt || '') >= since));
      if (!touched.length) return 0;
      const insert = db.prepare(`INSERT INTO line_authors (token, line_id, author, owner, at) VALUES (?,?,?,?,?)
        ON CONFLICT(token, line_id) DO UPDATE SET author = excluded.author, owner = excluded.owner, at = excluded.at`);
      db.exec('BEGIN');
      try { for (const line of touched) insert.run(token, line.id, who.name, who.owner ? 1 : 0, at); db.exec('COMMIT'); }
      catch (cause) { db.exec('ROLLBACK'); throw cause; }
      return touched.length;
    },

    /** Blocks with `author` and `authorOwner` on each line, for the page's gutter. */
    decorate(token, blocks) {
      if (!Array.isArray(blocks) || !blocks.length) return blocks;
      const ids = blocks.flatMap((block) => (block?.lines || []).map((line) => line.id)).filter(Boolean);
      if (!ids.length) return blocks;
      const known = new Map();
      for (let i = 0; i < ids.length; i += 500) {
        const slice = ids.slice(i, i + 500);
        for (const row of all(`SELECT line_id, author, owner, at FROM line_authors WHERE token = ? AND line_id IN (${slice.map(() => '?').join(',')})`, token, ...slice)) {
          known.set(row.line_id, row);
        }
      }
      return blocks.map((block) => (block?.lines ? {
        ...block,
        lines: block.lines.map((line) => {
          const row = known.get(line.id);
          return row ? { ...line, author: row.author, authorOwner: row.owner === 1, authoredAt: row.at } : line;
        })
      } : block));
    },

    // --- comments ------------------------------------------------------------------------------

    /**
     * The live threads. With `who` (the reader asking) each carries `canDelete`: the document's owner, or the tab that wrote
     * the thread's first comment, may delete the whole thread (the same rule as deleting one comment).
     */
    threads(token, { resolved = true, who = null } = {}) {
      const threads = all(`SELECT * FROM threads WHERE token = ? AND deleted_at IS NULL ${resolved ? '' : 'AND resolved_at IS NULL'} ORDER BY created_at`, token);
      const comments = all('SELECT * FROM comments WHERE token = ? AND deleted_at IS NULL ORDER BY created_at, id', token);
      const starter = new Map();
      if (who) for (const row of all('SELECT thread_id, client FROM comments WHERE token = ? ORDER BY created_at, id', token)) if (!starter.has(row.thread_id)) starter.set(row.thread_id, row.client);
      const byThread = new Map();
      for (const comment of comments) {
        if (!byThread.has(comment.thread_id)) byThread.set(comment.thread_id, []);
        byThread.get(comment.thread_id).push({
          id: comment.id, body: comment.body, author: comment.author, owner: comment.owner === 1,
          createdAt: comment.created_at, editedAt: comment.edited_at
        });
      }
      return threads.map((row) => ({
        id: row.id, lineId: row.line_id, quote: row.quote, start: row.anchor_start, end: row.anchor_end,
        createdAt: row.created_at, author: row.author, owner: row.owner === 1,
        resolvedAt: row.resolved_at, resolvedBy: row.resolved_by,
        ...(who ? { canDelete: Boolean(who.owner || (who.client && starter.get(row.id) === who.client)) } : {}),
        comments: byThread.get(row.id) || []
      }));
    },

    /** A new thread with its first comment, or a reply on an existing one (`threadId`). */
    comment(token, { threadId = null, id = null, lineId = '', quote = '', start = 0, end = 0, body = '' }, who) {
      if (!exists(token)) return { error: 'No such document', status: 404 };
      const text = String(body ?? '').trim();
      if (!text) return { error: 'empty comment', status: 400 };
      if (text.length > LIMITS.commentChars) return { error: 'comment too long', status: 413 };
      const at = nowIso();
      const commentId = typeof id === 'string' && /^[A-Za-z0-9_-]{6,64}$/u.test(id) ? id : randomUUID();
      // A retried POST carries the same id; the first one stands.
      const prior = one('SELECT thread_id FROM comments WHERE id = ?', commentId);
      if (prior) return { ok: true, threadId: prior.thread_id, id: commentId, duplicate: true };
      let thread = threadId ? one('SELECT * FROM threads WHERE id = ? AND token = ?', String(threadId), token) : null;
      if (thread?.deleted_at) {
        // A reply that was in flight when the thread was deleted: the tombstone wins in either arrival order. The comment is
        // kept (so a replay of it is a duplicate) but is born deleted, and the thread does not come back.
        journal(token, { op: 'comment', token, id: commentId, threadId: thread.id, body: text, author: who.name, owner: who.owner, client: who.client || null, at, deleted: true });
        run(`INSERT INTO comments (id, thread_id, token, body, author, owner, client, created_at, deleted_at) VALUES (?,?,?,?,?,?,?,?,?)`,
          commentId, thread.id, token, text, who.name, who.owner ? 1 : 0, who.client || null, at, thread.deleted_at);
        return { ok: true, threadId: thread.id, id: commentId, deleted: true };
      }
      if (threadId && !thread) {
        // A thread named by the client that does not exist yet is created under that id, so a
        // thread opened offline keeps its identity when its first comment lands.
        if (!/^[A-Za-z0-9_-]{6,64}$/u.test(String(threadId))) return { error: 'bad thread id', status: 400 };
      }
      if (!thread) {
        const line = String(lineId || '').slice(0, 80);
        if (!line) return { error: 'a line is required', status: 400 };
        const newId = threadId ? String(threadId) : randomUUID();
        const q = String(quote ?? '').slice(0, LIMITS.quoteChars);
        const s = Math.max(0, Math.floor(Number(start) || 0));
        const e = Math.max(s, Math.floor(Number(end) || 0));
        journal(token, { op: 'thread-create', token, id: newId, lineId: line, quote: q, start: s, end: e, author: who.name, owner: who.owner, at });
        run(`INSERT INTO threads (id, token, line_id, quote, anchor_start, anchor_end, created_at, author, owner) VALUES (?,?,?,?,?,?,?,?,?)`,
          newId, token, line, q, s, e, at, who.name, who.owner ? 1 : 0);
        thread = one('SELECT * FROM threads WHERE id = ?', newId);
      }
      journal(token, { op: 'comment', token, id: commentId, threadId: thread.id, body: text, author: who.name, owner: who.owner, client: who.client || null, at });
      run(`INSERT INTO comments (id, thread_id, token, body, author, owner, client, created_at) VALUES (?,?,?,?,?,?,?,?)`,
        commentId, thread.id, token, text, who.name, who.owner ? 1 : 0, who.client || null, at);
      // A reply on a resolved thread reopens it, as Google Docs does.
      if (thread.resolved_at) run('UPDATE threads SET resolved_at = NULL, resolved_by = NULL WHERE id = ?', thread.id);
      return { ok: true, threadId: thread.id, id: commentId };
    },

    resolve(token, threadId, resolved, who) {
      const thread = one('SELECT * FROM threads WHERE id = ? AND token = ? AND deleted_at IS NULL', String(threadId || ''), token);
      if (!thread) return { error: 'No such thread', status: 404 };
      const at = nowIso();
      journal(token, { op: resolved ? 'thread-resolve' : 'thread-reopen', token, id: thread.id, by: who.name, at });
      run('UPDATE threads SET resolved_at = ?, resolved_by = ? WHERE id = ?', resolved ? at : null, resolved ? who.name : null, thread.id);
      return { ok: true };
    },

    /** Delete one comment: its author's own client, or the owner. Soft. */
    deleteComment(token, commentId, who) {
      const comment = one('SELECT * FROM comments WHERE id = ? AND token = ? AND deleted_at IS NULL', String(commentId || ''), token);
      if (!comment) return { error: 'No such comment', status: 404 };
      if (!who.owner && !(who.client && comment.client === who.client)) return { error: 'Only its author can delete a comment', status: 403 };
      const at = nowIso();
      journal(token, { op: 'comment-delete', token, id: comment.id, by: who.name, at });
      run('UPDATE comments SET deleted_at = ? WHERE id = ?', at, comment.id);
      const left = one('SELECT COUNT(*) AS n FROM comments WHERE thread_id = ? AND deleted_at IS NULL', comment.thread_id).n;
      if (!left) run('UPDATE threads SET deleted_at = ? WHERE id = ?', at, comment.thread_id);
      return { ok: true };
    },

    /**
     * Delete a whole thread, its anchor and every reply: the owner, or the tab that wrote its first comment. A soft delete, a
     * tombstone: the thread and its comments keep their rows with `deleted_at`, so a reply still in flight lands as deleted
     * and a replay of the delete (the op log delivers at least once) is the same answer, whoever replays it.
     */
    deleteThread(token, threadId, who) {
      const id = String(threadId || '');
      const thread = one('SELECT * FROM threads WHERE id = ? AND token = ?', id, token);
      if (!thread) return { error: 'No such thread', status: 404 };
      if (thread.deleted_at) return { ok: true, duplicate: true };
      const first = one('SELECT client FROM comments WHERE thread_id = ? ORDER BY created_at, id LIMIT 1', thread.id);
      if (!who.owner && !(who.client && first?.client === who.client)) return { error: 'Only its author can delete a thread', status: 403 };
      const at = nowIso();
      journal(token, { op: 'thread-delete', token, id: thread.id, by: who.name, at });
      run('UPDATE comments SET deleted_at = ? WHERE thread_id = ? AND deleted_at IS NULL', at, thread.id);
      run('UPDATE threads SET deleted_at = ? WHERE id = ?', at, thread.id);
      return { ok: true };
    },

    // --- live: readers and presence -------------------------------------------------------------

    addReader(token, send) {
      if (!readers.has(token)) readers.set(token, new Set());
      readers.get(token).add(send);
      return () => { readers.get(token)?.delete(send); if (!readers.get(token)?.size) readers.delete(token); };
    },

    broadcast(token, payload) {
      for (const send of readers.get(token) || []) { try { send(payload); } catch { /* a dead reader */ } }
    },

    // `cursor` is the tab's caret and selection (doc-presence.js cleanCursor), ephemeral: kept in
    // memory with the rest of presence, never written to the document. undefined keeps the last one.
    here(token, client, { name, owner = false, line = null, cursor } = {}) {
      if (!presence.has(token)) presence.set(token, new Map());
      const room = presence.get(token);
      if (client) {
        const prior = room.get(client);
        room.set(client, {
          name: name ?? prior?.name ?? 'anonymous', owner, line: line ?? prior?.line ?? null,
          cursor: cursor === undefined ? prior?.cursor ?? null : cursor, at: Date.now()
        });
      }
      const cutoff = Date.now() - PRESENCE_TTL_MS;
      for (const [id, entry] of room) if (entry.at < cutoff) room.delete(id);
      return [...room.entries()].map(([id, entry]) => ({ client: id, name: entry.name, owner: entry.owner, line: entry.line, cursor: entry.cursor || null }));
    },

    leave(token, client) { presence.get(token)?.delete(client); },

    close() {
      for (const token of [...open.keys()]) api.closeStore(token);
      releaseWalStore(registryPath);
      try { db.close(); } catch { /* closed */ }
    }
  };
  return api;
}

let shared = null;
export function docs() {
  if (!shared) shared = openDocs();
  return shared;
}
export function resetDocs() {
  try { shared?.close(); } catch { /* closed */ }
  shared = null;
}
/** Whether a token names a live document; hooks.server.js asks this before serving the page. */
export const hasDoc = (token) => docs().exists(token);

// --- rate limits -------------------------------------------------------------------------------

const buckets = new Map();
/** A token bucket per key: `burst` at once, refilled at `perSecond`. */
export function allow(key, { perSecond = 20, burst = 80 } = {}) {
  const now = Date.now();
  const bucket = buckets.get(key) || { tokens: burst, at: now };
  bucket.tokens = Math.min(burst, bucket.tokens + ((now - bucket.at) / 1000) * perSecond);
  bucket.at = now;
  if (buckets.size > 10_000) buckets.clear();
  if (bucket.tokens < 1) { buckets.set(key, bucket); return false; }
  bucket.tokens -= 1;
  buckets.set(key, bucket);
  return true;
}

