// @tophat-md/groups: derived pages shared across groups without sharing anything a reader cannot already read.
//
// Notes are immutable facts linking entities. A page is a derived outline per entity whose nodes each cite the notes
// they rest on; a node's key hashes its sorted note ids, so a node (with its subtree) built by one member is reusable by
// every viewer whose notes under that node are the same. Published nodes are PageNode records stored with the
// audience of their notes (the groups holding all of them); a viewer adopts a record only when the key matches its own,
// it holds every cited note, the signature verifies and the author is a trusted pagewriter. Everything else is
// regenerated: the differing leaves and the path up to the root. The package takes its store, model calls and log as
// arguments and imports no model client and no application code.
import { Clock, audience, keypair, nodeKey, sign, verify } from './lib/keys.mjs';
import { DEFAULTS, OTHER, facetIdentities, facetOf, plan, walk } from './lib/plan.mjs';
import { RECORD_TYPE, decide, materialize, memoryLog, pagewritersFor, pickEarliest, publish, rejectReason, seedFacets, storeLog, trustedAuthor } from './lib/share.mjs';
import { LAYOUT, TIERS, allocate, facetCandidates, render, rerank } from './lib/layout.mjs';

export { Clock, audience, keypair, nodeKey, sign, verify };
export { DEFAULTS, OTHER, facetIdentities, facetOf, plan, walk };
export { RECORD_TYPE, decide, materialize, memoryLog, pagewritersFor, pickEarliest, publish, rejectReason, seedFacets, storeLog, trustedAuthor };
export { LAYOUT, TIERS, allocate, facetCandidates, render, rerank };

/**
 * The viewer's notes on an entity from a MemoryStore (the linknotes interface): every visible note with its
 * co-linked entity ids and its scopes. -> [{ id, at, body, entities, scopes }]
 */
export async function viewerNotes(store, entityId) {
  const e = await store.entity(entityId);
  if (!e?.ok) return [];
  const out = [];
  for (const n of e.notes || []) {
    const r = await store.read('note', n.id);
    const note = r?.note ?? n;
    out.push({ id: n.id, at: note.at ?? n.at, body: note.body ?? n.body, entities: note.entities ?? [], scopes: r?.scopes ?? n.scopes ?? [] });
  }
  return out;
}

/**
 * scopesOf over a note list (for audience and publish). `own`: the viewer's private scope, counted as holding every
 * note in the list: it reaches only the viewer's own devices, which already hold every note the viewer reads. That is
 * what makes an own page an ordinary page whose audience is the viewer alone.
 */
export const scopesFrom = (notes, { own = null } = {}) => {
  const m = new Map(notes.map((n) => [n.id, own ? [...new Set([...(n.scopes || []), own])] : n.scopes || []]));
  return (id) => m.get(id) || [];
};

/**
 * Build one viewer's page for `entity`.
 *   { store?, notes?, entity, published: log entries the viewer can read, trust, generate(part), rankFacets(candidates)?,
 *     author, clock (Clock), privateKey?, facets? (previous identities; default: seeded from a trusted published root),
 *     generatorVersion?, leafMax?, budget? (page units, default 4000), layout? (allocate options), nameOf? }
 * -> { notes, facets, tree, decisions, stats, texts, records (new PageNodes, to publish), units, text }
 * The status section is generate({ kind: 'status', entity, notes: newest few }) on every build, never published.
 */
export async function buildPage(o) {
  const generatorVersion = o.generatorVersion ?? 'g1';
  const notes = o.notes ?? await viewerNotes(o.store, o.entity);
  const prev = o.facets ?? seedFacets(o.published, o.trust, o.entity);
  const identities = facetIdentities(o.entity, notes, prev, { minFacetNotes: o.minFacetNotes });
  const fmap = new Map(identities.map((f) => [f.id, f]));
  const candidates = facetCandidates(notes, identities, (n) => facetOf(n, fmap, o.entity), o.layout);
  const live = new Set(candidates.map((c) => c.id));
  const ranker = o.rankFacets ?? ((cands) => cands.map((c) => ({ id: c.id, tier: 'current', weight: 1, reason: 'unranked' })));
  const ranked = await rerank(identities.filter((f) => live.has(f.id)).concat(live.has(OTHER) ? [{ id: OTHER, rarity: null }] : []), candidates, ranker);
  const facets = identities.map((f) => ({ ...f, ...(ranked.find((r) => r.id === f.id) || {}) }));
  const { tree, decisions, stats } = decide({ entity: o.entity, notes, facets: identities, generatorVersion, leafMax: o.leafMax }, o.published || [], o.trust);
  const { texts, records } = await materialize({ entity: o.entity, tree, decisions, generatorVersion, generate: o.generate, author: o.author, clock: o.clock, privateKey: o.privateKey, facetList: facets });
  const sizeOf = (node) => node.children.reduce((s, c) => s + 1 + sizeOf(c), (texts.get(node.path) || '').length);
  const allFacets = ranked.map((r) => { const c = candidates.find((x) => x.id === r.id); const node = tree.children.find((n) => n.path === `f:${r.id}`); return { ...r, count: c?.noteCount ?? 0, recent: c?.recentCount ?? 0, maxUnits: node ? sizeOf(node) : 0 }; });
  const { units } = allocate(allFacets, o.budget ?? 4000, o.layout);
  const newest = [...notes].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 5);
  const status = notes.length ? String(await o.generate({ kind: 'status', entity: o.entity, notes: newest })) : '';
  const text = render({ tree, texts, facetList: ranked, units, status, nameOf: o.nameOf });
  return { notes, facets, tree, decisions, stats, texts, records, units, text };
}
