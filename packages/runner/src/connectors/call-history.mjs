// Apple call history, normalized into events.
//
// READ MODE IS STATED, NOT ASSUMED. The legacy ingest read a finder-backup
// extract rather than the live database, and an agent that assumed it was live
// answered a question about last week from a file captured a month earlier. A
// stale answer presented as a current one is the failure this module is shaped
// around, so every unit declares its mode and every record carries it:
//
//   live     the path in `config.liveDatabase`, by default
//            ~/Library/Application Support/CallHistoryDB/CallHistory.storedata.
//            Current as of the instant it is copied. Needs a grant.
//   extract  any other path: a backup extract, a copy pulled off a device, an
//            archive. Current only as of its own mtime, which is reported as
//            the unit's `capturedAt` and as the coverage window, and is never
//            reported as now.
//
// The mode is derived from the path rather than configured, so a configuration
// file cannot claim an extract is live.
//
// THE GRANT. Reading the live database needs Full Disk Access, which only the
// owner can give: System Settings > Privacy & Security > Full Disk Access.
// macOS refuses the copy with EPERM or EACCES, which is not a missing and not a
// corrupt database, so the two conditions carry two different codes and a
// denied grant never reads as an empty history.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readUnits, DEFAULT_DEADLINE_MS } from './bounded-read.mjs';

export const CALL_HISTORY_KIND = 'apple-call-history';
export const LIVE_CALL_DATABASE =
  path.join(os.homedir(), 'Library/Application Support/CallHistoryDB/CallHistory.storedata');
export const FULL_DISK_ACCESS_STEP = 'System Settings > Privacy & Security > Full Disk Access';

const APPLE_EPOCH_SECONDS = 978307200;

// Read only what a call event is: when, which way, how long, which handle and
// which carrier. Nothing else in ZCALLRECORD is asked for.
const WANTED = [
  'ZUNIQUE_ID', 'ZDATE', 'ZDURATION', 'ZORIGINATED', 'ZANSWERED', 'ZCALLTYPE',
  'ZADDRESS', 'ZNAME', 'ZSERVICE_PROVIDER', 'ZISO_COUNTRY_CODE',
];

const fail = code => { const error = new Error(code); error.code = code; throw error; };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function stamp(seconds) {
  const ms = (seconds + APPLE_EPOCH_SECONDS) * 1000;
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) fail('invalid-call-timestamp');
  return new Date(ms).toISOString();
}

// A revoked grant, a missing file and a file that is not a database are three
// different answers and the caller needs to tell them apart.
function snapshot(file, into, copyFile) {
  const target = path.join(into, 'calls.storedata');
  try {
    copyFile(file, target);
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') fail('full-disk-access-required');
    fail('call-database-unavailable');
  }
  // A live database usually has a write-ahead log, and the newest calls are in
  // it rather than in the main file.
  for (const suffix of ['-wal', '-shm']) {
    try { copyFile(`${file}${suffix}`, `${target}${suffix}`); } catch { /* optional */ }
  }
  return target;
}

function open(file) {
  let database;
  try {
    database = new DatabaseSync(file, { readOnly: true });
    database.exec('PRAGMA query_only=ON');
    return database;
  } catch {
    database?.close();
    fail('call-database-unreadable');
  }
}

const column = (present, name) =>
  present.has(name) ? `${name} AS ${name.slice(1).toLowerCase()}` : `NULL AS ${name.slice(1).toLowerCase()}`;

function callRecord(row, unit) {
  const seconds = Number(row.date);
  if (typeof row.unique_id !== 'string' || !row.unique_id) fail('invalid-call-identity');
  if (!Number.isFinite(seconds)) fail('invalid-call-timestamp');
  const direction = row.originated == null ? 'unknown' : (row.originated ? 'outgoing' : 'incoming');
  const answered = row.answered == null ? null : Boolean(row.answered);
  const duration = row.duration == null ? null : Math.round(Number(row.duration));
  const handle = row.address == null ? null : String(row.address);
  const name = row.name == null ? null : String(row.name);
  const words = [
    `${direction} call`,
    name || handle ? `with ${name || handle}` : 'with an unrecorded handle',
    answered === false ? 'not answered' : null,
    duration === null ? null : `${duration}s`,
    row.service_provider ? `via ${row.service_provider}` : null,
  ].filter(Boolean);
  return {
    id: `call:${row.unique_id}`,
    revision: hash(row),
    occurredAt: stamp(seconds),
    text: words.join('; '),
    metadata: {
      type: 'call',
      readMode: unit.mode,
      unitId: unit.id,
      capturedAt: unit.capturedAt,
      direction,
      answered,
      durationSeconds: duration,
      handle,
      displayName: name,
      serviceProvider: row.service_provider ?? null,
      countryCode: row.iso_country_code ?? null,
      callType: row.calltype == null ? null : Number(row.calltype),
      // An extract holds no call made after it was captured, and saying so on
      // the record keeps a reader from treating it as the present.
      currentAsOf: unit.mode === 'live' ? 'read-instant' : unit.capturedAt,
    },
  };
}

