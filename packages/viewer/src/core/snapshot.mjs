// A published snapshot: the plaintext view of memory that its owner chose to make public (a demo, a group's open
// notes), served as one JSON file instead of the sealed log. The tab builds the graph and the entity pages from it with
// the same code as from a replay (graph.mjs reads only the methods below), so a public graph and a private one look and
// behave the same. Nothing here decrypts: a snapshot is plaintext by the publisher's decision, and it is read-only.
//
// snapshot: { kind: 'tophat-graph-snapshot', v: 1, user, scopes, at, notes: [{id, body, at}], entities: [{id, name, type,
//   merged_into}], note_entities: [{note_id, entity_id}], pages: { entityId: { nodes, cached } } }
export const SNAPSHOT_KIND = 'tophat-graph-snapshot';

/** A read-only view over a snapshot with the read methods of a ViewState. */
export function snapshotView(snap) {
  if (!snap || snap.kind !== SNAPSHOT_KIND) throw new Error('not a graph snapshot');
  const notes = new Map((snap.notes || []).map((n) => [n.id, n]));
  const entities = new Map((snap.entities || []).map((e) => [e.id, e]));
  const resolve = (id) => { let e = entities.get(id), hops = 0; while (e && e.merged_into && hops++ < 20) e = entities.get(e.merged_into); return e ? e.id : id; };
  return {
    user: snap.user || 'public', device: 'snapshot', cursor: 1, changes: 1, unopened: [],
    viewer: { user: snap.user || 'public', groups: snap.scopes || [] },
    heldScopes: () => snap.scopes || [],
    tables: { notes, entities },
    at: snap.at || null,
    visibleNotes: () => [...notes.values()],
    entityRows: () => [...entities.values()],
    entityRow: (id) => entities.get(id) || null,
    entityAclVisible: (id) => entities.has(id),
    noteEntities: () => snap.note_entities || [],
    resolveEntity: resolve,
    async page(id) { const p = snap.pages && snap.pages[id]; return p ? { ...p, as_of: snap.at || null } : null; },
  };
}
