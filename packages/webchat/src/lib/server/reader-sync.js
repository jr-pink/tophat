// The reader's offline set, and the replay of what a device did while it could not reach us.
//
// locally. so that even if the server is down i can still read stuff... offline "first" multiplayer
// "first"...
//
// Two halves. manifest() tells a device every document's row and a version for each, plus which
// of them belong in the offline set (read, saved or touched in the past week, starred, or on the
// live shelf, which is the reader's inbox); bodies() hands over everything needed to open one with
// no server: every section's HTML (a book's chapters parsed out of the file), links, every note
// thread, reading positions, and the book-internal assets the HTML points at. applyOps() replays
// a device's op log. Each op carries a client id, so a replay is idempotent; notes are an add-wins
// set keyed by client-minted ids, flags and positions are last-writer-wins per field by the
// instant the device recorded, and a delete only removes the version the device had seen.
//
// Nothing here bypasses the store: every note still goes journal first, fsynced, then the row.
// What loses a last-writer-wins race is not thrown away either; it is appended, fsynced, to
// reader-conflicts.jsonl beside the journal.

import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { conversationOfDoc } from './reader-store.js';

export const OFFLINE_WINDOW_MS = 7 * 86_400_000;
const FIELDS = ['starred', 'archived', 'aside', 'defer', 'status'];
const prepared = new WeakMap();

export function ensureSyncTables(store) {
  if (prepared.has(store)) return;
  store.db.exec(`CREATE TABLE IF NOT EXISTS reader_sync_ops (
    op_id TEXT PRIMARY KEY, device TEXT, kind TEXT, at TEXT, applied_at TEXT NOT NULL, result TEXT NOT NULL DEFAULT '{}')`);
  store.db.exec(`CREATE TABLE IF NOT EXISTS reader_doc_fields (
    doc_id TEXT NOT NULL, field TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (doc_id, field))`);
  prepared.set(store, true);
}

