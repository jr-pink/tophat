import { readFileSync, statSync } from 'node:fs';
import { owner, ownerPossessive } from '../../../../runner/owner.mjs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { defineJobs } from './offload.js';
import { statusOfLine } from './notes-tasks.js';

const singleLine = value => String(value || '').replace(/[\r\n\t]+/g, ' ').trim();

// Only message pointers used by the assessment can be covered. Arrivals not yet assessed
// are excluded: clicking an older todo must never acknowledge unseen messages.
export function replyTasks(ledger, history) {
  if (!ledger?.chats || !history?.chats) throw new Error('Reply source is incomplete');
  const tasks = [];
  for (const [id, chat] of Object.entries(ledger.chats)) {
    if (chat.override?.desired === 'read' || chat.attention?.kind !== 'on_me') continue;
    const evidence = (history.chats[id]?.messages || [])
      .filter(m => m.id && m.isSender === false && !m.isHidden && !m.isDeleted &&
        !['REACTION', 'NOTICE'].includes(m.type) && typeof chat.messageHashes?.[m.id] === 'string')
      .map(m => String(m.id));
    if (!evidence.length) continue;
    const title = singleLine(chat.title) || 'Conversation';
    const reason = singleLine(chat.attention.reason);
    tasks.push({ scope: `beeper:${id}`, evidence,
      body: `- [ ] Reply to ${title}${reason ? ` — ${reason}` : ''}` });
  }
  return tasks;
}

export function replySourceDir(env = process.env, home = homedir()) {
  return env.TOPHAT_BEEPER_RESPONSE_DIR || '';
}

/** What the latest assessment covers, read. It does NOT create work any more.
 *
 * It used to: every GET of the notes page or the state area ran the importer, and a conversation that
 * had acquired new messages since the last look produced ANOTHER unchecked "Reply to X" line, because
 * the identity was a hash over the fresh evidence set. a new batch of messages under it is evidence,
 * not a second obligation, and reading a view is not a reason to write state at all. The scope and
 * its assessed pointers are returned here so the push plane -- which can see the existing open AND
 * closed work for that thread and judge whether this is the same outcome -- is the thing that
 * decides. `store` stays in the signature because the callers pass it and because a reviewed
 * reconciliation path may still write through the store explicitly.
 */
// Two JSON parses of the monitor's files cost 30-45 ms of stopped thread per call, and the page
// asks on every open; the answer only changes when one of the files does.
const answers = new Map();

export function syncReplies(store, { dir = replySourceDir() } = {}) {
  if (!dir) return { available: false, checkedAt: null, scopes: [], evidence: 0, creates: false };
  let stamp = null;
  try { stamp = `${statSync(join(dir, 'ledger.json')).mtimeMs}:${statSync(join(dir, 'history.json')).mtimeMs}`; } catch { /* unreadable: the read below says so */ }
  if (stamp && answers.get(dir)?.stamp === stamp) return answers.get(dir).value;
  const value = readReplies(dir);
  if (stamp && value.available) answers.set(dir, { stamp, value });
  return value;
}

function readReplies(dir) {
  try {
    const ledger = JSON.parse(readFileSync(join(dir, 'ledger.json'), 'utf8'));
    const history = JSON.parse(readFileSync(join(dir, 'history.json'), 'utf8'));
    const tasks = replyTasks(ledger, history);
    return {
      available: true,
      checkedAt: ledger.updatedAt || null,
      creates: false,
      scopes: tasks.map((task) => task.scope),
      evidence: tasks.reduce((total, task) => total + task.evidence.length, 0),
      coverage: 'Assessed conversations needing a reply. Evidence for interpretation; no task is created by reading.'
    };
  } catch {
    // A missing or half-written external snapshot never removes or rewrites existing owner tasks.
    return { available: false, checkedAt: null, scopes: [], evidence: 0, creates: false };
  }
}


// --------------------------------------------------------------------------------------------- The
// Beeper badge is a projection of THIS state. The monitor's LLM assessment is evidence and nothing
// more; what is owed to him is the open conversation line in the notes state area, the same line the
// Notes page shows.
// ---------------------------------------------------------------------------------------------

const substantive = (m) => m.id && !m.isHidden && !m.isDeleted && !['REACTION', 'NOTICE'].includes(m.type);
const atOf = (m) => { const n = Date.parse(m.timestamp); return Number.isFinite(n) ? n : null; };

