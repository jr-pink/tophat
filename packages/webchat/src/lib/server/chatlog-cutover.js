// The switch from the legacy events.sqlite to the log-first store, and the way back.
//
// cutover(dir) runs once, at the boot that finds the flag `on` and a legacy file still at events.sqlite
// (nothing is serving yet: the previous process has gone and the next has not opened a store). It
//   1. catches the log up on everything the legacy file holds above the log's highest cursor (events
//      coalesced exactly as the live path does), the applied actions the log lacks, and any conversation
//      row that differs from what the log derives (a `$snapshot` of the legacy row: at this moment the
//      legacy file is quiescent, so its row is the truth);
//   2. refuses to go on unless the log's committed events equal the legacy file's, kind for kind, in
//      count and last cursor;
//   3. copies the small non-event tables (passkeys, challenges, routing messages, reading marks, scope
//      moves and rules) into chat-state.sqlite with their own DDL;
//   4. makes cursor.reserve exceed every cursor the legacy file ever issued;
//   5. moves events.sqlite (and its -wal/-shm) to archive/ untouched, read-only, and puts the derived
//      index at events.sqlite, so every other reader of that path (rev5, retrieval, the memory ingest)
//      keeps working with the same columns.
// Every step is repeatable; a crash before step 5 leaves the legacy file in place and the next boot runs
// it again. Nothing in the legacy file is modified or deleted by any step.
//
// rollback(dir) rebuilds a legacy store from the archive plus the log: a copy-on-write clone of the
// archived file gets every event, search row, conversation row, applied action and state table the
// log-first store holds, so a restart with the flag off serves everything, including what was written
// since the cutover. The archive itself is never opened for writing.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { LogWriter } from './chatlog-writer.js';
import { ChatIndex } from './chat-index.js';
import { legacyConversationRecords } from './chatlog-backfill.js';
import { FRAGMENT_KINDS } from './fragments.js';
import { CONVERSATION_COLUMNS } from './conv-projection.js';
import { RESERVE_BLOCK, STATE_SCHEMA } from './log-store.js';

const STATE_TABLES = ['credentials', 'challenges', 'ff_messages', 'reading', 'scope_moves', 'scope_rules'];
const FRAGMENT_LIST = [...FRAGMENT_KINDS].map((k) => `'${k}'`).join(',');

