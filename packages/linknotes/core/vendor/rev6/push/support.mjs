// Note support: how often a fact came up, when it was first and last seen, and how often it was used.
//
// Three parts, one module:
//   1. Reinforcement. A push that sees an arrival restate a fact an earlier note already holds, with the same value,
//      emits {"reinforce": [{"note": N, "sources": [R..]}]} instead of a second note. The cited raw records are appended
//      to note_support (append-only, one row per note and record). A note's support is then every distinct raw record
//      it cites or was reinforced by: `sources` (the count), `first_seen` and `last_seen` (min and max of those records'
//      occurred_at, never the wall clock). A changed value is a new note linked by note_refs (supersede), never a
//      reinforcement: two values are never merged into one row.
//   2. Usage. note_usage is an append-only log of every time a note was shown by a search, opened by a read and cited
//      in a final answer (usage.mjs derives it from the runner's transcripts by code). Idempotent keyed rows.
//   3. Ranking priors. A small multiplicative prior on note hits from support (log of the source count) and recency
//      (half-life decay of last_seen against as_of or the newest candidate), plus an even smaller usage prior behind
//      its own flag. Config has one home: memory-ranking.json beside the store's real path; no file means no priors
//      (search exactly as before). A file missing a key is an error naming the key; no code default exists.
// (how often this ytpe of fact comes up)".
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { ensureCitationIndex } from './store.mjs';

const APPEND_ONLY = (t) => ['UPDATE', 'DELETE'].map((op) => `CREATE TRIGGER IF NOT EXISTS ${t}_append_only_${op.toLowerCase()} BEFORE ${op} ON ${t} BEGIN SELECT RAISE(ABORT, 'append-only: ${t}'); END;`).join('\n');

/** Additive schema: new tables only, no existing row or column is touched (safe on a live store; CREATE IF NOT EXISTS).
 *  The reinforcement table is note_support: the name note_sources belongs to the push store's citation index (store.mjs
 *  ensureCitationIndex: raw id -> citing note, kept by triggers on notes). Stores written before the split hold this table under
 *  that name; migrateLegacySupport renames it at open. */
export const SUPPORT_SCHEMA = `
CREATE TABLE IF NOT EXISTS note_support(note_id TEXT NOT NULL, raw_id TEXT NOT NULL, occurred_at TEXT NOT NULL,
  batch_id TEXT, created_at TEXT NOT NULL, PRIMARY KEY(note_id, raw_id));
CREATE INDEX IF NOT EXISTS note_support_raw ON note_support(raw_id);
CREATE TABLE IF NOT EXISTS note_usage(key TEXT PRIMARY KEY, note_id TEXT NOT NULL, event TEXT NOT NULL CHECK(event IN ('shown','opened','cited')),
  at TEXT NOT NULL, session TEXT, turn TEXT);
CREATE INDEX IF NOT EXISTS note_usage_note ON note_usage(note_id, event);
CREATE TABLE IF NOT EXISTS note_usage_cursor(source TEXT PRIMARY KEY, seq INTEGER NOT NULL, at TEXT NOT NULL);
${APPEND_ONLY('note_support')}
${APPEND_ONLY('note_usage')}`;

export const ensureSupportSchema = (db) => db.exec(SUPPORT_SCHEMA);

/**
 * A store whose note_sources is the old reinforcement table (it has occurred_at) gets it renamed to note_support, with
 * every row kept, and the citation index rebuilt under its own name. Without this, the citation triggers the store adds at
 * open would insert (raw_id, note_id) into the old table and every note write would fail on its NOT NULL occurred_at.
 * Run by the writer at open, outside any transaction, after the store's own open (which may already have attached citation
 * triggers and an index to the old table: they are dropped here). Returns true when it migrated.
 */
