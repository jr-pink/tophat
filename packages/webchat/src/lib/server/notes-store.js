import { releaseWalStore, walStore } from './sqlite-checkpointer.js';
import { reorderTree } from '../core/notes-reorder.js';
import { historyDelta, historyPatches } from '../core/notes-history.js';
// The notes store: one continuous chronological document, kept as LINES.
//
// A line is the thing that is stored: its own id, created_at, updated_at, order (a float), indent,
// a marker state re-parsed from its text, a gap flag and a soft delete. A block -- the chunk he
// types in, the one two blank lines end -- is derived from the lines and their gap flags, and is
// named by its first line, so a block id stays a stable handle for the page, the chat chip and the
// DOM while the text inside it is rows that can move on their own. That is the model the docstore
// notes app settled on (apps/notesapp/app.py): order is a float, the sort key is (order, id), kind
// and todo_done are re-parsed from the body, a delete is an archive, and setting a field to the
// value it already holds is a true no-op with no updated_at bump.
//
// Like the reader's notes, every write is appended to a JSON-lines journal and fsynced before the
// sqlite row is touched, and a delete is a soft delete. rebuildFromJournal() puts it back. Nothing
// in this module rewrites or truncates the journal: the block records written before lines existed
// are still read back, and the migration only appends.

import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { appendJournalLine, releaseJournal } from './journal-append.js';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { webchatStoreDir } from './paths.js';
import {
  blocksFromLines, diffLines, lineFields, lineOrdBetween, moveLine as moveLinePure, newLineId,
  parseListItem
} from '../core/notes-doc.js';

import * as Automerge from '@automerge/automerge';
import {
  applyLines, bootstrap, decodeDoc, encodeDoc, hash128, isDoc, mergeDocs, project, sameLineage, useAutomerge
} from '../core/notes-crdt.js';
import { outline } from '../client/notes-fold.js';
import { notesDay } from '../core/notes-time.js';

useAutomerge(Automerge);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS notes_actions (
 token TEXT PRIMARY KEY, owner TEXT NOT NULL, delta TEXT NOT NULL,
 undone INTEGER NOT NULL, valid INTEGER NOT NULL DEFAULT 1,
 position INTEGER NOT NULL, revision INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS notes_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- The block's text as an Automerge document (src/lib/core/notes-crdt.js), keyed by the id of the
-- block's first line, base64. The lines table stays what everything else reads (search, tasks,
-- history, the state builder); this is what two devices' edits to one block are merged in. A doc
-- whose \`rows_hash\` is not the hash of the block's rows now was left behind by a write that did not
-- go through it (a move, an undo, an agent), and is brought up to date by diffing the rows into it.
CREATE TABLE IF NOT EXISTS block_docs (
  head      TEXT PRIMARY KEY,
  doc       TEXT NOT NULL,
  rows_hash TEXT NOT NULL,
  at        TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS blocks (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL DEFAULT 'text',   -- text | break
  body        TEXT NOT NULL DEFAULT '',
  ord         REAL NOT NULL,                  -- document order within the zone; an insert is a midpoint
  zone        TEXT NOT NULL DEFAULT 'timeline', -- timeline (what happened) | future (today block and beyond) | state
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT,
  source      TEXT NOT NULL DEFAULT 'type',   -- type | dictation | import
  chat_id     TEXT,                           -- the chat ⌘↵ started from this block, if any
  seq         INTEGER NOT NULL DEFAULT 0
);
CREATE VIRTUAL TABLE IF NOT EXISTS block_fts USING fts5(
  id UNINDEXED, body, tokenize = 'porter unicode61'
);
CREATE TABLE IF NOT EXISTS lines (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL DEFAULT 'text',   -- text | break (a page rule is a line of its own)
  body        TEXT NOT NULL DEFAULT '',       -- one written line of markdown, never a newline
  ord         REAL NOT NULL,                  -- order within the zone; an insert is a midpoint
  indent      INTEGER NOT NULL DEFAULT 0,     -- re-derived from the body on every write
  gap_after   INTEGER NOT NULL DEFAULT 0,     -- 1 ends the block after this line
  zone        TEXT NOT NULL DEFAULT 'timeline',
  created_at  TEXT NOT NULL,                  -- the line's own; it survives an edit to its block
  updated_at  TEXT NOT NULL,                  -- bumped by any mutating op, never by a no-op
  deleted_at  TEXT,                           -- the archive; a delete is reversible
  source      TEXT NOT NULL DEFAULT 'type',   -- type | dictation | import | system
  chat_id     TEXT,                           -- the chat ⌘↵ started from the block this line heads
  task_id     TEXT,                           -- the shared rev5 work item this line projects, if any
  seq         INTEGER NOT NULL DEFAULT 0
);
CREATE VIRTUAL TABLE IF NOT EXISTS line_fts USING fts5(
  id UNINDEXED, body, tokenize = 'porter unicode61'
);
`;

// Indexes come after the zone migration below, because a store written before the future area
// existed has no zone column for them to name.
const INDEXES = `
CREATE INDEX IF NOT EXISTS blocks_live_ord ON blocks(zone, ord) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS blocks_by_day ON blocks(created_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS lines_live_ord ON lines(zone, ord) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS lines_by_day ON lines(created_at) WHERE deleted_at IS NULL;
`;

// The zones the document is walked in, in the order they stand on the page. Anything that looks
// up a block or counts the document walks all three, or a state block would be invisible to the
// page that edits it.
const ZONES = ['past', 'timeline', 'future', 'state'];

export function notesStoreDir({ env = process.env, home = homedir() } = {}) {
  return env.TOPHAT_STATE_DIR ? join(env.TOPHAT_STATE_DIR, 'webchat') : webchatStoreDir({ env, home });
}
export const notesDbPath = (options) => join(notesStoreDir(options), 'notes.sqlite');
export const notesJournalPath = (options) => join(notesStoreDir(options), 'notes-journal.jsonl');

const nowIso = () => new Date().toISOString();

/**
 * Append one record to the journal before anything else happens: written into the file at once, so
 * it precedes the SQLite row; fsynced off the event loop (journal-append.js says why and what that
 * costs).
 */
function appendJournal(path, record) {
  appendJournalLine(path, record);
}

export function readJournal(path) {
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { out.push(JSON.parse(trimmed)); } catch { /* a torn last line is skipped, never rewritten */ }
  }
  return out;
}

/** The line as the rest of the app sees it: the row, plus what its body says about it. */
/**
 * Two devices, one block, both offline. Each write names the block's whole line list, and a row
 * no entry names is archived -- so the second device to reconnect used to archive every line the
 * first one added. `base` is the list of line ids the writing device last saw the block with. A
 * stored line outside it was written by someone else since; a stored line inside it that the
 * entries leave out is one this device deleted. The first kind is kept, slotted in after the
 * nearest line above it that the write still names, which is how a CRDT sequence treats a
 * concurrent insert. With no `base` the write is the old full replacement.
 */
export function mergeConcurrent(existing, entries, base) {
  if (!Array.isArray(base) || !Array.isArray(entries) || !existing?.length) return entries;
  const known = new Set(base);
  const out = entries.map((entry) => ({ ...entry }));
  const named = new Set(out.map((entry) => entry.id).filter(Boolean));
  // A stored line the writer never saw whose words are exactly a new line of this write is that
  // line, not a second one: the same write replayed after its answer was lost, or a write that
  // left before the answer to the previous one named the row it made. Claiming it keeps a replay
  // idempotent instead of doubling every line it added.
  for (const line of existing) {
    if (named.has(line.id) || known.has(line.id)) continue;
    const twin = out.find((entry) => !entry.id && entry.body === line.body);
    if (twin) { twin.id = line.id; named.add(line.id); }
  }
  let anchor = null;
  for (const line of existing) {
    if (named.has(line.id)) { anchor = line.id; continue; }
    if (known.has(line.id)) continue;
    const at = anchor === null ? Math.min(1, out.length) : out.findIndex((entry) => entry.id === anchor) + 1;
    const insertAt = at <= 0 ? out.length : at;
    out.splice(insertAt, 0, { id: line.id, body: line.body, createdAt: line.createdAt || null });
    named.add(line.id);
    anchor = line.id;
  }
  return out;
}

export const lineShape = (row) => {
  if (!row) return null;
  const derived = lineFields(row.body);
  return {
    id: row.id,
    kind: row.kind || 'text',
    body: row.body,
    ord: row.ord,
    indent: Number(row.indent || 0),
    gapAfter: !!row.gap_after,
    zone: row.zone || 'timeline',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at || null,
    source: row.source || 'type',
    chatId: row.chat_id || null,
    taskId: row.task_id || null,
    textKind: derived.kind,
    todoDone: derived.todoDone
  };
};

const blockShape = (row) => row && ({
  id: row.id,
  kind: row.kind,
  body: row.body,
  ord: row.ord,
  zone: row.zone || 'timeline',
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  deletedAt: row.deleted_at || null,
  source: row.source,
  chatId: row.chat_id || null
});

// The fields a patch may touch, and the no-op rule: a write that changes none of them is not a
// write at all. docstore tests that invariant on every setter; here it is one comparison.
const PATCHABLE = ['kind', 'body', 'ord', 'indent', 'gapAfter', 'zone', 'createdAt', 'source', 'chatId', 'taskId'];

