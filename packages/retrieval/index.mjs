// @tophat-md/retrieval: one index refresh and one ask path over pluggable corpora.
//
// A corpus is { name, refresh?(ctx) -> Promise<report>, search(query, { terms, limit, ctx }) -> Promise<hit[]> } where a hit is
// { id, title?, text, at?, ref } (ref: something a caller can open: a linknotes id, a file path). Built in:
//   linknotes  the MemoryStore itself (search through the interface; no refresh: the store indexes on write)
//   files     a directory of text files (.md .txt .org .json .jsonl), indexed into a local SQLite FTS5 file, refreshed
//             incrementally by mtime and size
// refresh(cfg) is the ONE refresh job: every corpus with a refresh is refreshed when its own interval (everySeconds, e.g.
// mail every 300 s, notes daily) has passed. ask(query) extracts the rare terms (lib/terms.mjs), asks every corpus in
// parallel, and fuses the ranked lists by reciprocal rank. Register a corpus: registerCorpus('kind', (cfg) => corpus).
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { extractTerms } from './lib/terms.mjs';

const KINDS = new Map();
export function registerCorpus(kind, factory) { KINDS.set(kind, factory); }
export function corpusKinds() { return [...KINDS.keys()]; }

registerCorpus('linknotes', (c) => ({
  name: c.name || 'linknotes',
  async search(query, { limit, ctx }) {
    if (!ctx.store) return [];
    const { hits } = await ctx.store.search(query, { limit });
    return hits.map((h) => ({ id: `${h.kind}:${h.id}`, title: h.name || h.title || h.kind, text: (h.snippet || h.body || '').replace(/\s+/g, ' '), at: h.at || h.occurred_at || h.updated_at || null, ref: { kind: h.kind, id: h.id } }));
  },
}));

const EXT = /\.(md|txt|org|json|jsonl)$/i;
registerCorpus('files', (c) => {
  if (!c.dir || !path.isAbsolute(c.dir)) throw new Error(`corpus ${c.name}: files needs an absolute dir`);
  const dbFile = (ctx) => path.join(ctx.stateDir, `corpus-${c.name}.sqlite`);
  const open = (ctx) => {
    fs.mkdirSync(ctx.stateDir, { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(dbFile(ctx));
    db.exec("CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY, mtime REAL, size INTEGER); CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(path UNINDEXED, title, body, tokenize='porter unicode61');");
    return db;
  };
  const walk = (dir, out = []) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { if (e.name.startsWith('.')) continue; const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, out); else if (EXT.test(e.name)) out.push(p); } return out; };
  return {
    name: c.name,
    async refresh(ctx) {
      const db = open(ctx);
      try {
        const seen = new Set(); let changed = 0, removed = 0;
        db.exec('BEGIN');
        for (const p of walk(c.dir)) {
          const st = fs.statSync(p); seen.add(p);
          if (st.size > (c.maxFileBytes ?? 2_000_000)) continue;
          const row = db.prepare('SELECT mtime, size FROM files WHERE path=?').get(p);
          if (row && row.mtime === st.mtimeMs && row.size === st.size) continue;
          const body = fs.readFileSync(p, 'utf8');
          db.prepare('DELETE FROM fts WHERE path=?').run(p);
          db.prepare('INSERT INTO fts(path,title,body) VALUES(?,?,?)').run(p, path.relative(c.dir, p), body);
          db.prepare('INSERT INTO files(path,mtime,size) VALUES(?,?,?) ON CONFLICT(path) DO UPDATE SET mtime=excluded.mtime, size=excluded.size').run(p, st.mtimeMs, st.size);
          changed++;
        }
        for (const { path: p } of db.prepare('SELECT path FROM files').all()) if (!seen.has(p)) { db.prepare('DELETE FROM fts WHERE path=?').run(p); db.prepare('DELETE FROM files WHERE path=?').run(p); removed++; }
        db.exec('COMMIT');
        return { changed, removed, files: seen.size };
      } catch (e) { try { db.exec('ROLLBACK'); } catch { /* none */ } throw e; } finally { db.close(); }
    },
    async search(query, { terms, limit, ctx }) {
      if (!fs.existsSync(dbFile(ctx))) return [];
      const db = open(ctx);
      try {
        const words = (terms.length ? terms : query.split(/\s+/)).map((t) => t.replace(/"/g, '')).filter(Boolean);
        if (!words.length) return [];
        const q = words.map((t) => `"${t}"`).join(' OR ');
        return db.prepare("SELECT path, title, snippet(fts, 2, '[', ']', '…', 16) AS snip FROM fts WHERE fts MATCH ? ORDER BY rank LIMIT ?").all(q, limit)
          .map((r) => ({ id: `file:${r.path}`, title: r.title, text: r.snip, at: null, ref: { path: r.path } }));
      } finally { db.close(); }
    },
  };
});

const corporaOf = (cfg) => (cfg.corpora || [{ name: 'linknotes', kind: 'linknotes' }]).map((c) => {
  const f = KINDS.get(c.kind);
  if (!f) throw new Error(`unknown corpus kind ${c.kind}; registered: ${corpusKinds().join(', ')}`);
  return { cfg: c, corpus: f({ ...c, name: c.name || c.kind }) };
});
const readState = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return { corpora: {} }; } };