export function migrateLegacySupport(db) {
  const cols = db.prepare("SELECT name FROM pragma_table_info('note_sources')").all().map((r) => r.name);
  if (!cols.includes('occurred_at')) return false;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const t of ['note_sources_ins', 'note_sources_upd', 'note_sources_del', 'note_sources_append_only_update', 'note_sources_append_only_delete']) db.exec(`DROP TRIGGER IF EXISTS ${t}`);
    for (const i of ['note_sources_note', 'note_sources_raw']) db.exec(`DROP INDEX IF EXISTS ${i}`);
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='note_support'").get()) {
      db.exec('INSERT OR IGNORE INTO note_support(note_id,raw_id,occurred_at,batch_id,created_at) SELECT note_id,raw_id,occurred_at,batch_id,created_at FROM note_sources');
      db.exec('DROP TABLE note_sources');
    } else db.exec('ALTER TABLE note_sources RENAME TO note_support');
    db.exec(SUPPORT_SCHEMA);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  ensureCitationIndex(db);
  return true;
}
const hasTable = (store, t) => Boolean(store.one("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?", [t]));

// ---- 1. reinforcement
/**
 * Add `sourceRefs` (stored raw ids) as further support of note `noteId`. A record the note already cites, or that already
 * reinforced it, adds nothing (the count is of separate records). Returns { id, op, added, ...support }.
 */
export function reinforceNote(store, noteId, sourceRefs, { batchId = null, now }) {
  const note = store.one('SELECT id,source_refs FROM notes WHERE id=?', [noteId]);
  if (!note) throw new Error(`reinforce: note ${JSON.stringify(noteId)} does not exist`);
  const cited = new Set(typeof note.source_refs === 'string' ? JSON.parse(note.source_refs) : note.source_refs || []);
  let added = 0;
  for (const rid of [...new Set(sourceRefs || [])]) {
    if (cited.has(rid)) continue;
    const raw = store.one('SELECT occurred_at FROM raw_data WHERE id=?', [rid]);
    if (!raw) throw new Error(`reinforce: source ref ${JSON.stringify(rid)} does not name stored raw data`);
    added += Number(store.run('INSERT OR IGNORE INTO note_support(note_id,raw_id,occurred_at,batch_id,created_at) VALUES(?,?,?,?,?)', [noteId, rid, raw.occurred_at, batchId, now]).changes);
  }
  return { id: noteId, op: added ? 'reinforced' : 'unchanged', added, ...(supportOf(store, [noteId]).get(noteId) || {}) };
}

/** Map note id -> { sources, first_seen, last_seen } over the cited and reinforcing raw records. */
export function supportOf(store, ids) {
  const out = new Map();
  ids = [...new Set(ids)].filter(Boolean);
  if (!ids.length) return out;
  const list = JSON.stringify(ids);
  const extra = hasTable(store, 'note_support') ? 'UNION SELECT note_id, raw_id FROM note_support WHERE note_id IN (SELECT value FROM json_each(:ids))' : '';
  const rows = store.all(`SELECT s.nid AS id, COUNT(DISTINCT s.rid) AS n, MIN(COALESCE(r.occurred_at, n.at)) AS first_seen, MAX(COALESCE(r.occurred_at, n.at)) AS last_seen
    FROM (SELECT n2.id AS nid, j.value AS rid FROM notes n2, json_each(n2.source_refs) j WHERE n2.id IN (SELECT value FROM json_each(:ids)) ${extra}) s
    JOIN notes n ON n.id=s.nid LEFT JOIN raw_data r ON r.id=s.rid GROUP BY s.nid`, { ids: list });
  for (const r of rows) out.set(r.id, { sources: r.n, first_seen: r.first_seen, last_seen: r.last_seen });
  for (const id of ids) if (!out.has(id)) { const n = store.one('SELECT at FROM notes WHERE id=?', [id]); if (n) out.set(id, { sources: 1, first_seen: n.at, last_seen: n.at }); }
  return out;
}

/** Map note id -> { shown, opened, cited } from the usage log (empty when the store has none). */
export function usageOf(store, ids) {
  const out = new Map();
  if (!ids.length || !hasTable(store, 'note_usage')) return out;
  for (const r of store.all('SELECT note_id, event, COUNT(*) AS n FROM note_usage WHERE note_id IN (SELECT value FROM json_each(?)) GROUP BY note_id, event', [JSON.stringify([...new Set(ids)])])) {
    const u = out.get(r.note_id) || { shown: 0, opened: 0, cited: 0 };
    u[r.event] = r.n; out.set(r.note_id, u);
  }
  return out;
}

