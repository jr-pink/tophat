import { rev5MemoryPath } from './state-report.js';
// What a check-off or a structural edit in Notes does to the shared work item behind it.
//
// Notes keeps the writing: the line, its words, its id, its history, its journal. The shared rev5
// `work` row keeps the outcome: status, owner, parent. This module is the join, and it is
// deliberately small -- read the current revision, send one absolute change under an operation id,
// settle the record it already wrote down. There is no second task store, no sync engine and no
// queue daemon.
//
// The durability rule, which is the whole reason this file exists: his edit is saved in the notes
// journal BEFORE the work store is asked, together with the operation that is owed to it. So a
// crash, a locked database, a stopped runner or a lost answer leaves a pending operation that the
// next drain retries under the same id -- and the same id is the work store's receipt key, so a
// retry of an operation that did land returns the first result instead of applying twice.
//
// The conflict rule: a stale change is NOT retried with a fresh revision. `{reason:'conflict'}`
// comes back with the current row, the operation is parked as a conflict and a person or a model
// decides. Quietly taking the new revision and writing anyway is exactly how a newer owner edit or
// a handoff gets overwritten.

import { randomUUID } from 'node:crypto';
import { parseListItem, setListState, stripWeight } from '../core/notes-doc.js';
import { applyTasksAsync, getTaskAsync, listTasksAsync, tasksCliAsync } from './tasks-bridge.js';

/** The marker a status reads as in his document, and back. */
// A parked line is still open work, waiting on a condition rather than on him.
const MARKER_STATUS = { todo: 'todo', done: 'done', dropped: 'dropped', await: 'todo' };
export const statusOfLine = (body) => {
  const item = parseListItem(String(body ?? ''));
  if (!item || item.listType !== 'checkbox') return null;
  return MARKER_STATUS[item.checkboxState] || null;
};

const failure = (answer) => ({
  ok: false,
  reason: answer?.reason === 'conflict' ? 'conflict' : (answer?.reason || 'unavailable'),
  detail: answer?.detail || answer?.error || answer?.message || null,
  current: answer?.current || null
});

async function reportEdit(op, taskId, options) {
  if (!op.after) return;
  const env = options.env || process.env;
  const answer = await tasksCliAsync({ records: [{ source: 'notes-state', native_id: op.opId, revision: '1', role: 'owner', author: 'owner',
    occurred_at: op.at, available_at: op.at, thread: `notes:${op.lineId}`, policy: { model: 'allow', publish: 'none' },
    text: JSON.stringify({ task_id: taskId, before: op.before, after: op.after, parent_line_id: op.parentLineId }),
    locator: { line: op.lineId, task: taskId } }] },
    { env: { ...env, TOPHAT_REPO: options.repo || env.TOPHAT_REPO }, db: options.db || rev5MemoryPath(options), command: 'ingest' });
  if (!answer?.ok) { const error = Error(answer?.detail || answer?.reason || 'Task refused'); error.current = answer?.current; throw error; }
}

/**
 * Deliver one pending operation. Returns the settled record. A conflict parks; anything else stays
 * pending, because an undelivered change must not look delivered.
 */
