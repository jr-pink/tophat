// TenantStore: the rev6 memory store (vendored unchanged) plus groups, per-row ACLs, an
// append-only action log and per-viewer pages. Tenancy is a filter: it can hide a row from a
// viewer and refuse a write into a group the writer is not in; it never changes whether the
// store itself accepts a batch, nor what the store writes. With no viewer and no tenancy rows
// the store behaves, and writes, exactly as rev6/push/store.mjs.
import crypto from 'node:crypto';
import { realpathSync } from 'node:fs';
import nodePath from 'node:path';
import { Store, StoreError, supportRefs } from '../vendor/rev6/push/store.mjs';
import { pyDumps as j, instant } from '../vendor/rev6/push/common.mjs';
import { privateIn } from '../vendor/rev6/push/identity.mjs';
import { renderBfs } from '../vendor/rev6/push/pages.mjs';
import { CONTROL_TABLES, PolicyError, authorizeControl, canRead, canWrite, minimizeCnf, normAcl, rank, satisfies } from './policy.mjs';
import { newGroupKey, open, seal, sha256, unwrapForDevice, wrapForDevice } from './crypto.mjs';
import { SCREEN_PATTERN, SCREENED_GROUPS } from './screen.mjs';
import { pageNodeError, pageNodeRow, validPageNodeRow } from './pagenode.mjs';

