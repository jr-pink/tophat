// PageNode: a derived page node (a published subtree of an entity's page), replicated through the same log as notes but
// never a note and never evidence. The record shape, its key and its signature are those of the groups package: canonical
// JSON with sorted keys, nodeKey over ['pagenode-v1', entity, generatorVersion, path, sorted unique note ids], Ed25519
// over the canonical bytes of every field but `sig`. The algorithms here must stay byte-identical to that package;
// test/pagenode.test.mjs pins them with vectors.
import crypto from 'node:crypto';

export const RECORD_TYPE = 'PageNode';
/** Every field a PageNode record may carry; anything else is refused (nothing rides along unsigned or unchecked). */
export const FIELDS = ['type', 'entity', 'path', 'key', 'text', 'citedNoteIds', 'childKeys', 'facetList', 'generatorVersion', 'author', 'at', 'sig'];
/** Hybrid-logical-clock stamp: 15-digit wall milliseconds, '.', 6-digit counter, '.', node id. Sorts in time order. */
export const HLC = /^\d{15}\.\d{6}\..+$/;

/** JSON with object keys sorted at every level, so equal values hash equally. */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}
export const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
const sortedIds = (ids) => [...new Set(ids)].sort();

/** The key of a page node: equal notes under a node give equal keys, whatever else either viewer reads. */
export function nodeKey(entity, noteIds, generatorVersion, path = '') {
  return sha256hex(canonical(['pagenode-v1', String(entity), String(generatorVersion), String(path), sortedIds(noteIds)]));
}
const body = (record) => { const { sig, ...rest } = record; return Buffer.from(canonical(rest)); };
/** True when `sig` verifies under `publicKey` (PEM); false on any malformed input. */
export function verify(record, publicKey) {
  try { return !!publicKey && typeof record?.sig === 'string' && crypto.verify(null, body(record), publicKey, Buffer.from(record.sig, 'base64')); }
  catch { return false; }
}
/** A stable hash of a record, signature excluded (the groups package's tiebreak after the clock). */
export const recordHash = (record) => sha256hex(body(record).toString());
/** The stored id of a record: sha256 of its canonical bytes, signature included (two signatures are two records). */
export const pageNodeId = (record) => sha256hex(canonical(record));

const isStr = (x) => typeof x === 'string';
/** Why `record` is not a well-formed signed PageNode (null when it is). Signature checked only when `publicKey` is given. */
export function pageNodeError(record, { publicKey = null } = {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return 'not an object';
  if (record.type !== RECORD_TYPE) return `type must be ${RECORD_TYPE}`;
  const extra = Object.keys(record).filter((k) => !FIELDS.includes(k));
  if (extra.length) return `unknown fields ${extra.join(', ')}`;
  for (const k of ['entity', 'path', 'key', 'text', 'generatorVersion', 'author', 'at', 'sig']) if (!isStr(record[k])) return `${k} must be a string`;
  if (!record.entity || !record.author || !record.generatorVersion) return 'entity, author and generatorVersion must be non-empty';
  if (!HLC.test(record.at)) return 'at must be a hybrid-logical-clock stamp';
  if (!Array.isArray(record.citedNoteIds) || !record.citedNoteIds.length || !record.citedNoteIds.every((x) => isStr(x) && x)) return 'citedNoteIds must be a non-empty list of note ids';
  if (!Array.isArray(record.childKeys) || !record.childKeys.every(isStr)) return 'childKeys must be a list of keys';
  if (!Array.isArray(record.facetList)) return 'facetList must be a list';
  if (nodeKey(record.entity, record.citedNoteIds, record.generatorVersion, record.path) !== record.key) return 'cited notes do not hash to the key';
  if (publicKey && !verify(record, publicKey)) return 'signature does not verify';
  return null;
}

/** The row stored for a record (table mc_pagenodes). */
export function pageNodeRow(record) {
  return { id: pageNodeId(record), entity: record.entity, key: record.key, path: record.path, at: record.at, author: record.author, cited: JSON.stringify(sortedIds(record.citedNoteIds)), record: canonical(record) };
}
/** True when a replicated row image is a consistent PageNode row (its id, columns and key all follow from its record). */
export function validPageNodeRow(img) {
  let record;
  try { record = JSON.parse(img?.record); } catch { return false; }
  if (pageNodeError(record)) return false;
  const want = pageNodeRow(record);
  return Object.keys(want).every((k) => img[k] === want[k]);
}