/** How many leading lines a node's tree covers. Indented children are the outline's; on top of that
 * a plain (non-bullet) line takes the unindented bullets directly under it, because those read as
 * its list.
 */
function treeSpan(candidates, node) {
  let end = node.descendants + 1;
  const isBullet = (body) => /^\s*(?:[-*+]|\d+[.)])\s/u.test(String(body ?? ''));
  if (isBullet(candidates[0]?.body) || /^\s/u.test(String(candidates[0]?.body ?? ''))) return end;
  while (end < candidates.length && isBullet(candidates[end].body) && !/^\s/u.test(candidates[end].body)) {
    end += 1;
    while (end < candidates.length && /^\s/u.test(candidates[end].body)) end += 1;
  }
  return end;
}

/** treeSpan, stopped at the end of the block the first line is in. A block ends at its gap (the
 * blank lines after it), whatever follows: a bullet, a lone bullet, plain text. Only indented
 * lines, which cannot start a block, still belong to the tree.
 */
function blockTreeSpan(candidates, node) {
  let span = treeSpan(candidates, node);
  const gap = candidates.findIndex(line => line.gapAfter);
  if (gap >= 0 && span > gap + 1) {
    span = gap + 1;
    while (span < candidates.length && /^\s/u.test(candidates[span].body)) span += 1;
  }
  return span;
}

/** One patch per line: two touches of the same row in one batch become one row write. */
function mergePatches(patches) {
  const merged = new Map();
  for (const patch of patches) merged.set(patch.id, { ...(merged.get(patch.id) || {}), ...patch });
  return [...merged.values()];
}

// Every write any store in this process makes, told to whoever listens: the live feed
// (src/lib/server/live-feed.js) turns it into a push to every open notes page. A write from another
// process (scripts/state.mjs) never passes through here; the feed notices those by PRAGMA data_version.
const writeListeners = new Set();
export function onNotesWrite(listener) {
  writeListeners.add(listener);
  return () => writeListeners.delete(listener);
}