export function isDerivedIndex(file) {
  if (!fs.existsSync(file)) return false;
  const db = new DatabaseSync(file, { readOnly: true });
  try { return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'log_pos'").get()); } finally { db.close(); }
}

const sidecars = ['', '-wal', '-shm'];

export function cutover(dir, { log = console, now = () => new Date().toISOString() } = {}) {
  const legacyPath = path.join(dir, 'events.sqlite');
  const indexPath = path.join(dir, 'chat-index.sqlite');
  const statePath = path.join(dir, 'chat-state.sqlite');
  const root = path.join(dir, 'chatlog');
  if (isDerivedIndex(legacyPath)) return { status: 'already-cut-over' };
  if (!fs.existsSync(legacyPath)) throw new Error(`cutover: no legacy store at ${legacyPath}`);
  if (!fs.existsSync(indexPath) || !fs.existsSync(root)) throw new Error('cutover: there is no shadow log to cut over from (run the backfill and the shadow phase first)');
  const started = performance.now();
  const legacy = new DatabaseSync(legacyPath, { readOnly: true });
  legacy.exec('PRAGMA busy_timeout = 30000');
  const writer = new LogWriter({ root, indexPath });
  const report = { status: 'cut-over', caughtUp: { events: 0, conversations: 0, snapshots: 0, applied: 0 } };
  try {
    legacy.exec('BEGIN');
    const legacyHead = Number(legacy.prepare('SELECT COALESCE(MAX(cursor), 0) AS c FROM events').get().c);
    let sequence = legacyHead;
    try { sequence = Math.max(sequence, Number(legacy.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'events'").get()?.seq || 0)); } catch { /* none */ }
    const from = writer.index.ingestedThrough();

    // ---- 1. catch up -------------------------------------------------------------------------------------------
    const legacyRows = new Map(legacy.prepare('SELECT * FROM conversations').all().map((r) => [r.id, r]));
    const indexApplied = new Set(writer.index.db.prepare('SELECT action_id FROM applied_actions').all().map((r) => r.action_id));
    const appliedBy = new Map();
    for (const a of legacy.prepare('SELECT * FROM applied_actions').all()) if (!indexApplied.has(a.action_id)) { (appliedBy.get(a.conversation_id) || appliedBy.set(a.conversation_id, []).get(a.conversation_id)).push(a); }
    const touched = new Set(legacy.prepare('SELECT DISTINCT conversation_id FROM events WHERE cursor > ?').all(from).map((r) => r.conversation_id));
    for (const id of appliedBy.keys()) touched.add(id);
    for (const [id, row] of legacyRows) if (!touched.has(id)) {
      // a conversation nothing was appended to can still differ (a setting changed, a scope backfilled)
      const mine = writer.index.row(id);
      if (!mine || CONVERSATION_COLUMNS.some((c) => (mine[c] ?? null) !== (row[c] ?? null))) touched.add(id);
    }
    const select = legacy.prepare('SELECT cursor, run_id, kind, content, at FROM events WHERE conversation_id = ? AND cursor > ? ORDER BY cursor');
    for (const id of touched) {
      const existing = writer.index.row(id);
      const { records, stats } = legacyConversationRecords({
        id, rows: select.iterate(id, from), legacyRow: legacyRows.get(id) || null, applied: appliedBy.get(id) || [],
        startN: writer.log.lastN(id), startRow: existing || null
      });
      if (!records.length) continue;
      for (let at = 0; at < records.length; at += 5000) writer.append(records.slice(at, at + 5000));
      report.caughtUp.events += stats.events; report.caughtUp.conversations += 1;
      if (stats.snapshot) report.caughtUp.snapshots += 1;
      report.caughtUp.applied += (appliedBy.get(id) || []).length;
    }

    // ---- 2. the log must hold what the legacy file holds -------------------------------------------------------
    // A full comparison scans the legacy file (about 20 s); `verified_through` is the cursor up to which an earlier
    // `mark-verified` (markVerified below, run before the restart) already proved every conversation's counts equal, so
    // the boot only has to prove what lies above it, and that is a range read.
    const above = Number(writer.index.meta('verified_through') || 0);
    const checked = compareCounts(legacy, writer.index.db, { above });
    report.verify = { ...checked, above };
    if (checked.problems.length) throw new Error(`cutover refused: ${checked.problems[0]}${checked.problems.length > 1 ? ` (and ${checked.problems.length - 1} more)` : ''}`);

    // ---- 3. the state tables ------------------------------------------------------------------------------------
    const state = new DatabaseSync(statePath);
    try {
      state.exec('PRAGMA journal_mode = WAL');
      state.exec(STATE_SCHEMA);
      state.exec(`ATTACH DATABASE '${legacyPath.replace(/'/gu, "''")}' AS old`);
      report.state = {};
      for (const table of STATE_TABLES) {
        const ddl = legacy.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.sql;
        if (!ddl) continue;
        const exists = state.prepare("SELECT 1 FROM main.sqlite_master WHERE type = 'table' AND name = ?").get(table);
        if (!exists) state.exec(ddl);
        state.exec(`INSERT OR REPLACE INTO main.${table} SELECT * FROM old.${table}`);
        report.state[table] = Number(state.prepare(`SELECT COUNT(*) AS n FROM main.${table}`).get().n);
      }
      state.exec('DETACH DATABASE old');
      state.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally { state.close(); }
    legacy.exec('COMMIT');

    // ---- 4. cursors ---------------------------------------------------------------------------------------------
    const reserveFile = path.join(root, 'cursor.reserve');
    let reserved = 0;
    try { reserved = Number(fs.readFileSync(reserveFile, 'utf8').trim()) || 0; } catch { /* none */ }
    const floor = Math.max(reserved, sequence, legacyHead, writer.index.maxCursor());
    const tmp = `${reserveFile}.cutover.tmp`;
    fs.writeFileSync(tmp, String(floor + RESERVE_BLOCK));
    fs.renameSync(tmp, reserveFile);
    report.cursors = { legacyHead, legacySequence: sequence, reserve: floor + RESERVE_BLOCK };
  } finally {
    try { legacy.close(); } catch { /* closed */ }
    writer.close();
  }

  // ---- 5. the swap -----------------------------------------------------------------------------------------------
  const archive = path.join(dir, 'archive');
  fs.mkdirSync(archive, { recursive: true });
  const stamp = now().replace(/[-:.]/gu, '').replace('Z', 'Z');
  const archived = path.join(archive, `events-legacy-${stamp}.sqlite`);
  for (const suffix of sidecars) {
    const from = `${legacyPath}${suffix}`;
    if (fs.existsSync(from)) { fs.renameSync(from, `${archived}${suffix}`); try { fs.chmodSync(`${archived}${suffix}`, 0o444); } catch { /* best effort */ } }
  }
  for (const suffix of sidecars) {
    const from = `${indexPath}${suffix}`;
    if (fs.existsSync(from)) fs.renameSync(from, `${legacyPath}${suffix}`);
  }
  report.archive = archived;
  report.ms = Math.round(performance.now() - started);
  log.log?.(`[chatlog] cut over: legacy store archived at ${archived}; ${JSON.stringify(report.caughtUp)} caught up in ${report.ms} ms`);
  return report;
}

/**
 * Committed events (everything but fragments) of two stores, compared in total and per conversation, for cursors in
 * (above, upTo]. Returns { legacy: {n, last}, log: {n, last}, conversations, problems: [...] }.
 */
export function compareCounts(legacy, index, { above = 0, upTo = Number.MAX_SAFE_INTEGER } = {}) {
  const where = `kind NOT IN (${FRAGMENT_LIST}) AND cursor > ${Number(above)} AND cursor <= ${Number(upTo)}`;
  const total = (db) => { const r = db.prepare(`SELECT COUNT(*) AS n, COALESCE(MAX(cursor), 0) AS last FROM events WHERE ${where}`).get(); return { n: Number(r.n), last: Number(r.last) }; };
  const per = (db) => new Map(db.prepare(`SELECT conversation_id AS id, COUNT(*) AS n FROM events WHERE ${where} GROUP BY conversation_id`).all().map((r) => [r.id, Number(r.n)]));
  const a = total(legacy); const b = total(index);
  const problems = [];
  if (a.n !== b.n || a.last !== b.last) problems.push(`the log holds ${b.n} committed events (last cursor ${b.last}) and the legacy file ${a.n} (last cursor ${a.last})`);
  const pa = per(legacy); const pb = per(index);
  for (const [id, n] of pa) if (pb.get(id) !== n) problems.push(`conversation ${id} has ${n} committed events in the legacy file and ${pb.get(id) ?? 0} in the log`);
  for (const [id, n] of pb) if (!pa.has(id) && n) problems.push(`conversation ${id} exists only in the log (${n} events)`);
  return { legacy: a, log: b, conversations: pa.size, problems };
}

/**
 * While the shadow runs: prove per-conversation counts equal up to a cursor safely behind both heads and record it in
 * the index (`verified_through`), so the cutover at the next boot compares only what lies above. Read-only on the legacy
 * file; the one write is that meta row. Returns { through, ...compareCounts }.
 */
export function markVerified(dir, { margin = 5000 } = {}) {
  const legacy = new DatabaseSync(path.join(dir, 'events.sqlite'), { readOnly: true });
  const index = new DatabaseSync(path.join(dir, 'chat-index.sqlite'));
  try {
    legacy.exec('PRAGMA busy_timeout = 30000'); index.exec('PRAGMA busy_timeout = 30000');
    const head = (db) => Number(db.prepare(`SELECT COALESCE(MAX(cursor), 0) AS c FROM events WHERE kind NOT IN (${FRAGMENT_LIST})`).get().c);
    const through = Math.max(0, Math.min(head(legacy), head(index)) - margin);
    legacy.exec('BEGIN'); index.exec('BEGIN');
    const result = compareCounts(legacy, index, { upTo: through });
    legacy.exec('COMMIT'); index.exec('COMMIT');
    if (!result.problems.length) index.prepare("INSERT INTO index_meta (k, v) VALUES ('verified_through', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(String(through));
    return { through, ...result };
  } finally { legacy.close(); index.close(); }
}

/**
 * Rebuild a legacy store at dir/events.sqlite from the newest archive and the log-first store's index, for a
 * restart with the flag off. The server must be stopped. Returns what it did; the index and the archive are untouched.
 */
export function rollback(dir, { log = console } = {}) {
  const legacyPath = path.join(dir, 'events.sqlite');
  const archiveDir = path.join(dir, 'archive');
  const archives = fs.existsSync(archiveDir) ? fs.readdirSync(archiveDir).filter((f) => /^events-legacy-.*\.sqlite$/u.test(f)).sort() : [];
  if (!archives.length) throw new Error('rollback: there is no archived legacy store');
  const archive = path.join(archiveDir, archives.at(-1));
  if (!isDerivedIndex(legacyPath)) throw new Error('rollback: events.sqlite is not a derived index; nothing to roll back');
  // The new legacy store is built beside the live file and swapped in last, so a rollback that dies leaves the
  // derived index at events.sqlite and can simply be run again.
  const building = path.join(dir, 'events.rollback.sqlite');
  for (const suffix of sidecars) fs.rmSync(`${building}${suffix}`, { force: true });
  for (const suffix of sidecars) if (fs.existsSync(`${archive}${suffix}`)) fs.copyFileSync(`${archive}${suffix}`, `${building}${suffix}`, fs.constants.COPYFILE_FICLONE);
  for (const suffix of sidecars) { try { fs.chmodSync(`${building}${suffix}`, 0o644); } catch { /* absent */ } }
  const db = new DatabaseSync(building);
  const report = { archive };
  const lap = (label, t) => { report[`${label}Ms`] = Math.round(performance.now() - t); };
  try {
    db.exec('PRAGMA busy_timeout = 30000');
    db.exec(`ATTACH DATABASE '${legacyPath.replace(/'/gu, "''")}' AS d`);
    const cols = CONVERSATION_COLUMNS.join(', ');
    let t = performance.now();
    db.exec('BEGIN IMMEDIATE');
    const before = Number(db.prepare('SELECT COUNT(*) AS n FROM events').get().n);
    db.exec('INSERT OR IGNORE INTO events (cursor, conversation_id, run_id, kind, content, at) SELECT cursor, conversation_id, run_id, kind, content, at FROM d.events');
    report.eventsAdded = Number(db.prepare('SELECT COUNT(*) AS n FROM events').get().n) - before;
    lap('events', t); t = performance.now();
    // the search rows of the events that were added (rows of events the archive already had are already there):
    // the full-text tables are virtual, so the cursors already indexed are collected once, in memory.
    for (const table of ['event_fts', 'event_sub']) {
      const have = new Set(db.prepare(`SELECT cursor FROM main.${table}`).all().map((r) => Number(r.cursor)));
      const insert = db.prepare(`INSERT INTO main.${table} (body, conversation_id, cursor, kind) VALUES (?, ?, ?, ?)`);
      let added = 0;
      for (const r of db.prepare(`SELECT body, conversation_id, cursor, kind FROM d.${table}`).iterate()) {
        if (have.has(Number(r.cursor))) continue;
        insert.run(r.body, r.conversation_id, r.cursor, r.kind); added += 1;
      }
      report[`${table}Added`] = added;
    }
    lap('search', t); t = performance.now();
    db.exec(`INSERT OR REPLACE INTO conversations (${cols}) SELECT ${cols} FROM d.conversations`);
    db.exec('INSERT OR IGNORE INTO applied_actions SELECT action_id, conversation_id, op, cursor_before, cursor_after, at FROM d.applied_actions');
    // the legacy store's cursors continue above everything either side ever issued
    const reserve = Number(fs.readFileSync(path.join(dir, 'chatlog', 'cursor.reserve'), 'utf8').trim()) || 0;
    const top = Math.max(reserve, Number(db.prepare('SELECT COALESCE(MAX(cursor), 0) AS c FROM events').get().c));
    const seq = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'events'").get();
    if (seq) db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'events'").run(Math.max(top, Number(seq.seq)));
    else db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('events', ?)").run(top);
    db.exec('COMMIT');
    db.exec('DETACH DATABASE d');
    lap('rows', t);
    // the state tables come back from chat-state.sqlite
    const statePath = path.join(dir, 'chat-state.sqlite');
    if (fs.existsSync(statePath)) {
      db.exec(`ATTACH DATABASE '${statePath.replace(/'/gu, "''")}' AS s`);
      report.state = {};
      for (const table of STATE_TABLES) {
        const has = db.prepare("SELECT 1 FROM s.sqlite_master WHERE type = 'table' AND name = ?").get(table);
        const mine = db.prepare("SELECT 1 FROM main.sqlite_master WHERE type = 'table' AND name = ?").get(table);
        if (has && !mine) db.exec(db.prepare("SELECT sql FROM s.sqlite_master WHERE type = 'table' AND name = ?").get(table).sql);
        if (has) { db.exec(`INSERT OR REPLACE INTO main.${table} SELECT * FROM s.${table}`); report.state[table] = Number(db.prepare(`SELECT COUNT(*) AS n FROM main.${table}`).get().n); }
      }
      db.exec('DETACH DATABASE s');
    }
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* none open */ }
    throw error;
  } finally { db.close(); }
  // swap: the derived index is kept beside (a second cutover needs no rebuild); the rebuilt legacy store takes its name
  const derivedCopy = path.join(dir, `chat-index.rolledback-${Date.now()}.sqlite`);
  for (const suffix of sidecars) if (fs.existsSync(`${legacyPath}${suffix}`)) fs.renameSync(`${legacyPath}${suffix}`, `${derivedCopy}${suffix}`);
  for (const suffix of sidecars) if (fs.existsSync(`${building}${suffix}`)) fs.renameSync(`${building}${suffix}`, `${legacyPath}${suffix}`);
  report.derivedCopy = derivedCopy;
  log.log?.(`[chatlog] rolled back to a legacy store at ${legacyPath} (${JSON.stringify(report)})`);
  return report;
}
