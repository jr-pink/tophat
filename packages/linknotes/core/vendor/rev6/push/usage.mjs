// Note usage, by code, from the runner's transcripts (runner.sqlite beside the memory store): per note, every time a
// search or read showed it, a read opened it, and the turn's final answer used it. Written to note_usage (support.mjs),
// append-only, one row per (message or turn, event, note), INSERT OR IGNORE, so a re-read window or a second writer
// adds nothing twice; one cursor row says how far the transcripts were read.
//
// What counts, per owner turn (an owner message up to the next one in the same session):
//   shown   a note id in a search/list/read tool result or in the injected search context of the turn;
//   opened  memory_read of kind note, or a search whose `open` names a note (the model asked for its full text), or a
//           memory_read of a raw record a note shown in the same turn cites (the model opened the note's evidence;
//   cited   the final answer (the turn's last assistant text) names the note id, or carries the note's distinctive words:
//           at least 3 of its numbers, names and long words that the owner's own message did not already contain, and at
//           least half of them. A paraphrase that keeps none of them is missed; this is a lower bound.
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ensureSupportSchema } from './support.mjs';

export const NOTE_ID = /\bn_[0-9a-f]{10}\b/gu;
const SHOWS = new Set(['search', 'memory_search', 'memory_list', 'list', 'memory_read', 'read']);
const OPENS_KIND = new Set(['memory_read', 'read']);
const STOP = new Set(('about after again against already among another around because before being below between both cannot could does doing during each either every from further have having here into itself just more most never nothing other ought over owner owner\'s same should since some still such than that their theirs them then there these they this those through under until very were what when where which while whom would your yours with without also only says said told note notes records record shows shown according').split(' '));

/** The runner transcript database beside a memory store (its real path), or null. */
export function runnerDbFor(dbPath) {
  if (!dbPath || dbPath === ':memory:') return null;
  let real = String(dbPath);
  try { real = realpathSync(real); } catch { return null; }
  const f = path.join(path.dirname(real), 'runner.sqlite');
  return existsSync(f) ? f : null;
}

const blocks = (content) => { try { const v = JSON.parse(content); return Array.isArray(v) ? v : [{ type: 'text', text: String(v) }]; } catch { return [{ type: 'text', text: String(content) }]; } };
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (typeof x === 'string' ? x : x?.text ?? '')).join('\n') : c?.text ?? '');
const idsIn = (t) => [...new Set(String(t || '').match(NOTE_ID) || [])];
const tokens = (t) => String(t || '').toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'.$-]*[\p{L}\p{N}]|\p{N}/gu) || [];

/** The distinctive words of a note body: numbers, and words of 5+ letters that are not common, minus the asker's words. */
export function distinctive(body, asked = '') {
  const skip = new Set(tokens(asked));
  return [...new Set(tokens(body).filter((w) => !skip.has(w) && !STOP.has(w) && (/\d/u.test(w) ? w.length >= 2 : w.length >= 5)))];
}
/** Whether an answer uses a note: its id, or ≥3 and ≥ half of its distinctive words. */
export function cites(answer, note, asked = '') {
  if (String(answer).includes(note.id)) return true;
  const d = distinctive(note.body, asked);
  if (d.length < 3) return false;
  const have = new Set(tokens(answer));
  const hit = d.filter((w) => have.has(w)).length;
  return hit >= 3 && hit / d.length >= 0.5;
}

/**
 * Turn a slice of transcript rows ({ seq, session_id, kind, content, created_at }, seq order) into usage events.
 * `closed(turn)` says whether a turn is finished (its answer final). Returns { events, open: [first seq of each unfinished turn] }.
 */
