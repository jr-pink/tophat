// The write path from the system state area into the rev5 raw data plane.
//
// One row into `raw_data` in ~/.local/state/tophat-rev5/rev5/memory.sqlite and nothing else: no
// other table, no batch, no entity. The push cycle picks unprocessed rows up on its own every 300
// seconds, which is the debounce revision 1 asks for, and interprets the report against evidence.
//
// Three rules hold this together.
//
// 1. A failed report never fails the edit. His line is already saved in the notes store, which is
//    the thing that must not be lost; the report is best effort and a failure is logged and
//    returned, never thrown.
// 2. Another process is pushing against that database at the same time. A locked store is waited
//    on and retried, never forced: no WAL checkpoint, no journal mode change, no busy loop.
// 3. The private-people registry governs this row as it governs every ingested one. It is the
//    shared list both runtimes read (tophat/src/core/private-people.mjs); when it cannot be read
//    the record is written withheld rather than open, because that list exists to fail closed.

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { rev5Db } from '../../../../runner/rev5/tasks.mjs';
import { pyJson, stateReportRow } from '../core/state-report.js';
import { sectionOf, threadOf } from '../core/notes-doc.js';

/** The store this plane writes into.
 *
 * WHERE THE REV5 STORE IS IS ONE RULE AND rev5/tasks.mjs OWNS IT. This was a second copy of that
 * rule, spelled out character for character, down to the older TOPHAT_REV5_MEMORY variable: two
 * places to edit tomorrow for one decision, which is the exact thing that file's own comment says
 * it exists to prevent ("honouring it here is what stops one side opening a database the other does
 * not"). The `home` argument stays, because it is the seam tests resolve against; it is folded into
 * the state directory the owner reads, and the two environment spellings keep their precedence.
 */
export function rev5MemoryPath({ env = process.env, home = homedir() } = {}) {
  const stateDir = env.TOPHAT_STATE_DIR || join(home, '.local', 'state', 'tophat');
  return rev5Db({ ...env, TOPHAT_STATE_DIR: stateDir });
}

export function privatePeoplePath({ env = process.env, home = homedir() } = {}) {
  return env.TOPHAT_PRIVATE_PEOPLE || join(home, 'projects', 'tophat', 'src', 'core', 'private-people.mjs');
}

/**
 * The row's id, exactly as rev5 computes it for a record that names none of its own
 * (rev5/store.py: `"r_" + digest([source, account, native_id, revision], 12)`, and `digest` is a
 * sha256 over Python's json dump). An id in another shape would still store, but it would stop
 * looking like the plane it is in.
 */
export function rawRecordId({ source, account, nativeId, revision }) {
  const dump = pyJson([source, account, nativeId, revision]);
  return `r_${createHash('sha256').update(dump, 'utf8').digest('hex').slice(0, 12)}`;
}

/**
 * The policy this record carries. `{model: 'allow'}` is what revision 1 asks for so push may read
 * it, and the one thing that overrides it is the private-people list: a body naming one of them is
 * withheld from every model, and rev5's ingest spells the reason `private-body:<id>`.
 */
export async function policyFor(text, { path = privatePeoplePath(), log = console.error } = {}) {
  try {
    const { privatePersonIn } = await import(pathToFileURL(path).href);
    const person = privatePersonIn([String(text ?? '')]);
    if (person) return { model: 'deny', publish: 'none', reason: `private-body:${person.id}` };
    return { model: 'allow', publish: 'none', reason: null };
  } catch (cause) {
    log(`[state-report] the private-people registry at ${path} could not be read: ${cause?.message || cause}`);
    return { model: 'deny', publish: 'none', reason: 'private-people registry unreadable' };
  }
}

const sleep = (ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  if (timer.unref) timer.unref();
});

/**
 * Insert the row. A store that is not there is not created: this plane belongs to rev5 and an
 * empty database with one table in it would be a worse lie than a logged failure. A row that is
 * already there, by id or by (source, account, native_id, revision), is the write having already
 * happened and is reported as done.
 */
