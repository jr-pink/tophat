// The telemetry lane (DOCSTORE3-DESIGN.md A9, perf doctrine rule 3): bounded by items and bytes, drop-oldest,
// counted. Laws (tests/engine.laws.test.js): depth never exceeds the bound, the newest record survives, and pushing
// any amount of telemetry never changes what the outbox holds.
//
//   const lane = createTelemetryLane({ maxItems: 500, send: (records) => fetch('/lag', { method: 'POST', body: JSON.stringify({ records }) }) })
//   lane.push({ kind: 'longtask', durationMs: 120 })            // never blocks, never throws, never waits
// It shares no queue, lock, timer or IndexedDB store with the durable outbox; it is memory only
// (losing telemetry on a crash is the policy) and flushes on its own timer with its own deadline.

export function createTelemetryLane({ maxItems = 500, maxBytes = 256_000, send, flushEveryMs = 30_000, batch = 50,
  setTimer = setTimeout, clearTimer = clearTimeout, sizeOf = approxSize } = {}) {
  const queue = [];
  let bytes = 0;
  let timer = null;
  let sending = false;
  const counts = { accepted: 0, dropped: 0, sent: 0, failed: 0 };

  function push(record) {
    const size = sizeOf(record);
    if (size > maxBytes) { counts.dropped += 1; return false; }
    queue.push({ record, size });
    bytes += size;
    counts.accepted += 1;
    while (queue.length > maxItems || bytes > maxBytes) {
      const old = queue.shift();
      bytes -= old.size;
      counts.dropped += 1;
    }
    arm();
    return true;
  }

  function arm() {
    if (timer || !send) return;
    timer = setTimer(() => { timer = null; flush(); }, flushEveryMs);
    timer?.unref?.();
  }

  async function flush() {
    if (sending || !queue.length || !send) return;
    sending = true;
    const taken = queue.splice(0, batch);
    for (const t of taken) bytes -= t.size;
    try {
      await send(taken.map((t) => t.record));
      counts.sent += taken.length;
    } catch {
      // Telemetry is never retried at the cost of anything else: the batch is gone and counted.
      counts.failed += taken.length;
      counts.dropped += taken.length;
    } finally {
      sending = false;
      if (queue.length) arm();
    }
  }

  function stop() { clearTimer(timer); timer = null; }

  return { push, flush, stop, depth: () => queue.length, bytes: () => bytes, counts: () => ({ ...counts, depth: queue.length, bytes }) };
}

/** A cheap size estimate: string lengths plus a constant per value; never JSON.stringify of a big object. */
export function approxSize(value, depth = 0) {
  if (value == null) return 4;
  switch (typeof value) {
    case 'string': return value.length + 2;
    case 'number': case 'boolean': return 8;
    case 'object': {
      if (depth > 4) return 16;
      let total = 2;
      if (Array.isArray(value)) { for (const v of value) total += approxSize(v, depth + 1) + 1; return total; }
      for (const k in value) total += k.length + 3 + approxSize(value[k], depth + 1);
      return total;
    }
    default: return 8;
  }
}
