// Ranking and page layout. A cheap injected model ranks facets into tiers on every build (the ranking is never frozen
// and never changes which notes sit in which facet); the layout then splits the page budget by tier fractions and,
// within a tier, by importance weight times sqrt(note count), with floors, a per-facet ceiling and a recency floor.

export const TIERS = ['background', 'current', 'detail'];
export const LAYOUT = {
  fractions: { background: 0.25, current: 0.45, detail: 0.30 },
  backgroundFloor: 0.03,   // each background facet gets at least this fraction of the budget
  ceiling: 0.30,           // no facet takes more than this fraction of the budget
  recencyFacets: 3,        // the most active facets ...
  recencySlot: 0.04,       // ... each get at least this fraction, whatever their tier
  recentDays: 30,          // activity = notes in the last recentDays before the newest note
};

/**
 * Candidates for the ranker: one per facet with notes, { id, rarity, noteCount, recentCount, lastAt }.
 * `facetOfNote(note)` gives a note's facet id (plan.facetOf bound to the facet identities).
 */
export function facetCandidates(notes, facets, facetOfNote, { recentDays = LAYOUT.recentDays } = {}) {
  const newest = notes.reduce((m, n) => (n.at > m ? n.at : m), '');
  const since = newest ? new Date(Date.parse(newest) - recentDays * 86400000).toISOString() : '';
  const by = new Map();
  for (const n of notes) {
    const id = facetOfNote(n);
    const c = by.get(id) || { id, rarity: facets.find((f) => f.id === id)?.rarity ?? null, noteCount: 0, recentCount: 0, lastAt: '' };
    c.noteCount++; if (n.at >= since) c.recentCount++; if (n.at > c.lastAt) c.lastAt = n.at;
    by.set(id, c);
  }
  return [...by.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

/**
 * Re-rank: rankFacets(candidates) -> [{ id, tier, weight?, reason? }] (may be async). Returns the facet identities
 * with tier, weight (default 1) and reason replaced; identity and rarity untouched; an unranked facet is 'detail'.
 */
export async function rerank(facets, candidates, rankFacets) {
  const ranked = new Map(((await rankFacets(candidates)) || []).map((r) => [r.id, r]));
  const out = facets.map((f) => {
    const r = ranked.get(f.id);
    const tier = TIERS.includes(r?.tier) ? r.tier : 'detail';
    return { id: f.id, rarity: f.rarity, tier, weight: Number.isFinite(r?.weight) && r.weight > 0 ? r.weight : 1, reason: String(r?.reason ?? '').slice(0, 200) };
  });
  return out;
}

/**
 * Allocate `budget` units (characters, lines: the caller's unit) to facets.
 *   facets: [{ id, tier, weight, count, recent?, maxUnits? }]
 * Each facet is held under min(maxUnits, ceiling * budget). Floors first: each background facet backgroundFloor,
 * and the `recencyFacets` facets with the most recent notes recencySlot each (whatever their tier). Then the current
 * tier fills its fraction, proportional to weight * sqrt(count); what it cannot use flows to detail, then to
 * background. Returns { units: { id: n }, unused }.
 */
export function allocate(facets, budget, opts = {}) {
  const o = { ...LAYOUT, ...opts, fractions: { ...LAYOUT.fractions, ...(opts.fractions || {}) } };
  const B = Math.max(0, Math.floor(budget));
  const ceil = Math.floor(o.ceiling * B);
  const cap = (f) => Math.max(0, Math.min(f.maxUnits ?? Infinity, ceil));
  const units = {};
  for (const f of facets) units[f.id] = 0;
  const raise = (f, n) => { units[f.id] = Math.max(units[f.id], Math.min(cap(f), n)); };
  for (const f of facets) if (f.tier === 'background') raise(f, Math.floor(o.backgroundFloor * B));
  const active = facets.filter((f) => (f.recent ?? 0) > 0).sort((a, b) => b.recent - a.recent || (a.id < b.id ? -1 : 1)).slice(0, o.recencyFacets);
  for (const f of active) raise(f, Math.floor(o.recencySlot * B));
  let floors = Object.values(units).reduce((a, b) => a + b, 0);
  if (floors > B) {   // floors alone overrun a tiny budget: scale them down
    const k = B / floors;
    for (const id of Object.keys(units)) units[id] = Math.floor(units[id] * k);
    floors = Object.values(units).reduce((a, b) => a + b, 0);
  }
  let left = B - floors;
  const fill = (fs, pool) => {
    pool = Math.min(pool, left);
    let rem = pool;
    let act = fs.filter((f) => cap(f) - units[f.id] > 0 && (f.weight ?? 1) > 0);
    const w = (f) => (f.weight ?? 1) * Math.sqrt(Math.max(0, f.count ?? 0));
    act = act.filter((f) => w(f) > 0);
    while (rem > 0 && act.length) {
      const W = act.reduce((s, f) => s + w(f), 0);
      const share = new Map(act.map((f) => [f.id, (rem * w(f)) / W]));
      const capped = act.filter((f) => share.get(f.id) >= cap(f) - units[f.id]);
      if (capped.length) {
        for (const f of capped) { rem -= cap(f) - units[f.id]; units[f.id] = cap(f); }
        act = act.filter((f) => !capped.includes(f));
        continue;
      }
      let given = 0;
      for (const f of act) { const g = Math.floor(share.get(f.id)); units[f.id] += g; given += g; }
      rem -= given;
      const order = [...act].sort((a, b) => (share.get(b.id) % 1) - (share.get(a.id) % 1) || w(b) - w(a) || (a.id < b.id ? -1 : 1));
      for (const f of order) { if (rem <= 0) break; if (units[f.id] < cap(f)) { units[f.id]++; rem--; } }
      break;
    }
    left -= pool - rem;
    return pool - rem;
  };
  const tier = (t) => facets.filter((f) => f.tier === t);
  // a tier's floors are paid out of its own fraction
  const quota = (t) => Math.max(0, Math.floor(o.fractions[t] * B) - tier(t).reduce((s, f) => s + units[f.id], 0));
  const qc = quota('current'), qd = quota('detail');
  const usedC = fill(tier('current'), qc);
  fill(tier('detail'), qd + (qc - usedC));
  fill(tier('background'), left);
  return { units, unused: left };
}

/**
 * Render a page: the always-fresh status section (outside the budget), then facets by tier (background, current,
 * detail) and weight, each cut to its allocation; a facet with room past its own text adds its leaves, newest first.
 *   tree: the plan; texts: Map path -> text; facetList: ranked facets; units: from allocate; status: text; nameOf(id)
 */
export function render({ tree, texts, facetList, units, status = '', nameOf = (id) => id }) {
  const rank = new Map(facetList.map((f) => [f.id, f]));
  const sections = tree.children.map((node) => ({ node, id: node.path.slice(2), f: rank.get(node.path.slice(2)) || { tier: 'detail', weight: 1 } }));
  sections.sort((a, b) => TIERS.indexOf(a.f.tier) - TIERS.indexOf(b.f.tier) || (b.f.weight ?? 1) - (a.f.weight ?? 1) || (a.id < b.id ? -1 : 1));
  const leaves = (n) => (n.children.length ? n.children.flatMap(leaves) : [n]);
  const out = [];
  if (status) out.push(status.trim());
  if (texts.get('')) out.push(texts.get('').trim());
  for (const { node, id } of sections) {
    const room = units[id] ?? 0;
    if (room <= 0) continue;
    const parts = [texts.get(node.path) || ''];
    if (node.children.length) for (const l of leaves(node).reverse()) parts.push(texts.get(l.path) || '');
    let body = '';
    for (const p of parts.filter(Boolean)) { if (body.length >= room) break; body += (body ? '\n' : '') + p; }
    out.push(`## ${nameOf(id)}\n${body.slice(0, room)}`);
  }
  return out.join('\n\n');
}
