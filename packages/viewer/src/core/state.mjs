// The viewer's replica: the hub log replayed in memory, in a browser or in Node, with nothing but WebCrypto. It is the
// receive/putRow/purge path of the linknotes TenantStore reduced to what a read-only graph viewer reads (entities, notes,
// note-entity links, raw-row policies and stubs, entity links, cached pages, ACL grants and revocations, memberships and
// scope keys), with the same rules:
//   - a part opens only with a scope key this viewer holds (from the key file, or unwrapped from an mc_keys row addressed
//     to the key file's device); one it cannot open waits in `unopened` and is retried when keys change;
//   - grants are additive in hub order; only an mc_unshare revokes, and a later image in that group re-grants only when
//     the revocation came earlier in hub order; mutable rows are last-writer-wins by hub sequence;
//   - a row an unshare leaves in no scope this user reads loses its body (with its dependents) and leaves a tombstone, so an
//     older image is ignored and a later re-share brings it back;
//   - a viewer reads a row when one of its active grants is a scope the user is a member of (any role), and a note only
//     when its sources pass the source policy (present raw rows allowed for models, else the writer's stub verdict).
// Nothing here writes to the hub. Raw rows keep only their source and policy (never their text).
import { minimizeCnf } from '../../../linknotes/core/src/policy.mjs';
import { open as openSealed, unwrapForDevice, aesKey, unb64, b64, sha256Hex } from './crypto.mjs';

export const PAGE_PROMPT = 'outline-v1';
export const STATE_SCHEMA = 1;
const ROLES = ['none', 'read', 'write', 'admin'];
const rank = (r) => Math.max(0, ROLES.indexOf(r));
const ALL_TABLES = new Set(['raw_data', 'entities', 'identities', 'notes', 'note_entities', 'work', 'work_entities', 'mentions', 'batches', 'changes']);
const K = (...p) => p.join('\0');
const pyStr = (v) => (v === null || v === undefined ? 'None' : v === true ? 'True' : v === false ? 'False' : String(v));
const parseJson = (v, dflt) => { if (v === null || v === undefined) return dflt; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return dflt; } };

/** Read a hub device token's claims (no verification: the hub verifies; the viewer only needs its user and device). */
export function tokenClaims(token) {
  const m = /^mc1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(String(token || '').trim());
  if (!m) throw new Error('not a hub device token (mc1.<claims>.<mac>)');
  const s = m[1].replace(/-/g, '+').replace(/_/g, '/');
  const p = JSON.parse(new TextDecoder().decode(unb64(s + '='.repeat((4 - (s.length % 4)) % 4))));
  if (!p || typeof p.user !== 'string' || typeof p.device !== 'string') throw new Error('token has no user or device');
  return { user: p.user, device: p.device, exp: p.exp ?? null };
}

export class ViewState {
  /**
   * user, device: whom the hub serves (the token's claims). keys: { scopes: { <group>: { <epoch>: base64 key } },
   * devicePrivateKey?: pkcs8 base64 of `keyDevice`, keyDevice?: the device the mc_keys rows are addressed to }.
   */
  constructor({ user, device, keys = {} } = {}) {
    this.user = user; this.device = device;
    this.keyDevice = keys.keyDevice || keys.device || null;
    this.devicePrivateKey = keys.devicePrivateKey || null;
    this.keys = new Map(); // `${grp}|${epoch}` -> base64
    for (const [g, epochs] of Object.entries(keys.scopes || {})) for (const [e, k] of Object.entries(epochs)) this.keys.set(`${g}|${Number(e)}`, k);
    this.cryptoKeys = new Map();
    this.groups = new Map(); // grp -> created_by
    this.members = new Map(); // K(grp, user) -> role
    this.tables = { entities: new Map(), notes: new Map(), note_entities: new Map(), raw_data: new Map() };
    this.rowid = 0;
    this.acl = new Map(); // K(t, pk) -> Map(grp -> revoked 0|1)
    this.revocations = new Map(); // K(t, pk, grp) -> hub seq
    this.rowver = new Map(); // K(t, pk) -> hub seq
    this.tombs = new Map(); // K(t, pk) -> hub seq
    this.stubs = new Map(); // raw id -> allowed 0|1
    this.links = new Map(); // K(a, b) -> { a, b, linked, at }
    this.pageCache = new Map(); // key -> row
    this.applied = new Set(); // `${action id}#${part index}`
    this.unopened = []; // [{ seq, index, action }] (action carries the one part)
    this.cursor = 0;
    this.changes = 0; // bumps whenever a visible read may have changed
    this._viewerGroups = null;
  }

