// The copy of the document the browser keeps, so opening the notes app is a paint and not a round
// trip. offline first, crdt, etc.
//
// Two things live here, both on the client's own disk:
//
// 1. The snapshot: the present and a peek either side, written after the document settles. A cold
//    open reads it, renders it, and scrolls to the present before a single request is made.
// 2. The outbox: writes he made that the server has not acknowledged. It is localStorage, read
//    folded over the snapshot at open and sent again as soon as there is a server to send to.
//
// Neither is a second source of truth. The snapshot is replaced by whatever the server says about
// the same block ids, and an outbox entry is dropped the moment its write is acknowledged.

const DB_NAME = 'tophat-notes';
const DB_VERSION = 1;
const STORE = 'document';
// One device can hold his notes and any number of public documents (src/routes/docs), each with
// its own snapshot, outbox and week. The scope is '' for his notes, which keeps every key exactly
// as it was, and `doc:<token>` for a document; the editor sets it before it reads anything.
let scope = '';
export function setNotesCacheScope(next = '') { scope = String(next || ''); }
export const notesCacheScope = () => scope;
const scoped = (key, sep) => (scope ? `${key}${sep}${scope}` : key);
const SNAPSHOT_KEY_BASE = 'present';
const OUTBOX_KEY_BASE = 'tophat.notes.outbox';
// The kit's name for an outbox key (`qk-outbox:<what>`; localOutbox, mp-outbox and the dictation outbox use it). The notes
// outbox now lives here, and during the rollback window (the cutover to the engine client until the owner closes it) every write
// goes to BOTH keys in the same op shape, so a rolled-back build, which reads only `tophat.notes.outbox`, finds exactly what
// is still unsent. Set false to stop mirroring when the window closes; the old key is then archived by hand, never read again.
const OUTBOX_KEY_NEW_BASE = 'qk-outbox:notes';
export const NOTES_OUTBOX_MIRROR_LEGACY = true;
const OUTBOX_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

const promisify = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

