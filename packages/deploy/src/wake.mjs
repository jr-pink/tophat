// Arrival wakes: when a source delivers something that needs someone on the team to act, post one turn into the chat that
// owns the subject (or a new chat) through the webchat's own loopback `POST /api/inbound`. This is the assistant side of
// the intake (@tophat-md/push only derives memory): it never answers, sends or executes, it only wakes a chat.
//
// An arrival is a raw row the intake stored (locator.pusher is the intake's id) from a source other than the chat
// transcripts, written by a person (role human or owner), no older than wake.maxAgeHours (default 48). Each arrival is
// judged once, ever: the decision is appended to `<state>/intake/wakes.jsonl` (append-only, one writer) and a record with
// a decision is never judged again; a failed post is retried on the next pass, at most MAX_ATTEMPTS times. One model call
// judges a whole batch against the instance's recent chats, under the intake's daily budget.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const MAX_ATTEMPTS = 4;
export const AUTOMATED = '[Automated event from the push plane; this is not a message from the owner.]';
const CHAT_SOURCES = ['webchat'];

export const SYSTEM = `You are the arrival desk of a team's assistant. You are given new arrivals (messages, mail, notices that reached the team) and the team's recent chats.
For each arrival decide whether someone on the team must act or decide on it: a request, a question to answer, a deadline, a payment, a problem to fix, a promise a person made. Receipts, newsletters, automated notices, FYIs and anything already handled in a chat need no wake.
For an arrival that needs action choose the chat that already owns its subject, by its id from the list, or null to open a new chat. Write a title as "Who: what" (the sender or service, then the gist, at most 80 characters) and a text for the woken agent: what arrived (quote the key words), what is asked, by whom, and the arrival's id. You never answer, send or act yourself.
Reply with ONLY JSON: {"wakes":[{"arrival":"A1","conversation":"<chat id or null>","title":"...","text":"..."}]}. An arrival you leave out needs no wake.`;

