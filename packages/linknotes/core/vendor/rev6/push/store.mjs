// The rev5 memory store, in Node, on the same memory.sqlite schema (no schema change).
// Raw data is immutable revisions; memory is entities, identities, mentions, notes, work and one
// page per entity. Every accepted change lands in one transaction with its batch receipt, so a
// batch is wholly applied or never happened, and a replayed receipt returns the first result.
// Models never write here: apply validates references, maps $temp ids to stable digests, checks
// expected versions and logs before/after. Withheld raw text never leaves through search or read.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { cpLen, cpSlice, digest, instant, isObj, isStr, nowIso, pyDumps, pyRepr, pyStr, truthy } from './common.mjs';
import { collisionQualifier, handleSlug, loadPeople, mentionKey, privateIn, qualifiedNameProblem, quotesFrom, unnameable } from './identity.mjs';
import { numbered, renderBfs } from './pages.mjs';

export const ABSORB_PENDING_CHARS = 8000;
export const WORK_STATUS = ['todo', 'done', 'dropped'];
export const MARKED_STATUS = ['ambiguous', 'distinct'];
export const ROLES = ['owner', 'human', 'assistant', 'tool', 'system'];
export const BACKGROUND_ROLES = ['assistant', 'tool', 'system'];
export const KINDS = ['raw', 'entity', 'note', 'work', 'page'];
export const ARRIVAL_CLIP_CHARS = 4000;
export const ARRIVAL_RECORD_OVERHEAD = 120;
export const FRESH_PICKUP_MINUTES = 30;
export const LOCAL_ONLY_SOURCES = new Set();
export const LOCAL_ONLY_POLICY = { model: 'deny', publish: 'none', reason: 'first-person source is local-only' };
export const ELIGIBLE = `(r.occurred_at <= :as_of AND r.available_at <= :as_of AND NOT EXISTS (
  SELECT 1 FROM raw_data n WHERE n.source=r.source AND n.account=r.account AND n.native_id=r.native_id
  AND n.rowid>r.rowid AND n.available_at <= :as_of))`;
export const ALLOWED = "json_extract(r.policy,'$.model')='allow'";
/** claimed_until value of a row the cloud policy withholds (a private person is named in it or its thread). Such a row is
 *  never a candidate for a slice, and it is not "waiting": it cannot be interpreted until the private-person registry changes
 *  (`releaseHolds`).
 */
export const HOLD_UNTIL = '9999-12-31T00:00:00.000Z';
/** The pending-and-allowed index. Every hot raw query reads `processed_batch IS NULL AND json_extract(r.policy,'$.model')='allow'`
 *  3.7 GB) to read its policy: one backlog count took 20-30 s on the live store and status() ran five such scans, so a maintenance
 *  pass of four model calls spent ~8 CPU minutes in sqlite3_step and ran 755.9 s against a 600 s budget. The
 *  index carries the policy expression, so counts, MIN/MAX, the fresh count and ELIGIBLE's outer columns are answered from the
 *  index, and occurred_at third makes pendingRaw's `ORDER BY occurred_at DESC, rowid DESC LIMIT n` a backward index walk that stops at n.
 *  SQLite maintains it on every write. Additive and idempotent, like rev5's raw_not_allowed (rev5/store.py WITHHELD_INDEX);
 *  the writer ensures it at open (a no-op once it exists).
 */
/** Reverse citation index: raw id -> the notes and work that cite it in source_refs. threadEntities used to scan every note and
 *  work row, unpack its source_refs JSON and probe raw_data per ref (or, as planned, re-scan the thread per note_entities row):
 *  79 s for one call on the live store, 110 s over the 8 calls of one interpretation packet. Now the lookup starts
 *  from the thread's raw rows (raw_thread index) and reaches citing notes and work through these tables. Triggers keep them in
 *  step with every writer (rev6, rev5 Python, repairs), so no write path has to remember them; the writer creates and backfills
 *  them once at open (additive, idempotent, like PENDING_ALLOWED_INDEX).
 */
const REFS = (col) => `(SELECT DISTINCT value FROM json_each(CASE WHEN json_valid(${col}) AND json_type(${col})='array' THEN ${col} ELSE '[]' END) WHERE type='text')`;
const citeDdl = (kind, table) => `
CREATE TABLE IF NOT EXISTS ${kind}_sources(raw_id TEXT NOT NULL, ${kind}_id TEXT NOT NULL, PRIMARY KEY(raw_id, ${kind}_id)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS ${kind}_sources_${kind} ON ${kind}_sources(${kind}_id);
CREATE TRIGGER IF NOT EXISTS ${kind}_sources_ins AFTER INSERT ON ${table} BEGIN
  INSERT OR IGNORE INTO ${kind}_sources(raw_id, ${kind}_id) SELECT value, NEW.id FROM ${REFS('NEW.source_refs')}; END;
CREATE TRIGGER IF NOT EXISTS ${kind}_sources_upd AFTER UPDATE OF source_refs, id ON ${table} BEGIN
  DELETE FROM ${kind}_sources WHERE ${kind}_id=OLD.id;
  INSERT OR IGNORE INTO ${kind}_sources(raw_id, ${kind}_id) SELECT value, NEW.id FROM ${REFS('NEW.source_refs')}; END;
CREATE TRIGGER IF NOT EXISTS ${kind}_sources_del AFTER DELETE ON ${table} BEGIN
  DELETE FROM ${kind}_sources WHERE ${kind}_id=OLD.id; END;`;
export function ensureCitationIndex(db) {
  for (const [kind, table] of [['note', 'notes'], ['work', 'work']]) {
    const had = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(`${kind}_sources`);
    if (had) { db.exec(citeDdl(kind, table)); continue; }
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(citeDdl(kind, table));
      db.exec(`INSERT OR IGNORE INTO ${kind}_sources(raw_id, ${kind}_id) SELECT j.value, t.id FROM ${table} t, json_each(CASE WHEN json_valid(t.source_refs) AND json_type(t.source_refs)='array' THEN t.source_refs ELSE '[]' END) j WHERE j.type='text'`);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
}

export const OWNER_INDEXES = ["CREATE INDEX IF NOT EXISTS raw_owner_author ON raw_data(source, author, role)", "CREATE INDEX IF NOT EXISTS raw_owner_sender_text ON raw_data(source, CAST(json_extract(locator,'$.sender_id') AS TEXT), role)"];
/** merged_into had no index: every clusterIds() step (`WHERE merged_into=?`, 270 calls per interpretation packet) scanned the whole entities table. */
export const ENTITY_INDEXES = ['CREATE INDEX IF NOT EXISTS entities_merged ON entities(merged_into)'];
/** The full-text join key, covering. A search joins every FTS match to raw_data by id and reads source, occurred_at, available_at,
 *  (10-14 s cold), then a sort. With these columns in the index the join and the eligibility probe never leave it (plan:
 *  SEARCH r USING COVERING INDEX raw_id_cover); only the kept rows are read whole.
 */
export const RAW_SEARCH_JOIN_INDEX = 'CREATE INDEX IF NOT EXISTS raw_id_cover ON raw_data(id, source, occurred_at, available_at, account, native_id)';
export const PENDING_ALLOWED_INDEX = "CREATE INDEX IF NOT EXISTS raw_pending_policy ON raw_data(processed_batch, json_extract(policy,'$.model'), occurred_at, available_at, claimed_until, source, account, native_id)";
export const UNHELD = `COALESCE(r.claimed_until,'') <> '${HOLD_UNTIL}'`;
const ROOTS = `(WITH RECURSIVE roots(id, root) AS (
  SELECT id, id FROM entities WHERE merged_into IS NULL
  UNION ALL SELECT e.id, r.root FROM entities e JOIN roots r ON e.merged_into=r.id) SELECT id, root FROM roots)`;
const JSON_COLS = ['participants', 'locator', 'policy', 'aliases', 'source_refs', 'note_refs', 'nodes', 'model', 'context_refs', 'bindings'];

// A NUL inside a TEXT column ends the string for node:sqlite (and SQLite's own length()), so a
// pdftotext page with a form feed's NUL neighbour reached the model as the 52 chars before it.
// Never stored.
export const stripNul = (text) => (typeof text === 'string' && text.includes('\0') ? text.replace(/\0/gu, '') : text);
export const arrivalCost = (text, clip = ARRIVAL_CLIP_CHARS, overhead = ARRIVAL_RECORD_OVERHEAD) => Math.min(cpLen(text || ''), clip) + overhead;
export const notLocalOnlySql = () => (LOCAL_ONLY_SOURCES.size ? `r.source NOT IN (${[...LOCAL_ONLY_SOURCES].sort().map((s) => `'${s}'`).join(',')})` : '1');
export const defaultDbPath = (env = process.env) => { if (!env.LINKNOTES_DB) throw new Error('linknotes: pass a store file (or set LINKNOTES_DB)'); return env.LINKNOTES_DB; };

export class StoreError extends Error {}
export class TaskConflict extends StoreError {
  constructor(current, expected) { super(`stale work ${current.id}: at version ${current.version}, expected ${pyStr(expected)}`); this.current = current; this.expected = expected; }
}

const j = pyDumps;
const LONE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u;
export function loneSurrogatePath(value, at = 'changes') {
  if (isStr(value)) return LONE.test(value) ? at : null;
  if (Array.isArray(value)) { for (let i = 0; i < value.length; i++) { const f = loneSurrogatePath(value[i], `${at}[${i}]`); if (f) return f; } return null; }
  if (isObj(value)) { for (const [k, v] of Object.entries(value)) { if (LONE.test(k)) return `${at} (in a key)`; const f = loneSurrogatePath(v, `${at}.${k}`); if (f) return f; } }
  return null;
}

export function normalizePolicy(raw, privateReason) {
  if (isStr(raw)) raw = { model: raw };
  raw = { ...(isObj(raw) ? raw : {}) };
  if (privateReason) return { model: 'deny', publish: 'none', reason: privateReason };
  if (raw.model !== 'allow' && raw.model !== 'deny') return { model: 'deny', publish: raw.publish ?? 'none', reason: 'policy unspecified' };
  return { model: raw.model, publish: raw.publish ?? (raw.model === 'deny' ? 'none' : 'label-only'), reason: raw.reason ?? null };
}

const DECORATION = /\s*\((owner[^)]*|reply to message (?<reply>[^)\s]+)|reply to (?:[^()]|\([^()]*\))*|edited (?<edited>[0-9T:.Z+-]+)|historical assistant)\)\s*$/u;
export function splitAuthor(raw) {
  let text = String(raw ?? '').trim(); const out = {};
  for (;;) {
    const m = DECORATION.exec(text);
    if (!m) break;
    if (m.groups.reply) out.reply_to = m.groups.reply;
    if (m.groups.edited) out.edited_at = m.groups.edited;
    if (m[1].startsWith('owner')) out.role = 'owner';
    if (m[1] === 'historical assistant') out.role = 'assistant';
    text = text.slice(0, m.index).trim();
  }
  return [text || null, out];
}
const nameKey = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/gu, ' ').trim();

function decode(row) {
  if (!row) return row;
  const out = { ...row };
  for (const k of JSON_COLS) if (k in out && isStr(out[k])) { try { out[k] = JSON.parse(out[k]); } catch { /* text stays text */ } }
  return out;
}
/** Bind JS values the way sqlite3 does: integers as INTEGER, booleans as 0/1. */
function bindable(v) {
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
  if (typeof v === 'boolean') return v ? 1n : 0n;
  if (v === undefined) return null;
  return v;
}
function bindArgs(args) {
  if (Array.isArray(args)) return args.map(bindable);
  if (isObj(args)) return [Object.fromEntries(Object.entries(args).map(([k, v]) => [k, bindable(v)]))];
  return [];
}

