// The runner's memory and shared-work store, backed by @tophat-md/linknotes. Hand-written (not assembled): the
// assembled runner and webchat reach the store only through this module and ./cli.mjs.
//
// One request shape for every caller: answer(command, request, { db, env, readOnly }) -> { result, code }, where
// command is tasks | ingest | search | read | apply | status | push and code is 0 (ok), 2 (refused) or 1 (internal).
// `tasks` takes { op: list | get | apply | chat, ... }. A refusal is a value ({ ok: false, reason, detail }); a stale
// task write answers { ok: false, reason: 'conflict', current, expected_version } so the caller can retry on the
// current state.
//
// Scope. The replica's user is the instance scope (TOPHAT_SCOPE; default 'local') and every row written without
// explicit groups goes to that scope. TOPHAT_SCOPE_GROUPS (comma separated) names further groups the instance may
// share into: each is created on first open when this replica has never seen it (its creator is its admin); a group
// that exists without this user as a member is left alone (it is someone else's, joined through the hub). So a group
// runner (an instance whose scope is the group) writes into the group's scope by default. TOPHAT_SCOPE_USER, when set,
// names the replica's user apart from its write scope: a person whose replica already holds groups (user `sam` writing
// into `sam-private`) opens it as that user, and no group is created for the user name.
//
// Hub. TOPHAT_HUB_URL and TOPHAT_HUB_TOKEN_FILE (from the instance file's `hub` block) let sync() push and pull the
// replica through a ciphertext-only hub; TOPHAT_DEVICE and TOPHAT_DEVICE_KEY_FILE name the device and its key file
// (default: a device id derived from the host and the database path, its key beside the database).
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { createHash } from 'node:crypto';
import { SqliteBackend } from '@tophat-md/linknotes';

const SCOPE_RE = /^[a-z][a-z0-9-]{1,47}$/;
export const DEFAULT_SCOPE = 'local';
export const COMMANDS = ['tasks', 'ingest', 'search', 'read', 'apply', 'status', 'push', 'sync'];
const WRITES = new Set(['ingest', 'apply', 'push']);

/** The scope and groups an environment names; an invalid name is an error, never silently replaced. */
export function scopeOf(env = process.env) {
  const scope = String(env.TOPHAT_SCOPE || DEFAULT_SCOPE).trim();
  const user = String(env.TOPHAT_SCOPE_USER || scope).trim();
  const groups = String(env.TOPHAT_SCOPE_GROUPS || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const g of [scope, user, ...groups]) if (!SCOPE_RE.test(g)) throw new Error(`scope name ${JSON.stringify(g)} must match ${SCOPE_RE} (TOPHAT_SCOPE / TOPHAT_SCOPE_USER / TOPHAT_SCOPE_GROUPS)`);
  return { scope, user, groups: [...new Set(groups.filter((g) => g !== scope))] };
}

/** The hub block an environment names, or null: { url, tokenFile, timeoutMs }. */
export function hubOf(env = process.env) {
  if (!env.TOPHAT_HUB_URL) return null;
  if (!env.TOPHAT_HUB_TOKEN_FILE) throw new Error('TOPHAT_HUB_URL is set without TOPHAT_HUB_TOKEN_FILE');
  return { url: env.TOPHAT_HUB_URL, tokenFile: env.TOPHAT_HUB_TOKEN_FILE, ...(env.TOPHAT_HUB_TIMEOUT_MS ? { timeoutMs: Number(env.TOPHAT_HUB_TIMEOUT_MS) } : {}) };
}

const opened = new Map(); // db path + scope -> backend