export async function deliverTaskOp(store, op, options = {}) {
  if (op.create) {
    const binding = { source: 'notes-line', native_id: op.lineId };
    const found = await listTasksAsync({ binding }, options);
    if (!found.ok) return { ok: false, ...failure(found) };
    let taskId = found.tasks[0]?.id;
    if (!taskId) {
      const answer = await applyTasksAsync({ opId: op.opId, actor: op.actor,
        tasks: [{ id: '$line', ...op.fields, owner_kind: 'me', bindings: [binding] }] }, options);
      if (!answer.ok) return { ok: false, ...failure(answer) };
      taskId = answer.id_map.$line;
    }
    store.bindLine(op.lineId, taskId);
    store.taskVersion(taskId, (await getTaskAsync(taskId, options)).work.version);
    const row = (await getTaskAsync(taskId, options)).work;
    if (row.title !== op.fields.title || row.status !== op.fields.status) {
      const before = op.before && parseListItem(stripWeight(op.before.body));
      if (!before || row.title !== before.content.trim() || row.status !== statusOfLine(op.before.body)) {
        return { ok: false, reason: 'conflict', op: store.settleTaskOp(op.opId, { state: 'conflict', current: row }) };
      }
      const expected = op.createdVersion ?? row.version;
      store.markTaskOp(op.opId, { createdVersion: expected });
      const answer = await applyTasksAsync({ opId: `${op.opId}:edit`, actor: op.actor,
        tasks: [{ id: taskId, expected_version: expected, ...op.fields }] }, options);
      if (!answer.ok) return { ok: false, ...failure(answer) };
    }
    if (op.parentLineId) {
      const parent = store.line(op.parentLineId);
      if (!parent?.taskId) return { ok: false, reason: 'pending-parent' };
      const row = (await getTaskAsync(taskId, options)).work;
      const expected = op.parentVersion ?? row.version;
      const parentId = op.parentTaskId ?? parent.taskId;
      store.markTaskOp(op.opId, { parentVersion: expected, parentTaskId: parentId });
      const answer = await applyTasksAsync({ opId: `${op.opId}:parent`, actor: op.actor,
        tasks: [{ id: taskId, expected_version: expected, parent_id: parentId }] }, options);
      if (!answer.ok) return { ok: false, ...failure(answer) };
    }
    try { await reportEdit(op, taskId, options); } catch (error) { return { ok: false, reason: 'report-pending', detail: error.message }; }
    return { ok: true, op: store.settleTaskOp(op.opId, { state: 'delivered', taskId }) };
  }
  const current = (await getTaskAsync(op.taskId, options));
  if (!current?.ok) return { op: store.taskOp(op.opId) || op, ...failure(current) };
  const row = current.work;
  const wanted = { ...(op.sentFields || op.fields) };
  if (!op.sentFields && 'parentLineId' in op) {
    const parent = op.parentLineId ? store.line(op.parentLineId) : null;
    if (op.parentLineId && !parent?.taskId) return { ok: false, reason: 'pending-parent' };
    wanted.parent_id = parent?.taskId || null;
  }
  const alreadyThere = Object.entries(wanted).every(([key, value]) => row[key] === value);
  // The revision this operation was FIRST sent against, remembered before it is sent.
  //
  // A retry has to be byte for byte the operation the work store may already hold, or its receipt
  // refuses it as the same id with different content -- which is exactly the case that matters:
  // the apply landed, the answer was lost, and the store has moved on by one version. Reading the
  // current version again on the retry would send a different payload and turn a safe replay into
  // a refusal. Recorded first, so a crash between the note and the send cannot lose it.
  const expected = Number.isInteger(op.expectedVersion) ? op.expectedVersion : row.version;
  if (!Number.isInteger(op.expectedVersion)) store.markTaskOp(op.opId, { expectedVersion: expected, sentFields: wanted });
  if (!op.sentFields) store.markTaskOp(op.opId, { sentFields: wanted });
  // A no-op is still delivered, so the receipt exists and the pending record can be settled.
  const answer = await applyTasksAsync({
    opId: op.opId,
    actor: op.actor,
    tasks: [{ id: op.taskId, expected_version: expected, ...wanted }]
  }, options);
  if (!answer?.ok) {
    if (answer?.reason === 'conflict') {
      const parked = store.settleTaskOp(op.opId, { state: 'conflict', current: answer.current || null });
      return { op: parked, ...failure(answer) };
    }
    return { op: store.taskOp(op.opId) || op, ...failure(answer) };
  }
  const written = (answer.work || []).find((entry) => entry.id === op.taskId) || null;
  try { await reportEdit(op, op.taskId, options); } catch (error) { return { ok: false, reason: 'report-pending', detail: error.message }; }
  store.taskVersion(op.taskId, written?.version ?? row.version);
  const settled = store.settleTaskOp(op.opId, {
    state: 'delivered',
    expectedVersion: expected,
    version: written?.version ?? row.version,
    unchanged: written?.op === 'unchanged' || alreadyThere,
    replayed: answer.replayed === true
  });
  return { ok: true, op: settled, task: written, replayed: answer.replayed === true };
}