  // ---- keys and membership ----
  roleOf(user, grp) { return this.members.get(K(grp, user)) ?? 'none'; }
  groupsOf(user, min = 1) { const out = []; for (const [k, role] of this.members) { const [g, u] = k.split('\0'); if (u === user && rank(role) >= min) out.push(g); } return out.sort(); }
  get viewer() { if (!this._viewerGroups) this._viewerGroups = this.groupsOf(this.user); return { user: this.user, groups: this._viewerGroups }; }
  heldScopes() { return [...new Set([...this.keys.keys()].map((k) => k.slice(0, k.lastIndexOf('|'))))].sort(); }
  keyFor(grp, epoch) {
    const id = `${grp}|${epoch}`;
    if (this.cryptoKeys.has(id)) return this.cryptoKeys.get(id);
    const raw = this.keys.get(id);
    if (!raw) return null;
    const p = aesKey(unb64(raw), ['decrypt']);
    this.cryptoKeys.set(id, p);
    return p;
  }
  async applyControl(actor, { t, img }) {
    if (t === 'mc_groups') {
      if (!this.groups.has(img.grp)) { this.groups.set(img.grp, actor); this.members.set(K(img.grp, actor), 'admin'); }
    } else if (t === 'mc_members') this.members.set(K(img.grp, img.user), img.role);
    else if (t === 'mc_keys') {
      if (img.device === this.keyDevice && this.devicePrivateKey && !this.keys.has(`${img.grp}|${img.epoch}`)) {
        try { const key = await unwrapForDevice(this.devicePrivateKey, img.wrapped, `${img.grp}|${img.epoch}|${img.device}`); this.keys.set(`${img.grp}|${img.epoch}`, b64(key)); this.keysChanged = true; } catch { /* not for this key */ }
      }
    }
    this._viewerGroups = null; this.changes++;
  }

  // ---- receive: one action from the hub, in hub order ----
  async receive(action) {
    if (action.origin === this.device) return 'own';
    const fresh = action.parts.map((p, i) => ({ ...p, index: p.index ?? i })).filter((p) => !this.applied.has(`${action.id}#${p.index}`));
    if (!fresh.length) return 'duplicate';
    this._purge = new Map();
    for (const part of fresh) {
      if (part.control) {
        await this.applyControl(action.actor, part.control);
        // a key just arrived: parts it opens are older than everything after it, so apply them now, in hub order (applied
        // at the end, an older note landed after a newer unshare of it and stayed readable)
        if (this.keysChanged && this.unopened.length) { const purge = this._purge; this._purge = null; await this.retryUnopened(); this._purge = purge; }
        continue;
      }
      const value = await this.openPart(action, part);
      if (!value) { this.unopened.push({ seq: action.seq, index: part.index, action: { ...action, parts: [part] } }); continue; }
      for (const r of value.rows) this.putRow({ ...r, acl: part.acl, cnf: part.cnf }, action.seq);
    }
    for (const p of fresh) this.applied.add(`${action.id}#${p.index}`);
    this.settlePurges(action.seq);
    this._purge = null;
    return 'applied';
  }
  async openPart(action, part) {
    const meta = part.cnf ? { cnf: part.cnf } : { acl: part.acl };
    try { return await openSealed(part.sealed, `${action.id}|${part.index}|${JSON.stringify(meta)}`, (g, e) => this.keyFor(g, e)); } catch { return null; }
  }
  /** Parts that arrived before their key, retried in hub order (as TenantStore.retryUnopened). */
  async retryUnopened() {
    const left = [];
    for (const u of [...this.unopened].sort((a, b) => a.seq - b.seq || a.index - b.index)) {
      const part = u.action.parts[0];
      const value = await this.openPart(u.action, part);
      if (!value) { left.push(u); continue; }
      this._purge = new Map();
      for (const r of value.rows) this.putRow({ ...r, acl: part.acl, cnf: part.cnf }, u.seq);
      this.settlePurges(u.seq);
      this._purge = null;
    }
    this.unopened = left;
    this.keysChanged = false;
  }

