// Hybrid logical clock: the kit's one order source (DOCSTORE3-DESIGN A8 "Order is logical, not wall-clock"; conformance
// row #8). Every timestamp an engine writes into a log entry (model.js) or a field stamp (engine/rows.js) is minted
// here, never read raw from Date.now().
//
// A time is { ts, l }: ts is milliseconds (the wall clock as this replica best knows it, never going backwards), l a
// logical counter that orders events within one ts. Rules:
//   tick()        a local event: ts = max(wall, last.ts); l = 0 when ts moved forward, else last.l + 1. Strictly later
//                 than every time this clock issued or observed.
//   observe(t)    a remote or stored time was seen (ingest, a row read from disk, a pending entry restored): the clock
//                 takes the max, so the next tick() is strictly later than it. Two devices whose clocks disagree by
//                 30 s still order "B edited after seeing A's write" after A's write (census A26: a device whose clock
//                 ran behind could not overwrite a value from a device whose clock ran ahead).
//   compare(a, b) total order on { ts, l }; ties are broken by the caller (device id, then device seq).
// Wall time stays a display hint: ts is close to the wall clock while no clock is skewed, and runs ahead of it by at
// most the largest skew observed, never behind.

export const L_PAD = 6; // base36 digits of l in a row stamp

/** createHlc({ now, last }) -> { tick, observe, peek }. `last` restores a persisted { ts, l } (so a reload never
 *  re-issues a time). `now` is the wall clock (injectable for tests). */
export function createHlc({ now = () => Date.now(), last = null } = {}) {
  let ts = Number.isFinite(last?.ts) ? last.ts : 0, l = Number.isFinite(last?.l) ? last.l : 0;
  return {
    tick() {
      const wall = Math.floor(now());
      if (Number.isFinite(wall) && wall > ts) { ts = wall; l = 0; } else l += 1;
      return { ts, l };
    },
    observe(t) {
      if (!t || !Number.isFinite(t.ts)) return;
      const tl = Number.isFinite(t.l) ? t.l : 0;
      if (t.ts > ts || (t.ts === ts && tl > l)) { ts = t.ts; l = tl; }
    },
    /** The latest time issued or observed (persist it with the log). */
    peek: () => ({ ts, l }),
  };
}

/** Total order on HLC times. */
export const compareHlc = (a, b) => (a.ts - b.ts) || ((a.l || 0) - (b.l || 0));