export const RETRY_BASE_MS = 30_000;
export const RETRY_MAX_MS = 60 * 60_000;

/** An operation carrying an empty title: the work store refuses it every time, so asking is waste. */
const blankTitle = (op) => Boolean(op.fields) && 'title' in op.fields && String(op.fields.title ?? '').trim() === '';

/** Deliver what is owed. An operation that fails for a reason that is not a conflict is tried again
 * later, not on every pass: each attempt is a whole Python start run synchronously, so sixteen
 * operations that could never land cost the server about 2.7 s of stopped thread on every notes
 * view=sync and again three seconds after every notes request. A failure now records when it may
 * be tried again (30 s, doubling to an hour), and an operation with an empty title is not
 * attempted at all; both stay pending and visible.
 */
export async function drainTaskOps(store, options = {}) {
  const out = { attempted: 0, delivered: 0, conflicts: 0, pending: 0, deferred: 0, results: [] };
  const now = options.now ?? Date.now();
  for (const op of store.pendingTaskOps()) {
    if (blankTitle(op) || (op.retryAt && Date.parse(op.retryAt) > now)) { out.deferred += 1; out.pending += 1; continue; }
    out.attempted += 1;
    let result;
    try { result = await deliverTaskOp(store, op, options); }
    catch (error) { result = { ok: false, reason: 'unavailable', detail: error.message }; }
    if (result.ok) out.delivered += 1;
    else if (result.reason === 'conflict') out.conflicts += 1;
    else {
      out.pending += 1;
      const attempts = (op.attempts || 0) + 1;
      const wait = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempts - 1));
      try { store.markTaskOp(op.opId, { attempts, retryAt: new Date(now + wait).toISOString(), lastReason: result.reason || 'unavailable' }); } catch {}
    }
    out.results.push({ opId: op.opId, taskId: op.taskId, ok: Boolean(result.ok), reason: result.reason || null });
  }
  return out;
}

/**
 * His click. The marker is written into the line and the owed operation is written beside it in
 * one journal record; then the work store is asked. The line is his either way: a work store that
 * is down, locked or stale never costs him the edit, and never silently loses the report.
 *
 * Absolute, per the shared contract: "set status done", never "toggle".
 */
export async function setLineStatus(store, { lineId, status, actor = 'owner', opId = randomUUID(), body = null }, options = {}) {
  if (!Object.values(MARKER_STATUS).includes(status)) throw new Error('status is todo, done or dropped');
  const line = store.line(lineId);
  if (!line) throw new Error(`no line ${lineId}`);
  const existing = store.taskOp(opId);
  if (existing && existing.state === 'delivered') return { ok: true, op: existing, line, replayed: true };
  const next = body ?? setListState(line.body, status);
  const patches = next === line.body ? [] : [{ id: lineId, body: next }];
  if (!line.taskId) {
    // Ordinary writing. The document takes the edit; nothing here invents a shared task for it.
    store.patchLines(patches);
    return { ok: true, bound: false, line: store.line(lineId) };
  }
  const op = existing && existing.state !== 'delivered'
    ? existing
    : store.recordTaskOp({ opId, taskId: line.taskId, actor, kind: 'status', expectedVersion: (await getTaskAsync(line.taskId, options))?.work?.version ?? store.taskVersion(line.taskId) ?? -1, fields: { status } }, patches);
  const result = await deliverTaskOp(store, op, options);
  return { ...result, bound: true, line: store.line(lineId) };
}