  aclEntries(t, pk) { return this.acl.get(K(t, pk)); }
  putRow(r, hubSeq) {
    const { t, img } = r;
    const pk = String(r.pk);
    this.changes++;
    if (t === 'mem_search') return;
    if (t === 'mc_raw_stub') { this.stubs.set(img.id, img.allowed); return; }
    if (t === 'mc_unshare') {
      for (const g of r.acl || []) {
        const m = this.aclEntries(img.t, String(img.pk));
        if (!m || !m.has(g)) continue;
        m.set(g, 1);
        const rk = K(img.t, String(img.pk), g);
        this.revocations.set(rk, Math.max(this.revocations.get(rk) ?? -Infinity, hubSeq));
      }
      if (this._purge && ALL_TABLES.has(img.t)) this._purge.set(K(img.t, String(img.pk)), { t: img.t, pk: String(img.pk) });
      return;
    }
    if (t === 'mc_page_cache') { if (!this.pageCache.has(img.key)) this.pageCache.set(img.key, { key: img.key, entity_id: img.entity_id, prompt_version: img.prompt_version, note_ids: parseJson(img.note_ids, []), cnf: parseJson(img.cnf, []), nodes: parseJson(img.nodes, []), generated_at: img.generated_at }); return; }
    if (t === 'mc_links') { this.links.set(K(img.a, img.b), { a: img.a, b: img.b, linked: img.linked, at: img.at }); return; }
    if (!ALL_TABLES.has(t) || t === 'changes') return;
    const tk = K(t, pk);
    const tomb = this.tombs.get(tk);
    if (tomb !== undefined) { if (hubSeq <= tomb) return; this.tombs.delete(tk); }
    const immutable = ['notes', 'note_entities', 'mentions', 'work_entities', 'changes'].includes(t);
    if (!immutable) {
      const v = this.rowver.get(tk);
      if (v !== undefined && v >= hubSeq) return;
      this.rowver.set(tk, hubSeq);
    }
    if (r.acl) {
      let m = this.acl.get(tk);
      if (!m) this.acl.set(tk, (m = new Map()));
      for (const g of r.acl) {
        if (!m.has(g)) m.set(g, 0);
        else if (m.get(g) === 1) { const rv = this.revocations.get(K(t, pk, g)); if (rv !== undefined && rv < hubSeq) m.set(g, 0); }
      }
    }
    const table = this.tables[t];
    if (!table) return;
    if (immutable && table.has(pk)) return;
    table.set(pk, this.slim(t, img, immutable ? null : table.get(pk)));
  }
  slim(t, img, prev) {
    if (t === 'notes') return { id: img.id, body: img.body ?? '', at: img.at ?? null, created_at: img.created_at ?? null, source_refs: parseJson(img.source_refs, []) || [], note_refs: parseJson(img.note_refs, []) || [], rowid: ++this.rowid };
    if (t === 'note_entities') return { note_id: img.note_id, entity_id: img.entity_id };
    if (t === 'entities') return { id: img.id, name: img.name ?? prev?.name ?? '', type: img.type ?? prev?.type ?? 'misc', merged_into: 'merged_into' in img ? img.merged_into ?? null : prev?.merged_into ?? null };
    if (t === 'raw_data') return { id: img.id, source: img.source ?? prev?.source ?? null, policy: parseJson(img.policy, prev?.policy ?? {}) || {} };
    return img;
  }
  /** After an action: rows its unshares left in no scope this user reads lose their body (TenantStore.settlePurges). */
  settlePurges(hubSeq) {
    if (!this._purge || !this._purge.size) return;
    const mine = this.groupsOf(this.user);
    for (const { t, pk } of this._purge.values()) {
      const m = this.aclEntries(t, pk);
      if (!m || !m.size) continue;
      if ([...m].some(([g, rv]) => !rv && mine.includes(g))) continue;
      this.purgeRow(t, pk, hubSeq);
    }
    this._purge.clear();
  }
  purgeRow(t, pk, hubSeq) {
    const tomb = (tt, key) => { if (tt === 'changes') return; const k = K(tt, key); this.tombs.set(k, Math.max(this.tombs.get(k) ?? -Infinity, hubSeq)); };
    const delNe = (pred) => { for (const [k, r] of this.tables.note_entities) if (pred(r)) { this.tables.note_entities.delete(k); tomb('note_entities', k); } };
    const dropPages = (pred) => { for (const [k, r] of this.pageCache) if (pred(r)) this.pageCache.delete(k); };
    if (t === 'notes') delNe((r) => r.note_id === pk);
    if (t === 'entities') {
      delNe((r) => r.entity_id === pk);
      for (const [k, l] of this.links) if (l.a === pk || l.b === pk) this.links.delete(k);
      dropPages((r) => r.entity_id === pk);
    }
    if (t === 'notes' || t === 'entities' || t === 'work') dropPages((r) => JSON.stringify(r.note_ids).includes(pk) || JSON.stringify(r.nodes).includes(pk));
    if (this.tables[t]) this.tables[t].delete(pk);
    tomb(t, pk);
    this.changes++;
  }

