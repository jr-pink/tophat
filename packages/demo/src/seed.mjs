// Seed the demo instance's replica from the exported records (export.mjs), and publish its graph snapshot.
// Runs as the demo instance's user, on the replica the runner reads (<paths.state>/runner/memory.sqlite), writing into
// the instance's scope (the group, e.g. tophat-dev). Idempotent: a record already stored is a duplicate, and notes are
// derived only from records nothing has been derived from yet (pending). The snapshot's pages are the model-written ones (pages.mjs) where they exist.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openStore } from '@tophat-md/runner/store/memory.mjs';
import { ENTITIES, PROJECT } from './entities.mjs';
import { modelPageOf } from './pages.mjs';

const PUSHER = 'tophat-demo-seed';

export async function seed({ db, scope, records: file }) {
  const env = { TOPHAT_SCOPE: scope };
  const b = openStore(db, env);
  const s = b.store;
  // Entities are found by name; a missing one is created with a $temp id (the store assigns the id).
  const all = [PROJECT, ...ENTITIES];
  const lookup = () => new Map(all.map((e) => [e.id, s.one('SELECT id FROM entities WHERE name=? AND merged_into IS NULL ORDER BY rowid LIMIT 1', [e.name])?.id]).filter(([, v]) => v));
  let idOf = lookup();
  const missing = all.filter((e) => !idOf.has(e.id)).map(({ id, name, type }) => ({ id: '$' + id, name, type }));
  if (missing.length) { await b.apply({ entities: missing }, { scopes: [scope] }); idOf = lookup(); }
  const records = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const byId = new Map(records.map((r) => [r.id, r]));
  const ing = await b.ingest(records.map(({ id, source, revision, time, text, title }) => ({ id, source, revision, time, text, thread: title, role: 'human' })), { scopes: [scope], pusher: PUSHER });
  let notes = 0;
  for (;;) {
    const batch = await b.pending({ pusher: PUSHER, limit: 100 });
    if (!batch.length) break;
    for (const raw of batch) {
      const r = byId.get(raw.native_id);
      if (!r) { await b.apply({ notes: [] }, { ackRaw: [raw.id], sourceRefs: [raw.id], batchId: `demo-ack-${raw.id}` }); continue; }
      await b.apply({ notes: [{ body: r.text, entities: r.entities.map((k) => idOf.get(k)).filter(Boolean), at: r.time, author: 'tophat-docs' }] }, { scopes: [scope], sourceRefs: [raw.id], ackRaw: [raw.id], batchId: `demo-note-${raw.id}` });
      notes++;
    }
  }
  return { stored: ing.stored.length, duplicates: ing.duplicates.length, rejected: ing.rejected.length, notes, entities_added: missing.length };
}

/** The published snapshot of what the instance's user can read (see packages/viewer/src/core/snapshot.mjs). */
export async function snapshot({ db, scope, out }) {
  const b = openStore(db, { TOPHAT_SCOPE: scope });
  const s = b.store;
  s.setViewer(s.user);
  const groups = JSON.stringify(s.viewer.groups);
  const notes = s.all("SELECT id, body, at, created_at FROM notes WHERE id IN (SELECT pk FROM mc_acl WHERE t='notes' AND revoked=0 AND grp IN (SELECT value FROM json_each(?)))", [groups])
    .filter((r) => s.memoryVisible('note', r)).map((r) => ({ id: r.id, body: r.body, at: r.at || r.created_at }));
  const ids = new Set(notes.map((n) => n.id));
  const entities = s.all("SELECT id, name, type, merged_into FROM entities WHERE id IN (SELECT pk FROM mc_acl WHERE t='entities' AND revoked=0 AND grp IN (SELECT value FROM json_each(?)))", [groups]);
  const note_entities = s.all('SELECT note_id, entity_id FROM note_entities').filter((r) => ids.has(r.note_id));
  const pages = {};
  // A page written by the model (pages.mjs: signed PageNode records in this scope) wins; an entity without one, or whose records are not a
  // complete tree, keeps the store's mechanical outline. `kind` tells the widget which shape it is reading (build-graph.mjs pageOf).
  for (const e of entities) {
    try {
      const written = modelPageOf(await b.pageNodes({ entity: e.id }));
      if (written) { pages[e.id] = { nodes: written.nodes, cached: true, kind: 'model' }; continue; }
    } catch { /* no PageNode here: the mechanical page below */ }
    try { const p = await b.page(e.id); if (p) pages[e.id] = { nodes: p.nodes, cached: p.cached }; } catch { /* no page */ }
  }
  const snap = { kind: 'tophat-graph-snapshot', v: 1, user: s.user, scopes: s.viewer.groups, at: new Date().toISOString(), notes, entities, note_entities, pages };
  const tmp = path.join(path.dirname(out), `.${path.basename(out)}.${process.pid}`);
  writeFileSync(tmp, JSON.stringify(snap), { mode: 0o644 });
  renameSync(tmp, out);
  return { notes: notes.length, entities: entities.length, links: note_entities.length, bytes: JSON.stringify(snap).length };
}
