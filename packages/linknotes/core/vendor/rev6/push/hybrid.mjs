// Hybrid memory search: the store's lexical FTS search plus dense embedding retrieval over the derived memory index
// (mem_search: notes, work, entities, pages), fused by reciprocal rank fusion. Same request and answer shape as
// Store.search; raw hits stay lexical (hundreds of thousands of rows; FTS covers them).
//
// Why: lexical search misses paraphrases ("when did I last weigh myself" shares no word with a note about a bodyweight
// reading). A local embedding model closes that gap.
//
// One source of truth: `memory-embeddings.json` beside the store file (its real path, so a symlinked state dir reads the
// same file). No file: no embeddings (lexical only, the store as it always was). A file missing a key is an error that
// names the key; no code default exists for the model, its dims, the endpoint or the fusion constants. `search: false`
// keeps search lexical while the write path still embeds (backfill before the switch is flipped).
//
// The model runs locally behind an OpenAI-compatible /v1/embeddings endpoint (llama-server, a managed LaunchAgent).
// Search embeds the query synchronously (Store.search is synchronous) through a worker thread and Atomics.wait;
// an endpoint that is down or slow costs one bounded wait, then the search answers lexically, says so in
// coverage.dense and logs one stderr warning a minute. Embedding on write (embedPending) is a separate pass after the
// write, bounded in time, and never throws to its caller.
import { readFileSync, realpathSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { ftsQuery, KINDS as KINDS_ALL } from './store.mjs';

export const CONFIG_NAME = 'memory-embeddings.json';
export const CONFIG_KEYS = ['model', 'model_file', 'dims', 'url', 'query_prefix', 'doc_prefix', 'max_chars', 'kinds', 'timeout_ms', 'rrf_k', 'candidates', 'search', 'cycle_max_rows', 'cycle_budget_ms'];
const DERIVED = ['entity', 'note', 'work', 'page'];

export class EmbedConfigError extends Error {}

export function configPathFor(dbPath) {
  let real = String(dbPath);
  try { real = realpathSync(real); } catch { /* not created yet */ }
  return path.join(path.dirname(real), CONFIG_NAME);
}

/** The embeddings config beside the store, or null when there is none (lexical only). Throws on a partial file. */
export function embedConfigFor(dbPath) {
  if (!dbPath || dbPath === ':memory:') return null;
  const file = configPathFor(dbPath);
  if (!existsSync(file)) return null;
  let c;
  try { c = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new EmbedConfigError(`embeddings: ${file} is not readable JSON (${e.message})`); }
  const missing = CONFIG_KEYS.filter((k) => c?.[k] === undefined);
  if (missing.length) throw new EmbedConfigError(`embeddings: ${file} is missing ${missing.map((k) => `\`${k}\``).join(', ')} (no code default exists)`);
  if (!Number.isInteger(c.dims) || c.dims < 8) throw new EmbedConfigError(`embeddings: ${file} dims must be an integer`);
  const kinds = c.kinds.filter((k) => DERIVED.includes(k));
  if (kinds.length !== c.kinds.length) throw new EmbedConfigError(`embeddings: ${file} kinds must be among ${DERIVED.join(', ')}`);
  return { ...c, kinds, file };
}

// ---- warnings: one line a minute per cause, to stderr (callers' stdout is JSON)
const warned = new Map();
function warn(msg) {
  const now = Date.now();
  if (now - (warned.get(msg) || 0) < 60_000) return;
  warned.set(msg, now);
  try { process.stderr.write(`[memory hybrid] ${new Date().toISOString()} ${msg}\n`); } catch { /* closed */ }
}

// ---- the embedding endpoint
const normalize = (arr, dims) => {
  if (!Array.isArray(arr) || arr.length !== dims) throw new Error(`endpoint returned ${Array.isArray(arr) ? arr.length : typeof arr} dims, config says ${dims}`);
  const v = Float32Array.from(arr); let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  s = Math.sqrt(s) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= s;
  return v;
};
const clip = (text, n) => { const t = String(text ?? ''); return t.length > n ? t.slice(0, n) : t; };

/** Embed texts (async, batched by the caller). Returns normalized Float32Arrays; throws on any endpoint error. */
export async function embedTexts(cfg, texts, { timeoutMs = 60_000 } = {}) {
  const r = await fetch(cfg.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: texts, model: cfg.model }), signal: AbortSignal.timeout(timeoutMs) });
  const body = await r.text();
  if (!r.ok) throw Object.assign(new Error(`embeddings endpoint ${r.status}: ${body.slice(0, 200)}`), { status: r.status, body });
  const data = JSON.parse(body).data;
  if (!Array.isArray(data) || data.length !== texts.length) throw new Error(`embeddings endpoint answered ${data?.length} of ${texts.length}`);
  return data.sort((a, b) => a.index - b.index).map((d) => normalize(d.embedding, cfg.dims));
}

// Synchronous query embedding: one long-lived worker per process does the fetch; the caller blocks on Atomics.wait.
const WORKER_SRC = `
const { parentPort } = require('node:worker_threads');
parentPort.on('message', async ({ url, body, timeoutMs, sab }) => {
  const st = new Int32Array(sab, 0, 2), out = new Uint8Array(sab, 8);
  let text;
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(timeoutMs) });
    text = await r.text();
    if (!r.ok) text = JSON.stringify({ error: 'HTTP ' + r.status + ': ' + text.slice(0, 200) });
  } catch (e) { text = JSON.stringify({ error: String((e && e.cause && e.cause.code) || (e && e.name === 'TimeoutError' ? 'timeout' : e && e.message)) }); }
  let bytes = new TextEncoder().encode(text);
  if (bytes.length > out.length) bytes = new TextEncoder().encode(JSON.stringify({ error: 'answer too large' }));
  out.set(bytes); Atomics.store(st, 1, bytes.length); Atomics.store(st, 0, 1); Atomics.notify(st, 0);
});`;
let worker = null;
function queryWorker() {
  if (worker) return worker;
  worker = new Worker(WORKER_SRC, { eval: true });
  worker.unref();
  worker.on('error', () => { worker = null; });
  worker.on('exit', () => { worker = null; });
  return worker;
}
/** Embed one query synchronously; returns a Float32Array or throws with the reason (down, timeout, bad answer). */
export function embedQuerySync(cfg, text) {
  const sab = new SharedArrayBuffer(8 + 512 * 1024);
  const st = new Int32Array(sab, 0, 2);
  queryWorker().postMessage({ url: cfg.url, body: JSON.stringify({ input: [clip(cfg.query_prefix + text, cfg.max_chars)], model: cfg.model }), timeoutMs: cfg.timeout_ms, sab });
  // the first call also pays the worker's start (~20-40 ms); the budget allows for it
  const r = Atomics.wait(st, 0, 0, cfg.timeout_ms + 250);
  if (r === 'timed-out') throw new Error(`no answer within ${cfg.timeout_ms} ms`);
  const msg = JSON.parse(new TextDecoder().decode(new Uint8Array(sab, 8, Atomics.load(st, 1)).slice()));
  if (msg.error) throw new Error(msg.error.message || msg.error);
  return normalize(msg.data?.[0]?.embedding, cfg.dims);
}

// ---- the vector table: one row per indexed (kind, id), keyed to the mem_search row it was embedded from
export const VECTOR_TABLE = `CREATE TABLE IF NOT EXISTS mem_vectors (kind TEXT NOT NULL, id TEXT NOT NULL, model TEXT NOT NULL, src_rowid INTEGER NOT NULL,
  hash TEXT NOT NULL, vec BLOB NOT NULL, embedded_at TEXT NOT NULL, PRIMARY KEY (kind, id));
