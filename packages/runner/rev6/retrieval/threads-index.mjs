// A trigram full-text sidecar over the communication fan-in store (commitment-store.sqlite3), so query.mjs
// readThreads can find candidate messages in tens of milliseconds instead of scanning every payload with LIKE. Used
// only when TOPHAT_REV6_THREADS_FTS names a built sidecar; nothing reads it otherwise. The sidecar holds, per
// message, the fields readThreads scores (subject, conversation title, sender, recipients, text), so the rows it
// returns are a superset of the rows the LIKE scan would have scored above zero, and readThreads applies the same
// scoring to the real payloads: same output.
//   node rev6/retrieval/threads-index.mjs build <store.sqlite3> <sidecar.sqlite>   (about 40 s)
//   node rev6/retrieval/threads-index.mjs refresh <store.sqlite3> <sidecar.sqlite>  (incremental)
import { chmodSync, existsSync, renameSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

// conv_key is a blob holding NUL separators (source\0account\0conversation), so the sidecar keeps it as hex.
const keyText = (k) => Buffer.from(typeof k === 'string' ? Buffer.from(k, 'utf8') : k).toString('hex');
export const keyBytes = (hex) => Buffer.from(hex, 'hex');
export const bodyOf = (m) => [m.subject, m.conversation_title, m.sender, ...(Array.isArray(m.recipients) ? m.recipients : []), m.text].filter((v) => typeof v === 'string').join('\n');
const MARGIN_MS = 3 * 86400000;

function schema(db) {
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS t USING fts5(conv_key UNINDEXED, message_id UNINDEXED, body, tokenize='trigram');
    CREATE TABLE IF NOT EXISTS seen (conv_key TEXT NOT NULL, message_id TEXT NOT NULL, PRIMARY KEY (conv_key, message_id)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);`);
}
function addRows(db, rows) {
  const has = db.prepare('SELECT 1 FROM seen WHERE conv_key = ? AND message_id = ?'), mark = db.prepare('INSERT INTO seen VALUES (?, ?)'), ins = db.prepare('INSERT INTO t(conv_key, message_id, body) VALUES (?, ?, ?)');
  let added = 0, maxTs = '';
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const k = keyText(r.conv_key);
      if (r.source_ts > maxTs) maxTs = r.source_ts;
      if (has.get(k, r.message_id)) continue;
      let m; try { m = JSON.parse(r.payload); } catch { continue; }
      ins.run(k, r.message_id, bodyOf(m)); mark.run(k, r.message_id); added += 1;
    }
    if (maxTs) db.prepare("INSERT INTO meta VALUES ('max_ts', ?) ON CONFLICT(k) DO UPDATE SET v = max(v, excluded.v)").run(maxTs);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return added;
}

/** Full build into a temp file, then an atomic rename over the sidecar. */
export function buildIndex(storePath, sidecarPath) {
  const tmp = `${sidecarPath}.building`;
  rmSync(tmp, { force: true });
  const src = new DatabaseSync(storePath, { readOnly: true }), db = new DatabaseSync(tmp);
  try {
    chmodSync(tmp, 0o600); // message text, as private as the store it copies (0600)
    // A throwaway file renamed into place only when complete, so it needs no rollback journal and no fsync per page; a
    // 64 MB page cache keeps the trigram index's segment merges in memory instead of re-reading them from disk.
    db.exec('PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF; PRAGMA cache_size = -65536; PRAGMA temp_store = MEMORY;');
    schema(db);
    const added = addRows(db, src.prepare('SELECT conv_key, message_id, source_ts, payload FROM messages').iterate());
    db.prepare("INSERT INTO meta VALUES ('built_at', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(new Date().toISOString());
    db.close(); renameSync(tmp, sidecarPath);
    return { added };
  } finally { try { src.close(); } catch { /* closed */ } try { db.close(); } catch { /* closed */ } }
}

/** Adds the messages dated within a few days of the newest indexed one (the store's source_ts index makes this cheap). */
export function refreshIndex(storePath, sidecarPath, { src = null } = {}) {
  const own = !src;
  src ||= new DatabaseSync(storePath, { readOnly: true });
  const db = new DatabaseSync(sidecarPath);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    schema(db);
    const maxTs = db.prepare("SELECT v FROM meta WHERE k = 'max_ts'").get()?.v || '';
    const from = maxTs ? new Date(Date.parse(maxTs) - MARGIN_MS).toISOString() : '';
    return { added: addRows(db, src.prepare('SELECT conv_key, message_id, source_ts, payload FROM messages WHERE source_ts >= ?').iterate(from)) };
  } finally { db.close(); if (own) src.close(); }
}

/**
 * Candidate (conv_key as hex, message_id) pairs whose indexed fields contain any of the terms (case-insensitive substring,
 * the LIKE semantics of the scan it replaces), or null when the sidecar cannot answer (missing, or a term shorter than
 * three characters, which a trigram index cannot look up).
 */
export function candidates(sidecarPath, terms, { need = 1 } = {}) {
  // a term under three characters cannot be looked up, but a row that reaches `need` distinct terms still holds at
  // least need minus (number of short terms) of the long ones, so those alone give a superset while that is >= 1
  const distinct = [...new Set(terms.map((x) => x.toLowerCase()))], long = distinct.filter((t) => t.length >= 3);
  const short = distinct.length - long.length;
  if (!sidecarPath || !existsSync(sidecarPath) || distinct.length !== terms.length || !long.length || need - short < 1) return null;
  need -= short; terms = long;
  let db;
  try {
    db = new DatabaseSync(sidecarPath, { readOnly: true });
    // one index lookup per term, rowids only; a row is read only when enough distinct terms hit it (a substring hit
    // count is an upper bound on the word-boundary score readThreads applies, so nothing it keeps is lost)
    // no ESCAPE clause: FTS5 answers LIKE from the trigram index only without one (with it, 1.5 s instead of 30 ms);
    // a literal % or _ in a term then acts as a wildcard, which can only widen the candidate set
    const hits = new Map(), byTerm = db.prepare('SELECT rowid AS r FROM t WHERE body LIKE ?');
    for (const t of new Set(terms.map((x) => x.toLowerCase()))) for (const { r } of byTerm.all(`%${t}%`)) hits.set(r, (hits.get(r) || 0) + 1);
    const keep = [...hits].filter(([, n]) => n >= need).map(([r]) => r), get = db.prepare('SELECT conv_key, message_id, body FROM t WHERE rowid = ?');
    return keep.map((r) => get.get(r));
  } catch { return null; } finally { try { db?.close(); } catch { /* closed */ } }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, store, sidecar] = process.argv.slice(2);
  if (!['build', 'refresh'].includes(cmd) || !store || !sidecar) { process.stderr.write('usage: threads-index.mjs build|refresh <store.sqlite3> <sidecar.sqlite>\n'); process.exit(2); }
  const t = Date.now(), r = cmd === 'build' ? buildIndex(store, sidecar) : refreshIndex(store, sidecar);
  process.stdout.write(`${JSON.stringify({ cmd, ...r, ms: Date.now() - t })}\n`);
}
