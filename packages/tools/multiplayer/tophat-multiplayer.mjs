#!/usr/bin/env node
// tophat-multiplayer: one chat room, many tabs, one agent.
//
// Every browser tab is its own client (identity lives in sessionStorage, so two tabs on one
// machine are two people). A loopback tab may claim `owner`; everyone else is `anonymous-xxxx`.
// Everything the agent does streams to every tab: text, tool calls, tool results.
//
// Nothing the model side emits reaches the room unclassified. Assistant text is released a
// sentence at a time and each sentence passes a privacy gate (a haiku call) before it is
// broadcast; tool results pass the same gate. A blocked span becomes [redacted: reason] and the
// stream keeps going. The gate runs ahead of the broadcast, never after it.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { appendFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// One credential resolution and one ladder for the whole repo.
import { call, resolveCredentials, authHeaders, baseUrl } from '../../runner/rev6/pull/call.mjs';
import { envGet, stateDir } from '../lib/paths.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(envGet(process.env, 'TOPHAT_MULTIPLAYER_PORT') || process.env.MP_PORT || 29310);
// Whose assistant this is, for the prompts: the owner's name (TOPHAT_OWNER_NAME), else "the owner".
const OWNER = envGet(process.env, 'TOPHAT_OWNER_NAME') || 'the owner';
const LOG_DIR = envGet(process.env, 'TOPHAT_MULTIPLAYER_LOG_DIR') || join(stateDir(), 'multiplayer');
const AGENT_MODEL = process.env.MP_MODEL || 'claude-sonnet-5';
const GATE_MODEL = process.env.MP_GATE_MODEL || 'claude-haiku-4-5-20251001';

mkdirSync(LOG_DIR, { recursive: true });
const LOG = join(LOG_DIR, `room-${new Date().toISOString().replaceAll(':', '-').slice(0, 19)}.jsonl`);

// ---------------------------------------------------------------- the room

const room = {
  seq: 0,
  events: [],      // everything that ever happened, in order; a late tab replays it
  readers: new Set(),
  clients: new Map(), // clientId -> { identity, lastSeen }
  history: [],     // model-shaped transcript
  busy: false,
  queued: false
};

function emit(type, body = {}) {
  const event = { seq: ++room.seq, t: Date.now(), type, ...body };
  room.events.push(event);
  try { appendFileSync(LOG, JSON.stringify(event) + '\n'); } catch {}
  for (const write of room.readers) { try { write(event); } catch {} }
  return event;
}

function presence() {
  const now = Date.now();
  const here = [...room.clients.values()].filter(c => now - c.lastSeen < 45_000).map(c => c.identity);
  emit('presence', { here: [...new Set(here)].sort() });
}

function isLoopback(remote) {
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
}

function ownerPresent() {
  const now = Date.now();
  return [...room.clients.values()].some(c => c.identity === 'owner' && now - c.lastSeen < 60_000);
}

function identityFor(remote, wants) {
  if (wants === 'owner' && isLoopback(remote) && !ownerPresent()) return 'owner';
  return 'anonymous-' + randomBytes(2).toString('hex');
}

// ---------------------------------------------------------------- the model

