// The /api/docs/<token>/* endpoints. Every handler starts from the token in its own path, answers
// 404 for one that was never minted, and is handed only that document's store (docs.js). The notes
// handlers are the very ones /api/notes runs (notes-routes.js), with no owner hooks and no zone
// operations, wrapped in the size and rate limits a public surface needs.
import { error, json } from '@sveltejs/kit';
import { app } from './app.js';
import { SESSION_COOKIE } from './auth.js';
import { allow, cleanName, docs, LIMITS, OWNER_NAME, TOKEN_RE } from './docs.js';
import { notesRoutes } from './notes-routes.js';
import { guestOf } from './doc-guest-routes.js';
import { cleanCursor } from '../core/doc-presence.js';

const NO_STORE = { 'cache-control': 'no-store' };
const HEARTBEAT_MS = 15_000;
const PUSH_BYTES = 256 * 1024;   // the largest write carried on the live push itself

/** The token of a request, or a 404 for one that was never minted (or is malformed). */
export function docToken(params = {}) {
  const token = String(params.token || '');
  if (!TOKEN_RE.test(token) || !docs().exists(token)) error(404, 'No such document');
  return token;
}

const header = (request, name) => {
  const raw = request.headers.get(name);
  if (!raw) return '';
  try { return decodeURIComponent(raw); } catch { return raw; }
};

/**
 * Who is writing. A tab holding his session is the owner and is always "the owner", whatever it
 * sends. A tab holding a verified guest passkey cookie (doc-guests.js) is the name stored with
 * that passkey, whatever x-doc-name says, and is still never the owner. Anyone else is the name
 * their tab says, cleaned: a label, spoofable. The client id is the tab's own, used for echo
 * suppression and for deleting one's own comment; it proves nothing beyond that.
 */
export function whoOf({ request, cookies, url }) {
  const owner = Boolean(cookies && app.auth.valid(cookies.get(SESSION_COOKIE)));
  const sent = header(request, 'x-doc-name') || url?.searchParams?.get('name') || '';
  const client = (header(request, 'x-doc-client') || request.headers.get('x-tophat-client') || url?.searchParams?.get('client') || '').slice(0, 64);
  const guest = owner ? null : guestOf(cookies);
  return {
    owner,
    name: owner ? OWNER_NAME : guest ? guest.name : cleanName(sent),
    client,
    guestId: guest?.guestId ?? null,
    bound: Boolean(guest)
  };
}

const clientIp = (event) => event.request.headers.get('cf-connecting-ip')
  || (() => { try { return event.getClientAddress(); } catch { return 'local'; } })();

function limited(event, token, kind, rate) {
  if (whoOf(event).owner) return null;
  if (allow(`${kind}:${token}:${clientIp(event)}`, rate)) return null;
  return json({ error: 'Too many writes; slow down' }, { status: 429, headers: { 'retry-after': '2', ...NO_STORE } });
}

function tooBig(event) {
  const length = Number(event.request.headers.get('content-length') || 0);
  return length > LIMITS.bodyBytes ? json({ error: 'Too large' }, { status: 413 }) : null;
}

/** What a public write may not do: too many blocks, a line too long, a document grown too big. */
function shapeRefusal(store, body) {
  const blocks = Array.isArray(body.blocks) ? body.blocks : body.block ? [body.block] : [];
  if (blocks.length > LIMITS.blocksPerWrite) return json({ error: 'Too many blocks in one write' }, { status: 413 });
  for (const block of blocks) {
    const text = String(block?.body ?? '');
    if (text.length > LIMITS.blocksPerWrite * LIMITS.lineChars) return json({ error: 'Block too large' }, { status: 413 });
    if (text.split('\n').some((line) => line.length > LIMITS.lineChars)) return json({ error: 'Line too long' }, { status: 413 });
  }
  if (blocks.length && store.count() > LIMITS.linesPerDoc) return json({ error: 'This document is full' }, { status: 413 });
  return null;
}

