import { setLineStatus } from './notes-tasks.js';
// The system state area: five sections at the bottom of the notes page, composed from the real
// state of this machine and written back through the notes store as ordinary lines.
//
// Two rules govern everything here.
//
// 1. Every figure says where it came from and how fresh it is. A source that could not be read is
//    written into the line as `unknown (could not read <path>)`. Nothing is guessed, nothing is
//    quietly omitted, and no timestamp is printed bare: an age is always relative to `now`.
// 2. Ownership. A line whose source is not `system` is the owner's. The builder never overwrites it;
//    it re-emits it verbatim, in its existing relative order, below a `- ---` separator. See
//    keptLines() for the exact boundary, which is deliberately conservative.
//
// Read the installed state root, not a historical deployment name. Tests supply synthetic roots.
// Memory and runner overrides match the direct runner. Source databases are opened read-only.

// Two id spaces run through these sources and they are not the same: projects.json groups chats by
// webchat conversation id, while the goal ledgers and the work rows' source_refs name the runner's
// session id. readConversations() is the join between them; without it every cross-source count
// reads zero and looks broken while being wrong.

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { blocksFromLines, setListState } from '../core/notes-doc.js';
import { defineJobs } from './offload.js';

export const STATE_SECTIONS = ["what's going on", 'context'];
// Revision 1 folded these four headings into `what's going on`.
export const SUPERSEDED_SECTIONS = ['big rocks', 'inflight', 'todo', 'changes'];
export const SEPARATOR = '- ---';
const ZONE = 'state';
const DAY_ZONE = 'America/Los_Angeles';

export const sectionBlockId = (name) => `state-${String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;

export function defaultRoots({ home = homedir(), env = process.env } = {}) {
  const state = env.TOPHAT_STATE_DIR || join(home, '.local', 'state', 'tophat');
  return {
    home,
    state,
    projects: join(state, 'projects.json'),
    goals: env.TOPHAT_RUNNER_GOALS_DIR || join(state, 'rev5', 'goals'),
    memory: env.TOPHAT_RUNNER_DB || env.TOPHAT_REV5_MEMORY || join(state, 'rev5', 'memory.sqlite'),
    runner: env.TOPHAT_RUNNER_RUNNER_DB || join(state, 'rev5', 'runner.sqlite'),
    events: env.WEBCHAT_DB || join(state, 'webchat', 'events.sqlite'),
    baseline: join(state, 'baseline.md'),
    knowledge: env.TOPHAT_KNOWLEDGE_DIR || ''
  };
}

// --- time ---------------------------------------------------------------------------------------

/** How long ago, relative, never a bare timestamp: "12m", "4h", "3d". */
export function ageOf(at, now) {
  const then = Date.parse(at);
  if (!Number.isFinite(then)) return null;
  const ms = Math.max(0, now.getTime() - then);
  if (ms < 60 * 60 * 1000) return `${Math.round(ms / 60000)}m`;
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(ms / (24 * 60 * 60 * 1000))}d`;
}

/** The same, forced to whole days, for the standing context. */
export function daysOld(at, now) {
  const then = Date.parse(at);
  if (!Number.isFinite(then)) return null;
  return `${Math.floor(Math.max(0, now.getTime() - then) / (24 * 60 * 60 * 1000))}d`;
}

const localDay = (now, zone = DAY_ZONE) => now.toLocaleDateString('en-CA', { timeZone: zone });