export function ftsQuery(text, maxTerms = 16, allTerms = false) {
  const terms = (String(text).toLowerCase().match(/[\p{L}\p{N}_'.-]+/gu) || []).filter((t) => t.replace(/^[.'-]+|[.'-]+$/gu, '').length > 1).slice(0, maxTerms);
  return terms.map((t) => `"${t.replace(/"/gu, '""')}"`).join(allTerms ? ' AND ' : ' OR ');
}

export function supportRefs(store, notes = [], work = [], nodes = []) {
  const refs = new Set();
  for (const x of [...notes, ...work]) for (const r of (x.source_refs ?? x.refs ?? x.evidence ?? []) || []) refs.add(r);
  const queue = notes.flatMap((x) => [...(x.id ? [x.id] : []), ...(x.note_refs || [])]);
  for (const node of nodes) {
    for (const r of node.refs || []) refs.add(r);
    queue.push(...(node.notes || []));
    for (const wid of node.work || []) { const item = store.one('SELECT source_refs FROM work WHERE id=?', [wid]); if (item) item.source_refs.forEach((r) => refs.add(r)); else refs.add('unavailable-work:' + pyStr(wid)); }
  }
  const seen = new Set();
  while (queue.length) {
    const nid = queue.pop();
    if (seen.has(nid)) continue;
    seen.add(nid);
    const note = store.one('SELECT source_refs,note_refs FROM notes WHERE id=?', [nid]);
    if (note) { note.source_refs.forEach((r) => refs.add(r)); queue.push(...note.note_refs); } else refs.add('unavailable-note:' + pyStr(nid));
  }
  return [...refs].sort();
}

export function scopeSql(args, { sources, since, until, defaultScope } = {}) {
  let clause = '';
  if (sources && sources.length) { clause += ` AND r.source IN (${sources.map((s, i) => { args[`scope_src${i}`] = s; return `:scope_src${i}`; }).join(',')})`; }
  if (since) { args.scope_since = instant(since); clause += ' AND r.occurred_at >= :scope_since'; }
  if (until) { args.scope_until = instant(until); clause += ' AND r.occurred_at < :scope_until'; }
  if (defaultScope) {
    // rev6 intake scope: interpret what occurred on or after the cutoff, plus the owner's notes sources.
    args.interp_since = instant(defaultScope.since);
    clause += ` AND (r.occurred_at >= :interp_since OR r.source IN (${defaultScope.sources.map((s) => `'${s.replace(/'/gu, "''")}'`).join(',')}))`;
  }
  return clause;
}

export class Store {
  constructor(file, { people, now, caller = 'cloud', readOnly = false } = {}) {
    this.path = String(file || defaultDbPath());
    this._stmts = new Map();
    if (readOnly) {
      this.db = new DatabaseSync(this.path, { readOnly: true });
      this.db.exec('PRAGMA busy_timeout=30000');
    } else {
      if (this.path !== ':memory:') mkdirSync(path.dirname(this.path), { recursive: true });
      this.db = new DatabaseSync(this.path);
      this.db.exec('PRAGMA busy_timeout=30000');
      this.db.exec('PRAGMA journal_mode=WAL');
      this.db.exec('PRAGMA foreign_keys=ON');
      if (!this.one("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='raw_data'")) throw new StoreError(`${this.path} holds no rev5 schema; rev6 push never creates or migrates one`);
      this.db.exec(PENDING_ALLOWED_INDEX);
      for (const ddl of OWNER_INDEXES) this.db.exec(ddl);
      for (const ddl of [...ENTITY_INDEXES, RAW_SEARCH_JOIN_INDEX]) this.db.exec(ddl);
      ensureCitationIndex(this.db);
    }
    this.people = people ?? loadPeople();
    this._now = now;
    this.cloud = caller !== 'local';
    this.localOnlyCut = this.cloud ? notLocalOnlySql() : '1';
    this.allowed = `(${ALLOWED} AND ${this.localOnlyCut})`;
    this._stmts = new Map();
  }
  now() { return this._now ? instant(this._now) : nowIso(); }
  close() { this.db.close(); }
  stmt(sql) { let s = this._stmts.get(sql); if (!s) { s = this.db.prepare(sql); this._stmts.set(sql, s); } return s; }
  one(sql, args = []) { return decode(this.stmt(sql).get(...bindArgs(args))) ?? null; }
  all(sql, args = []) { return this.stmt(sql).all(...bindArgs(args)).map(decode); }
  run(sql, args = []) { return this.stmt(sql).run(...bindArgs(args)); }
  tx(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const out = work(); this.db.exec('COMMIT'); return out; } catch (e) { try { this.db.exec('ROLLBACK'); } catch { /* gone */ } throw e; }
  }

  // ---- raw data ----
  ingest(records) {
    const stored = [], duplicates = [], rejected = []; let withheld = 0;
    const now = this.now();
    this.tx(() => {
      (records || []).forEach((rec, i) => {
        let row;
        try { row = this.rawRow(rec, now); } catch (e) { rejected.push({ index: i, id: isObj(rec) ? rec.id ?? null : null, reason: e.message }); return; }
        const exists = this.one('SELECT id FROM raw_data WHERE source=? AND account=? AND native_id=? AND revision=?', [row.source, row.account, row.native_id, row.revision]);
        if (exists || this.one('SELECT id FROM raw_data WHERE id=?', [row.id])) { duplicates.push(exists?.id ?? row.id); return; }
        const cols = Object.keys(row);
        this.run(`INSERT INTO raw_data(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`, cols.map((c) => row[c]));
        if (JSON.parse(row.policy).model === 'allow') this.run('INSERT INTO raw_search(id,text) VALUES(?,?)', [row.id, row.text]); else withheld++;
        stored.push(row.id);
      });
    });
    return { ok: !rejected.length, stored, duplicates, rejected, withheld_by_policy: withheld };
  }

  rawRow(rec, now) {
    if (!isObj(rec)) throw new StoreError('record must be an object');
    for (const k of ['source', 'native_id']) if (!String(rec[k] ?? '').trim()) throw new StoreError(`missing provenance: ${k}`);
    if (!isStr(rec.text)) throw new StoreError('text must be a string');
    if (!rec.occurred_at) throw new StoreError('missing provenance: occurred_at');
    const occurred = this.inst(rec.occurred_at);
    const available = rec.available_at ? this.inst(rec.available_at) : occurred;
    const [author, deco] = splitAuthor(rec.author);
    const merged = { ...deco }; for (const [k, v] of Object.entries(rec)) if (v !== null && v !== undefined) merged[k] = v;
    const role = (merged.role === undefined || merged.role === 'human') && deco.role ? deco.role : (merged.role || 'human');
    if (!ROLES.includes(role)) throw new StoreError(`role must be one of ('owner', 'human', 'assistant', 'tool', 'system')`);
    const source = String(merged.source), account = String(merged.account || ''), nativeId = String(merged.native_id), revision = String(merged.revision || '1');
    const participants = (merged.participants || []).filter(Boolean).map((p) => splitAuthor(p)[0]).filter(Boolean);
    const priv = privateIn(this.people, [author || '', ...participants], stripNul(merged.text));
    const id = String(merged.id || 'r_' + digest([source, account, nativeId, revision], 12));
    const locator = { ...(truthy(merged.locator) ? merged.locator : { source, account, native_id: nativeId, revision, thread: merged.thread ?? null, field: 'text' }) };
    for (const k of ['reply_to', 'edited_at', 'sender_id', 'send_status']) if (truthy(merged[k])) locator[k] = k === 'edited_at' ? this.inst(merged[k]) : pyStr(merged[k]);
    return { id, source, account, native_id: nativeId, revision, role, author, participants: j(participants), thread: truthy(merged.thread) ? pyStr(merged.thread) : null,
      occurred_at: occurred, available_at: available, ingested_at: now, text: stripNul(merged.text), locator: j(locator), policy: j(normalizePolicy(merged.policy, priv)) };
  }
  inst(v) { try { return instant(v); } catch (e) { throw new StoreError(e.message); } }

  /** The source-policy half of rawView's decision: the policy column and the local-only rule (needs only source and policy). */
  sourceAllowed(row) {
    return LOCAL_ONLY_SOURCES.has(row.source) ? (!this.cloud && [null, undefined, LOCAL_ONLY_POLICY.reason].includes(row.policy.reason)) : row.policy.model === 'allow';
  }
  /** rawView's whole read decision, from the five columns it depends on (source, policy, author, participants, text). */
  rawAllowed(row) { return this.sourceAllowed(row) && !privateIn(this.people, [row.author, ...(row.participants || [])], row.text || ''); }
  /**  them in one interpretation packet, and read every column). Inside withRawMemo() a row is read once per gather. Absent ids are absent. */
  policyRows(ids) {
    const out = new Map(), want = [];
    for (const id of new Set(ids)) { if (this._rawMemo?.has(id)) { const v = this._rawMemo.get(id); if (v) out.set(id, v); } else want.push(id); }
    for (let i = 0; i < want.length; i += 400) {
      const chunk = want.slice(i, i + 400), seen = new Set();
      for (const r of this.all('SELECT id,source,policy,author,participants,text FROM raw_data WHERE id IN (SELECT value FROM json_each(?))', [j(chunk)])) { out.set(r.id, r); seen.add(r.id); this._rawMemo?.set(r.id, r); }
      for (const id of chunk) if (!seen.has(id)) this._rawMemo?.set(id, null);
    }
    return out;
  }
  /** Run a read-only gather with policy rows memoised by id; raw rows do not change inside one synchronous pass. */
  withRawMemo(work) {
    if (this._rawMemo) return work();
    this._rawMemo = new Map();
    try { return work(); } finally { this._rawMemo = null; }
  }
  rawView(row, full = true) {
    const localOnly = LOCAL_ONLY_SOURCES.has(row.source);
    let allowed = this.sourceAllowed(row);
    const out = {};
    for (const k of ['id', 'source', 'account', 'native_id', 'revision', 'role', 'author', 'participants', 'thread', 'occurred_at', 'available_at', 'locator', 'policy']) out[k] = row[k];
    out.testimony = BACKGROUND_ROLES.includes(row.role) ? 'attributed-background' : 'primary';
    const loc = isObj(row.locator) ? row.locator : null;
    if (loc?.attachments?.length || loc?.attachments_present) {
      const files = (loc.attachments || []).filter(isObj).map((a) => ({ ...a, contents: 'not read' }));
      out.attachments = files.length ? files : [{ contents: 'not read', kind: 'unknown' }];
    }
    out.text_chars = cpLen(row.text);
    out.processed = row.processed_batch !== null && row.processed_batch !== undefined;
    if (privateIn(this.people, [row.author, ...(row.participants || [])], row.text || '')) allowed = false;
    if (allowed && full) out.text = row.text;
    else if (!allowed) out.withheld = row.policy.reason || (localOnly ? LOCAL_ONLY_POLICY.reason : 'source policy');
    return out;
  }

  pendingRaw(maxRecords, maxBytes, asOf, { sources, since, until, claim, order, defaultScope } = {}) {
    const args = { as_of: instant(asOf), n: maxRecords, wall: nowIso() };
    const scope = scopeSql(args, { sources, since, until, defaultScope });
    const rows = this.all(`SELECT * FROM raw_data r WHERE processed_batch IS NULL AND (claimed_until IS NULL OR claimed_until < :wall) AND ${this.allowed} AND ${ELIGIBLE}${scope} ORDER BY ${order === 'recent' ? 'occurred_at DESC, rowid DESC' : 'available_at, rowid'} LIMIT :n`, args);
    const taken = []; let used = 0;
    for (const row of rows) {
      const size = arrivalCost(row.text);
      if (taken.length && used + size > maxBytes) continue;
      if (claim && !claim(row.id)) continue;
      taken.push(row); used += size;
    }
    const backlog = this.one(`SELECT COUNT(*) AS n FROM raw_data r WHERE processed_batch IS NULL AND ${this.allowed} AND ${UNHELD}`).n;
    const future = this.one(`SELECT COUNT(*) AS n FROM raw_data r WHERE processed_batch IS NULL AND ${this.allowed} AND (r.occurred_at > :as_of OR r.available_at > :as_of) AND ${UNHELD}`, { as_of: args.as_of }).n;
    const claimed = this.one(`SELECT COUNT(*) AS n FROM raw_data r WHERE processed_batch IS NULL AND claimed_until >= :wall AND ${this.allowed} AND ${UNHELD}`, { wall: args.wall }).n;
    return [taken, { backlog, excluded_future: future, superseded: this.supersededBy(taken), claimed_elsewhere: claimed,
      slice: { taken: taken.length, packet_chars: used, max_records: maxRecords, max_input_bytes: maxBytes, scanned: rows.length, stopped_by: taken.length >= maxRecords ? 'max_records' : 'backlog exhausted' } }];
  }
  supersededBy(rows) {
    return rows.flatMap((row) => this.all('SELECT id FROM raw_data WHERE processed_batch IS NULL AND source=? AND account=? AND native_id=? AND rowid<?',
      [row.source, row.account, row.native_id, this.one('SELECT rowid FROM raw_data WHERE id=?', [row.id]).rowid]).map((x) => x.id));
  }
  claim(ids, seconds) {
    if (!ids.length) return [];
    const until = new Date(Date.now() + seconds * 1000).toISOString(), wall = nowIso();
    return this.tx(() => ids.filter((rid) => this.run('UPDATE raw_data SET claimed_until=? WHERE id=? AND processed_batch IS NULL AND (claimed_until IS NULL OR claimed_until < ?)', [until, rid, wall]).changes));
  }
  /** Withhold rows from every later slice until the registry changes; they stop counting as pending or waiting. */
  hold(ids) {
    if (!ids.length) return 0;
    return Number(this.run('UPDATE raw_data SET claimed_until=? WHERE processed_batch IS NULL AND id IN (SELECT value FROM json_each(?))', [HOLD_UNTIL, j([...ids])]).changes);
  }
  releaseHolds() { return Number(this.run('UPDATE raw_data SET claimed_until=NULL WHERE processed_batch IS NULL AND claimed_until=?', [HOLD_UNTIL]).changes); }
  distinctSources() {
    return this.all('WITH RECURSIVE s(source) AS (SELECT MIN(source) FROM raw_data UNION ALL SELECT (SELECT MIN(source) FROM raw_data WHERE source > s.source) FROM s WHERE s.source IS NOT NULL) SELECT source FROM s WHERE source IS NOT NULL').map((r) => r.source);
  }
  heldCount() { return this.one('SELECT COUNT(*) AS n FROM raw_data WHERE processed_batch IS NULL AND claimed_until=?', [HOLD_UNTIL]).n; }
  release(ids) { if (ids.length) this.run('UPDATE raw_data SET claimed_until=NULL WHERE processed_batch IS NULL AND id IN (SELECT value FROM json_each(?))', [j([...ids])]); }

  // ---- search and read ----
  search(query, { kind, limit = 20, asOf, allTerms = false } = {}) {
    query = String(query ?? '').trim(); limit = Math.max(1, Math.min(parseInt(limit || 20, 10), 200));
    const expr = ftsQuery(query, 16, allTerms);
    if (!expr) throw new StoreError('search needs a query with at least one word');
    asOf = asOf ? instant(asOf) : null;
    if (kind && !KINDS.includes(kind)) throw new StoreError("kind must be one of ('raw', 'entity', 'note', 'work', 'page')");
    const kinds = kind ? [kind] : [...KINDS];
    const hits = [];
    if (kinds.includes('raw')) {
      for (const r of this.all(`SELECT r.*, snippet(raw_search,1,'[',']','…',12) AS snip FROM raw_search s JOIN raw_data r ON r.id=s.id WHERE raw_search MATCH :q AND ${this.localOnlyCut} AND ${ELIGIBLE} ORDER BY rank LIMIT :n`, { q: expr, as_of: asOf || '9', n: limit })) {
        const view = this.rawView(r, false);
        if (!('withheld' in view)) hits.push({ kind: 'raw', ...view, snippet: r.snip });
      }
    }
    const others = kinds.filter((k) => k !== 'raw');
    if (others.length) {
      const seen = new Set();
      for (const r of this.all(`SELECT kind,id,snippet(mem_search,2,'[',']','…',12) AS snip FROM mem_search WHERE mem_search MATCH ? AND kind IN (${others.map(() => '?').join(',')}) ORDER BY rank LIMIT ?`, [expr, ...others, limit])) {
        const ident = ['entity', 'page'].includes(r.kind) ? this.resolveEntity(r.id) : r.id;
        if (seen.has(`${r.kind}|${ident}`)) continue;
        const head = this.head(r.kind, ident);
        if (!head || (asOf && r.kind === 'note' && (head.at || '') > asOf)) continue;
        seen.add(`${r.kind}|${ident}`);
        hits.push({ kind: r.kind, snippet: r.snip, ...head });
      }
    }
    const withheld = this.withheldCount();
    return { ok: true, query, as_of: asOf, hits: hits.slice(0, limit), coverage: { kinds, raw_withheld_by_policy_not_searched: withheld, limit } };
  }

  // NOT this.allowed, counted through rev5's raw_not_allowed partial index (rev5/store.py withheld_count; the plain scan
  // read all 2.7 GB of raw_data per search); without the index the planner scans, same number.
  withheldCount() {
    let n = this.one("SELECT COUNT(*) AS n FROM raw_data WHERE NOT json_extract(policy,'$.model')='allow'").n;
    if (this.localOnlyCut !== '1') n += this.one(`SELECT COUNT(*) AS n FROM raw_data r WHERE NOT (${this.localOnlyCut}) AND COALESCE(${ALLOWED}, 1)`).n;
    return n;
  }

  head(kind, ident) {
    let row = null;
    if (kind === 'entity') row = this.one('SELECT id,name,type,aliases,name_status,version,updated_at FROM entities WHERE id=?', [ident]);
    else if (kind === 'note') row = this.one('SELECT id,body,author,at,source_refs,batch_id FROM notes WHERE id=?', [ident]);
    else if (kind === 'work') row = this.one('SELECT * FROM work WHERE id=?', [ident]);
    else if (kind === 'page') { const p = this.one('SELECT entity_id,revision,dirty,updated_at FROM pages WHERE entity_id=?', [ident]); row = p ? { id: ident, page_revision: p.revision, dirty: Boolean(p.dirty) } : null; }
    if (row && !this.memoryVisible(kind, row)) return null;
    if (kind === 'page' && row && !this.memoryVisible('page', this.one('SELECT * FROM pages WHERE entity_id=?', [ident]))) return null;
    return row;
  }

  /** Derived prose inherits every cited original's current read policy. */
  memoryVisible(kind, row) {
    if (!row) return true;
    const nodes = kind === 'page' && Array.isArray(row.nodes) ? row.nodes : [];
    const refs = supportRefs(this, kind === 'note' ? [row] : [], kind === 'work' ? [row] : [], nodes);
    if (kind === 'entity' && row.id) {
      const support = this.all('SELECT n.* FROM notes n JOIN note_entities ne ON ne.note_id=n.id WHERE ne.entity_id=?', [row.id]);
      if (support.length && !support.some((n) => this.memoryVisible('note', n))) return false;
    }
    if (kind === 'mention' && row.raw_id) refs.push(row.raw_id);
    const raws = this.policyRows(refs);
    for (const ref of refs) { const raw = raws.get(ref); if (!raw || !this.rawAllowed(raw)) return false; }
    return !privateIn(this.people, [], j(row));
  }

  resolveEntity(ident) {
    const seen = new Set(); let cur = ident;
    for (;;) {
      if (seen.has(cur)) throw new StoreError(`merge chain cycles at ${cur}`);
      seen.add(cur);
      const next = this.one('SELECT merged_into FROM entities WHERE id=?', [cur])?.merged_into;
      if (!next) return cur;
      cur = next;
    }
  }
  clusterIds(ident) {
    const root = this.resolveEntity(ident); const out = [root], queue = [root];
    while (queue.length) for (const r of this.all('SELECT id FROM entities WHERE merged_into=? ORDER BY id', [queue.pop()])) if (!out.includes(r.id)) { out.push(r.id); queue.push(r.id); }
    return out;
  }
  danglingReferences() {
    const bad = [];
    for (const [table, column, where] of [['note_entities', 'entity_id', ''], ['work_entities', 'entity_id', ''], ['identities', 'entity_id', ''], ['pages', 'entity_id', ''], ['mentions', 'entity_id', ''], ['entities', 'merged_into', ''], ['mem_search', 'id', "kind IN ('entity','page')"]]) {
      for (const r of this.all(`SELECT DISTINCT ${column} AS ref FROM ${table} WHERE ${column} IS NOT NULL${where ? ' AND ' + where : ''}`)) {
        let root;
        try { root = this.resolveEntity(r.ref); } catch (e) { bad.push({ table, column, entity_id: r.ref, reason: e.message }); continue; }
        if (!this.one('SELECT 1 AS ok FROM entities WHERE id=? AND merged_into IS NULL', [root])) bad.push({ table, column, entity_id: r.ref, reason: `resolves to ${root}, which is not a live entity` });
      }
    }
    return bad;
  }

  read(kind, ident, { nodes, budget, asOf, history = false } = {}) {
    if (!KINDS.includes(kind)) throw new StoreError("kind must be one of ('raw', 'entity', 'note', 'work', 'page')");
    if (kind === 'raw') return this.readRaw(ident, asOf);
    if (kind === 'note' || kind === 'work') {
      const row = this.one(`SELECT * FROM ${kind === 'note' ? 'notes' : 'work'} WHERE id=?`, [ident]);
      if (!row) throw new StoreError(`no ${kind} ${ident}`);
      if (!this.memoryVisible(kind, row)) return { ok: true, withheld: 'derived source policy', id: ident };
      row.entities = kind === 'note' ? this.all('SELECT entity_id FROM note_entities WHERE note_id=?', [ident]).map((r) => r.entity_id) : this.all('SELECT entity_id FROM work_entities WHERE work_id=?', [ident]).map((r) => r.entity_id);
      return kind === 'note' ? { ok: true, note: row, sources: this.sources(row.source_refs) } : { ok: true, work: row, sources: this.sources(row.source_refs), history: history ? this.history('work', ident) : null };
    }
    const entity = this.one('SELECT * FROM entities WHERE id=?', [ident]);
    if (!entity) throw new StoreError(`no entity ${ident}`);
    if (!this.memoryVisible('entity', entity)) return { ok: true, withheld: 'derived source policy', id: ident };
    if (entity.merged_into) return { ...this.read(kind, entity.merged_into, { nodes, budget, asOf, history }), merged_from: ident };
    const page = this.pageView(ident, nodes, budget);
    if (kind === 'page') return { ok: true, entity, page, history: history ? this.history('page', ident) : null };
    entity.identities = this.all('SELECT source,account,native FROM identities WHERE entity_id IN (SELECT value FROM json_each(?)) ORDER BY created_at, rowid', [j(this.clusterIds(ident))]);
    return { ok: true, entity, page, notes: this.entityNotes(ident, { asOf, limit: 40 }), work: this.entityWork(ident),
      mentions: this.entityMentions(ident, { asOf, limit: 40 }), history: history ? this.history('entity', ident) : null };
  }
  readRaw(ident, asOf) {
    const cut = asOf ? instant(asOf) : '9';
    let row = this.one('SELECT * FROM raw_data WHERE id=?', [ident]);
    if (!row) { const i = ident.indexOf('/'); const [s, n] = i < 0 ? [ident, ''] : [ident.slice(0, i), ident.slice(i + 1)]; row = this.one(`SELECT * FROM raw_data r WHERE source=:s AND native_id=:n AND ${ELIGIBLE} ORDER BY rowid DESC LIMIT 1`, { s, n, as_of: cut }); }
    if (!row) throw new StoreError(`no raw data ${ident}`);
    const view = this.rawView(row);
    if (asOf && (row.available_at > cut || row.occurred_at > cut)) { delete view.text; view.withheld = `not available at ${cut} (available ${row.available_at})`; }
    const revisions = this.all('SELECT id,revision,occurred_at,available_at,processed_batch FROM raw_data WHERE source=? AND account=? AND native_id=? ORDER BY rowid', [row.source, row.account, row.native_id]);
    const cited = this.all('SELECT id FROM notes WHERE EXISTS (SELECT 1 FROM json_each(notes.source_refs) WHERE value=?)', [row.id]).map((c) => c.id);
    return { ok: true, raw: view, as_of: asOf ? cut : null, revisions, cited_by_notes: cited };
  }
  sources(refs) { return (refs || []).map((r) => this.one('SELECT * FROM raw_data WHERE id=?', [r])).filter(Boolean).map((r) => this.rawView(r, false)); }
  pageView(entityId, nodes, budget) {
    const page = this.one('SELECT * FROM pages WHERE entity_id=?', [entityId]) || { nodes: [], revision: null, dirty: 1 };
    if (!this.memoryVisible('page', page)) return { withheld: 'derived source policy', revision: page.revision ?? null, nodes: [], outline: null };
    const all = page.nodes || [];
    const out = { revision: page.revision ?? null, as_of: page.as_of ?? null, dirty: Boolean(page.dirty ?? 1), node_count: all.length, outline: all.length ? renderBfs(all, budget ?? null) : null };
    if (nodes === true) out.nodes = numbered(all);
    else if (nodes && nodes.length) {
      const wanted = new Set(nodes), byParent = new Map();
      for (const n of all) { const k = n.parent ?? null; if (!byParent.has(k)) byParent.set(k, []); byParent.get(k).push(n); }
      const expanded = [], queue = all.filter((n) => wanted.has(n.id));
      while (queue.length) { const n = queue.shift(); expanded.push(n); queue.push(...(byParent.get(n.id) || [])); }
      out.nodes = expanded; out.unknown_nodes = [...wanted].filter((w) => !all.some((n) => n.id === w)).sort();
    }
    return out;
  }
  entityNotes(id, { asOf, limit = 200, follow = true, policyFilter = true } = {}) {
    return this.all('SELECT DISTINCT n.* FROM notes n JOIN note_entities ne ON ne.note_id=n.id WHERE ne.entity_id IN (SELECT value FROM json_each(:ids)) AND COALESCE(n.at, n.created_at) <= :as_of ORDER BY COALESCE(n.at, n.created_at) DESC, n.rowid DESC LIMIT :n',
      { ids: j(follow ? this.clusterIds(id) : [id]), as_of: asOf ? instant(asOf) : '9', n: limit }).filter((r) => !policyFilter || this.memoryVisible('note', r));
  }
  entityMentions(id, { asOf, limit = 200, follow = true } = {}) {
    return this.all('SELECT * FROM mentions WHERE entity_id IN (SELECT value FROM json_each(:ids)) AND at <= :as_of ORDER BY at DESC, rowid DESC LIMIT :n',
      { ids: j(follow ? this.clusterIds(id) : [id]), as_of: asOf ? instant(asOf) : '9', n: limit }).filter((r) => this.memoryVisible('mention', r));
  }
  entityWork(id, { openOnly = false, follow = true, policyFilter = true } = {}) {
    return this.all(`SELECT DISTINCT w.* FROM work w JOIN work_entities we ON we.work_id=w.id WHERE we.entity_id IN (SELECT value FROM json_each(?)) ${openOnly ? "AND w.status='todo'" : ''} ORDER BY w.status='todo' DESC, w.updated_at DESC`,
      [j(follow ? this.clusterIds(id) : [id])]).filter((r) => !policyFilter || this.memoryVisible('work', r));
  }
  provisionalNames(limit = 200, offset = 0) {
    return this.all("SELECT id,name,type,aliases,name_status,name_problem,created_at,updated_at FROM entities WHERE merged_into IS NULL AND name_status IN ('provisional','collides') ORDER BY updated_at, id LIMIT ? OFFSET ?", [limit, offset]).map((row) => ({
      ...row, identities: this.all('SELECT source,account,native FROM identities WHERE entity_id IN (SELECT value FROM json_each(?))', [j(this.clusterIds(row.id))]),
      mentions: this.entityMentions(row.id, { limit: 8 }).map((m) => m.text) }));
  }
  unquotedMentions(limit = 200) {
    return this.all('SELECT m.id,m.text,m.raw_id,m.entity_id,m.method,m.at,m.batch_id,r.text AS record FROM mentions m JOIN raw_data r ON r.id=m.raw_id WHERE m.verbatim=0 ORDER BY m.created_at DESC LIMIT ?', [limit])
      .filter((r) => !quotesFrom(r.record, r.text)).map(({ record, ...rest }) => rest);
  }
  mentionHolders(key) { return [...new Set(this.all('SELECT entity_id, MAX(at) AS last FROM mentions WHERE key=? AND entity_id IS NOT NULL GROUP BY entity_id ORDER BY last DESC', [mentionKey(key)]).map((r) => this.resolveEntity(r.entity_id)))]; }
  history(kind, target, limit = 100) {
    return this.all('SELECT seq,batch_id,op,before,after,at FROM changes WHERE kind=? AND target_id=? ORDER BY seq DESC LIMIT ?', [kind, target, limit])
      .filter((r) => ['before', 'after'].every((k) => this.memoryVisible(kind, isStr(r[k]) ? JSON.parse(r[k]) : r[k])));
  }

  // ---- packet support ----
  /** Dirty pages, most overdue first. With `settledBefore` a built page generated after that instant is left out: it stays
   * dirty and comes back once it is older (the page throttle, interpret.mjs). A page never built is always included. */
  dirtyPages(limit, { settledBefore = null } = {}) {
    const settled = settledBefore ? "AND (generated_at IS NULL OR nodes='[]' OR generated_at <= ?)" : '';
    return this.all(`SELECT entity_id FROM pages WHERE dirty=1 AND entity_id IN (SELECT id FROM entities WHERE merged_into IS NULL) ${settled} ORDER BY nodes LIKE '%"unintegrated"%' DESC, revision IS NOT NULL, COALESCE(updated_at,''), touched_at, entity_id LIMIT ?`, settledBefore ? [settledBefore, limit] : [limit]).map((r) => r.entity_id);
  }
  clearEmptyDirty() {
    return Number(this.run(`UPDATE pages SET dirty=0, updated_at=? WHERE dirty=1 AND nodes='[]' AND entity_id IN (SELECT id FROM entities WHERE merged_into IS NULL) AND entity_id NOT IN (SELECT r.root FROM ${ROOTS} r JOIN note_entities ne ON ne.entity_id=r.id) AND entity_id NOT IN (SELECT r.root FROM ${ROOTS} r JOIN work_entities we ON we.entity_id=r.id)`, [this.now()]).changes);
  }
  /** Map native -> Set(roles) of every author and participant in one thread up to `asOf`. */
  threadParties(source, account, thread, asOf) {
    const rows = this.all(`SELECT author, participants, role FROM raw_data r WHERE source=:s AND account=:a AND thread=:t AND ${this.allowed} AND ${ELIGIBLE} ORDER BY occurred_at DESC LIMIT 500`, { s: source, a: account, t: thread, as_of: instant(asOf) });
    const parties = new Map();
    for (const r of rows) for (const [native, role] of [[r.author, r.role], ...(r.participants || []).map((p) => [p, 'human'])]) if (native) { if (!parties.has(native)) parties.set(native, new Set()); parties.get(native).add(role); }
    return parties;
  }
  ownerEntities() {
    // Same set and order as the join it replaces (an identity counts once it has any owner row), as two EXISTS probes the
    // raw_owner_author / raw_owner_sender_text indexes answer (CAST AS TEXT is the TEXT affinity the old comparison applied, so a numeric sender_id still matches); the OR inside one join scanned every row of each identity's source (47 s live).
    return [...new Set(this.all("SELECT i.entity_id, MIN(i.created_at) AS at FROM identities i JOIN entities e ON e.id=i.entity_id WHERE EXISTS (SELECT 1 FROM raw_data r WHERE r.source=i.source AND r.author=i.native AND r.role='owner') OR EXISTS (SELECT 1 FROM raw_data r WHERE r.source=i.source AND CAST(json_extract(r.locator,'$.sender_id') AS TEXT)=i.native AND r.role='owner') GROUP BY i.entity_id ORDER BY at").map((r) => this.resolveEntity(r.entity_id)))];
  }
  threadEntities(source, account, thread, limit = 24) {
    // From the thread's raw rows (raw_thread) through the citation index (note_sources / work_sources) to the notes and work.
    const rows = this.all('SELECT ne.entity_id AS e, MAX(n.created_at) AS at FROM raw_data r CROSS JOIN note_sources ns ON ns.raw_id=r.id CROSS JOIN notes n ON n.id=ns.note_id CROSS JOIN note_entities ne ON ne.note_id=n.id WHERE r.source=:s AND r.account=:a AND r.thread=:t GROUP BY ne.entity_id UNION SELECT we.entity_id, MAX(w.updated_at) FROM raw_data r CROSS JOIN work_sources ws ON ws.raw_id=r.id CROSS JOIN work w ON w.id=ws.work_id CROSS JOIN work_entities we ON we.work_id=w.id WHERE r.source=:s AND r.account=:a AND r.thread=:t GROUP BY we.entity_id ORDER BY 2 DESC LIMIT :n', { s: source, a: account, t: thread, n: limit });
    return [...new Set(rows.map((r) => this.resolveEntity(r.e)))].slice(0, limit);
  }
  /** Entities tied to `seeds` through shared notes, best first (rev5 Store.note_neighbors): a record
   * about a product reaches the project its notes already link it to. Earlier seeds weigh more; the
   * count is divided by log2(2 + the neighbour's own note count) so a hub (Amazon, the owner) does
   * not crowd out the one project tied to this product.
   */
  noteNeighbors(seeds, { exclude = [], limit = 8 } = {}) {
    const score = new Map(), skip = new Set([...seeds, ...exclude]);
    seeds.forEach((seed, rank) => {
      for (const r of this.all('SELECT b.entity_id AS e, COUNT(*) AS n FROM note_entities a JOIN note_entities b ON b.note_id=a.note_id AND b.entity_id<>a.entity_id WHERE a.entity_id=? GROUP BY b.entity_id', [seed])) {
        const eid = this.resolveEntity(r.e);
        if (skip.has(eid)) continue;
        const df = this.one('SELECT COUNT(*) AS n FROM note_entities WHERE entity_id=?', [r.e]).n;
        score.set(eid, (score.get(eid) || 0) + r.n / (1 + rank) / Math.log2(2 + df));
      }
    });
    return [...score].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([e]) => e);
  }
  workEntitiesFor(ids) { return ids.length ? [...new Set(this.all('SELECT DISTINCT entity_id FROM work_entities WHERE work_id IN (SELECT value FROM json_each(?)) ORDER BY entity_id', [j([...ids])]).map((r) => this.resolveEntity(r.entity_id)))] : []; }
  recentWork(entityIds, { limit = 8, policyFilter = true } = {}) {
    if (!entityIds.length) return [];
    const ids = [...new Set(entityIds.flatMap((e) => this.clusterIds(e)))];
    return this.all("SELECT DISTINCT w.* FROM work w JOIN work_entities we ON we.work_id=w.id WHERE we.entity_id IN (SELECT value FROM json_each(?)) AND w.status IN ('done','dropped') ORDER BY w.updated_at DESC LIMIT ?", [j(ids), limit]).filter((r) => !policyFilter || this.memoryVisible('work', r));
  }
  markClean(id, touchedAt) { this.run('UPDATE pages SET dirty=0, updated_at=? WHERE entity_id=? AND touched_at=?', [this.now(), id, touchedAt]); }
  clearDirty(id, asOf) { this.run('UPDATE pages SET dirty=0, updated_at=? WHERE entity_id=? AND touched_at <= ?', [this.now(), id, asOf]); }
  revisionCount(s, a, n) { return this.one('SELECT COUNT(*) AS n FROM raw_data WHERE source=? AND account=? AND native_id=?', [s, a, n]).n; }
  pageInput(id, asOf) {
    const entity = this.one('SELECT id,name,type,aliases FROM entities WHERE id=?', [id]);
    const page = this.one('SELECT revision,nodes,input_digest,touched_at,as_of,generated_at FROM pages WHERE entity_id=?', [id]) || {};
    return { entity, as_of: asOf,
      notes: this.entityNotes(id, { asOf, limit: 1000000, policyFilter: false }).map((n) => ({ id: n.id, text: n.body, at: n.at || n.created_at, author: n.author, refs: n.source_refs })),
      work: this.entityWork(id, { policyFilter: false }).map((w) => ({ id: w.id, status: w.status, text: w.title + (w.body ? ': ' + w.body : ''), evidence: w.source_refs, updated_at: w.updated_at })),
      page: { revision: page.revision ?? null, nodes: page.nodes || [], input_digest: page.input_digest ?? null, touched_at: page.touched_at ?? null, as_of: page.as_of ?? null, generated_at: page.generated_at ?? null } };
  }

  /** Strip NUL from stored raw text (rows written before ingest stripped it) and requeue the ones a push
   * batch already interpreted from the truncated text. The full bytes are read as a BLOB (SQLite's replace()
   * stops at the NUL too), decoded, stripped and written back; raw_search is rewritten from the repaired row. Dry run unless `apply`. */
  repairNulText({ apply = false, requeue = true } = {}) {
    const rows = this.all("SELECT id, source, processed_batch, length(CAST(text AS BLOB)) AS bytes, json_extract(policy,'$.model') AS model FROM raw_data WHERE instr(text, char(0)) > 0 ORDER BY id");
    const requeued = requeue ? rows.filter((r) => String(r.processed_batch || '').startsWith('push-')).map((r) => r.id) : [];
    const report = { affected: rows.length, by_source: {}, requeued: requeued.length, requeued_ids: requeued, applied: false };
    for (const r of rows) report.by_source[r.source] = (report.by_source[r.source] || 0) + 1;
    if (!apply || !rows.length) return report;
    const now = this.now(), ids = rows.map((r) => r.id), batch = 'repair-nul-' + digest([now, ids], 12);
    this.tx(() => {
      this.run('INSERT INTO batches(id, kind, received_at, input_digest, result) VALUES(?,?,?,?,?)', [batch, 'repair', now, digest(ids), j({ reason: 'NUL bytes in raw text truncated it for node:sqlite readers', affected: ids.length, requeued })]);
      const requeueSet = new Set(requeued);
      for (const r of rows) {
        const bytes = this.one('SELECT CAST(text AS BLOB) AS b FROM raw_data WHERE id=?', [r.id]).b;
        const fixed = stripNul(Buffer.from(bytes).toString('utf8'));
        this.run('UPDATE raw_data SET text=? WHERE id=?', [fixed, r.id]);
        const after = Buffer.byteLength(fixed, 'utf8');
        if (requeueSet.has(r.id)) this.run('UPDATE raw_data SET processed_batch=NULL, claimed_until=NULL WHERE id=?', [r.id]);
        if (r.model === 'allow') {
          this.run('DELETE FROM raw_search WHERE id=?', [r.id]);
          this.run('INSERT INTO raw_search(id, text) SELECT id, text FROM raw_data WHERE id=?', [r.id]);
        }
        this.run('INSERT INTO changes(batch_id, kind, target_id, op, before, after, at) VALUES(?,?,?,?,?,?,?)', [batch, 'raw', r.id, 'nul-stripped',
          j({ bytes: r.bytes, processed_batch: r.processed_batch }), j({ bytes: after, processed_batch: requeueSet.has(r.id) ? null : r.processed_batch }), now]);
      }
    });
    return { ...report, applied: true, batch };
  }

  drainHealth(windowHours = 24, freshHours = 24) {
    const now = Date.parse(this.now());
    const ago = (h) => new Date(now - h * 3600e3).toISOString();
    const acked = (since) => this.one("SELECT COUNT(*) AS n FROM raw_data WHERE processed_batch IN (SELECT id FROM batches WHERE kind='push' AND received_at >= ?)", [since]).n;
    const minutes = (stamp) => (stamp ? Math.round((now - Date.parse(stamp)) / 6000) / 10 : null);
    const pending = this.one(`SELECT COUNT(*) AS n FROM raw_data r WHERE processed_batch IS NULL AND ${this.allowed} AND ${UNHELD}`).n;
    const window = acked(ago(windowHours)), hour = acked(ago(1));
    const last = this.one("SELECT received_at FROM batches WHERE kind='push' ORDER BY received_at DESC, rowid DESC LIMIT 1");
    const newest = this.one(`SELECT MAX(available_at) AS t FROM raw_data r WHERE processed_batch IS NULL AND ${this.allowed} AND ${UNHELD}`).t;
    const waiting = this.one(`SELECT MIN(available_at) AS t FROM raw_data r WHERE processed_batch IS NULL AND ${this.allowed} AND ${UNHELD} AND available_at >= ? AND available_at <= ?`, [ago(freshHours), new Date(now).toISOString()]).t;
    const failed = this.all("SELECT COALESCE(reason,'unknown') AS reason, purpose, COUNT(*) AS n, MAX(at) AS last FROM calls WHERE ok=0 AND at >= ? GROUP BY reason, purpose ORDER BY n DESC", [ago(windowHours)]);
    const rate = Math.round((window / windowHours) * 10) / 10, wait = minutes(waiting);
    let status, why;
    if (!window && pending) [status, why] = ['stalled', `nothing acknowledged in ${windowHours}h while ${pending} records were pending`];
    else if (wait !== null && wait > FRESH_PICKUP_MINUTES) [status, why] = ['behind', `a record that arrived ${Math.round(wait)} minutes ago is still waiting; current records come first`];
    else [status, why] = ['ok', `draining at ${rate} records/hour; nothing recent is waiting more than ${FRESH_PICKUP_MINUTES} minutes`];
    return { status, why, basis: 'drain rate and recency of what has been ingested; backlog size is not a health signal', acknowledged_1h: hour, [`acknowledged_${windowHours}h`]: window,
      records_per_hour: rate, last_consolidation_at: last?.received_at ?? null, minutes_since_consolidation: minutes(last?.received_at), oldest_recent_record_waiting_minutes: wait,
      newest_pending_record_at: newest, pending, held_by_private_person_policy: this.heldCount(), failed_calls_24h: failed.reduce((a, r) => a + r.n, 0), failed_calls_by_reason: failed, hours_to_drain_at_this_rate: rate ? Math.round((pending / rate) * 10) / 10 : null };
  }
  /** What the push deciders need (budget.mjs decidePush/decideBackfill, interpret's receipt): index-only counts, milliseconds.
   *  status() is the full health report (per-source sums over every raw row) and was being called for this alone. */
  backlog() {
    return { raw_pending: this.one(`SELECT COUNT(*) AS n FROM raw_data r WHERE processed_batch IS NULL AND ${this.allowed} AND ${UNHELD}`).n, held_by_private_person_policy: this.heldCount(),
      raw_withheld_by_policy: this.withheldCount(),
      pages_dirty: this.one('SELECT COUNT(*) AS n FROM pages WHERE dirty=1 AND entity_id IN (SELECT id FROM entities WHERE merged_into IS NULL)').n,
      work_open: this.one("SELECT COUNT(*) AS n FROM work WHERE status='todo'").n };
  }
  status() {
    const counts = Object.fromEntries(['raw_data', 'entities', 'identities', 'mentions', 'notes', 'work', 'pages', 'batches', 'changes', 'calls'].map((t) => [t, this.one(`SELECT COUNT(*) AS n FROM ${t}`).n]));
    const calls = this.one('SELECT COUNT(*) AS n, SUM(ok) AS ok, SUM(input_chars) AS input_chars, SUM(output_chars) AS output_chars FROM calls');
    calls.failed = calls.n - (calls.ok || 0);
    return { ok: true, db: this.path, counts,
      sources: this.all(`SELECT source, COUNT(*) AS records, SUM(processed_batch IS NULL AND ${this.allowed} AND ${UNHELD}) AS pending, SUM(NOT ${this.allowed}) AS withheld, MAX(available_at) AS latest FROM raw_data r GROUP BY source`),
      backlog: this.backlog(),
      last_batch: this.one('SELECT id,kind,received_at FROM batches ORDER BY received_at DESC, rowid DESC LIMIT 1'),
      last_consolidation: this.one("SELECT id,kind,received_at FROM batches WHERE kind='push' ORDER BY received_at DESC,rowid DESC LIMIT 1"),
      health: this.drainHealth(), model_calls: calls, private_people: Object.keys(this.people).sort() };
  }

  // ---- apply ----
  apply(batchId, changes, { sourceRefs = null, expectedVersions = null, ackRaw = null, kind = 'apply', extra = null } = {}) {
    if (!batchId || !isStr(batchId)) throw new StoreError('apply needs a string batch_id');
    if (changes !== null && changes !== undefined && !isObj(changes)) throw new StoreError('changes must be an object of change kinds');
    if (sourceRefs !== null && sourceRefs !== undefined && !Array.isArray(sourceRefs)) throw new StoreError('source_refs must be a list');
    if (expectedVersions !== null && expectedVersions !== undefined && !isObj(expectedVersions)) throw new StoreError('expected_versions must be an object');
    if (ackRaw !== null && ackRaw !== undefined && !Array.isArray(ackRaw)) throw new StoreError('ack_raw must be a list');
    const half = loneSurrogatePath([changes ?? null, sourceRefs ?? null, expectedVersions ?? null, ackRaw ?? null]);
    if (half) throw new StoreError(`a text in this batch holds half a character (a lone surrogate) at ${half}; send it again with that text whole`);
    const parts = [changes ?? null, sourceRefs ?? null, expectedVersions ?? null, ackRaw ?? null];
    const inputDigest = digest(kind === 'task' ? [...parts, extra ?? null] : parts);
    const replay = () => {
      const prior = this.one('SELECT input_digest, result FROM batches WHERE id=?', [batchId]);
      if (!prior) return null;
      if (prior.input_digest !== inputDigest) throw new StoreError(`batch ${batchId} already accepted with different content`);
      return { ...JSON.parse(prior.result), replayed: true };
    };
    const first = replay();
    if (first) return first;
    changes = changes || {};
    const unknown = Object.keys(changes).filter((k) => !['entities', 'identities', 'mentions', 'notes', 'work', 'pages'].includes(k));
    if (unknown.length) throw new StoreError(`unknown change kinds: [${unknown.sort().map((k) => pyRepr(k)).join(', ')}]`);
    for (const [ck, body] of Object.entries(changes)) {
      if (body === null || body === undefined) continue;
      if (!Array.isArray(body)) throw new StoreError(`changes.${ck} must be a list`);
      body.forEach((item, i) => { if (!isObj(item)) throw new StoreError(`changes.${ck}[${i}] must be an object`); });
    }
    const now = this.now();
    return this.tx(() => {
      const again = replay();
      if (again) return again;
      this.run("INSERT INTO batches(id,kind,received_at,input_digest,result) VALUES(?,?,?,?,'{}')", [batchId, kind, now, inputDigest]);
      const ctx = new Apply(this, batchId, now, expectedVersions || {}, sourceRefs || []);
      let result;
      try { result = ctx.run(changes); } catch (e) {
        if (e instanceof StoreError) throw e;
        throw new StoreError(`a change in this batch is the wrong shape (${e.constructor.name}: ${e.message})`);
      }
      for (const rid of ackRaw || []) {
        const row = this.one('SELECT processed_batch FROM raw_data WHERE id=?', [rid]);
        if (!row) throw new StoreError(`cannot acknowledge unknown raw data ${rid}`);
        if (row.processed_batch !== null) throw new StoreError(`raw ${rid} already acknowledged by ${row.processed_batch}`);
        this.run('UPDATE raw_data SET processed_batch=?, claimed_until=NULL WHERE id=?', [batchId, rid]);
      }
      Object.assign(result, { ok: true, batch_id: batchId, acknowledged: [...(ackRaw || [])] }, extra || {});
      this.run('UPDATE batches SET result=? WHERE id=?', [j(result), batchId]);
      return result;
    });
  }

  taskList({ owner_kind = null, owner_ref = null, status = null, query = '', limit = 100, offset = 0, binding = null } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isInteger(offset) || offset < 0) throw new StoreError('task pagination requires limit 1..1000 and nonnegative offset');
    if (status !== null && !WORK_STATUS.includes(status)) throw new StoreError('invalid task status');
    if (owner_kind !== null && !['me', 'person', 'chat', 'unknown'].includes(owner_kind)) throw new StoreError('invalid owner_kind');
    const clauses = [], args = [];
    for (const [k, v] of [['owner_kind', owner_kind], ['owner_ref', owner_ref], ['status', status]]) if (v !== null) { clauses.push(k + '=?'); args.push(v); }
    if (query) { clauses.push("instr(lower(title || ' ' || body),lower(?))>0"); args.push(query); }
    if (binding !== null) {
      if (!isObj(binding) || Object.keys(binding).sort().join() !== 'native_id,source') throw new StoreError('binding needs source/native_id');
      clauses.push("EXISTS (SELECT 1 FROM json_each(work.bindings) WHERE json_extract(value,'$.source')=? AND json_extract(value,'$.native_id')=?)"); args.push(binding.source, binding.native_id);
    }
    const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
    const total = this.one('SELECT COUNT(*) n FROM work' + where, args).n;
    const rows = this.all('SELECT * FROM work' + where + ' ORDER BY updated_at DESC,id LIMIT ? OFFSET ?', [...args, limit, offset]);
    const visible = rows.filter((r) => this.memoryVisible('work', r));
    return { ok: true, tasks: visible, total, offset, withheld_by_policy: rows.length - visible.length, next_offset: offset + limit < total ? offset + limit : null,
      coverage: 'Shared rev5 work, all statuses unless filtered; legacy unbound Notes/goals not imported.' };
  }
  taskApply(opId, tasks, actor, sourceRefs = null) {
    if (!isStr(actor) || !actor.trim()) throw new StoreError('task operation needs an attributed actor');
    if (!Array.isArray(tasks)) throw new StoreError('tasks must be a list');
    const allowed = new Set(['id', 'title', 'body', 'status', 'owner_kind', 'owner_ref', 'parent_id', 'context_refs', 'bindings', 'expected_version', 'entities', 'source_refs']);
    for (const t of tasks) if (!isObj(t) || Object.keys(t).some((k) => !allowed.has(k))) throw new StoreError('unknown task fields or malformed task');
    return this.apply(opId, { work: tasks }, { sourceRefs, kind: 'task', extra: { actor } });
  }
  recordCall(purpose, request, response, { batchId = null, lane = null } = {}) {
    const r = response || {};
    this.run('INSERT INTO calls(batch_id,purpose,model,ok,reason,input_chars,output_chars,usage,at,lane) VALUES(?,?,?,?,?,?,?,?,?,?)',
      [batchId, purpose, r.model ?? null, r.ok ? 1 : 0, r.reason ?? null, cpLen(request.system || '') + cpLen(request.user || ''), cpLen(r.text || ''), j(r.usage ?? null), this.now(), String(lane || process.env.LINKNOTES_LANE || 'steady')]);
  }
  entitiesForKey(key) {
    if (!key) return [];
    return [...new Set(this.all('SELECT entity_id, MIN(created_at) AS at FROM identities WHERE key=? GROUP BY entity_id ORDER BY at', [key]).map((r) => this.resolveEntity(r.entity_id)))];
  }
  entityByHandle(native) {
    const hit = this.one("SELECT i.entity_id, e.name, e.type FROM identities i JOIN entities e ON e.id=i.entity_id WHERE i.key=? AND i.key<>'' ORDER BY i.created_at LIMIT 1", [handleSlug(native)]);
    if (!hit) return null;
    const live = this.resolveEntity(hit.entity_id);
    const row = this.one('SELECT id, name, type FROM entities WHERE id=?', [live]);
    return row ? { entity: live, name: row.name, type: row.type } : null;
  }
  touch(id, now) { this.run('INSERT INTO pages(entity_id,touched_at) VALUES(?,?) ON CONFLICT(entity_id) DO UPDATE SET dirty=1, touched_at=excluded.touched_at', [this.resolveEntity(id), now]); }
  index(kind, id, text) { this.run('DELETE FROM mem_search WHERE kind=? AND id=?', [kind, id]); this.run('INSERT INTO mem_search(kind,id,text) VALUES(?,?,?)', [kind, id, text]); }
  log(batchId, kind, target, op, before, after, now) { this.run('INSERT INTO changes(batch_id,kind,target_id,op,before,after,at) VALUES(?,?,?,?,?,?,?)', [batchId, kind, target, op, before === null || before === undefined ? null : j(before), j(after), now]); }
  unmerge(loser, batchId) { return this.apply(batchId || `unmerge-${loser}-${digest([loser, this.now()], 8)}`, { entities: [{ id: loser, unmerge: true }] }, { kind: 'unmerge' }); }

  // ---- merged pages ----
  pageRow(id) { const r = this.stmt('SELECT * FROM pages WHERE entity_id=?').get(id); return r ? { ...r } : null; }
  pageText(nodes) { return nodes.map((n) => pyStr(n.text ?? '')).join('\n'); }
  absorbPage(loser, winner, now, batchId = null) {
    const source = this.pageRow(loser), nodes = JSON.parse(source?.nodes || '[]');
    const before = this.pageRow(winner), kept = JSON.parse(before?.nodes || '[]');
    if (!nodes.length) return { absorbed: 0, reason: 'the merged entity has no page outline', before };
    const rootId = 'u_' + loser;
    if (kept.some((n) => n.id === rootId)) return { absorbed: 0, reason: 'already absorbed', root: rootId, before };
    const pending = kept.filter((n) => truthy(n.unintegrated)).reduce((s, n) => s + pyStr(n.text ?? '').length, 0);
    if (pending >= ABSORB_PENDING_CHARS) { this.touch(winner, now); return { absorbed: 0, reason: `${pending} characters are already waiting to be folded in; page left dirty to rebuild from notes`, before }; }
    const who = this.one('SELECT name FROM entities WHERE id=?', [loser]) || {};
    const top = kept.filter((n) => n.parent === null || n.parent === undefined).map((n) => Number(n.order || 0));
    const rename = Object.fromEntries(nodes.map((n) => [n.id, `${n.id}@${loser}`]));
    const head = { id: rootId, parent: null, order: Math.trunc(Math.max(...(top.length ? top : [0]))) + 1, unintegrated: true, origin: loser, author: 'merge', refs: [], notes: [], work: [],
      text: `Unintegrated: the page of ${who.name || loser} (${loser}), merged into this entity on ${now}. Fold these points into the outline above, or drop the ones it already makes.` };
    const moved = nodes.map((n) => ({ ...n, id: rename[n.id], parent: rename[n.parent] || rootId, unintegrated: true, origin: loser }));
    const combined = [...kept, head, ...moved];
    try { numbered(combined); } catch (e) { return { absorbed: 0, reason: `the merged outline does not graft cleanly (${e.message})`, before }; }
    const revision = digest(combined.map((n) => [n.id, n.parent ?? null, n.order ?? null, n.text]));
    this.run('INSERT INTO pages(entity_id,revision,nodes,input_digest,as_of,generated_at,model,dirty,touched_at,updated_at) VALUES(?,?,?,?,?,?,?,1,?,?) ON CONFLICT(entity_id) DO UPDATE SET revision=excluded.revision, nodes=excluded.nodes, dirty=1, updated_at=excluded.updated_at',
      [winner, revision, j(combined), before?.input_digest ?? null, before?.as_of ?? null, before?.generated_at || now, before?.model ?? null, before?.touched_at || now, now]);
    this.index('page', winner, this.pageText(combined));
    if (batchId) this.log(batchId, 'page', winner, 'absorbed', { revision: before?.revision ?? null, nodes: kept.length }, { origin: loser, root: rootId, added: moved.length + 1, nodes: combined.length, revision }, now);
    return { absorbed: moved.length + 1, root: rootId, revision, before, origin_revision: source?.revision ?? null };
  }
  restorePageRow(id, before) {
    let nodes = [];
    if (before) {
      this.run('UPDATE pages SET revision=?, nodes=?, input_digest=?, as_of=?, generated_at=?, model=?, dirty=?, touched_at=?, updated_at=? WHERE entity_id=?',
        [before.revision, before.nodes, before.input_digest, before.as_of, before.generated_at, before.model, before.dirty, before.touched_at, before.updated_at, id]);
      nodes = JSON.parse(before.nodes || '[]');
    } else this.run("UPDATE pages SET revision=NULL, nodes='[]', input_digest=NULL, as_of=NULL, generated_at=NULL, model=NULL, dirty=1 WHERE entity_id=?", [id]);
    if (nodes.length) this.index('page', id, this.pageText(nodes)); else this.run("DELETE FROM mem_search WHERE kind='page' AND id=?", [id]);
    return { restored: nodes.length, revision: before?.revision ?? null };
  }
  stripAbsorbed(winner, loser, now) {
    const nodes = JSON.parse(this.pageRow(winner)?.nodes || '[]');
    const kept = nodes.filter((n) => n.origin !== loser);
    if (kept.length === nodes.length) return { removed: 0 };
    try { numbered(kept); } catch (e) { return { removed: 0, reason: `the survivor's page grew under the absorbed subtree (${e.message})` }; }
    const revision = kept.length ? digest(kept.map((n) => [n.id, n.parent ?? null, n.order ?? null, n.text])) : null;
    this.run('UPDATE pages SET revision=?, nodes=?, dirty=1, updated_at=? WHERE entity_id=?', [revision, j(kept), now, winner]);
    if (kept.length) this.index('page', winner, this.pageText(kept)); else this.run("DELETE FROM mem_search WHERE kind='page' AND id=?", [winner]);
    return { removed: nodes.length - kept.length, revision };
  }
}

