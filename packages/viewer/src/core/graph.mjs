// The memory graph for one viewer, built where the plaintext is (the browser). Entities are nodes; each note is ONE
// hyperedge over its entities (never projected to pairs). Everything derives from the notes the viewer may read:
//   notes     view.visibleNotes(): ACL-visible to the viewer's scopes and passing the source policy;
//   entities  non-handle, ACL-visible, with at least one visible note; a merged entity counts as its root;
//   pages     view.page(id): a cached page generated from exactly the viewer's visible notes, else the outline.
// `view` is a ViewState (./state.mjs) or anything with the same read methods (the tests adapt a linknotes replica).
const MAX_K = 25, MAX_HUBS = 8000, NOTE_CHARS = 700, TIP_CHARS = 240;
export const byAt = (a, b) => (a.at || '').localeCompare(b.at || '') || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
export const newestFirst = (a, b) => byAt(b, a);

function rooted(view) {
  const byId = new Map(view.entityRows().map((e) => [e.id, e]));
  const root = new Map();
  const rootOf = (id) => {
    if (root.has(id)) return root.get(id);
    let e = byId.get(id), hops = 0;
    while (e && e.merged_into && hops++ < 20) e = byId.get(e.merged_into);
    const r = e && !e.merged_into && e.type !== 'handle' && view.entityAclVisible(e.id) ? e.id : null;
    root.set(id, r);
    return r;
  };
  return { byId, rootOf };
}

/** {meta, nodes:[{id,name,type,n,t,ta}], hyper:[{id,text,at,m,k}]} plus (not serialized) adj, byNote, noteById. */
export function buildGraph(view, now = () => new Date().toISOString()) {
  const t0 = Date.now();
  const notes = view.visibleNotes().map((r) => ({ id: r.id, body: r.body, at: r.at || r.created_at }));
  const noteById = new Map(notes.map((n) => [n.id, n]));
  const { byId, rootOf } = rooted(view);
  const byNote = new Map();
  for (const r of view.noteEntities()) {
    if (!noteById.has(r.note_id)) continue;
    const e = rootOf(r.entity_id); if (!e) continue;
    let s = byNote.get(r.note_id); if (!s) byNote.set(r.note_id, (s = new Set()));
    s.add(e);
  }
  const count = new Map(), adj = new Map();
  for (const s of byNote.values()) {
    for (const e of s) count.set(e, (count.get(e) || 0) + 1);
    if (s.size < 2) continue;
    for (const a of s) { let m = adj.get(a); if (!m) adj.set(a, (m = new Map())); for (const b of s) if (a !== b) m.set(b, (m.get(b) || 0) + 1); }
  }
  const ids = [...count.keys()].sort();
  const idx = new Map(ids.map((e, i) => [e, i]));
  let hyper = [], droppedBig = 0;
  for (const [nid, s] of byNote) {
    if (s.size > MAX_K) { droppedBig++; continue; }
    if (s.size < 2) continue;
    const n = noteById.get(nid), m = [...s].map((e) => idx.get(e)).sort((a, b) => a - b);
    hyper.push({ id: nid, text: n.body.slice(0, NOTE_CHARS), at: n.at, m, k: m.length });
  }
  const big = hyper.filter((h) => h.k >= 3).sort((a, b) => (b.at || '').localeCompare(a.at || ''));
  const overBudget = Math.max(0, big.length - MAX_HUBS);
  hyper = hyper.filter((h) => h.k === 2).concat(big.slice(0, MAX_HUBS)).sort(byAt);
  const newest = new Map();
  for (const [nid, s] of byNote) { const n = noteById.get(nid); for (const e of s) { const cur = newest.get(e); if (!cur || byAt(n, noteById.get(cur)) > 0) newest.set(e, nid); } }
  const nodes = ids.map((e) => {
    const x = byId.get(e), nn = noteById.get(newest.get(e));
    return { id: e, name: x.name, type: x.type, n: count.get(e), t: nn.body.slice(0, TIP_CHARS), ta: nn.at };
  });
  const v = view.viewer;
  const meta = { built_at: now(), viewer: v ? v.user : 'owner', groups: v ? v.groups : null,
    notes_visible: notes.length, nodes: nodes.length, hyperedges: hyper.length, dropped_k_over_cap: droppedBig, dropped_over_hub_budget: overBudget, max_k: MAX_K, ms: Date.now() - t0 };
  return { meta, nodes, hyper, adj, byNote, noteById };
}

const PEOPLE = ['person', 'agent', 'group'];
/** shared: Map(neighbour id -> shared notes); info(id) -> {name, type, n} or undefined. People first, then types by size. */
export function groupNeighbours(shared, info) {
  const groups = new Map();
  for (const [b, c] of shared) { const n = info(b); if (!n) continue; const t = PEOPLE.includes(n.type) ? 'people' : n.type; if (!groups.has(t)) groups.set(t, []); groups.get(t).push({ id: b, name: n.name, type: n.type, shared: c, n: n.n }); }
  for (const l of groups.values()) l.sort((a, b) => b.shared - a.shared || b.n - a.n || a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return [...groups.entries()].sort((a, b) => (a[0] === 'people' ? -1 : b[0] === 'people' ? 1 : b[1].length - a[1].length || a[0].localeCompare(b[0]))).map(([type, items]) => ({ type, items }));
}
export function neighbours(graph, id) {
  const m = graph.adj.get(id); if (!m) return [];
  const byIdx = new Map(graph.nodes.map((n) => [n.id, n]));
  return groupNeighbours(m, (b) => byIdx.get(b));
}

/** Page lines from page nodes (a tree by parent, siblings by order). */
export function pageLines(nodes) {
  if (!Array.isArray(nodes) || !nodes.length) return null;
  const kids = new Map();
  for (const n of nodes) { const p = n.parent ?? null; if (!kids.has(p)) kids.set(p, []); kids.get(p).push(n); }
  for (const l of kids.values()) l.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const out = [], seen = new Set();
  const walk = (p, depth) => { for (const n of kids.get(p) || []) { if (seen.has(n.id)) continue; seen.add(n.id); out.push({ depth, text: String(n.text) }); walk(n.id, depth + 1); } };
  walk(null, 0);
  return out;
}

/** The entity page for the viewer: {node, page, neighbours, notes (newest 40), notes_total}, or null when not in the view. */
export async function entityPage(view, graph, id) {
  let root = id;
  try { root = view.resolveEntity ? view.resolveEntity(id) : id; } catch { return null; }
  const node = graph.nodes.find((n) => n.id === root);
  if (!node) return null;
  const notes = [];
  for (const [nid, s] of graph.byNote) if (s.has(root)) notes.push(graph.noteById.get(nid));
  notes.sort(newestFirst);
  let page = null;
  try { const p = await view.page(root); if (p) { const lines = pageLines(p.nodes); if (lines) page = { lines, as_of: p.as_of || null, dirty: false, cached: p.cached }; } } catch { page = null; }
  return { node, page, neighbours: neighbours(graph, root), notes: notes.slice(0, 40), notes_total: notes.length };
}

/** The serializable graph (what the page mounts). */
export const plainGraph = (g) => ({ meta: g.meta, nodes: g.nodes, hyper: g.hyper });
