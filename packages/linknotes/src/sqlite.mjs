// The sqlite backend: MemoryStore over one local replica. Sync with a hub is optional and end-to-end encrypted (the
// hub stores ciphertext and group ids only; scope keys are wrapped to device keys).
import { readFileSync } from 'node:fs';
import { openReplica, StoreError } from './replica.mjs';
import { renderBfs } from '../core/vendor/rev6/push/pages.mjs';
import { httpTransport, syncOnce } from '../core/src/sync.mjs';
import { digest } from '../core/vendor/rev6/push/common.mjs';
import { rank } from '../core/src/policy.mjs';

const KIND_TABLE = { note: 'notes', work: 'work', entity: 'entities', raw: 'raw_data' };

/** RawRecord -> the store's raw row input. */
export function toStoreRecord(r, pusher) {
  if (!r || typeof r !== 'object') throw new StoreError('record must be an object');
  const locator = { ...(r.locator || {}), source: r.source, native_id: String(r.id), ...(pusher ? { pusher } : {}) };
  return { source: r.source, account: r.account || '', native_id: String(r.id), revision: r.revision ? String(r.revision) : '1', role: r.role || 'human', author: r.author ?? null,
    participants: r.participants || [], thread: r.thread ?? null, text: r.text, occurred_at: r.time, available_at: r.available ?? r.time, policy: r.policy ?? 'allow', locator };
}

export class SqliteBackend {
  /**
   * config: { file, user, device, writeScopes, keyFile?, people?|peopleFile?, screens?, hub?: { url, token?|tokenFile? } }
   * deps.transport: a sync transport (tests: the hub in-process); default HTTP to config.hub.url.
   */
  constructor(config, { transport = null } = {}) {
    this.config = config;
    const { store, keys } = openReplica(config);
    this.store = store; this.keys = keys;
    this.transport = transport;
    if (!store.one('SELECT 1 AS ok FROM mc_devices WHERE device=?', [config.device])) store.registerDevice(keys.publicKey);
  }
  get backend() { return 'sqlite'; }
  async whoami() { return { user: this.config.user, device: this.config.device, backend: this.backend, writeScopes: this.store.writeGroups }; }

