// fuzz: seeded generators and a differential check, old twin vs new.
// Why: every rev6 pure function with an old twin (parsers, decoders, terms,
// ranking, reducers, merges, exit codes) must give equal output on the same
// generated inputs, or a listed, intended difference. Seeded, so a reported
// failure replays exactly; no dependencies.
import {isDeepStrictEqual} from 'node:util';

/** mulberry32: small, fast, deterministic. */
export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const POOLS = [
  'abcdefghijklmnopqrstuvwxyz ', 'ABCXYZ0123456789', ' \t\n\r', '.,;:!?"\'`-_/\\|<>[]{}()#*$%&@~^=+',
  'éüßøåçñ', '中文日本語한국어', 'ابجدעברית', 'Ⅻ①ﬁ\u00a0\u200b\u200d\ufeff\u0301',
];
const EMOJI = ['😀', '👍🏽', '👨‍👩‍👧', '🇺🇸', '❤️', '🧪'];

export function makeGen(seed = 1) {
  const r = rng(seed);
  const int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  const pick = (xs) => xs[int(0, xs.length - 1)];
  const g = {
    r, int, pick,
    bool: () => r() < 0.5,
    /** Strings mixing ASCII, scripts, combining marks, emoji and (sometimes) lone surrogates. */
    string(max = 24) {
      let s = '';
      for (let i = int(0, max); i > 0; i--) {
        const x = r();
        if (x < 0.08) s += pick(EMOJI);
        else if (x < 0.11) s += String.fromCharCode(int(0xD800, 0xDFFF)); // lone surrogate
        else { const p = pick(POOLS); s += [...p][int(0, [...p].length - 1)]; }
      }
      return s;
    },
    number() {
      const x = r();
      if (x < 0.1) return pick([0, -0, 1, -1, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER, Number.MIN_VALUE, 2 ** 53 + 1]);
      if (x < 0.5) return int(-1000, 1000);
      return (r() - 0.5) * 10 ** int(-6, 12);
    },
    /** ISO instants incl. leap days, offsets, millis and the epoch edges; some invalid on purpose. */
    isoDate() {
      const x = r();
      if (x < 0.1) return pick(['1970-01-01T00:00:00.000Z', '2024-02-29T23:59:59.999Z', '2026-03-08T10:00:00Z', '2026-11-01T08:59:59-08:00', '9999-12-31T23:59:59Z', '2026-02-30T00:00:00Z', '']);
      const d = new Date(int(0, 4102444800) * 1000 + int(0, 999));
      const iso = d.toISOString();
      if (x < 0.3) return iso.replace('.000Z', 'Z');
      if (x < 0.4) return iso.replace('Z', pick(['+00:00', '-07:00', '+05:30']));
      return iso;
    },
    /** Nested JSON-compatible values (finite numbers only, so JSON round-trips). */
    json(depth = 3) {
      const x = r();
      if (depth <= 0 || x < 0.35) return pick([() => null, () => g.bool(), () => g.string(), () => { const n = g.number(); return Number.isFinite(n) ? n : 0; }])();
      if (x < 0.65) return Array.from({length: int(0, 4)}, () => g.json(depth - 1));
      return Object.fromEntries(Array.from({length: int(0, 4)}, () => [g.string(8), g.json(depth - 1)]));
    },
  };
  return g;
}

const outcome = (fn, input) => {
  try { const v = fn(input); return v && typeof v.then === 'function' ? {promise: v} : {value: v}; }
  catch (e) { return {threw: e?.name ?? String(e)}; }
};
const settle = async (o) => { if (!o.promise) return o; try { return {value: await o.promise}; } catch (e) { return {threw: e?.name ?? String(e)}; } };

/**
 * Feed oldFn and newFn the same n generated inputs. gen(g, i) builds input i
 * from a seeded generator. allow(input, old, new) marks an intended difference.
 * Reports the first `max` differing inputs (outcomes compared by deep equality;
 * a throw matches a throw of the same error name).
 */
export async function differential(oldFn, newFn, gen, {n = 200, seed = 1, allow = () => false, eq = isDeepStrictEqual, max = 5} = {}) {
  const g = makeGen(seed), diffs = []; let allowed = 0;
  for (let i = 0; i < n && diffs.length < max; i++) {
    const input = gen(g, i);
    const a = await settle(outcome(oldFn, input)), b = await settle(outcome(newFn, input));
    if (eq(a, b)) continue;
    if (allow(input, a, b)) { allowed++; continue; }
    diffs.push({i, input, old: a, new: b});
  }
  return {ok: diffs.length === 0, n, seed, allowed, diffs};
}