/**
 * What reconciliation needs from the monitor, per assessed conversation: the assessment's verdict,
 * the owner's explicit override, and when each side last spoke. Incoming messages (id and time) are
 * listed only for conversations judged to be on him; those are the candidates for a new ask.
 */
export function replyFacts(ledger, history) {
  if (!ledger?.chats || !history?.chats) throw new Error('Reply source is incomplete');
  const facts = {};
  for (const [id, chat] of Object.entries(ledger.chats)) {
    const messages = (history.chats[id]?.messages || []).filter(substantive);
    const incoming = messages.filter((m) => m.isSender === false && typeof chat.messageHashes?.[m.id] === 'string')
      .map((m) => ({ id: String(m.id), at: atOf(m) })).filter((m) => m.at !== null);
    const outgoing = messages.filter((m) => m.isSender === true).map(atOf).filter((n) => n !== null);
    facts[id] = {
      title: singleLine(chat.title) || 'Conversation',
      reason: singleLine(chat.attention?.reason),
      kind: chat.attention?.kind || null,
      assessedAt: Date.parse(chat.assessedAt) || null,
      override: ['read', 'unread'].includes(chat.override?.desired) ? chat.override.desired : null,
      lastIncomingAt: incoming.length ? Math.max(...incoming.map((m) => m.at)) : null,
      lastOutgoingAt: outgoing.length ? Math.max(...outgoing) : null,
      incoming: chat.attention?.kind === 'on_me' ? incoming : []
    };
  }
  return facts;
}

/** What one reconcile pass reads, parsed off the main thread: the candidates and the facts. */
export function readReconcileInput(dir) {
  const ledger = JSON.parse(readFileSync(join(dir, 'ledger.json'), 'utf8'));
  const history = JSON.parse(readFileSync(join(dir, 'history.json'), 'utf8'));
  return { checkedAt: ledger.updatedAt || null, tasks: replyTasks(ledger, history), facts: replyFacts(ledger, history) };
}

const isOpen = (line) => !line.deletedAt && statusOfLine(line.body) === 'todo';
const closedAt = (line) => Date.parse(line.deletedAt || line.updatedAt) || 0;
const scopeOf = (chatID) => `beeper:${chatID}`;

/**
 * Bring the conversation lines in line with the latest assessment, without ever overruling him.
 *
 *  - No line has ever existed for a conversation judged to be on him: one line is created. This is
 *    the push plane's job in the design; push does not read this ledger yet, so this is the
 *    deterministic stand-in, and it is idempotent per scope (the line's identity is the scope).
 *  - An open line is left alone (its evidence coverage grows).
 *  - Every line closed (done, dropped or deleted by him): it stays closed UNLESS something new
 *    arrived after he closed it that he has not answered; that is a new request, so a new line.
 *    Silence, a re-assessment or an unread flag never reopens anything.
 *  - An open line whose conversation is no longer judged to be on him, where his own message is the
 *    last word and came after the line was made, is closed as done: a reply actually sent, observed.
 *  - An explicit `drop` override closes the line.
 * Lines bound to a shared work item are never edited here; their status belongs to that item.
 */
export function reconcileReplies(store, input, { now = Date.now() } = {}) {
  const report = { created: [], renewed: [], closed: [], untouched: 0 };
  const lines = store.replyLines();
  const candidates = new Map(input.tasks.map((task) => [task.scope, task]));
  const chatOf = (scope) => scope.slice('beeper:'.length);

  for (const task of input.tasks) {
    const chatID = chatOf(task.scope);
    const f = input.facts[chatID];
    const own = lines.get(task.scope) || [];
    const open = own.filter(isOpen);
    if (!own.length) {
      const line = store.importEvidenceTask(task);
      if (line) report.created.push({ chatID, line: line.id, title: f?.title });
    } else if (open.length) {
      const newest = open.at(-1);
      store.importEvidenceTask({ ...task, generation: newest.generation });
      report.untouched++;
    } else {
      const since = Math.max(...own.map(closedAt));
      const fresh = (f?.incoming || []).filter((m) => m.at > since);
      const answered = f?.lastOutgoingAt != null && fresh.length && f.lastOutgoingAt > Math.max(...fresh.map((m) => m.at));
      if (fresh.length && !answered) {
        const generation = Math.max(...own.map((l) => l.generation)) + 1;
        const line = store.importEvidenceTask({ ...task, evidence: fresh.map((m) => m.id), generation });
        if (line) report.renewed.push({ chatID, line: line.id, title: f?.title, generation });
      } else report.untouched++;
    }
  }

  for (const [scope, own] of lines) {
    if (!scope.startsWith('beeper:')) continue;
    const f = input.facts[chatOf(scope)];
    if (!f) continue;
    for (const line of own.filter(isOpen)) {
      if (line.taskId) continue;
      let why = null;
      if (f.override === 'read') why = `${owner()} dropped this conversation explicitly (monitor override)`;
      else if (!candidates.has(scope) && ['none', 'follow_up'].includes(f.kind) && f.assessedAt > Date.parse(line.createdAt) &&
        f.lastOutgoingAt != null && f.lastOutgoingAt > Date.parse(line.createdAt) && f.lastOutgoingAt >= (f.lastIncomingAt ?? 0)) {
        why = `${owner()} replied in the conversation after this was raised and the latest assessment no longer finds a reply owed`;
      }
      if (!why) continue;
      const marker = f.override === 'read' ? '-' : 'x';
      store.patchLines([{ id: line.id, body: line.body.replace(/^(\s*- \[) (\])/, `$1${marker}$2`) }]);
      report.closed.push({ chatID: chatOf(scope), line: line.id, title: f.title, why });
    }
  }
  return report;
}

