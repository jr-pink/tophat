// Replicated vault state: a last-writer-wins map per credential, per passkey,
// with tombstones, ordered by a hybrid logical clock (HLC).
//
// Everything in this module is pure: it never touches a file or a key. The
// catalog it merges is the decrypted catalog JSON, which lives in memory only;
// values stay in their own encrypted files and are referenced by keyringName,
// so a merge moves ciphertext, never plaintext.
//
// Clock format: "<wall ms, 15 digits>.<counter, 6 digits>.<replica id>". The
// fixed widths make string order equal clock order, so every comparison is a
// plain string compare and the replica id breaks ties deterministically.

const HLC = /^(\d{15})\.(\d{6})\.([a-z0-9-]{1,64})$/;
export const REPLICA = /^[a-z0-9-]{1,64}$/;
// WebCrypto, not node:crypto, so this one file is the reducer on the server and
// in the browser alike.
export const newReplicaId = () =>
  [...globalThis.crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, '0')).join('');

export function encodeHlc(wall, counter, replica) {
  if (!Number.isSafeInteger(wall) || wall < 0 || !Number.isSafeInteger(counter) || counter < 0 || counter > 999999)
    throw new Error('Invalid clock');
  if (!REPLICA.test(replica)) throw new Error('Invalid replica id');
  return `${String(wall).padStart(15, '0')}.${String(counter).padStart(6, '0')}.${replica}`;
}

export function decodeHlc(text) {
  const match = typeof text === 'string' ? HLC.exec(text) : null;
  if (!match) return null;
  return {wall: Number(match[1]), counter: Number(match[2]), replica: match[3]};
}

export const validHlc = text => decodeHlc(text) !== null;
export const compareHlc = (a, b) => (a === b ? 0 : a < b ? -1 : 1);

// The next clock after everything this replica has seen. Seeing a peer's clock
// is the HLC receive step; since every clock a replica has merged lives in its
// catalog, the maximum over the catalog is the receive state, nothing extra
// has to be persisted.
export function tick(latest, replica, now = Date.now()) {
  const last = decodeHlc(latest);
  if (!last || now > last.wall) return encodeHlc(now, 0, replica);
  if (last.counter < 999999) return encodeHlc(last.wall, last.counter + 1, replica);
  return encodeHlc(last.wall + 1, 0, replica);
}

export function latestHlc(catalog) {
  let best = null;
  const see = value => {if (validHlc(value) && (best === null || value > best)) best = value;};
  for (const entry of Object.values(catalog.entries || {})) see(entry.hlc);
  for (const tomb of Object.values(catalog.tombstones || {})) see(tomb.hlc);
  for (const value of Object.values(catalog.passkeyClocks || {})) see(value);
  for (const value of Object.values(catalog.passkeyTombstones || {})) see(value);
  return best;
}