export function openNotesCache(indexedDBImpl = globalThis.indexedDB) {
  if (!indexedDBImpl) return Promise.resolve(null);
  return new Promise((resolve) => {
    let request;
    try { request = indexedDBImpl.open(DB_NAME, DB_VERSION); }
    catch { resolve(null); return; }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

/** What the last session left on disk, or null. Never throws: a cold open must not depend on it. */
export async function readSnapshot(indexedDBImpl = globalThis.indexedDB) {
  try {
    const db = await openNotesCache(indexedDBImpl);
    if (!db) return null;
    const tx = db.transaction(STORE, 'readonly');
    const value = await promisify(tx.objectStore(STORE).get(scoped(SNAPSHOT_KEY_BASE, '@')));
    db.close();
    return value && Array.isArray(value.blocks) ? value : null;
  } catch { return null; }
}

/** Plain data for IndexedDB. The page keeps its blocks in Svelte state, which hands out proxies, and
 * a structured clone refuses a proxy (DataCloneError). That was thrown inside the try below and
 * swallowed, so the snapshot was never written at all and every open waited for the network.
 */
export const plain = (value) => JSON.parse(JSON.stringify(value));

export async function writeSnapshot(snapshot, indexedDBImpl = globalThis.indexedDB) {
  try {
    const data = plain({ ...snapshot, at: Date.now() });
    const db = await openNotesCache(indexedDBImpl);
    if (!db) return false;
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(data, scoped(SNAPSHOT_KEY_BASE, '@'));
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    db.close();
    return true;
  } catch { return false; }
}

export async function clearSnapshot(indexedDBImpl = globalThis.indexedDB) {
  try {
    const db = await openNotesCache(indexedDBImpl);
    if (!db) return false;
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(scoped(SNAPSHOT_KEY_BASE, '@'));
    db.close();
    return true;
  } catch { return false; }
}

// --- the outbox ------------------------------------------------------------------------------

const readKey = (storage, key) => {
  try {
    const parsed = JSON.parse(storage?.getItem(key) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
};

/**
 * Unsent writes: the new key and, while the rollback window is open, the old one, one entry per block. A write only the old
 * key holds was made by a rolled-back build; one only the new key holds is kept too (the old build may have lost the mirror
 * to a full disk), because a resend of a write the store already has is counted once by its `opId`/`sentIds`, while a dropped
 * one is words lost. When both hold a block the newer write (`at`) wins, the new key on a tie.
 */
export function readOutbox(storage = globalThis.localStorage) {
  const cutoff = Date.now() - OUTBOX_MAX_AGE_MS;
  const byId = new Map();
  const take = (op) => {
    if (!op || !op.id || !((op.at || 0) > cutoff)) return;
    const prior = byId.get(op.id);
    if (!prior || (op.at || 0) > (prior.at || 0)) byId.set(op.id, op);
  };
  readKey(storage, scoped(OUTBOX_KEY_NEW_BASE, ':')).forEach(take);
  if (NOTES_OUTBOX_MIRROR_LEGACY) readKey(storage, scoped(OUTBOX_KEY_BASE, '.')).forEach(take);
  return [...byId.values()];
}

const putKey = (storage, key, ops) => {
  if (!ops.length) storage.removeItem(key);
  else storage.setItem(key, JSON.stringify(ops));
};

/** Replaces the outbox: the new key first, then the mirror. False only when the new key could not be written. */
export function writeOutbox(ops, storage = globalThis.localStorage) {
  try {
    if (!storage) return false;
    putKey(storage, scoped(OUTBOX_KEY_NEW_BASE, ':'), ops || []);
  } catch { return false; }
  if (NOTES_OUTBOX_MIRROR_LEGACY) {
    try { putKey(storage, scoped(OUTBOX_KEY_BASE, '.'), ops || []); } catch { /* the new key holds it; the mirror retries on the next write */ }
  }
  return true;
}

/**
 * One unsent write per block, newest wins: the body he is typing supersedes the one before it.
 * `base` is the exception: the line ids the block had when this device last agreed with the
 * server, taken from the FIRST unsent write and kept until one is acknowledged. The store reads
 * it to tell a line this device deleted from one another device added meanwhile (notes-store.js
 * `mergeConcurrent`), which is what lets two devices edit one block offline without either
 * device's new lines being archived by the other's write.
 */
export function rememberOps(entries, storage = globalThis.localStorage) {
  const ops = readOutbox(storage);
  const byId = new Map(ops.map((op) => [op.id, op]));
  for (const entry of entries) {
    const prior = byId.get(entry.id);
    // A write superseding one still unacknowledged keeps that one's base, plus every row that
    // write itself carried: rows this device wrote are rows it has seen. Without them a line made
    // by the first write and dropped by the second (two edits inside one round trip) looked like
    // another device's line, and the store kept it.
    const own = (prior?.block?.lines || []).map((line) => line?.id).filter(Boolean);
    const base = prior && Array.isArray(prior.base) ? [...new Set([...prior.base, ...own])] : entry.base;
    // The words the store held, line by line, when these edits began (kept from the first unsent
    // write, like `base`): the common ancestor the store merges a concurrent change against.
    const baseLines = prior ? prior.baseLines : entry.baseLines;
    // The block's own position and chat link when the edits began, for the same reason: a write
    // names them only if this device changed them, so a stale copy never undoes a move or a chat
    // another device made.
    const baseFields = prior ? prior.baseFields : entry.baseFields;
    // `opId` names this version of the write; `sentIds` are the earlier versions that left without
    // an answer, which the store may or may not have applied. Together they make a resend count once.
    const sentIds = prior?.sentIds?.length ? prior.sentIds : undefined;
    // `n` counts the writes to this block since it was last acknowledged, so an answer to an
    // earlier send can tell it apart from words typed while that send was on the wire.
    byId.set(entry.id, {
      ...entry, ...(Array.isArray(base) ? { base } : {}), ...(Array.isArray(baseLines) ? { baseLines } : {}), ...(baseFields ? { baseFields } : {}),
      ...(sentIds ? { sentIds } : {}), opId: newOpId(), n: (prior?.n || 0) + 1, at: Date.now()
    });
  }
  const next = [...byId.values()];
  writeOutbox(next, storage);
  return next;
}

/**
 * The store acknowledged a write. Without `sent` every op for these blocks goes. With it (block id
 * -> the op's `n` when the write left), an op written again since stays: it holds words the store
 * has not heard. Its base becomes `agreed[id]`, the rows the store answered with, since this device
 * has now seen exactly those.
 */
export function forgetOps(ids, storage = globalThis.localStorage, { sent = null, agreed = {}, agreedLines = {}, agreedFields = {} } = {}) {
  const drop = new Set(ids);
  const next = [];
  for (const op of readOutbox(storage)) {
    if (!drop.has(op.id)) { next.push(op); continue; }
    if (!sent || op.n === sent[op.id]) continue;
    // Typed since the send: what is left is judged against the lines the store answered with, and
    // every earlier version has been answered.
    const { sentIds, ...rest } = op;
    next.push({ ...rest, opId: newOpId(), ...(Array.isArray(agreed[op.id]) ? { base: agreed[op.id] } : {}), ...(Array.isArray(agreedLines[op.id]) ? { baseLines: agreedLines[op.id] } : {}), ...(agreedFields[op.id] ? { baseFields: agreedFields[op.id] } : {}) });
  }
  writeOutbox(next, storage);
  return next;
}

/** A removal takes the block out; a body replaces the one on disk. */
export function applyOutbox(blocks, ops) {
  if (!ops?.length) return blocks;
  const removed = new Set(ops.filter((op) => op.remove).map((op) => op.id));
  const writes = new Map(ops.filter((op) => !op.remove).map((op) => [op.id, op]));
  const out = [];
  for (const block of blocks) {
    if (removed.has(block.id)) continue;
    const op = writes.get(block.id);
    if (!op) { out.push(block); continue; }
    writes.delete(block.id);
    out.push({ ...block, ...op.block, _pending: true });
  }
  for (const op of writes.values()) if (op.block) out.push({ ...op.block, _pending: true, _local: true });
  return out;
}

let opCounter = 0;
/** A fresh id for one version of a write: unique across tabs and reloads. */
export function newOpId() {
  opCounter += 1;
  const random = globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  return `op-${random}-${opCounter}`;
}

/** The lines (id, words, age) the store held when a block's unsent edits began, or null. */
export function baseLinesOf(id, storage = globalThis.localStorage) {
  const op = readOutbox(storage).find((entry) => entry.id === id);
  return op && Array.isArray(op.baseLines) ? op.baseLines : null;
}

/** The lines and block fields unsent edits to this block began from, or null when there are none. */
export function baseStateOf(id, storage = globalThis.localStorage) {
  const op = readOutbox(storage).find((entry) => entry.id === id);
  return op && Array.isArray(op.baseLines) ? { lines: op.baseLines, fields: op.baseFields || null } : null;
}

/** Whether a version of this block's write has left without an answer: the store may have it. */
export function unanswered(id, storage = globalThis.localStorage) {
  const op = readOutbox(storage).find((entry) => entry.id === id);
  return Boolean(op?.sentIds?.length);
}

/**
 * A write is leaving. Returns what the store needs to merge it and to count it once, and records
 * that this version has left, before it does, so a crash between the send and the answer still
 * resends it as a superseding write.
 */
export function markSent(id, storage = globalThis.localStorage) {
  const ops = readOutbox(storage);
  const op = ops.find((entry) => entry.id === id);
  if (!op) return null;
  // A version that has left before goes out under a new id, naming the old one: what the store
  // received then may be older than what this version holds now, and must not stand in for it.
  if ((op.sentIds || []).includes(op.opId)) op.opId = newOpId();
  const out = { opId: op.opId, supersedes: [...(op.sentIds || [])], baseLines: Array.isArray(op.baseLines) ? op.baseLines : null, baseFields: op.baseFields || null };
  op.sentIds = [...(op.sentIds || []), op.opId];
  writeOutbox(ops, storage);
  return out;
}

/** The store's lines are now what unsent edits to these blocks are judged against. */
export function rebaseOps(baseByBlock, storage = globalThis.localStorage) {
  const ops = readOutbox(storage);
  let changed = false;
  for (const op of ops) {
    const next = baseByBlock[op.id];
    if (Array.isArray(next)) { op.baseLines = next; changed = true; }
    else if (next && Array.isArray(next.lines)) { op.baseLines = next.lines; if (next.fields) op.baseFields = next.fields; changed = true; }
  }
  if (changed) writeOutbox(ops, storage);
}

/** The base line ids recorded for a block's unsent write, or null. */
export function baseOf(id, storage = globalThis.localStorage) {
  const op = readOutbox(storage).find((entry) => entry.id === id);
  return op && Array.isArray(op.base) ? op.base : null;
}

/**
 * Unsent writes worth sending. A block this device created and never got onto the server, and
 * that is still empty, is the scaffolding the page makes on open (the tail gap, the today block):
 * replaying it after a few offline opens would put one empty block per open into the document.
 */
export function replayable(ops, knownIds = new Set()) {
  return (ops || []).filter((op) => op.remove || knownIds.has(op.id) || String(op.block?.body ?? '').trim() !== '');
}

// --- the week ---------------------------------------------------------------------------------
// The past, a week deep, kept apart from the snapshot: the snapshot paints a cold open and holds
// only a peek of history so the present lands at the top, while this is what he scrolls up into
// when the server cannot page the past for him. Written by a background walk while online.

const WEEK_KEY_BASE = 'past-week';

export async function readWeek(indexedDBImpl = globalThis.indexedDB) {
  try {
    const db = await openNotesCache(indexedDBImpl);
    if (!db) return null;
    const tx = db.transaction(STORE, 'readonly');
    const value = await promisify(tx.objectStore(STORE).get(scoped(WEEK_KEY_BASE, '@')));
    db.close();
    return value && Array.isArray(value.blocks) ? value : null;
  } catch { return null; }
}

export async function writeWeek(week, indexedDBImpl = globalThis.indexedDB) {
  try {
    const data = plain({ ...week, at: Date.now() });
    const db = await openNotesCache(indexedDBImpl);
    if (!db) return false;
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(data, scoped(WEEK_KEY_BASE, '@'));
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    db.close();
    return true;
  } catch { return false; }
}

const DAY_MS = 24 * 60 * 60_000;

/** Whether a past page reached back past the window: its oldest block is older than `days`. */
export function reachedBack(blocks, { now = Date.now(), days = 7 } = {}) {
  const cutoff = now - days * DAY_MS;
  return (blocks || []).some((block) => {
    const at = Date.parse(block.createdAt || block.updatedAt || '');
    return Number.isFinite(at) && at < cutoff;
  });
}

/** Thrown by the notes page's fetch wrapper when the far end is not the app. */
export class NotesOffline extends Error {
  constructor(message = 'offline') { super(message); this.name = 'NotesOffline'; }
}

const GATEWAY = new Set([502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 530]);
/** A response the app did not write: a gateway status, or a body that is not JSON. */
export function notFromApp(response) {
  if (!response) return true;
  if (GATEWAY.has(response.status)) return true;
  const type = response.headers?.get?.('content-type') || '';
  return Boolean(type) && !type.includes('json');
}
