// Turning a legacy events.sqlite into chat logs: the records one conversation's log would hold had it
// been written by the log-first store from its first event.
//
// The same FragmentCommitter the live store uses decides what each fragment becomes, so history and
// the live path agree: a block that settled is dropped, thinking and anything unsettled becomes one
// coalesced event at its first fragment's cursor. Every other event keeps its id, cursor, run id,
// timestamp and content byte for byte. Nothing here writes; it returns records (chatlog.js shapes) and
// the figures a verifier needs.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { LogWriter } from './chatlog-writer.js';
import { FragmentCommitter, FRAGMENT_KINDS } from './fragments.js';
import { blankConversation, CONVERSATION_COLUMNS, projectEvent } from './conv-projection.js';

const NEVER = () => ({ unref() {} });

function parseContent(text) {
  try { return { d: JSON.parse(text) }; } catch { return { x: String(text ?? '') }; }
}

/**
 * @param {object} input
 * @param {string} input.id            conversation id
 * @param {Iterable<{cursor:number, run_id:string|null, kind:string, content:string, at:string}>} input.rows  its legacy events in cursor order
 * @param {object|null} input.legacyRow its row in the legacy conversations table (null: no row)
 * @param {Array<object>} [input.applied] its applied_actions rows
 * @param {number} [input.startN]       sequence numbers continue after this (0 for a fresh log)
 * @param {object} [input.startRow]     the conversation's row as the index holds it now: an incremental catch-up folds the new
 *                                      events onto it instead of starting from a blank row (no `$conv` is written)
 * @returns {{records: object[], stats: object}}
 */
export function legacyConversationRecords({ id, rows, legacyRow, applied = [], startN = 0, startRow = null }) {
  const records = [];
  let n = startN;
  const stats = { events: 0, fragmentsIn: 0, fragmentBytesIn: 0, coalesced: 0, coalescedBytes: 0, unreadable: 0, snapshot: false, diffColumns: [], maxCursor: 0, firstCursor: null };
  const push = (record) => { n += 1; records.push({ i: id, n, ...record }); };

  let derived = startRow ? { ...startRow } : undefined;
  if (legacyRow && !startRow) {
    const fields = {
      at: legacyRow.created_at, cwd: legacyRow.cwd, settings: JSON.parse(legacyRow.settings || '{}'),
      parentId: legacyRow.parent_id, forkedFrom: legacyRow.forked_from, source: legacyRow.source,
      sidechat: legacyRow.sidechat ? JSON.parse(legacyRow.sidechat) : null, scope: null
    };
    push({ k: '$conv', t: legacyRow.created_at, d: fields });
    derived = blankConversation(id, fields);
  }

  const committer = new FragmentCommitter({
    setTimer: NEVER, clearTimer: () => {}, thinkingFlushMs: Number.MAX_SAFE_INTEGER,
    commit: (_conv, block) => {
      stats.coalesced += 1;
      const size = JSON.stringify(block.content).length;
      stats.coalescedBytes += size;
      push({ c: block.cursor, k: block.kind, r: block.runId ?? null, t: block.at, d: block.content, co: 1, cl: block.last });
      if (derived) derived = projectEvent(derived, { kind: block.kind, content: block.content, at: block.at, cursor: block.cursor }, { late: true });
    },
    onError: (error) => { throw error; }
  });

  for (const row of rows) {
    const parsed = parseContent(row.content);
    if (parsed.x !== undefined) stats.unreadable += 1;
    const content = parsed.d ?? {};
    const ev = { kind: row.kind, content, conversation_id: id, run_id: row.run_id ?? null, cursor: row.cursor, at: row.at };
    stats.maxCursor = Math.max(stats.maxCursor, row.cursor);
    if (stats.firstCursor === null) stats.firstCursor = row.cursor;
    if (FRAGMENT_KINDS.has(row.kind)) {
      stats.fragmentsIn += 1; stats.fragmentBytesIn += row.content.length;
      committer.fragment(id, ev);
      continue;
    }
    committer.committed(id, { kind: row.kind, content });
    stats.events += 1;
    push({ c: row.cursor, k: row.kind, r: row.run_id ?? null, t: row.at, ...(parsed.x !== undefined ? { x: parsed.x } : { d: parsed.d }) });
    if (derived) derived = projectEvent(derived, ev);
  }
  committer.flushAll();

  if (legacyRow) {
    for (const column of CONVERSATION_COLUMNS) {
      if ((derived[column] ?? null) !== (legacyRow[column] ?? null)) stats.diffColumns.push(column);
    }
    if (stats.diffColumns.length) {
      // The legacy row is the truth for what events cannot derive (and for anything an old build wrote differently).
      push({ k: '$snapshot', t: legacyRow.updated_at, d: { row: { ...legacyRow } } });
      stats.snapshot = true;
    }
  }
  for (const a of applied) {
    push({ k: '$applied', t: a.at, d: { actionId: a.action_id, op: a.op, cursorBefore: a.cursor_before, cursorAfter: a.cursor_after, at: a.at } });
  }
  return { records, stats };
}