// Key-sorted JSON, so two equal objects compare equal whatever order their
// keys were written in.
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value).sort().filter(key => value[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}

const withoutClock = ({hlc, ...rest}) => rest;
const sameContent = (a, b) => canonical(withoutClock(a)) === canonical(withoutClock(b));

// An entry written before clocks existed (or by a build that does not stamp
// them) gets one derived from its own updatedAt, so a migrated vault orders
// its history the way the timestamps already did.
export function legacyHlc(entry, replica) {
  const at = Date.parse(entry?.updatedAt ?? '');
  return encodeHlc(Number.isSafeInteger(at) && at > 0 ? at : 0, 0, replica);
}

// Stamp every change a mutation made. before/after are {entries, passkeys}
// where passkeys is the decrypted passkey index array. Anything new or
// different gets a fresh clock; anything gone gets a tombstone. A pre-clock
// writer (an older serving release) leaves an edited entry with its old clock
// and a newer updatedAt; that is caught here as a change too.
export function stampChanges(catalog, before, afterPasskeys, replica, now = Date.now()) {
  catalog.tombstones ||= {};
  catalog.passkeyClocks ||= {};
  catalog.passkeyTombstones ||= {};
  catalog.sync ||= {};
  catalog.sync.pending ||= {};
  let latest = latestHlc(catalog);
  const next = () => (latest = tick(latest, replica, now));
  const changed = [];
  for (const [id, entry] of Object.entries(catalog.entries)) {
    const prior = before.entries[id];
    if (prior && sameContent(prior, entry)) {
      // Untouched by this mutation. A record from before clocks existed is
      // migrated with a clock derived from its own updatedAt, not queued.
      if (!validHlc(entry.hlc)) entry.hlc = legacyHlc(entry, replica);
      continue;
    }
    entry.hlc = next();
    delete catalog.tombstones[id];
    catalog.sync.pending[id] = entry.hlc;
    changed.push(id);
  }
  for (const [id, prior] of Object.entries(before.entries)) {
    if (Object.hasOwn(catalog.entries, id)) continue;
    catalog.tombstones[id] = {hlc: next(), name: prior.name, kind: prior.kind};
    catalog.sync.pending[id] = catalog.tombstones[id].hlc;
    changed.push(id);
  }
  const priorKeys = new Map((before.passkeys || []).map(entry => [entry.id, entry]));
  const nowKeys = new Map((afterPasskeys || []).map(entry => [entry.id, entry]));
  for (const [id, entry] of nowKeys) {
    const prior = priorKeys.get(id);
    if (prior && canonical(prior) === canonical(entry)) {
      if (!validHlc(catalog.passkeyClocks[id])) catalog.passkeyClocks[id] = encodeHlc(0, 0, replica);
      continue;
    }
    catalog.passkeyClocks[id] = next();
    delete catalog.passkeyTombstones[id];
    catalog.sync.pending[`passkey:${id}`] = catalog.passkeyClocks[id];
    changed.push(`passkey:${id}`);
  }
  for (const id of priorKeys.keys()) {
    if (nowKeys.has(id)) continue;
    delete catalog.passkeyClocks[id];
    catalog.passkeyTombstones[id] = next();
    catalog.sync.pending[`passkey:${id}`] = catalog.passkeyTombstones[id];
    changed.push(`passkey:${id}`);
  }
  return changed;
}

// Give every record of a catalog read from disk a clock, in memory, so a
// catalog written before clocks existed merges by its updatedAt order.
export function withClocks(catalog, passkeys, replica) {
  const out = structuredClone(catalog);
  out.tombstones ||= {};
  out.passkeyClocks ||= {};
  out.passkeyTombstones ||= {};
  for (const entry of Object.values(out.entries)) if (!validHlc(entry.hlc)) entry.hlc = legacyHlc(entry, replica);
  for (const entry of passkeys || [])
    if (!validHlc(out.passkeyClocks[entry.id])) out.passkeyClocks[entry.id] = encodeHlc(0, 0, replica);
  return out;
}

// Highest clock wins. Equal clocks only happen when one write reached both
// sides (same content) or two replicas share an id; then a tombstone beats a
// live record and otherwise the larger canonical form wins, so the result
// never depends on which side was "local".
function pick(candidates) {
  let best = null;
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (!best) {best = candidate; continue;}
    const order = compareHlc(candidate.hlc, best.hlc);
    if (order > 0) best = candidate;
    else if (order === 0) {
      if (candidate.dead !== best.dead) {if (candidate.dead) best = candidate;}
      else if (canonical(candidate.body) > canonical(best.body)) best = candidate;
    }
  }
  return best;
}

const HISTORY_CAP = 5000;