// `notify: false` keeps a store's writes out of the process-wide listeners above, which feed his
// own notes pages: a public document (src/lib/server/docs.js) is the same store code over another
// file, and its writes must never wake, or reach, the owner's notes feed.
export function openNotesStore(path = notesDbPath(), { journal = notesJournalPath(), notify = true } = {}) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  walStore(db, path);
  db.exec(SCHEMA);
  // A store written before the future area existed has no zone column; everything in it is
  // timeline, which is exactly the default.
  const columns = db.prepare('PRAGMA table_info(blocks)').all().map((row) => row.name);
  if (!columns.includes('zone')) db.exec(`ALTER TABLE blocks ADD COLUMN zone TEXT NOT NULL DEFAULT 'timeline'`);
  // A store written before ⌘↵ started chats has no chat_id; a block without one simply has no chat.
  if (!columns.includes('chat_id')) db.exec('ALTER TABLE blocks ADD COLUMN chat_id TEXT');
  // A line written before shared work existed carries no binding, which is exactly "not a task".
  const lineColumns = db.prepare('PRAGMA table_info(lines)').all().map((row) => row.name);
  if (!lineColumns.includes('task_id')) db.exec('ALTER TABLE lines ADD COLUMN task_id TEXT');
  db.exec(INDEXES);

  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const one = (sql, ...args) => db.prepare(sql).get(...args);

  let pendingJournal = null;
  let taskEditObserver = null;
  const emitJournal = record => {
    if (pendingJournal) pendingJournal.push(record);
    else appendJournal(journal, record);
    if (!notify) return;
    for (const listener of writeListeners) { try { listener(record); } catch { /* a listener never fails a write */ } }
  };
  function writeAction(action) {
    if (!action) return;
    if (action.fresh) run('UPDATE notes_actions SET valid = 0 WHERE owner = ? AND undone = 1', action.owner);
    run(`INSERT OR REPLACE INTO notes_actions(token, owner, delta, undone, valid, position, revision)
      VALUES (?, ?, ?, ?, 1, ?, ?)`, action.token, action.owner, JSON.stringify(action.delta),
      action.undone ? 1 : 0, action.position, action.revision);
  }
  // The row effects and the action that explains them share one fsynced record. SQLite is a
  // projection: an interrupted commit can be reconstructed without losing an undo transition.
  function actionTransaction(change, describe) {
    if (pendingJournal) throw new Error('Nested notes action');
    db.exec('SAVEPOINT notes_action');
    pendingJournal = [];
    try {
      const beforeTasks = taskEditObserver ? store.historySnapshot() : null;
      const result = change();
      if (taskEditObserver) taskEditObserver(beforeTasks, store.historySnapshot());
      const action = describe();
      const records = pendingJournal;
      if (records.length || action) appendJournal(journal, { op: 'notes-action', at: nowIso(), records, action });
      writeAction(action);
      db.exec('RELEASE notes_action');
      return { result, token: action?.token || null };
    } catch (error) {
      db.exec('ROLLBACK TO notes_action; RELEASE notes_action');
      throw error;
    } finally { pendingJournal = null; }
  }
  const nextActionRevision = () => Number(one('SELECT COALESCE(MAX(revision), 0) + 1 AS n FROM notes_actions').n);

  const nextSeq = () => {
    const lines = Number(one('SELECT COALESCE(MAX(seq), 0) AS n FROM lines')?.n || 0);
    const blocks = Number(one('SELECT COALESCE(MAX(seq), 0) AS n FROM blocks')?.n || 0);
    return Math.max(lines, blocks) + 1;
  };

  // --- the line rows ----------------------------------------------------------------------------

  const rowOf = (id) => one('SELECT * FROM lines WHERE id = ?', id);
  const shapeOf = (id) => lineShape(rowOf(id));

  function indexLine(line) {
    run('DELETE FROM line_fts WHERE id = ?', line.id);
    if (!line.deletedAt && line.kind !== 'break' && line.body.trim()) {
      run('INSERT INTO line_fts (id, body) VALUES (?,?)', line.id, line.body);
    }
  }

  function writeRow(line, seq) {
    run(`INSERT INTO lines (id, kind, body, ord, indent, gap_after, zone, created_at, updated_at,
                            deleted_at, source, chat_id, task_id, seq)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind, body = excluded.body, ord = excluded.ord, indent = excluded.indent,
           gap_after = excluded.gap_after, zone = excluded.zone, created_at = excluded.created_at,
           updated_at = excluded.updated_at, deleted_at = excluded.deleted_at,
           source = excluded.source, chat_id = excluded.chat_id, task_id = excluded.task_id,
           seq = excluded.seq`,
      line.id, line.kind, line.body, line.ord, line.indent, line.gapAfter ? 1 : 0, line.zone,
      line.createdAt, line.updatedAt, line.deletedAt, line.source, line.chatId, line.taskId ?? null, seq);
    indexLine(line);
  }

  /** A new line. created_at and updated_at are both the moment it was written (docstore's stamp). */
  function insertLine(fields) {
    const at = nowIso();
    const body = typeof fields.body === 'string' ? fields.body : '';
    const line = {
      id: fields.id || newLineId(),
      kind: fields.kind || 'text',
      body,
      ord: Number(fields.ord),
      indent: fields.indent ?? lineFields(body).indent,
      gapAfter: !!fields.gapAfter,
      zone: fields.zone || 'timeline',
      createdAt: fields.createdAt || at,
      updatedAt: fields.updatedAt || at,
      deletedAt: fields.deletedAt || null,
      source: fields.source || 'type',
      chatId: fields.chatId ?? null,
      taskId: fields.taskId ?? null
    };
    const seq = fields.seq ?? nextSeq();
    emitJournal({ seq, at, op: fields.op || 'create', line });
    writeRow(line, seq);
    return line;
  }

  /**
   * Change one line. Any field that really changes bumps updated_at; a patch that changes nothing
   * is a no-op that touches neither the journal nor the row, so a save he did not mean leaves no
   * delta behind.
   */
  function patchLine(id, patch) {
    const current = shapeOf(id);
    if (!current) return null;
    const next = { ...current, ...patch };
    if (patch.body !== undefined && patch.indent === undefined) next.indent = lineFields(next.body).indent;
    const changed = PATCHABLE.some((field) => next[field] !== current[field]);
    if (!changed) return current;
    const at = nowIso();
    const seq = nextSeq();
    next.updatedAt = at;
    emitJournal({ seq, at, op: 'update', line: next });
    writeRow(next, seq);
    return next;
  }

  /** The archive: soft, reversible, and a second archive of the same line is a no-op. */
  function archiveLine(id) {
    const current = shapeOf(id);
    if (!current || current.deletedAt) return false;
    const at = nowIso();
    const seq = nextSeq();
    const next = { ...current, deletedAt: at, updatedAt: at };
    emitJournal({ seq, at, op: 'delete', line: next });
    writeRow(next, seq);
    return true;
  }

  function restoreLine(id) {
    const current = shapeOf(id);
    if (!current || !current.deletedAt) return false;
    const at = nowIso();
    const seq = nextSeq();
    const next = { ...current, deletedAt: null, updatedAt: at };
    emitJournal({ seq, at, op: 'restore', line: next });
    writeRow(next, seq);
    return true;
  }

  // --- reading ----------------------------------------------------------------------------------

  const liveLines = (zone) => all(
    'SELECT * FROM lines WHERE deleted_at IS NULL AND zone = ? ORDER BY ord ASC, id ASC', zone
  ).map(lineShape);

  const allLines = (zone) => all(
    'SELECT * FROM lines WHERE zone = ? ORDER BY ord ASC, id ASC', zone
  ).map(lineShape);

  const blocksIn = (zone) => blocksFromLines(liveLines(zone));

  // Paging in SQL, not in memory. `liveLines` is fine for the short zones, but the timeline and
  // the past are the ones that grow without bound, and reading a gigabyte of rows to answer with
  // the last screenful is the thing that makes a big document unopenable. These walk the
  // (zone, ord) index with a LIMIT, so the cost of a page is the page.
  //
  // A block is a run of lines ending at a gap flag, so a page that starts mid-block would hand
  // the browser half a block and a wrong block id: after taking `limit` rows the walk extends
  // upwards, line by line, until the row above it ends a block (or there is nothing above).
  function pageLines(zone, { limit = 200, before = null, after = null, fromStart = false } = {}) {
    const rows = fromStart
      ? all('SELECT * FROM lines WHERE deleted_at IS NULL AND zone = ? ORDER BY ord ASC, id ASC LIMIT ?', zone, limit)
      : after !== null
      ? all('SELECT * FROM lines WHERE deleted_at IS NULL AND zone = ? AND ord > ? ORDER BY ord ASC, id ASC LIMIT ?', zone, after, limit)
      : before !== null
        ? all('SELECT * FROM lines WHERE deleted_at IS NULL AND zone = ? AND ord < ? ORDER BY ord DESC, id DESC LIMIT ?', zone, before, limit).reverse()
        : all('SELECT * FROM lines WHERE deleted_at IS NULL AND zone = ? ORDER BY ord DESC, id DESC LIMIT ?', zone, limit).reverse();
    const lines = rows.map(lineShape);
    if (after === null && !fromStart) {
      for (;;) {
        const head = lines[0];
        if (!head) break;
        const prior = one(
          'SELECT * FROM lines WHERE deleted_at IS NULL AND zone = ? AND (ord < ? OR (ord = ? AND id < ?)) ORDER BY ord DESC, id DESC LIMIT 1',
          zone, head.ord, head.ord, head.id
        );
        if (!prior || prior.gap_after) break;
        lines.unshift(lineShape(prior));
      }
    }
    return lines;
  }

  /** How many live lines of a zone sit before / after an ord, counted by sqlite. */
  const countLines = (zone, { before = null, after = null } = {}) =>
    Number(
      before !== null
        ? one('SELECT COUNT(*) AS n FROM lines WHERE deleted_at IS NULL AND zone = ? AND ord < ?', zone, before)?.n
        : after !== null
          ? one('SELECT COUNT(*) AS n FROM lines WHERE deleted_at IS NULL AND zone = ? AND ord > ?', zone, after)?.n
          : one('SELECT COUNT(*) AS n FROM lines WHERE deleted_at IS NULL AND zone = ?', zone)?.n
    ) || 0;

  /**
   * The lines of one block. A block is named by its first line, so the run starts there and ends
   * at the first line whose gap flag is set. Deleted lines are walked only when the block itself
   * is gone, which is what a restore needs.
   */
  function runOf(id, { includeDeleted = false } = {}) {
    for (const zone of ZONES) {
      const block = blocksIn(zone).find((entry) => entry.id === id);
      if (block) return block.lines;
    }
    if (!includeDeleted) return [];
    const head = shapeOf(id);
    if (!head) return [];
    const lines = allLines(head.zone);
    const index = lines.findIndex((line) => line.id === id);
    if (index < 0) return [];
    const out = [];
    for (let at = index; at < lines.length; at += 1) {
      out.push(lines[at]);
      if (lines[at].gapAfter || lines[at].kind === 'break') break;
    }
    return out;
  }

  // --- placing a block --------------------------------------------------------------------------

  /** Put a run of lines where an order value asks for it. The order the page sends is a position
   * among blocks, not among lines, so it is read as "after the last block before it, before the
   * first block after it" and the lines are spread in the gap that leaves. A run that is already
   * between those two neighbours does not move, so saving a block twice writes nothing.
   */
  function placeRun(zone, lines, targetOrd, leaving = new Set()) {
    if (!Number.isFinite(Number(targetOrd)) || lines.length === 0) return;
    const mine = new Set(lines.map((line) => line.id));
    // Rows this same action is archiving are NOT neighbours. They are still live when a block is
    // saved -- they are archived at the end of the batch, because a split or a merge can hand a
    // line's created_at over first -- and a dying row with its head gone derives into a block run
    // that spans half the document, which put the surviving run somewhere else entirely.
    const others = liveLines(zone).filter((line) => !mine.has(line.id) && !leaving.has(line.id));
    const blocks = blocksFromLines(others);
    let before = null;
    let after = null;
    for (const block of blocks) {
      if (block.ord < Number(targetOrd)) before = block.lines[block.lines.length - 1];
      else if (after === null) after = block.lines[0];
    }
    const head = lines[0];
    const tail = lines[lines.length - 1];
    const above = before === null || head.ord > before.ord;
    const below = after === null || tail.ord < after.ord;
    if (above && below && lines.every((line) => line.zone === zone)) return;     // already in place

    let previous = before ? before.ord : null;
    for (let index = 0; index < lines.length; index += 1) {
      const ord = lineOrdBetween(previous, after ? after.ord : null);
      patchLine(lines[index].id, { ord, zone });
      lines[index] = { ...lines[index], ord, zone };
      previous = ord;
    }
  }

  // --- writing a block --------------------------------------------------------------------------

  /**
   * The text a line carried does not lose its age because the block around it was split or merged:
   * a line that disappears from one block in the same batch and reappears in another hands over
   * its created_at to the line that takes its words.
   */
  function claimCreatedAt(orphans, body) {
    if (!body.trim()) return null;
    const index = orphans.findIndex((line) => line.body === body);
    if (index < 0) return null;
    const [taken] = orphans.splice(index, 1);
    archiveLine(taken.id);
    return taken.createdAt;
  }

  /**
   * The lines a write is addressed to, when it carries them: `lines: [{ id, body }, ...]` in
   * document order, which wins over `body`. Ids on the wire are how the page says which stored row
   * each line is, so the store stops guessing it from the words; a line that moves and is edited in
   * the same save keeps its own row, its own id and its own created_at instead of trading them with
   * the line it passed. A page rule is one empty line whatever is sent, so it never reads them.
   */
  function explicitLines(input, kind) {
    if (kind === 'break') return null;
    if (!Array.isArray(input.lines) || input.lines.length === 0) return null;
    return input.lines.map((entry) => ({
      id: typeof entry?.id === 'string' && entry.id.trim() ? entry.id.trim() : null,
      body: typeof entry?.body === 'string' ? entry.body : '',
      createdAt: typeof entry?.createdAt === 'string' && Number.isFinite(Date.parse(entry.createdAt)) ? entry.createdAt : null
    }));
  }

  // --- the block documents -----------------------------------------------------------------------

  const rowsHash = (lines) => hash128(JSON.stringify(lines.map((line) => [line.id, line.body])));
  const docRow = (head) => one('SELECT doc, rows_hash FROM block_docs WHERE head = ?', head);
  function putDoc(head, doc, hash) {
    run(`INSERT INTO block_docs (head, doc, rows_hash, at) VALUES (?, ?, ?, ?)
         ON CONFLICT(head) DO UPDATE SET doc = excluded.doc, rows_hash = excluded.rows_hash, at = excluded.at`,
    head, encodeDoc(doc), hash, nowIso());
  }

  /**
   * The document of the block whose rows are `lines` ([{ id, body }], in order), made if it never
   * existed and brought up to date if rows moved on without it: the rows are diffed into the
   * document (a join is a deleted newline, a typed word an insert), so what an agent, a move or an
   * undo did reaches every device as ordinary edits. Returns `{ doc, b64 }`.
   */
  function docFor(head, lines) {
    const hash = rowsHash(lines);
    const row = docRow(head);
    if (row && row.rows_hash === hash) return { b64: row.doc, doc: null };
    let doc = row ? applyLines(decodeDoc(row.doc), lines, { consume: true }) : bootstrap(head, lines);
    // A document that differs from the rows even now (a line the rows name twice) is rebuilt.
    if (rowsHash(project(doc).lines) !== hash) doc = bootstrap(head, lines);
    putDoc(head, doc, hash);
    return { b64: encodeDoc(doc), doc };
  }
  const loadedDoc = (head, lines) => {
    const got = docFor(head, lines);
    return got.doc || decodeDoc(got.b64);
  };

  /** A block, shaped for the wire, with its document: what a page keeps and edits and sends back. */
  function withDoc(block) {
    if (!block || block.kind === 'break' || !Array.isArray(block.lines) || block.lines.length === 0) return block;
    try { return { ...block, crdt: docFor(block.id, block.lines.map((line) => ({ id: line.id, body: line.body }))).b64 }; }
    catch { return block; }
  }

  /**
   * A write that carries its document. The document is merged into the block's own (a replay or a
   * late arrival changes nothing; two devices' edits to one line, a cut and a join of it, a move,
   * all merge as characters), and the lines it now has are what the rows become. Null when the write
   * has no usable document: the older line merge then applies, and the document catches up from the
   * rows afterwards.
   */
  function mergeCrdtWrite(existing, input, blockId) {
    if (typeof input.crdt !== 'string' || !input.crdt) return null;
    let theirs;
    try { theirs = decodeDoc(input.crdt); } catch { return null; }
    if (!isDoc(theirs)) return null;
    let merged = null;
    if (existing.length === 0) merged = theirs;
    else {
      const ours = loadedDoc(blockId, existing.map((line) => ({ id: line.id, body: line.body })));
      if (sameLineage(ours, theirs)) merged = mergeDocs(ours, theirs, { consume: true });
    }
    if (!merged) return null;
    const born = new Map((Array.isArray(input.lines) ? input.lines : []).map((line) => [line?.id, line?.createdAt]));
    const entries = project(merged).lines.map((line) => ({
      id: line.id, body: line.body, createdAt: typeof born.get(line.id) === 'string' && Number.isFinite(Date.parse(born.get(line.id))) ? born.get(line.id) : null
    }));
    return { doc: merged, entries };
  }

  /** After the rows are written: the document is the rows' document, under the id of the head row. */
  function settleDoc(requestedId, written, merged) {
    if (written.length === 0) return;
    const lines = written.map((line) => ({ id: line.id, body: line.body }));
    const head = lines[0].id;
    const hash = rowsHash(lines);
    let doc = merged;
    if (!doc) {
      const row = docRow(head) || docRow(requestedId);
      doc = row ? decodeDoc(row.doc) : null;
    }
    doc = doc ? (rowsHash(project(doc).lines) === hash ? doc : applyLines(doc, lines, { consume: true })) : bootstrap(head, lines);
    if (rowsHash(project(doc).lines) !== hash) doc = bootstrap(head, lines);
    putDoc(head, doc, hash);
    if (requestedId !== head) run('DELETE FROM block_docs WHERE head = ?', requestedId);
  }

  function saveBlock(input, orphans, runs, claimed) {
    const id = String(input.id || '').trim();
    if (!id) throw new Error('a block id is required');
    const existing = runs.get(id).filter(line => !claimed.has(line.id));
    const kind = input.kind || existing[0]?.kind || 'text';
    const zone = input.zone || existing[0]?.zone || 'timeline';
    // A write that does not say who made it is his hands. It must NOT inherit the block's source:
    // a line he types into a block an agent wrote would come back marked as the agent's, and the
    // page would set it in the machine face and offer it for archiving as not his. Every writer
    // that is not him names itself (the builder passes `system`, an import passes `import`).
    const source = input.source || 'type';
    const crdt = kind === 'break' ? null : mergeCrdtWrite(existing, input, id);
    const entries = crdt ? crdt.entries : mergeConcurrent(existing, explicitLines(input, kind), input.base);
    const bodies = entries ? entries.map((entry) => entry.body)
      : kind === 'break' ? ['']
        : typeof input.body === 'string' ? input.body.split('\n')
          : existing.length > 0 ? existing.map((line) => line.body) : [''];
    const targetOrd = Number.isFinite(Number(input.ord)) ? Number(input.ord)
      : existing.length === 0 ? store.appendOrd(zone) : null;

    // What the block's lines are about to be, in order: rows it already has, and rows for words
    // that are new. The first line of a block keeps its row whatever he types into it, because
    // the block is named by its first line and the page, the chat chip and the DOM hold that name.
    //
    // The source is per line, not per block. A line the diff reports as `keep` did not change, so
    // it keeps the source it already had; only a line that was inserted or rewritten takes the
    // source of this save. That is what makes the system state area safe to regenerate: a line
    // whose source is not `system` is his, and a rewrite that leaves its words alone leaves its
    // ownership alone too, while one line he retypes inside a generated section becomes his.
    const plan = [];
    if (existing.length === 0) {
      for (let index = 0; index < bodies.length; index += 1) {
        const entryId = entries?.[index]?.id;
        const moved = entryId ? orphans.find(line => line.id === entryId) : null;
        if (moved) { plan.push({ line: moved, body: bodies[index], source }); orphans.splice(orphans.indexOf(moved), 1); }
        else plan.push({ fresh: true, id: index === 0 ? id : entryId && !shapeOf(entryId) ? entryId : newLineId(), body: bodies[index], source });
      }
    } else if (entries) {
      // Ids on the wire name stable entities. Rows omitted from another submitted source may
      // transfer here; a new client id is accepted only when it names no stored row. A row
      // no entry names is archived, exactly as the diff's `archive` op archives one.
      //
      // The head is the one place the list does not have the last word: the block is named by its
      // first line and the page, the chat chip and the DOM hold that name, so a first entry that
      // names no row of the block writes into the head row rather than putting a new row above it.
      // A first entry that does name a row of the block is obeyed, even when that row is not the
      // head today -- overwriting the head with a moved line's words is precisely the identity swap
      // this protocol exists to end -- and the block then answers under the id of its new head.
      const live = new Map([...existing, ...orphans].map((line) => [line.id, line]));
      // A line the write names that was archived (an undo's words, written back before the store's
      // own redo) is that line again, not a new one under another id.
      if (crdt) for (const entry of entries) {
        if (!entry.id || live.has(entry.id)) continue;
        const row = rowOf(entry.id);
        if (row && row.deleted_at && (row.zone || 'timeline') === zone && restoreLine(entry.id)) live.set(entry.id, shapeOf(entry.id));
      }
      const claimed = new Map();
      const taken = new Set();
      entries.forEach((entry, index) => {
        if (!entry.id || !live.has(entry.id) || taken.has(entry.id)) return;
        claimed.set(index, live.get(entry.id));
        taken.add(entry.id);
      });
      if (!claimed.has(0) && !taken.has(existing[0].id)) {
        claimed.set(0, existing[0]);
        taken.add(existing[0].id);
      }
      entries.forEach((entry, index) => {
        const line = claimed.get(index);
        if (line) plan.push({ line, body: entry.body, source: entry.body === line.body ? line.source : source });
        else plan.push({ fresh: true, id: entry.id && !shapeOf(entry.id) ? entry.id : newLineId(), body: entry.body, source });
      });
      for (let i = orphans.length - 1; i >= 0; i--) if (taken.has(orphans[i].id)) orphans.splice(i, 1);
    } else {
      // The head line keeps its row whatever happens to it, so it is read as a keep or an update
      // by its words alone; the diff below never sees it.
      const headBody = bodies[0] ?? '';
      plan.push({ line: existing[0], body: headBody, source: headBody === existing[0].body ? existing[0].source : source });
      for (const op of diffLines(existing.slice(1).map((line) => line.body), bodies.slice(1))) {
        if (op.op === 'keep') plan.push({ line: existing[op.from + 1], body: op.body, source: existing[op.from + 1].source });
        else if (op.op === 'update') plan.push({ line: existing[op.from + 1], body: op.body, source });
        else if (op.op === 'insert') plan.push({ fresh: true, id: newLineId(), body: op.body, source });
        else orphans.push(existing[op.from + 1]);
      }
    }

    // New lines land between the neighbours they were written between, which is docstore's midpoint.
    const following = liveLines(zone).filter((line) => !existing.some((entry) => entry.id === line.id));
    const edge = existing.length > 0 ? existing[existing.length - 1].ord : targetOrd;
    const tailOrd = Number.isFinite(Number(edge)) ? following.find((line) => line.ord > edge)?.ord ?? null : null;
    const ordAfter = (from, floor = null) => {
      const above = (ord) => ord !== null && (floor === null || ord > floor);
      for (let at = from + 1; at < plan.length; at += 1) {
        if (!plan[at].line) continue;
        return above(plan[at].line.ord) ? plan[at].line.ord : above(tailOrd) ? tailOrd : null;
      }
      return above(tailOrd) ? tailOrd : null;
    };
    let previous = null;
    const written = [];
    for (let index = 0; index < plan.length; index += 1) {
      const step = plan[index];
      const last = index === plan.length - 1;
      if (step.fresh) {
        const ord = index === 0 && existing.length === 0 && targetOrd !== null
          ? targetOrd
          : lineOrdBetween(previous, ordAfter(index, entries ? previous : null));
        written.push(insertLine({
          id: step.id, kind, body: step.body, ord, gapAfter: last, zone, source: step.source,
          // A line that is new now is stamped now -- unless it is carrying words a line in this
          // same batch was holding, or unless the whole block is new and the page said when.
          createdAt: entries?.[index]?.createdAt || claimCreatedAt(orphans, step.body)
            || (existing.length === 0 ? input.createdAt : null)
            || undefined,
          chatId: index === 0 ? (input.chatId ?? null) : null
        }));
      } else {
        const patch = { body: step.body, kind, gapAfter: last, source: step.source };
        if (entries?.[index]?.createdAt) patch.createdAt = entries[index].createdAt;
        else if (!step.line.body.trim() && step.body.trim()) patch.createdAt = nowIso();
        if (index === 0 && input.chatId !== undefined) patch.chatId = input.chatId;
        // A row addressed by its id can have moved. When it no longer sits after the line above
        // it, it takes the order value between its new neighbours; the diffing path cannot get
        // here, because a diff never reorders the rows it keeps.
        if (entries && previous !== null && step.line.ord <= previous) {
          patch.ord = lineOrdBetween(previous, ordAfter(index, previous));
        }
        written.push(patchLine(step.line.id, patch));
      }
      previous = written[written.length - 1].ord;
    }

    // Where the block sits, and which zone it is in: the page asks for both with one order value.
    const leaving = new Set(orphans.map((line) => line.id));
    if (targetOrd !== null) placeRun(zone, written, targetOrd, leaving);
    else if (written.some((line) => line.zone !== zone)) placeRun(zone, written, store.appendOrd(zone), leaving);

    // Legacy block writes can still supply the head's timestamp. An explicit line transition
    // takes precedence: its date records content creation, clearing/retyping or a merge.
    const head = shapeOf(written[0].id);
    if (!entries?.[0]?.createdAt && input.createdAt && head && input.createdAt !== head.createdAt && existing.length > 0) {
      patchLine(head.id, { createdAt: input.createdAt });
    }
    // The block is named by its first line. That is the id the write asked for in every case but
    // one: an explicit list that moved another of the block's rows to the head, which renames it.
    for (const line of written) claimed.add(line.id);
    if (kind !== 'break') settleDoc(id, written, crdt?.doc || null);
    return store.block(written[0].id) || store.block(id);
  }

  // --- the migration ----------------------------------------------------------------------------

  /**
   * The store as it was: one row per block, its lines inside one body. Every block becomes its
   * lines, each line taking the block's created_at, in order, and the block row is left exactly
   * where it is. It is idempotent by the head line: a block whose first line is already a row is
   * skipped, so opening the store again, or rebuilding it from the journal, migrates nothing
   * twice. Nothing is deleted and the journal is only appended to.
   */
  function migrateBlocksToLines() {
    const rows = all('SELECT * FROM blocks ORDER BY zone ASC, ord ASC, id ASC').map(blockShape);
    let made = 0;
    for (let index = 0; index < rows.length; index += 1) {
      const block = rows[index];
      if (rowOf(block.id)) continue;                        // already a line: migrated before
      const bodies = block.kind === 'break' ? [''] : String(block.body ?? '').split('\n');
      const next = rows.slice(index + 1).find((entry) => (entry.zone || 'timeline') === (block.zone || 'timeline'));
      const span = next && next.ord > block.ord ? next.ord - block.ord : 1;
      const step = span / (bodies.length + 1);
      for (let at = 0; at < bodies.length; at += 1) {
        insertLine({
          op: 'migrate',
          id: at === 0 ? block.id : `${block.id}~${at}`,
          kind: block.kind === 'break' ? 'break' : 'text',
          body: bodies[at],
          ord: block.ord + at * step,
          gapAfter: at === bodies.length - 1,
          zone: block.zone || 'timeline',
          createdAt: block.createdAt,
          updatedAt: block.updatedAt || block.createdAt,
          deletedAt: block.deletedAt || null,
          source: block.source || 'type',
          chatId: at === 0 ? block.chatId : null
        });
        made += 1;
      }
    }
    return made;
  }

  // One fsynced journal record carries the entire move and its boundary changes.
  // Replay applies the same batch, so a crash cannot lose half a subtree.
  function applyBatch(record) {
    db.exec('SAVEPOINT notes_batch');
    try {
      for (const line of record.lines || []) writeRow(line, record.seq);
      for (const [key, value] of Object.entries(record.meta || {})) {
        run('INSERT OR REPLACE INTO notes_meta (key, value) VALUES (?, ?)', key, value);
      }
      db.exec('RELEASE notes_batch');
    } catch (error) { db.exec('ROLLBACK TO notes_batch; RELEASE notes_batch'); throw error; }
  }
  function batch(patches, meta = {}) {
    const at = nowIso();
    const record = { op: 'notes-batch', seq: nextSeq(), at,
      lines: patches.map(patch => ({ ...shapeOf(patch.id), ...patch, updatedAt: at })), meta };
    emitJournal(record);
    applyBatch(record);
  }
  function moveToPast(selected, meta = {}) {
    const ids = new Set(selected.map(line => line.id));
    const patches = [];
    for (const zone of new Set(selected.map(line => line.zone))) {
      const live = liveLines(zone);
      // Deletion closes an interior gap. Only carry an existing paragraph boundary across
      // removed trailing lines; never manufacture a boundary before an interior selection.
      let previous = null;
      for (const line of live) {
        if (!ids.has(line.id)) previous = line;
        else if (line.gapAfter && previous && !previous.gapAfter) {
          patches.push({ id: previous.id, gapAfter: true });
        }
      }
    }
    // Blocks never mix in the past. Each selected line is tagged with the block it came from; a
    // boundary goes wherever the source changes, and the previous archive's tail only joins when
    // it came from the same source block. The rollover (meta.day) keeps its own layout.
    const grouped = !meta.day;
    const sourceOf = new Map();
    const sourceIds = new Map();
    if (grouped) {
      for (const zone of new Set(selected.map(line => line.zone))) {
        for (const block of blocksFromLines(liveLines(zone))) {
          for (const line of block.lines) { sourceOf.set(line.id, block.id); sourceIds.set(block.id, block.lines.map(l => l.id)); }
        }
      }
    }
    const pastLive = liveLines('past');
    const tail = pastLive[pastLive.length - 1];
    let ord = store.appendOrd('past');
    const gapFor = (line, i) => {
      if (!grouped) return !!line.gapAfter;
      const next = selected[i + 1];
      if (next && sourceOf.get(next.id) !== sourceOf.get(line.id)) return true;
      return !!line.gapAfter;
    };
    if (grouped && tail && !tail.gapAfter) {
      let joins = false;
      try {
        const last = JSON.parse(one("SELECT value FROM notes_meta WHERE key = 'past-tail-source'")?.value || 'null');
        const first = selected[0];
        const srcIds = first ? sourceIds.get(sourceOf.get(first.id)) || [] : [];
        joins = !!last && last.tail === tail.id && srcIds.some(id => last.ids.includes(id));
      } catch { joins = false; }
      if (!joins) patches.push({ id: tail.id, gapAfter: true });
    }
    selected.forEach((line, i) => patches.push({ id: line.id, zone: 'past', ord: ord++, gapAfter: gapFor(line, i) }));
    if (grouped && selected.length) {
      const lastLine = selected[selected.length - 1];
      meta = { ...meta, 'past-tail-source': JSON.stringify({ tail: lastLine.id, ids: sourceIds.get(sourceOf.get(lastLine.id)) || [] }) };
    }
    batch(patches, meta);
  }

  /**
   * The mirror of moveToPast: the lines go to the very top of the future area, in the order given,
   * as one block of their own. Ords count down from the future's current first line, so nothing
   * already there is rewritten.
   */
  function moveToFutureTop(selected, meta = {}) {
    const ids = new Set(selected.map(line => line.id));
    const patches = [];
    for (const zone of new Set(selected.map(line => line.zone))) {
      let previous = null;
      for (const line of liveLines(zone)) {
        if (!ids.has(line.id)) previous = line;
        else if (line.gapAfter && previous && !previous.gapAfter) patches.push({ id: previous.id, gapAfter: true });
      }
    }
    const rest = liveLines('future').filter(line => !ids.has(line.id));
    const first = rest.length ? Math.floor(rest[0].ord) : 1;
    selected.forEach((line, i) => patches.push({ id: line.id, zone: 'future', ord: first - selected.length + i,
      gapAfter: i === selected.length - 1 || line.gapAfter }));
    batch(patches, meta);
  }

  const store = {
    db,
    observeTaskEdits(observer) { taskEditObserver = observer; },
    path,
    journalPath: journal,

    close() { releaseJournal(journal); releaseWalStore(path); db.close(); },

    // Evidence imports create ordinary note lines and never rewrite an existing task.
    // The coverage receipt shares the journal transaction with the note, including replay.
    importEvidenceTask({ scope, evidence, body, generation = 0 }) {
      if (typeof scope !== 'string' || !scope || !Array.isArray(evidence) ||
          evidence.some(value => typeof value !== 'string' || !value) ||
          typeof body !== 'string' || !body.startsWith('- [ ] ') || body.includes('\n')) {
        throw new Error('Invalid evidence task');
      }
      const key = `evidence-task:${scope}`;
      const covered = JSON.parse(one('SELECT value FROM notes_meta WHERE key = ?', key)?.value || '[]');
      const fresh = [...new Set(evidence)].filter(value => !covered.includes(value));
      if (!fresh.length) return null;
      // Generation 0 is the scope's first line and keeps its historical id. A later generation is a
      // NEW ask in the same conversation after the earlier one was closed (reply-sync decides that);
      // it is a line of its own, so closing one never closes or reopens the other.
      if (!Number.isInteger(generation) || generation < 0) throw new Error('Invalid evidence task');
      let id = `thread-chat-${createHash('sha256').update(JSON.stringify(generation ? [scope, generation] : scope)).digest('hex')}`;
      // Older imports hashed the evidence too. Find their scope receipt and keep the line's id;
      // even an archived line still owns its scope. Existing duplicates are not ours to merge.
      if (!generation && !shapeOf(id)) {
        const prior = all("SELECT key, value FROM notes_meta WHERE key LIKE 'evidence-note:%' ORDER BY key")
          .find(row => JSON.parse(row.value).scope === scope && shapeOf(row.key.slice('evidence-note:'.length)));
        if (prior) id = prior.key.slice('evidence-note:'.length);
      }
      const existing = shapeOf(id);
      const receipt = store.evidenceFor(id);
      const at = nowIso();
      batch(existing ? [] : [{ id, kind: 'text', body, ord: store.appendOrd('state'), indent: 0,
        gapAfter: true, zone: 'state', createdAt: at, deletedAt: null, source: 'import', chatId: null }], {
        [key]: JSON.stringify([...new Set([...covered, ...fresh])]),
        [`evidence-note:${id}`]: JSON.stringify({ scope, evidence: [...new Set([...(receipt?.evidence || []), ...fresh])],
          importedAt: receipt?.importedAt || at, ...(generation ? { generation } : receipt?.generation ? { generation: receipt.generation } : {}) })
      });
      return store.block(id);
    },
    /**
     * Every conversation line the evidence importer ever made, by scope, oldest first, closed and
     * deleted ones included: the scope's receipts are the identity, not the line's current text.
     * `generation` is 0 for the first ask in a conversation and counts up for each later one.
     */
    replyLines() {
      const byScope = new Map();
      for (const row of all("SELECT key, value FROM notes_meta WHERE key LIKE 'evidence-note:%'")) {
        const receipt = JSON.parse(row.value);
        const line = shapeOf(row.key.slice('evidence-note:'.length));
        if (!line || typeof receipt.scope !== 'string') continue;
        if (!byScope.has(receipt.scope)) byScope.set(receipt.scope, []);
        byScope.get(receipt.scope).push({ ...line, generation: receipt.generation || 0 });
      }
      for (const lines of byScope.values()) lines.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
      return byScope;
    },
    evidenceFor(id) {
      const record = one('SELECT value FROM notes_meta WHERE key = ?', `evidence-note:${id}`);
      return record ? JSON.parse(record.value) : null;
    },

    /**
     * The shared work item a line projects. The binding is the line's own column, written through
     * the same journal as its words, so a rebuild keeps it; it is a POINTER, never a second copy
     * of the task's status, owner or text. An unbound line is ordinary writing and nothing here
     * makes it a task.
     */
    bindLine(lineId, taskId) {
      const line = shapeOf(lineId);
      if (!line) throw new Error('no such line');
      if (typeof taskId !== 'string' || !taskId.trim()) throw new Error('a binding needs a task id');
      if (line.taskId && line.taskId !== taskId) throw new Error(`line ${lineId} is already bound to ${line.taskId}`);
      return patchLine(lineId, { taskId });
    },
    taskVersion(taskId, version = null) {
      const value = one('SELECT value FROM notes_meta WHERE key = ?', `task-version:${taskId}`)?.value;
      if (Number.isInteger(version) && Number(value) !== version) batch([], { [`task-version:${taskId}`]: String(version) });
      return Number.isInteger(version) ? version : value == null ? null : Number(value);
    },
    taskLine(taskId) {
      return all('SELECT * FROM lines WHERE task_id = ? ORDER BY ord ASC, id ASC', taskId).map(lineShape)[0] || null;
    },

    /**
     * One shared-task operation, durable before it is attempted. The line's new words and the
     * operation that has to reach the work store are one fsynced journal record, so a crash
     * between them is impossible: either both are there to be replayed, or neither happened.
     * The operation id is the caller's retry identity and the work store's receipt key, so
     * delivering the same record twice is the same operation, never a second one.
     */
    recordTaskOp(op, patches = []) {
      if (!op?.opId || !op?.taskId) throw new Error('a task operation needs opId and taskId');
      const record = { ...op, at: nowIso(), state: 'pending' };
      batch(patches, { [`task-op:${op.opId}`]: JSON.stringify(record) });
      return record;
    },
    /** Several line patches in one fsynced journal record, for a caller that is not a block save. */
    patchLines(patches) {
      if (!Array.isArray(patches) || !patches.length) return [];
      batch(patches);
      return patches.map((patch) => shapeOf(patch.id));
    },
    taskOp(opId) {
      const row = one('SELECT value FROM notes_meta WHERE key = ?', `task-op:${opId}`);
      return row ? JSON.parse(row.value) : null;
    },
    /** Operations still owed to the work store, oldest first. A conflict stays for review. */
    pendingTaskOps({ includeConflicts = false } = {}) {
      return all("SELECT key, value FROM notes_meta WHERE key LIKE 'task-op:%'")
        .map((row) => JSON.parse(row.value))
        .filter((op) => op.state === 'pending' || (includeConflicts && op.state === 'conflict'))
        .sort((a, b) => (a.at < b.at ? -1 : 1));
    },
    /** Note something about an owed operation without claiming it has been settled. */
    markTaskOp(opId, patch) {
      const current = store.taskOp(opId);
      if (!current) return null;
      const next = { ...current, ...patch };
      batch([], { [`task-op:${opId}`]: JSON.stringify(next) });
      return next;
    },
    settleTaskOp(opId, outcome) {
      return store.markTaskOp(opId, { ...outcome, settledAt: nowIso() });
    },

    past({ limit = 100, before = null } = {}) {
      return blocksIn('past').filter(block => before === null || block.ord < before).slice(-limit);
    },
    pastCountBefore(ord = Infinity) {
      return blocksIn('past').filter(block => block.ord < ord).length;
    },
    // A day starts at 04:00 local time. The browser requests this only after editing settles.
    rollover(at = new Date()) {
      const day = notesDay(at);
      const previous = one("SELECT value FROM notes_meta WHERE key = 'day'")?.value;
      if (previous && day <= previous) return false;
      if (!previous) {
        // Preserve today's existing writing; older blocks begin in Past.
        const old = blocksIn('timeline').filter(block => notesDay(new Date(block.createdAt)) < day);
        moveToPast(old.flatMap(block => block.lines), { day });
      } else {
        moveToPast(liveLines('timeline'), { day });
      }
      return true;
    },
    archiveTree(blockId, index) {
      return store.archiveTrees([{ block: blockId, index }]);
    },
    archiveTrees(targets) {
      if (!Array.isArray(targets)) return null;
      const ids = new Set();
      for (const target of targets) {
        const block = store.block(target?.block);
        const index = target?.index;
        if (!block || !['timeline', 'future'].includes(block.zone)) continue;
        if (!Number.isInteger(index) || index < 0 || !block.lines[index]) continue;
        const live = liveLines(block.zone);
        const start = live.findIndex(line => line.id === block.lines[index].id);
        const rest = live.slice(start);
        const boundary = rest.findIndex(line => line.kind === 'break');
        const candidates = boundary < 0 ? rest : rest.slice(0, boundary);
        const node = outline(candidates.map(line => line.body))[0];
        if (!node) continue;
        for (const line of candidates.slice(0, blockTreeSpan(candidates, node))) ids.add(line.id);
      }
      const selected = ['timeline', 'future'].flatMap(zone => liveLines(zone)).filter(line => ids.has(line.id));
      if (!selected.length) return null;
      moveToPast(selected);
      return selected.map(line => line.id);
    },
    /** A document's archive is a line in the document, not another zone. The tree each target names
     * (the line and its indented children, found the way archiveTrees finds them) moves to directly
     * after the first line whose trimmed body is the marker, above everything archived before it,
     * so the archive reads newest first. No marker in the zone, or a target already below the
     * marker, moves nothing. Only the moved lines (and the line that closes a gap they left) are
     * written: the rest of the document keeps its rows, its order and its authors.
     */
    archiveToMarker(targets, { marker = '@@archive' } = {}) {
      if (!Array.isArray(targets)) return null;
      const byZone = new Map();
      for (const target of targets) {
        const block = store.block(target?.block);
        const index = target?.index;
        if (!block || block.zone === 'state') continue;
        if (!Number.isInteger(index) || index < 0 || !block.lines[index]) continue;
        const live = byZone.get(block.zone)?.live || liveLines(block.zone);
        const markerAt = live.findIndex(line => line.kind !== 'break' && line.body.trim() === marker);
        if (markerAt < 0) continue;
        const start = live.findIndex(line => line.id === block.lines[index].id);
        if (start < 0 || start >= markerAt) continue;
        const rest = live.slice(start, markerAt);
        const boundary = rest.findIndex(line => line.kind === 'break');
        const candidates = boundary < 0 ? rest : rest.slice(0, boundary);
        const node = outline(candidates.map(line => line.body))[0];
        if (!node) continue;
        const entry = byZone.get(block.zone) || { live, markerAt, ids: new Set() };
        for (const line of candidates.slice(0, blockTreeSpan(candidates, node))) entry.ids.add(line.id);
        byZone.set(block.zone, entry);
      }
      const patches = [];
      const moved = [];
      for (const { live, markerAt, ids } of byZone.values()) {
        if (!ids.size) continue;
        const moving = live.filter(line => ids.has(line.id));
        const rest = live.filter(line => !ids.has(line.id));
        // The hole closes the way moveToPast closes it: an existing boundary carries back over the
        // removed lines; no boundary is manufactured before an interior selection.
        let previous = null;
        for (const line of live) {
          if (!ids.has(line.id)) previous = line;
          else if (line.gapAfter && previous && !previous.gapAfter) patches.push({ id: previous.id, gapAfter: true });
        }
        const at = rest.findIndex(line => line.id === live[markerAt].id);
        const markerLine = rest[at];
        const below = rest[at + 1] || null;
        // Midpoints between the marker and what already sits under it; once those run out of
        // room the zone is renumbered whole, as a drag move does.
        let ords;
        const room = below ? (below.ord - markerLine.ord) / (moving.length + 1) : 1;
        if (room > 1e-7) ords = moving.map((_, i) => markerLine.ord + room * (i + 1));
        else {
          const order = [...rest.slice(0, at + 1), ...moving, ...rest.slice(at + 1)];
          order.forEach((line, i) => { if (!ids.has(line.id) && line.ord !== i + 1) patches.push({ id: line.id, ord: i + 1 }); });
          ords = moving.map(line => order.indexOf(line) + 1);
        }
        // The marker's block stays one block: the moved tree takes the marker's closing gap, if
        // it had one, so the lines under the marker keep reading as one run.
        moving.forEach((line, i) => {
          const last = i === moving.length - 1;
          patches.push({ id: line.id, ord: ords[i], gapAfter: last ? !!markerLine.gapAfter : !!line.gapAfter });
        });
        if (markerLine.gapAfter) patches.push({ id: markerLine.id, gapAfter: false });
        moved.push(...moving.map(line => line.id));
      }
      if (!moved.length) return null;
      batch(mergePatches(patches));
      return moved;
    },
    /** ⌘O, the opposite of ⌘E: the tree under the caret or pointer leaves the timeline, the past or
     * lower down the future and lands at the top of the future area, under NEXT.
     */
    promoteTrees(targets) {
      if (!Array.isArray(targets)) return null;
      const zones = ['timeline', 'future', 'past'];
      const ids = new Set();
      for (const target of targets) {
        const block = store.block(target?.block);
        const index = target?.index;
        if (!block || !zones.includes(block.zone)) continue;
        if (!Number.isInteger(index) || index < 0 || !block.lines[index]) continue;
        const live = liveLines(block.zone);
        const start = live.findIndex(line => line.id === block.lines[index].id);
        if (start < 0) continue;
        const rest = live.slice(start);
        const boundary = rest.findIndex(line => line.kind === 'break');
        const candidates = boundary < 0 ? rest : rest.slice(0, boundary);
        const node = outline(candidates.map(line => line.body))[0];
        if (!node) continue;
        for (const line of candidates.slice(0, blockTreeSpan(candidates, node))) ids.add(line.id);
      }
      const selected = zones.flatMap(zone => liveLines(zone)).filter(line => ids.has(line.id));
      if (!selected.length) return null;
      moveToFutureTop(selected);
      return selected.map(line => line.id);
    },

    /**
     * One page of a zone, read through the (zone, ord) index: the newest `limit` lines, oldest
     * first, or the ones after `after`. This is what the page opens with and what it backfills
     * with, so neither cost grows with the document.
     */
    page(zone, options = {}) {
      return blocksFromLines(pageLines(zone, options));
    },
    /** Live lines of a zone before / after an ord, counted in sqlite rather than walked. */
    lineCount(zone, options = {}) {
      return countLines(zone, options);
    },

    /** The newest `limit` timeline blocks, oldest first; `before` pages further back. */
    window({ limit = 300, before = null } = {}) {
      const blocks = blocksIn('timeline').filter((block) => before === null || block.ord < before);
      return blocks.slice(Math.max(0, blocks.length - limit));
    },

    /** The whole future area, today block first. It is short by design, so it is never paged. */
    future() {
      return blocksIn('future');
    },

    /** The system state area: the five sections, in order. Short by design, like the future area. */
    state() {
      return blocksIn('state').map(block => ({ ...block, evidence: store.evidenceFor(block.id) }));
    },

    /**
     * A fingerprint of the state area, so the page can ask "has it changed?" without pulling it
     * down. It is the live lines' ids, words and updated_at, which is exactly what a reader would
     * notice: a line rewritten, added, moved out or archived changes it, and a save that changed
     * nothing leaves it alone, because a no-op write never bumps an updated_at.
     */
    stateHash() {
      const digest = createHash('sha256');
      for (const line of liveLines('state')) {
        digest.update(`${line.id}\u0000${line.body}\u0000${line.updatedAt}\n`);
      }
      return digest.digest('hex');
    },

    /** How much is above the window, so the page knows whether scrolling up has anywhere to go. */
    countBefore(ord) {
      return blocksIn('timeline').filter((block) => block.ord < ord).length;
    },

    count() {
      return ZONES.reduce((total, zone) => total + blocksIn(zone).length, 0);
    },

    /** Every live line of a zone, in order: the rows the blocks are derived from. */
    recordAction(change, owner = 'document') {
      let before;
      return actionTransaction(() => { before = store.historySnapshot(); return change(); }, () => {
        const delta = historyDelta(before, store.historySnapshot());
        if (!delta.length) return null;
        const revision = nextActionRevision();
        return { token: randomUUID(), owner, delta, undone: false, fresh: true, position: revision, revision };
      });
    },
    historyFor(owner = 'document') {
      const rows = all('SELECT * FROM notes_actions WHERE owner = ? AND valid = 1 ORDER BY position', owner);
      return {
        undo: rows.filter(row => !row.undone).map(row => row.token),
        redo: rows.filter(row => row.undone).reverse().map(row => row.token)
      };
    },
    travelHistory(token, redo = false, owner = 'document') {
      const stack = store.historyFor(owner)[redo ? 'redo' : 'undo'];
      if (stack.at(-1) !== token) throw new Error('Undo action is not at the top of its history');
      const row = one('SELECT * FROM notes_actions WHERE token = ? AND owner = ? AND valid = 1', token, owner);
      const delta = JSON.parse(row.delta);
      return actionTransaction(() => store.applyHistory(delta, redo), () => ({
        token, owner, delta, undone: !redo, position: row.position, revision: nextActionRevision()
      }));
    },
    historySnapshot() { return db.prepare('SELECT * FROM lines').all().map(lineShape); },
    applyHistory(delta, redo = false) {
      const patches = historyPatches(delta, this.historySnapshot(), redo);
      if (patches.length) batch(patches);
    },
    lines(zone = 'timeline') { return liveLines(zone); },
    line(id) { return shapeOf(id); },
    runOf,

    /**
     * Documents a page hands over with an undo or a redo it already made on its own screen: merged
     * into the block's own, so the words the page restored are ONE edit in the document, not that
     * edit and a second one the store would make by diffing the restored rows into it. A document
     * that is not of the same lineage, or whose lines are not the rows now, is left to the
     * ordinary catch-up (the rows are diffed in on the next read).
     */
    adoptDocs(docs) {
      for (const [id, text] of Object.entries(docs && typeof docs === 'object' ? docs : {})) {
        try {
          const lines = runOf(id).map((line) => ({ id: line.id, body: line.body }));
          const row = docRow(id);
          if (!lines.length || !row || typeof text !== 'string') continue;
          const theirs = decodeDoc(text);
          const ours = decodeDoc(row.doc);
          if (!sameLineage(ours, theirs)) continue;
          const merged = mergeDocs(ours, theirs, { consume: true });
          const hash = rowsHash(lines);
          if (rowsHash(project(merged).lines) === hash) putDoc(id, merged, hash);
        } catch { /* the catch-up from the rows covers it */ }
      }
    },

    /** Blocks as the page keeps them: each with its document (`crdt`), made or caught up on the way. */
    withDocs(blocks) { return Array.isArray(blocks) ? blocks.map(withDoc) : blocks; },

    /** One block, derived. A block whose lines are all archived still answers, with its text. */
    block(id) {
      for (const zone of ZONES) {
        const found = blocksIn(zone).find((block) => block.id === id);
        if (found) return found;
      }
      const lines = runOf(id, { includeDeleted: true });
      if (lines.length === 0) return null;
      const head = lines[0];
      return {
        id: head.id,
        kind: head.kind === 'break' ? 'break' : 'text',
        body: lines.map((line) => line.body).join('\n'),
        ord: head.ord,
        zone: head.zone,
        createdAt: head.createdAt,
        updatedAt: head.updatedAt,
        deletedAt: head.deletedAt,
        source: head.source,
        chatId: head.chatId,
        lines
      };
    },

    /** The order value an appended block takes in its zone: after every line already in it. */
    appendOrd(zone = 'timeline') {
      return Number(one(
        'SELECT COALESCE(MAX(ord), 0) + 1 AS n FROM lines WHERE deleted_at IS NULL AND zone = ?', zone
      )?.n || 1);
    },

    /** Create or update one block, as lines. */
    save(input) {
      return store.apply({ blocks: [input] }).blocks[0];
    },

    /** Several blocks in one call: what ⌘↵ and a paragraph split both need. */
    saveMany(blocks) {
      return store.apply({ blocks }).blocks;
    },

    /** They are applied together so a split or a merge can hand a line's created_at to the block
     * that took its words.
     */
    apply({ blocks = [], remove = [] } = {}) {
      const orphans = [];
      const removed = [];
      for (const id of remove) {
        const lines = runOf(id);
        if (lines.length === 0) continue;
        orphans.push(...lines);
        removed.push(id);
      }
      // Explicit omissions authorize entity transfer into another submitted block in this action.
      for (const block of blocks) {
        if (!Array.isArray(block.lines) || !block.lines.length) continue;
        const retained = new Set(block.lines.map(line => line?.id));
        for (const line of runOf(block.id)) if (!retained.has(line.id) && !orphans.some(other => other.id === line.id)) orphans.push(line);
      }
      const runs = new Map(blocks.map(block => [block.id, runOf(block.id)]));
      const claimed = new Set();
      const saved = blocks.map((block) => {
        const result = saveBlock(block, orphans, runs, claimed);
        return result && result.id !== block.id ? { ...result, previousId: block.id } : result;
      });
      for (const line of orphans) archiveLine(line.id);
      return { blocks: saved.map(block => withDoc({ ...store.block(block.id), ...(block.previousId ? { previousId: block.previousId } : {}) })), removed };
    },

    /** Soft delete of a whole block: every line of it is archived, text and history intact. */
    remove(id) {
      const lines = runOf(id, { includeDeleted: true });
      if (lines.length === 0) return false;
      let touched = false;
      for (const line of lines) touched = archiveLine(line.id) || touched;
      return touched;
    },

    restore(id) {
      const lines = runOf(id, { includeDeleted: true });
      if (lines.length === 0) return null;
      for (const line of lines) restoreLine(line.id);
      return store.block(id);
    },

    /**
     * Move one line up or down. It walks inside its block until it reaches the edge and then
     * crosses into the block above or below; the order moves, and updated_at is bumped with it.
     */
    moveLine(id, direction) {
      const line = shapeOf(id);
      if (!line || line.deletedAt) return null;
      const live = liveLines(line.zone);
      const index = live.findIndex((entry) => entry.id === id);
      const target = index + (direction < 0 ? -1 : 1);
      if (index < 0 || target < 0 || target >= live.length) return null;
      const moved = moveLinePure(live, id, direction);
      if (!moved) return null;
      const displaced = live[target];
      // A block boundary is drawn BETWEEN two rows, so the two lines exchange their gap flags: a
      // line moving inside its block cannot split it, and a line moving through a boundary does
      // not drag the boundary along with it.
      //
      // Found by the model fuzz in notes-store.fuzz.test.js.
      if (line.kind !== 'break' && displaced.kind !== 'break') {
        // Nothing else happens. A boundary is made deliberately and only deliberately, so a move
        // neither invents one nor destroys one: it used to hand the boundary of the block a line
        // was leaving to the line above, which put a boundary after a line nobody had asked to
        // end a block.
        if (Boolean(displaced.gapAfter) !== Boolean(line.gapAfter)) {
          patchLine(displaced.id, { gapAfter: Boolean(line.gapAfter) });
        }
        return patchLine(id, { ord: moved.ord, gapAfter: Boolean(displaced.gapAfter) });
      }
      // Past a page break there is no boundary to exchange: the rule is the older one, that the
      // line ends a block only when nothing follows it.
      if (line.gapAfter && index > 0 && !live[index - 1].gapAfter && live[index - 1].kind !== 'break') {
        patchLine(live[index - 1].id, { gapAfter: true });
      }
      const after = direction < 0 ? live[target] : live[target + 1] || null;
      return patchLine(id, { ord: moved.ord, gapAfter: after === null });
    },

    reorderTree(id, target, after = false, whole = false) {
      const source = shapeOf(id);
      if (!source || source.deletedAt) return null;
      // Both zones, because a drop can land in another area; reorderTree filters per zone.
      const target_zone = shapeOf(target)?.zone;
      const pool = target_zone && target_zone !== source.zone
        ? [...liveLines(source.zone), ...liveLines(target_zone)]
        : liveLines(source.zone);
      const patches = reorderTree(pool, id, target, after, { whole });
      if (!patches.length) return null;
      batch(patches);
      return shapeOf(id);
    },

    /** The same move, named the way the page knows it: the nth line of a block. */
    moveLineAt(blockId, index, direction) {
      const lines = runOf(blockId);
      const line = lines[index];
      if (!line) return null;
      return store.moveLine(line.id, direction);
    },

    /**
     * Every todo line in the document, newest first, each with its own created_at. The future area
     * comes first, because that is where the live list is, then the timeline newest first.
     */
    todos({ open = true, limit = 200 } = {}) {
      const out = [];
      const groups = [...blocksIn('future'), ...store.state().filter(block => block.evidence), ...blocksIn('timeline').reverse()];
      for (const block of groups) {
        if (block.kind === 'break') continue;
        for (let index = 0; index < block.lines.length; index += 1) {
          const line = block.lines[index];
          const item = parseListItem(line.body);
          if (!item || item.listType !== 'checkbox') continue;
          if (open && item.checkboxState !== 'todo') continue;
          out.push({
            blockId: block.id, lineId: line.id, line: index, text: item.content,
            state: item.checkboxState, indent: item.indent, at: line.createdAt, ord: line.ord,
            zone: line.zone
          });
          if (out.length >= limit) return out;
        }
      }
      return out;
    },

    search(query, { limit = 50 } = {}) {
      const trimmed = String(query || '').trim();
      if (!trimmed) return [];
      const match = `${trimmed.replace(/["']/g, ' ')}*`;
      const hits = new Set(all(
        `SELECT f.id AS id FROM line_fts f JOIN lines l ON l.id = f.id
         WHERE line_fts MATCH ? AND l.deleted_at IS NULL`, match
      ).map((row) => row.id));
      if (hits.size === 0) return [];
      const found = [...blocksIn('timeline'), ...blocksIn('future')]
        .filter((block) => block.lines.some((line) => hits.has(line.id)))
        .sort((a, b) => b.ord - a.ord);
      return found.slice(0, limit);
    },

    /** Put the document back from the journal alone, for a database that did not survive. */
    rebuildFromJournal() {
      const records = readJournal(journal);
      db.exec('DELETE FROM blocks; DELETE FROM block_fts; DELETE FROM lines; DELETE FROM line_fts; DELETE FROM notes_meta; DELETE FROM notes_actions;');
      const replay = records => {
      for (const record of records) {
        if (record.op === 'notes-action') { replay(record.records || []); writeAction(record.action); continue; }
        if (record.op === 'notes-batch') { applyBatch(record); continue; }
        // Records written before lines existed name a block; they are replayed into the block
        // table and migrated below, exactly as an old store on disk is.
        const block = record.block;
        if (block?.id) {
          if (record.op === 'delete') { run('UPDATE blocks SET deleted_at = ? WHERE id = ?', record.at, block.id); continue; }
          run(`INSERT INTO blocks (id, kind, body, ord, zone, created_at, updated_at, deleted_at, source, chat_id, seq)
               VALUES (?,?,?,?,?,?,?,NULL,?,?,?)
               ON CONFLICT(id) DO UPDATE SET
                 kind = excluded.kind, body = excluded.body, ord = excluded.ord, zone = excluded.zone,
                 updated_at = excluded.updated_at, deleted_at = NULL, source = excluded.source,
                 chat_id = excluded.chat_id, seq = excluded.seq`,
            block.id, block.kind, block.body, block.ord, block.zone || 'timeline', block.createdAt,
            block.updatedAt, block.source || 'type', block.chatId || null, record.seq || 0);
          continue;
        }
        const line = record.line;
        if (!line?.id) continue;
        writeRow({
          ...line,
          taskId: line.taskId ?? null,
          indent: line.indent ?? lineFields(line.body).indent,
          deletedAt: record.op === 'delete' ? (line.deletedAt || record.at) : (record.op === 'restore' ? null : line.deletedAt || null)
        }, record.seq || 0);
      }
      };
      replay(records);
      migrateBlocksToLines();
      db.exec('DELETE FROM line_fts');
      for (const row of all(`SELECT id, body FROM lines WHERE deleted_at IS NULL AND kind = 'text' AND TRIM(body) <> ''`)) {
        run('INSERT INTO line_fts (id, body) VALUES (?,?)', row.id, row.body);
      }
      return store.count();
    },

    migrate: migrateBlocksToLines
  };

  migrateBlocksToLines();
  // A fsynced action may have survived a process exit before SQLite released its savepoint.
  // Compare durable revision watermarks on open and reconstruct the projection if it trails.
  const committedRevision = nextActionRevision() - 1;
  if (readJournal(journal).some(record => record.op === 'notes-action' && record.action?.revision > committedRevision)) {
    store.rebuildFromJournal();
  }

  return store;
}

let shared = null;
export function notesStore() {
  if (!shared) shared = openNotesStore();
  return shared;
}
export function resetNotesStore() {
  try { shared?.close(); } catch { /* a store that is already closed is the state we wanted */ }
  shared = null;
}