const readLines = (file) => { try { return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
export const ledgerFile = (stateDir) => path.join(stateDir, 'wakes.jsonl');

/** Raw ids that are settled (decided, or out of attempts) from the ledger. */
export function settled(stateDir) {
  const done = new Set(), failed = new Map();
  for (const l of readLines(ledgerFile(stateDir))) {
    if (l.status === 'failed') failed.set(l.id, (failed.get(l.id) || 0) + 1);
    else done.add(l.id);
  }
  for (const [id, n] of failed) if (n >= MAX_ATTEMPTS) done.add(id);
  return done;
}

/** Arrivals not yet decided, oldest first. `db` is the replica's store (`store.store.all`). */
export function arrivals(db, { pusher, stateDir, now, maxAgeHours = 48, limit = 10 }) {
  const done = settled(stateDir);
  const since = new Date(Date.parse(now) - maxAgeHours * 3600e3).toISOString();
  const rows = db.all(`SELECT id, source, native_id, author, role, thread, occurred_at, text FROM raw_data
    WHERE json_extract(locator,'$.pusher')=? AND source NOT IN (${CHAT_SOURCES.map(() => '?').join(',')}) AND role IN ('human','owner') AND occurred_at >= ? ORDER BY occurred_at, rowid`, [pusher, ...CHAT_SOURCES, since]);
  return rows.filter((r) => !done.has(r.id)).slice(0, limit);
}

/** The team's recent chats as the judge sees them: id, title, last activity, from the webchat store (read only). */
export async function recentChats(webchatDb, { limit = 25 } = {}) {
  if (!existsSync(webchatDb)) return [];
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(webchatDb, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 3000');
    return db.prepare('SELECT id, title, updated_at FROM conversations WHERE archived = 0 AND sidechat IS NULL AND aside = 0 ORDER BY updated_at DESC LIMIT ?').all(limit);
  } finally { db.close(); }
}

export function packet(rows, chats, { maxChars = 1500 } = {}) {
  const arr = rows.map((r, i) => `A${i + 1} | ${r.occurred_at} | source ${r.source} | from ${r.author || 'unknown'}${r.thread ? ` | thread ${r.thread}` : ''} | id ${r.id}\n${String(r.text).slice(0, maxChars)}`).join('\n\n');
  const list = chats.map((c) => `${c.id} | ${c.title} | last activity ${c.updated_at}`).join('\n') || '(no chats yet)';
  return `ARRIVALS\n${arr}\n\nRECENT CHATS\n${list}\n`;
}

/** The judge's answer as wakes: [{ row, conversation, title, text }]. A bad entry or an unknown chat id is dropped alone (the chat becomes new). */
export function parseWakes(text, rows, chats) {
  let j; try { j = JSON.parse(String(text).trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { throw Object.assign(new Error('the wake judge answered with something that is not JSON'), { code: 'wake-bad-json' }); }
  const known = new Set(chats.map((c) => c.id)), out = [], seen = new Set();
  for (const w of Array.isArray(j?.wakes) ? j.wakes : []) {
    const row = rows[Number(String(w?.arrival || '').replace(/^A/i, '')) - 1];
    if (!row || seen.has(row.id) || typeof w.text !== 'string' || !w.text.trim()) continue;
    seen.add(row.id);
    out.push({ row, conversation: typeof w.conversation === 'string' && known.has(w.conversation) ? w.conversation : null,
      title: String(w.title || '').replace(/\s+/g, ' ').trim().slice(0, 90), text: w.text.trim().slice(0, 4000) });
  }
  return out;
}

/** POST one wake into the webchat. Idempotent on the webchat side by messageId (the raw id). */
export async function post(wake, { webchatUrl, token, fetchImpl = fetch }) {
  const r = await fetchImpl(`${webchatUrl.replace(/\/+$/, '')}/api/inbound`, { method: 'POST', signal: AbortSignal.timeout(30_000),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ text: `${AUTOMATED}\n${wake.text}`, source: 'push', messageId: wake.row.id.replace(/[^\w:./-]/g, '_'), title: wake.title || undefined, ...(wake.conversation ? { conversationId: wake.conversation } : {}) }) });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`inbound ${r.status}: ${String(body.error || '').slice(0, 120)}`);
  return body;
}

/**
 * One wake pass. ctx: { store (the replica backend), pusher, stateDir (intake state dir), webchatDb, webchatUrl, token, provider, model (price), budget,
 * push (the push package directory), now (ISO), maxAgeHours?, batch? }. Returns { judged, woken, none, failed, errors } or null when there is nothing to judge.
 */
export async function runWake(ctx, deps = {}) {
  const now = ctx.now ?? new Date().toISOString();
  const rows = arrivals(ctx.store.store, { pusher: ctx.pusher, stateDir: ctx.stateDir, now, maxAgeHours: ctx.maxAgeHours, limit: ctx.batch ?? 10 });
  if (!rows.length) return null;
  const report = { judged: rows.length, woken: 0, none: 0, failed: 0, errors: [] };
  const log = (entry) => { mkdirSync(ctx.stateDir, { recursive: true, mode: 0o700 }); appendFileSync(ledgerFile(ctx.stateDir), JSON.stringify({ at: now, ...entry }) + '\n', { mode: 0o600 }); };
  const chats = await recentChats(ctx.webchatDb);
  const user = packet(rows, chats), maxTokens = Math.min(ctx.model?.maxTokens ?? 4000, 4000);
  const budget = await import(pathToFileURL(path.join(ctx.push, 'budget.mjs')).href);
  let wakes;
  try {
    budget.check({ stateDir: ctx.stateDir, budget: ctx.budget, price: ctx.model?.price, now, inTok: Math.ceil((SYSTEM.length + user.length) / 4), maxOut: maxTokens });
    const reply = await ctx.provider.complete({ system: SYSTEM, user, maxTokens });
    budget.record({ stateDir: ctx.stateDir, now, provider: ctx.model?.provider, model: reply.model, usage: reply.usage, price: ctx.model?.price });
    wakes = parseWakes(reply.text, rows, chats);
  } catch (e) {
    // A judge that cannot answer (budget, provider, bad JSON) counts an attempt per arrival, so a broken judge stops after MAX_ATTEMPTS passes.
    for (const r of rows) log({ id: r.id, source: r.source, status: 'failed', error: `judge: ${e.code || String(e.message).slice(0, 80)}` });
    report.errors.push(`judge: ${e.code || e.message}`); report.failed = rows.length; return report;
  }
  const woke = new Set(wakes.map((w) => w.row.id));
  for (const r of rows) if (!woke.has(r.id)) { log({ id: r.id, source: r.source, status: 'none' }); report.none++; }
  for (const w of wakes) {
    try {
      const got = await post(w, { webchatUrl: ctx.webchatUrl, token: ctx.token, fetchImpl: deps.fetch });
      log({ id: w.row.id, source: w.row.source, status: 'posted', conversation: got.conversationId ?? got.id ?? w.conversation, title: w.title });
      report.woken++;
    } catch (e) { log({ id: w.row.id, source: w.row.source, status: 'failed', error: String(e.message).slice(0, 160) }); report.failed++; report.errors.push(`post: ${String(e.message).slice(0, 80)}`); }
  }
  return report;
}