CREATE INDEX IF NOT EXISTS mem_vectors_model ON mem_vectors(model)`;
const hasTable = (db) => Boolean(db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='mem_vectors'").get());
const hashOf = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);
// rows at the top of mem_search's rowid range whose text is re-hashed each pass (see embedPending)
const REUSE_WINDOW = 256;
const toBlob = (v) => new Uint8Array(v.buffer, v.byteOffset, v.byteLength);

// In-process matrix cache. No commit since the last look (PRAGMA data_version): reused without a query; otherwise
// refreshed by rowid (new rows appended), and a replaced or deleted row forces one full reload.
const caches = new Map();
function matrix(store, cfg) {
  const db = store.db;
  const key = `${store.path}\0${cfg.model}`;
  let c = caches.get(key);
  const version = db.prepare('PRAGMA data_version').get().data_version;
  if (c && c.version === version) return c;
  if (!hasTable(db)) return null;
  const head = db.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(rowid), 0) AS m FROM mem_vectors WHERE model=?').get(cfg.model);
  if (c && c.n === head.n && c.m === head.m) { c.version = version; return c; }
  const load = (after) => db.prepare('SELECT rowid AS r, kind, id, src_rowid, vec FROM mem_vectors WHERE model=? AND rowid>? ORDER BY rowid').all(cfg.model, after);
  let rows, base = null;
  if (c && head.m > c.m) { rows = load(c.m); if (c.n + rows.length === head.n) base = c; else rows = load(0); }
  else rows = load(0);
  const d = cfg.dims, n0 = base ? base.kinds.length : 0;
  const good = rows.filter((row) => row.vec.byteLength === d * 4);
  const mat = new Float32Array((n0 + good.length) * d);
  if (base) mat.set(base.mat.subarray(0, n0 * d));
  const kinds = base ? [...base.kinds] : [], ids = base ? [...base.ids] : [], src = base ? [...base.src] : [];
  good.forEach((row, i) => {
    const b = row.vec;
    mat.set(new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)), (n0 + i) * d);
    kinds.push(row.kind); ids.push(row.id); src.push(row.src_rowid);
  });
  c = { n: head.n, m: head.m, version, mat, kinds, ids, src, codes: Uint8Array.from(kinds, (k) => DERIVED.indexOf(k)) };
  caches.set(key, c);
  return c;
}

/** Top `want` (kind, id) by cosine among `kinds`: brute force over the cached matrix (vectors are unit length). */
export function denseCandidates(store, cfg, qv, kinds, want) {
  const c = matrix(store, cfg);
  if (!c || !c.kinds.length) return [];
  const d = cfg.dims, n = c.kinds.length, mat = c.mat, codes = c.codes;
  const ok = new Uint8Array(DERIVED.length);
  for (const k of kinds) ok[DERIVED.indexOf(k)] = 1;
  const scores = new Float32Array(n).fill(-2);
  for (let i = 0; i < n; i++) {
    if (!ok[codes[i]]) continue;
    let s = 0;
    for (let j = 0, o = i * d; j < d; j++, o++) s += mat[o] * qv[j];
    scores[i] = s;
  }
  const floor = scores.slice().sort()[Math.max(0, n - want)];
  const top = [];
  for (let i = 0; i < n; i++) if (scores[i] > -2 && scores[i] >= floor) top.push(i);
  return top.sort((a, b) => scores[b] - scores[a]).slice(0, want).map((i) => ({ kind: c.kinds[i], id: c.ids[i], src_rowid: c.src[i], score: scores[i] }));
}

// ---- search
const clampLimit = (limit) => Math.max(1, Math.min(parseInt(limit || 20, 10), 200));
function snippetOf(text) {
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ');
  return words.length > 24 ? `${words.slice(0, 24).join(' ')}…` : words.join(' ');
}

const derivedOf = (opts) => (opts.derived !== undefined && opts.derived !== null && opts.derived !== '' && !opts.kind ? Math.max(0, Math.min(parseInt(opts.derived, 10) || 0, 200)) : null);

/**
 * Store.search plus dense retrieval over the derived kinds, fused by reciprocal rank fusion. Same arguments and answer.
 * `derived` (unkinded only): derived memory gets its own allowance beside the `limit` raw hits (rev5 store.search
 * derived=). The derived kinds are ranked on their own here, so neither allowance is cut behind the other's hits (one
 * wide Store.search sliced at 200 returned no derived hit at all once 200 raw rows matched).
 * Neither dense nor `derived`: Store.search's own answer, unchanged.
 */
export function hybridSearch(store, query, opts = {}) {
  const derivedN = derivedOf(opts);
  let cfg = null, cfgError = null;
  try { cfg = embedConfigFor(store.path); } catch (e) { cfgError = e.message; warn(e.message); }
  let dense = Boolean(cfg && cfg.search && (!opts.kind || cfg.kinds.includes(opts.kind)));
  const flag = (r, d) => (d ? { ...r, coverage: { ...r.coverage, dense: d } } : r);
  const errState = cfgError ? { status: 'config_error', detail: cfgError } : null;
  if (!dense && derivedN === null) return flag(store.search(query, opts), errState);
  if (opts.kind === 'raw' || (opts.kind && !DERIVED.includes(opts.kind))) return flag(store.search(query, opts), errState);
  const lexKinds = opts.kind ? [opts.kind] : DERIVED, kinds = dense ? lexKinds.filter((k) => cfg.kinds.includes(k)) : [];
  const limit = clampLimit(opts.limit);
  const t0 = performance.now();
  // the answer's frame first (validation, as_of, coverage) and, unkinded, its raw hits
  const lex = opts.kind ? store.search(query, { ...opts, limit: 1 }) : store.search(query, { ...opts, kind: 'raw' });
  const take = derivedN ?? limit;
  const frame = (hits, d) => ({ ...lex, hits, coverage: { ...lex.coverage, kinds: opts.kind ? [opts.kind] : [...KINDS_ALL], ...(derivedN === null ? {} : { limit, derived: derivedN }), ...(d ? { dense: d } : {}) } });
  const raw = opts.kind ? [] : lex.hits.filter((h) => h.kind === 'raw');
  // unkinded with the raw hits already filling the limit and no derived allowance: Store.search has no derived hit either
  if (derivedN === null && !opts.kind && raw.length >= limit) return frame(raw.slice(0, limit), { status: 'not_needed', detail: 'raw hits fill the limit' });
  if (take === 0) return frame(raw, errState);
  let qv = null, denseState = errState;
  if (dense) {
    try { qv = embedQuerySync(cfg, String(query ?? '')); }
    catch (e) { warn(`dense leg off, lexical only: ${e.message} (${cfg.url})`); dense = false; denseState = { status: 'unavailable', detail: e.message }; }
  }
  if (!dense && derivedN === null) return flag(store.search(query, opts), denseState);
  const want = Math.max(take, dense ? cfg.candidates : take);
  const expr = ftsQuery(String(query).trim(), 16, Boolean(opts.allTerms));
  const lexRows = store.all(`SELECT kind,id,snippet(mem_search,2,'[',']','…',12) AS snip FROM mem_search WHERE mem_search MATCH ? AND kind IN (${lexKinds.map(() => '?').join(',')}) ORDER BY rank LIMIT ?`, [expr, ...lexKinds, dense ? want : 200]);
  const denseRows = dense ? denseCandidates(store, cfg, qv, kinds, want) : [];
  // RRF over the two rankings (score = sum over lists of 1/(k + rank)); with one list this is its own order. Visibility
  // and the as-of cut are applied while taking hits in fused order, exactly as Store.search applies them to its own.
  const k = dense ? cfg.rrf_k : 60;
  const fused = new Map();
  const add = (kind, rawId, rank, extra) => {
    let ident = rawId;
    if (kind === 'entity' || kind === 'page') { try { ident = store.resolveEntity(rawId); } catch { return; } }
    const key = `${kind}|${ident}`;
    const f = fused.get(key) || { kind, ident, score: 0, lexRank: null };
    f.score += 1 / (k + rank);
    Object.assign(f, extra(f));
    fused.set(key, f);
  };
  lexRows.forEach((r, i) => add(r.kind, r.id, i + 1, (f) => ({ snip: f.snip ?? r.snip, lexRank: f.lexRank ?? i + 1 })));
  denseRows.forEach((c, i) => add(c.kind, c.id, i + 1, (f) => ({ src_rowid: f.src_rowid ?? c.src_rowid })));
  const ordered = [...fused.values()].sort((a, b) => b.score - a.score || (a.lexRank ?? 1e9) - (b.lexRank ?? 1e9));
  const derived = [];
  for (const f of ordered) {
    if (derived.length >= take) break;
    const head = store.head(f.kind, f.ident);
    if (!head || (lex.as_of && f.kind === 'note' && (head.at || '') > lex.as_of)) continue;
    let snip = f.snip;
    if (snip === undefined) snip = snippetOf(store.one('SELECT text FROM mem_search WHERE rowid=?', [f.src_rowid])?.text);
    derived.push({ kind: f.kind, snippet: snip, ...head });
  }
  const hits = derivedN === null ? [...raw, ...derived].slice(0, limit) : [...raw, ...derived];
  return frame(hits, dense ? { status: 'ok', model: cfg.model, kinds, lexical_candidates: lexRows.length, dense_candidates: denseRows.length, fusion: `rrf k=${cfg.rrf_k}`, ms: Math.round(performance.now() - t0) } : denseState);
}

// ---- embedding on write and the backfill
/**
 * Embed every derived index row that has no current vector (new, or its text changed since), then drop vectors whose
 * row is gone. Bounded by maxRows and budgetMs; resumable (each batch commits on its own). Never throws: the answer
 * says what happened, so a push write is never blocked or failed by it.
 */
export async function embedPending(store, { maxRows = Infinity, budgetMs = Infinity, batch = 32, onProgress = null, cycle = false } = {}) {
  const started = Date.now();
  let cfg;
  try { cfg = embedConfigFor(store.path); } catch (e) { return { ok: false, ran: false, error: e.message }; }
  if (!cfg) return { ok: true, ran: false, reason: `no ${CONFIG_NAME} beside the store` };
  // the heartbeat's pass after its writes: bounded by the config's per-cycle caps (a model change re-embeds over many cycles
  // or by the backfill command, never inside one minute)
  if (cycle) { maxRows = cfg.cycle_max_rows; budgetMs = cfg.cycle_budget_ms; }
  const left = () => ({ timeoutMs: Math.max(1000, Math.min(60_000, budgetMs - (Date.now() - started))) });
  const out = { ok: true, ran: true, model: cfg.model, embedded: 0, relinked: 0, skipped: 0, pruned: 0, pending: null, ms: 0 };
  try {
    store.db.exec(VECTOR_TABLE);
    const marks = cfg.kinds.map(() => '?').join(',');
    const pendingSql = `SELECT m.rowid AS rid, m.kind, m.id FROM mem_search m WHERE m.kind IN (${marks})
      AND NOT EXISTS (SELECT 1 FROM mem_vectors v WHERE v.kind=m.kind AND v.id=m.id AND v.src_rowid=m.rowid AND v.model=?) LIMIT ?`;
    const textOf = store.db.prepare('SELECT text FROM mem_search WHERE rowid=?');
    const current = store.db.prepare('SELECT hash, model FROM mem_vectors WHERE kind=? AND id=?');
    const relink = store.db.prepare('UPDATE mem_vectors SET src_rowid=? WHERE kind=? AND id=?');
    const put = store.db.prepare('INSERT OR REPLACE INTO mem_vectors(kind,id,model,src_rowid,hash,vec,embedded_at) VALUES(?,?,?,?,?,?,?)');
    // FTS5 gives a re-inserted row max(rowid)+1, so a row rewritten while it held the top rowid keeps its rowid: the
    // rowid alone would call its new text current. The top rows are checked by text hash and unlinked when changed.
    const tail = store.db.prepare(`SELECT m.rowid AS rid, m.kind, m.id, m.text, v.hash FROM mem_search m JOIN mem_vectors v ON v.kind=m.kind AND v.id=m.id AND v.src_rowid=m.rowid
      WHERE m.rowid > (SELECT COALESCE(MAX(rowid), 0) FROM mem_search) - ${REUSE_WINDOW}`).all();
    for (const t of tail) if (hashOf(clip(cfg.doc_prefix + (t.text ?? ''), cfg.max_chars)) !== t.hash) store.db.prepare('UPDATE mem_vectors SET src_rowid=-1 WHERE kind=? AND id=?').run(t.kind, t.id);
    const failed = new Set();
    while (out.embedded + out.skipped < maxRows && Date.now() - started < budgetMs) {
      const rows = store.db.prepare(pendingSql).all(...cfg.kinds, cfg.model, Math.min(batch, maxRows - out.embedded - out.skipped) + failed.size)
        .filter((r) => !failed.has(r.rid)).slice(0, batch);
      if (!rows.length) break;
      const items = [];
      for (const r of rows) {
        const text = clip(cfg.doc_prefix + (textOf.get(r.rid)?.text ?? ''), cfg.max_chars), hash = hashOf(text);
        const cur = current.get(r.kind, r.id);
        if (cur && cur.hash === hash && cur.model === cfg.model) { relink.run(r.rid, r.kind, r.id); out.relinked += 1; continue; }
        items.push({ ...r, text, hash });
      }
      if (!items.length) continue;
      let vecs;
      try { vecs = await embedTexts(cfg, items.map((x) => x.text), left()); }
      catch (e) {
        if (e.status !== 400) throw e;
        // one item too long for the model's context: embed one at a time, halving the text until it fits
        vecs = [];
        for (const it of items) {
          let t = it.text, v = null;
          for (;;) {
            try { [v] = await embedTexts(cfg, [t], left()); break; }
            catch (e2) { if (e2.status !== 400) throw e2; if (t.length <= 40) break; t = t.slice(0, Math.floor(t.length / 2)); }
          }
          vecs.push(v);
        }
      }
      const at = new Date().toISOString();
      store.db.exec('BEGIN IMMEDIATE');
      try {
        items.forEach((it, i) => { if (vecs[i]) { put.run(it.kind, it.id, cfg.model, it.rid, it.hash, toBlob(vecs[i]), at); out.embedded += 1; } else { failed.add(it.rid); out.skipped += 1; } });
        store.db.exec('COMMIT');
      } catch (e) { store.db.exec('ROLLBACK'); throw e; }
      if (onProgress) onProgress(out);
    }
    out.pending = store.db.prepare(`SELECT COUNT(*) AS n FROM (${pendingSql})`).get(...cfg.kinds, cfg.model, 10_000_000).n - failed.size;
    if (out.pending <= 0) {
      out.pending = 0;
      // nothing pending: a vector whose source row is gone belongs to a deleted index row
      out.pruned = Number(store.db.prepare('DELETE FROM mem_vectors WHERE src_rowid NOT IN (SELECT rowid FROM mem_search)').run().changes);
    }
  } catch (e) {
    out.ok = false; out.error = String(e.cause?.code || e.message).slice(0, 300);
    warn(`embedding pass stopped: ${out.error}`);
  }
  out.ms = Date.now() - started;
  return out;
}