const isTemp = (v) => isStr(v) && v.startsWith('$');
const sameJson = (a, b) => j(a) === j(b);

/** One batch's validation and writes; $temp ids become stable digests reported in id_map. */
class Apply {
  constructor(store, batchId, now, expected, sourceRefs) {
    Object.assign(this, { s: store, batchId, now, expected, idMap: {}, touched: new Set(), counter: 0, created: [] });
    this.batchSources = sourceRefs.map((r) => this.resolveSource(r));
    this.kind = store.one('SELECT kind FROM batches WHERE id=?', [batchId]).kind;
    this.taskMode = this.kind === 'task';
  }
  /** A caller-written batch (memory_apply, kind 'apply') declaring a NEW entity whose name (case-folded, exact) is already held by a live same-typed entity is refused with the candidate ids:
   * the qualifier pass below would otherwise create the duplicate and rename the original.
   * `name_status: 'distinct'` is the caller's explicit judgement that it is a different thing. Pipeline kinds (push, settle, seed) keep the qualifier path. */
  refuseDuplicateName(name, etype, item) {
    if (this.kind !== 'apply' || item.name_status === 'distinct') return;
    const want = name.trim().toLowerCase();
    const held = (r) => isStr(r.name) && r.name.trim().toLowerCase() === want;
    const typed = truthy(item.type);
    const hits = this.s.all('SELECT id,name,type,aliases FROM entities WHERE merged_into IS NULL').filter((r) => held(r) && (!typed || r.type === etype));
    const all = hits;
    if (all.length) throw new StoreError(`entity ${pyRepr(name)} already exists: ${all.slice(0, 8).map((h) => `${h.id} (${h.name}, ${h.type})`).join('; ')}. Name that entity (by id or exact name) in your notes instead of declaring it new; if it really is a different ${etype}, declare it with name_status:"distinct".`);
  }
  newId(prefix, temp) { this.counter++; const id = prefix + digest([this.batchId, prefix, this.counter], 10); if (temp) this.idMap[temp] = id; return id; }
  entityRef(ref) {
    if (isStr(ref) && ref in this.idMap) return this.idMap[ref];
    if (isStr(ref) && this.s.one('SELECT 1 AS ok FROM entities WHERE id=?', [ref])) return this.s.resolveEntity(ref);
    if (isStr(ref) && ref.trim() && !ref.startsWith('$')) return this.entityByName(ref);
    throw new StoreError(`unknown entity reference ${pyRepr(ref)}`);
  }
  /** A model may name an entity instead of looking its id up: exactly one live entity with that name or alias (case-folded) resolves; a miss or a tie is refused with candidate ids. */
  entityByName(ref) {
    const want = ref.trim().toLowerCase();
    const hits = this.s.all('SELECT id,name,type,aliases FROM entities WHERE merged_into IS NULL').filter((r) => [r.name, ...(r.aliases || [])].some((n) => isStr(n) && n.trim().toLowerCase() === want));
    if (hits.length === 1) { (this.linked ||= {})[ref] = { name: hits[0].name, id: hits[0].id }; return hits[0].id; }
    if (hits.length) throw new StoreError(`entity name ${pyRepr(ref)} is ambiguous; use one of these ids: ${hits.slice(0, 8).map((h) => `${h.id} (${h.name}, ${h.type})`).join('; ')}`);
    const like = `%${want.replace(/[%_]/g, '')}%`;
    const near = this.s.all('SELECT id,name FROM entities WHERE merged_into IS NULL AND (name LIKE ? OR aliases LIKE ?) LIMIT 5', [like, like]);
    throw new StoreError(`unknown entity reference ${pyRepr(ref)}: no live entity has exactly that name or alias${near.length ? `; near: ${near.map((r) => `${r.id} (${r.name})`).join('; ')}` : ''}`);
  }
  resolveSource(ref) {
    if (isStr(ref) && this.s.one('SELECT 1 AS ok FROM raw_data WHERE id=?', [ref])) return ref;
    const t = pyStr(ref), i = t.indexOf('/');
    const row = this.s.one('SELECT id FROM raw_data WHERE source=? AND native_id=? ORDER BY rowid DESC LIMIT 1', i < 0 ? [t, ''] : [t.slice(0, i), t.slice(i + 1)]);
    if (row) return row.id;
    throw new StoreError(`source ref ${pyRepr(ref)} does not name stored raw data`);
  }
  checkVersion(kind, id, current, item) {
    const expected = 'expected_version' in item ? item.expected_version : (this.expected[kind] || {})[id];
    if (expected !== null && expected !== undefined && pyStr(expected) !== pyStr(current)) throw new StoreError(`stale ${kind} ${id}: at version ${current}, expected ${pyStr(expected)}`);
  }
  run(changes) {
    const out = { entities: [], identities: [], mentions: [], notes: [], work: [], pages: [], qualified: [] };
    for (const item of changes.entities || []) out.entities.push(this.entity(item));
    for (const item of changes.identities || []) out.identities.push(this.identity(item));
    for (const item of changes.mentions || []) out.mentions.push(this.mention(item));
    for (const item of changes.notes || []) out.notes.push(this.note(item));
    for (const item of changes.work || []) out.work.push(this.work(item));
    if (changes.work?.length) this.validateWorkParents();
    for (const item of changes.pages || []) out.pages.push(this.page(item));
    out.qualified = this.qualifyCollisions();
    for (const eid of this.touched) this.s.touch(eid, this.now);
    out.id_map = this.idMap; out.dirty_pages = [...this.touched].sort();
    if (this.linked) out.linked_by_name = this.linked;
    return out;
  }
  qualifyCollisions() {
    const out = [];
    for (const id of this.created) {
      const row = this.s.one('SELECT id,name,type,aliases,version,name_status FROM entities WHERE id=? AND merged_into IS NULL', [id]);
      if (!row || row.name_status === 'ambiguous') continue;
      const key = nameKey(row.name);
      const rivals = this.s.all('SELECT id,name,type,aliases,version FROM entities WHERE merged_into IS NULL AND id<>?', [id]).filter((r) => nameKey(r.name) === key);
      if (!rivals.length) continue;
      for (const [sideRow, other] of [[row, rivals[0]], [rivals[0], row]]) {
        const side = this.s.one('SELECT id,name,type,aliases,name_status FROM entities WHERE id=?', [sideRow.id]);
        if (nameKey(side.name) !== key || side.name_status === 'ambiguous') continue;
        const q = collisionQualifier(this.identitiesOf(side.id), side.type, other.type);
        if (!q) {
          this.s.run("UPDATE entities SET name_status='collides', name_problem=? WHERE id=?", [`${pyRepr(side.name)} is held by another live entity and the store knows no stable fact to tell them apart`, side.id]);
          out.push({ id: side.id, op: 'collides', name: side.name, with: other.id });
          continue;
        }
        const renamed = `${side.name} (${q})`, aliases = [...new Set([...side.aliases, side.name])].sort();
        this.s.run("UPDATE entities SET name=?,aliases=?,name_status='qualified',name_problem=NULL,version=version+1,updated_at=? WHERE id=?", [renamed, j(aliases), this.now, side.id]);
        this.s.index('entity', side.id, [renamed, ...aliases].join(' '));
        this.s.log(this.batchId, 'entity', side.id, 'qualified', { name: side.name, aliases: side.aliases }, { name: renamed, aliases, because: `name collides with ${other.id}` }, this.now);
        this.touched.add(side.id);
        out.push({ id: side.id, op: 'qualified', name: renamed, with: other.id });
      }
    }
    return out;
  }
  identitiesOf(id) { return this.s.all('SELECT source,account,native FROM identities WHERE entity_id IN (SELECT value FROM json_each(?)) ORDER BY created_at, rowid', [j(this.s.clusterIds(id))]).map((r) => [r.source, r.account, r.native]); }
  merge(loser, winner) {
    const rows = { [loser]: this.s.one('SELECT * FROM entities WHERE id=?', [loser]), [winner]: this.s.one('SELECT * FROM entities WHERE id=?', [winner]) };
    if (loser === winner || !rows[loser] || !rows[winner]) throw new StoreError('merge needs two distinct existing entities');
    if (rows[loser].merged_into || rows[winner].merged_into) throw new StoreError('merge refuses an entity that is already merged');
    const L = rows[loser], Wr = rows[winner];
    const carried = Object.fromEntries([['identities', 'identities'], ['notes', 'note_entities'], ['work', 'work_entities']].map(([k, t]) => [k, this.s.one(`SELECT COUNT(*) AS n FROM ${t} WHERE entity_id=?`, [loser]).n]));
    const aliases = [...new Set([...Wr.aliases, ...L.aliases, ...(L.name !== Wr.name ? [L.name] : [])])].sort();
    this.s.run('UPDATE entities SET aliases=?, version=version+1, updated_at=? WHERE id=?', [j(aliases), this.now, winner]);
    this.s.run('UPDATE entities SET merged_into=?, version=version+1, updated_at=? WHERE id=?', [winner, this.now, loser]);
    const page = this.s.absorbPage(loser, winner, this.now, this.batchId);
    this.s.index('entity', winner, [Wr.name, Wr.type, ...aliases].join(' '));
    const pick = (o) => Object.fromEntries(['absorbed', 'root', 'revision', 'reason'].map((k) => [k, o[k] ?? null]));
    const before = { name: L.name, aliases: L.aliases, version: L.version, updated_at: L.updated_at };
    const after = { merged_into: winner, carried, survivor_before: { aliases: Wr.aliases, version: Wr.version, updated_at: Wr.updated_at, page: page.before ?? null },
      survivor_after: { aliases, version: Wr.version + 1 }, page: pick(page) };
    this.s.log(this.batchId, 'entity', loser, 'merged', before, after, this.now);
    this.s.log(this.batchId, 'entity', winner, 'absorbed', { aliases: Wr.aliases }, { from: loser, aliases, carried, page: after.page }, this.now);
    this.touched.add(winner);
    return { id: loser, op: 'merged', into: winner, moved: carried, carried, page: Object.fromEntries(Object.entries(pick(page)).filter(([, v]) => v !== null)), version: Wr.version + 1 };
  }
  unmerge(loser) {
    const row = this.s.one('SELECT * FROM entities WHERE id=?', [loser]);
    if (!row) throw new StoreError(`no entity ${loser}`);
    const winner = row.merged_into;
    if (!winner) throw new StoreError(`entity ${loser} is not merged`);
    const rec = this.s.one("SELECT before, after FROM changes WHERE kind='entity' AND target_id=? AND op='merged' ORDER BY seq DESC LIMIT 1", [loser]);
    const before = rec?.before ? JSON.parse(rec.before) : {}, after = rec?.after ? JSON.parse(rec.after) : {};
    const out = { id: loser, op: 'unmerged', from: winner, pre_image: Boolean(rec) };
    if (before.version !== undefined && before.version !== null && row.version === before.version + 1) this.s.run('UPDATE entities SET merged_into=NULL, version=?, updated_at=? WHERE id=?', [before.version, before.updated_at || row.updated_at, loser]);
    else { this.s.run('UPDATE entities SET merged_into=NULL, version=version+1, updated_at=? WHERE id=?', [this.now, loser]); out.loser_changed_since_merge = true; }
    this.s.index('entity', loser, [row.name, row.type, ...row.aliases].join(' '));
    const survivor = this.s.one('SELECT * FROM entities WHERE id=?', [winner]);
    const sb = after.survivor_before || {}, sa = after.survivor_after || {};
    if (Object.keys(sb).length && survivor && survivor.version === sa.version && sameJson(survivor.aliases, sa.aliases)) {
      this.s.run('UPDATE entities SET aliases=?, version=?, updated_at=? WHERE id=?', [j(sb.aliases), sb.version, sb.updated_at, winner]);
      this.s.index('entity', winner, [survivor.name, survivor.type, ...sb.aliases].join(' '));
    } else if (survivor) out.survivor_changed_since_merge = true;
    const page = after.page || {};
    if (page.root) {
      const current = this.s.pageRow(winner);
      out.page = current && current.revision === page.revision ? this.s.restorePageRow(winner, sb.page ?? null) : { ...this.s.stripAbsorbed(winner, loser, this.now), written_since_merge: true };
    }
    this.s.log(this.batchId, 'entity', loser, 'unmerged', { merged_into: winner }, out, this.now);
    this.s.log(this.batchId, 'entity', winner, 'released', { aliases: survivor?.aliases ?? null }, { of: loser, aliases: sb.aliases ?? null, page: out.page ?? null }, this.now);
    return out;
  }
  entity(item) {
    let id = item.id;
    if (truthy(item.unmerge)) return this.unmerge(id);
    if (truthy(item.merge_into)) return this.merge(id, this.entityRef(item.merge_into));
    const temp = isTemp(id) ? id : null;
    const current = temp || !truthy(id) ? null : this.s.one('SELECT * FROM entities WHERE id=?', [id]);
    if (truthy(id) && !temp && !current) throw new StoreError(`entity ${id} does not exist; new entities use a $temp id or no id`);
    const name = pyStr(truthy(item.name) ? item.name : current?.name || '').trim();
    const junk = unnameable(name);
    if (junk) throw new StoreError(`entity name refused: ${junk}`);
    let status = current?.name_status || 'unreviewed', problem = current?.name_problem ?? null;
    if (!current || name !== current.name) { problem = qualifiedNameProblem(name); status = problem ? 'provisional' : 'qualified'; }
    // Two review states are set by name, never inferred: 'ambiguous' (a placeholder for a mention context could not
    // settle, identity.mjs placeholderFor) and 'distinct' (the owner or the settle pass judged it a different thing).
    if (truthy(item.name_status)) {
      if (!MARKED_STATUS.includes(item.name_status)) throw new StoreError(`name_status ${pyRepr(item.name_status)} cannot be set; only ${MARKED_STATUS.join(', ')}`);
      if (!problem) { status = item.name_status; problem = truthy(item.name_problem) ? pyStr(item.name_problem) : problem; }
    }
    let aliases = [...new Set((truthy(item.aliases) ? item.aliases : current?.aliases || []).map((a) => pyStr(a).trim()).filter(Boolean))].sort();
    const etype = pyStr(truthy(item.type) ? item.type : current?.type || 'misc');
    let version, op;
    if (current) {
      this.checkVersion('entities', id, current.version, item);
      if (name !== current.name) aliases = [...new Set([...aliases, current.name])].sort();
      if (name === current.name && etype === current.type && sameJson(aliases, current.aliases) && status === current.name_status) return { id, op: 'unchanged', version: current.version };
      this.s.run('UPDATE entities SET name=?,type=?,aliases=?,name_status=?,name_problem=?,version=version+1,updated_at=? WHERE id=?', [name, etype, j(aliases), status, problem, this.now, id]);
      [version, op] = [current.version + 1, 'updated'];
    } else {
      this.refuseDuplicateName(name, etype, item);
      id = this.newId('e_', temp); [version, op] = [1, 'created'];
      this.s.run('INSERT INTO entities(id,name,type,aliases,name_status,name_problem,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', [id, name, etype, j(aliases), status, problem, this.now, this.now]);
    }
    this.s.index('entity', id, [name, ...aliases].join(' '));
    this.s.log(this.batchId, 'entity', id, op, current ? { name: current.name, type: current.type, aliases: current.aliases } : null, { name, type: etype, aliases, name_status: status, name_problem: problem }, this.now);
    this.touched.add(id);
    if (op === 'created') this.created.push(id);
    const out = { id, op, version, name_status: status };
    if (problem) out.name_problem = problem;
    return out;
  }
  identity(item) {
    const source = pyStr(item.source || ''), native = pyStr(item.native || '');
    if (!truthy(item.source) || !truthy(item.native)) throw new StoreError('identity needs source and native');
    const eid = this.entityRef(item.entity), account = truthy(item.account) ? pyStr(item.account) : '';
    const current = this.s.one('SELECT entity_id FROM identities WHERE source=? AND account=? AND native=?', [source, account, native]);
    const live = current ? this.s.resolveEntity(current.entity_id) : null;
    if (live === eid) return { source, account, native, entity: eid, op: 'unchanged' };
    if (current && !truthy(item.rebind)) throw new StoreError(`identity ${source}/${account}/${native} is bound to ${live}; pass rebind:true to move it`);
    this.s.run('INSERT INTO identities(source,account,native,entity_id,created_at,key) VALUES(?,?,?,?,?,?) ON CONFLICT(source,account,native) DO UPDATE SET entity_id=excluded.entity_id, key=excluded.key', [source, account, native, eid, this.now, handleSlug(native)]);
    const op = current ? 'rebound' : 'bound';
    this.s.log(this.batchId, 'identity', `${source}/${account}/${native}`, op, current ? { entity: current.entity_id } : null, { entity: eid }, this.now);
    this.touched.add(eid);
    return { source, account, native, entity: eid, op };
  }
  mention(item) {
    const text = pyStr(item.text || '').trim();
    if (!truthy(item.text) || !text) throw new StoreError('a mention needs the verbatim text that was said');
    const rawId = truthy(item.raw) ? this.resolveSource(item.raw) : null;
    const row = rawId ? this.s.one('SELECT source,account,thread,occurred_at,text FROM raw_data WHERE id=?', [rawId]) : null;
    const at = truthy(item.at) ? this.s.inst(item.at) : row?.occurred_at || this.now;
    const source = pyStr(truthy(item.source) ? item.source : row?.source || ''), account = pyStr(truthy(item.account) ? item.account : row?.account || '');
    const thread = item.thread !== null && item.thread !== undefined ? item.thread : row?.thread ?? null;
    const entity = truthy(item.entity) ? this.entityRef(item.entity) : null;
    const verbatim = row && quotesFrom(row.text, text) ? 1 : 0;
    const id = 'm_' + digest([rawId, mentionKey(text), at, entity, source, thread], 12);
    if (this.s.one('SELECT 1 AS ok FROM mentions WHERE id=?', [id])) return { id, op: 'unchanged', entity };
    const method = pyStr(truthy(item.method) ? item.method : entity ? 'resolved' : 'unresolved');
    this.s.run('INSERT INTO mentions(id,text,key,raw_id,source,account,thread,at,entity_id,method,considered,verbatim,batch_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, text, mentionKey(text), rawId, source, account, thread, at, entity, method, j(item.considered || []), verbatim, this.batchId, this.now]);
    return { id, op: 'recorded', entity, at, verbatim: Boolean(verbatim), method };
  }
  note(item) {
    const body = pyStr(item.body ?? '').trim();
    if (!truthy(item.body) || !body) throw new StoreError('note needs a body');
    const entities = (item.entities || []).map((e) => this.entityRef(e));
    if (!entities.length) throw new StoreError(`note ${pyRepr(cpSlice(body, 0, 40))} attaches to no entity`);
    const sources = (item.source_refs || []).map((r) => this.resolveSource(r));
    const srcs = sources.length ? sources : [...this.batchSources];
    if (!srcs.length) throw new StoreError(`note ${pyRepr(cpSlice(body, 0, 40))} cites no raw data`);
    const noteRefs = [...(item.note_refs || [])];
    for (const r of noteRefs) if (!this.s.one('SELECT 1 AS ok FROM notes WHERE id=?', [r])) throw new StoreError(`note ref ${pyRepr(r)} does not exist`);
    const at = truthy(item.at) ? this.s.inst(item.at) : this.s.one(`SELECT MIN(occurred_at) AS t FROM raw_data WHERE id IN (${srcs.map(() => '?').join(',')})`, srcs).t;
    const id = this.newId('n_', pyStr(item.id ?? '').startsWith('$') ? item.id : null);
    this.s.run('INSERT INTO notes(id,body,author,at,source_refs,note_refs,batch_id,created_at) VALUES(?,?,?,?,?,?,?,?)', [id, body, pyStr(truthy(item.author) ? item.author : 'model'), at, j(srcs), j(noteRefs), this.batchId, this.now]);
    const uniqE = [...new Set(entities)];
    for (const eid of uniqE) { this.s.run('INSERT INTO note_entities(note_id,entity_id) VALUES(?,?)', [id, eid]); this.touched.add(eid); }
    this.s.index('note', id, body);
    this.s.log(this.batchId, 'note', id, 'created', null, { body, entities, source_refs: srcs }, this.now);
    return { id, op: 'created', entities: uniqE, at };
  }
  validateWorkParents() {
    const parents = new Map(this.s.all('SELECT id,parent_id FROM work').map((r) => [r.id, r.parent_id]));
    for (const id of parents.keys()) {
      const seen = new Set(); let at = id;
      while (at !== null && at !== undefined) {
        // A parent outside this replica's groups is unknown, not an error: partial replicas hold children whose parents live elsewhere.
        if (!parents.has(at)) break;
        if (seen.has(at)) throw new StoreError(`task parent cycle at ${at}`);
        seen.add(at); at = parents.get(at);
      }
    }
  }
  work(item) {
    let id = item.id;
    const temp = isTemp(id) ? id : null;
    const current = temp || !truthy(id) ? null : this.s.one('SELECT * FROM work WHERE id=?', [id]);
    if (truthy(id) && !temp && !current) throw new StoreError(`work ${id} does not exist; new work uses a $temp id or no id`);
    if (current) {
      const expected = 'expected_version' in item ? item.expected_version : (this.expected.work || {})[id];
      if (this.taskMode && !Number.isInteger(expected)) throw new StoreError('task update requires integer expected_version');
      if (expected !== null && expected !== undefined && pyStr(expected) !== pyStr(current.version)) {
        if (this.taskMode) throw new TaskConflict(current, expected);
        this.checkVersion('work', id, current.version, item);
      }
    }
    const base = current || {};
    const get = (k, d) => (k in item ? item[k] : k in base ? base[k] : d);
    let title = pyStr(get('title', '')).trim();
    const body = pyStr(get('body', '')).trim();
    let status = get('status', 'todo');
    if (!title || !WORK_STATUS.includes(status)) throw new StoreError("work needs a title and a status in ('todo', 'done', 'dropped')");
    let ownerKind = get('owner_kind', 'unknown'), ownerRef = get('owner_ref', null);
    if (!['me', 'person', 'chat', 'unknown'].includes(ownerKind)) throw new StoreError('owner_kind must be me, person, chat or unknown');
    if (ownerKind === 'me' || ownerKind === 'unknown') { if (ownerRef !== null && ownerRef !== undefined) throw new StoreError('me/unknown owner has no owner_ref; clear it explicitly on transfer'); ownerRef = null; }
    else if (!isStr(ownerRef) || !ownerRef.trim()) throw new StoreError('person/chat owner requires owner_ref');
    if (ownerKind === 'person') ownerRef = this.entityRef(ownerRef);
    let parent = get('parent_id', null);
    if (parent !== null && parent !== undefined) {
      parent = parent in this.idMap ? this.idMap[parent] : parent;
      if (!isStr(parent) || !this.s.one('SELECT 1 AS ok FROM work WHERE id=?', [parent])) throw new StoreError(`unknown task parent ${pyRepr(parent)}; create parents before children`);
    } else parent = null;
    const context = get('context_refs', []);
    let bindings = get('bindings', []);
    if (!Array.isArray(context) || context.some((x) => !isObj(x))) throw new StoreError('context_refs must be a list of retrieval locator objects');
    if (!Array.isArray(bindings) || bindings.some((x) => !isObj(x) || Object.keys(x).sort().join() !== 'native_id,source' || Object.values(x).some((v) => !isStr(v) || !v))) throw new StoreError('bindings must be explicit source/native_id objects');
    if (bindings.some((x) => !['notes-line', 'chat-goal', 'file-task'].includes(x.source))) throw new StoreError('binding source must be notes-line, chat-goal or file-task; message locators belong in context_refs');
    const baseB = base.bindings || [];
    const has = (list, x) => list.some((y) => sameJson(y, x));
    bindings = [...baseB, ...bindings.filter((x) => !has(baseB, x))];
    for (const row of this.s.all('SELECT id,bindings FROM work WHERE id<>?', [truthy(id) ? id : ''])) if (bindings.some((x) => has(row.bindings, x))) throw new StoreError(`legacy binding already belongs to ${row.id}`);
    if (current && !this.taskMode && (current.bindings || []).some((x) => x.source === 'chat-goal' && String(x.native_id ?? '').endsWith(':chat')))
      [title, status, ownerKind, ownerRef, parent] = [current.title, current.status, current.owner_kind, current.owner_ref, current.parent_id];
    const entities = [...new Set((item.entities || []).map((e) => this.entityRef(e)))];
    let sources = (item.source_refs || []).map((r) => this.resolveSource(r));
    if (!sources.length && !current) sources = [...this.batchSources];
    const linked = current ? this.s.all('SELECT entity_id FROM work_entities WHERE work_id=?', [id]).map((r) => r.entity_id) : [];
    if (current) sources = [...new Set([...current.source_refs, ...sources])];
    else if (!this.taskMode) {
      if (!entities.length) throw new StoreError(`work ${pyRepr(title)} relates to no entity`);
      if (!sources.length) throw new StoreError(`work ${pyRepr(title)} cites no raw data`);
    }
    const fields = { title, body, status, source_refs: sources, owner_kind: ownerKind, owner_ref: ownerRef, parent_id: parent, context_refs: context, bindings };
    if (current && Object.entries(fields).every(([k, v]) => sameJson(current[k] ?? null, v ?? null)) && entities.every((e) => linked.includes(e))) return { id, op: 'unchanged', version: current.version, status };
    const enc = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, ['source_refs', 'context_refs', 'bindings'].includes(k) ? j(v) : v]));
    let version, op, before = null;
    if (current) {
      before = Object.fromEntries(Object.keys(fields).map((k) => [k, current[k] ?? null]));
      this.s.run(`UPDATE work SET ${Object.keys(enc).map((k) => k + '=?').join(',')},version=version+1,updated_at=? WHERE id=?`, [...Object.values(enc), this.now, id]);
      [version, op] = [current.version + 1, 'updated'];
    } else {
      id = this.newId('w_', temp); [version, op] = [1, 'created'];
      this.s.run(`INSERT INTO work(id,${Object.keys(enc).join(',')},created_at,updated_at) VALUES(${Array(Object.keys(enc).length + 3).fill('?').join(',')})`, [id, ...Object.values(enc), this.now, this.now]);
    }
    for (const eid of [...new Set([...entities, ...linked])]) { this.s.run('INSERT OR IGNORE INTO work_entities(work_id,entity_id) VALUES(?,?)', [id, eid]); this.touched.add(eid); }
    this.s.index('work', id, [title, body, status].join(' '));
    this.s.log(this.batchId, 'work', id, op, before, fields, this.now);
    return { id, op, version, status };
  }
  page(item) {
    const eid = this.entityRef(item.entity_id);
    const nodes = item.nodes;
    if (!Array.isArray(nodes) || !nodes.length) throw new StoreError(`page for ${eid} has no nodes`);
    try { numbered(nodes); } catch (e) { throw new StoreError(`page for ${eid} is not a tree: ${e.message}`); }
    const current = this.s.one('SELECT * FROM pages WHERE entity_id=?', [eid]) || { revision: null, touched_at: '', nodes: [] };
    const base = 'expected_base_revision' in item ? item.expected_base_revision : (this.expected.pages || {})[eid];
    if ((base ?? null) !== (current.revision ?? null)) throw new StoreError(`stale page ${eid}: base ${pyStr(base ?? null)}, current ${pyStr(current.revision ?? null)}`);
    const revision = item.revision || digest(nodes.map((n) => [n.id, n.parent ?? null, n.order ?? null, n.text]));
    const asOf = truthy(item.as_of) ? this.s.inst(item.as_of) : this.now;
    const touchedIn = 'touched_at' in item ? item.touched_at : current.touched_at;
    const stillDirty = touchedIn === current.touched_at ? 0 : 1;
    this.s.run('INSERT INTO pages(entity_id,revision,nodes,input_digest,as_of,generated_at,model,dirty,touched_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(entity_id) DO UPDATE SET revision=excluded.revision, nodes=excluded.nodes, input_digest=excluded.input_digest, as_of=excluded.as_of, generated_at=excluded.generated_at, model=excluded.model, dirty=excluded.dirty, updated_at=excluded.updated_at',
      [eid, revision, j(nodes), item.input_digest ?? null, asOf, item.generated_at || this.now, j(item.model ?? null), stillDirty, current.touched_at || this.now, this.now]);
    this.s.index('page', eid, this.s.pageText(nodes));
    this.s.log(this.batchId, 'page', eid, 'written', { revision: current.revision ?? null }, { revision, changes: item.changes || [], nodes: nodes.length }, this.now);
    return { entity_id: eid, op: 'written', revision, dirty: Boolean(stillDirty) };
  }
}