function readDatabase(unit, { after, batchSize, copyFile }) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tophat-calls-'));
  fs.chmodSync(temporary, 0o700);
  let database;
  try {
    database = open(snapshot(unit.path, temporary, copyFile));
    const present = new Set(database.prepare('PRAGMA table_info(ZCALLRECORD)').all().map(row => row.name));
    if (!present.has('ZUNIQUE_ID') || !present.has('ZDATE')) fail('unsupported-call-schema');
    const select = WANTED.map(name => column(present, name)).join(', ');
    const rows = database.prepare(
      `SELECT ${select} FROM ZCALLRECORD WHERE ZUNIQUE_ID IS NOT NULL`
      + ' AND (ZDATE > ? OR (ZDATE = ? AND ZUNIQUE_ID > ?)) ORDER BY ZDATE, ZUNIQUE_ID LIMIT ?',
    ).all(after.date, after.date, after.id, batchSize);
    return { rows, records: rows.map(row => callRecord(row, unit)) };
  } finally {
    database?.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function plan(config) {
  const configured = config.databases ?? [];
  if (!Array.isArray(configured) || !configured.length) fail('call-databases-required');
  const live = config.liveDatabase ?? LIVE_CALL_DATABASE;
  return configured.map(entry => {
    const file = typeof entry === 'string' ? entry : entry?.path;
    if (!file || !path.isAbsolute(file)) fail('absolute-call-database-path-required');
    let capturedAt = null;
    try { capturedAt = fs.statSync(file).mtime.toISOString(); } catch { capturedAt = null; }
    return { id: typeof entry === 'string' ? path.basename(entry) : (entry.id ?? path.basename(file)),
      path: file, mode: file === live ? 'live' : 'extract', capturedAt };
  });
}

const coverage = units => {
  const modes = new Set(units.map(unit => unit.mode));
  if (modes.size > 1) return 'mixed-live-and-extract';
  return modes.has('live') ? 'live-database-snapshot' : 'backup-extract-as-of-capture';
};

export async function pollCallHistory(source, { cursor = null, copyFile = fs.copyFileSync } = {}) {
  if (source.kind !== CALL_HISTORY_KIND) fail('unsupported-call-history-kind');
  const config = source.config ?? {};
  const batchSize = config.batchSize ?? 500;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 20000) fail('invalid-call-batch-size');
  const units = plan(config);
  const previous = cursor?.version === 1 ? (cursor.units ?? {}) : {};
  const next = {}, drained = {};
  const work = units.map(unit => ({
    id: unit.id,
    read: () => {
      const after = previous[unit.id] ?? { date: -Infinity, id: '' };
      const start = { date: Number.isFinite(after.date) ? after.date : -1e12, id: after.id ?? '' };
      const { rows, records } = readDatabase(unit, { after: start, batchSize, copyFile });
      const last = rows.at(-1);
      next[unit.id] = last ? { date: Number(last.date), id: String(last.unique_id) } : after;
      drained[unit.id] = rows.length < batchSize;
      return records;
    },
  }));
  const { records, health } = await readUnits(work, { deadlineMs: config.deadlineMs ?? DEFAULT_DEADLINE_MS });
  const complete = units.every(unit => drained[unit.id] === true);
  return {
    records,
    cursor: { version: 1, units: { ...previous, ...next } },
    complete,
    health: {
      ...health,
      coverage: coverage(units),
      readModes: units.map(unit => ({ unit: unit.id, mode: unit.mode, capturedAt: unit.capturedAt })),
      ownerStep: health.unreadable.some(item => item.code === 'full-disk-access-required')
        ? FULL_DISK_ACCESS_STEP : null,
    },
  };
}