const startedAt = new WeakMap();
const notes = notesRoutes({
  store: (event) => docs().store(docToken(event.params)),
  zoneOps: false,
  guard: (event, body) => shapeRefusal(docs().store(docToken(event.params)), body),
  onWrite: (event, answer) => {
    const token = docToken(event.params);
    const who = whoOf(event);
    const since = startedAt.get(event.request) || null;
    const lines = [...(answer.blocks || []), ...(answer.past || []), ...(answer.future || []), ...(answer.state || [])]
      .flatMap((block) => block?.lines || []);
    try { docs().attribute(token, lines, who, since); } catch { /* the gutter label is not worth failing a write */ }
    // The answer goes back with the authors on it, so the writing tab sees its own name at once.
    for (const key of ['blocks', 'past', 'future', 'state']) if (Array.isArray(answer[key])) answer[key] = docs().decorate(token, answer[key]);
    docs().touch(token);
    // The written blocks ride on the push, documents included, so the other tabs merge them at
    // once instead of reading the document back (one round trip instead of two). A write too big
    // to carry goes out as a bare signal and the tabs read it, as before.
    // A move (archive to the @@archive marker, a drag) answers with the whole document and can
    // dissolve a block; merging those blocks by id would leave the dissolved one on the other
    // tabs, so a move goes out as the bare signal and the tabs read the document.
    const structural = 'archived' in answer || 'promoted' in answer || 'moved' in answer;
    const written = Array.isArray(answer.blocks) && !structural ? answer.blocks.filter((block) => block && Array.isArray(block.lines)) : [];
    let carried = null;
    if (written.length && written.length === (answer.blocks || []).length) {
      try { if (JSON.stringify(written).length <= PUSH_BYTES) carried = written; } catch { carried = null; }
    }
    docs().broadcast(token, { topic: 'doc', origin: who.client || null, ...(carried ? { blocks: carried, at: Date.now() } : {}) });
  }
});

// The notes reads come back with each line's last author on it.
async function decorated(event, response) {
  if (!response.ok) return response;
  const token = docToken(event.params);
  const body = await response.json();
  for (const key of ['blocks', 'past', 'future', 'state']) if (Array.isArray(body[key])) body[key] = docs().decorate(token, body[key]);
  return json(body, { headers: NO_STORE });
}

export async function notesGET(event) {
  docToken(event.params);
  return decorated(event, await notes.GET(event));
}

export async function notesPOST(event) {
  const token = docToken(event.params);
  const refused = tooBig(event) || limited(event, token, 'write', { perSecond: 25, burst: 120 });
  if (refused) return refused;
  startedAt.set(event.request, new Date(Date.now() - 1).toISOString());
  return notes.POST(event);
}

export async function notesDELETE(event) {
  const token = docToken(event.params);
  const refused = tooBig(event) || limited(event, token, 'write', { perSecond: 25, burst: 120 });
  if (refused) return refused;
  return notes.DELETE(event);
}

// --- meta --------------------------------------------------------------------------------------

export function metaGET(event) {
  const token = docToken(event.params);
  const who = whoOf(event);
  return json({ ...docs().info(token), me: { owner: who.owner, name: who.owner ? OWNER_NAME : who.bound ? who.name : null, bound: who.bound } }, { headers: NO_STORE });
}

/** Anyone with the link may rename it, as an editor of a shared Google Doc may. */
export async function metaPOST(event) {
  const token = docToken(event.params);
  const refused = tooBig(event) || limited(event, token, 'meta', { perSecond: 1, burst: 10 });
  if (refused) return refused;
  const body = await event.request.json().catch(() => ({}));
  if (typeof body.title !== 'string') return json({ error: 'title is required' }, { status: 400 });
  const info = docs().rename(token, body.title);
  docs().broadcast(token, { topic: 'meta', origin: whoOf(event).client || null, title: info.title });
  return json(info, { headers: NO_STORE });
}

// --- comments ----------------------------------------------------------------------------------

export function commentsGET(event) {
  const token = docToken(event.params);
  return json({ threads: docs().threads(token, { who: whoOf(event) }) }, { headers: NO_STORE });
}

function commentAnswer(event, token, result) {
  if (result.error) return json({ error: result.error }, { status: result.status || 400 });
  docs().broadcast(token, { topic: 'comments', origin: whoOf(event).client || null });
  return json({ ...result, threads: docs().threads(token, { who: whoOf(event) }) }, { headers: NO_STORE });
}

export async function commentsPOST(event) {
  const token = docToken(event.params);
  const refused = tooBig(event) || limited(event, token, 'comment', { perSecond: 0.5, burst: 20 });
  if (refused) return refused;
  const body = await event.request.json().catch(() => ({}));
  return commentAnswer(event, token, docs().comment(token, body, whoOf(event)));
}