export async function writeRawRecord(row, {
  path = rev5MemoryPath(), attempts = 4, waitMs = 200, busyMs = 30_000,
  now = new Date().toISOString(), log = console.error
} = {}) {
  if (!existsSync(path)) {
    const error = `no rev5 memory store at ${path}`;
    log(`[state-report] ${error}`);
    return { ok: false, error };
  }
  const id = rawRecordId(row);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let db = null;
    try {
      db = new DatabaseSync(path);
      // Wait for the pusher rather than fight it; 30s is the timeout rev5's own store opens with.
      db.exec(`PRAGMA busy_timeout = ${Number(busyMs) || 0}`);
      db.prepare(
        `INSERT INTO raw_data (id, source, account, native_id, revision, role, author, participants,
                               thread, occurred_at, available_at, ingested_at, text, locator, policy)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        id, row.source, row.account, row.nativeId, row.revision, row.role, row.author,
        pyJson(row.participants), row.thread, row.occurredAt, row.availableAt, now, row.text,
        pyJson(row.locator), pyJson(row.policy)
      );
      return { ok: true, id, withheld: row.policy?.model !== 'allow' };
    } catch (cause) {
      const message = String(cause?.message || cause);
      if (/UNIQUE|PRIMARY KEY/iu.test(message)) return { ok: true, id, duplicate: true };
      if (!/busy|locked/iu.test(message) || attempt === attempts) {
        log(`[state-report] the report was not written: ${message}`);
        return { ok: false, error: message };
      }
      await sleep(waitMs * attempt);
    } finally {
      try { db?.close(); } catch { /* a handle that is already closed is the state we wanted */ }
    }
  }
  const error = 'the rev5 memory store stayed locked';
  log(`[state-report] ${error}`);
  return { ok: false, error };
}

/**
 * One edit in the state area, reported. What the caller does not name is read off the notes store,
 * so a subagent can say "line 3 of what's going on" and the record still carries the words and the
 * thread; the page, which knows what the line said a moment ago, sends `before` itself.
 */
export async function reportStateEdit({
  store, kind, section = null, blockId = null, line = null, before = null, after = null,
  thread = null, now = new Date().toISOString(), path, registry, log = console.error
} = {}) {
  const blocks = store ? store.state() : [];
  const block = blocks.find((entry) => (blockId ? entry.id === blockId : sectionOf(entry) === section)) || null;
  const lines = block?.lines || [];
  const index = Number.isInteger(Number(line)) && line !== null && line !== '' ? Number(line) : null;
  const target = index === null ? null : lines[index] || null;
  const text = after ?? target?.body ?? '';
  const row = stateReportRow({
    kind,
    section: section || (block ? sectionOf(block) : null),
    blockId: block?.id || blockId || null,
    lineId: target?.id || null,
    line: index,
    before: before ?? '',
    after: text,
    thread: thread ?? threadOf(lines.map((entry) => entry.body), index),
    now,
    policy: await policyFor(
      // The policy is decided on the words that will be stored, which is the record's own text.
      [before ?? '', text, thread ?? ''].join('\n'),
      { path: registry, log }
    )
  });
  return writeRawRecord(row, { path, now, log });
}

/** The two routes' shared answer, so the browser and an agent get the same thing. */
export async function stateReportResponse({ store, body = {}, now, path, registry, log } = {}) {
  const kind = String(body.kind || '');
  if (kind !== 'check' && kind !== 'edit') {
    return { status: 400, payload: { error: "kind is 'check' or 'edit'" } };
  }
  const result = await reportStateEdit({
    store,
    kind,
    section: body.section ? String(body.section) : null,
    blockId: body.blockId ? String(body.blockId) : null,
    line: body.line ?? null,
    before: typeof body.before === 'string' ? body.before : null,
    after: typeof body.after === 'string' ? body.after : null,
    thread: typeof body.thread === 'string' ? body.thread : null,
    now, path, registry, log
  });
  // A report that could not be written is still a 200: the edit itself is saved, and the page must
  // not show an error for a plane the person writing never asked about.
  return { status: 200, payload: { ...result, hash: store ? store.stateHash() : null } };
}
