// Multiplayer mode: one real conversation per room, many clients, one gated view per room.
//
// The room is an ordinary webchat conversation in the ordinary store, run by the ordinary runner,
// so it gets everything a chat of the owner's gets: instant send, streamed deltas, tool cards, the
// context hook, interrupts. What multiplayer adds is two things and nothing else.
//
//   1. Identity per tab. A tab holding a valid webchat session is `owner`; every other tab is
//      `anonymous-xxxx`, assigned on join and kept in that tab's sessionStorage, so three tabs on
//      one machine are three people. Every message carries its author's label into the transcript,
//      which is also how the agent knows who is talking.
//   2. A gated projection of the room's events. Store events are consumed in order and re-emitted
//      into a parallel feed that room clients read; assistant text is held back a sentence at a
//      time until the classifier in mp-gate.js has judged it, tool inputs and outputs are judged
//      whole, and thinking never leaves the machine at all. The owner's own webchat shows the same
//      conversation ungated, because that view is behind his passkey.
//
// The projection is append-only and keeps the original store cursors, so a room client pages with
// `after` exactly as the main client does, and a tab that joins late replays the room from zero.

import { createHash, randomBytes } from 'node:crypto';
import { owner, ownerPossessive } from '../../../../runner/owner.mjs';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join as joinPath } from 'node:path';
import { ACTIONS, makeAction, newId } from '../core/contract.js';
import { app, applyAction, DEFAULT_CWD } from './app.js';
import { webchatStorePath } from './paths.js';
import { gate, gatedText, redaction, GATE_MODEL, GATE_SYSTEM } from './mp-gate.js';

const ROOM_FILE = process.env.WEBCHAT_MP_FILE || webchatStorePath('multiplayer.json');
const CLIENT_IDLE_MS = 60_000;
// A dictated message can be long. The bound is the seed's, a size no one types by accident.
const MAX_TEXT = 60_000;

export const ROOM_TITLE = 'Multiplayer room';

// What the agent is told the room is, sent as the room's first message so it is in context from
// the first token. The gate is a backstop; this is the instruction.
export const BRIEFING = [
  'You are in multiplayer mode: this conversation is a public group chat, open to anyone with the link, and everything you say is broadcast to every tab in it.',
  '',
  `Participants are labelled. \`owner\` is ${owner()}. \`anonymous-xxxx\` are strangers. Every message reaches you as "label: text", and a label is the only thing you know about who is speaking.`,
  '',
  'Rules for this room:',
  `- Divulge nothing personal about ${owner()} or anyone he knows: addresses, contacts, finances, organisation internals, legal matters, health, relationships, calendar, credentials, file paths, or the contents of his files, mail and messages. Say plainly that you do not share that here, then answer the part you can.`,
  '- Do not read his private files, mail, messages or notes to answer a stranger. Public knowledge, reasoning, code and the web are fine.',
  '- Never run anything that writes, sends, buys, deletes or changes state on his hosts or accounts, whoever asks.',
  '- Answer the room, briefly. Address people by their label when it matters.',
  '',
  'A privacy classifier reads every sentence you emit and redacts it before anyone sees it. That is a backstop, not permission.'
].join('\n');

// ---------------------------------------------------------------- room state
//
// Many rooms, one per random token, plus the legacy room at plain /mp. Each room is its own
// ordinary conversation with its own gated feed, readers and clients; one store subscription
// dispatches events to the room whose conversation they belong to, so a room's clients never see
// another room's events. A token is 128 random bits and only the owner can mint one (createRoom,
// behind POST /api/mp/rooms); an unknown token is a 404, never a new room, so a URL cannot be
// guessed into existence.

export const LEGACY = 'legacy';
const ROOMS_FILE = process.env.WEBCHAT_MP_ROOMS_FILE || webchatStorePath('multiplayer-rooms.json');
const MAX_SEED = 60_000;
// Invalidate old decisions when either the policy or projection changes. Only the gated feed
// is served; unfinished private text stays in this owner-only checkpoint until classified.
// 2: a forced text flush carries its own event id (see releaseText).
const PROJECTION_VERSION = createHash('sha256').update(`2:${GATE_MODEL}:${GATE_SYSTEM}`).digest('hex');
const projectionPath = (room) => joinPath(dirname(ROOMS_FILE), 'mp-projections', `${room.id}.json`);

