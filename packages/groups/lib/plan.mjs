// Facets and the outline plan: which notes sit under which node of an entity's page. Everything here is a pure
// function of the notes and the facet identities, so every viewer holding the same notes plans the same nodes.
import { nodeKey } from './keys.mjs';

/** The facet for notes that link no facet entity. */
export const OTHER = '~other';
export const DEFAULTS = { leafMax: 12, minFacetNotes: 2, levels: ['month', 'week', 'day', 'size'] };

/**
 * A note: { id, at (ISO), entities: [entity ids it links], scopes?: [groups], body? }.
 * A facet identity: { id (a co-linked entity id, or OTHER), rarity (note count when the facet was first made; never
 * updated) }. Ranking fields (tier, weight, reason) ride on the same objects but never affect membership.
 */

/**
 * The facet a note belongs to: of the facet entities it links, the rarest (lowest frozen rarity, then lowest id);
 * OTHER when it links none. Depends only on the note and the facet identities, never on a ranking.
 */
export function facetOf(note, facets, entity) {
  let best = null;
  const byId = facets instanceof Map ? facets : new Map(facets.map((f) => [f.id, f]));
  for (const e of note.entities || []) {
    if (e === entity) continue;
    const f = byId.get(e);
    if (!f) continue;
    if (!best || f.rarity < best.rarity || (f.rarity === best.rarity && f.id < best.id)) best = f;
  }
  return best ? best.id : OTHER;
}

/**
 * The facet identities for a page: every previous identity kept as it was (rarity frozen), plus each co-linked entity
 * linked by at least `minFacetNotes` of the notes that is not yet a facet, with its current count as rarity. Ranking
 * fields of previous identities are carried over. Facets are never dropped here: a facet with no notes plans no node.
 */
export function facetIdentities(entity, notes, previous = [], { minFacetNotes = DEFAULTS.minFacetNotes } = {}) {
  const out = previous.map((f) => ({ ...f }));
  const have = new Set(out.map((f) => f.id));
  const counts = new Map();
  for (const n of notes) for (const e of new Set(n.entities || [])) if (e !== entity) counts.set(e, (counts.get(e) || 0) + 1);
  for (const [id, c] of [...counts].sort((a, b) => (a[0] < b[0] ? -1 : 1))) if (c >= minFacetNotes && !have.has(id)) out.push({ id, rarity: c });
  return out;
}

const pad = (n) => String(n).padStart(2, '0');
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  return `${y}-W${pad(Math.ceil(((t - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7))}`;
}
const BUCKET = {
  month: (n) => { const d = new Date(n.at); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`; },
  week: (n) => isoWeek(new Date(n.at)),
  day: (n) => new Date(n.at).toISOString().slice(0, 10),
};
const byTime = (a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The outline plan for `entity` over `notes`: a tree of { path, key, noteIds, children }. The root (path '') holds
 * every note; under it one node per facet that has notes (path 'f:<facet id>'); a node with more than `leafMax` notes
 * splits by month, then ISO week, then day, then into chunks of `leafMax` in time order (a level that puts every note
 * in one bucket is skipped). Keys are nodeKey(entity, noteIds, generatorVersion, path).
 */
export function plan(entity, notes, { facets = [], generatorVersion = 'g1', leafMax = DEFAULTS.leafMax, levels = DEFAULTS.levels } = {}) {
  const byFacet = new Map();
  const fmap = new Map(facets.map((f) => [f.id, f]));
  for (const n of notes) { const f = facetOf(n, fmap, entity); if (!byFacet.has(f)) byFacet.set(f, []); byFacet.get(f).push(n); }
  const mk = (path, ns, children = []) => {
    const noteIds = ns.map((n) => n.id).sort();
    return { path, key: nodeKey(entity, noteIds, generatorVersion, path), noteIds, children, notes: children.length ? null : [...ns].sort(byTime) };
  };
  const split = (path, ns, li) => {
    if (ns.length <= leafMax) return mk(path, ns);
    for (let i = li; i < levels.length; i++) {
      const lvl = levels[i];
      const groups = new Map();
      if (lvl === 'size') {
        const sorted = [...ns].sort(byTime);
        for (let k = 0; k * leafMax < sorted.length; k++) groups.set(`c${k}`, sorted.slice(k * leafMax, (k + 1) * leafMax));
      } else for (const n of ns) { const b = BUCKET[lvl](n); if (!groups.has(b)) groups.set(b, []); groups.get(b).push(n); }
      if (groups.size < 2) continue;
      const kids = [...groups.keys()].sort().map((b) => split(`${path}/${lvl}:${b}`, groups.get(b), i + 1));
      return mk(path, ns, kids);
    }
    return mk(path, ns);
  };
  const kids = [...byFacet.keys()].sort().map((f) => split(`f:${f}`, byFacet.get(f), 0));
  return mk('', notes, kids);
}

/** Every node of a plan, parents before children. */
export function walk(root) { const out = []; const go = (n) => { out.push(n); n.children.forEach(go); }; go(root); return out; }
