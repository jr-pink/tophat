// Public share links: a reader document or a chat, readable by anyone holding the link, with no
// sign-in.
//
// So a share is a PAIR of rows: one clean, one with his notes and highlights. The two tokens are
// independently random, never derived from each other and never emitted together to a reader, so
// someone holding the clean link has no path to the annotated one. The pair id exists only on this
// side, for revoking both at once; the public page never sees it.
//
// The token itself is the credential, the way a quicklook ULID is. 16 random bytes, base64url.

import { releaseWalStore, walStore } from './sqlite-checkpointer.js';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readerStoreDir } from './reader-store.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS shares (
  token          TEXT PRIMARY KEY,
  pair_id        TEXT NOT NULL,
  kind           TEXT NOT NULL,                    -- doc | chat
  target_id      TEXT NOT NULL,
  with_notes     INTEGER NOT NULL DEFAULT 0,
  title          TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL,
  revoked_at     TEXT,
  views          INTEGER NOT NULL DEFAULT 0,
  last_viewed_at TEXT
);
CREATE INDEX IF NOT EXISTS shares_by_target ON shares(kind, target_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS shares_by_pair ON shares(pair_id);

-- What visitors of an askable chat link asked, and what was answered (src/lib/server/share-ask.js).
-- A row is written as the question is accepted (status 'pending'), which is also what the rate
-- limit counts, then finished with the answer; 'visit' is a random id the visitor's browser keeps,
-- the thread an answer may lean on. 'asker' is a label the visitor typed and can be anything.
CREATE TABLE IF NOT EXISTS share_asks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  token        TEXT NOT NULL,
  visit        TEXT NOT NULL DEFAULT '',
  asker        TEXT NOT NULL DEFAULT '',
  question     TEXT NOT NULL,
  answer       TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'pending',   -- pending | ok | truncated | error
  model        TEXT NOT NULL DEFAULT '',
  cost_usd     REAL NOT NULL DEFAULT 0,
  error        TEXT NOT NULL DEFAULT '',
  asked_at     TEXT NOT NULL,
  answered_at  TEXT
);
CREATE INDEX IF NOT EXISTS share_asks_by_token ON share_asks(token, asked_at);
`;

// An askable link is its own row with ask = 1, minted separately from the clean/notes pair and
// revocable on its own. Existing rows migrate to ask = 0, so every link minted before this stays
// read-only.
function migrate(db) {
  const columns = db.prepare('PRAGMA table_info(shares)').all().map((c) => c.name);
  if (!columns.includes('ask')) db.exec('ALTER TABLE shares ADD COLUMN ask INTEGER NOT NULL DEFAULT 0');
}

/** Visitor questions accepted per token per hour, and per day; at most this many unanswered at once. */
export const ASK_LIMITS = Object.freeze({ perHour: 20, perDay: 100, pending: 2 });
const PENDING_STALE_MS = 10 * 60_000;

const askShape = (row) => ({
  id: row.id, token: row.token, visit: row.visit, asker: row.asker, question: row.question,
  answer: row.answer, status: row.status, model: row.model, costUsd: row.cost_usd,
  error: row.error, askedAt: row.asked_at, answeredAt: row.answered_at || null,
});

export const sharesDbPath = () => join(readerStoreDir(), 'shares.sqlite');

export const newToken = () => randomBytes(16).toString('base64url');

export function openShareStore(path = sharesDbPath()) {
  mkdirSync(readerStoreDir(), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  walStore(db, path);
  db.exec(SCHEMA);
  migrate(db);

  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const one = (sql, ...args) => db.prepare(sql).get(...args) ?? null;
  const run = (sql, ...args) => db.prepare(sql).run(...args);

  const shape = (row) => row && ({
    token: row.token, kind: row.kind, targetId: row.target_id,
    withNotes: !!row.with_notes, ask: !!row.ask, title: row.title,
    createdAt: row.created_at, views: row.views, lastViewedAt: row.last_viewed_at || null,
  });

  return {
    db,

    /**
     * The live pair for a target, minting one the first time. Asking twice gives the same two
     * links, so sharing a chat again does not scatter a new URL into the world each time.
     * Returns { pairId, plain, notes } where plain and notes are tokens.
     */
    pair(kind, targetId, title = '') {
      const rows = all(
        'SELECT * FROM shares WHERE kind = ? AND target_id = ? AND ask = 0 AND revoked_at IS NULL ORDER BY created_at',
        kind, targetId);
      const plain = rows.find((r) => !r.with_notes);
      const notes = rows.find((r) => r.with_notes);
      if (plain && notes && plain.pair_id === notes.pair_id) {
        if (title && title !== plain.title) {
          run('UPDATE shares SET title = ? WHERE pair_id = ?', title, plain.pair_id);
        }
        return { pairId: plain.pair_id, plain: plain.token, notes: notes.token, minted: false };
      }
      // Anything partial (one side revoked, an older half-row) is replaced by a clean pair.
      if (rows.length) run('UPDATE shares SET revoked_at = ? WHERE kind = ? AND target_id = ? AND ask = 0 AND revoked_at IS NULL',
        new Date().toISOString(), kind, targetId);
      const pairId = newToken();
      const at = new Date().toISOString();
      const plainToken = newToken();
      const notesToken = newToken();
      for (const [token, withNotes] of [[plainToken, 0], [notesToken, 1]]) {
        run('INSERT INTO shares (token, pair_id, kind, target_id, with_notes, title, created_at) VALUES (?,?,?,?,?,?,?)',
          token, pairId, kind, targetId, withNotes, title, at);
      }
      return { pairId, plain: plainToken, notes: notesToken, minted: true };
    },

    /** What a visitor's token resolves to, or null. Carries no pair id and no sibling token. */
    resolve(token) {
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{10,64}$/u.test(token)) return null;
      return shape(one('SELECT * FROM shares WHERE token = ? AND revoked_at IS NULL', token));
    },

    /** The clean twin of a notes token, and only in that direction. Going notes -> clean gives away
     * nothing: whoever holds the annotated link already sees everything the clean one shows. The
     * reverse stays impossible, which is the whole point of the pair.
     */
    plainTwinOf(token) {
      const row = one('SELECT * FROM shares WHERE token = ? AND revoked_at IS NULL', token);
      if (!row || !row.with_notes) return null;
      const twin = one('SELECT token FROM shares WHERE pair_id = ? AND with_notes = 0 AND revoked_at IS NULL', row.pair_id);
      return twin?.token || null;
    },

    recordView(token) {
      run('UPDATE shares SET views = views + 1, last_viewed_at = ? WHERE token = ?',
        new Date().toISOString(), token);
    },

    /** Both links for a target, as the owner's UI sees them. */
    forTarget(kind, targetId) {
      return all('SELECT * FROM shares WHERE kind = ? AND target_id = ? AND ask = 0 AND revoked_at IS NULL ORDER BY with_notes',
        kind, targetId).map(shape);
    },

    /** Revoking kills both halves of the read-only pair: a share is withdrawn as one thing. The askable link is separate (revokeAsk). */
    revoke(kind, targetId) {
      const at = new Date().toISOString();
      const changed = run('UPDATE shares SET revoked_at = ? WHERE kind = ? AND target_id = ? AND ask = 0 AND revoked_at IS NULL',
        at, kind, targetId);
      return Number(changed.changes || 0);
    },

    list({ limit = 200 } = {}) {
      return all('SELECT * FROM shares WHERE revoked_at IS NULL ORDER BY created_at DESC LIMIT ?', limit).map(shape);
    },

    // ---------------------------------------------------------------- askable chat links

    /**
     * The live askable link for a chat, minting one the first time. Its own token, its own pair id:
     * nothing ties it to the clean or notes links, and revoking it leaves them alone. Chats only.
     */
    askLink(targetId, title = '') {
      const live = one('SELECT * FROM shares WHERE kind = ? AND target_id = ? AND ask = 1 AND revoked_at IS NULL ORDER BY created_at LIMIT 1',
        'chat', targetId);
      if (live) {
        if (title && title !== live.title) run('UPDATE shares SET title = ? WHERE token = ?', title, live.token);
        return { token: live.token, minted: false };
      }
      const token = newToken();
      run('INSERT INTO shares (token, pair_id, kind, target_id, with_notes, ask, title, created_at) VALUES (?,?,?,?,?,?,?,?)',
        token, newToken(), 'chat', targetId, 0, 1, title, new Date().toISOString());
      return { token, minted: true };
    },

    /** The live askable link for a chat as the owner's UI sees it, or null. */
    askLinkFor(targetId) {
      return shape(one('SELECT * FROM shares WHERE kind = ? AND target_id = ? AND ask = 1 AND revoked_at IS NULL ORDER BY created_at LIMIT 1',
        'chat', targetId));
    },

    /** Withdraw the askable link of a chat. Questions already asked stay in the table for the owner. */
    revokeAsk(targetId) {
      const changed = run('UPDATE shares SET revoked_at = ? WHERE kind = ? AND target_id = ? AND ask = 1 AND revoked_at IS NULL',
        new Date().toISOString(), 'chat', targetId);
      return Number(changed.changes || 0);
    },

    /**
     * Accept one visitor question, or refuse it for the rate limit. The check and the insert are one
     * synchronous step on one connection, so two concurrent requests cannot both take the last slot.
     * Returns { ok: true, id } or { ok: false, reason, retryAfterSec }.
     */
    beginAsk({ token, visit = '', asker = '', question, now = Date.now(), limits = ASK_LIMITS }) {
      const iso = (ms) => new Date(ms).toISOString();
      // A pending row that never finished (the process died mid-answer) stops counting as pending.
      run("UPDATE share_asks SET status = 'error', error = 'abandoned', answered_at = ? WHERE token = ? AND status = 'pending' AND asked_at < ?",
        iso(now), token, iso(now - PENDING_STALE_MS));
      const pending = one("SELECT COUNT(*) AS n FROM share_asks WHERE token = ? AND status = 'pending'", token).n;
      if (pending >= limits.pending) return { ok: false, reason: 'busy', retryAfterSec: 10 };
      const hour = all('SELECT asked_at FROM share_asks WHERE token = ? AND asked_at > ? ORDER BY asked_at', token, iso(now - 3_600_000));
      if (hour.length >= limits.perHour) {
        const oldest = Date.parse(hour[0].asked_at);
        return { ok: false, reason: 'hour', retryAfterSec: Math.max(1, Math.ceil((oldest + 3_600_000 - now) / 1000)) };
      }
      const day = one('SELECT COUNT(*) AS n, MIN(asked_at) AS first FROM share_asks WHERE token = ? AND asked_at > ?', token, iso(now - 86_400_000));
      if (day.n >= limits.perDay) {
        return { ok: false, reason: 'day', retryAfterSec: Math.max(1, Math.ceil((Date.parse(day.first) + 86_400_000 - now) / 1000)) };
      }
      const info = run('INSERT INTO share_asks (token, visit, asker, question, asked_at) VALUES (?,?,?,?,?)',
        token, visit, asker, question, iso(now));
      return { ok: true, id: Number(info.lastInsertRowid) };
    },

    finishAsk(id, { status, answer = '', model = '', costUsd = 0, error = '' }) {
      run('UPDATE share_asks SET status = ?, answer = ?, model = ?, cost_usd = ?, error = ?, answered_at = ? WHERE id = ?',
        status, answer, model, Number(costUsd) || 0, String(error).slice(0, 500), new Date().toISOString(), id);
    },

    /** What one visitor (a browser's visit id) has asked on this token, oldest first. */
    asksOfVisit(token, visit, { limit = 50 } = {}) {
      if (!visit) return [];
      return all('SELECT * FROM (SELECT * FROM share_asks WHERE token = ? AND visit = ? ORDER BY id DESC LIMIT ?) ORDER BY id',
        token, visit, limit).map(askShape);
    },

    /** Everything asked on every askable link a chat has had, newest first: the owner's view. */
    asksForTarget(targetId, { limit = 200 } = {}) {
      return all(`SELECT a.* FROM share_asks a JOIN shares s ON s.token = a.token
                  WHERE s.kind = 'chat' AND s.target_id = ? AND s.ask = 1 ORDER BY a.id DESC LIMIT ?`,
        targetId, limit).map(askShape);
    },

    close() { releaseWalStore(path); try { db.close(); } catch { /* already closed */ } },
  };
}

let singleton = null;
export function shareStore() {
  if (!singleton) singleton = openShareStore();
  return singleton;
}