function saveProjection(room) {
  clearTimeout(room.saveTimer);
  room.saveTimer = null;
  if (room.projecting || room.projectionFailed) return;
  const file = projectionPath(room);
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: PROJECTION_VERSION, id: room.id,
      cursor: room.projectedCursor, feed: room.feed, text: [...room.text] }), { mode: 0o600 });
    renameSync(tmp, file);
  } catch (cause) { console.warn('[mp] could not checkpoint projection:', cause.message); }
}

function restoreProjection(room) {
  try {
    const saved = JSON.parse(readFileSync(projectionPath(room), 'utf8'));
    if (saved.version !== PROJECTION_VERSION || saved.id !== room.id ||
        !Number.isSafeInteger(saved.cursor) || !Array.isArray(saved.feed) || !Array.isArray(saved.text) ||
        saved.feed.some(event => event.conversation_id !== room.id)) return;
    const text = new Map(saved.text);
    room.feed = saved.feed;
    room.text = text;
    room.projectedCursor = saved.cursor;
  } catch { /* Missing or corrupt checkpoints rebuild through the privacy gate. */ }
}

function enqueue(room, event) {
  room.queue = room.queue.then(async () => {
    room.projecting = true;
    try { await project(room, event); } finally { room.projecting = false; }
    room.projectedCursor = event.cursor;
    // Coalesce token bursts; never checkpoint half of an in-flight classification.
    if (!room.saveTimer) room.saveTimer = setTimeout(() => saveProjection(room), 100);
  }).catch((cause) => {
    room.projectionFailed = true; // Never persist a cursor beyond a failed source event.
    console.error('[mp] projection failed:', cause.message);
  });
}

/** The briefing for a token room: private by link, and what the owner posts is room content. */
export const ROOM_BRIEFING = [
  `You are in multiplayer mode: this conversation is a private group chat, open only to people ${owner()} has given its unguessable link, and everything you say is broadcast to every tab in it.`,
  '',
  `Participants are labelled. \`owner\` is ${owner()}. \`anonymous-xxxx\` are people he shared the link with. Every message reaches you as "label: text", and a label is the only thing you know about who is speaking.`,
  '',
  'Rules for this room:',
  '- Content posted into this room, by the owner or anyone else, is room content: you may read, discuss, summarise and work on it here.',
  `- Beyond that, divulge nothing personal about ${owner()} or anyone he knows: addresses, contacts, finances, organisation internals, legal matters, health, relationships, calendar, credentials, file paths, or the contents of his files, mail and messages. Say plainly that you do not share that here, then answer the part you can.`,
  '- Do not read his private files, mail, messages or notes to answer anyone in the room. Public knowledge, reasoning, code and the web are fine.',
  '- Never run anything that writes, sends, buys, deletes or changes state on his hosts or accounts, whoever asks.',
  '- Answer the room, briefly. Address people by their label when it matters.',
  '',
  'A privacy classifier reads every sentence you emit and redacts it before anyone sees it. That is a backstop, not permission.'
].join('\n');

const rooms = new Map();          // key (LEGACY or token) -> room
const byConversation = new Map(); // conversationId -> room
let subscribedTo = null;

function makeRoom(key, { title = ROOM_TITLE, conversationId = null } = {}) {
  return {
    key,
    title,
    id: conversationId,
    projectedCursor: 0,
    saveTimer: null,
    feed: [],              // gated events, store cursors preserved, strictly increasing
    readers: new Set(),
    clients: new Map(),    // clientId -> { identity, lastSeen, lastSaid, seq }
    queue: Promise.resolve(),
    text: new Map(),       // itemId -> { held, released, cursor }
    anonCount: 0,
    seq: 0
  };
}

export function roomState(key = LEGACY) { return rooms.get(key) || null; }

function readRooms() {
  try { return JSON.parse(readFileSync(ROOMS_FILE, 'utf8')) || {}; }
  catch { return {}; }
}

