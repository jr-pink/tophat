// Test support: the read interface of a ViewState over a linknotes replica (a TenantStore viewed as one user), so the
// same graph builder runs on both and the results can be compared. Uses only the replica's own filters (aclVisible,
// memoryVisible, the SqliteBackend page path).
export function storeView(backend, user) {
  const s = backend.store;
  s.setViewer(user);
  return {
    get viewer() { return s.viewer; },
    visibleNotes() {
      const v = s.viewer;
      return s.all("SELECT * FROM notes WHERE id IN (SELECT pk FROM mc_acl WHERE t='notes' AND revoked=0 AND grp IN (SELECT value FROM json_each(?)))", [JSON.stringify(v.groups)])
        .filter((r) => s.memoryVisible('note', r));
    },
    entityRows: () => s.all('SELECT id, name, type, merged_into FROM entities'),
    entityAclVisible: (id) => s.aclVisible('entities', id),
    noteEntities: () => s.all('SELECT note_id, entity_id FROM note_entities'),
    resolveEntity: (id) => s.resolveEntity(id),
    visibleEntityIds: () => s.all("SELECT id FROM entities WHERE id IN (SELECT pk FROM mc_acl WHERE t='entities' AND revoked=0 AND grp IN (SELECT value FROM json_each(?)))", [JSON.stringify(s.viewer.groups)]).map((r) => r.id).sort(),
    async page(id) { const p = await backend.page(id); return { ...p, as_of: null }; },
  };
}