const iso = (value) => {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

/** When each field of a document was last set, so an older offline write cannot undo a newer one. */
export function stampFields(store, docId, body, at = new Date().toISOString()) {
  ensureSyncTables(store);
  const write = store.db.prepare(`INSERT INTO reader_doc_fields (doc_id, field, at) VALUES (?,?,?)
    ON CONFLICT(doc_id, field) DO UPDATE SET at = excluded.at WHERE excluded.at > reader_doc_fields.at`);
  for (const field of FIELDS) if (body[field] !== undefined) write.run(docId, field, at);
}

/** Starred, the live shelf (the inbox), or anything saved, changed or read in the window. */
export function inOfflineSet(row, now = Date.now(), windowMs = OFFLINE_WINDOW_MS) {
  if (!row) return false;
  if (row.starred) return true;
  const since = new Date(now - windowMs).toISOString();
  for (const at of [row.added_at, row.updated_at, row.last_read_at, row.read_at]) if (at && at >= since) return true;
  if (row.archived || row.aside) return false;
  const waiting = (row.defer_until && row.defer_until > new Date(now).toISOString())
    || (!row.defer_until && String(row.defer_condition || '') !== '');
  return !waiting;
}

const hash = (value) => createHash('sha1').update(value).digest('hex').slice(0, 16);

/**
 * Every document's row, as the shelf draws it, with a version per row and the offline set marked.
 * The etag changes whenever any version does, so a device that is current pays for one small
 * answer; `since` is that etag.
 */
export function manifest(store, { now = Date.now(), since = null } = {}) {
  ensureSyncTables(store);
  const rows = store.db.prepare(`SELECT d.*, s.status, s.percent, s.section_idx, s.last_read_at, s.chat_id,
      (SELECT MAX(p.updated_at) FROM progress p WHERE p.doc_id = d.id) AS read_at,
      (SELECT COUNT(*) FROM highlights h WHERE h.doc_id = d.id AND h.deleted_at IS NULL AND h.parent_id IS NULL) AS notes,
      (SELECT MAX(h.updated_at) || ':' || COUNT(*) FROM highlights h WHERE h.doc_id = d.id) AS notes_at,
      (SELECT COUNT(*) || ':' || COALESCE(SUM(sec.words), 0) || ':' || COALESCE(SUM(LENGTH(sec.html)), 0)
         FROM sections sec WHERE sec.doc_id = d.id) AS sections_sig,
      (SELECT COALESCE(SUM(LENGTH(sec.html)), 0) FROM sections sec WHERE sec.doc_id = d.id) AS html_bytes
    FROM docs d LEFT JOIN doc_state s ON s.doc_id = d.id
    WHERE d.kind <> 'chat'`).all();
  const docs = rows.map((row) => {
    const { notes_at: notesAt, sections_sig: sig, html_bytes: htmlBytes, ...rest } = row;
    const shaped = { ...rest, meta: safeJson(rest.meta), order_at: rest.read_at || rest.added_at };
    return {
      ...shaped,
      version: hash(JSON.stringify([rest, notesAt, sig])),
      member: inOfflineSet(shaped, now),
      bytes: Number(htmlBytes || 0) || (rest.kind === 'epub' ? Number(rest.words || 0) * 7 : 0)
    };
  });
  const etag = hash(docs.map((doc) => `${doc.id}:${doc.version}:${doc.member ? 1 : 0}`).join('|'));
  if (since && since === etag) return { etag, unchanged: true, now: new Date(now).toISOString() };
  return { etag, now: new Date(now).toISOString(), windowMs: OFFLINE_WINDOW_MS, docs };
}

function safeJson(text) {
  try { return JSON.parse(text || '{}'); } catch { return {}; }
}

/** Book-internal references in a chapter, which the client turns into asset requests. */
export function assetRefs(html) {
  const out = new Set();
  for (const match of String(html || '').matchAll(/(?:src|href)="epub:([^"#]+)/gu)) out.add(match[1]);
  return [...out];
}

/** Everything one document needs to open with nobody answering. */
export function bodies(store, ids, { chapterHtml = null } = {}) {
  const out = [];
  for (const id of ids) {
    const doc = store.doc(id);
    if (!doc) { out.push({ id, missing: true }); continue; }
    const progress = store.progress(id);
    const sections = store.db.prepare('SELECT idx, href, title, words, html FROM sections WHERE doc_id = ? ORDER BY idx').all(id)
      .map((row) => {
        let html = row.html;
        let error = null;
        if (!html && doc.kind === 'epub' && chapterHtml) {
          try { html = chapterHtml(id, row.idx); } catch (cause) { error = cause.message; }
        }
        return { idx: row.idx, href: row.href, title: row.title, words: row.words, html: html || '', error };
      });
    const assets = doc.kind === 'epub' ? [...new Set(sections.flatMap((s) => assetRefs(s.html)))] : [];
    out.push({
      id,
      doc: { ...doc, state: progress.state },
      sections,
      links: store.links(id),
      highlights: store.highlights(id),
      progress,
      assets
    });
  }
  return out;
}

/** What lost a last-writer-wins race, kept: one fsynced line per losing write. */
export function recordConflict(store, record) {
  const path = join(dirname(store.journalPath || join(process.cwd(), 'reader-notes.jsonl')), 'reader-conflicts.jsonl');
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'a');
  try {
    writeSync(fd, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function threadOf(store, id) {
  return store.thread(id);
}

/** One op, applied under the merge rules above; returns what the original route would have answered. */
function applyOne(store, op) {
  const at = iso(op.at) || new Date().toISOString();
  const p = op.payload || {};
  switch (op.kind) {
    case 'note.save': {
      if (!p.id) return { ok: false, error: 'a note op needs its client id', permanent: true };
      const existing = store.db.prepare('SELECT * FROM highlights WHERE id = ?').get(String(p.id));
      // Last writer wins on the text of a note; the loser is kept in the conflicts file.
      if (existing && existing.updated_at > at && !existing.deleted_at) {
        recordConflict(store, { kind: 'note.save', reason: 'newer edit already stored', op, current: existing.updated_at });
        const thread = threadOf(store, existing.id);
        return { ok: true, conflict: true, highlight: thread };
      }
      if (!existing && !p.parentId && !p.docId) return { ok: false, error: 'docId is required', permanent: true };
      if (p.parentId && !store.db.prepare('SELECT id FROM highlights WHERE id = ?').get(String(p.parentId))) {
        return { ok: false, error: 'no note to reply to', permanent: true };
      }
      const docId = existing?.doc_id || p.docId;
      const conversationId = conversationOfDoc(docId);
      if (conversationId) store.ensureChatDoc(conversationId, p.docTitle);
      else if (!p.parentId && !existing && !store.doc(docId)) return { ok: false, error: 'no such document', permanent: true };
      // add-wins: saving a note that was deleted elsewhere brings it back (saveHighlight clears deleted_at)
      const saved = store.saveHighlight({
        id: String(p.id),
        parentId: p.parentId || null,
        docId,
        sectionIdx: p.sectionIdx ?? existing?.section_idx ?? 0,
        anchorKey: p.anchorKey,
        kind: p.kind || (p.note ? 'note' : 'highlight'),
        color: p.color || existing?.color || 'yellow',
        quote: p.quote,
        prefix: p.prefix,
        suffix: p.suffix,
        start: p.start,
        end: p.end,
        note: p.note,
        tags: p.tags,
        author: p.author,
        createdAt: existing ? null : at,
        updatedAt: at
      });
      if (!saved) return { ok: false, error: 'no note to reply to', permanent: true };
      return saved.parentId
        ? { ok: true, highlight: store.thread(saved.id), reply: { id: saved.id, note: saved.note, author: saved.author, createdAt: saved.createdAt, updatedAt: saved.updatedAt, parentId: saved.parentId, docId: saved.docId } }
        : { ok: true, highlight: saved };
    }
    case 'note.delete': {
      const existing = store.db.prepare('SELECT * FROM highlights WHERE id = ?').get(String(p.id || ''));
      if (!existing) return { ok: true, gone: true };
      if (existing.deleted_at) return { ok: true, highlight: existing.parent_id ? threadOf(store, existing.parent_id) : null };
      // Add wins: a delete removes only the version the device saw. An edit it never saw survives.
      if (p.seenUpdatedAt && existing.updated_at > p.seenUpdatedAt) {
        recordConflict(store, { kind: 'note.delete', reason: 'note edited after the version this device deleted', op, current: existing.updated_at });
        return { ok: true, conflict: true, highlight: threadOf(store, existing.id) };
      }
      store.deleteHighlight(existing.id);
      return { ok: true, highlight: existing.parent_id ? threadOf(store, existing.parent_id) : null };
    }
    case 'note.restore': {
      const restored = store.restoreHighlight(String(p.id || ''));
      if (!restored) return { ok: false, error: 'no such note', permanent: true };
      return { ok: true, highlight: restored.parentId ? store.thread(restored.id) : restored };
    }
    case 'doc.patch': {
      const docId = String(p.docId || '');
      if (!store.doc(docId)) return { ok: false, error: 'no such document', permanent: true };
      const stamps = new Map(store.db.prepare('SELECT field, at FROM reader_doc_fields WHERE doc_id = ?').all(docId)
        .map((row) => [row.field, row.at]));
      const applied = {};
      const skipped = [];
      for (const field of FIELDS) {
        if (p.fields?.[field] === undefined) continue;
        if ((stamps.get(field) || '') > at) { skipped.push(field); continue; }
        applied[field] = p.fields[field];
      }
      if (applied.status) store.setStatus(docId, String(applied.status));
      if (applied.archived !== undefined) store.archive(docId, Boolean(applied.archived));
      if (applied.starred !== undefined) store.star(docId, Boolean(applied.starred));
      if (applied.aside !== undefined) store.setAside(docId, Boolean(applied.aside));
      if (applied.defer !== undefined) store.defer(docId, applied.defer || {});
      stampFields(store, docId, applied, at);
      if (skipped.length) recordConflict(store, { kind: 'doc.patch', reason: 'field set later elsewhere', fields: skipped, op });
      return { ok: true, doc: store.doc(docId), skipped };
    }
    case 'progress': {
      const docId = String(p.docId || '');
      if (!store.doc(docId)) return { ok: false, error: 'no such document', permanent: true };
      return { ok: true, ...store.markProgress({
        docId, sectionIdx: Number(p.sectionIdx || 0), ratio: Number(p.ratio || 0),
        scrollTop: Number(p.scrollTop || 0), seconds: Math.min(3600, Number(p.seconds || 0)), at
      }) };
    }
    default:
      return { ok: false, error: `unknown op ${op.kind}`, permanent: true };
  }
}

/** Replay a device's ops in order. An op already applied answers what it answered the first time. */
export function applyOps(store, ops = [], { device = null } = {}) {
  ensureSyncTables(store);
  const seen = store.db.prepare('SELECT result FROM reader_sync_ops WHERE op_id = ?');
  const mark = store.db.prepare(`INSERT OR IGNORE INTO reader_sync_ops (op_id, device, kind, at, applied_at, result)
    VALUES (?,?,?,?,?,?)`);
  const results = [];
  for (const op of ops) {
    const opId = String(op?.opId || '');
    if (!opId) { results.push({ opId, ok: false, error: 'an op needs an opId', permanent: true }); continue; }
    const prior = seen.get(opId);
    if (prior) { results.push({ opId, ...safeJson(prior.result), replayed: true }); continue; }
    let result;
    try {
      result = applyOne(store, op);
    } catch (cause) {
      result = { ok: false, error: cause.message };
    }
    // Only a settled answer is remembered; a failure that might pass next time is retried.
    if (result.ok || result.permanent) {
      mark.run(opId, device, String(op.kind || ''), iso(op.at), new Date().toISOString(),
        JSON.stringify({ ok: result.ok, conflict: result.conflict || false, error: result.error || null, permanent: result.permanent || false }));
    }
    results.push({ opId, ...result });
  }
  return results;
}