// ---- 3. ranking priors
export const RANKING_CONFIG = 'memory-ranking.json';
export const RANKING_KEYS = ['support_weight', 'recency_weight', 'recency_half_life_days', 'usage_prior', 'usage_weight', 'widen'];
export class RankingConfigError extends Error {}

/** memory-ranking.json beside the store's real path, or null (no priors). Throws on a partial file. */
export function rankingConfigFor(dbPath) {
  if (!dbPath || dbPath === ':memory:') return null;
  let real = String(dbPath);
  try { real = realpathSync(real); } catch { /* not created */ }
  const file = path.join(path.dirname(real), RANKING_CONFIG);
  if (!existsSync(file)) return null;
  let c;
  try { c = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new RankingConfigError(`ranking: ${file} is not readable JSON (${e.message})`); }
  const missing = RANKING_KEYS.filter((k) => c?.[k] === undefined);
  if (missing.length) throw new RankingConfigError(`ranking: ${file} is missing ${missing.map((k) => `\`${k}\``).join(', ')} (no code default exists)`);
  return { ...c, file };
}

const DAY = 86_400_000;
/** The prior multiplier of one note: 1 + w_s ln(sources) + w_r 2^(-age/H) [+ w_u ln(1 + cited + opened/2)]. */
export function priorOf(s, u, ref, cfg) {
  let m = 1 + cfg.support_weight * Math.log(Math.max(1, s?.sources || 1));
  if (s?.last_seen && ref) { const age = Math.max(0, (Date.parse(ref) - Date.parse(s.last_seen)) / DAY); m += cfg.recency_weight * 2 ** (-age / cfg.recency_half_life_days); }
  if (cfg.usage_prior && u) m += cfg.usage_weight * Math.log(1 + (u.cited || 0) + (u.opened || 0) / 2);
  return m;
}

/**
 * Re-rank a search answer's note hits by the priors, and annotate every note hit with its support. `search(widen)` runs
 * the underlying search with its allowance multiplied by `widen` (so a well-supported note just past the cut can enter);
 * the answer is cut back to the requested allowance. Positions turn into scores as 1/(60 + rank), the RRF form the
 * hybrid search already uses, so a prior of +10% moves a hit only past near neighbours. No config: annotation only.
 */
export function withPriors(store, search, { limit = 20, derived = null, asOf = null } = {}, cfg = rankingConfigFor(store.path)) {
  const res = search(cfg ? Math.max(1, cfg.widen) : 1);
  if (!res || !Array.isArray(res.hits)) return res;
  const noteIds = res.hits.filter((h) => h.kind === 'note').map((h) => h.id);
  const support = supportOf(store, noteIds);
  const annotate = (h) => (h.kind === 'note' && support.has(h.id) ? { ...h, support: support.get(h.id) } : h);
  const derivedN = derived === null || derived === undefined || derived === '' ? null : Number(derived);
  if (!cfg) return { ...res, hits: res.hits.map(annotate) };
  const usage = cfg.usage_prior ? usageOf(store, noteIds) : new Map();
  const ref = asOf || [...support.values()].map((s) => s.last_seen).filter(Boolean).sort().at(-1) || null;
  const rerank = (hits) => hits.map((h, i) => ({ h, s: (1 / (60 + i + 1)) * (h.kind === 'note' ? priorOf(support.get(h.id), usage.get(h.id), ref, cfg) : 1), i }))
    .sort((a, b) => b.s - a.s || a.i - b.i).map((x) => annotate(x.h));
  let hits;
  if (derivedN !== null) {
    const raw = res.hits.filter((h) => h.kind === 'raw').slice(0, limit);
    hits = [...raw, ...rerank(res.hits.filter((h) => h.kind !== 'raw')).slice(0, derivedN)];
  } else hits = rerank(res.hits).slice(0, limit);
  return { ...res, hits, coverage: { ...res.coverage, priors: { support_weight: cfg.support_weight, recency_weight: cfg.recency_weight, half_life_days: cfg.recency_half_life_days, usage: Boolean(cfg.usage_prior), widen: cfg.widen, ref } } };
}
