// Visitor turns on the public demo. A visitor proves they are a person once (Turnstile, checked server-side), gets a
// signed session, and may take `turnsPerSession` turns; each turn is one model call loop whose ONLY tools read the
// instance's memory (search, one entity with its notes) and point the graph pane at an entity. No tool here touches a
// file, a shell, the network beyond the model API, or any store but the demo replica, so a prompt that tries to reach
// one finds nothing to call. A visitor's chats (new ones, and forks of the seeded ones) live in this server's own
// store keyed by session and are only ever returned to that session.
//
// Spend: every call's usage is priced and added to a per-day ledger; past `dailyUsd` the demo is "resting" until the
// next day (UTC). Each call is capped at `maxTokens` output tokens and a turn at `maxSteps` calls.
import { createHmac, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '@tophat-md/runner/store/memory.mjs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, ip TEXT NOT NULL, created_at TEXT NOT NULL, turns INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, session TEXT NOT NULL, slot TEXT, title TEXT NOT NULL, messages TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS chats_by_session ON chats(session, updated_at);
CREATE TABLE IF NOT EXISTS spend (day TEXT PRIMARY KEY, usd REAL NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS ip_turns (day TEXT NOT NULL, ip TEXT NOT NULL, turns INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, ip));
`;

const TOOLS = [
  { name: 'memory_search', description: "Full-text search over the tophat-dev group's memory (notes about the tophat project: its packages, docs and commits). Returns matching notes and entities.", input_schema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 12 } }, required: ['query'] } },
  { name: 'memory_entity', description: 'One entity of the tophat-dev memory (by id from a search) with its newest notes.', input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'show_in_graph', description: "Point the visitor's memory graph pane at an entity (by id), so they see it and its neighbours.", input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
];

export class Visitors {
  constructor(c) {
    this.c = c;
    const v = c.visitors || {};
    this.cap = v.turnsPerSession ?? 5;
    this.ipCap = v.turnsPerIpPerDay ?? 20;
    this.dailyUsd = v.dailyUsd ?? 3;
    this.model = v.model || 'claude-haiku-5-5';
    this.maxTokens = v.maxTokens ?? 1200;
    this.maxSteps = v.maxSteps ?? 4;
    this.price = v.price || { input: 0.1, output: 0.5 }; // USD per million tokens
    this.secret = readFileSync(c.sessionSecretFile, 'utf8').trim();
    mkdirSync(path.dirname(c.visitorDb), { recursive: true });
    this.db = new DatabaseSync(c.visitorDb);
    this.db.exec('PRAGMA journal_mode=WAL;' + SCHEMA);
    this.memory = openStore(c.db, { TOPHAT_SCOPE: c.scope });
    this.instructions = readFileSync(c.visitorInstructions, 'utf8');
    this.key = readFileSync(c.modelKeyFile, 'utf8').trim();
    this.workspace = c.modelWorkspaceFile ? readFileSync(c.modelWorkspaceFile, 'utf8').trim() : null;
  }
  day() { return new Date().toISOString().slice(0, 10); }
  ipKey(ip) { return createHash('sha256').update(this.secret + '\0' + ip).digest('hex').slice(0, 16); }
  sign(id) { return `${id}.${createHmac('sha256', this.secret).update(id).digest('base64url')}`; }
  verify(token) {
    const [id, sig] = String(token || '').split('.');
    if (!id || !sig) return null;
    const want = createHmac('sha256', this.secret).update(id).digest('base64url');
    if (want.length !== sig.length || !timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return null;
    return this.db.prepare('SELECT * FROM sessions WHERE id=?').get(id) || null;
  }
  newSession(ip) {
    const id = randomBytes(16).toString('base64url');
    this.db.prepare('INSERT INTO sessions (id, ip, created_at) VALUES (?,?,?)').run(id, this.ipKey(ip), new Date().toISOString());
    return { id, token: this.sign(id) };
  }
  spentToday() { return this.db.prepare('SELECT usd FROM spend WHERE day=?').get(this.day())?.usd ?? 0; }
  resting() { return this.spentToday() >= this.dailyUsd; }
  state(session) {
    return { turns: session ? session.turns : 0, cap: this.cap, resting: this.resting(), verified: Boolean(session),
      chats: session ? this.db.prepare('SELECT id, slot, title, messages, updated_at FROM chats WHERE session=? ORDER BY updated_at DESC').all(session.id).map((r) => ({ ...r, messages: JSON.parse(r.messages) })) : [] };
  }

  // ---- tools: read-only, the demo replica only ----
  async tool(name, input) {
    if (name === 'memory_search') {
      const q = String(input.query || '').slice(0, 200), n = Math.min(12, Number(input.limit) || 8);
      const ents = (await this.memory.search(q, { limit: 4, kind: 'entity' })).hits || [];
      const notes = (await this.memory.search(q, { limit: n, kind: 'note' })).hits || [];
      return JSON.stringify({ entities: ents.map((e) => ({ id: e.id, name: e.name, type: e.type })), notes: notes.map((r) => ({ id: r.id, at: r.at, text: String(r.body || '').slice(0, 600) })) });
    }
    if (name === 'memory_entity') {
      const r = await this.memory.entity(String(input.id || '')).catch(() => null);
      if (!r || !r.entity) return 'no such entity';
      const notes = (r.notes || []).slice(0, 15).map((n) => ({ at: n.at, text: String(n.body).slice(0, 500) }));
      return JSON.stringify({ id: r.entity.id, name: r.entity.name, type: r.entity.type, notes, notes_total: (r.notes || []).length });
    }
    if (name === 'show_in_graph') return JSON.stringify({ ok: true, shown: String(input.id || '') });
    return `there is no tool named ${name}`;
  }

  async call(messages, { noTools = false } = {}) {
    const headers = { 'x-api-key': this.key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', ...(this.workspace ? { 'anthropic-workspace-id': this.workspace } : {}) };
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers, signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({ model: this.model, max_tokens: this.maxTokens, system: this.instructions, tools: TOOLS, ...(noTools ? { tool_choice: { type: 'none' } } : {}), messages }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`model ${r.status} ${j.error?.message || ''}`.trim());
    const u = j.usage || {};
    const usd = ((u.input_tokens || 0) + (u.cache_creation_input_tokens || 0)) * this.price.input / 1e6 + (u.cache_read_input_tokens || 0) * this.price.input / 10e6 + (u.output_tokens || 0) * this.price.output / 1e6;
    this.db.prepare('INSERT INTO spend (day, usd, calls) VALUES (?,?,1) ON CONFLICT(day) DO UPDATE SET usd=usd+excluded.usd, calls=calls+1').run(this.day(), usd);
    return j;
  }

  /** One visitor turn. history: [{role, text}] of the chat so far (seeded or the visitor's own). */
  async turn(session, ip, { chatId, slot, title, history, text }) {
    if (this.resting()) return { status: 503, error: 'resting' };
    if (session.turns >= this.cap) return { status: 429, error: 'limit' };
    const day = this.day(), ipk = this.ipKey(ip);
    const ipTurns = this.db.prepare('SELECT turns FROM ip_turns WHERE day=? AND ip=?').get(day, ipk)?.turns ?? 0;
    if (ipTurns >= this.ipCap) return { status: 429, error: 'limit' };
    const said = String(text || '').trim().slice(0, 2000);
    if (!said) return { status: 400, error: 'empty' };
    // count the turn before the model runs, so parallel requests cannot exceed the cap
    const claimed = this.db.prepare('UPDATE sessions SET turns=turns+1 WHERE id=? AND turns<?').run(session.id, this.cap);
    if (!claimed.changes) return { status: 429, error: 'limit' };
    this.db.prepare('INSERT INTO ip_turns (day, ip, turns) VALUES (?,?,1) ON CONFLICT(day, ip) DO UPDATE SET turns=turns+1').run(day, ipk);

    const own = chatId ? this.db.prepare('SELECT * FROM chats WHERE id=? AND session=?').get(chatId, session.id) : null;
    const past = own ? JSON.parse(own.messages) : (history || []).slice(-8).map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', text: String(m.text || '').slice(0, 6000) }));
    // the replayed history keeps no tool blocks, so an earlier turn's steps ride along as a bracketed line (the model
    // otherwise reads its own earlier answers as claims of calls it never made)
    const replay = (m) => (m.role === 'assistant' && m.steps && m.steps.length ? `[earlier turn; tools called: ${m.steps.map((x) => `${x.tool} ${x.input}`).join('; ')}]\n${m.text}` : m.text);
    const messages = past.map((m) => ({ role: m.role, content: replay(m) })).concat([{ role: 'user', content: said }]);
    const steps = [];
    let answer = '', focus = null;
    try {
      for (let i = 0; i < this.maxSteps; i++) {
        const last = i === this.maxSteps - 1;
        const j = await this.call(messages, { noTools: last || this.resting() });
        const content = j.content || [];
        const uses = content.filter((b) => b.type === 'tool_use');
        answer = content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim() || answer;
        if (!uses.length || last || this.resting()) break;
        messages.push({ role: 'assistant', content });
        const results = [];
        for (const u of uses) {
          const out = await this.tool(u.name, u.input || {}).catch((e) => `error: ${e.message}`);
          if (u.name === 'show_in_graph') focus = String(u.input?.id || '') || focus;
          steps.push({ tool: u.name, input: JSON.stringify(u.input || {}).slice(0, 200) });
          results.push({ type: 'tool_result', tool_use_id: u.id, content: String(out).slice(0, 12000) });
        }
        messages.push({ role: 'user', content: results });
      }
    } catch (e) {
      this.db.prepare('UPDATE sessions SET turns=turns-1 WHERE id=? AND turns>0').run(session.id); // a failed call is not a spent turn
      return { status: 502, error: 'model', detail: e.message };
    }
    if (!answer) answer = '(no answer)';
    const at = new Date().toISOString();
    const saved = past.concat([{ role: 'user', text: said }, { role: 'assistant', text: answer, steps, focus }]);
    const id = own ? own.id : randomBytes(9).toString('base64url');
    const name = own ? own.title : String(title || said).slice(0, 72);
    this.db.prepare('INSERT INTO chats (id, session, slot, title, messages, updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET messages=excluded.messages, updated_at=excluded.updated_at')
      .run(id, session.id, own ? own.slot : (slot || null), name, JSON.stringify(saved), at);
    const turns = this.db.prepare('SELECT turns FROM sessions WHERE id=?').get(session.id).turns;
    return { status: 200, chat: { id, slot: own ? own.slot : (slot || null), title: name }, answer, steps, focus, turns, cap: this.cap };
  }
}

/** Turnstile: the token from the widget, checked with the secret. */
export async function verifyTurnstile(secret, token, ip) {
  const body = new URLSearchParams({ secret, response: String(token || ''), ...(ip ? { remoteip: ip } : {}) });
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body, signal: AbortSignal.timeout(10_000) });
  const j = await r.json().catch(() => ({}));
  return Boolean(j.success);
}