export function eventsFrom(rows, { bodyOf, closed, refsOf = () => [] }) {
  const bySession = new Map();
  for (const r of rows) { if (!bySession.has(r.session_id)) bySession.set(r.session_id, []); bySession.get(r.session_id).push(r); }
  const events = [], open = [];
  for (const [session, list] of bySession) {
    const turns = [];
    for (const r of list) { if (r.kind === 'owner' || !turns.length) turns.push({ start: r.seq, rows: [] }); turns.at(-1).rows.push(r); }
    turns.forEach((t, i) => {
      const done = i < turns.length - 1 || closed(t);
      if (!done) { open.push(t.start); return; }
      const calls = new Map(), seen = new Map(), rawOpened = new Map(); let asked = '', answer = '';
      const add = (ev, id, r, key) => { events.push({ key: `${session}:${key}:${ev}:${id}`, note_id: id, event: ev, at: r.created_at, session, turn: String(t.start) }); if (ev !== 'cited') seen.set(id, true); };
      for (const r of t.rows) {
        const bs = blocks(r.content);
        if (r.kind === 'owner') asked += bs.map((b) => b.text || '').join('\n');
        else if (r.kind === 'injected') for (const id of idsIn(bs.map((b) => b.text || '').join('\n'))) add('shown', id, r, r.seq);
        else if (r.kind === 'assistant') {
          const text = bs.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
          if (text.trim()) answer = text;
          for (const b of bs) if (b.type === 'tool_use') {
            calls.set(b.id, b);
            const inp = b.input || {};
            if (OPENS_KIND.has(b.name) && inp.kind === 'note' && /^n_[0-9a-f]{10}$/u.test(String(inp.id || ''))) add('opened', inp.id, r, r.seq);
            if (b.name === 'search' && inp.open) for (const id of idsIn(inp.open)) add('opened', id, r, r.seq);
            if (OPENS_KIND.has(b.name) && inp.kind === 'raw' && inp.id) rawOpened.set(String(inp.id), r);
          }
        } else if (r.kind === 'tool_result') {
          for (const b of bs) {
            if (b.type !== 'tool_result') continue;
            const call = calls.get(b.tool_use_id);
            if (!call || !SHOWS.has(call.name)) continue;
            for (const id of idsIn(textOf(b.content))) add('shown', id, r, r.seq);
          }
        }
      }
      for (const id of [...seen.keys()]) for (const rid of refsOf(id)) if (rawOpened.has(rid)) { const r = rawOpened.get(rid); add('opened', id, r, `${r.seq}:${rid}`); break; }
      if (!answer) return;
      for (const id of idsIn(answer)) add('cited', id, { created_at: t.rows.at(-1).created_at }, t.start);
      for (const id of seen.keys()) {
        const body = bodyOf(id);
        if (body && cites(answer, { id, body }, asked)) add('cited', id, { created_at: t.rows.at(-1).created_at }, t.start);
      }
    });
  }
  return { events, open };
}

/**
 * Read transcript rows after the cursor and append their usage events to the store. A turn is finished when a later owner
 * message exists or its last row is older than `settleMs`; the cursor stops before the first unfinished turn, so it is
 * read again next time. First run: only rows from `sinceIso` on. Bounded by `maxRows`. Never throws: the answer says why.
 */
export function syncUsage(store, runnerDb, { maxRows = 20000, settleMs = 30 * 60_000, now = new Date().toISOString(), sinceIso = null } = {}) {
  if (!runnerDb) return { ok: true, ran: false, reason: 'no runner.sqlite beside the store' };
  let src;
  try {
    ensureSupportSchema(store.db);
    src = new DatabaseSync(runnerDb, { readOnly: true });
    src.exec('PRAGMA busy_timeout=5000');
    const cur = store.one("SELECT seq FROM note_usage_cursor WHERE source='runner'")?.seq ?? null;
    const start = cur ?? (sinceIso ? (src.prepare('SELECT COALESCE(MIN(seq),1)-1 AS s FROM messages WHERE created_at>=?').get(sinceIso).s) : 0);
    const rows = src.prepare("SELECT seq, session_id, kind, content, created_at FROM messages WHERE seq>? AND kind IN ('owner','assistant','tool_result','injected') ORDER BY seq LIMIT ?").all(start, maxRows);
    if (!rows.length) return { ok: true, ran: true, rows: 0, events: 0, cursor: start };
    const lastAt = Date.parse(now);
    const notes = new Map();
    const bodyOf = (id) => { if (!notes.has(id)) notes.set(id, store.one('SELECT body FROM notes WHERE id=?', [id])?.body ?? null); return notes.get(id); };
    const refsOf = (id) => { const r = store.one('SELECT source_refs FROM notes WHERE id=?', [id])?.source_refs; return Array.isArray(r) ? r : r ? JSON.parse(r) : []; };
    const { events, open } = eventsFrom(rows, { bodyOf, refsOf, closed: (t) => lastAt - Date.parse(t.rows.at(-1).created_at) > settleMs });
    const real = events.filter((e) => bodyOf(e.note_id) !== null);
    // never behind where this read started: a window that is one long unfinished turn moves on (keys keep it idempotent)
    const cursor = open.length && Math.min(...open) - 1 > start ? Math.min(...open) - 1 : open.length && rows.length < maxRows ? start : rows.at(-1).seq;
    let added = 0;
    store.tx(() => {
      for (const e of real) added += Number(store.run('INSERT OR IGNORE INTO note_usage(key,note_id,event,at,session,turn) VALUES(?,?,?,?,?,?)', [e.key, e.note_id, e.event, e.at, e.session, e.turn]).changes);
      store.run("INSERT INTO note_usage_cursor(source,seq,at) VALUES('runner',?,?) ON CONFLICT(source) DO UPDATE SET seq=excluded.seq, at=excluded.at", [Math.max(cursor, start), now]);
    });
    const by = (ev) => real.filter((e) => e.event === ev).length;
    return { ok: true, ran: true, rows: rows.length, events: real.length, added, shown: by('shown'), opened: by('opened'), cited: by('cited'), open_turns: open.length, cursor: Math.max(cursor, start) };
  } catch (e) {
    return { ok: false, ran: true, error: String(e.message).slice(0, 300) };
  } finally { try { src?.close(); } catch { /* closed */ } }
}
