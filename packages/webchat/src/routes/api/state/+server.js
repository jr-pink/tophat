import { setLineStatus } from '$lib/server/notes-tasks.js';
import { cachedReplies } from '$lib/server/replies.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { json } from '@sveltejs/kit';
import { notesStore } from '$lib/server/notes-store.js';
import { stateReportResponse } from '$lib/server/state-report.js';
import { secretsDir } from '$lib/server/secrets.js';
import {
  STATE_SECTIONS, composeSection, newBlockId, sectionOf, setListState
} from '$lib/core/notes-doc.js';

// The system state area, from both ends. GET is the page's: the two sections and a hash of them,
// held open while nothing has changed so the page can follow the area without polling it down the
// wire. POST is the subagents': read the area, rewrite the generated lines of one section, tick a
// box, or ask the builder to run. only lines whose source is `system` belong to whoever writes here.

const MARKERS = ['todo', 'done', 'await', 'dropped', 'bullet'];
const POLL_MS = 1_000;
const WAIT_MS = 20_000;

// --- the gate -----------------------------------------------------------------------------------

// Read at request time, not at import: a token written after the server started is still the
// token, and a deployment that has none refuses every POST rather than accepting an empty bearer.
// Async: a read on the HTTP thread waits on the disk like any other.
async function serviceToken() {
  try { return (await readFile(join(secretsDir(), 'webchat-service-token'), 'utf8')).trim(); }
  catch { return ''; }
}

async function authorized(request) {
  const expected = await serviceToken();
  if (!expected) return false;
  const given = (request.headers.get('authorization') || '').replace(/^Bearer /iu, '');
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// --- reading ------------------------------------------------------------------------------------

/** When the area was last written, which is the newest line in it; null while it is empty. */
const builtAtOf = (blocks) =>
  blocks.reduce((latest, block) => (block.updatedAt > latest ? block.updatedAt : latest), '') || null;

/**
 * The brief's held-open shape (src/lib/server/brief.js, waitForChange), copied so there is one
 * pattern and not two: the page asks with the hash it already has and the answer is withheld until
 * that hash is stale or the wait runs out. One connection, no second protocol to drift, and an
 * idle tab costs one cheap hash a second instead of a document a second.
 */
async function waitForChange(store, since, { timeoutMs = WAIT_MS, pollMs = POLL_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (store.stateHash() === since && Date.now() < deadline) {
    const rest = Math.min(pollMs, Math.max(1, deadline - Date.now()));
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, rest);
      // An unreffed timer never holds the process open, which is what lets a test or a shutdown
      // finish while a long poll is still in the air.
      if (timer.unref) timer.unref();
    });
  }
  return store.stateHash() === since ? 'timeout' : 'changed';
}

/** Regeneration belongs to the pull, not to the push. The area is composed from live sources in about
 * a second with no model in it, while keeping it current from the other end would mean push holding
 * a pointer from every source to every line it had once written. So a read of a stale area starts a
 * rebuild and returns what is there; the held-open poll above delivers the new text a moment later.
 */
const REBUILD_AFTER_MS = 5 * 60_000;
const CHECK_EVERY_MS = 30_000;
let rebuilding = null;
let checkedAt = 0;

export function _refreshIfStale(store, { now = Date.now(), after = REBUILD_AFTER_MS, every = CHECK_EVERY_MS,
  env = process.env } = {}) {
  // A seeded area is the fixture a test is asserting against, so the harness holds this off; a
  // deployment leaves it on.
  if (env.WEBCHAT_STATE_REFRESH === '0') return null;
  if (rebuilding) return rebuilding;
  // The page holds this route open once a second; reading the area's age that often would be the
  // poll paying for the rebuild it almost never needs.
  if (now - checkedAt < every) return null;
  checkedAt = now;
  const built = builtAtOf(store.state());
  const age = built ? now - Date.parse(built) : Infinity;
  if (!(age > after)) return null;
  rebuilding = (async () => {
    try {
      const mod = await import('$lib/server/system-state.js');
      let offThread = null;
      try { offThread = mod.readSourcesOffThread; } catch { offThread = null; }
      // The sources are read on a worker thread (system-state.js); this thread only composes and writes.
      const now = new Date();
      await mod.buildSystemState({ store, now, facts: typeof offThread === 'function' ? await offThread({ now }) : null });
    } catch (cause) {
      // A builder that cannot run leaves the area exactly as it was; the read still answers.
      console.warn(`[state] rebuild on pull failed: ${String(cause?.message || cause)}`);
    } finally { rebuilding = null; }
  })();
  return rebuilding;
}

export async function GET({ url, request }) {
  // A request that presents a bearer was let past the session check in hooks.server.js on the
  // strength of that bearer alone, so this is where it is actually checked; a request without one
  // reached here only by holding a valid session cookie, and needs nothing further.
  const offered = request?.headers?.get('authorization') || '';
  if (offered && !(await authorized(request))) {
    return json({ error: 'not authorized' }, { status: 401, headers: { 'cache-control': 'no-store' } });
  }
  const store = notesStore();
  const replies = cachedReplies();
  _refreshIfStale(store);
  const since = url.searchParams.get('since');
  const wait = Number(url.searchParams.get('wait') || WAIT_MS);
  if (since) await waitForChange(store, since, { timeoutMs: Number.isFinite(wait) ? wait : WAIT_MS });
  const blocks = store.state();
  return json(
    { blocks, replies, hash: store.stateHash(), builtAt: builtAtOf(blocks) },
    { headers: { 'cache-control': 'no-store' } }
  );
}

