// Incognito chats, the server half. Add it to hamburger menu in nav pill.
//
// An incognito chat runs through exactly the code a normal chat does (applyAction, the runner, the session
// machine, the translator, the SSE stream) against a second pair of singletons that keep nothing:
//
//   store   openStore(':memory:'). Never events.sqlite, so none of its readers (rev5/chats.py, rev5/push.py,
//           the baseline and nightly scripts, the retrieval indexer, voice nouns, search, autotitle,
//           evaluation capture, share links) can see it. The main /api/actions refuses incognito ids outright.
//   runner  createRunner with no live-child record, no relay and no handover, so a child dies with this server
//           and a boot never revives it; no titler, no evaluation capture. Its environment adds TOPHAT_INCOGNITO=1
//           (rev6/pull/incognito.mjs: `:memory:` runner ledger, push and turn push off, chat work item off,
//           goal hook off, memory CLI read-only, no task_update or memory_apply, no trace files) and points every
//           cache at INCOGNITO_ROOT/<conversation id>, which is removed with the chat and swept at boot.
//   provider forced to `direct`: the claude and codex CLIs keep their own session files on disk.
//
// A chat ends when its tab discards it (closing the pane, leaving the page) or when its tab has been gone for
// IDLE_DISCARD_MS, and with this process in any case: nothing here is written down to survive a restart.
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACTIONS, normalizeSettings, validateAction } from '../core/contract.js';
import { isIncognito, tabOf, validIncognitoId } from '../core/incognito.js';
import { openStore } from './store.js';
import { createRunner } from './runner.js';
import { createSpliceLedger } from './sidechat.js';
import { webchatStorePath } from './paths.js';

// One root per server store, so a test server or a dev server never sweeps the live server's scratch.
export const INCOGNITO_ROOT = process.env.WEBCHAT_INCOGNITO_ROOT || join(tmpdir(),
  `tophat-incognito-${createHash('sha256').update(process.env.WEBCHAT_DB || webchatStorePath('events.sqlite')).digest('hex').slice(0, 10)}`);
/** A tab with no open stream for this long has its incognito chats discarded. */
export const IDLE_DISCARD_MS = Number(process.env.WEBCHAT_INCOGNITO_IDLE_MS || 30 * 60_000);
const SWEEP_MS = 60_000;

/** What an incognito child's environment says on top of the server's own. `undefined` removes a variable. */
export function incognitoOverrides(root = INCOGNITO_ROOT) {
  return {
    TOPHAT_INCOGNITO: '1',
    TOPHAT_INCOGNITO_ROOT: root,
    TOPHAT_RUNNER_RUNNER_DB: ':memory:',
    TOPHAT_RUNNER_PUSH: '0',
    TOPHAT_RUNNER_TURN_PUSH: '0',
    TOPHAT_RUNNER_CHAT_WORK: '0',
    TOPHAT_RUNNER_GOAL_HOOK: '0',
    TOPHAT_RUNNER_TRACE_DIR: undefined,
    // Always the default runner (rev6/pull/pull.mjs), the one that reads TOPHAT_INCOGNITO; never an override.
    TOPHAT_PULL_SCRIPT: undefined,
  };
}

/**
 * The runner's one environment: a live view of `base` (process.env, which serve.mjs edits in place on a reload)
 * with the overrides laid over it, so spreading it into a child's env gives the child both.
 */
export function overlayEnv(base, overrides) {
  const has = (key) => Object.hasOwn(overrides, key);
  const read = (key) => (has(key) ? overrides[key] : base[key]);
  return new Proxy({}, {
    get: (_, key) => (typeof key === 'string' ? read(key) : undefined),
    has: (_, key) => typeof key === 'string' && read(key) !== undefined,
    set: (_, key, value) => { overrides[key] = value; return true; },
    deleteProperty: (_, key) => { overrides[key] = undefined; return true; },
    ownKeys: () => [...new Set([...Object.keys(base), ...Object.keys(overrides)])].filter((key) => read(key) !== undefined),
    getOwnPropertyDescriptor: (_, key) => {
      const value = typeof key === 'string' ? read(key) : undefined;
      return value === undefined ? undefined : { value, enumerable: true, configurable: true, writable: true };
    },
  });
}

/** Settings for an incognito chat: whatever was asked, on the direct provider. */
export function directSettings(settings = {}, base = undefined) {
  return normalizeSettings({ ...(settings || {}), provider: 'direct' }, base);
}