/**
 * An indent or an outdent that moved a bound line under (or out from under) another bound line.
 * The parent pointer is the deliberate gesture's, not a guess about nesting: the caller names the
 * line and its new parent line, both of which carry bindings, and the shared change is explicit.
 * Cycles and dangling parents are refused by the work store itself.
 */
export async function setLineParent(store, { lineId, parentLineId = null, actor = 'owner', opId = randomUUID() }, options = {}) {
  const line = store.line(lineId);
  if (!line) throw new Error(`no line ${lineId}`);
  if (!line.taskId) return { ok: true, bound: false, line };
  let parentTaskId = null;
  if (parentLineId) {
    const parent = store.line(parentLineId);
    if (!parent) throw new Error(`no line ${parentLineId}`);
    if (!parent.taskId) return { ok: false, reason: 'unbound-parent', detail: `line ${parentLineId} is not a task`, line };
    parentTaskId = parent.taskId;
  }
  const existing = store.taskOp(opId);
  if (existing && existing.state === 'delivered') return { ok: true, op: existing, line, replayed: true };
  const op = existing && existing.state !== 'delivered'
    ? existing
    : store.recordTaskOp({ opId, taskId: line.taskId, actor, kind: 'parent', expectedVersion: (await getTaskAsync(line.taskId, options))?.work?.version ?? store.taskVersion(line.taskId) ?? -1, fields: { parent_id: parentTaskId } });
  const result = await deliverTaskOp(store, op, options);
  return { ...result, bound: true, line };
}

/**
 * Make an existing line a shared task. The work item is created with the line's own id as an
 * explicit `notes-line` binding, which is a compatibility identity and not a semantic key; the
 * line's words become the title and the line keeps them. Creating is the one operation that is not
 * a revision update, so it carries the operation id as its receipt and the binding makes a second
 * attempt visible rather than making a second task.
 */
export async function bindLineToNewTask(store, { lineId, title = null, ownerKind = 'me', ownerRef = null, actor = 'owner', opId = randomUUID(), contextRefs = [] }, options = {}) {
  const line = store.line(lineId);
  if (!line) throw new Error(`no line ${lineId}`);
  if (line.taskId) return { ok: true, taskId: line.taskId, line, already: true };
  const item = parseListItem(line.body);
  const text = String(title ?? (item ? item.content : line.body)).trim();
  if (!text) throw new Error('a task needs words');
  const binding = { source: 'notes-line', native_id: lineId };
  const existing = store.taskOp(opId);
  const op = existing && existing.state !== 'delivered' ? existing : { opId, taskId: null, actor };
  const answer = await applyTasksAsync({
    opId,
    actor,
    tasks: [{
      id: '$line', title: text, status: statusOfLine(line.body) || 'todo',
      owner_kind: ownerKind, owner_ref: ownerRef,
      bindings: [binding], context_refs: contextRefs
    }]
  }, options);
  if (!answer?.ok) return { ok: false, line, ...failure(answer) };
  const taskId = answer.id_map?.$line || (answer.work || [])[0]?.id || null;
  if (!taskId) return { ok: false, line, reason: 'unavailable', detail: 'the work store returned no id' };
  store.bindLine(lineId, taskId);
  store.taskVersion(taskId, (await getTaskAsync(taskId, options))?.work?.version ?? 1);
  return { ok: true, taskId, line: store.line(lineId), replayed: answer.replayed === true, op };
}

