// Keys, audiences, clocks and signatures: the pure pieces every other part of the package builds on.
import crypto from 'node:crypto';

/** JSON with object keys sorted at every level, so equal values hash equally. */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const sortedIds = (ids) => [...new Set(ids)].sort();

/**
 * The key of a page node: sha256 over the entity, the generator version, the node's place in the outline (path, '' for
 * the root) and the sorted note ids it rests on. Two viewers whose notes under a node are the same get the same key,
 * whatever else either of them can read; one note more or less anywhere below changes it, and so every ancestor's.
 */
export function nodeKey(entity, noteIds, generatorVersion, path = '') {
  return sha256(canonical(['pagenode-v1', String(entity), String(generatorVersion), String(path), sortedIds(noteIds)]));
}

/**
 * The audience of a record resting on `noteIds`: the groups that contain every one of those notes (the intersection of
 * their scope sets), sorted. `scopesOf(id)` returns a note's groups (an array or Set). No notes -> [] (nothing to share).
 */
export function audience(noteIds, scopesOf) {
  const ids = sortedIds(noteIds);
  if (!ids.length) return [];
  let acc = null;
  for (const id of ids) {
    const s = new Set(scopesOf(id) || []);
    acc = acc ? new Set([...acc].filter((g) => s.has(g))) : s;
    if (!acc.size) return [];
  }
  return [...acc].sort();
}

/**
 * Hybrid logical clock. Timestamps are strings that sort in time order: 15-digit wall milliseconds, '.', 6-digit
 * counter, '.', node id. tick() for a local event, observe(at) after receiving a remote timestamp.
 */
export class Clock {
  constructor(node, wall = () => Date.now()) { this.node = String(node); this.wall = wall; this.ms = 0; this.c = 0; }
  static parse(at) { const [ms, c, ...node] = String(at).split('.'); return { ms: Number(ms), c: Number(c), node: node.join('.') }; }
  format() { return `${String(this.ms).padStart(15, '0')}.${String(this.c).padStart(6, '0')}.${this.node}`; }
  tick() { const w = this.wall(); if (w > this.ms) { this.ms = w; this.c = 0; } else this.c++; return this.format(); }
  observe(at) {
    const r = Clock.parse(at), w = this.wall();
    const ms = Math.max(w, this.ms, r.ms);
    this.c = ms === this.ms && ms === r.ms ? Math.max(this.c, r.c) + 1 : ms === this.ms ? this.c + 1 : ms === r.ms ? r.c + 1 : 0;
    this.ms = ms;
    return this.format();
  }
}

/** An Ed25519 key pair as PEM strings. */
export function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { publicKey: publicKey.export({ type: 'spki', format: 'pem' }), privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}
const body = (record) => { const { sig, ...rest } = record; return Buffer.from(canonical(rest)); };
/** The record with `sig` over every other field. */
export function sign(record, privateKey) { return { ...record, sig: crypto.sign(null, body(record), privateKey).toString('base64') }; }
/** True when `sig` verifies under `publicKey`; false on any malformed input. */
export function verify(record, publicKey) {
  try { return !!publicKey && typeof record?.sig === 'string' && crypto.verify(null, body(record), publicKey, Buffer.from(record.sig, 'base64')); }
  catch { return false; }
}
/** A stable hash of a record (signature excluded), the tiebreak after the clock. */
export const recordHash = (record) => sha256(body(record).toString());