function removeScratch(root, id) {
  if (!/^[\w.-]+$/.test(String(id || ''))) return;
  try { rmSync(join(root, id), { recursive: true, force: true }); } catch { /* already gone */ }
}

/**
 * The incognito singletons. `applyAction` is app.js's (passed in so this module never builds the main app itself
 * and a test can hand in its own); `defaultCwd` is the main app's working directory.
 */
export function createIncognito({ applyAction, defaultCwd, root = INCOGNITO_ROOT, env = process.env, spawnImpl, now = Date.now,
  idleMs = IDLE_DISCARD_MS, timers = true } = {}) {
  // Nothing from an earlier process can still be in use: its children died with it.
  try { rmSync(root, { recursive: true, force: true }); } catch { /* nothing there */ }
  const store = openStore(':memory:');
  const runnerEnv = overlayEnv(env, incognitoOverrides(root));
  const runner = createRunner({ store, defaultCwd, env: runnerEnv, ...(spawnImpl ? { spawnImpl } : {}) });
  const splices = createSpliceLedger(store);
  store.subscribe((event) => {
    if (event.kind === 'run.completed') splices.commit(event.conversation_id);
    else if (event.kind === 'run.error' || event.kind === 'run.cancelled') splices.drop(event.conversation_id);
  });

  // Tabs: when each was last heard from, and how many streams it holds open right now.
  const tabs = new Map();
  const seen = (tab) => {
    if (!tab) return;
    const entry = tabs.get(tab) || { at: 0, streams: 0 };
    entry.at = now();
    tabs.set(tab, entry);
  };

  const mine = (tab) => (event) => tabOf(event.conversation_id) === tab;
  const conversationsOf = (tab) => store.conversations().filter((c) => tabOf(c.id) === tab);

  function purge(id) {
    for (const table of ['events', 'event_fts', 'event_sub', 'conversations', 'applied_actions', 'reading']) {
      const column = table === 'conversations' ? 'id' : 'conversation_id';
      try { store.db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(id); } catch { /* table absent */ }
    }
  }

  /** Ends one incognito chat: its child, its rows, its scratch directory. */
  function discard(id) {
    if (!isIncognito(id)) return false;
    try { runner.stop(id); } catch { /* not running */ }
    purge(id);
    removeScratch(root, id);
    // A child on its way out can still write its last events (run.cancelled) after the purge.
    const late = setTimeout(() => { purge(id); removeScratch(root, id); }, 15_000);
    late.unref?.();
    return true;
  }

  function discardTab(tab) {
    const ids = new Set(conversationsOf(tab).map((c) => c.id));
    for (const id of runner.live.keys()) if (tabOf(id) === tab) ids.add(id);
    for (const id of ids) discard(id);
    tabs.delete(tab);
    return [...ids];
  }

  function sweep() {
    const cutoff = now() - idleMs;
    const known = new Set([...tabs.keys(), ...store.conversations().map((c) => tabOf(c.id)).filter(Boolean)]);
    for (const tab of known) {
      const entry = tabs.get(tab);
      if (entry?.streams > 0) continue;
      if (entry && entry.at > cutoff) continue;
      discardTab(tab);
    }
  }
  let sweeper = null;
  if (timers) { sweeper = setInterval(sweep, SWEEP_MS); sweeper.unref?.(); }

  function capabilities(base = {}) {
    const providers = (base.providers || []).includes('direct') ? ['direct'] : (base.providers || []);
    return { ...base, providers, incognito: true };
  }

  /** POST /api/incognito/actions. Returns [status, body]. */
  function act(raw) {
    let action;
    try { action = validateAction(raw); } catch (cause) { return [400, { error: `Invalid action: ${cause.message}` }]; }
    const id = action.conversation_id;
    if (!validIncognitoId(id)) return [400, { error: 'not an incognito chat' }];
    const payload = { ...(action.payload || {}) };
    if (action.op === ACTIONS.FORK && !(validIncognitoId(payload.parentId) && tabOf(payload.parentId) === tabOf(id))) {
      return [400, { error: 'an incognito chat forks only from an incognito chat of the same tab' }];
    }
    if ([ACTIONS.CREATE, ACTIONS.SEND, ACTIONS.FORK].includes(action.op) && (payload.settings || action.op !== ACTIONS.FORK)) {
      payload.settings = directSettings(payload.settings || {});
    }
    if (action.op === ACTIONS.SETTINGS) {
      const current = store.conversation(id)?.settings || {};
      payload.settings = directSettings({ ...current, ...(payload.settings || {}) }, current);
    }
    seen(tabOf(id));
    const tab = tabOf(id);
    const seenBefore = store.appliedAction(action.action_id);
    if (seenBefore) {
      return [200, { events: store.between(seenBefore.cursor_before, seenBefore.cursor_after).filter(mine(tab)), cursor: store.cursor(), replayed: true }];
    }
    // Putting an incognito chat away is ending it: there is no archive to put it in.
    if (action.op === ACTIONS.ARCHIVE && payload.archived) { discard(id); return [200, { events: [], cursor: store.cursor(), discarded: [id] }]; }
    const before = store.cursor();
    try {
      applyAction({ ...action, payload }, { store, runner, splices,
        attribution: { actor: 'human', basis: 'interactive-owner-channel', source: 'webchat-incognito', deviceId: action.device_id, authorVerified: false } });
    } catch (cause) { return [409, { error: cause.message }]; }
    store.markApplied({ actionId: action.action_id, conversationId: id, op: action.op, cursorBefore: before, cursorAfter: store.cursor() });
    return [200, { events: store.since(before).filter(mine(tab)), cursor: store.cursor() }];
  }

  function live(tab) { return [...runner.live.keys()].filter((id) => tabOf(id) === tab); }
  function busy(tab) { return live(tab).filter((id) => runner.isBusy(id)); }
  function sidebar(tab) { return { cursor: store.cursor(), rows: conversationsOf(tab) }; }

  function bootstrap(tab, base) {
    seen(tab);
    const conversations = conversationsOf(tab);
    const events = conversations.flatMap((c) => store.conversationEvents(c.id, { newest: true, limit: 2000 }));
    return { conversations, events, cursor: store.cursor(), sidebar: sidebar(tab), live: live(tab), capabilities: capabilities(base) };
  }

  function sync(tab, after, base) {
    seen(tab);
    const LIMIT = 2000;
    const page = store.since(after, LIMIT);
    return { events: page.filter(mine(tab)), truncated: page.length >= LIMIT, cursor: store.cursor(), sidebar: sidebar(tab), live: live(tab), busy: busy(tab), capabilities: capabilities(base) };
  }

  /** The store as one tab's stream sees it: its own chats only. */
  function streamStore(tab) {
    const filter = mine(tab);
    return {
      cursor: () => store.cursor(),
      since: (cursor, limit) => store.since(cursor, limit).filter(filter),
      subscribe(listener) {
        const entry = tabs.get(tab) || { at: now(), streams: 0 };
        entry.streams += 1; entry.at = now();
        tabs.set(tab, entry);
        const off = store.subscribe((event) => { if (filter(event)) listener(event); });
        return () => { off(); const e = tabs.get(tab); if (e) { e.streams = Math.max(0, e.streams - 1); e.at = now(); } };
      },
    };
  }

  function conversation(id, { after = 0, before = null, limit = 2000, newest = false } = {}) {
    if (!validIncognitoId(id)) return null;
    seen(tabOf(id));
    const found = store.conversation(id);
    if (!found) return null;
    return { conversation: found, events: store.conversationEvents(id, { after, before, limit, newest }) };
  }

  function stopAll() { try { runner.stopAll(); } catch { /* nothing running */ } }
  function close() {
    if (sweeper) clearInterval(sweeper);
    stopAll();
    try { store.close(); } catch { /* closed */ }
    try { rmSync(root, { recursive: true, force: true }); } catch { /* gone */ }
  }

  return { store, runner, splices, env: runnerEnv, root, act, bootstrap, sync, streamStore, conversation, discard, discardTab, sweep, seen, stopAll, close, tabs };
}

const KEY = Symbol.for('tophat.webchat.incognito');

/** The process's incognito singletons, made on first use and adopted across a hot reload like app.js's. */
export async function incognito() {
  if (globalThis[KEY]) return globalThis[KEY];
  const { app, applyAction, DEFAULT_CWD } = await import('./app.js');
  if (globalThis[KEY]) return globalThis[KEY];
  const made = createIncognito({ applyAction: (action, options) => applyAction(action, options), defaultCwd: DEFAULT_CWD });
  globalThis[KEY] = made;
  void app;
  // Children of this runner are plain children, not relays: they go with this process, and they are told so.
  process.on('exit', () => made.stopAll());
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => made.stopAll());
  return made;
}

/** At boot: no incognito scratch from an earlier process survives (its children died with it). */
export function sweepIncognitoRoot(root = INCOGNITO_ROOT) {
  if (globalThis[KEY]) return;
  try { rmSync(root, { recursive: true, force: true }); } catch { /* nothing there */ }
}