/** { threadId, resolved: true|false } */
export async function commentsPATCH(event) {
  const token = docToken(event.params);
  const refused = limited(event, token, 'comment', { perSecond: 0.5, burst: 20 });
  if (refused) return refused;
  const body = await event.request.json().catch(() => ({}));
  return commentAnswer(event, token, docs().resolve(token, body.threadId, body.resolved !== false, whoOf(event)));
}

/** `?id=` or { id } deletes one comment; `?threadId=` or { threadId } deletes the whole thread (anchor and replies). */
export async function commentsDELETE(event) {
  const token = docToken(event.params);
  const body = await event.request.json().catch(() => ({}));
  const threadId = event.url.searchParams.get('threadId') || body.threadId;
  if (threadId) return commentAnswer(event, token, docs().deleteThread(token, threadId, whoOf(event)));
  const id = event.url.searchParams.get('id') || body.id;
  return commentAnswer(event, token, docs().deleteComment(token, id, whoOf(event)));
}

// --- presence and the live stream --------------------------------------------------------------

export async function presencePOST(event) {
  const token = docToken(event.params);
  // Cursor moves arrive as fast as a caret moves (the client throttles to one per ~40ms), so the
  // allowance is a typist's, not a heartbeat's.
  const refused = tooBig(event) || limited(event, token, 'presence', { perSecond: 40, burst: 80 });
  if (refused) return refused;
  const body = await event.request.json().catch(() => ({}));
  const who = whoOf(event);
  const client = String(body.client || who.client || '').slice(0, 64);
  if (!client) return json({ error: 'client is required' }, { status: 400 });
  const name = who.owner || who.bound ? who.name : cleanName(body.name ?? who.name);
  const cursor = 'cursor' in body ? cleanCursor(body.cursor) : undefined;
  const here = docs().here(token, client, { name, owner: who.owner, line: typeof body.line === 'string' ? body.line.slice(0, 80) : null, cursor });
  docs().broadcast(token, { topic: 'presence', here, at: Date.now() });
  return json({ here }, { headers: NO_STORE });
}

/**
 * One SSE stream per document tab, shaped for createLiveConnection (src/lib/client/live.js):
 * `{hello}` first, then `{topic, origin}` for each change. It carries signals and presence only;
 * the page reads the document itself through the notes GET, as his notes page does on a push.
 */
export function eventsGET(event) {
  const token = docToken(event.params);
  const who = whoOf(event);
  const client = (event.url.searchParams.get('client') || who.client || '').slice(0, 64);
  const name = who.owner || who.bound ? who.name : cleanName(event.url.searchParams.get('name'));
  let drop = () => {};
  let beat = null;
  let closed = false;
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (payload) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)); } catch { stop(); }
      };
      const stop = () => {
        if (closed) return;
        closed = true;
        drop();
        if (beat !== null) clearInterval(beat);
        beat = null;
        if (client) { docs().leave(token, client); docs().broadcast(token, { topic: 'presence', here: docs().here(token) }); }
        try { controller.close(); } catch { /* closed */ }
      };
      send({ hello: true });
      drop = docs().addReader(token, send);
      const here = docs().here(token, client, { name, owner: who.owner });
      docs().broadcast(token, { topic: 'presence', here });
      beat = setInterval(() => {
        if (client) docs().here(token, client, { owner: who.owner });
        try { controller.enqueue(encoder.encode(': beat\n\n')); } catch { stop(); return; }
        send({ topic: 'presence', here: docs().here(token) });
      }, HEARTBEAT_MS);
    },
    cancel() {
      closed = true;
      drop();
      if (beat !== null) clearInterval(beat);
      beat = null;
      if (client) { docs().leave(token, client); docs().broadcast(token, { topic: 'presence', here: docs().here(token) }); }
    }
  });
  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' }
  });
}

// --- the owner's list and minting --------------------------------------------------------------

function ownerOnly(event) {
  if (!app.auth.valid(event.cookies.get(SESSION_COOKIE))) error(401, 'Sign in required');
}

export function listGET(event) {
  ownerOnly(event);
  return json({ docs: docs().list() }, { headers: NO_STORE });
}

export async function createPOST(event) {
  ownerOnly(event);
  const body = await event.request.json().catch(() => ({}));
  if (body.remove) {
    const ok = docs().remove(String(body.remove));
    return json({ ok }, { status: ok ? 200 : 404, headers: NO_STORE });
  }
  const doc = docs().create({ title: body.title });
  return json({ ...doc, path: `/docs/${doc.token}`, url: `${event.url.origin}/docs/${doc.token}` }, { status: 201, headers: NO_STORE });
}
