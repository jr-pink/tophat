// Shared by every reader in rev6/sources: hashing, coded failures, the bounded
// per-unit read (a unit that fails costs its own coverage, never the batch),
// and the copy-then-open of a native SQLite store. Why copy: the owner's stores
// (chat.db, CallHistory, Photos) are hot and owned by other apps; a copy opened
// read-only with query_only cannot write, checkpoint or lock them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const APPLE_EPOCH = 978307200;
export const FULL_DISK_ACCESS_STEP = 'System Settings > Privacy & Security > Full Disk Access';
export const sha = (text) => createHash('sha256').update(text).digest('hex');
export const hashJson = (value) => sha(JSON.stringify(value));
export const coded = (code, extra) => Object.assign(new Error(code), { code }, extra);
export const fail = (code, extra) => { throw coded(code, extra); };
export const result = (records, cursor, complete = true, health = {}) =>
  ({ records, cursor, complete, health: { status: 'ok', coverage: complete ? 'snapshot-complete' : 'partial', ...health } });
export const isoOrFail = (value, code = 'invalid-source-date') => {
  const d = new Date(value); if (!Number.isFinite(+d)) fail(code); return d.toISOString();
};
export const appleIso = (seconds, code = 'invalid-timestamp') => {
  const ms = (Number(seconds) + APPLE_EPOCH) * 1000;
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) fail(code);
  return new Date(ms).toISOString();
};

export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}
export const revisionOf = (payload) => sha(`${canonical(payload)}\n`);

// The bounded per-unit read has ONE owner: src/connectors/bounded-read.mjs.
//
// What stood here was a line-for-line port of it, and a port is a copy: the same
// 20-second deadline, the same pool of four, the same carried/quiet/unreadable
// classification, the same four codes, and the same refusal to report a sweep
// where every unit failed as a sweep that found nothing. That last line is the
// whole reason the module exists -- a denied Full Disk Access grant must never
// be indistinguishable from a Mac that has made no phone calls -- and a rule of
// that shape is exactly the one whose two halves must not drift apart, since
// the half that loosens reads as an empty source and nobody notices.
//
// The module path and the name are unchanged, so every rev6 source reader is
// untouched; tests/bounded-read-one-owner.test.mjs pins the two to one function.
export { readUnits } from '../../src/connectors/bounded-read.mjs';

/** Run `work(db)` on a read-only copy of `file` (plus its -wal/-shm), then delete the copy. */
export function withCopy(file, name, work, { copyFile = fs.copyFileSync, prefix = 'rev6-src-', what = 'database' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(dir, 0o700);
  let db;
  try {
    const target = path.join(dir, name);
    try { copyFile(file, target); } catch (error) {
      fail(error?.code === 'EPERM' || error?.code === 'EACCES' ? 'full-disk-access-required' : `${what}-unavailable`);
    }
    for (const s of ['-wal', '-shm']) { try { copyFile(`${file}${s}`, `${target}${s}`); } catch { /* optional */ } }
    try { db = new DatabaseSync(target, { readOnly: true }); db.exec('PRAGMA query_only=ON'); } catch { db?.close(); db = null; fail(`${what}-unreadable`); }
    return work(db);
  } finally { db?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

/** Open a store in place, read-only, no copy (Beeper's index, the reader store): `mode=ro` sees committed WAL rows. */
export function openRo(file) {
  if (!fs.existsSync(file)) fail('store-absent');
  const db = new DatabaseSync(`file:${file}?mode=ro`, { readOnly: true });
  db.exec('PRAGMA busy_timeout=5000; PRAGMA query_only=ON');
  return db;
}

export const columnsOf = (db, table) => { try { return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)); } catch { return new Set(); } };
export const hasTable = (db, name) => { try { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name=?").get(name); } catch { return false; } };
export const mtimeIso = (file) => { try { return fs.statSync(file).mtime.toISOString(); } catch { return null; } };
