// The source runner: poll each enabled, due source once with a deadline, hand its records to `deliver` (the push
// plane ingests them into a MemoryStore), and only then commit the cursor, so a cursor never moves past records that
// are not durable. One broken source never stops the rest. Cursor state: <stateDir>/sources-state.json, written by
// atomic temp+rename (one writer: the push poll). Failures keep the cause's code, never its prose (a message can carry a
// URL with a token in it).
import fs from 'node:fs';
import path from 'node:path';
import { adapterFor, toRawRecord } from './index.mjs';

export const stateFile = (stateDir) => path.join(stateDir, 'sources-state.json');
export function readState(stateDir) { try { return JSON.parse(fs.readFileSync(stateFile(stateDir), 'utf8')); } catch { return { sources: {} }; } }
function writeState(stateDir, s) { fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 }); const f = stateFile(stateDir), tmp = `${f}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(s, null, 1) + '\n', { mode: 0o600 }); fs.renameSync(tmp, f); }

const due = (source, row, now) => source.enabled !== false && !(source.schedule && row?.lastAttempt && Date.parse(now) - Date.parse(row.lastAttempt) < source.schedule * 1000);

/**
 * sources: [{ id, family, account?, schedule? (seconds), enabled?, config }]
 * deliver(source, rawRecords) -> Promise<any>  (must be durable when it resolves)
 */
export async function runSources({ sources, stateDir, deliver, now = new Date().toISOString(), deadlineMs = 240000, force = false, ctx = {} }) {
  const state = readState(stateDir);
  const started = Date.now(), report = { polled: 0, skipped: [], errors: [], delivered: {} };
  for (const source of sources) {
    const row = state.sources[source.id];
    if (!force && !due(source, row, now)) { report.skipped.push(source.id); continue; }
    const left = deadlineMs - (Date.now() - started);
    if (left <= 0) { report.skipped.push(source.id); continue; }
    let timer;
    try {
      const mod = await adapterFor(source.family);
      const batch = await Promise.race([mod.poll(source, { cursor: row?.cursor ?? null, now, stateDir, ...ctx }),
        new Promise((_, no) => { timer = setTimeout(() => no(Object.assign(new Error('source-deadline-exceeded'), { code: 'source-deadline-exceeded' })), left); })]);
      if (!batch || !Array.isArray(batch.records)) throw Object.assign(new Error('invalid-source-batch'), { code: 'invalid-source-batch' });
      const raw = batch.records.map((r) => toRawRecord(source, r));
      report.delivered[source.id] = raw.length ? await deliver(source, raw) : { stored: [], duplicates: [] };
      state.sources[source.id] = { cursor: batch.cursor ?? null, lastSuccess: now, lastAttempt: now, complete: batch.complete === true, error: null, health: batch.health?.status ?? null };
      writeState(stateDir, state);
      report.polled++;
    } catch (error) {
      const cause = [error?.code, error?.name].filter((x) => typeof x === 'string' && x.trim()).join(' ').trim() || null;
      state.sources[source.id] = { ...(row || {}), lastAttempt: now, error: `Source unavailable; retry pending${cause ? ` (${cause})` : ''}` };
      writeState(stateDir, state);
      report.errors.push({ source: source.id, cause });
    } finally { clearTimeout(timer); }
  }
  return report;
}
