// One way to open a SQLite store (node:sqlite). Several processes share each
// store, so busy is a wait, not a failure: busy_timeout goes on before anything
// takes a lock, and the operations busy_timeout does not cover (switching to
// WAL, SQLITE_BUSY_SNAPSHOT inside a transaction) are retried in place.
// Never: open a path the live-state guard refuses, or switch a read-only handle's journal mode.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { refuseLiveUnderTest } from './paths.mjs';

export const BUSY = /database is locked|SQLITE_BUSY|database table is locked/iu;
export const isBusy = (error) => BUSY.test(String(error && error.message)) || error?.errcode === 5 || error?.errcode === 6;

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no SharedArrayBuffer: spin-free fallthrough */ }
}

/** `work()`, retried while SQLite says busy. `tolerate` returns undefined instead of throwing after the last attempt. */
export function retryWhileBusy(work, { attempts = 12, pauseMs = 120, tolerate = false, sleep = sleepSync } = {}) {
  for (let n = 1; ; n++) {
    try { return work(); } catch (error) {
      const busy = isBusy(error);
      if (!busy || n >= attempts) { if (busy && tolerate) return undefined; throw error; }
      sleep(pauseMs);
    }
  }
}

/**
 * Open a store. `readonly` opens without creating or writing anything; otherwise the parent
 * directory is created (0700) and the file is switched to WAL.
 */
export function openDb(file, { readonly = false, wal = !readonly, busyMs = 5000, what = 'sqlite store' } = {}) {
  if (file !== ':memory:') {
    refuseLiveUnderTest(path.resolve(file), what);
    if (!readonly) mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  }
  const db = new DatabaseSync(file, readonly ? { readOnly: true } : {});
  db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyMs))}`);
  if (wal && !readonly && file !== ':memory:') retryWhileBusy(() => db.exec('PRAGMA journal_mode = WAL'), { tolerate: true });
  return db;
}

/** `work(db)` inside BEGIN IMMEDIATE ... COMMIT, rolled back on throw, the whole transaction retried while busy. */
export function transaction(db, work, options) {
  return retryWhileBusy(() => {
    db.exec('BEGIN IMMEDIATE');
    try { const out = work(db); db.exec('COMMIT'); return out; } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* already rolled back by SQLite */ }
      throw error;
    }
  }, options);
}