/** ISO week of a local day string, as the week indexes name themselves (2026-W40). */
export function isoWeekKey(day) {
  const [year, month, date] = day.split('-').map(Number);
  const at = new Date(Date.UTC(year, month - 1, date));
  at.setUTCDate(at.getUTCDate() - ((at.getUTCDay() + 6) % 7) + 3);      // the Thursday of this week
  const firstThursday = new Date(Date.UTC(at.getUTCFullYear(), 0, 4));
  firstThursday.setUTCDate(firstThursday.getUTCDate() - ((firstThursday.getUTCDay() + 6) % 7) + 3);
  const week = 1 + Math.round((at - firstThursday) / (7 * 24 * 60 * 60 * 1000));
  return `${at.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

const quarterKey = (day) => `${day.slice(0, 4)}-Q${Math.floor((Number(day.slice(5, 7)) - 1) / 3) + 1}`;

/**
 * One line of text, flattened and cut to length. Em and en dashes in quoted source text become
 * plain hyphens: the words are the source's, the punctuation is this file's house style.
 */
const clip = (text, max = 96) => {
  const flat = String(text ?? '').replace(/[\u2014\u2013]/g, '-').replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 3);
  const space = cut.lastIndexOf(' ');
  const whole = space > max * 0.6 ? cut.slice(0, space) : cut;
  // a cut that ends on "an", "the", "of" reads worse than one word shorter
  return `${whole.replace(/\s+\S{1,3}$/, '').replace(/[,;:]$/, '')}...`;
};

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const unknown = (what, path) => `- ${what}: unknown (could not read ${path})`;
const tilde = (path, home = homedir()) => String(path).startsWith(home) ? `~${String(path).slice(home.length)}` : String(path);

// --- reading the sources ------------------------------------------------------------------------

function readJson(path) {
  try { return { ok: true, path, value: JSON.parse(readFileSync(path, 'utf8')), mtime: statSync(path).mtime.toISOString() }; }
  catch (error) { return { ok: false, path, error: String(error?.message || error) }; }
}

function readText(path) {
  try { return { ok: true, path, text: readFileSync(path, 'utf8'), mtime: statSync(path).mtime.toISOString() }; }
  catch (error) { return { ok: false, path, error: String(error?.message || error) }; }
}

function openRo(path) {
  if (!existsSync(path)) throw new Error(`no database at ${path}`);
  return new DatabaseSync(path, { readOnly: true });
}

/**
 * The webchat conversation table, read-only. This is the join between the runner's session ids
 * (goal ledgers, work source_refs) and projects.json's conversation ids.
 */
function readConversations(path) {
  let db = null;
  try {
    db = openRo(path);
    const bySession = new Map();
    const byId = new Map();
    for (const row of db.prepare('SELECT id, session_id, title FROM conversations').all()) {
      byId.set(row.id, row);
      if (row.session_id) bySession.set(row.session_id, row);
    }
    return { ok: true, path, byId, bySession };
  } catch (error) {
    return { ok: false, path, error: String(error?.message || error), byId: new Map(), bySession: new Map() };
  } finally { try { db?.close(); } catch { /* already closed */ } }
}

/** Every goal ledger, with its open items and the conversation it belongs to. */
function readGoals(dir, chats) {
  try {
    const files = readdirSync(dir).filter((name) => name.endsWith('.json'));
    const ledgers = [];
    for (const name of files) {
      const parsed = readJson(join(dir, name));
      if (!parsed.ok) continue;
      const ledger = parsed.value;
      const session = String(ledger.session_id || basename(name, '.json'));
      const chat = chats.bySession.get(session) || null;
      const items = Array.isArray(ledger.items) ? ledger.items : [];
      ledgers.push({
        session,
        short: session.slice(0, 8),
        conversationId: chat?.id || null,
        title: chat?.title || null,
        hook: ledger.hook || null,
        updatedAt: ledger.updated_at || parsed.mtime,
        items,
        open: items.filter((item) => item.status === 'todo')
      });
    }
    return { ok: true, path: dir, value: ledgers, files: files.length };
  } catch (error) { return { ok: false, path: dir, error: String(error?.message || error) }; }
}

const countRefs = (refs) => {
  try { const parsed = JSON.parse(refs); return Array.isArray(parsed) ? parsed.length : 0; }
  catch { return 0; }
};

/** The webchat session ids a work row's source_refs point at. */
const sessionsOf = (refs) => new Set(
  [...String(refs).matchAll(/webchat\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g)].map((hit) => hit[1])
);

/** The rev5 memory store, read-only. Never opened for writing, never written to. */
function readMemory(path, now) {
  let db = null;
  try {
    db = openRo(path);
    const all = (sql, ...args) => db.prepare(sql).all(...args);
    const one = (sql, ...args) => db.prepare(sql).get(...args);
    const since = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();

    const todo = all(`SELECT id, title, status, source_refs, created_at, updated_at
                      FROM work WHERE status = 'todo' ORDER BY updated_at DESC`)
      .map((row) => ({ ...row, refs: countRefs(row.source_refs), sessions: sessionsOf(row.source_refs) }));
    const counts = Object.fromEntries(all('SELECT status, COUNT(*) AS n FROM work GROUP BY status')
      .map((row) => [row.status, Number(row.n)]));
    const rockEntities = all(
      `SELECT e.id AS id, e.name AS name, e.type AS type, COUNT(*) AS n
         FROM work_entities we JOIN entities e ON e.id = we.entity_id JOIN work w ON w.id = we.work_id
        WHERE w.status = 'todo' AND e.merged_into IS NULL
        GROUP BY e.id ORDER BY n DESC LIMIT 40`);
    const linked = new Map();
    for (const row of all(
      `SELECT we.work_id AS work_id, we.entity_id AS entity_id
         FROM work_entities we JOIN work w ON w.id = we.work_id WHERE w.status = 'todo'`)) {
      if (!linked.has(row.work_id)) linked.set(row.work_id, new Set());
      linked.get(row.work_id).add(row.entity_id);
    }

    return {
      ok: true,
      path,
      todo,
      counts,
      rockEntities,
      linked,
      touched48h: Number(one('SELECT COUNT(*) AS n FROM work WHERE updated_at > ?', since)?.n || 0),
      recent48h: all(`SELECT id, title, status, source_refs, updated_at FROM work
                       WHERE updated_at > ? ORDER BY updated_at DESC`, since)
        .map((row) => ({ ...row, sessions: sessionsOf(row.source_refs) })),
      changes48h: all('SELECT kind, op, COUNT(*) AS n FROM changes WHERE at > ? GROUP BY kind, op ORDER BY n DESC', since),
      changesTotal: Number(one('SELECT COUNT(*) AS n FROM changes')?.n || 0),
      lastChangeAt: one('SELECT at FROM changes ORDER BY seq DESC LIMIT 1')?.at || null,
      recentEntities: all(`SELECT name, type, updated_at FROM entities WHERE merged_into IS NULL
                           ORDER BY updated_at DESC LIMIT 3`),
      entityCount: Number(one('SELECT COUNT(*) AS n FROM entities WHERE merged_into IS NULL')?.n || 0),
      noteCount: Number(one('SELECT COUNT(*) AS n FROM notes')?.n || 0),
      lastPush: one(`SELECT id, received_at FROM batches WHERE kind = 'push' ORDER BY received_at DESC LIMIT 1`) || null,
      batches48h: Number(one('SELECT COUNT(*) AS n FROM batches WHERE received_at > ?', since)?.n || 0),
      backlog: Number(one('SELECT COUNT(*) AS n FROM raw_data WHERE processed_batch IS NULL')?.n || 0),
      rawTotal: Number(one('SELECT COUNT(*) AS n FROM raw_data')?.n || 0),
      backlogOldest: one('SELECT MIN(available_at) AS at FROM raw_data WHERE processed_batch IS NULL')?.at || null
    };
  } catch (error) {
    return { ok: false, path, error: String(error?.message || error) };
  } finally { try { db?.close(); } catch { /* already closed */ } }
}

/** Running agents and background jobs, from the rev5 runner's own store, read-only. */
function readRunner(path) {
  let db = null;
  try {
    db = openRo(path);
    return {
      ok: true,
      path,
      agents: db.prepare(`SELECT id, description, created_at FROM agents WHERE status = 'running'
                          ORDER BY created_at DESC`).all(),
      jobs: db.prepare(`SELECT id, tool, started_at FROM jobs WHERE status = 'running'
                        ORDER BY started_at DESC`).all()
    };
  } catch (error) { return { ok: false, path, error: String(error?.message || error) }; }
  finally { try { db?.close(); } catch { /* already closed */ } }
}

/** The day's brief, if one was written; otherwise the newest brief within a week, said so. */
function readBrief(knowledge, now) {
  const day = localDay(now);
  for (let back = 0; back < 8; back += 1) {
    const at = new Date(Date.parse(`${day}T12:00:00Z`) - back * 24 * 60 * 60 * 1000);
    const key = at.toISOString().slice(0, 10);
    const path = join(knowledge, 'briefs', key.slice(0, 4), key.slice(5, 7), `${key}.md`);
    const found = readText(path);
    if (!found.ok) continue;
    const meta = readJson(`${path}.meta.json`);
    return { ...found, day: key, today: key === day, writtenAt: (meta.ok && meta.value.at) || found.mtime };
  }
  const path = join(knowledge, 'briefs', day.slice(0, 4), day.slice(5, 7), `${day}.md`);
  return { ok: false, path, day, error: 'no brief for today or the seven days before it' };
}

/** The index file for the horizon we want, or the newest one at or before it, marked as such. */
function newestIndex(dir, wanted) {
  try {
    const files = readdirSync(dir).filter((name) => name.endsWith('.md')).sort();
    const exact = wanted && files.includes(`${wanted}.md`) ? `${wanted}.md` : null;
    const name = exact || files.filter((file) => !wanted || file <= `${wanted}.md`).pop() || files[files.length - 1];
    if (!name) return { ok: false, path: dir, error: 'no index files in it' };
    const path = join(dir, name);
    return { ...readText(path), key: basename(name, '.md'), exact: Boolean(exact) };
  } catch (error) { return { ok: false, path: dir, error: String(error?.message || error) }; }
}

export function readSources({ roots = defaultRoots(), now = new Date() } = {}) {
  const day = localDay(now);
  const year = day.slice(0, 4);
  const knowledge = roots.knowledge;
  const chats = readConversations(roots.events);
  return {
    now,
    day,
    roots,
    chats,
    projects: readJson(roots.projects),
    goals: readGoals(roots.goals, chats),
    memory: readMemory(roots.memory, now),
    runner: readRunner(roots.runner),
    baseline: readText(roots.baseline),
    brief: readBrief(knowledge, now),
    week: newestIndex(join(knowledge, 'indexes', 'weeks', year), isoWeekKey(day)),
    month: newestIndex(join(knowledge, 'indexes', 'months', year), day.slice(0, 7)),
    quarter: newestIndex(join(knowledge, 'indexes', 'quarters', year), quarterKey(day)),
    year: newestIndex(join(knowledge, 'indexes', 'years'), year)
  };
}

// Reading the sources is a pile of synchronous sqlite queries over the rev5 store (2 GB) and JSON
// reads: 805 ms of stopped event loop on the live server, every five minutes, in the middle of
// whatever chat was streaming. It runs on a worker thread and the page's request only ever does
// the cheap composing and writing.
const jobs = defineJobs(import.meta.url, {
  readSources: (roots, nowMs) => readSources({ roots, now: new Date(nowMs) })
});

/** `readSources` without holding the thread: the same facts, read by a worker. */
export async function readSourcesOffThread({ roots = defaultRoots(), now = new Date() } = {}) {
  const facts = await jobs('readSources', roots, now.getTime());
  return { ...facts, now };
}

// --- the importance score -----------------------------------------------------------------------

/**
 * How a todo work row earns its place in the top fifteen. Three bounded terms, so that no single
 * term can run away with the list:
 *
 *   recency   2 / (1 + days since updated_at)   2.0 today, 1.0 at one day, 0.5 at three days, ~0 at a month
 *   evidence  log10(1 + source_refs)            0.3 for one ref, 1.0 for ten, 1.8 for sixty-six
 *   rock      1.5 when it is linked to a big rock, 0 otherwise
 *
 * Recency decays hyperbolically, halving after a day, because this is a dashboard: what he touched
 * today is what he is in the middle of. Evidence is logarithmic because the difference between one
 * reference and ten says something and the difference between sixty and seventy does not. The rock
 * bonus is a flat 1.5, worth about a day of freshness, so belonging to a big rock lifts an item
 * without letting a stale item outrank something live.
 */
export function importanceScore(item, { now, rockEntityIds = new Set(), linked = new Map() } = {}) {
  const updated = Date.parse(item.updated_at);
  const days = Number.isFinite(updated) ? Math.max(0, (now.getTime() - updated) / 86400000) : 365;
  const recency = 2 / (1 + days);
  const evidence = Math.log10(1 + (item.refs ?? 0));
  const entities = linked.get(item.id) || new Set();
  const onRock = [...entities].some((id) => rockEntityIds.has(id));
  return recency + evidence + (onRock ? 1.5 : 0);
}

// --- what's going on: one threaded section ------------------------------------------------------
//
// Revision 1 of the contract folded the old `big rocks`, `inflight`, `todo` and `changes` headings
// into one section. They survive as KINDS OF LINE inside a thread rather than as headings: the thread
// line says what the rock is, and under it, indented, are what is in flight, what is still to do and
// what changed. Biggest rock first, both between threads and inside one.
//
// Every generated line ends with its importance as an HTML comment, `<!--w:0.82-->`, which the page
// reads and strips. One scale across the whole section, threads and details together, because the
// fold rule compares a thread's score with another thread's children's scores.

const THREAD_LIMIT = 8;
const KID_LIMIT = 4;
export const SCORE_RE = /\s*<!--w:(\d+(?:\.\d+)?)-->\s*$/;
export const stripScore = (body) => String(body ?? '').replace(SCORE_RE, '');
export const scoreOf = (body) => {
  const hit = SCORE_RE.exec(String(body ?? ''));
  return hit ? Number(hit[1]) : null;
};

const kid = (text, raw, workId = null) => ({ text, raw, workId });

/** The work items a thread's chats produced, by mapping runner session ids to conversation ids. */
function workUnder(rows, chats, belongs) {
  if (!chats.ok) return null;
  return rows.filter((row) => [...row.sessions].some((session) => belongs(chats.bySession.get(session)?.id)));
}

/** One thread per project grouping in projects.json, biggest rock first. */
function projectThreads(facts, now) {
  const out = [];
  if (!facts.projects.ok) {
    out.push({ text: `the chat groupings: unknown (could not read ${facts.projects.path})`, raw: 0.05, kids: [] });
    return out;
  }
  const memory = facts.memory;
  const at = ageOf(facts.projects.value.generated_at, now);
  const window = facts.projects.value.window_days ?? '?';
  for (const project of facts.projects.value.projects || []) {
    const threads = Array.isArray(project.threads) ? project.threads : [];
    const belongs = (id) => Boolean(id) && threads.some((thread) => id.startsWith(thread));
    const kids = [];

    const open = memory.ok ? workUnder(memory.todo, facts.chats, belongs) : null;
    const goals = facts.goals.ok
      ? facts.goals.value.filter((ledger) => belongs(ledger.conversationId))
      : null;
    const openGoals = goals ? goals.flatMap((ledger) => ledger.open.map((item) => ({ ...item, ledger }))) : [];

    // in flight: what a subagent is holding open in one of this project's chats
    for (const item of openGoals.sort((a, b) => Date.parse(b.updated_at || 0) - Date.parse(a.updated_at || 0)).slice(0, 2)) {
      const age = ageOf(item.updated_at || item.created_at, now);
      kids.push(kid(`- [ ] ${clip(item.text, 62)} (a subagent has this open in "${clip(item.ledger.title || item.ledger.short, 26)}", ${age}) <<kid>>`,
        1.2 + importanceScore({ id: item.id, refs: 0, updated_at: item.updated_at || item.created_at }, { now })));
    }
    // still to do: the heaviest open work rows that came out of these chats
    if (open === null) {
      kids.push(kid(`- still to do: unknown (could not read ${memory.ok ? facts.chats.path : memory.path}) <<kid>>`, 0.05));
    } else {
      for (const item of open.map((row) => ({ row, raw: importanceScore(row, { now, linked: memory.linked }) }))
        .sort((a, b) => b.raw - a.raw).slice(0, 2)) {
        kids.push(kid(`- [ ] ${clip(item.row.title, 62)} (${ageOf(item.row.updated_at, now)} old, ${item.row.refs} refs, memory.sqlite work) <<kid>>`, item.raw, item.row.id));
      }
    }
    // what changed: work under this project the memory store touched in the last 48h. It is the
    // fourth kind of line the old sections became, so it keeps a slot of its own rather than
    // competing for one with the open work, which always outscores it.
    const tail = [];
    if (memory.ok && facts.chats.ok) {
      const changed = workUnder(memory.recent48h, facts.chats, belongs) || [];
      const newest = changed[0];
      tail.push(kid(newest
        ? `- ${changed.length} of its work items changed in the last 48h, newest "${clip(newest.title, 36)}" went ${newest.status} ${ageOf(newest.updated_at, now)} ago (memory.sqlite work) <<kid>>`
        : `- nothing under it changed in the last 48h (memory.sqlite work) <<kid>>`,
      newest ? 0.6 + Math.log10(1 + changed.length) : 0.2));
    }
    kids.sort((a, b) => b.raw - a.raw);
    kids.splice(KID_LIMIT - tail.length);
    kids.push(...tail);
    // The tail is guaranteed a slot, not the last place: it can outscore the open work left in the
    // list, and the contract is biggest first inside a thread too.
    kids.sort((a, b) => b.raw - a.raw);

    const size = (open?.length ?? 0) + openGoals.length;
    const counts = [
      open === null ? `open work unknown (could not read ${memory.ok ? facts.chats.path : memory.path})` : `${plural(open.length, 'open work item')}`,
      goals === null ? `open goal items unknown (could not read ${facts.goals.path})` : `${plural(openGoals.length, 'open goal item')}`,
      `${plural(threads.length, 'chat')} in ${window}d`
    ].join(', ');
    const what = clip(String(project.what || '').replace(/^He is /, '').replace(/\.$/, ''), 62);
    out.push({
      text: `- ${clip(project.name, 38)}: ${what}; ${counts} (projects.json, ${at}) <<thread>>`,
      raw: Math.max(0, ...kids.map((entry) => entry.raw)) + 0.4 * Math.log10(1 + size),
      kids
    });
  }
  return out;
}

/** A thread per effort in the memory store that many open work items point at. */
function entityThreads(facts, now, named) {
  if (!facts.memory.ok) return [];
  const memory = facts.memory;
  const byEntity = new Map();
  for (const [workId, entities] of memory.linked) {
    for (const id of entities) {
      if (!byEntity.has(id)) byEntity.set(id, []);
      byEntity.get(id).push(workId);
    }
  }
  const rows = new Map(memory.todo.map((row) => [row.id, row]));
  // An effort, not a person, a file or a service: those are how work is tagged, not what it is for.
  return memory.rockEntities
    .filter((entity) => ['project', 'defect', 'effort'].includes(entity.type) && entity.n >= 4
      && !named.has(entity.name.toLowerCase()))
    .map((entity) => {
      const items = (byEntity.get(entity.id) || []).map((id) => rows.get(id)).filter(Boolean)
        .map((row) => ({ row, raw: importanceScore(row, { now, linked: memory.linked }) }))
        .sort((a, b) => b.raw - a.raw);
      const kids = items.slice(0, 3).map((item) =>
        kid(`- [ ] ${clip(item.row.title, 62)} (${ageOf(item.row.updated_at, now)} old, ${item.row.refs} refs, memory.sqlite work) <<kid>>`, item.raw, item.row.id));
      return {
        entityId: entity.id,
        workIds: items.map((item) => item.row.id),
        text: `- ${clip(entity.name, 58)}: ${plural(entity.n, 'open work item')} point at it (memory.sqlite work_entities) <<thread>>`,
        raw: Math.max(0, ...kids.map((entry) => entry.raw)) + 0.4 * Math.log10(1 + entity.n),
        kids
      };
    });
}

/** The last thread: the memory plane itself, which is what the old `changes` section was about. */
function planeThread(facts, now) {
  const memory = facts.memory;
  const kids = [];
  if (!memory.ok) {
    return {
      text: `- the rev5 memory plane: unknown (could not read ${memory.path}) <<thread>>`,
      raw: 0.05,
      kids: runnerKids(facts, now)
    };
  }
  const total = memory.changes48h.reduce((sum, row) => sum + Number(row.n), 0);
  kids.push(kid(`- by kind and op: ${memory.changes48h.slice(0, 5).map((row) => `${row.kind} ${row.op} ${row.n}`).join(', ') || 'none'} (over ${memory.batches48h} batches in 48h) <<kid>>`, 0.9));
  kids.push(kid(`- entities touched last: ${memory.recentEntities.map((row) => `${clip(row.name, 34)} (${row.type}, ${ageOf(row.updated_at, now)})`).join('; ') || 'none'} (memory.sqlite entities) <<kid>>`, 0.8));
  kids.push(kid(memory.lastPush
    ? `- last push batch ${memory.lastPush.id}, ${ageOf(memory.lastPush.received_at, now)} ago (memory.sqlite batches where kind = push) <<kid>>`
    : '- no push batch has ever landed (memory.sqlite batches) <<kid>>', 0.95));
  kids.push(kid(`- raw backlog ${memory.backlog} of ${memory.rawTotal} rows unprocessed, oldest ${ageOf(memory.backlogOldest, now)} old (memory.sqlite raw_data where processed_batch IS NULL) <<kid>>`,
    0.7 + 0.2 * Math.log10(1 + memory.backlog)));
  kids.push(...runnerKids(facts, now));
  kids.sort((a, b) => b.raw - a.raw);
  return {
    text: `- the rev5 memory plane itself: ${total} changes in the last 48h of ${memory.changesTotal} ever, last one ${ageOf(memory.lastChangeAt, now)} ago, ${memory.entityCount} live entities and ${memory.noteCount} notes (memory.sqlite) <<thread>>`,
    raw: Math.max(0, ...kids.map((entry) => entry.raw)) + 0.4 * Math.log10(1 + memory.backlog),
    kids
  };
}

function runnerKids(facts, now) {
  if (!facts.runner.ok) return [kid(`- agents and background jobs: unknown (could not read ${facts.runner.path}) <<kid>>`, 0.05)];
  const newest = facts.runner.agents[0];
  return [kid(`- ${plural(facts.runner.agents.length, 'agent')} and ${plural(facts.runner.jobs.length, 'background job')} running${newest ? `, newest "${clip(newest.description, 34)}" ${ageOf(newest.created_at, now)} in` : ''} (rev5 runner.sqlite) <<kid>>`, 1.1)];
}

/** Sources that answered nothing at all still say so, with their path, at the foot of the section. */
function unreadableThreads(facts) {
  const out = [];
  for (const [key, label] of [['goals', 'the goal ledgers'], ['chats', 'the chat titles and their session ids'], ['runner', 'the runner store']]) {
    if (!facts[key]?.ok) out.push({ text: `- ${label}: unknown (could not read ${facts[key]?.path}) <<thread>>`, raw: 0.04, kids: [] });
  }
  return out;
}

function whatsGoingOn(facts, now) {
  const named = new Set(facts.projects.ok
    ? (facts.projects.value.projects || []).map((project) => String(project.name).toLowerCase()) : []);
  const ranked = [
    ...projectThreads(facts, now),
    ...entityThreads(facts, now, named),
    planeThread(facts, now),
    ...unreadableThreads(facts)
  ].sort((a, b) => b.raw - a.raw);

  // A work row shown under the thread that owns it is not repeated under a second thread, and an
  // effort whose every item has already been shown above does not get a thread of its own.
  const shown = new Set();
  const threads = [];
  for (const thread of ranked) {
    const kids = [];
    for (const entry of thread.kids) {
      if (kids.length >= KID_LIMIT) break;
      if (entry.workId && shown.has(entry.workId)) continue;
      if (entry.workId) shown.add(entry.workId);
      kids.push(entry);
    }
    if (thread.entityId && kids.length === 0) continue;
    threads.push({ ...thread, kids });
    if (threads.length >= THREAD_LIMIT) break;
  }

  const lines = [];
  const weights = [];
  for (const thread of threads) {
    lines.push(thread.text);
    weights.push(thread.raw);
    for (const entry of thread.kids) {
      lines.push(`  ${entry.text}${entry.workId ? ` <!--task:${entry.workId}-->` : ''}`);
      weights.push(entry.raw);
    }
  }
  const top = Math.max(1, ...weights);
  return lines.map((line, index) => line
    .replace(' <<thread>>', '')
    .replace(' <<kid>>', '')
    + ` <!--w:${(weights[index] / top).toFixed(2)}-->`);
}

/**
 * The first `count` paragraphs of an index file that carry content. Paragraphs, not lines, because
 * these files hard-wrap their prose and a line off the top of one is a fragment of a sentence.
 */
function contentLines(text, count = 1) {
  const out = [];
  let current = [];
  const flush = () => {
    const joined = current.join(' ').trim();
    current = [];
    if (joined) out.push(joined.replace(/^[-*]\s+/, '').replace(/\*\*/g, ''));
  };
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('<!--') || line.startsWith('#')) { flush(); }
    else if (/^[-*]\s/.test(line)) { flush(); current.push(line); }
    else current.push(line);
    if (out.length >= count) return out;
  }
  flush();
  return out.slice(0, count);
}

function horizon(label, index, now, wanted) {
  if (!index?.ok) return [`- ${label}: unknown (could not read ${index?.path || 'its index'})`];
  const old = daysOld(index.mtime, now);
  const which = !index.exact && wanted ? `${index.key} (nothing for ${wanted} yet)` : index.key;
  const [first, second] = contentLines(index.text, 2);
  return [
    `- ${label} ${which}: ${clip(first || '(no prose in it)', 92)} (${old})`,
    `- ${label} also: ${clip(second || tilde(index.path), 92)} (${old})`
  ];
}

function context(facts, now) {
  const lines = [];
  const brief = facts.brief;
  if (!brief.ok) lines.push(`- day: unknown (could not read ${brief.path})`);
  else {
    const open = (brief.text.match(/^\s*-\s*\[ \]/gm) || []).length;
    const done = (brief.text.match(/^\s*-\s*\[x\]/gim) || []).length;
    const today = brief.text.match(/##\s*Today\s*\n+([^\n]+)/);
    const old = daysOld(brief.writtenAt, now);
    lines.push(`- day ${brief.day}${brief.today ? '' : ' (no brief written for today)'}: ${clip(today?.[1] || contentLines(brief.text, 1)[0] || '', 86)} (${old})`);
    lines.push(`- day brief carries ${open} open and ${done} done todos (${tilde(brief.path)}, ${old})`);
  }
  lines.push(...horizon('week', facts.week, now, isoWeekKey(facts.day)));
  lines.push(...horizon('month', facts.month, now, facts.day.slice(0, 7)));
  lines.push(...horizon('quarter', facts.quarter, now, quarterKey(facts.day)));
  lines.push(...horizon('year', facts.year, now, facts.day.slice(0, 4)));
  if (!facts.baseline.ok) lines.push(`- standing context: unknown (could not read ${facts.baseline.path})`);
  else {
    const era = facts.baseline.text.match(/##\s*The era he is in\s*\n+([^\n]+)/);
    const streams = (facts.baseline.text.match(/^- [a-z0-9-]+: [\d.]+ MB, rebuilt/gm) || []).length;
    const old = daysOld(facts.baseline.mtime, now);
    lines.push(`- era, from baseline.md: ${clip(era?.[1] || '', 88)} (${old})`);
    lines.push(`- baseline.md holds ${(facts.baseline.text.match(/^## /gm) || []).length} standing sections and ${streams} attention streams (${old})`);
  }
  return scoreContext(lines);
}

/**
 * Context lines are in the order the contract fixes, ascending horizon, so their scores are not
 * what sorts them. They exist because revision 1 says every generated line carries one and the
 * page's fold rule reads them. Freshness is the honest weight here: a line ends with how old its
 * source is in days, so 1 / (1 + days) is read straight back off the line it scores.
 */
function scoreContext(lines) {
  const raws = lines.map((line) => {
    const days = /(\d+)d\)\s*$/.exec(line);
    return days ? 1 / (1 + Number(days[1])) : 0.05;
  });
  const top = Math.max(...raws);
  return lines.map((line, index) => `${line} <!--w:${(raws[index] / top).toFixed(2)}-->`);
}

// --- ownership ----------------------------------------------------------------------------------

/**
 * The lines of a section that are the owner's and must survive a rebuild verbatim.
 *
 * Above the separator a line is his when its source is not `system`. Everything below the
 * separator is his whatever its source says: the separator is the durable mark of the boundary, so
 * a line that has already been preserved once stays preserved even if some write path stamps a
 * whole block with one source.
 */
export function keptLines(lines) {
  const kept = [];
  let below = false;
  for (const line of lines.slice(1)) {
    if (line.body.trim() === SEPARATOR) { below = true; continue; }
    if (below || (line.source || 'type') !== 'system') kept.push(line.body);
  }
  while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
  return kept;
}

export function composeSection(name, generated, existingLines = []) {
  const kept = keptLines(existingLines);
  return [`## ${name}`, ...generated, ...(kept.length ? [SEPARATOR, ...kept] : [])].join('\n');
}

// --- the store side -----------------------------------------------------------------------------

/** The state zone's blocks, through store.state() where it exists, else derived from its lines. */
export function stateBlocks(store) {
  if (typeof store.state === 'function') return store.state();
  if (typeof store.lines === 'function') return blocksFromLines(store.lines(ZONE));
  return [];
}

export function stateHash(store) {
  if (typeof store.stateHash === 'function') return store.stateHash();
  const digest = createHash('sha256');
  for (const block of stateBlocks(store)) {
    for (const line of block.lines || []) digest.update(`${line.id}\u0000${line.body}\u0000${line.updatedAt}\n`);
  }
  return digest.digest('hex');
}

export const sectionOf = (block) => {
  const head = block?.lines?.[0]?.body ?? String(block?.body ?? '').split('\n')[0];
  const match = /^##\s+(.+?)\s*$/.exec(head || '');
  return match ? match[1] : null;
};

const findSection = (store, name) => stateBlocks(store).find((block) => sectionOf(block) === name) || null;

function writeSection(store, name, generated) {
  const block = findSection(store, name);
  const bindings = [];
  generated = generated.filter(text => {
    const id = / <!--task:([a-zA-Z0-9_-]+)-->/.exec(text)?.[1];
    const existing = id && store.taskLine?.(id);
    return !existing || existing.source === 'system';
  });
  const body = composeSection(name, generated, block?.lines || []).split('\n').map((text, index) => {
    const match = / <!--task:([a-zA-Z0-9_-]+)-->/.exec(text);
    if (match) bindings.push({ index, taskId: match[1] });
    return text.replace(/ <!--task:[a-zA-Z0-9_-]+-->/g, '');
  }).join('\n');
  const entries = body.split('\n').map((text, index) => {
    const bound = bindings.find(b => b.index === index);
    const previous = bound ? block?.lines.find(line => line.taskId === bound.taskId) : block?.lines.find(line => line.body === text);
    return { id: previous?.id || (bound ? `work-${bound.taskId}` : null), body: text };
  });
  const saved = store.save({ id: block?.id || sectionBlockId(name), body, lines: entries, zone: ZONE, source: 'system' });
  for (const { index, taskId } of bindings) {
    const line = saved.lines[index];
    if (line && !line.taskId && store.bindLine) store.bindLine(line.id, taskId);
  }
}

/** Read the state area back out: the markdown, the sections, their lines and the hash. */
export function readState(store) {
  const sections = [];
  for (const block of stateBlocks(store)) {
    const name = sectionOf(block);
    sections.push({
      name: name || null,
      blockId: block.id,
      lines: (block.lines || []).map((line) => ({
        id: line.id, body: line.body, source: line.source || 'type', updatedAt: line.updatedAt
      }))
    });
  }
  return {
    markdown: sections.map((section) => section.lines.map((line) => line.body).join('\n')).join('\n\n'),
    sections,
    hash: stateHash(store)
  };
}

/** Replace a section's generated lines, keeping the owner's. `body` is newline separated, no heading. */
export function setSection(store, name, body) {
  const lines = String(body ?? '').split('\n');
  writeSection(store, name, lines.length === 1 && !lines[0] ? [] : lines);
  return stateHash(store);
}

/** Add generated lines at the end of a section's generated run. */
export function appendSection(store, name, body) {
  const block = findSection(store, name);
  const run = [];
  for (const line of (block?.lines || []).slice(1)) {
    if (line.body.trim() === SEPARATOR) break;
    if ((line.source || 'type') === 'system') run.push(line.body);
  }
  const added = String(body ?? '').split('\n');
  writeSection(store, name, [...run, ...(added.length === 1 && !added[0] ? [] : added)]);
  return stateHash(store);
}

/** Set one line's marker. `line` is the 0-based index within the section, heading included. */
export async function checkLine(store, name, index, state) {
  const block = findSection(store, name);
  if (!block) throw new Error(`no section named "${name}"`);
  const lines = (block.lines || []).map((line) => line.body);
  if (!Number.isInteger(index) || index < 0 || index >= lines.length) {
    throw new Error(`section "${name}" has ${lines.length} lines, so there is no line ${index}`);
  }
  if (block.lines[index].taskId && state !== 'bullet') {
    await setLineStatus(store, { lineId: block.lines[index].id, status: state, actor: 'agent' });
    return stateHash(store);
  }
  lines[index] = setListState(lines[index], state);
  store.save({ id: block.id, body: lines.join('\n'), zone: ZONE, source: block.lines[index]?.source || 'system' });
  return stateHash(store);
}

/**
 * Compose the five sections from the real sources and write them through the store. A section that
 * already exists is rewritten in place; a missing one is appended in contract order; nothing is
 * reordered and nothing of the owner's is dropped.
 */
export function buildSystemState({ store, now = new Date(), roots = defaultRoots(), facts = null } = {}) {
  const read = facts || readSources({ roots, now });
  const composed = {
    "what's going on": whatsGoingOn(read, now),
    context: context(read, now)
  };
  for (const name of STATE_SECTIONS) writeSection(store, name, composed[name]);
  retireSupersededSections(store);
  return { ...readState(store), builtAt: now.toISOString(), sources: sourceReport(read) };
}

/** `buildSystemState` with the sources read on a worker thread: the caller's thread only composes and writes. */
export async function buildSystemStateOffThread({ store, now = new Date(), roots = defaultRoots() } = {}) {
  const facts = await readSourcesOffThread({ roots, now });
  return buildSystemState({ store, now, roots, facts });
}

/** The four headings revision 1 folded into one. The ownership rule does not stop at a rename. */
export function retireSupersededSections(store) {
  if (typeof store.remove !== 'function') return [];
  const retired = [];
  for (const block of stateBlocks(store)) {
    const name = sectionOf(block);
    if (!SUPERSEDED_SECTIONS.includes(name)) continue;
    if (keptLines(block.lines || []).length > 0) continue;
    store.remove(block.id);
    retired.push(name);
  }
  return retired;
}

/** Which sources answered and which did not, for a caller that wants to say so. */
export function sourceReport(facts) {
  const out = {};
  for (const key of ['projects', 'goals', 'memory', 'runner', 'chats', 'baseline', 'brief', 'week', 'month', 'quarter', 'year']) {
    const source = facts[key];
    out[key] = { ok: Boolean(source?.ok), path: source?.path, error: source?.ok ? null : source?.error || null };
  }
  return out;
}