// Merge two replica states. A state is {catalog, passkeys} with passkeys the
// decrypted passkey index array. Returns the merged {catalog, passkeys}; the
// result is commutative, associative and idempotent in its content. The
// caller keeps its own `sync` bookkeeping, which never replicates.
export function mergeStates(a, b) {
  const ca = a.catalog, cb = b.catalog;
  const ids = new Set([...Object.keys(ca.entries || {}), ...Object.keys(cb.entries || {}),
    ...Object.keys(ca.tombstones || {}), ...Object.keys(cb.tombstones || {})]);
  const entries = {}, tombstones = {};
  for (const id of [...ids].sort()) {
    const side = c => [
      c.entries?.[id] && {hlc: c.entries[id].hlc || '', dead: false, body: c.entries[id]},
      c.tombstones?.[id] && {hlc: c.tombstones[id].hlc, dead: true, body: c.tombstones[id]}];
    const best = pick([...side(ca), ...side(cb)]);
    if (best.dead) tombstones[id] = {...best.body};
    else entries[id] = structuredClone(best.body);
  }
  const keysA = new Map((a.passkeys || []).map(entry => [entry.id, entry]));
  const keysB = new Map((b.passkeys || []).map(entry => [entry.id, entry]));
  const keyIds = new Set([...keysA.keys(), ...keysB.keys(),
    ...Object.keys(ca.passkeyTombstones || {}), ...Object.keys(cb.passkeyTombstones || {})]);
  const passkeys = [], passkeyClocks = {}, passkeyTombstones = {};
  for (const id of [...keyIds].sort()) {
    const side = (c, keys) => [
      keys.has(id) && {hlc: c.passkeyClocks?.[id] || '', dead: false, body: keys.get(id)},
      c.passkeyTombstones?.[id] && {hlc: c.passkeyTombstones[id], dead: true, body: null}];
    const best = pick([...side(ca, keysA), ...side(cb, keysB)]);
    if (best.dead) passkeyTombstones[id] = best.hlc;
    else {passkeys.push(structuredClone(best.body)); passkeyClocks[id] = best.hlc;}
  }
  const seen = new Map();
  for (const event of [...(ca.history || []), ...(cb.history || [])]) seen.set(canonical(event), event);
  const history = [...seen.entries()]
    .sort(([ka, ea], [kb, eb]) => (ea.at === eb.at ? (ka < kb ? -1 : ka > kb ? 1 : 0) : ea.at < eb.at ? -1 : 1))
    .map(([, event]) => event).slice(-HISTORY_CAP);
  const catalog = {version: 2, crdt: 1, revision: Math.max(ca.revision || 0, cb.revision || 0),
    entries, tombstones, passkeyClocks, passkeyTombstones, history};
  return {catalog, passkeys};
}

// The replicated part of a state, for comparing two replicas: what they hold,
// not their private bookkeeping (sync queue, revision counter).
export function replicatedView({catalog, passkeys}) {
  const {sync, revision, ...rest} = catalog;
  return canonical({...rest, crdt: 1, version: 2,
    passkeys: [...(passkeys || [])].sort((x, y) => (x.id < y.id ? -1 : 1))});
}

// ---------------------------------------------------------------------------
// Device ops: the same reducer, run in his browser over the catalog it holds.
//
// A device mints ops offline (section 6 of the plan): `put` creates or edits a
// credential and its value, `meta` renames, groups, re-sites, re-notes or
// archives one, `delete` forgets one and leaves a tombstone. The page shows the
// confirmed catalog with its pending ops folded on top; the Mac applies the
// same rules to the real vault. Both sides decide by clock, so what the page
// drew before the sync is what the vault holds after it.
//
// Everything below is pure: no clock is read, no file is touched, and the
// catalog handed in is never mutated. A value stays sealed in op.sealedValue;
// nothing here opens it.

const ENTRY_ID = /^[a-z0-9][a-z0-9-]{1,100}$/;
const VALUE_NAME = /^value-[0-9a-f]{32}$/;
export const OP_KINDS = ['put', 'meta', 'delete'];
// Rename, group, website, note and archive: the metadata a device may patch.
// A value change is a `put`, because it carries ciphertext the server re-seals.
export const META_FIELDS = ['name', 'archived', 'groups', 'origins', 'notes'];

// What the catalog already holds for an id: the live entry's clock, else its
// tombstone's. An op at or below this lost the race and is superseded.
export const clockOf = (catalog, id) =>
  catalog?.entries?.[id]?.hlc || catalog?.tombstones?.[id]?.hlc || '';

// applied | superseded | rejected. Superseded is not an error: the newer write
// won, and the device drops the op. Rejected is a shape the vault would refuse
// however often it were retried, so the device keeps it out of the log.
export function classifyOp(catalog, op) {
  const bad = reason => ({status: 'rejected', reason});
  if (!op || typeof op !== 'object' || Array.isArray(op)) return bad('malformed op');
  const opId = typeof op.opId === 'string' && op.opId.length >= 3 && op.opId.length <= 200;
  if (!opId || typeof op.id !== 'string' || !ENTRY_ID.test(op.id)) return bad('malformed op');
  if (!validHlc(op.hlc) || !OP_KINDS.includes(op.kind)) return bad('malformed op');
  if (op.kind === 'put') {
    if (!VALUE_NAME.test(String(op.keyringName)) || typeof op.sealedValue !== 'string')
      return bad('malformed value');
    if (op.entry !== undefined && (!op.entry || typeof op.entry !== 'object' || Array.isArray(op.entry)))
      return bad('malformed entry');
  }
  if (op.kind === 'meta') {
    const patch = op.patch;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return bad('malformed patch');
    if (Object.keys(patch).some(field => !META_FIELDS.includes(field))) return bad('unknown field');
    if (!catalog?.entries?.[op.id]) return bad('unknown credential');
  }
  if (compareHlc(op.hlc, clockOf(catalog, op.id)) <= 0) return {status: 'superseded'};
  return {status: 'applied'};
}

