// Derived work, made safe by construction (Docstore3 A9/A11, perf doctrine rules 4 and 5).
//
// `createJobs()` runs keyed single-flight jobs with a coalesced dirty flag: while a job for a key runs, every further
// request for that key marks it dirty and gets the running promise; when it finishes, it runs once more if it was marked.
// N triggers during a run cost at most 2 runs, never N. `slice()` lets a long job give the thread back every `budgetMs`.
//
// `ledger()` is incremental accounting per partition: add on write, remove on eviction, read in O(1). A budget is
// checked against the ledger, never by scanning the data to measure it.
//
//   const jobs = createJobs()
//   const book = ledger()
//   book.add('chat-1', 2048, 1, '2026-11-08T10:00Z')
//   if (book.total() > budget) jobs.run('evict', async (tick) => { for (const p of book.oldest()) { await tick(); ... } })

export function createJobs({ clock = () => (globalThis.performance?.now?.() ?? Date.now()), yieldNow = () => new Promise((r) => setTimeout(r, 0)), budgetMs = 8 } = {}) {
  const running = new Map(); // key -> { promise, dirty }
  const stats = {};
  const statFor = (key) => (stats[key] ||= { requested: 0, runs: 0, coalesced: 0, failed: 0, slices: 0, slowestMs: 0 });

  function run(key, fn) {
    const stat = statFor(key);
    stat.requested += 1;
    const live = running.get(key);
    if (live) { live.dirty = true; stat.coalesced += 1; return live.promise; }
    const entry = { dirty: false, promise: null };
    entry.promise = (async () => {
      let result;
      try {
        do {
          entry.dirty = false;
          stat.runs += 1;
          const started = clock();
          let sliceStart = clock();
          const tick = async () => { if (clock() - sliceStart >= budgetMs) { stat.slices += 1; await yieldNow(); sliceStart = clock(); } };
          try { result = await fn(tick); } catch (cause) { stat.failed += 1; throw cause; }
          finally { stat.slowestMs = Math.max(stat.slowestMs, clock() - started); }
        } while (entry.dirty);
        return result;
      } finally { running.delete(key); }
    })();
    running.set(key, entry);
    return entry.promise;
  }

  return { run, running: (key) => running.has(key), stats: () => JSON.parse(JSON.stringify(stats)) };
}

/** Incremental accounting per partition. `time` is any sortable value (an ISO string, a number). */
export function ledger(rows = []) {
  const parts = new Map();
  let total = 0;
  let count = 0;
  for (const r of rows) { parts.set(r.id, { id: r.id, bytes: r.bytes || 0, count: r.count || 0, last: r.last ?? '' }); total += r.bytes || 0; count += r.count || 0; }
  return {
    add(id, bytes, n = 1, time = '') {
      const p = parts.get(id) || { id, bytes: 0, count: 0, last: '' };
      const next = { id, bytes: p.bytes + bytes, count: p.count + n, last: time > p.last ? time : p.last };
      parts.set(id, next);
      total += bytes; count += n;
      return next;
    },
    remove(id) {
      const p = parts.get(id);
      if (!p) return null;
      parts.delete(id);
      total -= p.bytes; count -= p.count;
      return p;
    },
    get: (id) => (parts.has(id) ? { ...parts.get(id) } : null),
    total: () => total,
    count: () => count,
    size: () => parts.size,
    rows: () => [...parts.values()].map((p) => ({ ...p })),
    /** Partitions in eviction order: outside `keepAfter` first (oldest first), then inside it (oldest first). */
    evictionOrder({ keepAfter = null, keep = () => false } = {}) {
      return [...parts.values()].filter((p) => !keep(p.id)).sort((a, b) => {
        if (keepAfter != null) { const ai = a.last >= keepAfter, bi = b.last >= keepAfter; if (ai !== bi) return ai ? 1 : -1; }
        return a.last < b.last ? -1 : a.last > b.last ? 1 : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      }).map((p) => ({ ...p, inWindow: keepAfter != null && p.last >= keepAfter }));
    }
  };
}