// --- writing ------------------------------------------------------------------------------------

/** A section is found by its heading line, so a block that moved is still the same section. */
const sectionBlock = (store, name) => store.state().find((block) => sectionOf(block) === name) || null;

/** The body as lines, with the trailing blank the shells and the textareas leave behind removed. */
function bodyLines(body) {
  const text = String(body ?? '').replace(/\n+$/u, '');
  return text === '' ? [] : text.split('\n');
}

/** Replace or extend one section's generated lines. Saving with the `system` source then leaves his
 * lines alone, because a line the diff reports as unchanged keeps the source it already had.
 */
function writeSection(store, name, body, { append = false } = {}) {
  const generated = bodyLines(body);
  const block = sectionBlock(store, name);
  if (!block) {
    // A section with no block yet is created rather than refused, so a subagent can fill an area
    // the builder has not composed yet; it lands at the end and nothing else is reordered.
    const created = store.save({
      id: newBlockId(),
      body: [`## ${name}`, ...generated].join('\n'),
      zone: 'state',
      ord: store.appendOrd('state'),
      source: 'system'
    });
    return created;
  }
  return store.save({
    id: block.id,
    body: composeSection(block.lines, generated, { append }),
    zone: 'state',
    source: 'system'
  });
}

export async function POST({ request, getClientAddress }) {
  // The same gate as /api/agent: loopback only, no proxy headers, and a bearer equal to the
  // service token. Anything else is a 404, so a scan cannot even learn that the route is here.
  let address = '';
  try { address = getClientAddress(); } catch { address = ''; }
  const local = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
  const forwarded = request.headers.has('x-forwarded-for') || request.headers.has('cf-connecting-ip');
  if (!local || forwarded || !(await authorized(request))) return json({ error: 'not found' }, { status: 404 });

  const store = notesStore();
  const body = await request.json().catch(() => ({}));
  const op = String(body.op || '');

  if (op === 'read') {
    const blocks = store.state();
    return json({
      markdown: blocks.map((block) => block.body).join('\n\n'),
      sections: blocks.map((block) => ({
        name: sectionOf(block),
        blockId: block.id,
        lines: block.lines.map((line) => ({
          id: line.id, body: line.body, source: line.source, updatedAt: line.updatedAt
        }))
      })),
      hash: store.stateHash()
    }, { headers: { 'cache-control': 'no-store' } });
  }

  if (op === 'set' || op === 'append') {
    const section = String(body.section || '');
    if (!STATE_SECTIONS.includes(section)) {
      return json({ error: `no section "${section}"; it is one of ${STATE_SECTIONS.join(', ')}` }, { status: 400 });
    }
    const written = writeSection(store, section, body.body, { append: op === 'append' });
    return json({ section, blockId: written.id, body: written.body, hash: store.stateHash() });
  }

  if (op === 'check') {
    const section = String(body.section || '');
    const block = sectionBlock(store, section);
    if (!block) return json({ error: `no section "${section}" in the state area` }, { status: 400 });
    const index = Number(body.line);
    const target = Number.isInteger(index) ? block.lines[index] : undefined;
    if (!target) return json({ error: `no line ${body.line} in "${section}"` }, { status: 400 });
    const marker = String(body.state || '');
    if (!MARKERS.includes(marker)) {
      return json({ error: `state is one of ${MARKERS.join(', ')}` }, { status: 400 });
    }
    if (target.taskId && marker !== 'bullet') {
      const task = await setLineStatus(store, { lineId: target.id, status: marker, actor: 'agent' });
      return json({ section, blockId: block.id, line: index, body: store.line(target.id).body, task, hash: store.stateHash() });
    }
    const bodies = block.lines.map((line) => line.body);
    bodies[index] = setListState(bodies[index], marker);
    const written = store.save({ id: block.id, body: bodies.join('\n'), zone: 'state', source: target.source });
    return json({ section, blockId: written.id, line: index, body: bodies[index], hash: store.stateHash() });
  }

  if (op === 'report') {
    // An edit or a check-off in the state area, told to the memory plane as an owner report; the
    // next push cycle reads it and looks for the evidence. It never fails the edit, so a store
    // that is locked or missing comes back as a 200 saying so.
    const { status, payload } = await stateReportResponse({ store, body });
    return json(payload, { status });
  }

  if (op === 'rebuild') {
    // The builder is imported here and not at the top so this route answers even when it is not
    // installed: a missing builder is a 503 on one op, never a route that fails to load.
    let build = null;
    let offThread = null;
    try {
      const mod = await import('$lib/server/system-state.js');
      build = mod.buildSystemState;
      try { offThread = mod.readSourcesOffThread; } catch { offThread = null; }
    }
    catch { return json({ error: 'the builder is not installed yet' }, { status: 503 }); }
    if (typeof build !== 'function') return json({ error: 'the builder is not installed yet' }, { status: 503 });
    // A builder that fails says so with the hash the area still has; an unreadable source is the
    // builder's business to write down, and a crash must not leave the caller guessing.
    try {
      const now = new Date();
      await build({ store, now, facts: typeof offThread === 'function' ? await offThread({ now }) : null });
    }
    catch (cause) { return json({ error: String(cause?.message || cause), hash: store.stateHash() }, { status: 500 }); }
    return json({ hash: store.stateHash() });
  }

  return json({ error: `unknown op ${op}` }, { status: 400 });
}
