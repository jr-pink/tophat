// Append-only JSON-lines journals (notes-journal.jsonl, reader-notes.jsonl) without an fsync on the
// event loop.
//
// Both stores used to open the journal, write one line, fsyncSync and close, on the HTTP thread, per
// record. fsync waits for the device; with the boot disk saturated one took seconds, and a notes save
// or a GET /api/state that settles many blocks writes many records, so the server froze 20-65 s at a
// time.
//
// Now: the file stays open, the line is written with writeSync (into the OS page cache: it survives
// any crash of this process, and it is in the file before the caller touches SQLite, so a reader and
// rebuildFromJournal() see it in order), and the fsync runs on the libuv pool, coalesced so at most
// one is in flight per journal and every line written before an fsync started is covered by it. The
// power-loss window is the fsync's own latency; the SQLite stores beside these journals run
// synchronous=NORMAL in WAL, whose last commits are not durable across power loss either.
import { closeSync, fsync, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const G = (globalThis[Symbol.for('tophat.journalAppend')] ||= { files: new Map() });

function entry(path) {
  let file = G.files.get(path);
  if (!file) {
    mkdirSync(dirname(path), { recursive: true });
    file = { fd: openSync(path, 'a', 0o600), dirty: false, syncing: null, waiters: [] };
    G.files.set(path, file);
  }
  return file;
}

function sync(path, file) {
  if (file.syncing || !file.dirty) return;
  file.dirty = false;
  const waiters = file.waiters; file.waiters = [];
  file.syncing = new Promise((resolve) => {
    fsync(file.fd, (error) => {
      if (error) console.warn(`[journal] fsync ${path} failed: ${error.message}`);
      file.syncing = null;
      for (const done of waiters) done();
      resolve();
      // Lines written while this fsync ran are covered by the next one.
      if (file.dirty) sync(path, file);
    });
  });
}

/** Append one record (one JSON line). Synchronous write, asynchronous fsync. */
export function appendJournalLine(path, record) {
  const file = entry(path);
  writeSync(file.fd, `${JSON.stringify(record)}\n`);
  file.dirty = true;
  sync(path, file);
}

/** Resolves once every line appended so far is fsynced (tests, shutdown). */
export function journalsSynced(path = null) {
  const waits = [];
  for (const [key, file] of G.files) {
    if (path && key !== path) continue;
    if (file.dirty) { waits.push(new Promise((resolve) => file.waiters.push(resolve))); sync(key, file); }
    else if (file.syncing) waits.push(file.syncing);
  }
  return Promise.all(waits).then(() => undefined);
}

/**
 * Stop using a journal's descriptor (its store closed). The next append reopens the path, so a file
 * replaced or removed underneath is never written through a stale descriptor. The old descriptor is
 * fsynced and closed after any fsync already running on it.
 */
export function releaseJournal(path) {
  const file = G.files.get(path);
  if (!file) return;
  G.files.delete(path);
  const finish = () => fsync(file.fd, () => { try { closeSync(file.fd); } catch { /* closed */ } });
  if (file.syncing) file.syncing.then(finish); else finish();
}
