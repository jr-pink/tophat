// Which computer-use tab belongs to which chat, so a tab outlives its chat by no longer than the chat.
//
// Created: 2026-10-02T15:05:00-07:00
//
// The Codex computer-use plugin drives the automation Chrome that `com.tophat.chrome` launches,
// reachable at the CDP endpoint named by `rev5.browserCdp` in the tophat config.
//
// Ownership is established by observation, not by anything the plugin reports:
// the runner lists the endpoint's page targets either side of every
// computer-use call, and a page that appeared in between belongs to the
// conversation whose child made the call (TOPHAT_CONVERSATION_ID). That register
// is read by two things:
//
//   - archiving a chat, which closes the pages that chat opened;
//   - the 2am sweep, which closes every page except the ones belonging to a
//     chat that is running at that moment. 02:00 is the hour the owner already
//     gave this machine for unattended maintenance (src/health/repair.mjs,
//     REPAIR_HOUR), so the sweep uses the same one rather than inventing a
//     second night-time.
//
// A page nobody claimed is swept too: this Chrome exists for automation, the
// owner is never at the mini, and an unattributed page is by definition not a
// running chat's. Only the archive path needs an owner, and it has one.
//
// Nothing here closes Chrome itself, and the browser's own blank page is kept,
// so a sweep never takes the last window out from under a browser that the
// next chat is about to use.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** The hour unattended maintenance happens on this machine, in the owner's zone. */
export const SWEEP_HOUR = 2;
export const SWEEP_ZONE = 'America/Los_Angeles';
/** Loopback HTTP; a hung endpoint must not hold a turn open. */
export const CDP_MS = 4_000;

/**
 * The automation browser's DevTools endpoint, or null when there is none to talk to.
 *
 * Same rule the rest of the estate reads it by (`tophat-cdp`): the explicit
 * environment override first, then `rev5.browserCdp` from the config file. It
 * must be loopback HTTP with no credentials in it; anything else is refused
 * rather than contacted, because this module's whole job is closing things.
 */
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

/** Where the register lives: the rev 5 runner ledger, by the same rule as rev5/pull.mjs ledgerPath(). */
export function tabsDbPath(env = process.env) {
  return env.TOPHAT_RUNNER_RUNNER_DB
    || join(env.TOPHAT_STATE_DIR || join(env.HOME || homedir(), '.local', 'state', 'tophat'), 'rev5', 'runner.sqlite');
}

/** A handle on that file for a process that does not already hold one (the webchat server). */
export function openTabsDb(path = tabsDbPath()) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  // Several runners and the server write this file; busy is a wait, not a failure.
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

/** The pages open in that browser right now. Not iframes, workers or Chrome's own UI surfaces. */
export async function listPages(endpoint, { fetchImpl = fetch, timeoutMs = CDP_MS } = {}) {
  const response = await fetchImpl(`${endpoint}/json/list`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response?.ok) throw new Error(`CDP /json/list answered ${response?.status ?? 'nothing'}`);
  const body = await response.json();
  return (Array.isArray(body) ? body : [])
    .filter((target) => target && target.type === 'page' && typeof target.id === 'string' && target.id)
    .map((target) => ({ id: target.id, url: typeof target.url === 'string' ? target.url : '',
      title: typeof target.title === 'string' ? target.title : '' }));
}

/** Close one page. False rather than a throw: a sweep closes what it can and says what it could not. */
export async function closePage(endpoint, targetId, { fetchImpl = fetch, timeoutMs = CDP_MS } = {}) {
  try {
    const response = await fetchImpl(`${endpoint}/json/close/${encodeURIComponent(targetId)}`,
      { signal: AbortSignal.timeout(timeoutMs) });
    return Boolean(response?.ok);
  } catch { return false; }
}

/** The register itself. Created on first use, in whatever database the caller already has open. */
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
    /** First claim wins: a target id Chrome has reused is not retitled to a later chat. */
    record({ targetId, conversationId, sessionId = null, endpoint = null, url = '', title = '', at }) {
      insert.run(targetId, conversationId ?? null, sessionId, endpoint, url, title, at);
    },
    /** target id -> the chat that opened it, for every page this register still believes is open. */
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

/** The browser's own empty page. Closing it would leave the window count at zero for no gain. */
export const isBlankPage = (page) => !page.url || page.url === 'about:blank' || page.url.startsWith('chrome://');

/**
 * What may stay open. A page stays when the chat that opened it is running right
 * now, or when it is the browser's own blank page. Everything else goes,
 * including pages no chat claimed: this browser is for automation only.
 */
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

/** The calendar day of an instant in the owner's zone, as YYYY-MM-DD, or null when it is not an instant. */
export function localDay(at, zone = SWEEP_ZONE) {
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(when);
}

/** The hour of an instant in the owner's zone, or null when the clock is unreadable. */
export function localHour(at, zone = SWEEP_ZONE) {
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return null;
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hour12: false }).format(when));
  return Number.isFinite(hour) ? hour % 24 : null;
}

/**
 * Is this the night's sweep. Once per local day, inside the 02:00 hour, and an
 * unreadable clock holds off rather than firing: something that cannot tell the
 * time must not be what decides to close the owner's tabs.
 */
export function dueForSweep(now, lastSweepAt = null, { zone = SWEEP_ZONE, hour = SWEEP_HOUR } = {}) {
  const at = localHour(now, zone);
  if (at === null || at !== hour) return false;
  const today = localDay(now, zone);
  return today !== null && (lastSweepAt === null || localDay(lastSweepAt, zone) !== today);
}

/**
 * Close the pages one conversation opened. Used when a chat is archived: the
 * chat is put away and its browser state goes with it.
 */
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
    // A tab that refused to close is still this chat's, and still open: it keeps its register
    // entry so the 02:00 sweep comes back for it, and the caller is told rather than left to
    // read a short list as a clean archive.
    else failed.push(id);
  }
  // A page that is already gone is recorded closed too, so the register does not keep claiming it.
  registry.markClosed([...closed, ...gone], now(), reason);
  return { closed, gone, failed };
}

/**
 * The nightly pass: everything except the tabs of a chat that is running.
 *
 * The sweep is stamped before any page is closed, so a failure halfway through
 * does not re-run every ten minutes for the rest of the hour; the next night
 * picks up whatever this one left.
 */
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

/**
 * The runner's side: watch the page list around a computer-use call and write
 * down what appeared, against this conversation.
 *
 * Two extra loopback requests per computer-use call, both tolerant: a browser
 * that is not there, a listing that fails and a register that will not write
 * all leave the call itself untouched. Without a conversation id or an
 * endpoint this is a pass-through, which is what a test harness and a
 * command-line runner get.
 */
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