  // ---- reads (the viewer's filter) ----
  aclVisible(t, pk) {
    const m = this.aclEntries(t, String(pk));
    if (!m) return false;
    const groups = this.viewer.groups;
    for (const [g, rv] of m) if (!rv && groups.includes(g)) return true;
    return false;
  }
  activeAcl(t, pk) { const m = this.aclEntries(t, String(pk)); return m ? [...m].filter(([, rv]) => !rv).map(([g]) => g).sort() : []; }
  /** The source-policy half of a note's visibility (TenantStore.policyVisible for kind 'note', with no private-people list). */
  policyVisible(note) {
    const refs = new Set(note.source_refs || []);
    const queue = [note.id, ...(note.note_refs || [])], seen = new Set();
    while (queue.length) {
      const nid = queue.pop();
      if (seen.has(nid)) continue;
      seen.add(nid);
      const n = this.tables.notes.get(nid);
      if (n) { (n.source_refs || []).forEach((r) => refs.add(r)); queue.push(...(n.note_refs || [])); } else refs.add('unavailable-note:' + pyStr(nid));
    }
    for (const ref of refs) {
      const raw = String(ref).startsWith('unavailable-') ? null : this.tables.raw_data.get(ref);
      if (!raw) { if (this.stubs.get(String(ref))) continue; return false; }
      if (!raw.policy || raw.policy.model !== 'allow') return false;
    }
    return true;
  }
  noteVisible(n) { return this.aclVisible('notes', n.id) && this.policyVisible(n); }
  /** Every note this viewer reads. */
  visibleNotes() { const out = []; for (const n of this.tables.notes.values()) if (this.noteVisible(n)) out.push(n); return out; }
  entityRows() { return [...this.tables.entities.values()]; }
  entityRow(id) { return this.tables.entities.get(id) || null; }
  entityAclVisible(id) { return this.aclVisible('entities', id); }
  noteEntities() { return [...this.tables.note_entities.values()]; }
  resolveEntity(id) {
    const seen = new Set(); let cur = id;
    for (;;) { if (seen.has(cur)) throw new Error(`merge chain cycles at ${cur}`); seen.add(cur); const next = this.tables.entities.get(cur)?.merged_into; if (!next) return cur; cur = next; }
  }
  /** An entity's merge cluster plus linked entities (TenantStore.clusterIds). */
  clusterIds(id) {
    const base = (x) => {
      const root = this.resolveEntity(x), out = [root], queue = [root];
      while (queue.length) { const cur = queue.pop(); const kids = [...this.tables.entities.values()].filter((e) => e.merged_into === cur).map((e) => e.id).sort(); for (const k of kids) if (!out.includes(k)) { out.push(k); queue.push(k); } }
      return out;
    };
    const first = base(id);
    const live = [...this.links.values()].filter((l) => l.linked === 1 || l.linked === true);
    if (!live.length) return first;
    const out = [...first], queue = [...first];
    while (queue.length) {
      const cur = queue.shift();
      for (const l of live.filter((x) => x.a === cur || x.b === cur).sort((x, y) => (x.a + '\0' + x.b < y.a + '\0' + y.b ? -1 : 1))) {
        const other = l.a === cur ? l.b : l.a;
        if (!this.tables.entities.has(other)) continue;
        for (const x of base(other)) if (!out.includes(x)) { out.push(x); queue.push(x); }
      }
    }
    return out;
  }
  /** Notes of an entity the viewer reads, newest first (TenantStore.entityNotes with a viewer, follow links). */
  entityNotes(id) {
    const ids = new Set(this.clusterIds(id));
    const noteIds = new Set();
    for (const r of this.tables.note_entities.values()) if (ids.has(r.entity_id)) noteIds.add(r.note_id);
    const at = (n) => n.at ?? n.created_at ?? '';
    return [...noteIds].map((nid) => this.tables.notes.get(nid)).filter((n) => n && this.noteVisible(n))
      .sort((a, b) => (at(a) < at(b) ? 1 : at(a) > at(b) ? -1 : b.rowid - a.rowid));
  }
  /** The viewer's page for an entity (SqliteBackend.page): a cached page anyone generated from the same visible notes, else the outline. */
  async page(entityId) {
    const id = this.resolveEntity(entityId);
    const entity = this.tables.entities.get(id);
    if (!entity || !this.aclVisible('entities', id)) return null;
    const notes = this.entityNotes(id);
    const ids = notes.map((n) => n.id).sort();
    const key = await sha256Hex(JSON.stringify([PAGE_PROMPT, ids]));
    const hit = this.pageCache.get(key);
    const groups = this.viewer.groups;
    if (hit && hit.cnf.length && hit.cnf.every((clause) => clause.some((g) => groups.includes(g)))) return { entity_id: id, key, cached: true, note_ids: ids, nodes: hit.nodes, as_of: hit.generated_at };
    const nodes = outlinePage({ entity: { id: entity.id, name: entity.name, type: entity.type }, notes });
    // kept like a replica keeps the page it generated (never sent: the viewer writes nothing to the hub); a later page with the
    // same visible notes (a linked entity) reads it, as on the replica
    if (!hit) this.pageCache.set(key, { key, entity_id: id, prompt_version: PAGE_PROMPT, note_ids: ids, cnf: minimizeCnf(ids.map((n) => this.activeAcl('notes', n)).filter((a) => a.length)), nodes, generated_at: null, local: true });
    return { entity_id: id, key, cached: false, note_ids: ids, nodes, as_of: null };
  }

