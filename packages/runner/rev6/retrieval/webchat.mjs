// The tophat webchat transcripts as a corpus: every owner message and assistant reply in events.sqlite, searched through
// the store's own FTS table (event_fts, porter-stemmed) and joined to the conversation's title and dates.
//
// Why it exists: source_search never indexed these, so "the thing we made last week" was invisible to the one-call
// search. The memory store carries the same turns as raw rows, but without titles, a way to cut by date, or a way to
// tell a final reply from a tool echo.
//
// Read-only. tool.completed rows are not searched: they repeat assistant text and bury it under shell output.
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const KINDS = ['message.user', 'assistant.message'];
const q = (s) => `"${String(s).replace(/"/gu, '""')}"`;
const clipText = (s, n) => { const t = String(s || '').replace(/\s+/gu, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

export const webchatDbPath = (env = process.env) => env.WEBCHAT_DB || env.TOPHAT_WEBCHAT_DB || `${env.TOPHAT_STATE_DIR || `${env.HOME || ''}/.local/state/tophat`}/webchat/events.sqlite`;

function open(path) {
  if (!existsSync(path)) throw Object.assign(new Error('no webchat store'), { code: 'ENOENT' });
  const db = new DatabaseSync(path, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 3000');
  return db;
}

/** Row count of an FTS expression over owner and assistant turns (the sense probe). */
export function webchatCount(expr, { path } = {}) {
  const db = open(path);
  try { return db.prepare('SELECT COUNT(*) AS n FROM event_fts WHERE event_fts MATCH ? AND kind IN (?, ?)').get(expr, ...KINDS).n; } finally { db.close(); }
}

/** Recent conversation titles, for the topic-thread boost (his open threads are named there). */
export function recentTitles(path, { sinceIso, limit = 40 } = {}) {
  const db = open(path);
  try { return db.prepare('SELECT id, title, session_id AS session, updated_at AS at FROM conversations WHERE updated_at >= ? ORDER BY updated_at DESC LIMIT ?').all(sinceIso || '0', limit); } finally { db.close(); }
}

const unitCoverage = (text, units) => (units.length ? units.filter((u) => u.test(text)).length / units.length : 0.5);
const stem = (w) => String(w).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '').slice(0, 5);

/**
 * Ranked turns. terms/phrases are the expanded query; since/until/asOf are ISO instants (asOf also drops anything later);
 * exclude is a list of conversation ids (the current chat is already in the model's context).
 * Returns {hits, ms}. Each hit: {ref, conv, session, title, at, role, snippet, cursor, coverage, inWindow, score}.
 */
export function webchatSearch({ path, terms = [], phrases = [], units = null, since = null, until = null, asOf = null, exclude = [], limit = 12, window = null, newest = false, boostTitles = true }) {
  const t0 = Date.now();
  const clauses = [...phrases.map(q), ...terms.map(q)];
  if (!clauses.length) return { hits: [], ms: 0 };
  const db = open(path);
  try {
    const hi = [until, asOf].filter(Boolean).sort()[0] || null;
    const args = [clauses.join(' OR '), ...KINDS];
    let sql = `SELECT f.cursor AS cursor, f.conversation_id AS conv, f.kind AS kind, e.at AS at, bm25(event_fts) AS rank, substr(f.body, 1, 1800) AS body
      FROM event_fts f JOIN events e ON e.cursor = f.cursor WHERE event_fts MATCH ? AND f.kind IN (?, ?)`;
    if (since) { sql += ' AND e.at >= ?'; args.push(since); }
    if (hi) { sql += ' AND e.at <= ?'; args.push(hi); }
    if (exclude.length) { sql += ` AND f.conversation_id NOT IN (${exclude.map(() => '?').join(',')})`; args.push(...exclude); }
    sql += ' ORDER BY rank LIMIT ?'; args.push(Math.max(limit * 6, 60));
    const rows = db.prepare(sql).all(...args);
    const convs = new Map();
    const title = db.prepare('SELECT title, session_id AS session FROM conversations WHERE id = ?');
    const words = [...new Set([...terms, ...phrases.flatMap((p) => p.split(' '))].map(stem).filter((s) => s.length >= 2))];
    const phraseRx = phrases.length ? new RegExp(phrases.map((p) => p.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace(/ /gu, '[\\s-]+')).join('|'), 'iu') : null;
    const nowMs = Date.parse(asOf || until || new Date().toISOString());
    const scored = rows.map((r, i) => {
      const meta = convs.get(r.conv) || (() => { const m = title.get(r.conv) || { title: '', session: null }; convs.set(r.conv, m); return m; })();
      const hay = `${r.body} ${meta.title}`.toLowerCase();
      const coverage = units ? unitCoverage(hay, units) : (words.length ? words.filter((w) => hay.includes(w)).length / words.length : 0);
      const phraseHit = phraseRx && phraseRx.test(r.body) ? 1 : 0;
      const titleHit = boostTitles && (units ? unitCoverage(meta.title, units) : (words.length && words.filter((w) => meta.title.toLowerCase().includes(w)).length / words.length));
      const ageDays = Math.max(0, (nowMs - Date.parse(r.at)) / 864e5);
      const recency = Math.exp(-ageDays / 14);
      const inWin = window && r.at >= window.since && r.at <= window.until ? 1 : 0;
      const assistantFinal = r.kind === 'assistant.message' && r.body.length > 300 ? 1 : 0;
      const score = 0.8 / (1 + i / 8) + 1.0 * coverage + 0.6 * phraseHit + 0.5 * (titleHit || 0) + (window ? 0.5 * inWin : 0) + (newest ? 0.6 : 0.25) * recency + (window?.collab ? 0.25 * assistantFinal : 0);
      return { ref: `chat:${r.conv}#${r.cursor}`, conv: r.conv, session: meta.session, title: meta.title, at: r.at, role: r.kind === 'message.user' ? 'owner' : 'tophat', cursor: r.cursor,
        snippet: bodySnippet(r.body, words, phrases), coverage, inWindow: Boolean(inWin), score, body: r.body };
    }).sort((a, b) => b.score - a.score || (a.at < b.at ? 1 : -1));
    // One hit per conversation: the best-scoring turn, the later one when scores are close, with how many turns matched and when the last did.
    const groups = new Map();
    for (const h of scored) { const g = groups.get(h.conv) || []; g.push(h); groups.set(h.conv, g); }
    const hits = [];
    for (const g of groups.values()) {
      const top = g[0].score, near = g.filter((h) => top - h.score <= 0.35).sort((a, b) => (a.at < b.at ? 1 : -1))[0];
      hits.push({ ...near, turns: g.length, lastAt: g.reduce((m, h) => (h.at > m ? h.at : m), g[0].at) });
    }
    hits.sort((a, b) => b.score - a.score || (a.at < b.at ? 1 : -1));
    return { hits: hits.slice(0, limit), ms: Date.now() - t0 };
  } finally { db.close(); }
}

/** A window of the text around the densest cluster of query words. */
function bodySnippet(body, words, phrases, n = 260) {
  const text = String(body).replace(/\s+/gu, ' ');
  const low = text.toLowerCase();
  let at = -1;
  for (const p of phrases) { const i = low.indexOf(p); if (i >= 0 && (at < 0 || i < at)) at = i; }
  if (at < 0) for (const w of words) { const i = low.indexOf(w); if (i >= 0 && (at < 0 || i < at)) at = i; }
  let from = Math.max(0, (at < 0 ? 0 : at) - 40);
  if (from > 0) { const sp = text.indexOf(' ', from); if (sp >= 0 && sp - from < 20) from = sp + 1; }
  return clipText(text.slice(from, from + n + 40), n);
}

/** Conversation id and title for each runner session id (the memory store files a webchat turn under its session, not its conversation). */
export function webchatSessions(sessions, { path } = {}) {
  const ids = [...new Set(sessions)].filter(Boolean), out = new Map();
  if (!ids.length) return out;
  const db = open(path);
  try { for (const r of db.prepare(`SELECT id, title, session_id AS session FROM conversations WHERE session_id IN (${ids.map(() => '?').join(',')})`).all(...ids)) out.set(r.session, { conv: r.id, title: r.title }); } finally { db.close(); }
  return out;
}

/** Open a chat ref: the turn itself, and the two turns before it (who asked what, and what was answered). `chat:<conv>` gives the title, dates and the owner's messages. */
export function webchatOpen(ref, { path, chars = 7000 } = {}) {
  const m = /^chat:([0-9a-f-]{8,})(?:#(\d+(?:\.\d+)?))?$/u.exec(String(ref || '').trim());
  if (!m) return { error: `not a chat ref: ${ref}` };
  const db = open(path);
  try {
    const conv = db.prepare('SELECT id, title, created_at, updated_at, session_id FROM conversations WHERE id = ?').get(m[1]);
    if (!conv) return { error: `no conversation ${m[1]}` };
    const head = { conversation: conv.id, title: conv.title, created_at: conv.created_at, updated_at: conv.updated_at, session: conv.session_id };
    const turn = (r) => ({ cursor: r.cursor, at: r.at, role: r.kind === 'message.user' ? 'owner' : 'tophat', text: r.kind === 'message.user' ? userText(r.content) : r.content });
    if (m[2]) {
      const c = Number(m[2]);
      const target = db.prepare('SELECT cursor, kind, at, content FROM events WHERE cursor = ? AND conversation_id = ?').get(c, conv.id);
      if (!target) return { error: `no event ${c} in conversation ${conv.id}` };
      const before = db.prepare('SELECT cursor, kind, at, content FROM events WHERE conversation_id = ? AND cursor < ? AND kind IN (?, ?) ORDER BY cursor DESC LIMIT 2').all(conv.id, c, ...KINDS).reverse();
      return { ...head, turns: [...before, target].map(turn), chars };
    }
    const owner = db.prepare('SELECT cursor, kind, at, content FROM events WHERE conversation_id = ? AND kind = ? ORDER BY cursor LIMIT 60').all(conv.id, 'message.user');
    const last = db.prepare('SELECT cursor, kind, at, content FROM events WHERE conversation_id = ? AND kind = ? ORDER BY cursor DESC LIMIT 2').all(conv.id, 'assistant.message').reverse();
    return { ...head, turns: [...owner.map(turn), ...last.map(turn)], chars };
  } finally { db.close(); }
}

function userText(content) {
  try { const j = JSON.parse(content); return typeof j.text === 'string' ? j.text : content; } catch { return content; }
}