/**
 * Backfill the chat log (and its derived index) from a legacy events.sqlite. Read-only on the source; reruns skip
 * conversations that already have a log. Returns the totals the CLI prints (scripts/chatlog-backfill.mjs).
 */
export function backfillFromLegacy(source, dir, { only = null, limit = Infinity, indexPath = path.join(dir, 'chat-index.sqlite'), progress = () => {} } = {}) {
  const root = path.join(dir, 'chatlog');
  fs.mkdirSync(root, { recursive: true });
  const db = new DatabaseSync(source, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 30000');
  db.exec('BEGIN');
  const through = Number(db.prepare('SELECT COALESCE(MAX(cursor), 0) AS c FROM events').get().c);
  let sequence = 0;
  try { sequence = Number(db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'events'").get()?.seq || 0); } catch { /* none */ }
  const legacyRows = new Map(db.prepare('SELECT * FROM conversations').all().map((r) => [r.id, r]));
  const appliedBy = new Map();
  for (const a of db.prepare('SELECT * FROM applied_actions').all()) {
    const list = appliedBy.get(a.conversation_id) || []; list.push(a); appliedBy.set(a.conversation_id, list);
  }
  const ids = new Set(legacyRows.keys());
  for (const r of db.prepare('SELECT DISTINCT conversation_id FROM events').all()) ids.add(r.conversation_id);
  for (const id of appliedBy.keys()) ids.add(id);
  const list = (only ? [only] : [...ids]).sort().slice(0, limit === Infinity ? undefined : limit);

  const writer = new LogWriter({ root, indexPath });
  const reportFile = path.join(root, 'backfill-report.jsonl');
  const select = db.prepare('SELECT cursor, run_id, kind, content, at FROM events WHERE conversation_id = ? ORDER BY cursor');
  const totals = { conversations: 0, skipped: 0, events: 0, fragmentsIn: 0, fragmentBytesIn: 0, coalesced: 0, coalescedBytes: 0, records: 0, snapshots: 0, unreadable: 0, diffColumns: {} };
  const started = Date.now();

  for (const id of list) {
    if (writer.log.lastN(id) > 0) { totals.skipped += 1; continue; }
    const hash = createHash('sha256');
    let nonFragment = 0; let first = null; let last = null;
    // The verifier's hash is over the SOURCE rows, so it is computed here from the raw text, not from the records.
    const rows = (function* () {
      for (const row of select.iterate(id)) {
        if (!FRAGMENT_KINDS.has(row.kind)) {
          hash.update(JSON.stringify([row.cursor, row.run_id, row.kind, row.content, row.at])); hash.update('\n');
          nonFragment += 1; if (first === null) first = row.cursor; last = row.cursor;
        }
        yield row;
      }
    })();
    const { records, stats } = legacyConversationRecords({ id, rows, legacyRow: legacyRows.get(id) || null, applied: appliedBy.get(id) || [] });
    for (let at = 0; at < records.length; at += 5000) writer.append(records.slice(at, at + 5000));
    totals.conversations += 1;
    for (const key of ['events', 'fragmentsIn', 'fragmentBytesIn', 'coalesced', 'coalescedBytes', 'unreadable']) totals[key] += stats[key];
    totals.records += records.length;
    if (stats.snapshot) { totals.snapshots += 1; for (const c of stats.diffColumns) totals.diffColumns[c] = (totals.diffColumns[c] || 0) + 1; }
    fs.appendFileSync(reportFile, `${JSON.stringify({ id, events: nonFragment, first, last, sha256: hash.digest('hex'), fragmentsIn: stats.fragmentsIn, coalesced: stats.coalesced, records: records.length, snapshot: stats.snapshot, diffColumns: stats.diffColumns, hasRow: legacyRows.has(id), applied: (appliedBy.get(id) || []).length })}\n`);
    if (totals.conversations % 100 === 0) progress(`[backfill] ${totals.conversations}/${list.length} conversations, ${Math.round((Date.now() - started) / 1000)} s`);
  }
  db.exec('COMMIT');
  writer.index.setMeta('backfill_through', through);
  writer.index.setMeta('ingested_through', Math.max(through, Number(writer.index.meta('ingested_through') || 0)));
  writer.index.setMeta('legacy_sequence', sequence);
  writer.index.setMeta('backfill_source', path.resolve(source));
  writer.index.setMeta('backfill_at', new Date().toISOString());
  writer.close();

  return { source, dir, indexPath, through, legacySequence: sequence, seconds: Math.round((Date.now() - started) / 1000), ...totals };
}
