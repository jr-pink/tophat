import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export function parseReply(line) {
  try { const value = JSON.parse(line); return value && typeof value === 'object' ? value : null; } catch { return null; }
}

export function startCua(config, { spawnImpl = spawn, timeout = 120000, env = process.env } = {}) {
  const child = spawnImpl(config.command, config.args || [], { stdio: ['pipe', 'pipe', 'ignore'],
    env: { HOME: env.HOME, PATH: env.PATH, TMPDIR: env.TMPDIR, ...config.env } });
  let id = 0, closed = false;
  const pending = new Map();
  const fail = () => {
    closed = true;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Computer-use server closed; do not replay an action without observing its result.')); }
    pending.clear();
  };
  child.once('exit', fail); child.once('error', fail);
  child.stdin.on('error', fail);
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const message = parseReply(line), entry = pending.get(message?.id);
    if (!entry) return;
    pending.delete(message.id); clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(message.error.message || 'Computer-use request failed'));
    else entry.resolve(message.result);
  });
  function request(method, params) {
    if (closed) return Promise.reject(new Error('Computer-use server is closed'));
    const serial = ++id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(serial);
        reject(new Error('Computer-use request timed out; outcome unknown. Observe before retrying.'));
      }, timeout);
      pending.set(serial, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: serial, method, params }) + '\n');
    });
  }
  return {
    async init() {
      const info = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'tophat-direct', version: '1' } });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      const result = await request('tools/list', {});
      return { instructions: info.instructions || '', tools: result.tools };
    },
    call: (name, args, meta) => request('tools/call', meta ? { name, arguments: args, _meta: meta } : { name, arguments: args }),
    close() { fail(); lines.close(); child.kill(); }
  };
}

export function cuaContent(result, directory) {
  return (result.content || []).map(block => {
    if (block.type === 'text') return { type: 'text', text: block.text };
    if (block.type === 'image') {
      if (!/^image\/(png|jpeg|webp|gif)$/.test(block.mimeType) || typeof block.data !== 'string') throw new Error('Unsupported computer-use image');
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const path = join(directory, `${randomUUID()}.${block.mimeType.split('/')[1]}`);
      writeFileSync(path, Buffer.from(block.data, 'base64'), { mode: 0o600 });
      return { type: 'tophat_image', path, media_type: block.mimeType };
    }
    return { type: 'text', text: JSON.stringify(block) };
  });
}

export function createCua({ env = process.env, factory = startCua, sessionId = env.TOPHAT_CONVERSATION_ID || '', newTurnId = randomUUID } = {}) {
  let client, ready, instructions = '', specs = [], failure = '';
  const file = env.TOPHAT_RUNNER_CUA_CONFIG;
  const session = String(sessionId).replace(/[^A-Za-z0-9._-]/g, '-') || 'tophat-direct';
  let turnId = newTurnId();
  const meta = () => ({ 'x-codex-turn-metadata': { session_id: session, turn_id: turnId } });
  return {
    async ready() {
      turnId = newTurnId();
      if (!file) return;
      return ready ??= (async () => {
        try {
          const config = JSON.parse(readFileSync(file, 'utf8')).mcpServers.cua_repl;
          if (config.enabled === false) throw new Error('Installed CUA server is disabled');
          client = factory(config, { env });
          const native = await client.init();
          specs = native.tools.filter(tool => ['js', 'js_reset'].includes(tool.name)).map(tool => ({
            name: `mcp__cua_repl__${tool.name}`, description: tool.description, input_schema: tool.inputSchema
          }));
          if (specs.length !== 2) throw new Error('Installed CUA tool inventory is incomplete');
          instructions = native.instructions;
        } catch (error) { failure = error.message; client?.close(); client = null; specs = []; }
      })();
    },
    get specs() { return specs; },
    get turnMeta() { return meta(); },
    prompt() { return file ? failure ? `Computer use unavailable: ${failure}` : `${instructions}\nComputer-use tools come from the installed Codex unified-computer-use plugin. Follow their instructions exactly. Native mouse, keyboard, clipboard and focus share one desktop: coordinate exclusive ownership before use, and stop if another person or agent is using it. Prefer task-owned CDP tabs, and read workspace AGENTS.md for browser discovery. Never replay a timed-out action without inspecting its outcome.` : ''; },
    async run(name, input) {
      const result = await client.call(name.replace('mcp__cua_repl__', ''), input, meta());
      return { content: cuaContent(result, env.TOPHAT_RUNNER_CUA_IMAGES), isError: Boolean(result.isError) };
    },
    close() { client?.close(); }
  };
}