/** The replica at `db`, opened as the environment's scope; cached per process. */
export function openStore(db, env = process.env) {
  if (!db) throw new Error('memory store: no database path');
  const { scope, user, groups } = scopeOf(env);
  const hub = hubOf(env);
  const key = `${db}\0${user}\0${scope}\0${groups.join(',')}\0${hub?.url ?? ''}`;
  let b = opened.get(key);
  if (b) return b;
  const device = env.TOPHAT_DEVICE || `${user}-${createHash('sha256').update(`${hostname()}\0${db}`).digest('hex').slice(0, 10)}`;
  b = new SqliteBackend({ file: db, keyFile: env.TOPHAT_DEVICE_KEY_FILE || `${db}.device-key.json`, user, device, writeScopes: [scope], ...(hub ? { hub } : {}) });
  const s = b.store;
  for (const g of [scope, ...groups]) {
    if (s.one('SELECT 1 AS ok FROM mc_groups WHERE grp=?', [g])) continue;
    try { s.createGroup(g); } catch (e) { if (!s.one('SELECT 1 AS ok FROM mc_groups WHERE grp=?', [g])) throw e; } // another process made it first
  }
  opened.set(key, b);
  return b;
}

/** Close every cached replica (tests; a long-lived process never needs it). */
export function closeAll() { for (const b of opened.values()) { try { b.store.close(); } catch { /* closed */ } } opened.clear(); }

const pick = (req, keys) => Object.fromEntries(keys.filter((k) => req[k] !== undefined).map((k) => [k, req[k]]));

// A webchat chat is one shared work item, bound to its session, owned by the chat; created on its first turn.
const CHAT_SUFFIX = ':chat';
// The webchat appends a runtime-clock block (and, on a checkpoint, a pace-check block) to the owner's text; neither is
// part of what the owner asked, so a title never carries one, closed or cut off by the title's length limit.
const RUNTIME_BLOCK = /<(runtime-clock|pace-check)>[\s\S]*?(?:<\/\1>|$)/gi;
export const cleanTitle = (t) => String(t || '').replace(RUNTIME_BLOCK, ' ').replace(/\s+/g, ' ').replace(/^\s*\[(?:Automated event|Relayed by [^\]]*)[^\]]*\]\s*/i, '').trim().replace(/^[ ,.;-]+|[ ,.;-]+$/g, '').slice(0, 120);
function chatWork(s, req) {
  const session = String(req.session || '').trim();
  if (!session) throw new StoreErrorLike('chat op needs a session');
  const binding = { source: 'chat-goal', native_id: `${session}${CHAT_SUFFIX}` };
  const found = s.taskList({ binding, limit: 1 }).tasks[0];
  if (found) return { ok: true, work: found };
  const out = s.taskApply(`chat-work:${session}`, [{ id: '$chat', title: `Chat: ${cleanTitle(req.title) || session}`, status: 'todo', owner_kind: 'chat', owner_ref: session, bindings: [binding] }],
    'push:chat-work', req.source_refs ?? null);
  const id = out.id_map?.$chat ?? out.work?.[0]?.id;
  return { ok: true, work: id ? s.one('SELECT * FROM work WHERE id=?', [id]) : null };
}
class StoreErrorLike extends Error {}


/** A raw record in either spelling: this store's own columns, or the linknotes RawRecord ({ id, time }).
 * Policy defaults to `allow`: a record a caller ingested without saying otherwise is readable by its own scope
 * (the store itself defaults to deny, which would hide every turn a chat ingests). */
export function asRecord(r) {
  if (!r || typeof r !== 'object') return r;
  const out = { ...r, policy: r.policy ?? 'allow' };
  if (out.native_id === undefined && out.id !== undefined) { out.native_id = String(out.id); delete out.id; }
  if (out.occurred_at === undefined && out.time !== undefined) out.occurred_at = out.time;
  if (out.available_at === undefined && out.available !== undefined) out.available_at = out.available;
  return out;
}

/** Notes cite raw data. A batch whose notes cite none gets one evidence record per distinct group set, holding only
 * the text of that set's notes: one record for the whole batch would put a private note's words into a shared row. */