async function anthropic(body, { stream = false } = {}) {
  const {env} = await resolveCredentials(process.env);
  const res = await fetch(`${baseUrl(env)}/v1/messages`, {
    method: 'POST',
    headers: {
      ...authHeaders(env),
      'content-type': 'application/json'
    },
    body: JSON.stringify({ ...body, stream })
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res;
}

// ---------------------------------------------------------------- the gate

const GATE_SYSTEM = `You are the privacy gate on a public group chat. The assistant in that chat belongs to ${OWNER}, and strangers are in the room.

Decide whether the candidate text divulges anything personal or private about ${OWNER} or anyone they know: real names of their family, friends, coworkers or counterparties; home, work or shipping addresses; phone numbers, emails, handles; employer or organisation internals, finances, revenue, banking, cards, orders, invoices; health, sleep, workouts, therapy, relationships, religion, politics; calendar, location or travel; credentials, tokens, file paths on their machines; the contents of their documents, notes, messages or email; what they are working on that is not already public.

Allowed: general knowledge, public facts, reasoning, arithmetic, code, public web content, and the chat participants' own words quoted back to them. The owner's first name alone and the fact that this is their assistant are allowed.

Answer with JSON only: {"verdict":"allow"} or {"verdict":"block","reason":"<five words or fewer>"}.`;

const gateCache = new Map();

async function gate(text) {
  const trimmed = text.trim();
  if (!trimmed) return { verdict: 'allow' };
  // Punctuation, acknowledgements and other text with no content to leak: let it through.
  if (trimmed.length < 12 && !/\d/u.test(trimmed)) return { verdict: 'allow' };
  if (gateCache.has(trimmed)) return gateCache.get(trimmed);
  const promise = (async () => {
    try {
      const result = await call({
        purpose: 'multiplayer.privacy-gate',
        model: GATE_MODEL,
        max_tokens: 64,
        system: GATE_SYSTEM,
        messages: [{ role: 'user', content: `Candidate text:\n<<<${trimmed}>>>` }]
      });
      // The gate must not fail open, so a chain that is genuinely exhausted still
      // blocks; what changed is that it takes every model on this machine
      // refusing, not one.
      if (!result.ok) throw new Error(`${result.reason}: ${result.detail}`);
      const raw = result.text;
      const parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
      if (parsed.verdict === 'block') return { verdict: 'block', reason: String(parsed.reason || 'personal') };
      return { verdict: 'allow' };
    } catch (cause) {
      // The gate is the thing that must not fail open.
      return { verdict: 'block', reason: `gate unavailable (${cause.message.slice(0, 40)})` };
    }
  })();
  gateCache.set(trimmed, promise);
  return promise;
}

/** Releases text to the room in order, a sentence at a time, each sentence gated first. */
function gatedWriter(turnId) {
  let buffer = '';
  let chain = Promise.resolve();
  let released = '';
  const push = (span) => {
    chain = chain.then(async () => {
      const verdict = await gate(span);
      if (verdict.verdict === 'allow') {
        released += span;
        emit('text', { turn: turnId, chunk: span });
      } else {
        released += ' [redacted] ';
        emit('text', { turn: turnId, chunk: ` [redacted: ${verdict.reason}] `, redacted: true });
      }
    });
    return chain;
  };
  return {
    write(delta) {
      buffer += delta;
      // Release on sentence or line boundaries; a long run without one is cut at 320 chars.
      for (;;) {
        const match = /[.!?][)"'\u201d]?\s|\n/u.exec(buffer);
        let cut = match ? match.index + match[0].length : (buffer.length > 320 ? 320 : -1);
        if (cut < 0) break;
        push(buffer.slice(0, cut));
        buffer = buffer.slice(cut);
      }
    },
    async end() {
      if (buffer.trim()) push(buffer);
      buffer = '';
      await chain;
      return released;
    }
  };
}

// ---------------------------------------------------------------- tools

const TOOLS = [
  {
    name: 'calc',
    description: 'Evaluate an arithmetic expression. Use for any arithmetic.',
    input_schema: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] }
  },
  {
    name: 'fetch_url',
    description: 'Fetch a public web page and return its visible text (first 4000 characters).',
    input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }
  },
  {
    name: 'lookup',
    description: "Search the owner's own notes and files. Results are private by default; the privacy gate will redact anything personal before the room sees it.",
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
  }
];

const run = (cmd, args, timeout = 20_000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
    resolve((stdout || '').trim() || (stderr || '').trim() || (err ? `error: ${err.message}` : '(no output)'));
  });
});