/** Install on the browser write boundary. Edits and their task deltas share the action journal. */
export function observeOwnerTaskEdits(store, options = {}) {
  store.observeTaskEdits((before, after) => {
    const prior = new Map(before.map(line => [line.id, line]));
    const parentMap = (lines) => {
    const parents = new Map();
    for (const zone of new Set(lines.map(line => line.zone))) {
      const stack = [];
      for (const line of lines.filter(line => line.zone === zone && !line.deletedAt).sort((a,b) => a.ord - b.ord)) {
        while (stack.length && stack.at(-1).indent >= line.indent) stack.pop();
        parents.set(line.id, [...stack].reverse().find(p => p.taskId || statusOfLine(p.body))?.id || null);
        stack.push(line);
      }
    }
    return parents;
    };
    const parents = parentMap(after), oldParents = parentMap(before);
    for (const line of after.slice().sort((a,b) => a.ord - b.ord)) {
      const old = prior.get(line.id);
      if (line.deletedAt || !statusOfLine(line.body)) continue;
      if (old && ['body','indent','ord','zone'].every(key => old[key] === line[key]) && oldParents.get(line.id) === parents.get(line.id)) continue;
      // No task lookup here at all: this runs inside his request, and getTask is a child process of the
      // task CLI per line (seconds for a drag or an archive of a few task lines). The op carries
      // no expectedVersion, so delivery, which runs after the answer, sends against the revision
      // current then and remembers it for retries.
      const item = parseListItem(stripWeight(line.body));
      store.recordTaskOp({ opId: randomUUID(), taskId: line.taskId || `new:${line.id}`, lineId: line.id,
        create: !line.taskId, actor: 'owner', expectedVersion: undefined,
        parentLineId: parents.get(line.id), fields: { title: item.content.trim(), status: statusOfLine(line.body) },
        before: old || null, after: line });
    }
  });
}

/** Fold one page of the work store's rows into the bound lines; the part the async refresh uses. */
function foldTaskRows(store, wanted, rows) {
  const patches = [];
  for (const row of rows) {
    const line = wanted.get(row.id);
    if (line && store.taskVersion(row.id) !== row.version) store.taskVersion(row.id, row.version);
    if (line && statusOfLine(line.body) && statusOfLine(line.body) !== row.status) {
      patches.push({ id: line.id, body: setListState(line.body, row.status) });
    }
  }
  if (patches.length) store.patchLines(patches);
  return patches.length;
}

/**
 * `refreshTaskLines` without stopping the server: the pages come from async child processes, so
 * the event loop keeps answering while the work store is read. The lines a change touches reach
 * every open tab through the notes store's own journal (the live feed), so a caller never waits
 * for it.
 */
export async function refreshTaskLinesAsync(store, options = {}) {
  const bound = () => store.historySnapshot().filter(line => line.taskId && !line.deletedAt);
  if (!bound().length) return { refreshed: 0 };
  let offset = 0, count = 0;
  do {
    const response = await listTasksAsync({ limit: 1000, offset }, options);
    if (!response.ok) return { refreshed: count, unavailable: true };
    // Judged against the lines as they stand when the page arrives, not when the read began: a
    // line edited or given a pending operation meanwhile is not overwritten with an older status.
    const pending = new Set(store.pendingTaskOps({ includeConflicts: true }).map(op => op.taskId));
    const live = new Map(bound().filter(line => !pending.has(line.taskId)).map(line => [line.taskId, line]));
    count += foldTaskRows(store, live, response.tasks);
    offset = response.next_offset;
  } while (offset !== null);
  return { refreshed: count };
}

export const TASK_REFRESH_EVERY_MS = Number(process.env.WEBCHAT_TASK_REFRESH_MS || 30_000);
let refreshing = null;
let refreshedAt = 0;
/**
 * Start a background refresh if none is running and the last one is older than the interval;
 * returns at once. One at a time, so a burst of page loads is one read of the work store.
 */
export function refreshTaskLinesSoon(store, options = {}) {
  if (refreshing) return { scheduled: false, running: true };
  if (Date.now() - refreshedAt < TASK_REFRESH_EVERY_MS) return { scheduled: false, fresh: true };
  refreshedAt = Date.now();
  refreshing = refreshTaskLinesAsync(store, options)
    .catch(() => ({ refreshed: 0, unavailable: true }))
    .finally(() => { refreshing = null; });
  return { scheduled: true, running: true };
}
export const taskRefreshIdle = () => refreshing || Promise.resolve();
