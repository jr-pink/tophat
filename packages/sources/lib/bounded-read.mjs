// Every producer in this directory reads several independent units: three call
// history databases, two photo libraries, a directory of health exports, a
// queue of papers. Three things go wrong when that loop is written by hand, and
// all three have happened in the legacy system, so the loop is written once
// here.
//
// A unit that answered nothing gets reported as a unit that could not be read,
// or the other way round. A revoked Full Disk Access grant then looks exactly
// like a Mac that has never made a phone call, and there is nothing in the
// output to tell the two apart.
//
// One bare `await` in a loop means the first failing unit aborts the units
// behind it, so one dead source costs the whole cycle instead of costing
// itself.
//
// And a loop that awaits each unit in turn spends one slow unit's wait out of
// every later unit's budget, because the deadline is a ceiling on the whole
// read rather than on any one unit. Four units behind a unit that hangs are
// reported as deadline failures without ever having been tried, which reads
// from the outside exactly like four broken sources. So the units are read
// concurrently, a few at a time.
//
// Each unit is awaited in its own try/catch, against a deadline, and lands in
// exactly one of three lists: carried, quiet, unreadable. A unit that blows the
// deadline is unreadable with a named code, never quiet. The deadline stops
// this module waiting; it cannot cancel a read already in flight, so a unit's
// own read is expected to bound itself too.

const coded = code => {
  const error = new Error(code);
  error.code = code;
  return error;
};

function expire(ms, code) {
  let timer;
  const promise = new Promise((_, reject) => { timer = setTimeout(() => reject(coded(code)), ms); });
  return { promise, cancel: () => clearTimeout(timer) };
}

export const DEFAULT_DEADLINE_MS = 20000;

// A few at a time rather than all at once. These units are sqlite files, photo
// libraries and network fetches, so a queue of two hundred papers opened in one
// breath is its own failure; the point of the pool is that a hang costs the
// units sharing its worker and no others.
export const DEFAULT_CONCURRENCY = 4;

/**
 * Read one unit against the budget it was handed. Returns the outcome rather
 * than pushing anywhere, so the caller can classify in the order the units were
 * given whatever order they happen to finish in.
 */
async function readUnit(unit, remainingMs) {
  if (remainingMs <= 0) return { unit: unit.id, kind: 'unreadable', code: 'producer-deadline-exceeded' };
  const limit = expire(remainingMs, 'unit-deadline-exceeded');
  try {
    const reading = Promise.resolve().then(() => unit.read());
    reading.catch(() => {});
    const rows = await Promise.race([reading, limit.promise]);
    if (!Array.isArray(rows)) throw coded('invalid-unit-result');
    return rows.length
      ? { unit: unit.id, kind: 'carried', rows }
      : { unit: unit.id, kind: 'quiet' };
  } catch (error) {
    return { unit: unit.id, kind: 'unreadable', code: error?.code ?? 'unit-read-failed' };
  } finally {
    limit.cancel();
  }
}

export async function readUnits(units, {
  deadlineMs = DEFAULT_DEADLINE_MS,
  clock = Date.now,
  concurrency = DEFAULT_CONCURRENCY,
} = {}) {
  const started = clock();
  const outcomes = new Array(units.length);
  let next = 0;

  // Each worker takes the next unit and hands it what is left of the shared
  // budget, so a unit that starts after the deadline has already passed is named
  // rather than dropped, and a unit still in flight at the deadline fails on its
  // own limit. Either way the whole read is bounded by `deadlineMs`.
  const worker = async () => {
    while (next < units.length) {
      const index = next++;
      outcomes[index] = await readUnit(units[index], deadlineMs - (clock() - started));
    }
  };
  const workers = Math.max(1, Math.min(concurrency, units.length));
  await Promise.all(Array.from({ length: workers }, worker));

  const records = [], carried = [], quiet = [], unreadable = [];
  for (const outcome of outcomes) {
    if (outcome.kind === 'carried') {
      records.push(...outcome.rows);
      carried.push({ unit: outcome.unit, records: outcome.rows.length });
    } else if (outcome.kind === 'quiet') quiet.push(outcome.unit);
    else unreadable.push({ unit: outcome.unit, code: outcome.code });
  }

  // Nothing was read at all. Returning an empty snapshot here is the defect
  // this module exists to prevent: a denied grant must not be indistinguishable
  // from a source that holds nothing, so the producer fails instead.
  if (!carried.length && !quiet.length && unreadable.length) throw coded(unreadable[0].code);
  return {
    records,
    health: { status: unreadable.length ? 'partial' : 'ok', carried, quiet, unreadable },
  };
}