// ---- tabs a conversation opened (rev5/cua-tabs.mjs) ----
export const SWEEP_HOUR = 2;
export const SWEEP_ZONE = 'America/Los_Angeles';
export const CDP_MS = 4_000;

export function cdpEndpoint(env = process.env, { read = readFileSync } = {}) {
  const named = env.TOPHAT_RUNNER_BROWSER_CDP || configuredEndpoint(env, read);
  if (typeof named !== 'string' || !named) return null;
  let url;
  try { url = new URL(named); } catch { return null; }
  if (url.protocol !== 'http:') return null;
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return null;
  if (url.username || url.password) return null;
  return named.replace(/\/+$/u, '');
}

function configuredEndpoint(env, read) {
  const path = env.TOPHAT_CONFIG || join(env.HOME || homedir(), '.config', 'tophat', 'config.json');
  try { return JSON.parse(read(path, 'utf8'))?.rev5?.browserCdp ?? null; } catch { return null; }
}

export function tabsDbPath(env = process.env) {
  return env.TOPHAT_RUNNER_RUNNER_DB
    || join(env.TOPHAT_STATE_DIR || join(env.HOME || homedir(), '.local', 'state', 'tophat'), 'rev5', 'runner.sqlite');
}

export function openTabsDb(path = tabsDbPath()) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

export async function listPages(endpoint, { fetchImpl = fetch, timeoutMs = CDP_MS } = {}) {
  const response = await fetchImpl(`${endpoint}/json/list`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response?.ok) throw new Error(`CDP /json/list answered ${response?.status ?? 'nothing'}`);
  const body = await response.json();
  return (Array.isArray(body) ? body : [])
    .filter((target) => target && target.type === 'page' && typeof target.id === 'string' && target.id)
    .map((target) => ({ id: target.id, url: typeof target.url === 'string' ? target.url : '',
      title: typeof target.title === 'string' ? target.title : '' }));
}

export async function closePage(endpoint, targetId, { fetchImpl = fetch, timeoutMs = CDP_MS } = {}) {
  try {
    const response = await fetchImpl(`${endpoint}/json/close/${encodeURIComponent(targetId)}`,
      { signal: AbortSignal.timeout(timeoutMs) });
    return Boolean(response?.ok);
  } catch { return false; }
}