/** The one refresh. cfg: { stateDir, corpora: [{ name, kind, everySeconds?, ...kind config }] } */
export async function refresh(cfg, { now = Date.now(), force = false, store = null } = {}) {
  if (!cfg.stateDir) throw new Error('retrieval config needs stateDir');
  const stateFile = path.join(cfg.stateDir, 'retrieval-state.json'), state = readState(stateFile), out = {};
  for (const { cfg: c, corpus } of corporaOf(cfg)) {
    if (!corpus.refresh) continue;
    const last = state.corpora[corpus.name]?.at ? Date.parse(state.corpora[corpus.name].at) : 0;
    if (!force && c.everySeconds && now - last < c.everySeconds * 1000) { out[corpus.name] = { skipped: 'not due' }; continue; }
    try { out[corpus.name] = await corpus.refresh({ stateDir: cfg.stateDir, store }); state.corpora[corpus.name] = { at: new Date(now).toISOString(), error: null }; }
    catch (e) { out[corpus.name] = { error: e.message }; state.corpora[corpus.name] = { ...(state.corpora[corpus.name] || {}), error: e.message }; }
  }
  fs.mkdirSync(cfg.stateDir, { recursive: true }); const t = `${stateFile}.${process.pid}.tmp`; fs.writeFileSync(t, JSON.stringify(state, null, 1)); fs.renameSync(t, stateFile);
  return out;
}

/** Ask every corpus; fuse by reciprocal rank (k=60). Returns { terms, hits: [{ corpus, score, ...hit }], coverage }. */
export async function ask(query, cfg, { store = null, limit = 20, perCorpus = 20 } = {}) {
  const { terms } = extractTerms(String(query), { max: 6 });
  const ctx = { stateDir: cfg.stateDir, store };
  const lists = await Promise.all(corporaOf(cfg).map(async ({ corpus }) => {
    try { return { name: corpus.name, hits: await corpus.search(String(query), { terms, limit: perCorpus, ctx }) }; } catch (e) { return { name: corpus.name, hits: [], error: e.message }; }
  }));
  const fused = new Map();
  for (const l of lists) l.hits.forEach((h, i) => { const k = `${l.name}\0${h.id}`; const prev = fused.get(k); fused.set(k, { corpus: l.name, ...h, score: (prev?.score ?? 0) + 1 / (60 + i + 1) }); });
  const hits = [...fused.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
  return { query, terms, hits, coverage: lists.map((l) => ({ corpus: l.name, hits: l.hits.length, ...(l.error ? { error: l.error } : {}) })) };
}