function cite(s, req) {
  const notes = Array.isArray(req.changes?.notes) ? req.changes.notes : [];
  if ((req.source_refs || []).length) return;
  const bySet = new Map();
  for (const n of notes) {
    if (!n || typeof n !== 'object' || (n.source_refs || []).length) continue;
    const acl = [...(n.groups ?? n.acl ?? req.groups ?? s.writeGroups ?? [])].sort();
    const k = acl.join(',');
    if (!bySet.has(k)) bySet.set(k, { acl, notes: [] });
    bySet.get(k).notes.push(n);
  }
  for (const { acl, notes: group } of bySet.values()) {
    const text = group.map((n) => n.body).join('\n');
    const now = s.now();
    const rec = asRecord({ source: 'memory-apply', native_id: createHash('sha256').update(`${s.user}\0${req.batch_id}\0${acl.join(',')}`).digest('hex').slice(0, 12), text, occurred_at: now, author: s.user, role: 'owner' });
    const got = s.ingest([rec], acl.length ? { acl } : {});
    const rid = got.stored[0] ?? got.duplicates[0];
    for (const n of group) n.source_refs = [rid];
  }
}

function dispatch(s, command, req, readOnly, env) {
  if (readOnly && (WRITES.has(command) || (command === 'tasks' && ['apply', 'chat'].includes(req.op)))) {
    return { ok: false, reason: 'refused', detail: `read-only memory: ${command} writes` };
  }
  if (command === 'tasks') {
    const op = req.op || 'list';
    if (op === 'list') return s.taskList(pick(req, ['owner_kind', 'owner_ref', 'status', 'query', 'limit', 'offset', 'binding']));
    if (op === 'get') return s.read('work', String(req.id ?? ''), { history: true });
    if (op === 'apply') return s.taskApply(req.op_id, req.tasks, req.actor, req.source_refs ?? null);
    if (op === 'chat') return chatWork(s, req);
    throw new StoreErrorLike('task op must be list, get, apply or chat');
  }
  if (command === 'ingest') return s.ingest((req.records || []).map(asRecord), req.groups ? { acl: req.groups } : {});
  if (command === 'search') return s.search(req.query, { kind: req.kind, limit: req.limit || 20, asOf: req.as_of, allTerms: Boolean(req.all_terms) });
  if (command === 'read') return s.read(req.kind, String(req.id ?? ''), { nodes: req.nodes, budget: req.budget, asOf: req.as_of, history: Boolean(req.history) });
  if (command === 'apply') {
    // The evidence row cite() writes and the notes citing it land together or not at all: a refused batch leaves no
    // orphan evidence behind (the request is not mutated either, so a retry starts clean).
    const r = structuredClone(req);
    return atomically(s, () => {
      cite(s, r);
      return s.apply(r.batch_id, r.changes || {}, { sourceRefs: r.source_refs ?? null, expectedVersions: r.expected_versions ?? null, ackRaw: r.ack_raw ?? null,
        ...(r.groups !== undefined && r.groups !== null ? { groups: r.groups } : {}) });
    });
  }
  if (command === 'sync') return { ok: false, reason: 'refused', detail: 'sync is asynchronous: call syncStore(db, env) or `store/cli.mjs sync`' };
  if (command === 'push') return consolidate(s, req);
  if (command === 'status') { const { scope, groups } = scopeOf(env); const hub = hubOf(env); return { ok: true, ...s.status(), hub: hub ? { url: hub.url } : null, scope: { user: s.user, write: s.writeGroups, groups, readable: s.viewer?.groups ?? [] }, default_scope: scope }; }
  throw new StoreErrorLike(`command must be one of ${COMMANDS.join(', ')}`);
}

/** A transaction the store's own transactions nest in: every write `work` makes (each sealed as its own logged action)
 * commits at the end, or none does. A result with ok === false rolls back too. linknotes opens one BEGIN IMMEDIATE per
 * write and has no nesting, so for the duration of `work` this replica's tx() runs nested work inline. */
const REFUSED = Symbol('refused');
function atomically(s, work) {
  if (Object.hasOwn(s, 'tx')) return work(); // already inside one
  const outer = s.tx;
  let refused = null;
  s.tx = function nested(inner) { const out = inner(); if (typeof this.seal === 'function') this.seal(); return out; };
  try {
    return outer.call(s, () => {
      const out = work();
      if (out && out.ok === false) { refused = out; throw REFUSED; }
      return out;
    });
  } catch (e) {
    if (e === REFUSED) return refused;
    throw e;
  } finally { delete s.tx; }
}