/** The discovery read boundary over this store's raw data (rev5 RawDataPlane). */
export class RawDataPlane {
  constructor(store) { this.s = store; }
  planes(requested) { const present = new Set(this.s.distinctSources()); return requested.map((p) => ({ plane: p, available: present.has(p), reason: present.has(p) ? null : 'no raw data ingested from this source', partial: false })); }
  static record(r) { return { plane: r.source, account: r.account, native_id: r.native_id, revision: r.revision, event_time: r.occurred_at, observed_time: r.available_at, text: r.text, thread_id: r.thread, author: r.author, recipients: [...(r.participants || [])], role: r.role, quotes: [], tool: null, observed_inferred: false }; }
  /** Two stages: the ranked and the recent top-n are chosen on (id, source) alone, so the planner never reads a full row (text is
   *  overflow pages) for a match that is then sorted away, and only the rows kept per source (at most `limit` each) are read whole. */
  search(planes, terms, asOf, limit) {
    const expr = terms.filter((t) => t && t.trim()).map((t) => `"${t.replace(/"/gu, '""')}"`).join(' OR ');
    let rows = [], excluded = 0; const taken = new Map();
    if (expr && planes.length) {
      const args = { q: expr, pl: j(planes), as_of: instant(asOf), n: limit };
      const from = `FROM raw_search s JOIN raw_data r ON r.id=s.id WHERE raw_search MATCH :q AND r.source IN (SELECT value FROM json_each(:pl)) AND ${this.s.localOnlyCut} AND ${ELIGIBLE}`;
      const ranked = this.s.all(`SELECT r.id, r.source ${from} ORDER BY rank LIMIT :n`, { ...args, n: limit * planes.length });
      const recent = this.s.all(`SELECT r.id, r.source ${from} ORDER BY r.occurred_at DESC, r.rowid DESC LIMIT :n`, { ...args, n: limit * planes.length });
      for (const r of [...ranked, ...recent]) { if (!taken.has(r.source)) taken.set(r.source, []); const b = taken.get(r.source); if (b.length < limit && b.every((x) => x !== r.id)) b.push(r.id); }
      const whole = new Map(this.s.all('SELECT r.* FROM raw_data r WHERE r.id IN (SELECT value FROM json_each(:ids))', { ids: j([...taken.values()].flat()) }).map((r) => [r.id, r]));
      rows = [...taken.values()].flat().map((id) => RawDataPlane.record(whole.get(id)));
      excluded = this.s.one(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM raw_search s JOIN raw_data r ON r.id=s.id WHERE raw_search MATCH :q AND r.source IN (SELECT value FROM json_each(:pl)) AND NOT (${this.s.localOnlyCut} AND ${ELIGIBLE}) LIMIT :n)`, args).n;
    }
    const atCap = rows.length ? [...taken.entries()].filter(([, b]) => b.length >= limit).map(([p]) => p).sort() : [];
    return { records: rows, excluded, excluded_capped: excluded >= limit, planes_at_cap: atCap, candidates_capped: false, recency_window: null, recency_cut: null };
  }
  /** The party test is written before the eligibility subquery on purpose: SQLite evaluates a row's terms in written order, and the
   *  eligibility NOT EXISTS is an index probe plus a table fetch per row, so with it first every row of a plane
   *  paid for it and a rare person cost 6 s; with the cheap author/participant test first only the matches do.
   */
  searchParties(planes, aliases, asOf, limit) {
    const rows = [];
    for (const plane of planes) if (aliases.length) rows.push(...this.s.all(`SELECT r.* FROM raw_data r WHERE r.source=:p AND (lower(r.author) IN (SELECT value FROM json_each(:al)) OR EXISTS (SELECT 1 FROM json_each(r.participants) WHERE lower(value) IN (SELECT value FROM json_each(:al)))) AND ${this.s.allowed} AND ${ELIGIBLE} ORDER BY r.occurred_at DESC LIMIT :n`,
      { p: plane, as_of: instant(asOf), al: j(aliases.map((a) => a.toLowerCase())), n: limit }));
    return [rows, null];
  }
  neighbors(plane, account, thread, asOf, limit, since) {
    const rows = this.s.all(`SELECT r.* FROM raw_data r WHERE r.source=:p AND r.account=:a AND r.thread=:t AND r.occurred_at >= :since AND ${this.s.allowed} AND ${ELIGIBLE} ORDER BY r.occurred_at DESC, r.rowid DESC LIMIT :n`,
      { p: plane, a: account, t: thread, as_of: instant(asOf), since: since || '', n: limit + 1 }).map(RawDataPlane.record);
    return [rows.slice(0, limit), rows.length > limit];
  }
}