  // ---- persistence (the caller encrypts it) ----
  toJSON() {
    const m = (x) => [...x];
    return { schema: STATE_SCHEMA, user: this.user, device: this.device, keyDevice: this.keyDevice, devicePrivateKey: this.devicePrivateKey, keys: m(this.keys), groups: m(this.groups), members: m(this.members),
      tables: Object.fromEntries(Object.entries(this.tables).map(([t, x]) => [t, m(x)])), rowid: this.rowid,
      acl: [...this.acl].map(([k, v]) => [k, m(v)]), revocations: m(this.revocations), rowver: m(this.rowver), tombs: m(this.tombs), stubs: m(this.stubs), links: m(this.links), pageCache: m(this.pageCache),
      applied: m(this.applied), unopened: this.unopened, cursor: this.cursor };
  }
  static fromJSON(o) {
    if (!o || o.schema !== STATE_SCHEMA) throw new Error('cached state has another schema');
    const s = new ViewState({ user: o.user, device: o.device, keys: { keyDevice: o.keyDevice, devicePrivateKey: o.devicePrivateKey } });
    s.keys = new Map(o.keys); s.groups = new Map(o.groups); s.members = new Map(o.members);
    for (const t of Object.keys(s.tables)) s.tables[t] = new Map(o.tables[t] || []);
    s.rowid = o.rowid; s.acl = new Map(o.acl.map(([k, v]) => [k, new Map(v)])); s.revocations = new Map(o.revocations); s.rowver = new Map(o.rowver); s.tombs = new Map(o.tombs);
    s.stubs = new Map(o.stubs); s.links = new Map(o.links); s.pageCache = new Map(o.pageCache); s.applied = new Set(o.applied); s.unopened = o.unopened || []; s.cursor = o.cursor || 0;
    return s;
  }
}

/** The deterministic page: the entity, then its notes newest first (the same generator as linknotes outlinePage). */
export function outlinePage({ entity, notes }) {
  const root = { id: 'p1', parent: null, order: 0, text: `${entity?.name ?? 'entity'} (${entity?.type ?? 'misc'})` };
  return [root, ...notes.map((n, i) => ({ id: `p${i + 2}`, parent: 'p1', order: i, text: `${String(n.at || n.created_at || '').slice(0, 10)}: ${String(n.body).replace(/\s+/g, ' ').slice(0, 240)}`, notes: [n.id] }))];
}