/** The runner's push hook: the model-free part of consolidation. Pages of entities whose notes changed are rebuilt from
 * their notes (linknotes pageFor, the same outline the store serves on read) and marked clean. Interpretation (raw
 * records to entities and notes) needs a model and runs in the instance's intake (@tophat-md/push through
 * @tophat-md/upkeep), never here, so `interpret` says it did not run. */
function consolidate(s, req) {
  const limit = Math.max(1, Math.min(500, Number(req.page_limit) || 100));
  const dirty = s.all('SELECT entity_id, touched_at FROM pages WHERE dirty=1 AND entity_id IN (SELECT id FROM entities WHERE merged_into IS NULL) ORDER BY touched_at LIMIT ?', [limit]);
  const pages = [], problems = [];
  for (const { entity_id: id, touched_at: touched } of dirty) {
    try {
      if (s.viewer && !s.aclVisible('entities', id)) { pages.push({ entity_id: id, status: 'not_visible' }); continue; }
      const p = s.pageFor(id);
      s.run('UPDATE pages SET dirty=0, updated_at=? WHERE entity_id=? AND touched_at IS ?', [s.now(), id, touched]);
      pages.push({ entity_id: id, status: p.cached ? 'cached' : 'built', notes: p.note_ids.length });
    } catch (e) { problems.push(`page ${id}: ${e?.message || e}`); }
  }
  const count = (sql) => s.one(sql).n;
  return { ok: true, ran: true, interpret: { status: 'not_run', reason: 'interpretation runs in the instance intake (upkeep job intake), not in the runner' },
    pages, problems, pages_dirty_after: count('SELECT COUNT(*) AS n FROM pages WHERE dirty=1 AND entity_id IN (SELECT id FROM entities WHERE merged_into IS NULL)'),
    backlog_after: count('SELECT COUNT(*) AS n FROM raw_data WHERE processed_batch IS NULL') };
}

/** One request: { result, code } in the shapes the runner and the webchat read. Never throws. */
export function answer(command, req, { db, env = process.env, readOnly = false } = {}) {
  try {
    if (!req || typeof req !== 'object' || Array.isArray(req)) throw new StoreErrorLike('request must be one JSON object');
    const s = openStore(db, env).store;
    const result = dispatch(s, command, req, readOnly, env);
    return { result, code: result && result.ok === false ? 2 : 0 };
  } catch (e) {
    if (e && e.current && 'expected' in e) return { result: { ok: false, reason: 'conflict', current: e.current, expected_version: e.expected }, code: 2 };
    const refused = e instanceof StoreErrorLike || e?.constructor?.name === 'StoreError' || e instanceof TypeError || e instanceof RangeError;
    return { result: { ok: false, command, reason: refused ? 'refused' : 'internal_error', detail: `${e?.constructor?.name || 'Error'}: ${e?.message || e}`, error: `${refused ? 'refused: ' : ''}${e?.message || e}` }, code: refused ? 2 : 1 };
  }
}

/** One hub round (push, pull, key wraps) for the replica at `db`: { result, code }. Never throws; no hub is a refusal. */
export async function syncStore(db, env = process.env) {
  try {
    const hub = hubOf(env);
    if (!hub) return { result: { ok: false, reason: 'refused', detail: 'no hub configured (the instance file has no hub block)' }, code: 2 };
    try { readFileSync(hub.tokenFile, 'utf8'); } catch { return { result: { ok: false, reason: 'refused', detail: 'the hub token file is not readable' }, code: 2 }; }
    const r = await openStore(db, env).sync();
    return { result: { ok: true, hub: hub.url, ...r }, code: 0 };
  } catch (e) {
    return { result: { ok: false, command: 'sync', reason: 'internal_error', detail: `${e?.constructor?.name || 'Error'}: ${e?.message || e}` }, code: 1 };
  }
}

/** The task call the runner and the webchat share: the answer object, or throws on a refusal like the old CLI wrapper. */
export function taskAnswer(request, { db, env = process.env } = {}) {
  return answer('tasks', request, { db, env }).result;
}