/** Replicated tables, their key columns, and whether rows are immutable once written. */
export const TABLES = {
  raw_data: { pk: ['id'], immutable: false },
  entities: { pk: ['id'], immutable: false },
  identities: { pk: ['source', 'account', 'native'], immutable: false },
  notes: { pk: ['id'], immutable: true },
  note_entities: { pk: ['note_id', 'entity_id'], immutable: true },
  work: { pk: ['id'], immutable: false },
  work_entities: { pk: ['work_id', 'entity_id'], immutable: true },
  mentions: { pk: ['id'], immutable: true },
  batches: { pk: ['id'], immutable: false },
  changes: { pk: ['seq'], immutable: true },
  mc_pagenodes: { pk: ['id'], immutable: true },
};
const APPEND_ONLY = ['notes', 'note_entities', 'mentions', 'mc_pagenodes'];
const PENDING = Number.MAX_SAFE_INTEGER;
const KIND_TABLE = { note: 'notes', work: 'work', entity: 'entities', mention: 'mentions', raw: 'raw_data', pagenode: 'mc_pagenodes' };
export const PAGE_PROMPT = 'outline-v1';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS mc_meta(k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mc_groups(grp TEXT PRIMARY KEY, created_by TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mc_members(grp TEXT NOT NULL, user TEXT NOT NULL, role TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY(grp, user));
CREATE TABLE IF NOT EXISTS mc_devices(device TEXT PRIMARY KEY, user TEXT NOT NULL, public_key TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mc_keys(grp TEXT NOT NULL, epoch INTEGER NOT NULL, key TEXT NOT NULL, PRIMARY KEY(grp, epoch));
CREATE TABLE IF NOT EXISTS mc_wraps(grp TEXT NOT NULL, epoch INTEGER NOT NULL, device TEXT NOT NULL, PRIMARY KEY(grp, epoch, device));
CREATE TABLE IF NOT EXISTS mc_acl(t TEXT NOT NULL, pk TEXT NOT NULL, grp TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(t, pk, grp));
CREATE INDEX IF NOT EXISTS mc_acl_grp ON mc_acl(grp, t);
CREATE TABLE IF NOT EXISTS mc_links(a TEXT NOT NULL, b TEXT NOT NULL, linked INTEGER NOT NULL, at TEXT NOT NULL, PRIMARY KEY(a, b));
CREATE TABLE IF NOT EXISTS mc_raw_stub(id TEXT PRIMARY KEY, allowed INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS mc_page_cache(key TEXT PRIMARY KEY, entity_id TEXT NOT NULL, prompt_version TEXT NOT NULL, note_ids TEXT NOT NULL, cnf TEXT NOT NULL, nodes TEXT NOT NULL, generated_at TEXT NOT NULL, generated_by TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mc_outbox(n INTEGER PRIMARY KEY AUTOINCREMENT, t TEXT NOT NULL, pk TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mc_log(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, origin TEXT NOT NULL, origin_seq INTEGER NOT NULL, ts TEXT NOT NULL, body TEXT NOT NULL, hub_seq INTEGER, UNIQUE(origin, origin_seq));
CREATE TABLE IF NOT EXISTS mc_rejected(id TEXT PRIMARY KEY, hub_seq INTEGER NOT NULL, reason TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mc_superseded(id TEXT PRIMARY KEY, origin_seq INTEGER NOT NULL, hub_seq INTEGER NOT NULL, hub_id TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mc_applied(id TEXT PRIMARY KEY, hub_seq INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS mc_rowver(t TEXT NOT NULL, pk TEXT NOT NULL, seq INTEGER NOT NULL, pending INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(t, pk));
CREATE TABLE IF NOT EXISTS mc_deferred(hub_seq INTEGER NOT NULL, t TEXT NOT NULL, pk TEXT NOT NULL, row TEXT NOT NULL, PRIMARY KEY(hub_seq, t, pk));
CREATE TABLE IF NOT EXISTS mc_unopened(hub_seq INTEGER NOT NULL, part INTEGER NOT NULL, action TEXT NOT NULL, PRIMARY KEY(hub_seq, part));
CREATE TABLE IF NOT EXISTS mc_revocations(t TEXT NOT NULL, pk TEXT NOT NULL, grp TEXT NOT NULL, hub_seq INTEGER NOT NULL, PRIMARY KEY(t, pk, grp));
CREATE TABLE IF NOT EXISTS mc_grants(t TEXT NOT NULL, pk TEXT NOT NULL, grp TEXT NOT NULL, hub_seq INTEGER NOT NULL, PRIMARY KEY(t, pk, grp));
CREATE TABLE IF NOT EXISTS mc_aclpending(t TEXT NOT NULL, pk TEXT NOT NULL, grp TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY(t, pk, grp));
CREATE TABLE IF NOT EXISTS mc_pagenodes(id TEXT PRIMARY KEY, entity TEXT NOT NULL, key TEXT NOT NULL, path TEXT NOT NULL, at TEXT NOT NULL, author TEXT NOT NULL, cited TEXT NOT NULL, record TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS mc_pagenodes_entity ON mc_pagenodes(entity, key);
CREATE TABLE IF NOT EXISTS mc_purged(t TEXT NOT NULL, pk TEXT NOT NULL, hub_seq INTEGER NOT NULL, at TEXT NOT NULL, reason TEXT NOT NULL, PRIMARY KEY(t, pk));
INSERT OR IGNORE INTO mc_meta(k, v) VALUES('capture', '1');
`;

const pkExpr = (cols, p) => (cols.length === 1 ? `${p}.${cols[0]}` : `json_array(${cols.map((c) => `${p}.${c}`).join(',')})`);
function triggers() {
  const out = [];
  const on = "(SELECT v FROM mc_meta WHERE k='capture')='1'";
  for (const [t, { pk }] of Object.entries(TABLES)) {
    out.push(`CREATE TRIGGER IF NOT EXISTS mc_ins_${t} AFTER INSERT ON ${t} WHEN ${on} BEGIN INSERT INTO mc_outbox(t, pk) VALUES('${t}', ${pkExpr(pk, 'NEW')}); END;`);
    const when = t === 'raw_data' ? ` AND (NEW.processed_batch IS NOT OLD.processed_batch OR NEW.policy IS NOT OLD.policy OR NEW.text IS NOT OLD.text OR NEW.role IS NOT OLD.role OR NEW.author IS NOT OLD.author OR NEW.locator IS NOT OLD.locator)` : '';
    out.push(`CREATE TRIGGER IF NOT EXISTS mc_upd_${t} AFTER UPDATE ON ${t} WHEN ${on}${when} BEGIN INSERT INTO mc_outbox(t, pk) VALUES('${t}', ${pkExpr(pk, 'NEW')}); END;`);
  }
  for (const t of APPEND_ONLY) for (const op of ['UPDATE', 'DELETE']) out.push(`CREATE TRIGGER IF NOT EXISTS mc_append_only_${t}_${op.toLowerCase()} BEFORE ${op} ON ${t} BEGIN SELECT RAISE(ABORT, 'append-only: ${t} rows are never changed or deleted; write a new note that cites the old one'); END;`);
  for (const t of ['mc_log', 'mc_page_cache']) for (const op of ['UPDATE', 'DELETE']) {
    if (t === 'mc_log' && op === 'UPDATE') { out.push(`CREATE TRIGGER IF NOT EXISTS mc_append_only_mc_log_update BEFORE UPDATE ON mc_log WHEN NEW.body IS NOT OLD.body OR NEW.id IS NOT OLD.id OR NEW.origin_seq IS NOT OLD.origin_seq OR (OLD.hub_seq IS NOT NULL AND NEW.hub_seq IS NOT OLD.hub_seq) BEGIN SELECT RAISE(ABORT, 'append-only: mc_log'); END;`); continue; }
    out.push(`CREATE TRIGGER IF NOT EXISTS mc_append_only_${t}_${op.toLowerCase()} BEFORE ${op} ON ${t} BEGIN SELECT RAISE(ABORT, 'append-only: ${t}'); END;`);
  }
  return out.join('\n');
}

const pkOf = (t, row) => { const cols = TABLES[t].pk; return cols.length === 1 ? String(row[cols[0]]) : JSON.stringify(cols.map((c) => row[c])); };
const asJson = (x) => (typeof x === 'string' ? JSON.parse(x) : x); // the store decodes some JSON columns by name
/**
 * The grant events one logged row carries, per (row, group): an image in an acl part grants each of its groups; an mc_unshare
 * revokes its groups. Images in a cnf part, control rows and change rows (per-replica seqs) carry none. A grant is a
 * last-writer-wins register ordered by hub position: putRow applies an event only when it is later than the last one applied,
 * and a device's own unacknowledged event holds the grant (it lands later in hub order than anything pulled meanwhile).
 */
export function grantEvents(r) {
  if (!r || r.control || r.cnf) return [];
  if (r.t === 'mc_unshare') return TABLES[r.img?.t] && r.img.t !== 'changes' ? (r.acl || []).map((g) => ({ t: r.img.t, pk: String(r.img.pk), grp: g, op: 'revoke' })) : [];
  if (!TABLES[r.t] || r.t === 'changes' || !Array.isArray(r.acl)) return [];
  return r.acl.map((g) => ({ t: r.t, pk: String(r.pk), grp: g, op: 'grant' }));
}
const isTemp = (id) => id === undefined || id === null || id === '' || (typeof id === 'string' && id.startsWith('$'));

export class TenantStore extends Store {
  /**
   * opts.device / opts.user: who this replica acts as (omitted = no tenancy: the old store).
   * opts.viewAs: user whose view reads return (default opts.user; null = everything, the owner's
   * local view). opts.writeGroups: ACL given to rows written without an explicit `acl`.
   * opts.deviceKey: this device's X25519 private key (pkcs8 base64), to open wrapped group keys.
   */
  constructor(file, opts = {}) {
    super(file, opts);
    if (!opts.readOnly) { this.db.exec(SCHEMA); this.db.exec(triggers()); } // a read-only view opens an adopted file as it is
    this.device = opts.device ?? null;
    this.user = opts.user ?? null;
    this.deviceKey = opts.deviceKey ?? null;
    this.writeGroups = opts.writeGroups ? normAcl(opts.writeGroups) : null;
    this.setViewer(opts.viewAs === undefined ? this.user : opts.viewAs);
    this._ctx = null;
    this._idx = [];
  }

  setViewer(user) { this.viewerUser = user; this._viewerGroups = null; return this; }
  roleOf(user, grp) { return this.one('SELECT role FROM mc_members WHERE grp=? AND user=?', [grp, user])?.role ?? 'none'; }
  groupsOf(user, min = 1) { return this.all('SELECT grp, role FROM mc_members WHERE user=?', [user]).filter((r) => rank(r.role) >= min).map((r) => r.grp).sort(); }
  get viewer() {
    if (!this.viewerUser) return null;
    if (!this._viewerGroups) this._viewerGroups = this.groupsOf(this.viewerUser);
    return { user: this.viewerUser, groups: this._viewerGroups };
  }

  // ---- ACL ----
  aclOf(t, pk) { return this.all('SELECT grp FROM mc_acl WHERE t=? AND pk=? AND revoked=0 ORDER BY grp', [t, String(pk)]).map((r) => r.grp); }
  aclVisible(t, pk) {
    const v = this.viewer;
    if (!v) return true;
    return Boolean(this.one('SELECT 1 AS ok FROM mc_acl WHERE t=? AND pk=? AND revoked=0 AND grp IN (SELECT value FROM json_each(?))', [t, String(pk), j(v.groups)]));
  }
  setAcl(t, pk, acl) {
    pk = String(pk);
    for (const g of acl) this.run('INSERT INTO mc_acl(t,pk,grp,revoked) VALUES(?,?,?,0) ON CONFLICT(t,pk,grp) DO UPDATE SET revoked=0', [t, pk, g]);
    this.run('UPDATE mc_acl SET revoked=1 WHERE t=? AND pk=? AND grp NOT IN (SELECT value FROM json_each(?))', [t, pk, j(acl)]);
  }

  // ---- reads: one choke point, the store's own ----
  hasStubs() { return Boolean(this.one('SELECT 1 AS ok FROM mc_raw_stub LIMIT 1')); }
  memoryVisible(kind, row) {
    if (!row) return true;
    if (this.viewer) {
      if (kind === 'page') { if (row.entity_id && !this.aclVisible('entities', row.entity_id)) return false; }
      else if (KIND_TABLE[kind] && row.id !== undefined && !this.aclVisible(KIND_TABLE[kind], row.id)) return false;
    }
    return this.viewer || this.hasStubs() ? this.policyVisible(kind, row) : super.memoryVisible(kind, row);
  }
  /** The store's source-policy rule, with ACL-free raw views and the writer's verdict for sources this replica never received. */
  policyVisible(kind, row) {
    if (!row) return true;
    const nodes = kind === 'page' && Array.isArray(row.nodes) ? row.nodes : [];
    const refs = supportRefs(this, kind === 'note' ? [row] : [], kind === 'work' ? [row] : [], nodes);
    if (kind === 'entity' && row.id) {
      const support = this.all('SELECT n.* FROM notes n JOIN note_entities ne ON ne.note_id=n.id WHERE ne.entity_id=?', [row.id]);
      if (support.length && !support.some((n) => this.policyVisible('note', n))) return false;
    }
    if (kind === 'mention' && row.raw_id) refs.push(row.raw_id);
    for (const ref of refs) {
      const raw = String(ref).startsWith('unavailable-') ? null : this.one('SELECT * FROM raw_data WHERE id=?', [ref]);
      if (!raw) { if (this.one('SELECT allowed FROM mc_raw_stub WHERE id=?', [ref])?.allowed) continue; return false; }
      if ('withheld' in Store.prototype.rawView.call(this, raw)) return false;
    }
    return !privateIn(this.people, [], j(row));
  }
  rawView(row, full = true) {
    const out = super.rawView(row, full);
    if (this.viewer && !this.aclVisible('raw_data', row.id)) { delete out.text; out.withheld = 'not shared with this viewer'; }
    return out;
  }
  history(kind, target, limit = 100) {
    const t = KIND_TABLE[kind];
    if (this.viewer && t && !this.aclVisible(t, target)) return [];
    if (this.viewer && kind === 'page' && !this.aclVisible('entities', target)) return [];
    return super.history(kind, target, limit);
  }
  clusterIds(ident) {
    const base = super.clusterIds(ident);
    if (!this.one('SELECT 1 AS ok FROM mc_links WHERE linked=1 LIMIT 1')) return base;
    const out = [...base], queue = [...base];
    while (queue.length) {
      const id = queue.shift();
      for (const r of this.all('SELECT a, b FROM mc_links WHERE linked=1 AND (a=? OR b=?) ORDER BY a, b', [id, id])) {
        const other = r.a === id ? r.b : r.a;
        if (!this.one('SELECT 1 AS ok FROM entities WHERE id=?', [other])) continue;
        for (const x of super.clusterIds(other)) if (!out.includes(x)) { out.push(x); queue.push(x); }
      }
    }
    return out;
  }
  /** Tenancy on: rows replicate in a different insertion order on each device, so lists ordered by time break ties by id, never rowid. */
  get tenancy() { return Boolean(this.user || this.writeGroups); }
  entityNotes(id, opts = {}) {
    const v = this.viewer;
    if (!v && !this.tenancy) return super.entityNotes(id, opts);
    const { asOf, limit = 200, follow = true, policyFilter = true } = opts;
    const acl = v ? " AND n.id IN (SELECT pk FROM mc_acl WHERE t='notes' AND revoked=0 AND grp IN (SELECT value FROM json_each(:groups)))" : '';
    return this.all(`SELECT DISTINCT n.* FROM notes n JOIN note_entities ne ON ne.note_id=n.id WHERE ne.entity_id IN (SELECT value FROM json_each(:ids)) AND COALESCE(n.at, n.created_at) <= :as_of${acl} ORDER BY COALESCE(n.at, n.created_at) DESC, n.id DESC LIMIT :n`,
      { ids: j(follow ? this.clusterIds(id) : [id]), as_of: asOf ? instant(asOf) : '9', n: limit, ...(v ? { groups: j(v.groups) } : {}) }).filter((r) => !policyFilter || this.memoryVisible('note', r));
  }
  entityMentions(id, opts = {}) {
    if (!this.tenancy) return super.entityMentions(id, opts);
    const { asOf, limit = 200, follow = true } = opts;
    return this.all('SELECT * FROM mentions WHERE entity_id IN (SELECT value FROM json_each(:ids)) AND at <= :as_of ORDER BY at DESC, id DESC LIMIT :n',
      { ids: j(follow ? this.clusterIds(id) : [id]), as_of: asOf ? instant(asOf) : '9', n: limit }).filter((r) => this.memoryVisible('mention', r));
  }
  pageView(entityId, nodes, budget) {
    if (!this.viewer || this.seesWholeEntity(entityId)) return super.pageView(entityId, nodes, budget);
    const hit = this.cachedPage(entityId, PAGE_PROMPT);
    if (!hit) return { revision: null, as_of: null, dirty: true, node_count: 0, outline: null, viewer_page: 'not generated for this view yet' };
    return { revision: hit.key, as_of: hit.generated_at, dirty: false, node_count: hit.nodes.length, outline: renderBfs(hit.nodes, budget ?? null), viewer_page: hit.key };
  }

  /** A viewer who can read every note and work item of an entity reads the store's own page: it was built from exactly that. */
  seesWholeEntity(entityId) {
    const ids = j(this.clusterIds(entityId));
    const hidden = (t, sql) => this.one(`SELECT COUNT(*) AS n FROM (${sql}) x WHERE x.id NOT IN (SELECT pk FROM mc_acl WHERE t='${t}' AND revoked=0 AND grp IN (SELECT value FROM json_each(?)))`, [ids, j(this.viewer.groups)]).n;
    return this.aclVisible('entities', entityId)
      && hidden('notes', 'SELECT DISTINCT note_id AS id FROM note_entities WHERE entity_id IN (SELECT value FROM json_each(?))') === 0
      && hidden('work', 'SELECT DISTINCT work_id AS id FROM work_entities WHERE entity_id IN (SELECT value FROM json_each(?))') === 0;
  }

  // ---- per-viewer pages ----
  visibleNoteIds(entityId) { return this.entityNotes(entityId, { limit: 1000000 }).map((n) => n.id).sort(); }
  pageKey(promptVersion, noteIds) { return sha256(JSON.stringify([promptVersion, [...noteIds].sort()])); }
  pageCnf(noteIds) { return minimizeCnf(noteIds.map((id) => this.aclOf('notes', id)).filter((a) => a.length)); }
  readerSatisfies(cnf) { const v = this.viewer; return !v || satisfies((g) => (v.groups.includes(g) ? 'read' : 'none'), cnf); }
  cachedPage(entityId, promptVersion) {
    const ids = this.visibleNoteIds(entityId);
    const row = this.one('SELECT * FROM mc_page_cache WHERE key=?', [this.pageKey(promptVersion, ids)]);
    if (!row || !this.readerSatisfies(asJson(row.cnf))) return null;
    return { ...row, nodes: asJson(row.nodes), note_ids: asJson(row.note_ids), cnf: asJson(row.cnf) };
  }
  /** The viewer's page: from the cache when anyone has generated it from the same visible notes, else generated once. */
  pageFor(entityId, { promptVersion = PAGE_PROMPT, generate = outlinePage } = {}) {
    const hit = this.cachedPage(entityId, promptVersion);
    if (hit) return { cached: true, ...hit };
    const entity = this.one('SELECT id,name,type FROM entities WHERE id=?', [entityId]);
    const notes = this.entityNotes(entityId, { limit: 1000000 });
    const ids = notes.map((n) => n.id).sort();
    const nodes = generate({ entity, notes });
    const row = { key: this.pageKey(promptVersion, ids), entity_id: entityId, prompt_version: promptVersion, note_ids: JSON.stringify(ids), cnf: JSON.stringify(this.pageCnf(ids)), nodes: JSON.stringify(nodes), generated_at: this.now(), generated_by: this.user ?? 'local' };
    this.tx(() => {
      this.run('INSERT OR IGNORE INTO mc_page_cache(key,entity_id,prompt_version,note_ids,cnf,nodes,generated_at,generated_by) VALUES(?,?,?,?,?,?,?,?)', [row.key, row.entity_id, row.prompt_version, row.note_ids, row.cnf, row.nodes, row.generated_at, row.generated_by]);
      if (ids.length && JSON.parse(row.cnf).length) this.emit([{ t: 'mc_page_cache', pk: row.key, img: row, cnf: JSON.parse(row.cnf) }]);
    });
    return { cached: false, ...row, nodes, note_ids: ids, cnf: JSON.parse(row.cnf) };
  }

  // ---- writes ----
  writerRole(grp) { return this.user ? this.roleOf(this.user, grp) : 'admin'; }
  checkWrite(acl) {
    for (const g of acl) if (!this.one('SELECT 1 AS ok FROM mc_groups WHERE grp=?', [g])) throw new StoreError(`unknown group ${g}`);
    if (this.user && !canWrite((g) => this.writerRole(g), acl)) throw new StoreError(`${this.user} cannot write into ${acl.join(', ')}`);
    return acl;
  }
  /** The hub's rule, applied before anything is queued: changing a row needs write in every group of its ACL. */
  mayModify(t, id) {
    if (!this.user || !this.one(`SELECT 1 AS ok FROM ${t} WHERE id=?`, [id])) return;
    const acl = this.aclOf(t, id);
    if (acl.length && !canWrite((g) => this.writerRole(g), acl)) throw new StoreError(`${this.user} cannot write into ${acl.join(', ')}`);
  }
  aclArg(value) { try { return value === undefined || value === null ? null : this.checkWrite(normAcl(value)); } catch (e) { throw e instanceof PolicyError ? new StoreError(e.message) : e; } }
  /** The ACL of a row written without one. Fail closed: a user who can write into several groups must name the one
   * (writeGroups).
   */
  defaultAcl() {
    if (this.writeGroups) return this.writeGroups;
    if (!this.user) return [];
    const g = this.groupsOf(this.user, 2);
    if (g.length > 1) throw new StoreError(`${this.user} can write into ${g.join(', ')}: pass writeGroups so an unlabelled row defaults to one group, never all`);
    return g;
  }

  /** The content screen on an explicit ACL: a new row asked into a screened group that the writer's default does not already include is
   * refused when its text matches SCREEN_PATTERN, so the owner's private material never reaches the team group by a label alone. A
   * writer whose default already includes the screened group writes into it and is not screened.
   */
  screenAcl(acl, text, what) {
    if (!acl) return acl;
    const def = this.writeGroups ?? [];
    if (!acl.some((g) => SCREENED_GROUPS.includes(g) && !def.includes(g))) return acl;
    const m = String(text ?? '').match(SCREEN_PATTERN);
    if (m) throw new StoreError(`content screen: ${what} matches "${m[0]}", so it cannot go to ${acl.filter((g) => SCREENED_GROUPS.includes(g)).join(', ')}; leave groups unset (default ${def.join(', ') || 'none'}) or reword`);
    return acl;
  }

  /** opts.groups: the ACL of every new note, work item and entity in this batch that names none itself (item `acl` or `groups`). */
  apply(batchId, changes, opts = {}) {
    if (!this.user && !this.writeGroups) return super.apply(batchId, changes, opts);
    const items = (k) => (changes && typeof changes === 'object' && Array.isArray(changes[k]) ? changes[k] : []).filter((x) => x && typeof x === 'object' && !Array.isArray(x));
    const ctx = { notes: [], entities: [], work: [] };
    const asked = (it) => it.acl ?? it.groups ?? opts.groups;
    for (const it of items('notes')) {
      ctx.notes.push(this.screenAcl(this.aclArg(asked(it)), it.body, 'note'));
      if (this.viewer) for (const e of Array.isArray(it.entities) ? it.entities : []) if (!isTemp(e) && typeof e === 'string' && this.one('SELECT 1 AS ok FROM entities WHERE id=?', [e]) && !this.aclVisible('entities', this.resolveEntity(e))) throw new StoreError(`entity ${e} is not shared with ${this.user}`);
    }
    for (const it of items('entities')) {
      if (isTemp(it.id) && !it.merge_into && !it.unmerge) ctx.entities.push(this.screenAcl(this.aclArg(asked(it)), [it.name, ...(Array.isArray(it.aliases) ? it.aliases : [])].join(' '), 'entity'));
      else if (typeof it.id === 'string') this.mayModify('entities', it.id);
      if (typeof it.merge_into === 'string' && !isTemp(it.merge_into)) this.mayModify('entities', it.merge_into);
    }
    for (const it of items('work')) { if (isTemp(it.id)) ctx.work.push(this.screenAcl(this.aclArg(asked(it)), `${it.title ?? ''} ${it.body ?? ''}`, 'work item')); else if (typeof it.id === 'string') this.mayModify('work', it.id); }
    for (const it of items('identities')) if (typeof it.entity === 'string' && !isTemp(it.entity)) this.mayModify('entities', it.entity);
    // A PageNode is derived: never a source, never testimony. Citing one is refused by name, not left to look like a missing row.
    const refs = [...(Array.isArray(opts.sourceRefs) ? opts.sourceRefs : []), ...items('notes').flatMap((n) => [...(Array.isArray(n.source_refs) ? n.source_refs : []), ...(Array.isArray(n.note_refs) ? n.note_refs : [])]), ...items('work').flatMap((w) => (Array.isArray(w.source_refs) ? w.source_refs : []))];
    for (const ref of refs) if (typeof ref === 'string' && this.one('SELECT 1 AS ok FROM mc_pagenodes WHERE id=?', [ref])) throw new StoreError(`${ref} is a PageNode: derived, never evidence; cite the notes it rests on`);
    this._ctx = ctx;
    let out;
    try { out = super.apply(batchId, changes, opts); } finally { this._ctx = null; }
    // A note shared wider than an entity it names: the link stays in the entity's groups (derivedAcl), so readers there see
    // the note without that entity. Said in the result so the writer can share the entity on purpose, never widened silently.
    const narrow = [];
    for (const n of out?.notes || []) {
      const id = typeof n === 'string' ? n : n?.id;
      const acl = id ? this.aclOf('notes', id) : [];
      for (const r of id ? this.all('SELECT entity_id FROM note_entities WHERE note_id=?', [id]) : []) {
        const missing = acl.filter((g) => !this.aclOf('entities', r.entity_id).includes(g));
        if (missing.length) narrow.push({ note: id, entity: r.entity_id, not_in: missing });
      }
    }
    if (narrow.length) out.entities_narrower_than_note = narrow;
    if (out && (opts.groups || ctx.notes.some(Boolean) || ctx.entities.some(Boolean) || ctx.work.some(Boolean))) out.groups = { batch: opts.groups ?? null, default: this.writeGroups ?? null };
    return out;
  }
  ingest(records, { acl } = {}) {
    if (!this.user && !this.writeGroups) return super.ingest(records);
    this._ctx = { raw: this.aclArg(acl) };
    try { return super.ingest(records); } finally { this._ctx = null; }
  }
  index(kind, id, text) { super.index(kind, id, text); if (kind !== 'page') this._idx.push({ kind, id, text }); }
  tx(work) {
    this._idx = []; // index calls of a rolled-back transaction must never ride along with the next one
    try { return super.tx(() => { const out = work(); this.seal(); return out; }); } finally { this._idx = []; }
  }

  /** Inside the transaction: the rows it changed become one logged action, each row with its ACL. */
  seal() {
    const rows = this.all('SELECT t, pk FROM mc_outbox ORDER BY n');
    const idx = this._idx; this._idx = [];
    if (!rows.length) return null;
    this.run('DELETE FROM mc_outbox');
    if (!this.user && !this.writeGroups && !this.one('SELECT 1 AS ok FROM mc_groups LIMIT 1')) return null; // no tenancy: nothing to replicate
    const ctx = this._ctx || {};
    const queue = { notes: [...(ctx.notes || [])], entities: [...(ctx.entities || [])], work: [...(ctx.work || [])] };
    const seen = new Set(), out = [];
    const def = this.defaultAcl();
    for (const { t, pk } of rows) {
      if (seen.has(t + '\0' + pk)) continue;
      seen.add(t + '\0' + pk);
      let acl = t === 'changes' ? [] : this.aclOf(t, pk);
      // A row that was retracted (every group revoked) stays out of every view when a later plain update touches it (a raw row marked
      // processed, a work item's version): without this the default ACL below handed it back to its writer's group.
      if (!acl.length && t !== 'changes' && this.one('SELECT 1 AS ok FROM mc_acl WHERE t=? AND pk=? AND revoked=1 LIMIT 1', [t, pk])) continue;
      if (!acl.length) {
        const k = JSON.parse(TABLES[t].pk.length > 1 ? pk : '[]');
        if (t === 'notes' || t === 'entities' || t === 'work') acl = queue[t].shift() ?? def;
        else if (t === 'note_entities' || t === 'work_entities') { acl = this.derivedAcl(t, { [t === 'note_entities' ? 'note_id' : 'work_id']: k[0], entity_id: k[1] }); if (!acl.length) acl = def; }
        else if (t === 'identities') { const r = this.one('SELECT entity_id FROM identities WHERE source=? AND account=? AND native=?', k); acl = r ? this.aclOf('entities', r.entity_id) : def; }
        else if (t === 'mentions') { acl = this.derivedAcl('mentions', this.one('SELECT raw_id, entity_id, considered FROM mentions WHERE id=?', [pk]) ?? {}); if (!acl.length) acl = def; }
        else if (t === 'raw_data') acl = ctx.raw ?? def;
        else if (t === 'changes') { acl = this.derivedAcl('changes', this.one('SELECT * FROM changes WHERE seq=?', [Number(pk)]) ?? {}); if (!acl.length) acl = def; }
        else acl = def;
        if (!acl.length) continue; // nothing to share it with: stays local
        this.setAcl(t, pk, acl);
      }
      // A local change to a row in a group this writer neither writes nor holds a key for stays local: the hub refuses it and a part for it
      // cannot be sealed, and queued it stalled every later action of the device ("no key for any of private").
      if (this.device && this.user && acl.some((g) => !this.writes(g) && !this.keyFor(g, this.currentEpoch(g)))) { this.localOnly = (this.localOnly ?? 0) + 1; continue; }
      const img = this.one(`SELECT * FROM ${t} WHERE ${TABLES[t].pk.map((c) => `${c}=?`).join(' AND ')}`, TABLES[t].pk.length > 1 ? JSON.parse(pk) : [t === 'changes' ? Number(pk) : pk]);
      if (!img) continue;
      out.push({ t, pk, img: this.rawImage(t, pk), acl });
      if (t === 'notes') out.push(...this.stubsFor(img, acl));
    }
    for (const { kind, id, text } of idx) {
      const acl = this.aclOf(KIND_TABLE[kind], id);
      if (acl.length && this.device && this.user && acl.some((g) => !this.writes(g) && !this.keyFor(g, this.currentEpoch(g)))) continue;
      if (acl.length) out.push({ t: 'mem_search', pk: `${kind}\0${id}`, img: { kind, id, text }, acl });
    }
    return this.emit(out);
  }
  /** The ACL of a DERIVED row (a mention, a note-entity link, a work-entity link): the intersection of the ACLs of every row it
   * references, and nothing wider. A reference that is private-only or unknown (no ACL rows) empties the set; the caller then
   * falls back to the writer's default group (fail closed). A mention is the raw row's text plus the entities the matcher
   * considered, and `considered` carries their NAMES, so those entities are references too.
   */
  derivedAcl(t, row) {
    let acl, refs;
    if (t === 'mentions') {
      let considered = [];
      try { considered = typeof row.considered === 'string' ? JSON.parse(row.considered) : (row.considered ?? []); } catch { considered = null; }
      if (considered === null || !Array.isArray(considered)) return []; // unreadable list of names: refuse to widen
      acl = row.raw_id ? this.aclOf('raw_data', row.raw_id) : this.defaultAcl();
      refs = [row.entity_id, ...considered.map((c) => c?.entity)].filter((x) => x !== null && x !== undefined && x !== '');
    } else if (t === 'note_entities') { acl = this.aclOf('notes', row.note_id); refs = [row.entity_id]; }
    else if (t === 'work_entities') { acl = this.aclOf('work', row.work_id); refs = [row.entity_id]; }
    else if (t === 'changes') {
      // a change row is the before/after image of its target, and those images list entity ids (a note's `entities`): references too
      const tt = KIND_TABLE[row.kind];
      acl = tt ? this.aclOf(tt, row.target_id) : [];
      refs = [...new Set(`${row.before ?? ''} ${row.after ?? ''}`.match(/\be_[0-9a-f]{10}\b/g) ?? [])];
    }
    else return [];
    for (const id of refs) { const e = typeof id === 'string' ? this.aclOf('entities', id) : []; acl = acl.filter((g) => e.includes(g)); }
    return acl;
  }
  /** True when this writer has write role in `grp` (a missing key is a wait, not a refusal). */
  writes(grp) { return rank(this.writerRole(grp)) >= 2; }
  /** True when this writer may change a row in `grp` and can seal a part for it: write role and the group's current key. */
  canSeal(grp) { return rank(this.writerRole(grp)) >= 2 && (!this.device || !!this.keyFor(grp, this.currentEpoch(grp))); }
  /** Safety net on every sync: any derived row whose active ACL is wider than derivedAcl allows is narrowed (the groups it
   * should not have are unshared in the log, so replicas that applied it hide it). Returns what it narrowed; `.skipped`
   * counts rows left alone because this writer could not change them. Only rows whose every current group this writer writes
   * and holds the key for are touched: the hub refuses a change to a row by a writer missing any of its groups, and a part
   * for a group without its key cannot be sealed.
   */
  enforceDerived() {
    const base = this.writeGroups ?? [];
    const narrowed = [];
    Object.defineProperty(narrowed, 'skipped', { value: 0, writable: true }); // not enumerable: callers compare the list
    for (const t of ['mentions', 'note_entities', 'work_entities', 'changes']) {
      const cols = TABLES[t].pk;
      for (const { pk } of this.all('SELECT DISTINCT pk FROM mc_acl WHERE t=? AND revoked=0 AND grp NOT IN (SELECT value FROM json_each(?))', [t, j(base)])) {
        const keys = cols.length > 1 ? JSON.parse(pk) : [pk];
        const row = this.one(`SELECT * FROM ${t} WHERE ${cols.map((c) => `${c}=?`).join(' AND ')}`, keys);
        if (!row) continue;
        const cur = this.aclOf(t, pk), allowed = this.derivedAcl(t, row);
        const extra = cur.filter((g) => !allowed.includes(g));
        if (!extra.length) continue;
        if (!cur.every((g) => this.canSeal(g))) { narrowed.skipped++; continue; }
        const next = cur.filter((g) => allowed.includes(g));
        const to = next.length ? next : this.defaultAcl();
        if (!to.length || !to.every((g) => this.canSeal(g))) { if (to.length) narrowed.skipped++; continue; }
        this.tx(() => {
          this.setAcl(t, pk, to);
          this.emit([{ t, pk, img: this.rawImage(t, pk), acl: to }, { t: 'mc_unshare', pk: `${t}\0${pk}`, img: { t, pk: String(pk), acl: to }, acl: extra }]);
        });
        narrowed.push({ t, pk, removed: extra, now: to });
      }
    }
    return narrowed;
  }
  /** A row image byte for byte: JSON columns stay the text another writer stored (the store's reads decode them). */
  rawImage(t, pk) {
    const keys = TABLES[t].pk.length > 1 ? JSON.parse(pk) : [t === 'changes' ? Number(pk) : pk];
    return encodeRow(t, { ...this.db.prepare(`SELECT * FROM ${t} WHERE ${TABLES[t].pk.map((c) => `${c}=?`).join(' AND ')}`).get(...keys) });
  }
  /** The writer's policy verdict on a note's sources, for readers whose replica will not hold them. */
  stubsFor(note, acl) {
    const n = decodeRow('notes', note);
    const allowed = this.policyVisible('note', n) ? 1 : 0;
    const out = [];
    for (const ref of supportRefs(this, [n], [], [])) {
      const raw = this.one('SELECT id FROM raw_data WHERE id=?', [ref]);
      if (raw && acl.every((g) => this.aclOf('raw_data', ref).includes(g))) continue;
      out.push({ t: 'mc_raw_stub', pk: String(ref), img: { id: String(ref), allowed }, acl });
    }
    for (const ref of n.note_refs || []) if (!acl.every((g) => this.aclOf('notes', ref).includes(g))) out.push({ t: 'mc_raw_stub', pk: `unavailable-note:${ref}`, img: { id: `unavailable-note:${ref}`, allowed }, acl });
    return out;
  }
  emit(rows) {
    if (!rows.length || !this.device) return null;
    const originSeq = (this.one('SELECT MAX(origin_seq) AS n FROM mc_log WHERE origin=?', [this.device])?.n ?? 0) + 1;
    const ts = this.now();
    const body = j({ rows });
    const id = sha256(`${this.device}\0${originSeq}\0${ts}\0${body}`);
    this.run('INSERT INTO mc_log(id, origin, origin_seq, ts, body) VALUES(?,?,?,?,?)', [id, this.device, originSeq, ts, body]);
    for (const r of rows) if (TABLES[r.t] && !TABLES[r.t].immutable) this.run('INSERT INTO mc_rowver(t,pk,seq,pending) VALUES(?,?,?,1) ON CONFLICT(t,pk) DO UPDATE SET pending=pending+1', [r.t, r.pk, 0]);
    for (const r of rows) for (const ev of grantEvents(r)) this.run('INSERT INTO mc_aclpending(t,pk,grp,n) VALUES(?,?,?,1) ON CONFLICT(t,pk,grp) DO UPDATE SET n=n+1', [ev.t, ev.pk, ev.grp]);
    return id;
  }
  /** Flush rows written outside a transaction (store helpers that update in place). */
  flush() { return this.tx(() => null); }

  /** Widen or narrow who can read one row (and the rows that belong to it). */
  share(kind, id, acl) {
    const t = KIND_TABLE[kind];
    if (!t) throw new StoreError(`cannot share ${kind}`);
    const next = this.checkWrite(normAcl(acl));
    // A row written outside the cloud (the Python memory_apply, chat tools) has no ACL until a flush seals it; seal now
    // instead of refusing, so a fresh note is shareable at once rather than after the next heartbeat.
    if (!this.aclOf(t, id).length && this.one('SELECT 1 AS ok FROM mc_outbox WHERE t=? AND pk=? LIMIT 1', [t, String(id)])) this.flush();
    const prev = this.aclOf(t, id);
    if (!prev.length) throw new StoreError(`${kind} ${id} has no ACL on this replica`);
    if (this.user && !canRead((g) => this.writerRole(g), prev)) throw new StoreError(`${this.user} cannot see ${kind} ${id}`);
    const removed = prev.filter((g) => !next.includes(g));
    if (this.user && removed.some((g) => rank(this.writerRole(g)) < 2)) throw new StoreError(`${this.user} cannot unshare from a group they do not write`);
    if (t === 'mc_pagenodes' && next.some((g) => !prev.includes(g))) throw new StoreError(`a PageNode never widens access: ${id} is in ${prev.join(', ')}; it can only be narrowed`);
    if (prev.join() === next.join()) return { id, acl: next, op: 'unchanged' };
    return this.tx(() => {
      const rows = [];
      const add = (tt, pk, acl = next) => { this.setAcl(tt, pk, acl); const img = this.one(`SELECT * FROM ${tt} WHERE ${TABLES[tt].pk.map((c) => `${c}=?`).join(' AND ')}`, TABLES[tt].pk.length > 1 ? JSON.parse(pk) : [pk]); if (img) rows.push({ t: tt, pk, img: this.rawImage(tt, pk), acl }); return img; };
      const img = add(t, String(id));
      const linkAcl = (r) => { const e = this.aclOf('entities', r.entity_id); const a = next.filter((g) => e.includes(g)); return a.length ? a : this.defaultAcl(); };
      if (t === 'notes') {
        for (const r of this.all('SELECT entity_id FROM note_entities WHERE note_id=?', [id])) add('note_entities', JSON.stringify([id, r.entity_id]), linkAcl(r));
        rows.push(...this.stubsFor(img, next));
        // a PageNode citing the note leaves every group the note left (its audience is the groups holding all its notes)
        for (const pn of this.pageNodesCiting(id)) {
          const gone = this.aclOf('mc_pagenodes', pn).filter((g) => removed.includes(g));
          if (!gone.length) continue;
          this.run('UPDATE mc_acl SET revoked=1 WHERE t=? AND pk=? AND grp IN (SELECT value FROM json_each(?))', ['mc_pagenodes', pn, j(gone)]);
          rows.push({ t: 'mc_unshare', pk: `mc_pagenodes\0${pn}`, img: { t: 'mc_pagenodes', pk: pn, acl: this.aclOf('mc_pagenodes', pn) }, acl: gone });
        }
      }
      if (t === 'work') for (const r of this.all('SELECT entity_id FROM work_entities WHERE work_id=?', [id])) add('work_entities', JSON.stringify([id, r.entity_id]), linkAcl(r));
      if (t === 'entities') for (const r of this.all('SELECT source,account,native FROM identities WHERE entity_id=?', [id])) add('identities', JSON.stringify([r.source, r.account, r.native]));
      const text = { notes: () => img.body, entities: () => [img.name, ...JSON.parse(img.aliases)].join(' '), work: () => [img.title, img.body, img.status].join(' ') }[t];
      if (text) rows.push({ t: 'mem_search', pk: `${kind}\0${id}`, img: { kind, id, text: this.one('SELECT text FROM mem_search WHERE kind=? AND id=?', [kind, id])?.text ?? text() }, acl: next });
      if (removed.length) rows.push({ t: 'mc_unshare', pk: `${t}\0${id}`, img: { t, pk: String(id), acl: next }, acl: removed });
      this.emit(rows);
      return { id, acl: next, op: 'shared', removed };
    });
  }
  /** Take a row out of every view, the way a rejected row leaves them: it stays in its table and the log; an unshare of all its groups replicates. */
  retract(kind, id) {
    const t = KIND_TABLE[kind];
    const prev = t ? this.aclOf(t, id) : [];
    if (!prev.length) throw new StoreError(`${kind} ${id} has no ACL on this replica`);
    if (this.user && !canWrite((g) => this.writerRole(g), prev)) throw new StoreError(`${this.user} cannot retract from a group they do not write`);
    return this.tx(() => {
      this.run('UPDATE mc_acl SET revoked=1 WHERE t=? AND pk=?', [t, String(id)]);
      const rows = [{ t: 'mc_unshare', pk: `${t}\0${id}`, img: { t, pk: String(id), acl: [] }, acl: prev }];
      // The rows that belong to it (links, mentions, change images naming it) leave the same groups now, not at the owner's next sync.
      // Only groups of the retracted row are touched: the writer writes all of them (checked above) and holds their keys, whereas a
      // store-wide enforceDerived on a replica that cannot see every reference widened and narrowed rows it should not.
      for (const d of this.dependentsOf(t, String(id))) {
        const gone = this.aclOf(d.t, d.pk).filter((g) => prev.includes(g));
        if (!gone.length) continue;
        this.run(`UPDATE mc_acl SET revoked=1 WHERE t=? AND pk=? AND grp IN (SELECT value FROM json_each(?))`, [d.t, d.pk, j(gone)]);
        const left = this.aclOf(d.t, d.pk);
        rows.push({ t: 'mc_unshare', pk: `${d.t}\0${d.pk}`, img: { t: d.t, pk: d.pk, acl: left }, acl: gone });
      }
      this.emit(rows);
      return { id, acl: [], op: 'retracted', removed: prev, ...(rows.length > 1 ? { dependents: rows.length - 1 } : {}) };
    });
  }
  /** Replicated rows that exist because of one row: its entity links, mentions naming it, and change rows about it or naming it. */
  dependentsOf(t, id) {
    const out = [];
    const add = (tt, list) => { for (const pk of list) out.push({ t: tt, pk: String(pk) }); };
    const kind = { notes: 'note', entities: 'entity', work: 'work' }[t];
    if (t === 'notes') { add('note_entities', this.all('SELECT entity_id FROM note_entities WHERE note_id=?', [id]).map((r) => JSON.stringify([id, r.entity_id]))); add('mc_pagenodes', this.pageNodesCiting(id)); }
    if (t === 'work') add('work_entities', this.all('SELECT entity_id FROM work_entities WHERE work_id=?', [id]).map((r) => JSON.stringify([id, r.entity_id])));
    if (t === 'entities') {
      add('note_entities', this.all('SELECT note_id FROM note_entities WHERE entity_id=?', [id]).map((r) => JSON.stringify([r.note_id, id])));
      add('work_entities', this.all('SELECT work_id FROM work_entities WHERE entity_id=?', [id]).map((r) => JSON.stringify([r.work_id, id])));
      add('mentions', this.all("SELECT id FROM mentions WHERE entity_id=? OR considered LIKE '%' || ? || '%'", [id, id]).map((r) => r.id));
      add('changes', this.all("SELECT seq FROM changes WHERE kind!='entity' AND (before LIKE '%' || ? || '%' OR after LIKE '%' || ? || '%')", [id, id]).map((r) => r.seq));
    }
    if (kind) add('changes', this.all('SELECT seq FROM changes WHERE kind=? AND target_id=?', [kind, id]).map((r) => r.seq));
    return out;
  }
  // ---- PageNodes: derived page nodes, replicated, never notes and never evidence ----
  /** Ids of the PageNodes resting on note `noteId`. */
  pageNodesCiting(noteId) { return this.all('SELECT id FROM mc_pagenodes WHERE EXISTS (SELECT 1 FROM json_each(cited) c WHERE c.value=?) ORDER BY id', [String(noteId)]).map((r) => r.id); }
  /** A note this viewer reads: it exists here, is not retracted, and passes the viewer's ACL and the source policy. */
  noteReadable(id) {
    const n = this.one('SELECT * FROM notes WHERE id=?', [String(id)]);
    if (!n) return false;
    if (this.tenancy && !this.aclOf('notes', id).length) return false;
    return this.memoryVisible('note', n);
  }
  /** The audience of notes: the groups holding every one of them (sorted); [] when one has none or is not here. */
  noteAudience(ids) {
    let acc = null;
    for (const id of new Set(ids)) {
      const a = this.aclOf('notes', id);
      acc = acc ? acc.filter((g) => a.includes(g)) : a;
      if (!acc.length) return [];
    }
    return acc ?? [];
  }
  /**
   * Store one signed PageNode record (the groups package's shape). Its audience is the groups holding every note it cites, as this
   * store sees them; `scopes` (default: the audience groups this writer writes) must lie inside it, so a PageNode never widens
   * access. Every cited note must be one this writer reads; the key must hash from the cited notes; `publicKey` (PEM), when given,
   * must verify the signature (readers verify against their own trust anyway). Replicates as one logged action like a note.
   * Returns { id, scopes, audience, op: 'stored' | 'unchanged' }.
   */
  putPageNode(record, { scopes = null, publicKey = null } = {}) {
    if (!this.tenancy) throw new StoreError('PageNodes need tenancy (a user or writeGroups): they are scoped by audience');
    const why = pageNodeError(record, { publicKey });
    if (why) throw new StoreError(`not a PageNode: ${why}`);
    const row = pageNodeRow(record);
    for (const id of JSON.parse(row.cited)) {
      if (!this.one('SELECT 1 AS ok FROM notes WHERE id=?', [id])) throw new StoreError(`PageNode cites ${id}, which is not a note here`);
      const acl = this.aclOf('notes', id);
      if (!acl.length || (this.user && !canRead((g) => this.writerRole(g), acl))) throw new StoreError(`PageNode cites note ${id}, which ${this.user ?? 'this writer'} does not read`);
    }
    const audience = this.noteAudience(JSON.parse(row.cited));
    if (!audience.length) throw new StoreError('no group holds every note this PageNode cites: nothing to share it with');
    let acl;
    if (scopes !== null && scopes !== undefined) {
      acl = this.aclArg(scopes);
      const wider = acl.filter((g) => !audience.includes(g));
      if (wider.length) throw new StoreError(`a PageNode never widens access: ${wider.join(', ')} does not hold every note it cites (audience ${audience.join(', ')})`);
    } else {
      acl = audience.filter((g) => this.writes(g));
      if (!acl.length) throw new StoreError(`${this.user} writes no group of the audience ${audience.join(', ')}`);
      this.checkWrite(acl);
    }
    if (this.one('SELECT 1 AS ok FROM mc_pagenodes WHERE id=?', [row.id])) return { id: row.id, scopes: this.aclOf('mc_pagenodes', row.id), audience, op: 'unchanged' };
    this.tx(() => {
      this.setAcl('mc_pagenodes', row.id, acl);
      this.run('INSERT INTO mc_pagenodes(id,entity,key,path,at,author,cited,record) VALUES(?,?,?,?,?,?,?,?)', [row.id, row.entity, row.key, row.path, row.at, row.author, row.cited, row.record]);
    });
    return { id: row.id, scopes: acl, audience, op: 'stored' };
  }
  /**
   * PageNodes of `entity` (optionally one `key`) this viewer reads, as entries { id, record, scopes }, oldest clock first then id.
   * A viewer reads one iff it holds at least one group of its audience (its active ACL) and reads every note it cites; a retracted
   * PageNode (no active group) is read by nobody. `scopes`: only entries whose audience meets these groups.
   */
  pageNodes({ entity, key = null, scopes = null } = {}) {
    if (typeof entity !== 'string' || !entity) throw new StoreError('pageNodes needs an entity id');
    const v = this.viewer;
    const want = scopes === null || scopes === undefined ? null : new Set(scopes);
    const out = [];
    for (const row of this.all(`SELECT id, cited, record FROM mc_pagenodes WHERE entity=?${key ? ' AND key=?' : ''} ORDER BY at, id`, key ? [entity, key] : [entity])) {
      const acl = this.aclOf('mc_pagenodes', row.id);
      if (!acl.length || (v && !acl.some((g) => v.groups.includes(g))) || (want && !acl.some((g) => want.has(g)))) continue;
      if (!JSON.parse(row.cited).every((id) => this.noteReadable(id))) continue;
      out.push({ id: row.id, record: JSON.parse(row.record), scopes: acl });
    }
    return out;
  }

  // ---- purge: a replica holds plaintext only for rows its user reads ----
  /** Groups whose rows this replica's user may read. */
  readGroups() { return this.user ? this.groupsOf(this.user) : []; }
  /** True when a row's own log entry (this device wrote it into a group it reads) holds its image: this device's own material. */
  heldInOwnLog(t, pk, mine = this.readGroups()) {
    return Boolean(this.one(`SELECT 1 AS ok FROM mc_log l, json_each(l.body, '$.rows') r WHERE l.origin=? AND json_extract(r.value,'$.t')=? AND json_extract(r.value,'$.pk')=?
      AND EXISTS (SELECT 1 FROM json_each(json_extract(r.value,'$.acl')) g WHERE g.value IN (SELECT value FROM json_each(?))) LIMIT 1`, [this.device, t, String(pk), j(mine)]));
  }
  /**
   * May this replica drop a row's body? Only on a device replica (device and user), for a replicated row that has ACL rows, none of them an
   * active grant in a group the user reads, no local pending write, and not this device's own material (its image is in this device's log,
   * so dropping the table copy would hide it without removing it). `foreignGrant`: also require an active grant in some other group
   * (the row lives on elsewhere, e.g. narrowed to private), the one-time pass's rule.
   */
  purgeable(t, pk, { foreignGrant = false, mine = this.readGroups() } = {}) {
    if (!this.device || !this.user || !TABLES[t]) return false;
    const acl = this.all('SELECT grp, revoked FROM mc_acl WHERE t=? AND pk=?', [t, String(pk)]);
    if (!acl.length) return false;
    const active = acl.filter((r) => !r.revoked).map((r) => r.grp);
    if (active.some((g) => mine.includes(g))) return false;
    if (foreignGrant && !active.length) return false;
    if ((this.one('SELECT pending FROM mc_rowver WHERE t=? AND pk=?', [t, String(pk)])?.pending ?? 0) > 0) return false;
    return !this.heldInOwnLog(t, pk, mine);
  }
  /** Inside a transaction: run `work` with the delete guards of the append-only tables lifted, then put them back. */
  withDeletes(work) {
    for (const t of [...APPEND_ONLY, 'mc_page_cache']) this.db.exec(`DROP TRIGGER IF EXISTS mc_append_only_${t}_delete`);
    try { return work(); } finally { this.db.exec(triggers()); }
  }
  /**
   * Inside a transaction: delete one row's body and every row that exists because of it or quotes it (links, mentions, identities,
   * change images, search text, cached and stored pages citing it, deferred images), leaving its ACL rows and a tombstone
   * (mc_purged, at hub position `hubSeq`) so an older image is ignored and a later re-share brings the row back. Returns counts.
   */
  purgeRow(t, pk, hubSeq, reason) {
    pk = String(pk);
    const n = {};
    const at = this.now();
    const count = (k, res) => { if (res.changes) n[k] = (n[k] ?? 0) + res.changes; };
    const tomb = (tt, key) => { if (tt !== 'changes') this.run('INSERT INTO mc_purged(t,pk,hub_seq,at,reason) VALUES(?,?,?,?,?) ON CONFLICT(t,pk) DO UPDATE SET hub_seq=MAX(hub_seq, excluded.hub_seq), at=excluded.at, reason=excluded.reason', [tt, String(key), hubSeq, at, reason]); };
    const delKeyed = (tt, where, params) => {
      const cols = TABLES[tt].pk;
      for (const r of this.all(`SELECT ${cols.join(',')} FROM ${tt} WHERE ${where}`, params)) {
        const key = cols.length > 1 ? JSON.stringify(cols.map((c) => r[c])) : String(r[cols[0]]);
        count(tt, this.run(`DELETE FROM ${tt} WHERE ${cols.map((c) => `${c}=?`).join(' AND ')}`, cols.map((c) => r[c])));
        tomb(tt, key);
        this.run('DELETE FROM mc_deferred WHERE t=? AND pk=?', [tt, key]);
      }
    };
    const like = `%${pk}%`;
    const resetPages = (where, params) => {
      for (const p of this.all(`SELECT entity_id FROM pages WHERE ${where}`, params)) {
        count('pages', this.run("UPDATE pages SET nodes='[]', revision=NULL, input_digest=NULL, dirty=1 WHERE entity_id=?", [p.entity_id]));
        count('mem_search', this.run("DELETE FROM mem_search WHERE kind='page' AND id=?", [p.entity_id]));
        delKeyed('changes', "kind='page' AND target_id=?", [p.entity_id]);
      }
    };
    this.withDeletes(() => {
      const kind = { notes: 'note', entities: 'entity', work: 'work' }[t];
      if (t === 'notes') { delKeyed('note_entities', 'note_id=?', [pk]); delKeyed('mc_pagenodes', 'EXISTS (SELECT 1 FROM json_each(cited) c WHERE c.value=?)', [pk]); }
      if (t === 'work') delKeyed('work_entities', 'work_id=?', [pk]);
      if (t === 'entities') {
        delKeyed('identities', 'entity_id=?', [pk]);
        delKeyed('note_entities', 'entity_id=?', [pk]);
        delKeyed('work_entities', 'entity_id=?', [pk]);
        delKeyed('mentions', 'entity_id=? OR considered LIKE ?', [pk, like]);
        resetPages('entity_id=?', [pk]);
        count('mc_links', this.run('DELETE FROM mc_links WHERE a=? OR b=?', [pk, pk]));
        count('mc_page_cache', this.run('DELETE FROM mc_page_cache WHERE entity_id=?', [pk]));
      }
      if (t === 'raw_data') { delKeyed('mentions', 'raw_id=?', [pk]); count('raw_search', this.run('DELETE FROM raw_search WHERE id=?', [pk])); }
      if (kind) {
        count('mem_search', this.run('DELETE FROM mem_search WHERE kind=? AND id=?', [kind, pk]));
        delKeyed('changes', 'kind=? AND target_id=?', [kind, pk]);
        delKeyed('changes', "(before LIKE ? OR after LIKE ?)", [like, like]); // change images naming it (a page citing a note, a note naming an entity)
        resetPages('nodes LIKE ?', [like]);
        count('mc_page_cache', this.run('DELETE FROM mc_page_cache WHERE note_ids LIKE ? OR nodes LIKE ?', [like, like]));
      }
      const cols = TABLES[t].pk;
      const keys = cols.length > 1 ? JSON.parse(pk) : [t === 'changes' ? Number(pk) : pk];
      count(t, this.run(`DELETE FROM ${t} WHERE ${cols.map((c) => `${c}=?`).join(' AND ')}`, keys));
      tomb(t, pk);
      this.run('DELETE FROM mc_deferred WHERE t=? AND pk=?', [t, pk]);
    });
    return n;
  }
  /** Inside receive's transaction: rows an unshare in this action took out of every group this replica reads lose their body. */
  settlePurges(hubSeq) {
    if (!this._purge?.size || !this.device || !this.user) return;
    const mine = this.readGroups();
    for (const { t, pk } of this._purge.values()) {
      if (!this.purgeable(t, pk, { mine })) continue;
      const n = this.purgeRow(t, pk, hubSeq, 'unshared from every group this replica reads');
      this.purged = (this.purged ?? 0) + (n[t] ?? 0);
    }
    this._purge.clear();
  }
  /**
   * One-time cleanup for rows that lost this replica's groups before purge-on-unshare existed: every row still held in another group
   * and in none this user reads loses its body (purgeRow), its revoked grants get a hub position (the cursor) so a later re-share
   * restores it, and rows of this device's own log in no group it reads (queued before seal() kept such changes local, never sent) are
   * cut from the log bodies. Rows revoked from every group are left: an unshare later re-shared kept some revoked (see putRow).
   * dryRun: only the counts. Run compact() afterwards to remove the freed bytes from the file.
   */
  purgeForeign({ dryRun = false } = {}) {
    if (!this.device || !this.user) throw new StoreError('purge-foreign needs a device replica (device and user)');
    const mine = this.readGroups();
    const cursor = Number(this.one("SELECT v FROM mc_meta WHERE k='cursor'")?.v ?? 0);
    const rows = this.all(`SELECT t, pk FROM mc_acl WHERE t IN (SELECT value FROM json_each(?)) GROUP BY t, pk
      HAVING SUM(revoked=0)>0 AND SUM(revoked=0 AND grp IN (SELECT value FROM json_each(?)))=0 ORDER BY t, pk`, [j(Object.keys(TABLES)), j(mine)])
      .filter((r) => this.purgeable(r.t, r.pk, { foreignGrant: true, mine }));
    const foreignRow = (r) => {
      if (r.control) return false;
      const groups = r.cnf ? r.cnf.flat() : (r.acl ?? []);
      return !groups.some((g) => mine.includes(g));
    };
    const logCuts = this.all('SELECT id, body FROM mc_log WHERE origin=? ORDER BY seq', [this.device])
      .map((a) => { const rs = JSON.parse(a.body).rows; const keep = rs.filter((r) => !foreignRow(r)); return { id: a.id, keep, cut: rs.length - keep.length }; }).filter((a) => a.cut);
    const report = { device: this.device, user: this.user, reads: mine, cursor, rows: {}, dependents: {}, log_actions_cut: logCuts.length, log_rows_cut: logCuts.reduce((s, a) => s + a.cut, 0), dry_run: dryRun };
    for (const r of rows) report.rows[r.t] = (report.rows[r.t] ?? 0) + 1;
    if (dryRun) { report.targets = rows; return report; }
    this.run("UPDATE mc_meta SET v='0' WHERE k='capture'");
    try {
      super.tx(() => {
        for (const r of rows) {
          this.run('INSERT OR IGNORE INTO mc_revocations(t,pk,grp,hub_seq) SELECT t, pk, grp, ? FROM mc_acl WHERE t=? AND pk=? AND revoked=1', [cursor, r.t, r.pk]);
          const n = this.purgeRow(r.t, r.pk, cursor, 'purge-foreign: held only in groups this replica does not read');
          for (const [k, v] of Object.entries(n)) if (!(k === r.t)) report.dependents[k] = (report.dependents[k] ?? 0) + v;
        }
        if (logCuts.length) {
          this.db.exec('DROP TRIGGER IF EXISTS mc_append_only_mc_log_update');
          try { for (const a of logCuts) this.run('UPDATE mc_log SET body=? WHERE id=?', [j({ rows: a.keep }), a.id]); } finally { this.db.exec(triggers()); }
        }
      });
    } finally { this.run("UPDATE mc_meta SET v='1' WHERE k='capture'"); }
    return report;
  }
  /** One-time backfill for grants an unshare revoked before mc_revocations existed: replays the hub log in hub order for those (t, pk,
   * group) rows only, with putRow's grant rule (an mc_unshare part revokes its groups at its position; a later image in a part whose acl
   * names the group grants it again; a cnf part never grants), and writes the outcome: rows the log re-shared are granted again, and
   * every replayed revocation gets its hub position so a later re-share re-grants it. actions: the hub log as this replica pulls it
   * (sync.pullLog), in hub order; actions past the cursor are ignored (not applied yet); this device's own actions come from mc_log.
   * Rows the log never mentions, rows of `changes` (per-replica seqs) and rows whose body is not here (purged) are left as they are and
   * counted. A part in a target group this replica cannot open stops the pass.
   */
  regrant(actions, { dryRun = false } = {}) {
    if (!this.device || !this.user) throw new StoreError('regrant needs a device replica (device and user)');
    const cursor = Number(this.one("SELECT v FROM mc_meta WHERE k='cursor'")?.v ?? 0);
    const key = (t, pk, g) => `${t}\0${pk}\0${g}`;
    const targets = new Map();
    for (const r of this.all(`SELECT t, pk, grp FROM mc_acl a WHERE revoked=1 AND t<>'changes' AND t IN (SELECT value FROM json_each(?))
      AND NOT EXISTS (SELECT 1 FROM mc_revocations v WHERE v.t=a.t AND v.pk=a.pk AND v.grp=a.grp) ORDER BY t, pk, grp`, [j(Object.keys(TABLES))])) {
      targets.set(key(r.t, r.pk, r.grp), { ...r, state: null, revokedAt: null });
    }
    const groups = new Set([...targets.values()].map((x) => x.grp));
    const own = new Map(this.all('SELECT hub_seq, body FROM mc_log WHERE origin=? AND hub_seq IS NOT NULL', [this.device]).map((a) => [a.hub_seq, a.body]));
    const rejectedOwn = new Set(this.all('SELECT hub_seq FROM mc_rejected').map((r) => r.hub_seq));
    const fold = (rows, seq) => {
      for (const r of rows) {
        if (r.control) continue;
        if (r.t === 'mc_unshare') { for (const g of r.acl || []) { const x = targets.get(key(r.img.t, String(r.img.pk), g)); if (x) { x.state = 'revoked'; x.revokedAt = seq; } } continue; }
        if (!TABLES[r.t] || r.t === 'changes' || !r.acl) continue;
        for (const g of r.acl) { const x = targets.get(key(r.t, String(r.pk), g)); if (x && (x.state === null || x.state === 'revoked')) x.state = 'granted'; }
      }
    };
    let seen = 0;
    for (const a of actions) {
      if (a.seq > cursor) break;
      seen++;
      if (a.origin === this.device) { if (own.has(a.seq) && !rejectedOwn.has(a.seq)) fold(JSON.parse(own.get(a.seq)).rows, a.seq); continue; }
      for (const [i, part] of (a.parts ?? []).entries()) {
        const meta = part.cnf ? { cnf: part.cnf } : { acl: part.acl };
        let value = null;
        try { value = open(part.sealed, `${a.id}|${part.index ?? i}|${JSON.stringify(meta)}`, (g, e) => this.keyFor(g, e)); } catch { value = null; }
        if (!value) { if ((part.cnf ? part.cnf.flat() : part.acl ?? []).some((g) => groups.has(g))) throw new StoreError(`regrant: hub ${a.seq} part ${part.index ?? i} names a target group and does not open here; refusing a partial replay`); continue; }
        fold(value.rows.map((r) => ({ ...r, acl: part.acl, cnf: part.cnf })), a.seq);
      }
    }
    const report = { device: this.device, user: this.user, cursor, actions: seen, targets: targets.size, granted: [], kept_revoked: [], no_body: [], not_in_log: [], dry_run: dryRun };
    const hasBody = (t, pk) => { const cols = TABLES[t].pk; return Boolean(this.one(`SELECT 1 AS ok FROM ${t} WHERE ${cols.map((c) => `${c}=?`).join(' AND ')}`, cols.length > 1 ? JSON.parse(pk) : [pk])); };
    for (const x of targets.values()) {
      const row = { t: x.t, pk: x.pk, grp: x.grp, revoked_at: x.revokedAt };
      if (x.state === null) report.not_in_log.push(row);
      else if (x.state === 'revoked') report.kept_revoked.push(row);
      else if (!hasBody(x.t, x.pk)) report.no_body.push(row);
      else report.granted.push(row);
    }
    if (dryRun) return report;
    super.tx(() => {
      for (const r of [...report.granted, ...report.kept_revoked]) if (r.revoked_at !== null) this.run('INSERT INTO mc_revocations(t,pk,grp,hub_seq) VALUES(?,?,?,?) ON CONFLICT(t,pk,grp) DO UPDATE SET hub_seq=MAX(hub_seq, excluded.hub_seq)', [r.t, r.pk, r.grp, r.revoked_at]);
      for (const r of report.granted) this.run('UPDATE mc_acl SET revoked=0 WHERE t=? AND pk=? AND grp=? AND revoked=1', [r.t, r.pk, r.grp]);
    });
    this._viewerGroups = null;
    return report;
  }
  /** Drop freed bytes from the file: merge the full-text indexes (deleted entries leave their segments), VACUUM, truncate the WAL. */
  compact() {
    for (const t of ['mem_search', 'raw_search']) this.run(`INSERT INTO ${t}(${t}) VALUES('optimize')`);
    this.db.exec('VACUUM');
    const ck = this.one('PRAGMA wal_checkpoint(TRUNCATE)');
    return { vacuumed: true, checkpoint: ck };
  }

  /** Two ids for one thing (a shared entity meeting a local one): a reversible link, never a rewrite. */
  link(a, b, linked = true) {
    if (a === b) throw new StoreError('link needs two ids');
    for (const id of [a, b]) if (!this.one('SELECT 1 AS ok FROM entities WHERE id=?', [id])) throw new StoreError(`no entity ${id}`);
    [a, b] = [a, b].sort();
    const img = { a, b, linked: linked ? 1 : 0, at: this.now() };
    const acl = this.aclOf('entities', a).filter((g) => this.aclOf('entities', b).includes(g));
    return this.tx(() => {
      this.run('INSERT INTO mc_links(a,b,linked,at) VALUES(?,?,?,?) ON CONFLICT(a,b) DO UPDATE SET linked=excluded.linked, at=excluded.at', [a, b, img.linked, img.at]);
      if (acl.length) this.emit([{ t: 'mc_links', pk: JSON.stringify([a, b]), img, acl }]);
      return img;
    });
  }

  // ---- control plane: groups, members, devices, keys ----
  controlState() { return { groupExists: (g) => Boolean(this.one('SELECT 1 AS ok FROM mc_groups WHERE grp=?', [g])), roleOf: (u, g) => this.roleOf(u, g) }; }
  applyControl(actor, row, at) {
    const { t, img } = row;
    if (t === 'mc_groups') {
      if (!this.one('SELECT 1 AS ok FROM mc_groups WHERE grp=?', [img.grp])) {
        this.run('INSERT INTO mc_groups(grp, created_by, at) VALUES(?,?,?)', [img.grp, actor, at]);
        this.run("INSERT INTO mc_members(grp,user,role,at) VALUES(?,?,'admin',?) ON CONFLICT(grp,user) DO UPDATE SET role='admin'", [img.grp, actor, at]);
      }
    } else if (t === 'mc_members') this.run('INSERT INTO mc_members(grp,user,role,at) VALUES(?,?,?,?) ON CONFLICT(grp,user) DO UPDATE SET role=excluded.role, at=excluded.at', [img.grp, img.user, img.role, at]);
    else if (t === 'mc_devices') this.run('INSERT INTO mc_devices(device,user,public_key,at) VALUES(?,?,?,?) ON CONFLICT(device) DO UPDATE SET public_key=excluded.public_key, at=excluded.at', [img.device, img.user, img.public_key, at]);
    else if (t === 'mc_keys') {
      this.run('INSERT OR IGNORE INTO mc_wraps(grp,epoch,device) VALUES(?,?,?)', [img.grp, img.epoch, img.device]);
      if (img.device === this.device && this.deviceKey) {
        const key = unwrapForDevice(this.deviceKey, img.wrapped, `${img.grp}|${img.epoch}|${img.device}`);
        this.run('INSERT OR IGNORE INTO mc_keys(grp,epoch,key) VALUES(?,?,?)', [img.grp, img.epoch, key.toString('base64')]);
      }
    }
    this._viewerGroups = null;
  }
  control(rows) {
    const at = this.now();
    return this.tx(() => {
      for (const row of rows) {
        try { authorizeControl(this.controlState(), this.user, row); } catch (e) { throw new StoreError(e.message); }
        this.applyControl(this.user, row, at);
      }
      return this.emit(rows.map((r) => ({ ...r, control: true })));
    });
  }
  registerDevice(publicKey) { return this.control([{ t: 'mc_devices', pk: this.device, img: { device: this.device, user: this.user, public_key: publicKey } }]); }
  currentEpoch(grp) { return this.one('SELECT MAX(epoch) AS e FROM mc_keys WHERE grp=?', [grp])?.e ?? 0; }
  keyFor(grp, epoch) { const r = this.one('SELECT key FROM mc_keys WHERE grp=? AND epoch=?', [grp, epoch]); return r ? Buffer.from(r.key, 'base64') : null; }
  keyRows(grp, epoch, key) {
    const members = this.all("SELECT user FROM mc_members WHERE grp=? AND role<>'none'", [grp]).map((r) => r.user);
    return this.all('SELECT device, public_key FROM mc_devices WHERE user IN (SELECT value FROM json_each(?)) ORDER BY device', [j(members)])
      .filter((d) => !this.one('SELECT 1 AS ok FROM mc_wraps WHERE grp=? AND epoch=? AND device=?', [grp, epoch, d.device]))
      .map((d) => ({ t: 'mc_keys', pk: JSON.stringify([grp, epoch, d.device]), img: { grp, epoch, device: d.device, wrapped: wrapForDevice(d.public_key, key, `${grp}|${epoch}|${d.device}`) } }));
  }
  createGroup(grp) {
    const key = newGroupKey();
    this.control([{ t: 'mc_groups', pk: grp, img: { grp } }]);
    this.tx(() => { this.run('INSERT OR IGNORE INTO mc_keys(grp,epoch,key) VALUES(?,?,?)', [grp, 1, key.toString('base64')]); });
    return this.distributeKeys(grp);
  }
  /** Wrap the current key of `grp` to every member device that lacks it. */
  distributeKeys(grp) {
    const epoch = this.currentEpoch(grp), key = this.keyFor(grp, epoch);
    if (!key) throw new StoreError(`this device holds no key for ${grp}`);
    const rows = this.keyRows(grp, epoch, key);
    return rows.length ? this.control(rows) : null;
  }
  setMember(grp, user, role) {
    this.control([{ t: 'mc_members', pk: JSON.stringify([grp, user]), img: { grp, user, role } }]);
    if (rank(role) === 0) return this.rotateKey(grp);
    return this.distributeKeys(grp);
  }
  /** After a removal: a new epoch for future writes, wrapped to the remaining members only. */
  rotateKey(grp) {
    const epoch = this.currentEpoch(grp) + 1, key = newGroupKey();
    this.tx(() => { this.run('INSERT INTO mc_keys(grp,epoch,key) VALUES(?,?,?)', [grp, epoch, key.toString('base64')]); });
    return this.distributeKeys(grp);
  }

  // ---- sync support ----
  pendingActions() { return this.all('SELECT * FROM mc_log WHERE origin=? AND hub_seq IS NULL ORDER BY origin_seq', [this.device]); }
  /** One logged action as hub parts: control rows plain, data rows grouped by ACL and sealed. */
  sealAction(a) {
    const { rows } = JSON.parse(a.body);
    const groups = new Map();
    for (const r of rows) {
      const key = r.control ? 'control' : r.cnf ? 'cnf:' + JSON.stringify(r.cnf) : 'acl:' + r.acl.join(',');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    const parts = [];
    for (const [key, rs] of groups) {
      if (key === 'control') { for (const r of rs) parts.push({ control: { t: r.t, pk: r.pk, img: r.img } }); continue; }
      const cnf = rs[0].cnf ?? null, acl = rs[0].acl ?? null;
      // Rows queued before seal() kept such changes local (above) are dropped here: a part for a group this writer neither writes
      // nor holds a key for cannot be sealed, and it threw and held every later action of the device. A writer demoted after
      // writing still holds the key: that part goes and the hub rejects it (the revoke race), as before.
      if (this.device && this.user && (cnf ? cnf.flat() : acl).some((g) => !this.writes(g) && !this.keyFor(g, this.currentEpoch(g)))) continue;
      // Each clause is wrapped under every group key this device holds; one is enough for a reader in that group.
      const clauses = (cnf ?? [acl]).map((clause) => {
        const held = clause.map((g) => { const epoch = this.currentEpoch(g); const k = this.keyFor(g, epoch); return k ? { group: g, epoch, key: k } : null; }).filter(Boolean);
        if (!held.length) throw new StoreError(`no key for any of ${clause.join(', ')}`);
        return held;
      });
      const idx = parts.length;
      const meta = cnf ? { cnf } : { acl };
      parts.push({ ...meta, sealed: seal({ rows: rs.map(({ t, pk, img }) => ({ t, pk, img })) }, `${a.id}|${idx}|${JSON.stringify(meta)}`, clauses) });
    }
    // The hub's per-device sequence must stay contiguous, so an action left with no part still goes, carrying no rows.
    if (!parts.length) { const g = this.defaultAcl(); parts.push({ acl: g, sealed: seal({ rows: [] }, `${a.id}|0|${JSON.stringify({ acl: g })}`, [g.map((x) => ({ group: x, epoch: this.currentEpoch(x), key: this.keyFor(x, this.currentEpoch(x)) })).filter((h) => h.key)]) }); }
    return { id: a.id, origin_seq: a.origin_seq, ts: a.ts, parts };
  }
  /** Settled by the hub: accepted at `hubSeq`, or rejected there (terminal, with its reason; the log keeps the action). */
  ack(id, hubSeq, rejected = null) { this.tx(() => this.ackIn(id, hubSeq, rejected)); }
  /**
   * The body of ack, for a caller that already holds the transaction (there is no nesting). Every grant event of the action
   * stops being pending and, when the hub accepted it at `hubSeq` (`positions`: false for a superseded local action, whose
   * rows the hub never held there), is recorded at that position, so grant state converges with replicas that apply the
   * same actions in hub order.
   */
  ackIn(id, hubSeq, rejected = null, { positions = true } = {}) {
    {
      const a = this.one('SELECT * FROM mc_log WHERE id=?', [id]);
      if (!a || a.hub_seq !== null) return;
      this.run('UPDATE mc_log SET hub_seq=? WHERE id=?', [hubSeq, id]);
      for (const r of JSON.parse(a.body).rows) for (const ev of grantEvents(r)) {
        this.run('UPDATE mc_aclpending SET n=n-1 WHERE t=? AND pk=? AND grp=?', [ev.t, ev.pk, ev.grp]);
        this.run('DELETE FROM mc_aclpending WHERE t=? AND pk=? AND grp=? AND n<=0', [ev.t, ev.pk, ev.grp]);
        if (rejected || !positions) continue;
        this.run(`INSERT INTO ${ev.op === 'grant' ? 'mc_grants' : 'mc_revocations'}(t,pk,grp,hub_seq) VALUES(?,?,?,?) ON CONFLICT(t,pk,grp) DO UPDATE SET hub_seq=MAX(hub_seq, excluded.hub_seq)`, [ev.t, ev.pk, ev.grp, hubSeq]);
      }
      if (rejected) {
        this.run('INSERT OR IGNORE INTO mc_rejected(id, hub_seq, reason) VALUES(?,?,?)', [id, hubSeq, String(rejected)]);
        // Rows this action created and the hub never confirmed leave every view; they stay in the
        // table and the log (nothing is deleted), and sharing them again after write access returns restores them.
        for (const r of JSON.parse(a.body).rows) {
          if (!TABLES[r.t]) continue;
          const confirmed = !TABLES[r.t].immutable && (this.one('SELECT seq FROM mc_rowver WHERE t=? AND pk=?', [r.t, r.pk])?.seq ?? 0) > 0;
          if (!confirmed) this.run('UPDATE mc_acl SET revoked=1 WHERE t=? AND pk=?', [r.t, r.pk]);
        }
      }
      for (const r of JSON.parse(a.body).rows) {
        if (!TABLES[r.t] || TABLES[r.t].immutable) continue;
        this.run('UPDATE mc_rowver SET pending=pending-1, seq=MAX(seq, ?) WHERE t=? AND pk=?', [hubSeq, r.t, r.pk]);
        const v = this.one('SELECT seq, pending FROM mc_rowver WHERE t=? AND pk=?', [r.t, r.pk]);
        if (v.pending === 0) for (const d of this.all('SELECT * FROM mc_deferred WHERE t=? AND pk=? AND hub_seq>? ORDER BY hub_seq', [r.t, r.pk, v.seq])) this.putRow(JSON.parse(d.row), d.hub_seq);
      }
    }
  }
  /** The hub holds an action of this device at an origin_seq where the local log holds a different one: two replicas
   * claimed this device's sequence. The hub's action stays the history at that position; nothing is deleted here. The
   * local action is marked superseded (settled at the hub's position, listed in mc_superseded) and everything it
   * carried is queued again: table rows from their current state and ACL (never an older image over a newer one, never
   * a wider ACL), other rows verbatim. The re-issued rows ride a new action behind the ones already pending, under a
   * new id.
   */
  reconcileFork(action) {
    const mine = this.one('SELECT * FROM mc_log WHERE origin=? AND origin_seq=?', [this.device, action.origin_seq]);
    if (!mine || mine.hub_seq !== null) return 'own-unknown';
    this.tx(() => {
      this.ackIn(mine.id, action.seq, null, { positions: false });
      this.run('INSERT OR IGNORE INTO mc_superseded(id, origin_seq, hub_seq, hub_id, at) VALUES(?,?,?,?,?)', [mine.id, mine.origin_seq, action.seq, action.id, this.now()]);
      const verbatim = [];
      for (const r of JSON.parse(mine.body).rows) {
        const spec = TABLES[r.t];
        if (!spec) { verbatim.push(r); continue; }
        if (this.one(`SELECT 1 AS ok FROM ${r.t} WHERE ${spec.pk.map((c) => `${c}=?`).join(' AND ')}`, spec.pk.length > 1 ? JSON.parse(r.pk) : [r.t === 'changes' ? Number(r.pk) : r.pk])) this.run('INSERT INTO mc_outbox(t, pk) VALUES(?,?)', [r.t, r.pk]);
      }
      if (verbatim.length) this.emit(verbatim);
    });
    return 'superseded';
  }
  /**
   * One file, one identity: the first sync records where this replica lives; a later sync from another path is a copy
   * (a snapshot or a test run with the live config) and must not push under this device, or the hub's log forks.
   * To move the file on purpose: UPDATE mc_meta SET v=<new realpath> WHERE k='home'.
   */
  checkHome() {
    if (this.path === ':memory:' || !this.device) return;
    let here;
    try { here = realpathSync(this.path); } catch { here = nodePath.resolve(this.path); }
    const row = this.one("SELECT v FROM mc_meta WHERE k='home'");
    if (!row) { this.run("INSERT INTO mc_meta(k,v) VALUES('home',?)", [here]); return; }
    if (row.v !== here) { const e = new StoreError(`replica_path_mismatch: this file is ${here}, device ${this.device} lives at ${row.v}; refusing to sync a copy`); e.refused = true; throw e; }
  }
  /** One action from the hub, in hub order. Our own come back as acknowledgements. */
  receive(action) {
    if (action.origin === this.device) {
      if (!this.one('SELECT 1 AS ok FROM mc_log WHERE id=?', [action.id])) return this.reconcileFork(action);
      this.ack(action.id, action.seq, action.rejected ?? null); return 'own';
    }
    const fresh = action.parts.filter((p, i) => !this.one('SELECT 1 AS ok FROM mc_applied WHERE id=?', [`${action.id}#${p.index ?? i}`]));
    if (!fresh.length) return 'duplicate';
    action = { ...action, parts: fresh };
    this.run("UPDATE mc_meta SET v='0' WHERE k='capture'");
    this.db.exec('PRAGMA foreign_keys=OFF');
    try {
      this._purge = new Map();
      super.tx(() => {
        for (const [i, part] of action.parts.entries()) {
          if (part.control) { this.applyControl(action.actor, part.control, action.ts); continue; }
          const meta = part.cnf ? { cnf: part.cnf } : { acl: part.acl };
          let value = null;
          try { value = open(part.sealed, `${action.id}|${part.index ?? i}|${JSON.stringify(meta)}`, (g, e) => this.keyFor(g, e)); } catch { value = null; }
          if (!value) { this.run('INSERT OR IGNORE INTO mc_unopened(hub_seq, part, action) VALUES(?,?,?)', [action.seq, part.index ?? i, JSON.stringify({ ...action, parts: [{ ...part, index: part.index ?? i }] })]); continue; }
          for (const r of value.rows) this.putRow({ ...r, acl: part.acl, cnf: part.cnf }, action.seq);
        }
        for (const [i, p] of action.parts.entries()) this.run('INSERT OR IGNORE INTO mc_applied(id,hub_seq) VALUES(?,?)', [`${action.id}#${p.index ?? i}`, action.seq]);
        this.settlePurges(action.seq);
      });
    } finally {
      this._purge = null;
      this.db.exec('PRAGMA foreign_keys=ON');
      this.run("UPDATE mc_meta SET v='1' WHERE k='capture'");
    }
    return 'applied';
  }
  /** Parts that arrived before their key: retried whenever keys may have changed. */
  retryUnopened() {
    for (const u of this.all('SELECT * FROM mc_unopened ORDER BY hub_seq, part')) {
      const action = JSON.parse(u.action);
      const part = action.parts[0];
      const meta = part.cnf ? { cnf: part.cnf } : { acl: part.acl };
      let value = null;
      try { value = open(part.sealed, `${action.id}|${part.index}|${JSON.stringify(meta)}`, (g, e) => this.keyFor(g, e)); } catch { value = null; }
      if (!value) continue;
      this.run("UPDATE mc_meta SET v='0' WHERE k='capture'"); this.db.exec('PRAGMA foreign_keys=OFF');
      this._purge = new Map();
      try { super.tx(() => { for (const r of value.rows) this.putRow({ ...r, acl: part.acl, cnf: part.cnf }, action.seq); this.run('DELETE FROM mc_unopened WHERE hub_seq=? AND part=?', [u.hub_seq, u.part]); this.settlePurges(action.seq); }); }
      finally { this._purge = null; this.db.exec('PRAGMA foreign_keys=ON'); this.run("UPDATE mc_meta SET v='1' WHERE k='capture'"); }
    }
  }
  /** True when a remote revocation of (t, pk, grp) at `hubSeq` must not apply: an own change to it is pending, or a grant was applied later. */
  grantHeld(t, pk, grp, hubSeq) {
    if (this.one('SELECT 1 AS ok FROM mc_aclpending WHERE t=? AND pk=? AND grp=? AND n>0', [t, String(pk), grp])) return true;
    return (this.one('SELECT hub_seq FROM mc_grants WHERE t=? AND pk=? AND grp=?', [t, String(pk), grp])?.hub_seq ?? -1) > hubSeq;
  }
  /** Last writer by hub order per mutable row; local pending writes hold the row until acknowledged. */
  putRow(r, hubSeq) {
    const { t, pk, img } = r;
    if (t === 'mem_search') { if (this.one('SELECT 1 AS ok FROM mc_acl WHERE t=? AND pk=? AND revoked=0', [KIND_TABLE[img.kind], img.id])) Store.prototype.index.call(this, img.kind, img.id, img.text); return; }
    if (t === 'mc_raw_stub') { this.run('INSERT INTO mc_raw_stub(id,allowed) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET allowed=excluded.allowed', [img.id, img.allowed]); return; }
    if (t === 'mc_unshare') { // only the removed groups; never adds one
      for (const g of r.acl || []) {
        // last writer by hub order per grant: an own pending change, or a grant applied at a later position, wins
        if (this.grantHeld(img.t, img.pk, g, hubSeq)) continue;
        const res = this.run('UPDATE mc_acl SET revoked=1 WHERE t=? AND pk=? AND grp=?', [img.t, String(img.pk), g]);
        // when it happened, in hub order: a later action carrying the row in that group shares it again (putRow below)
        if (res.changes) this.run('INSERT INTO mc_revocations(t,pk,grp,hub_seq) VALUES(?,?,?,?) ON CONFLICT(t,pk,grp) DO UPDATE SET hub_seq=MAX(hub_seq, excluded.hub_seq)', [img.t, String(img.pk), g, hubSeq]);
      }
      if (this._purge && TABLES[img.t]) this._purge.set(`${img.t}\0${img.pk}`, { t: img.t, pk: String(img.pk) });
      return;
    }
    if (t === 'mc_page_cache') { this.run('INSERT OR IGNORE INTO mc_page_cache(key,entity_id,prompt_version,note_ids,cnf,nodes,generated_at,generated_by) VALUES(?,?,?,?,?,?,?,?)', [img.key, img.entity_id, img.prompt_version, img.note_ids, img.cnf, typeof img.nodes === 'string' ? img.nodes : JSON.stringify(img.nodes), img.generated_at, img.generated_by]); return; }
    if (t === 'mc_links') { this.run('INSERT INTO mc_links(a,b,linked,at) VALUES(?,?,?,?) ON CONFLICT(a,b) DO UPDATE SET linked=excluded.linked, at=excluded.at', [img.a, img.b, img.linked, img.at]); return; }
    const spec = TABLES[t];
    if (!spec) return;
    if (t === 'mc_pagenodes' && !validPageNodeRow(img)) { this.badPageNodes = (this.badPageNodes ?? 0) + 1; return; } // its id, columns and key must follow from its record
    // A purged row (its body left this replica when it lost every group the replica reads): an image from before the purge is
    // dropped, a later one (a re-share) brings it back.
    const tomb = t === 'changes' ? null : this.one('SELECT hub_seq FROM mc_purged WHERE t=? AND pk=?', [t, pk]);
    if (tomb) { if (hubSeq <= tomb.hub_seq) return; this.run('DELETE FROM mc_purged WHERE t=? AND pk=?', [t, pk]); }
    if (!spec.immutable) {
      const v = this.one('SELECT seq, pending FROM mc_rowver WHERE t=? AND pk=?', [t, pk]);
      if (v && v.pending > 0) { this.run('INSERT OR IGNORE INTO mc_deferred(hub_seq,t,pk,row) VALUES(?,?,?,?)', [hubSeq, t, pk, JSON.stringify(r)]); return; }
      if (v && v.seq >= hubSeq) return;
      this.run('INSERT INTO mc_rowver(t,pk,seq,pending) VALUES(?,?,?,0) ON CONFLICT(t,pk) DO UPDATE SET seq=excluded.seq', [t, pk, hubSeq]);
    }
    // Additive; only mc_unshare revokes. A grant revoked by an unshare EARLIER in hub order is given back: the row arriving in that group
    // again is a re-share. A revocation with no recorded hub position (local, or before mc_revocations) stays, as before; so does one
    // from a later position (a deferred older image applied after the unshare). An own pending change to the grant holds it (that change
    // lands later in hub order); an applied grant records its position.
    if (r.acl && t !== 'changes') for (const g of r.acl) {
      if (this.one('SELECT 1 AS ok FROM mc_aclpending WHERE t=? AND pk=? AND grp=? AND n>0', [t, String(pk), g])) continue;
      this.run('INSERT INTO mc_acl(t,pk,grp,revoked) VALUES(?,?,?,0) ON CONFLICT(t,pk,grp) DO UPDATE SET revoked=0 WHERE mc_acl.revoked=1 AND EXISTS (SELECT 1 FROM mc_revocations v WHERE v.t=excluded.t AND v.pk=excluded.pk AND v.grp=excluded.grp AND v.hub_seq < ?)', [t, pk, g, hubSeq]);
      if (this.one('SELECT 1 AS ok FROM mc_acl WHERE t=? AND pk=? AND grp=? AND revoked=0', [t, String(pk), g])) this.run('INSERT INTO mc_grants(t,pk,grp,hub_seq) VALUES(?,?,?,?) ON CONFLICT(t,pk,grp) DO UPDATE SET hub_seq=MAX(hub_seq, excluded.hub_seq)', [t, String(pk), g, hubSeq]);
    }
    const row = decodeForSql(t, img);
    const prevRaw = t === 'raw_data' ? this.one('SELECT policy FROM raw_data WHERE id=?', [row.id]) : null;
    const cols = Object.keys(row).filter((c) => !(t === 'changes' && c === 'seq') && !(t === 'raw_data' && c === 'claimed_until'));
    const ins = `INSERT INTO ${t}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`;
    if (spec.immutable) {
      if (t === 'changes') { const res = this.run(ins, cols.map((c) => row[c])); if (r.acl) this.setAcl('changes', String(res.lastInsertRowid), r.acl); } // change seqs are per replica
      else this.run(ins.replace('INSERT', 'INSERT OR IGNORE'), cols.map((c) => row[c]));
    } else {
      const upd = cols.filter((c) => !spec.pk.includes(c));
      this.run(`${ins} ON CONFLICT(${spec.pk.join(',')}) DO UPDATE SET ${upd.map((c) => `${c}=excluded.${c}`).join(',')}`, cols.map((c) => row[c]));
    }
    // raw_search is FTS5 (a lookup by id is a full scan): a new row is not indexed yet, an already-allowed one is
    if (t === 'raw_data' && JSON.parse(row.policy).model === 'allow' && !(prevRaw && (asJson(prevRaw.policy)?.model === 'allow' || this.one('SELECT 1 AS ok FROM raw_search WHERE id=?', [row.id])))) this.run('INSERT INTO raw_search(id,text) VALUES(?,?)', [row.id, row.text]);
  }
  /** Rebuild the replicated tables of a fresh store from this log (the log is the source of truth). */
  replayLogInto(target, actions = null) {
    let n = target._replayN ?? 0;
    target.run("UPDATE mc_meta SET v='0' WHERE k='capture'"); target.db.exec('PRAGMA foreign_keys=OFF');
    try {
      Store.prototype.tx.call(target, () => {
        for (const a of actions ?? this.all('SELECT * FROM mc_log ORDER BY seq')) {
          for (const r of JSON.parse(a.body).rows) {
            if (r.control) { target.applyControl(this.user, r, a.ts); continue; }
            if (r.t === 'changes') { const row = decodeForSql('changes', r.img); const cols = Object.keys(row); target.run(`INSERT INTO changes(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`, cols.map((c) => row[c])); if (r.acl) target.setAcl('changes', r.pk, r.acl); continue; }
            target.putRow(r, ++n);
          }
        }
      });
    } finally { target.db.exec('PRAGMA foreign_keys=ON'); target.run("UPDATE mc_meta SET v='1' WHERE k='capture'"); }
    target._replayN = n;
    return n;
  }
}

// Row images travel as JSON values; the store decodes JSON columns on read, so encode them back.
const JSON_COLS = new Set(['participants', 'locator', 'policy', 'aliases', 'source_refs', 'note_refs', 'nodes', 'model', 'context_refs', 'bindings', 'considered']);
function encodeRow(t, row) { const out = {}; for (const [k, v] of Object.entries(row)) out[k] = typeof v === 'bigint' ? Number(v) : v; return out; }
function decodeForSql(t, img) { const out = {}; for (const [k, v] of Object.entries(img)) out[k] = v !== null && typeof v === 'object' ? j(v) : v; return out; }
function decodeRow(t, img) { return img; }

/** A deterministic page: the entity, then its notes newest first. Pluggable; a model generator fits the same cache. */
export function outlinePage({ entity, notes }) {
  const root = { id: 'p1', parent: null, order: 0, text: `${entity?.name ?? 'entity'} (${entity?.type ?? 'misc'})` };
  return [root, ...notes.map((n, i) => ({ id: `p${i + 2}`, parent: 'p1', order: i, text: `${String(n.at || n.created_at || '').slice(0, 10)}: ${String(n.body).replace(/\s+/g, ' ').slice(0, 240)}`, notes: [n.id] }))];
}
export { StoreError };
