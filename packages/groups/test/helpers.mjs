// Test helpers: deterministic stand-ins for the model calls, actors with keys and clocks, note makers.
import { Clock, keypair } from '../index.mjs';

/** A generate() that records every part it is asked for and answers deterministically. */
export function stubGenerate() {
  const calls = [];
  const fn = async (part) => {
    calls.push(part);
    if (part.kind === 'leaf') return `[${part.path}] ${part.notes.map((n) => n.id).join(' ')}`;
    if (part.kind === 'rollup') return `[${part.path}] ${part.children.length} parts`;
    return `status: ${part.notes.length} newest`;
  };
  fn.calls = calls;
  fn.paths = (kind) => calls.filter((c) => !kind || c.kind === kind).map((c) => c.path);
  return fn;
}

/** A rankFacets() stub: tier and weight from a table (facet id -> [tier, weight]); others 'detail', weight 1. */
export const stubRank = (table = {}) => (cands) => cands.map((c) => ({ id: c.id, tier: table[c.id]?.[0] ?? 'detail', weight: table[c.id]?.[1] ?? 1, reason: `stub for ${c.noteCount} notes` }));

/** Named actors with Ed25519 keys and a shared fake wall clock (milliseconds advance only when told). */
export function actors(names, { wall = { t: 1_700_000_000_000 } } = {}) {
  const out = {};
  for (const n of names) { const k = keypair(); out[n] = { name: n, ...k, clock: new Clock(n, () => wall.t) }; }
  out.publicKeyOf = (a) => out[a]?.publicKey ?? null;
  out.wall = wall;
  return out;
}

let seq = 0;
/** A note on `entity` co-linking `others`, in `scopes`, at an ISO date. */
export function note(entity, others, scopes, at, id = null) {
  seq++;
  return { id: id ?? `n${String(seq).padStart(5, '0')}`, at, body: `fact ${seq}`, entities: [entity, ...others], scopes };
}

/** A deterministic PRNG (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  const r = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  r.int = (n) => Math.floor(r() * n);
  r.pick = (xs) => xs[r.int(xs.length)];
  return r;
}