// The catalog with one op folded on top. Returns the input itself when the op
// does not apply, and a fresh object when it does; the input is never changed.
export function applyOpToCatalog(catalog, op) {
  if (classifyOp(catalog, op).status !== 'applied') return catalog;
  const next = structuredClone(catalog);
  next.entries ||= {};
  next.tombstones ||= {};
  if (op.kind === 'delete') {
    const prior = next.entries[op.id];
    next.tombstones[op.id] = {hlc: op.hlc, name: prior?.name ?? op.id, kind: prior?.kind ?? 'secret'};
    delete next.entries[op.id];
    return next;
  }
  const prior = next.entries[op.id] || {};
  if (op.kind === 'meta') {
    const entry = {...prior};
    for (const field of META_FIELDS)
      if (op.patch[field] !== undefined) entry[field] = structuredClone(op.patch[field]);
    entry.archived = Boolean(entry.archived);
    entry.hlc = op.hlc;
    if (op.at) entry.updatedAt = op.at;
    next.entries[op.id] = entry;
    delete next.tombstones[op.id];
    return next;
  }
  const given = op.entry && typeof op.entry === 'object' ? op.entry : {};
  next.entries[op.id] = {...prior, id: op.id,
    name: given.name ?? prior.name ?? op.id,
    kind: given.kind ?? prior.kind ?? 'secret',
    origins: structuredClone(given.origins ?? prior.origins ?? []),
    groups: structuredClone(given.groups ?? prior.groups ?? []),
    notes: given.notes ?? prior.notes ?? '',
    archived: Boolean(given.archived ?? prior.archived ?? false),
    keyringName: op.keyringName, hlc: op.hlc,
    updatedAt: op.at ?? prior.updatedAt ?? ''};
  delete next.tombstones[op.id];
  return next;
}

// Every pending op folded over the confirmed catalog. Ops are applied in clock
// order, not log order, so the result does not depend on how the queue happens
// to be sorted and matches what the Mac will hold once the log drains.
export function foldCatalog(catalog, ops) {
  const order = (a, b) => (a.hlc === b.hlc ? (a.opId < b.opId ? -1 : a.opId > b.opId ? 1 : 0)
    : a.hlc < b.hlc ? -1 : 1);
  let out = catalog;
  for (const op of [...(ops || [])].filter(op => op && typeof op === 'object').sort(order))
    out = applyOpToCatalog(out, op);
  return out;
}

// What the list pane draws. archived:false is the ordinary view, true adds the
// archived ones (as the manager's own list does), 'only' is the archived scope.
export function vaultList(catalog, {archived = false, group = null, kind = null} = {}) {
  return Object.values(catalog?.entries || {})
    .filter(entry => (archived === 'only' ? Boolean(entry.archived) : archived || !entry.archived))
    .filter(entry => !group || (entry.groups || []).includes(group))
    .filter(entry => !kind || entry.kind === kind)
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, {sensitivity: 'base'}));
}

// The same fields /secrets searches today, so "mercury" still finds
// tophat-mercury-oauth with the server unreachable. Metadata only; a value is
// never searched, because it is ciphertext until he reveals it.
export const vaultHaystack = (entry, labels = {}) => [
  entry.name, entry.id, entry.issuer, entry.account,
  (entry.origins || []).join(' '), (entry.usernames || []).join(' '), (entry.emails || []).join(' '),
  (entry.phones || []).join(' '), (entry.groups || []).join(' '), (entry.scopes || []).join(' '),
  labels[entry.kind] || entry.kind,
].filter(Boolean).join(' ').toLowerCase();

export function vaultSearch(catalog, query, {labels = {}, ...scope} = {}) {
  const needle = String(query ?? '').trim().toLowerCase();
  const rows = vaultList(catalog, scope);
  return needle ? rows.filter(entry => vaultHaystack(entry, labels).includes(needle)) : rows;
}