  async apply(changes, { scopes, batchId, sourceRefs, ackRaw } = {}) {
    const s = this.store;
    changes = changes || {};
    const norm = (it) => { if (!it || typeof it !== 'object') return it; const { scopes: sc, ...rest } = it; return sc ? { ...rest, acl: sc } : rest; };
    const out = {}; for (const k of Object.keys(changes)) out[k] = Array.isArray(changes[k]) ? changes[k].map(norm) : changes[k];
    let refs = sourceRefs;
    if (!refs || !refs.length) {
      // The call itself is the evidence: one raw record per distinct note scope set, holding only the notes of that set
      // and readable by exactly that set. One record for the whole batch would put a private note's text into a shared
      // scope's raw row (the two-party leak test caught it).
      const bySet = new Map();
      for (const n of out.notes || []) {
        if (!n || typeof n !== 'object' || (n.source_refs || []).length) continue;
        const acl = [...(n.acl ?? scopes ?? s.writeGroups)].sort();
        const k = acl.join(',');
        if (!bySet.has(k)) bySet.set(k, { acl, notes: [] });
        bySet.get(k).notes.push(n);
      }
      for (const { acl, notes } of bySet.values()) {
        const text = notes.map((n) => n.body).join('\n');
        const rec = { source: 'linknotes-apply', id: digest([s.user, s.now(), acl, text], 12), text, time: s.now(), author: s.user, role: 'owner' };
        const got = s.ingest([toStoreRecord(rec)], { acl });
        const rid = got.stored[0] ?? got.duplicates[0];
        for (const n of notes) n.source_refs = [rid];
      }
    }
    const id = batchId || `apply-${digest([s.user, s.now(), out, refs ?? null], 12)}`;
    return s.apply(id, out, { groups: scopes, sourceRefs: refs ?? null, ackRaw: ackRaw ?? null });
  }
  async ingest(records, { scopes, pusher } = {}) {
    const r = this.store.ingest((records || []).map((x) => toStoreRecord(x, pusher)), { acl: scopes });
    return { stored: r.stored, duplicates: r.duplicates, rejected: r.rejected, withheld_by_policy: r.withheld_by_policy };
  }
  async pending({ pusher, limit = 50 } = {}) {
    if (!pusher) throw new StoreError('pending needs the pusher id');
    const s = this.store, v = s.viewer;
    const rows = s.all(`SELECT * FROM raw_data r WHERE processed_batch IS NULL AND json_extract(locator,'$.pusher')=? AND json_extract(policy,'$.model')='allow'
      ${v ? "AND r.id IN (SELECT pk FROM mc_acl WHERE t='raw_data' AND revoked=0 AND grp IN (SELECT value FROM json_each(?)))" : ''} ORDER BY available_at, rowid LIMIT ?`, v ? [pusher, JSON.stringify(v.groups), limit] : [pusher, limit]);
    return rows.map((r) => ({ id: r.id, source: r.source, account: r.account, native_id: r.native_id, author: r.author, participants: r.participants, thread: r.thread, role: r.role, time: r.occurred_at, text: r.text, scopes: s.aclOf('raw_data', r.id) }));
  }
  async search(query, { limit = 20, kind } = {}) { return this.store.search(query, { limit, kind }); }
  async read(kind, id) {
    if (!KIND_TABLE[kind]) throw new StoreError(`kind must be one of ${Object.keys(KIND_TABLE).join(', ')}`);
    const out = this.store.read(kind, id);
    if (out && typeof out === 'object' && KIND_TABLE[kind]) out.scopes = this.store.aclOf(KIND_TABLE[kind], id);
    return out;
  }
  async entity(id) {
    const r = this.store.read('entity', id);
    if (!r?.ok) return r;
    return { ok: true, entity: { ...r.entity, scopes: this.store.aclOf('entities', r.entity.id) }, notes: r.notes.map((n) => ({ ...n, scopes: this.store.aclOf('notes', n.id) })), work: r.work };
  }
  async page(entityId) {
    const s = this.store;
    const id = s.resolveEntity(entityId);
    if (!s.one('SELECT 1 AS ok FROM entities WHERE id=?', [id]) || (s.viewer && !s.aclVisible('entities', id))) throw new StoreError(`no entity ${entityId} visible to ${s.user}`);
    const p = s.pageFor(id);
    return { entity_id: id, key: p.key, cached: p.cached, note_ids: p.note_ids, cnf: p.cnf, nodes: p.nodes, outline: renderBfs(p.nodes, null).text };
  }
  /** Store one signed PageNode record (a derived page node: never a note, never evidence). scopes default to the writable part of its audience. */
  async putPageNode(record, { scopes = null, publicKey = null } = {}) { return this.store.putPageNode(record, { scopes, publicKey }); }
  /** PageNodes of one entity this viewer reads, oldest clock first: [{ id, record, scopes }]. */
  async pageNodes({ entity, key = null, scopes = null } = {}) { return this.store.pageNodes({ entity, key, scopes }); }
  async share(kind, id, scopes) { return this.store.share(kind, id, scopes); }
  async retract(kind, id) { return this.store.retract(kind, id); }
  async link(a, b, linked = true) { return this.store.link(a, b, linked); }
  async scopes() { return this.store.all('SELECT grp AS scope, role FROM mc_members WHERE user=? ORDER BY grp', [this.config.user]).map((r) => ({ ...r })); }
  async createScope(scope) { this.store.createGroup(scope); return { scope, role: 'admin' }; }
  async addMember(scope, user, role) { this.store.setMember(scope, user, role); return { scope, user, role }; }
  /** Push, pull, then wrap the current key of every scope this user administers to member devices that lack it. */
  async sync() {
    const t = this.transport ?? this.httpTransport();
    if (!t) throw new StoreError('no hub configured (config.hub.url and hub.token or hub.tokenFile)');
    const s = this.store;
    let r = await syncOnce(s, t);
    let wrapped = 0;
    for (const { grp } of s.all("SELECT grp FROM mc_members WHERE user=? AND role='admin'", [this.config.user])) {
      if (!s.keyFor(grp, s.currentEpoch(grp))) continue;
      if (s.distributeKeys(grp)) wrapped++;
    }
    if (wrapped) { const again = await syncOnce(s, t); r = { pushed: r.pushed + again.pushed, pulled: r.pulled + again.pulled, cursor: again.cursor }; }
    return { ...r, keys_wrapped: wrapped };
  }
  httpTransport() {
    const h = this.config.hub;
    if (!h?.url) return null;
    const token = h.token ?? (h.tokenFile ? readFileSync(h.tokenFile, 'utf8').trim() : null);
    if (!token) return null;
    return (this.transport = httpTransport(h.url, token, { timeoutMs: h.timeoutMs ?? 20000 }));
  }
  async close() { this.store.close(); }
}
export { rank };