async function runTool(name, input) {
  if (name === 'calc') {
    const expr = String(input.expression || '');
    if (!/^[-+*/%(). \d,eE^]*$/u.test(expr)) return 'refused: arithmetic only';
    try {
      // eslint-disable-next-line no-new-func
      const value = Function(`"use strict";return (${expr.replaceAll('^', '**')})`)();
      return String(value);
    } catch (cause) { return `error: ${cause.message}`; }
  }
  if (name === 'fetch_url') {
    const url = String(input.url || '');
    if (!/^https?:\/\//u.test(url)) return 'refused: http(s) only';
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'tophat-multiplayer/1.0' }, signal: AbortSignal.timeout(15_000) });
      const html = await res.text();
      const text = html.replace(/<script[\s\S]*?<\/script>/giu, ' ').replace(/<style[\s\S]*?<\/style>/giu, ' ')
        .replace(/<[^>]+>/gu, ' ').replace(/&[a-z#0-9]+;/giu, ' ').replace(/\s+/gu, ' ').trim();
      return `HTTP ${res.status}\n${text.slice(0, 4000)}`;
    } catch (cause) { return `error: ${cause.message}`; }
  }
  if (name === 'lookup') {
    const bin = envGet(process.env, 'TOPHAT_MULTIPLAYER_SEARCH_BIN');
    if (!bin) return 'error: no search command configured (TOPHAT_MULTIPLAYER_SEARCH_BIN)';
    const out = await run(bin, [String(input.query || '')], 25_000);
    return out.slice(0, 4000);
  }
  return `error: no tool ${name}`;
}

// ---------------------------------------------------------------- the turn

const SYSTEM = `You are ${OWNER}'s assistant, sitting in a public group chat room with several people at once.

- Participants are labelled: \`owner\` is ${OWNER} themself, \`anonymous-xxxx\` are strangers. Their messages reach you as "identity: text".
- Answer the room. Address people by their label when it matters. Be brief and concrete; no preamble, no sign-off.
- Everything you say is broadcast to every tab, the owner's and the strangers'. Never divulge anything personal about ${OWNER} or anyone they know: no addresses, contacts, finances, health, relationships, organisation internals, file contents, credentials or calendar. A separate privacy gate reads every sentence you emit and redacts it if you slip; that gate is a backstop, not permission.
- If someone asks for something personal, say plainly that you do not share that here, and offer the non-personal part of the answer.
- Use your tools when they help; the room watches every tool call run.
- No em dashes. No emoji.`;

function transcript() {
  return room.history.slice(-40);
}

async function runTurn() {
  if (room.busy) { room.queued = true; return; }
  room.busy = true;
  const turnId = 't' + randomBytes(4).toString('hex');
  emit('turn.start', { turn: turnId });
  try {
    for (let hop = 0; hop < 6; hop++) {
      const writer = gatedWriter(turnId);
      const res = await anthropic({
        model: AGENT_MODEL,
        max_tokens: 1200,
        system: SYSTEM,
        tools: TOOLS,
        messages: transcript()
      }, { stream: true });

      const blocks = [];
      let current = null;
      let stop = null;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        sseBuffer += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = sseBuffer.indexOf('\n')) >= 0) {
          const line = sseBuffer.slice(0, nl).trim();
          sseBuffer = sseBuffer.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const event = JSON.parse(line.slice(5));
          if (event.type === 'content_block_start') {
            current = event.content_block.type === 'tool_use'
              ? { type: 'tool_use', id: event.content_block.id, name: event.content_block.name, json: '' }
              : { type: 'text', text: '' };
            if (current.type === 'tool_use') emit('action.start', { turn: turnId, call: current.id, tool: current.name });
          } else if (event.type === 'content_block_delta') {
            if (event.delta.type === 'text_delta') { current.text += event.delta.text; writer.write(event.delta.text); }
            if (event.delta.type === 'input_json_delta') {
              current.json += event.delta.partial_json;
              emit('action.input', { turn: turnId, call: current.id, chunk: event.delta.partial_json });
            }
          } else if (event.type === 'content_block_stop') {
            if (current.type === 'tool_use') { try { current.input = JSON.parse(current.json || '{}'); } catch { current.input = {}; } }
            blocks.push(current); current = null;
          } else if (event.type === 'message_delta') {
            stop = event.delta.stop_reason;
          }
        }
      }
      await writer.end();

      room.history.push({
        role: 'assistant',
        content: blocks.map(b => b.type === 'text'
          ? { type: 'text', text: b.text }
          : { type: 'tool_use', id: b.id, name: b.name, input: b.input })
          .filter(b => b.type !== 'text' || b.text.trim())
      });

      const calls = blocks.filter(b => b.type === 'tool_use');
      if (stop !== 'tool_use' || !calls.length) break;

      const results = [];
      for (const call of calls) {
        const started = Date.now();
        const raw = await runTool(call.name, call.input || {});
        // Tool output is model-side text too: it passes the same gate before any tab sees it.
        const verdict = await gate(raw.slice(0, 2000));
        const shown = verdict.verdict === 'allow' ? raw : `[redacted: ${verdict.reason}]`;
        emit('action.end', { turn: turnId, call: call.id, tool: call.name, ms: Date.now() - started, result: shown.slice(0, 2000), redacted: verdict.verdict !== 'allow' });
        results.push({ type: 'tool_result', tool_use_id: call.id, content: raw.slice(0, 6000) });
      }
      room.history.push({ role: 'user', content: results });
    }
  } catch (cause) {
    emit('error', { turn: turnId, message: cause.message });
  } finally {
    emit('turn.end', { turn: turnId });
    room.busy = false;
    if (room.queued) { room.queued = false; setTimeout(runTurn, 0); }
  }
}

