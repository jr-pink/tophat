// Every repeating timer has an owner and a budget (lint rule interval-without-owner; docs/LINT.md). Registered timers are
// listable (for health), stoppable by owner, and a run over its budget is counted and backs off by doubling, up to
// 8x the period, so a slow tick cannot eat the interactive thread.
const live = new Map();

export function every(owner, ms, fn, { budgetMs, now = () => performance.now() } = {}) {
  if (!owner) throw new Error('every: owner is required');
  if (!(ms > 0)) throw new Error(`every ${owner}: period must be positive`);
  if (!(budgetMs > 0)) throw new Error(`every ${owner}: budgetMs is required (how long one tick may take)`);
  if (live.has(owner)) throw new Error(`every ${owner}: already running (one timer per owner)`);
  const t = { owner, ms, budgetMs, runs: 0, over: 0, worstMs: 0, period: ms, handle: null };
  const tick = () => {
    const start = now();
    try { fn(); } finally {
      const took = now() - start;
      t.runs++; t.worstMs = Math.max(t.worstMs, took);
      if (took > budgetMs) { t.over++; t.period = Math.min(t.period * 2, ms * 8); } else t.period = ms;
      if (live.get(owner) === t) t.handle = setTimeout(tick, t.period);
    }
  };
  t.handle = setTimeout(tick, ms);
  live.set(owner, t);
  return () => stop(owner);
}
export function stop(owner) { const t = live.get(owner); if (t) { clearTimeout(t.handle); live.delete(owner); } }
export const timers = () => [...live.values()].map(({ owner, ms, budgetMs, runs, over, worstMs, period }) => ({ owner, ms, budgetMs, runs, over, worstMs, period }));