/**
 * The projection the Beeper badge follows: a conversation is badged unread exactly while an open
 * conversation line exists for it (or he forced it with an explicit `keep`), and may be cleared once
 * every line it ever had is closed. A conversation with no line at all is not ours to touch.
 */
export function replyProjection(store, input) {
  const open = []; const closed = []; const overrides = {};
  for (const [scope, own] of store.replyLines()) {
    if (!scope.startsWith('beeper:')) continue;
    const chatID = scope.slice('beeper:'.length);
    (own.some(isOpen) ? open : closed).push(chatID);
  }
  for (const [chatID, f] of Object.entries(input.facts)) if (f.override) overrides[chatID] = f.override;
  return { checkedAt: input.checkedAt, open: open.sort(), closed: closed.sort(), overrides };
}

// The monitor rewrites those two files about once a minute and history.json is 6 MB: reading and
// parsing it on the request path held the loop for 30-200 ms per change. Requests take what a
// worker last read; a changed file starts one worker read, and the next request sees it. The
// first answer after a boot is `available: false` until the worker returns.
const jobs = defineJobs(import.meta.url, { readReplies: (dir) => readReplies(dir), readReconcileInput: (dir) => readReconcileInput(dir) });
const cached = new Map();

export function cachedReplies({ dir = replySourceDir() } = {}) {
  const none = { available: false, checkedAt: null, scopes: [], evidence: 0, creates: false };
  if (!dir) return none;
  let stamp = null;
  try { stamp = `${statSync(join(dir, 'ledger.json')).mtimeMs}:${statSync(join(dir, 'history.json')).mtimeMs}`; } catch { return cached.get(dir)?.value || none; }
  const entry = cached.get(dir) || { stamp: null, value: none, loading: false };
  cached.set(dir, entry);
  if (entry.stamp !== stamp && !entry.loading) {
    entry.loading = true;
    jobs('readReplies', dir)
      .then((value) => { entry.value = value; entry.stamp = stamp; })
      .catch(() => { entry.stamp = stamp; })
      .finally(() => { entry.loading = false; });
  }
  return entry.value;
}

/**
 * One reconcile pass against the live store, serialized, and answered with the projection. The
 * monitor files are parsed on a worker thread and only when one of them changed; the store work is
 * a handful of small sqlite reads. Never throws: a missing or half-written monitor snapshot leaves
 * every line exactly as it was and says so.
 */
let input = { dir: null, stamp: null, value: null };
let running = null;
export function syncReplyProjection(store, { dir = replySourceDir() } = {}) {
  if (!dir) return Promise.resolve({ available: false, reason: 'no reply source configured' });
  if (running) return running;
  running = (async () => {
    try {
      const stamp = `${statSync(join(dir, 'ledger.json')).mtimeMs}:${statSync(join(dir, 'history.json')).mtimeMs}`;
      if (input.dir !== dir || input.stamp !== stamp) input = { dir, stamp, value: await jobs('readReconcileInput', dir) };
      const report = reconcileReplies(store, input.value);
      return { available: true, report, ...replyProjection(store, input.value) };
    } catch (error) {
      return { available: false, reason: String(error?.message || error) };
    } finally { running = null; }
  })();
  return running;
}