export function openTabRegistry(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cua_tabs (
      target_id       TEXT PRIMARY KEY,
      conversation_id TEXT,
      session_id      TEXT,
      endpoint        TEXT,
      url             TEXT,
      title           TEXT,
      opened_at       TEXT NOT NULL,
      closed_at       TEXT,
      closed_reason   TEXT);
    CREATE INDEX IF NOT EXISTS cua_tabs_owner ON cua_tabs(conversation_id, closed_at);
    CREATE TABLE IF NOT EXISTS cua_tab_sweeps (id INTEGER PRIMARY KEY CHECK (id = 1), at TEXT NOT NULL)`);
  const insert = db.prepare(`INSERT INTO cua_tabs (target_id, conversation_id, session_id, endpoint, url, title, opened_at)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(target_id) DO NOTHING`);
  const close = db.prepare('UPDATE cua_tabs SET closed_at = ?, closed_reason = ? WHERE target_id = ? AND closed_at IS NULL');
  return {
    record({ targetId, conversationId, sessionId = null, endpoint = null, url = '', title = '', at }) {
      insert.run(targetId, conversationId ?? null, sessionId, endpoint, url, title, at);
    },
    owners() {
      const out = new Map();
      for (const row of db.prepare('SELECT target_id, conversation_id FROM cua_tabs WHERE closed_at IS NULL').all()) {
        if (row.conversation_id) out.set(row.target_id, row.conversation_id);
      }
      return out;
    },
    openFor(conversationId) {
      return db.prepare('SELECT target_id FROM cua_tabs WHERE conversation_id = ? AND closed_at IS NULL ORDER BY opened_at')
        .all(conversationId).map((row) => row.target_id);
    },
    markClosed(targetIds, at, reason) {
      let changed = 0;
      for (const id of targetIds) changed += close.run(at, reason, id).changes;
      return changed;
    },
    lastSweepAt() { return db.prepare('SELECT at FROM cua_tab_sweeps WHERE id = 1').get()?.at ?? null; },
    noteSweep(at) { db.prepare('INSERT INTO cua_tab_sweeps (id, at) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET at = excluded.at').run(at); }
  };
}

export const isBlankPage = (page) => !page.url || page.url === 'about:blank' || page.url.startsWith('chrome://');

export function sweepPlan({ pages, owners = new Map(), active = [], blank = isBlankPage }) {
  const running = new Set(active);
  const close = [], kept = [];
  for (const page of pages) {
    const owner = owners.get(page.id) || null;
    if (owner && running.has(owner)) kept.push({ ...page, owner, why: `${owner} is running` });
    else if (blank(page)) kept.push({ ...page, owner, why: 'the browser\'s blank page' });
    else close.push({ ...page, owner });
  }
  return { close, kept };
}

export function localDay(at, zone = SWEEP_ZONE) {
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(when);
}

export function localHour(at, zone = SWEEP_ZONE) {
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return null;
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hour12: false }).format(when));
  return Number.isFinite(hour) ? hour % 24 : null;
}

export function dueForSweep(now, lastSweepAt = null, { zone = SWEEP_ZONE, hour = SWEEP_HOUR } = {}) {
  const at = localHour(now, zone);
  if (at === null || at !== hour) return false;
  const today = localDay(now, zone);
  return today !== null && (lastSweepAt === null || localDay(lastSweepAt, zone) !== today);
}

export async function closeConversationTabs({ db, endpoint, conversationId, fetchImpl = fetch,
  now = () => new Date().toISOString(), reason = 'chat archived' } = {}) {
  if (!db || !endpoint || !conversationId) return { closed: [], gone: [], failed: [], error: 'no endpoint or no conversation' };
  const registry = openTabRegistry(db);
  const owned = registry.openFor(conversationId);
  if (!owned.length) return { closed: [], gone: [], failed: [] };
  let pages;
  try { pages = await listPages(endpoint, { fetchImpl }); } catch (error) { return { closed: [], gone: [], failed: [], error: error.message }; }
  const present = new Set(pages.map((page) => page.id));
  const closed = [], gone = [], failed = [];
  for (const id of owned) {
    if (!present.has(id)) { gone.push(id); continue; }
    if (await closePage(endpoint, id, { fetchImpl })) closed.push(id);
    else failed.push(id);
  }
  registry.markClosed([...closed, ...gone], now(), reason);
  return { closed, gone, failed };
}

export async function sweepTabs({ db, endpoint, active = [], fetchImpl = fetch,
  now = () => new Date().toISOString(), reason = 'nightly 02:00 sweep' } = {}) {
  if (!db || !endpoint) return { closed: [], kept: [], error: 'no endpoint' };
  const registry = openTabRegistry(db);
  const at = now();
  registry.noteSweep(at);
  let pages;
  try { pages = await listPages(endpoint, { fetchImpl }); } catch (error) { return { closed: [], kept: [], error: error.message }; }
  const { close, kept } = sweepPlan({ pages, owners: registry.owners(), active });
  const closed = [], failed = [];
  for (const page of close) {
    if (await closePage(endpoint, page.id, { fetchImpl })) closed.push(page);
    else failed.push(page);
  }
  registry.markClosed(closed.map((page) => page.id), at, reason);
  return { closed, kept, failed, at };
}

export function createTabWatcher({ db, env = process.env, sessionId = null,
  conversationId = env.TOPHAT_CONVERSATION_ID || null, endpoint = cdpEndpoint(env),
  list = listPages, now = () => new Date().toISOString(), log = (line) => console.error(line) } = {}) {
  if (!db || !endpoint || !conversationId) return { endpoint: null, around: (work) => work() };
  let registry = null;
  const pages = async () => { try { return await list(endpoint); } catch { return null; } };
  return {
    endpoint,
    async around(work) {
      const before = await pages();
      try {
        return await work();
      } finally {
        const after = before ? await pages() : null;
        if (before && after) {
          const seen = new Set(before.map((page) => page.id));
          const fresh = after.filter((page) => !seen.has(page.id));
          if (fresh.length) {
            try {
              registry ??= openTabRegistry(db);
              const at = now();
              for (const page of fresh) {
                registry.record({ targetId: page.id, conversationId, sessionId, endpoint, url: page.url, title: page.title, at });
              }
            } catch (error) { log(`[cua-tabs] could not record ${fresh.length} tab(s): ${error.message}`); }
          }
        }
      }
    }
  };
}