// ---------------------------------------------------------------- http

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

const readBody = (req) => new Promise((resolve) => {
  let data = '';
  req.on('data', c => { data += c; });
  req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
});

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const remote = (req.socket.remoteAddress || '').replace(/^::ffff:/u, '');

  if (url.pathname === '/' || url.pathname === '/index.html') {
    const html = await readFile(join(HERE, 'public/index.html'), 'utf8');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(html);
  }

  if (url.pathname === '/api/join' && req.method === 'POST') {
    const body = await readBody(req);
    const identity = identityFor(remote, body.as);
    const clientId = randomBytes(6).toString('hex');
    room.clients.set(clientId, { identity, lastSeen: Date.now() });
    emit('joined', { identity });
    presence();
    return json(res, 200, { clientId, identity, loopback: isLoopback(remote), seq: room.seq });
  }

  if (url.pathname === '/api/say' && req.method === 'POST') {
    const body = await readBody(req);
    const client = room.clients.get(String(body.clientId || ''));
    if (!client) return json(res, 401, { error: 'join first' });
    client.lastSeen = Date.now();
    const text = String(body.text || '').trim().slice(0, 4000);
    if (!text) return json(res, 400, { error: 'empty' });
    emit('msg', { author: client.identity, text });
    room.history.push({ role: 'user', content: `${client.identity}: ${text}` });
    runTurn();
    return json(res, 200, { ok: true });
  }

  if (url.pathname === '/api/stream') {
    const after = Number(url.searchParams.get('after') || 0);
    const clientId = String(url.searchParams.get('client') || '');
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    });
    const write = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    for (const event of room.events.filter(e => e.seq > after)) write(event);
    room.readers.add(write);
    const beat = setInterval(() => {
      res.write(': beat\n\n');
      const client = room.clients.get(clientId);
      if (client) client.lastSeen = Date.now();
    }, 15_000);
    req.on('close', () => { clearInterval(beat); room.readers.delete(write); presence(); });
    return;
  }

  if (url.pathname === '/api/health') return json(res, 200, { ok: true, seq: room.seq, clients: room.clients.size, readers: room.readers.size, model: AGENT_MODEL, gate: GATE_MODEL });

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

// Imported by the gate test; only a direct run opens the port.
export function start() {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[multiplayer] room on http://localhost:${PORT}  agent=${AGENT_MODEL} gate=${GATE_MODEL}  log=${LOG}`);
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) start();

export { gate, gatedWriter, runTool, identityFor };