function writeRooms(all) {
  mkdirSync(dirname(ROOMS_FILE), { recursive: true });
  const tmp = `${ROOMS_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
  renameSync(tmp, ROOMS_FILE);
}

/** A token is ours only if the owner minted it; this never creates anything. */
export function hasRoom(key) {
  if (key === LEGACY) return true;
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{22,64}$/u.test(key)) return false;
  return rooms.has(key) || Object.hasOwn(readRooms(), key);
}

export function roomInfo(key) {
  if (key === LEGACY) return { title: ROOM_TITLE };
  if (!hasRoom(key)) return null;
  const record = readRooms()[key];
  return record ? { title: record.title, createdAt: record.createdAt } : { title: rooms.get(key)?.title };
}

function remember(id) {
  try {
    mkdirSync(dirname(ROOM_FILE), { recursive: true });
    writeFileSync(ROOM_FILE, JSON.stringify({ conversationId: id, at: new Date().toISOString() }, null, 2));
  } catch (cause) { console.warn('[mp] could not write the room file:', cause.message); }
}

function recall() {
  try { return JSON.parse(readFileSync(ROOM_FILE, 'utf8')).conversationId || null; }
  catch { return null; }
}

function attach(room, id, { store, backfilling }) {
  if (room.id && byConversation.get(room.id) === room) byConversation.delete(room.id);
  room.id = id;
  byConversation.set(id, room);
  if (backfilling) backfill(room, { store });
  subscribe({ store });
}

/**
 * A room's conversation, attached on first use after boot and reused for ever after. Returns the
 * conversation id, or null for a token the owner never minted (the routes turn that into a 404).
 */
export function ensureRoom({ store = app.store, room: key = LEGACY } = {}) {
  let room = rooms.get(key);
  if (room?.id && store.conversation(room.id)) { subscribe({ store }); return room.id; }
  if (key === LEGACY) {
    if (!room) rooms.set(key, room = makeRoom(key));
    const remembered = recall();
    if (remembered && store.conversation(remembered)) { attach(room, remembered, { store, backfilling: true }); return room.id; }
    // Created before it is attached, so the creation event is projected by the subscription.
    const id = newId();
    attach(room, id, { store, backfilling: false });
    applyAction(makeAction({
      op: ACTIONS.CREATE,
      conversationId: id,
      payload: { title: ROOM_TITLE, cwd: DEFAULT_CWD, text: BRIEFING },
      deviceId: 'multiplayer',
      deviceSeq: 1
    }));
    remember(id);
    return id;
  }
  if (!hasRoom(key)) return null;
  const record = readRooms()[key];
  if (!record) return null;
  if (!room) rooms.set(key, room = makeRoom(key, { title: record.title }));
  if (record.conversationId && store.conversation(record.conversationId)) {
    attach(room, record.conversationId, { store, backfilling: true });
    return room.id;
  }
  // The record outlived its conversation: start the room again under the same token.
  const all = readRooms();
  const fresh = newId();
  attach(room, fresh, { store, backfilling: false });
  applyAction(makeAction({
    op: ACTIONS.CREATE,
    conversationId: fresh,
    payload: { title: room.title, cwd: DEFAULT_CWD, text: ROOM_BRIEFING },
    deviceId: `mp-room-${key.slice(0, 8)}`,
    deviceSeq: ++room.seq
  }));
  writeRooms({ ...all, [key]: { ...record, conversationId: fresh } });
  return fresh;
}

/**
 * Mint a room. Owner-only: the caller (POST /api/mp/rooms) has already checked the session. The
 * seed, if any, goes in as the first owner-labelled message, so it is in context for the agent and
 * in the feed for everyone who opens the link.
 */
export function createRoom({ title = '', seed = '', store = app.store } = {}) {
  const token = randomBytes(16).toString('base64url');
  const label = String(title || '').trim().slice(0, 120) || `Room ${token.slice(0, 6)}`;
  const room = makeRoom(token, { title: `Room: ${label}` });
  rooms.set(token, room);
  const id = newId();
  attach(room, id, { store, backfilling: false });
  applyAction(makeAction({
    op: ACTIONS.CREATE,
    conversationId: id,
    payload: { title: room.title, cwd: DEFAULT_CWD, text: ROOM_BRIEFING },
    deviceId: `mp-room-${token.slice(0, 8)}`,
    deviceSeq: ++room.seq
  }));
  writeRooms({ ...readRooms(), [token]: { conversationId: id, title: room.title, createdAt: new Date().toISOString() } });
  const text = String(seed || '').trim().slice(0, MAX_SEED);
  if (text) {
    applyAction(makeAction({
      op: ACTIONS.SEND,
      conversationId: id,
      payload: { text: `owner: ${text}` },
      deviceId: `mp-room-${token.slice(0, 8)}`,
      deviceSeq: ++room.seq
    }));
  }
  return { token, url: `/mp/${token}`, conversationId: id, title: room.title };
}

function subscribe({ store = app.store } = {}) {
  if (subscribedTo === store) return;
  subscribedTo = store;
  store.subscribe((event) => {
    const room = byConversation.get(event.conversation_id);
    if (!room) return;
    enqueue(room, event);
  });
}

/** Everything already in the room when the server boots, pushed through the same gate. */
function backfill(room, { store = app.store } = {}) {
  restoreProjection(room);
  let after = room.projectedCursor;
  for (;;) {
    const events = store.conversationEvents(room.id, { after, limit: 20_000 });
    // The projection itself stays strictly in order, but the classifier calls behind it do not have
    // to: they are judged concurrently first (bounded), and the in-order pass then finds every
    // verdict in the gate's cache. Serially, a long history was a queue of 12s-timeout calls that
    // held every room read behind it.
    if (events.length > 1) room.queue = room.queue.then(() => warmGate(room, events)).catch(() => {});
    for (const event of events) enqueue(room, event);
    if (events.length < 20_000) break;
    after = events.at(-1).cursor;
  }
}

const WARM_CONCURRENCY = Number(process.env.WEBCHAT_MP_WARM_CONCURRENCY || 8);

/** The texts project() would hand the classifier for these events, in order (a dry run of it). */
export function gateInputs(room, events) {
  const inputs = [];
  const held = new Map([...room.text].map(([id, value]) => [id, value.held]));
  for (const event of events) {
    const content = event.content || {};
    if (event.kind === 'assistant.delta') {
      const { spans, rest } = readySpans((held.get(content.itemId) || '') + (content.text || ''));
      held.set(content.itemId, rest);
      inputs.push(...spans);
    } else if (event.kind === 'assistant.message') {
      if (held.has(content.itemId)) {
        inputs.push(...readySpans(held.get(content.itemId), { force: true }).spans);
        held.delete(content.itemId);
      } else inputs.push(String(content.text || ''));
    } else if (event.kind === 'tool.started') {
      if (content.input !== null && content.input !== undefined) inputs.push(JSON.stringify(content.input).slice(0, 2_000));
    } else if (event.kind === 'tool.completed') {
      if (content.input !== null && content.input !== undefined) inputs.push(JSON.stringify(content.input).slice(0, 2_000));
      inputs.push(String(content.output ?? '').slice(0, 4_000));
    }
  }
  return inputs;
}

async function warmGate(room, events) {
  const pending = [...new Set(gateInputs(room, events))];
  const worker = async () => { while (pending.length) await gate(pending.shift()); };
  await Promise.all(Array.from({ length: Math.min(WARM_CONCURRENCY, pending.length) }, worker));
}

// ---------------------------------------------------------------- the feed

function publish(room, event, content) {
  const shaped = { ...event, content };
  room.feed.push(shaped);
  for (const write of room.readers) { try { write(shaped); } catch {} }
  return shaped;
}

/**
 * Split off every span that is ready to be judged: complete sentences and lines, plus a hard cut
 * so that a long stretch with no punctuation still streams rather than waiting for the turn to end.
 */
export function readySpans(buffer, { force = false, limit = 320 } = {}) {
  const spans = [];
  let rest = buffer;
  for (;;) {
    const match = /[.!?][)"'\u201d]?[\s]|\n/u.exec(rest);
    const cut = match ? match.index + match[0].length : (rest.length > limit ? limit : -1);
    if (cut < 0) break;
    spans.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (force && rest) { spans.push(rest); rest = ''; }
  return { spans, rest };
}

async function releaseText(room, event, itemId, { force = false } = {}) {
  const held = room.text.get(itemId);
  if (!held) return;
  const { spans, rest } = readySpans(held.held, { force });
  held.held = rest;
  if (!spans.length) return;
  let out = '';
  let redacted = false;
  for (const span of spans) {
    const verdict = await gate(span);
    if (verdict.verdict === 'allow') { out += span; continue; }
    out += ` ${redaction(verdict.reason)} `;
    redacted = true;
  }
  held.released += out;
  // Always a delta, whatever event forced the flush: the settle event publishes the whole message
  // itself, and a half-message published under that kind is a half-message the room believes is
  // final. One publish per source event also keeps one cursor per chunk, which is how the
  // reducer places streamed text.
  // A flush forced by the settling message is published under that message's event, so it needs
  // an id of its own: the reducer folds each event id once, and sharing it dropped the settled
  // message itself (the row stayed `streaming` in every room tab).
  const eventId = event.kind === 'assistant.delta' ? event.event_id : `${event.event_id}:flush`;
  publish(room, { ...event, event_id: eventId, kind: 'assistant.delta', cursor: held.cursor ?? event.cursor }, {
    itemId, text: out, agentId: event.content?.agentId ?? null, redacted
  });
  held.cursor = null;
}

// Kinds whose content carries no text of his: safe to pass through unchanged, and needed for the
// transcript to show a run as live rather than inert.
const PASSTHROUGH = new Set(['run.status', 'run.completed', 'run.error', 'run.cancelled']);

/**
 * A tool's input, judged whole. It stays an object so the tool card renders as it always does; a
 * blocked input collapses to one redacted field rather than disappearing, because the room should
 * still see that the call happened and what it was called.
 */
async function gatedInput(input) {
  if (input === null || input === undefined) return input;
  const verdict = await gate(JSON.stringify(input).slice(0, 2_000));
  return verdict.verdict === 'allow' ? input : { redacted: verdict.reason };
}

async function project(room, event) {
  const content = event.content || {};
  switch (event.kind) {
    case 'conversation.created':
      // A room client only ever sees its own conversation, under the room's name.
      publish(room, event, { ...content, title: room.title });
      return;
    case 'message.user': {
      // A participant's own words, already labelled by say(). The briefing is not a message anyone
      // in the room sent, so it is not shown as one.
      if ((content.text || '').startsWith('You are in multiplayer mode')) return;
      publish(room, event, content);
      return;
    }
    case 'assistant.delta': {
      const itemId = content.itemId;
      if (!room.text.has(itemId)) room.text.set(itemId, { held: '', released: '', cursor: event.cursor });
      const held = room.text.get(itemId);
      if (held.cursor === null) held.cursor = event.cursor;
      held.held += content.text || '';
      await releaseText(room, event, itemId);
      return;
    }
    case 'assistant.message': {
      const itemId = content.itemId;
      if (room.text.has(itemId)) {
        await releaseText(room, event, itemId, { force: true });
        const released = room.text.get(itemId).released;
        room.text.delete(itemId);
        publish(room, event, { ...content, text: released });
        return;
      }
      // A message that settled without deltas reaching us: judge the whole thing.
      publish(room, event, { ...content, text: await gatedText(content.text || '') });
      return;
    }
    case 'tool.started':
      publish(room, event, { ...content, input: await gatedInput(content.input) });
      return;
    case 'tool.completed': {
      // The completion carries the input again and the reducer applies it over the started row, so
      // it is judged here too rather than inheriting the earlier verdict by luck.
      publish(room, event, {
        ...content,
        input: await gatedInput(content.input),
        output: await gatedText(String(content.output ?? '').slice(0, 4_000)),
        isError: Boolean(content.isError)
      });
      return;
    }
    default:
      if (PASSTHROUGH.has(event.kind)) publish(room, event, content);
      // thinking.delta, tool.input_delta, hook.fired, pace.check, context.compacted,
      // evaluation.snapshot, agent.*: dropped. None of them has a gated form worth the risk.
  }
}

// ---------------------------------------------------------------- clients
//
// Every function takes the room key last and defaults to the legacy room, so plain /mp is
// unchanged. A key the owner never minted finds no room and answers like an unknown client.

function find(key) {
  if (!rooms.has(key)) ensureRoom({ room: key });
  return rooms.get(key) || null;
}

export function join({ owner = false, room: key = LEGACY } = {}) {
  const room = find(key);
  if (!room) return null;
  const clientId = randomBytes(8).toString('hex');
  const identity = owner && !ownerPresent(key) ? 'owner' : `anonymous-${randomBytes(2).toString('hex')}`;
  const participantId = createHash('sha256').update(`mp-participant:${key}:${clientId}`).digest('hex');
  room.clients.set(clientId, { identity, participantId, lastSeen: Date.now(), lastSaid: 0, seq: 0 });
  return { clientId, identity, participantId };
}

const ANON_LABEL = /^anonymous-[0-9a-f]{4}$/u;

/** The client for a send, whoever it claims to be. The only things that can refuse a send are an
 * unknown room token and an empty body. Identity is what the tab last joined under: an anonymous
 * label is claimed by shape (it grants nothing a fresh join would not), `owner` only when the
 * caller has checked the owner's session cookie. The participant id is derived from the client id,
 * so it is stable across restarts for a tab that keeps its id.
 */
export function adopt(rawClientId, { label = '', owner = false } = {}, key = LEGACY) {
  const room = find(key);
  if (!room) return null;
  const clientId = String(rawClientId || '').slice(0, 64) || randomBytes(8).toString('hex');
  const known = room.clients.get(clientId);
  if (known) return { clientId, client: known };
  const identity = label === 'owner' && owner ? 'owner'
    : ANON_LABEL.test(String(label)) ? label : `anonymous-${randomBytes(2).toString('hex')}`;
  const participantId = createHash('sha256').update(`mp-participant:${key}:${clientId}`).digest('hex');
  const client = { identity, participantId, lastSeen: Date.now(), lastSaid: 0, seq: 0 };
  room.clients.set(clientId, client);
  return { clientId, client };
}

export function ownerPresent(key = LEGACY) {
  const room = rooms.get(key);
  if (!room) return false;
  const now = Date.now();
  return [...room.clients.values()].some(c => c.identity === 'owner' && now - c.lastSeen < CLIENT_IDLE_MS);
}

export function touch(clientId, key = LEGACY) {
  const client = rooms.get(key)?.clients.get(clientId);
  if (client) client.lastSeen = Date.now();
  return client || null;
}

export function here(key = LEGACY) {
  const room = rooms.get(key);
  if (!room) return [];
  const now = Date.now();
  return [...new Set([...room.clients.values()]
    .filter(c => now - c.lastSeen < CLIENT_IDLE_MS)
    .map(c => c.identity))].sort();
}

/**
 * A participant says something. Their label goes into the transcript with their words. The send
 * is stored (applyAction, synchronous) before the privacy gate sees any of it: the gate governs
 * what is projected out to other tabs, never what is kept. No rate limit, no unknown-client
 * refusal; only an empty body is refused.
 */
export function say(clientId, raw, key = LEGACY, { actionId = null, label = '', owner = false } = {}) {
  const text = String(raw ?? '').trim().slice(0, MAX_TEXT);
  if (!text) return { error: 'nothing to send', status: 400 };
  const taken = adopt(clientId, { label, owner }, key);
  if (!taken) return { error: 'No such room', status: 404 };
  const { client } = taken;
  client.lastSaid = client.lastSeen = Date.now();
  const id = ensureRoom({ room: key });
  applyAction(makeAction({
    op: ACTIONS.SEND,
    conversationId: id,
    payload: { text: `${client.identity}: ${text}` },
    deviceId: `mp-${taken.clientId}`,
    deviceSeq: ++client.seq,
    // The room client's own action id, when it sent one, so the message it already shows
    // (core/reducer.js queueUserItem) is the row the server's event settles.
    ...(actionId ? { actionId } : {})
  }), { participantId: client.participantId });
  return { ok: true, identity: client.identity, clientId: taken.clientId };
}

export function interrupt(clientId, key = LEGACY, { label = '', owner = false } = {}) {
  const taken = adopt(clientId, { label, owner }, key);
  if (!taken) return { error: 'No such room', status: 404 };
  const { client } = taken;
  applyAction(makeAction({
    op: ACTIONS.INTERRUPT,
    conversationId: ensureRoom({ room: key }),
    payload: {},
    deviceId: `mp-${taken.clientId}`,
    deviceSeq: ++client.seq
  }));
  return { ok: true };
}

/** The gated feed from a cursor, for hydration and for reconnects. */
export function feedAfter(after = 0, key = LEGACY) {
  const room = rooms.get(key);
  return room ? room.feed.filter(event => event.cursor > after) : [];
}

/** Resolves once every event handed to the room so far has been projected (tests, the seeding tool). */
const SETTLE_MAX_MS = 3_000;
export async function settled(key = LEGACY) {
  const room = rooms.get(key);
  if (!room) return;
  // Bounded: a slow classifier backlog must delay a room's first paint by seconds at most, never
  // freeze it.
  let timer;
  await Promise.race([room.queue, new Promise((resolve) => { timer = setTimeout(resolve, SETTLE_MAX_MS); })]);
  clearTimeout(timer);
  saveProjection(room);
}

export function addReader(write, key = LEGACY) {
  const room = rooms.get(key);
  if (!room) return () => {};
  room.readers.add(write);
  return () => room.readers.delete(write);
}

/** Only for tests: forget every room without touching the store. */
export function resetRoom() {
  for (const room of rooms.values()) clearTimeout(room.saveTimer);
  rooms.clear();
  byConversation.clear();
  subscribedTo = null;
}
