// Offline text search over a replica store (Docstore3 rule 2: derived queries run off the interactive thread with a
// deadline and a limit, and say how much they covered). Every query token must appear in a partition's title or
// in its records; a title hit scores `titleWeight`, each matching record 1. The answer carries `complete` and
// `scanned`, so a caller never shows a partial answer as a full one.
//
//     textOf: (rec) => rec.text,                          // what of a record is searchable
//     titles: [{ id: 'doc-1', title: 'Onda tank' }],      // partitions by title (optional)
//     deadlineMs: 1500, limit: 40 })
//   // r = { hits: [{ part, score, best: { text, key } }], complete, scanned, ms }

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'is', 'it', 'for', 'on', 'that', 'with', 'we', 'i']);

export function tokenize(text) {
  return String(text || '').toLowerCase().split(/[^\p{L}\p{N}_.-]+/u).filter((t) => t.length > 1 && !STOP.has(t));
}

export function excerpt(text, token, radius = 60) {
  const s = String(text || ''), i = s.toLowerCase().indexOf(String(token).toLowerCase());
  if (i === -1) return s.slice(0, radius * 2);
  return `${i > radius ? '…' : ''}${s.slice(Math.max(0, i - radius), i + radius)}`;
}

export async function searchStore(store, query, { textOf = (r) => (typeof r?.text === 'string' ? r.text : ''), partOf = (r) => r?.part, keyOf = (r) => r?.key,
  titles = [], only = null, skip = () => false, titleWeight = 6, limit = 40, deadlineMs = 1500, maxRecords = 500_000, now = () => Date.now() } = {}) {
  const tokens = tokenize(query);
  if (!tokens.length) return { hits: [], complete: true, scanned: 0, ms: 0 };
  const found = new Map(); // part -> { tokens:Set, score, best }
  const started = now();
  let scanned = 0, complete = true;
  await store.scanNewest((rec) => {
    scanned += 1;
    if ((scanned & 255) === 0 && now() - started > deadlineMs) { complete = false; return false; }
    if (scanned >= maxRecords) { complete = false; return false; }
    const part = partOf(rec);
    if (only != null && part !== only) return true;
    if (skip(rec)) return true;
    const text = textOf(rec);
    if (!text) return true;
    const lower = text.toLowerCase();
    let n = 0, entry = null;
    for (const t of tokens) {
      if (!lower.includes(t)) continue;
      n += 1;
      entry ||= found.get(part) || { tokens: new Set(), score: 0, best: null };
      entry.tokens.add(t); entry.score += 1;
    }
    if (entry) { if (!entry.best || n > entry.best.n) entry.best = { text, key: keyOf(rec), n }; found.set(part, entry); }
    return true;
  });
  for (const row of titles) {
    if (only != null && row.id !== only) continue;
    const title = String(row.title || '').toLowerCase();
    for (const t of tokens) {
      if (!title.includes(t)) continue;
      const entry = found.get(row.id) || { tokens: new Set(), score: 0, best: null };
      entry.tokens.add(t); entry.score += titleWeight; found.set(row.id, entry);
    }
  }
  const hits = [];
  for (const [part, e] of found) {
    if (e.tokens.size < tokens.length) continue;
    const text = e.best?.text || '';
    const around = [...tokens].reverse().find((t) => text.toLowerCase().includes(t)) || tokens[0];
    hits.push({ part, score: e.score, best: e.best ? { text, key: e.best.key, excerpt: excerpt(text, around) } : null });
  }
  hits.sort((a, b) => b.score - a.score || (String(a.part) < String(b.part) ? -1 : 1));
  return { hits: hits.slice(0, limit), complete, scanned, ms: now() - started, tokens };
}
